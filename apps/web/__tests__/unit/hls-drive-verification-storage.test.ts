import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createHlsDriveVerificationStorage } from "@/lib/hls-drive-verification-storage";
import {
	type HlsInventory,
	sealHlsInventory,
} from "@/lib/hls-publication-contract";
import {
	type HlsPinnedRead,
	type HlsVerificationScope,
	prepareVerifiedHlsSnapshot,
} from "@/lib/hls-snapshot-verification";

function fixture() {
	const scope: HlsVerificationScope = {
		ownerId: "owner",
		videoId: "video",
		attemptId: "11111111-1111-4111-8111-111111111111",
		generationId: "22222222-2222-4222-8222-222222222222",
		storageProvider: "drive",
		storageBindingId: "drive-binding",
	};
	const prefix = `owner/video/.recording/hls/${scope.attemptId}/${scope.generationId}/`;
	const data = new TextEncoder().encode("Drive binary fixture");
	const sha256 = createHash("sha256").update(data).digest("hex");
	const request: HlsPinnedRead = {
		key: `${prefix}video/init.mp4`,
		identity: {
			provider: "drive",
			fileId: "init-file",
			revisionId: "revision-1",
			sha256,
		},
		signal: new AbortController().signal,
	};
	const resolveFileId = vi.fn(
		async (key: string): Promise<string | null> =>
			key.endsWith("init.mp4") ? "init-file" : "segment-file",
	);
	const token = vi.fn(async () => "fixture-token");
	const metadata = (fileId = "init-file") => ({
		id: fileId,
		mimeType: "video/mp4",
		size: String(data.length),
		sha256Checksum: sha256,
		headRevisionId: "revision-1",
		trashed: false,
	});
	const json = (input: unknown) => Response.json(input);
	const media = () =>
		new Response(data.slice(), {
			headers: {
				"content-type": "video/mp4",
				"content-length": String(data.length),
			},
		});
	const fetch = vi.fn(async (url: string, _init: RequestInit) =>
		url.includes("/revisions/")
			? media()
			: json(
					metadata(
						url.includes("/segment-file?") ? "segment-file" : "init-file",
					),
				),
	);
	const storage = createHlsDriveVerificationStorage({
		scope,
		fetch,
		getAccessToken: token,
		resolveFileId,
	});
	const manifest = () => {
		const inventory: HlsInventory = {
			version: 1,
			storageProvider: "drive",
			ownerId: scope.ownerId,
			videoId: scope.videoId,
			attemptId: scope.attemptId,
			generationId: scope.generationId,
			revision: 1,
			previousDigest: null,
			mode: "VOD",
			audioIntent: "none",
			masterId: "master",
			tracks: [{ id: "v", kind: "video", codec: "h264", variantId: "variant" }],
			entries: [
				{ role: "master", id: "master", variantIds: ["variant"] },
				{
					role: "variant",
					id: "variant",
					trackId: "v",
					initId: "init",
					segmentIds: ["segment"],
				},
				{
					role: "init",
					id: "init",
					trackId: "v",
					codec: "h264",
					key: request.key,
					size: data.length,
					identity: {
						provider: "drive",
						fileId: "init-file",
						revisionId: "revision-1",
						sha256,
					},
				},
				{
					role: "segment",
					id: "segment",
					trackId: "v",
					codec: "h264",
					key: `${prefix}video/segment_001.m4s`,
					size: data.length,
					identity: {
						provider: "drive",
						fileId: "segment-file",
						revisionId: "revision-1",
						sha256,
					},
					sequence: 1,
					duration: 3,
				},
			],
		};
		return sealHlsInventory(inventory);
	};
	return {
		scope,
		prefix,
		data,
		sha256,
		request,
		resolveFileId,
		token,
		metadata,
		json,
		media,
		fetch,
		storage,
		manifest,
	};
}
it("uses fixed Drive metadata and exact revision reads with trusted mapping", async () => {
	const f = fixture();
	const head = await f.storage.head(f.request);
	expect(head).toEqual({
		key: f.request.key,
		size: f.data.length,
		identity: f.request.identity,
	});
	const opened = await f.storage.open(f.request);
	expect(await new Response(opened.body).text()).toBe(
		new TextDecoder().decode(f.data),
	);
	expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([
		"https://www.googleapis.com/drive/v3/files/init-file?fields=id%2CmimeType%2Csize%2Csha256Checksum%2CheadRevisionId%2Ctrashed&supportsAllDrives=true",
		"https://www.googleapis.com/drive/v3/files/init-file?fields=id%2CmimeType%2Csize%2Csha256Checksum%2CheadRevisionId%2Ctrashed&supportsAllDrives=true",
		"https://www.googleapis.com/drive/v3/files/init-file/revisions/revision-1?alt=media",
		"https://www.googleapis.com/drive/v3/files/init-file?fields=id%2CmimeType%2Csize%2Csha256Checksum%2CheadRevisionId%2Ctrashed&supportsAllDrives=true",
	]);
	for (const [, init] of f.fetch.mock.calls) {
		expect(init.redirect).toBe("manual");
		expect(init.cache).toBe("no-store");
		expect(init.method).toBe("GET");
		expect(init.signal).toBe(f.request.signal);
		expect(new Headers(init.headers).get("authorization")).toBe(
			"Bearer fixture-token",
		);
	}
});
it.each([
	"other/video/x.mp4",
	"../x.mp4",
	"https://evil.example/x.mp4",
	"//evil.example/x.mp4",
])("rejects foreign key %s before mapping/auth/fetch", async (key) => {
	const f = fixture();
	await expect(f.storage.head({ ...f.request, key })).rejects.toMatchObject({
		code: "scope-mismatch",
	});
	expect(f.resolveFileId).not.toHaveBeenCalled();
	expect(f.token).not.toHaveBeenCalled();
	expect(f.fetch).not.toHaveBeenCalled();
});
it.each(["../x.mp4", "%2e%2e/x.mp4", "x.mp4?token=secret", "x//y.mp4"])(
	"rejects traversal %s",
	async (suffix) => {
		const f = fixture();
		await expect(
			f.storage.head({ ...f.request, key: f.prefix + suffix }),
		).rejects.toMatchObject({ code: "scope-mismatch" });
		expect(f.fetch).not.toHaveBeenCalled();
	},
);
it("does not trust a supplied fileId without resolver membership", async () => {
	const f = fixture();
	f.resolveFileId.mockResolvedValue("foreign");
	await expect(f.storage.open(f.request)).rejects.toMatchObject({
		code: "scope-mismatch",
	});
	expect(f.token).not.toHaveBeenCalled();
	expect(f.fetch).not.toHaveBeenCalled();
});
it.each([
	{ id: "foreign" },
	{ headRevisionId: "other" },
	{ sha256Checksum: "a".repeat(64) },
	{ sha256Checksum: "bad" },
	{ size: "0" },
	{ size: "-1" },
	{ size: "1e3" },
	{ size: "9007199254740992" },
	{ trashed: true },
	{ mimeType: "application/vnd.google-apps.document" },
])("rejects bad actual metadata %#", async (change) => {
	const f = fixture();
	f.fetch.mockImplementation(async () =>
		f.json({ ...f.metadata(), ...change }),
	);
	await expect(f.storage.open(f.request)).rejects.toMatchObject({
		code: "object-changed",
	});
	expect(f.fetch).toHaveBeenCalledTimes(1);
});
it.each(["headRevisionId", "sha256Checksum", "size", "trashed"])(
	"rejects missing metadata %s",
	async (field) => {
		const f = fixture();
		const metadata: Record<string, unknown> = f.metadata();
		delete metadata[field];
		f.fetch.mockImplementation(async () => f.json(metadata));
		await expect(f.storage.head(f.request)).rejects.toMatchObject({
			code: "object-changed",
		});
	},
);
it("rejects an old revision rather than falling back to current bytes", async () => {
	const f = fixture();
	const identity = {
		provider: "drive" as const,
		fileId: "init-file",
		revisionId: "old",
		sha256: f.sha256,
	};
	await expect(
		f.storage.open({ ...f.request, identity }),
	).rejects.toMatchObject({ code: "object-changed" });
	expect(f.fetch.mock.calls.some(([url]) => url.includes("alt=media"))).toBe(
		false,
	);
});
it.each([302, 206, 404, 500])(
	"rejects HTTP %s and discards the body without following location",
	async (status) => {
		const f = fixture();
		const cancel = vi.fn();
		f.fetch.mockImplementation(
			async () =>
				new Response(new ReadableStream({ cancel }), {
					status,
					headers: { location: "https://evil.example?token=secret" },
				}),
		);
		await expect(f.storage.head(f.request)).rejects.toMatchObject({
			code: "object-changed",
		});
		expect(cancel).toHaveBeenCalledOnce();
		expect(f.fetch).toHaveBeenCalledOnce();
	},
);
it("rejects redirected metadata even when status is 200", async () => {
	const f = fixture();
	const response = f.json(f.metadata());
	Object.defineProperty(response, "redirected", { value: true });
	f.fetch.mockImplementation(async () => response);
	await expect(f.storage.head(f.request)).rejects.toMatchObject({
		code: "object-changed",
	});
});
it("bounds metadata before parsing its body", async () => {
	const f = fixture();
	const cancel = vi.fn();
	f.fetch.mockImplementation(
		async () =>
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new Uint8Array(65537));
					},
					cancel,
				}),
				{ headers: { "content-type": "application/json" } },
			),
	);
	await expect(f.storage.head(f.request)).rejects.toMatchObject({
		code: "object-changed",
	});
	expect(cancel).toHaveBeenCalledOnce();
});
it.each(["length", "mime", "range", "compression"])(
	"rejects invalid media %s and cancels bytes",
	async (reason) => {
		const f = fixture();
		const cancel = vi.fn();
		f.fetch.mockImplementation(async (url) =>
			url.includes("/revisions/")
				? new Response(new ReadableStream({ cancel }), {
						headers: {
							"content-type": reason === "mime" ? "text/html" : "video/mp4",
							"content-length":
								reason === "length" ? "1" : String(f.data.length),
							...(reason === "range" ? { "content-range": "bytes 0-1/2" } : {}),
							...(reason === "compression"
								? { "content-encoding": "gzip" }
								: {}),
						},
					})
				: f.json(f.metadata()),
		);
		await expect(f.storage.open(f.request)).rejects.toMatchObject({
			code: "object-changed",
		});
		expect(cancel).toHaveBeenCalledOnce();
	},
);
it("rejects metadata mutation after opening exact revision and cancels body", async () => {
	const f = fixture();
	const cancel = vi.fn();
	let metadataReads = 0;
	f.fetch.mockImplementation(async (url) =>
		url.includes("/revisions/")
			? new Response(new ReadableStream({ cancel }), {
					headers: {
						"content-type": "video/mp4",
						"content-length": String(f.data.length),
					},
				})
			: f.json({
					...f.metadata(),
					headRevisionId: ++metadataReads === 1 ? "revision-1" : "revision-2",
				}),
	);
	await expect(f.storage.open(f.request)).rejects.toMatchObject({
		code: "object-changed",
	});
	expect(cancel).toHaveBeenCalledOnce();
});
it("cancels downstream without waiting for acknowledgement and releases the origin lock", async () => {
	const f = fixture();
	const cancel = vi.fn(() => new Promise<void>(() => {}));
	const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
	f.fetch.mockImplementation(async (url) =>
		url.includes("/revisions/")
			? new Response(body, {
					headers: {
						"content-type": "video/mp4",
						"content-length": String(f.data.length),
					},
				})
			: f.json(f.metadata()),
	);
	const opened = await f.storage.open(f.request);
	expect(body.locked).toBe(true);
	await opened.body.cancel();
	expect(cancel).toHaveBeenCalledOnce();
	expect(body.locked).toBe(false);
});
it("sanitizes network errors without exposing tokens or origins", async () => {
	const f = fixture();
	f.fetch.mockRejectedValue(new Error("https://origin.example?token=secret"));
	await expect(f.storage.head(f.request)).rejects.toMatchObject({
		code: "storage-unavailable",
		message: "HLS snapshot verification failed: storage-unavailable",
	});
});
it("denies already-aborted requests without any calls", async () => {
	const f = fixture();
	const controller = new AbortController();
	controller.abort();
	await expect(
		f.storage.head({ ...f.request, signal: controller.signal }),
	).rejects.toMatchObject({ code: "aborted" });
	expect(f.fetch).not.toHaveBeenCalled();
	expect(f.resolveFileId).not.toHaveBeenCalled();
});
it("freezes copied scope without mutating caller scope", async () => {
	const f = fixture();
	f.scope.videoId = "other";
	expect(f.storage.scope.videoId).toBe("video");
	expect(Object.isFrozen(f.scope)).toBe(false);
	expect(Object.isFrozen(f.storage.scope)).toBe(true);
	expect(await f.storage.head(f.request)).toBeDefined();
});
it("composes with the engine and verifies actual bytes", async () => {
	const f = fixture();
	const snapshot = await prepareVerifiedHlsSnapshot(
		f.manifest(),
		f.scope,
		f.storage,
	);
	expect(snapshot.objects).toHaveLength(2);
	expect(snapshot.totalBytes).toBe(f.data.length * 2);
	expect(
		f.fetch.mock.calls.every(([url]) =>
			url.startsWith("https://www.googleapis.com/drive/v3/files/"),
		),
	).toBe(true);
});
it("engine rejects corruption despite expected metadata", async () => {
	const f = fixture();
	f.fetch.mockImplementation(async (url) =>
		url.includes("/revisions/")
			? new Response(new Uint8Array(f.data.length), {
					headers: {
						"content-type": "video/mp4",
						"content-length": String(f.data.length),
					},
				})
			: f.json(
					f.metadata(
						url.includes("/segment-file?") ? "segment-file" : "init-file",
					),
				),
	);
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest(), f.scope, f.storage),
	).rejects.toMatchObject({ code: "content-mismatch" });
});

it("rejects empty metadata chunks rather than spinning without budget progress", async () => {
	const f = fixture();
	const cancel = vi.fn();
	f.fetch.mockImplementation(
		async () =>
			new Response(
				new ReadableStream(
					{
						pull(c) {
							c.enqueue(new Uint8Array());
						},
						cancel,
					},
					{ highWaterMark: 0 },
				),
				{ headers: { "content-type": "application/json" } },
			),
	);
	await expect(f.storage.head(f.request)).rejects.toMatchObject({
		code: "object-changed",
	});
	expect(cancel).toHaveBeenCalledOnce();
});
it("stops while reading stalled metadata and releases its reader without waiting for cancel", async () => {
	const f = fixture();
	const controller = new AbortController();
	let started: (() => void) | undefined;
	const reading = new Promise<void>((resolve) => {
		started = resolve;
	});
	const cancel = vi.fn(() => new Promise<void>(() => {}));
	const body = new ReadableStream<Uint8Array>(
		{
			pull() {
				started?.();
			},
			cancel,
		},
		{ highWaterMark: 0 },
	);
	f.fetch.mockImplementation(
		async () =>
			new Response(body, { headers: { "content-type": "application/json" } }),
	);
	const operation = f.storage.head({ ...f.request, signal: controller.signal });
	const rejected = expect(operation).rejects.toMatchObject({ code: "aborted" });
	await reading;
	controller.abort();
	await rejected;
	expect(cancel).toHaveBeenCalledOnce();
	expect(body.locked).toBe(false);
});
it("destroys a late HTTP response after the engine timeout", async () => {
	const f = fixture();
	let finish: ((response: Response) => void) | undefined;
	f.fetch.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest(), f.scope, f.storage, {
			timeoutMs: 10,
		}),
	).rejects.toMatchObject({ code: "aborted" });
	const cancel = vi.fn();
	finish?.(
		new Response(new ReadableStream({ cancel }), {
			headers: { "content-type": "application/json" },
		}),
	);
	await Promise.resolve();
	await Promise.resolve();
	expect(cancel).toHaveBeenCalledOnce();
});
it("does not fetch if token loading stalls beyond deadline", async () => {
	const f = fixture();
	f.token.mockImplementation(() => new Promise(() => {}));
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest(), f.scope, f.storage, {
			timeoutMs: 10,
		}),
	).rejects.toMatchObject({ code: "aborted" });
	expect(f.fetch).not.toHaveBeenCalled();
});
it("rejects credential header injection before HTTP", async () => {
	const f = fixture();
	f.token.mockResolvedValue("token\r\nInjected: yes");
	await expect(f.storage.head(f.request)).rejects.toMatchObject({
		code: "scope-mismatch",
	});
	expect(f.fetch).not.toHaveBeenCalled();
});
it("detects resolver changes during metadata validation", async () => {
	const f = fixture();
	f.resolveFileId
		.mockResolvedValueOnce("init-file")
		.mockResolvedValue("foreign");
	await expect(f.storage.open(f.request)).rejects.toMatchObject({
		code: "scope-mismatch",
	});
	expect(f.fetch).toHaveBeenCalledTimes(1);
});
it("rejects a head change after reading bytes through the engine", async () => {
	const f = fixture();
	let reads = 0;
	f.fetch.mockImplementation(async (url) =>
		url.includes("/revisions/")
			? f.media()
			: f.json({
					...f.metadata(),
					headRevisionId: ++reads === 4 ? "new-revision" : "revision-1",
				}),
	);
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest(), f.scope, f.storage),
	).rejects.toMatchObject({ code: "storage-unavailable" });
	expect(reads).toBe(4);
});
it("can retry verification without partial cached observations", async () => {
	const f = fixture();
	f.fetch.mockRejectedValueOnce(new Error("offline"));
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest(), f.scope, f.storage),
	).rejects.toMatchObject({ code: "storage-unavailable" });
	expect(
		(await prepareVerifiedHlsSnapshot(f.manifest(), f.scope, f.storage))
			.objects,
	).toHaveLength(2);
});
it("rejects missing or nonstring identity and scope fields before any IO", async () => {
	const f = fixture();
	for (const identity of [
		null,
		{
			provider: "drive",
			fileId: undefined,
			revisionId: "revision-1",
			sha256: f.sha256,
		},
		{ provider: "drive", fileId: "init-file", revisionId: 1, sha256: f.sha256 },
	])
		await expect(
			f.storage.head({
				...f.request,
				identity: identity as unknown as HlsPinnedRead["identity"],
			}),
		).rejects.toMatchObject({ code: "scope-mismatch" });
	expect(() =>
		createHlsDriveVerificationStorage({
			scope: { ...f.scope, ownerId: undefined as unknown as string },
			fetch: f.fetch,
			getAccessToken: f.token,
			resolveFileId: f.resolveFileId,
		}),
	).toThrow();
	expect(f.resolveFileId).not.toHaveBeenCalled();
	expect(f.fetch).not.toHaveBeenCalled();
});
