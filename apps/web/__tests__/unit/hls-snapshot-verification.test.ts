import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
	type HlsInventory,
	sealHlsInventory,
} from "@/lib/hls-publication-contract";
import {
	type HlsObjectObservation,
	type HlsPinnedRead,
	type HlsVerificationScope,
	type HlsVerificationStorage,
	prepareVerifiedHlsSnapshot,
} from "@/lib/hls-snapshot-verification";

function fixture(provider: "s3" | "drive" = "s3") {
	const scope: HlsVerificationScope = {
		ownerId: "owner",
		videoId: "video",
		attemptId: "11111111-1111-4111-8111-111111111111",
		generationId: "22222222-2222-4222-8222-222222222222",
		storageProvider: provider,
		storageBindingId: "private-store",
	};
	const prefix = `owner/video/.recording/hls/${scope.attemptId}/${scope.generationId}/`;
	const data = new TextEncoder().encode("fixture bytes");
	const sha256 = createHash("sha256").update(data).digest("hex");
	const identity =
		provider === "s3"
			? {
					provider: "s3" as const,
					versionId: "version",
					etag: '"opaque-2"',
					sha256,
				}
			: {
					provider: "drive" as const,
					fileId: "file",
					revisionId: "revision",
					sha256,
				};
	const input: HlsInventory = {
		version: 1,
		storageProvider: provider,
		videoId: scope.videoId,
		ownerId: scope.ownerId,
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
				key: `${prefix}v/init.mp4`,
				size: data.length,
				identity: {
					...identity,
					...(provider === "drive" ? { fileId: "init-file" } : {}),
				},
			},
			{
				role: "segment",
				id: "segment",
				trackId: "v",
				codec: "h264",
				key: `${prefix}v/segment_001.m4s`,
				size: data.length,
				identity,
				sequence: 1,
				duration: 3,
			},
		],
	};
	const manifest = sealHlsInventory(input);
	const observation = (request: HlsPinnedRead): HlsObjectObservation => ({
		key: request.key,
		size: data.length,
		identity: { ...request.identity },
	});
	const head = vi.fn(async (request: HlsPinnedRead) => observation(request));
	const open = vi.fn(async (request: HlsPinnedRead) => ({
		observation: observation(request),
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(data.slice(0, 3));
				controller.enqueue(data.slice(3));
				controller.close();
			},
		}),
	}));
	const storage: HlsVerificationStorage = { scope: { ...scope }, head, open };
	return { scope, manifest, data, storage, head, open, observation };
}

it.each(["s3", "drive"] as const)(
	"verifies pinned %s reads and returns only an inactive frozen snapshot",
	async (provider) => {
		const f = fixture(provider);
		const before = structuredClone(f.manifest);
		const snapshot = await prepareVerifiedHlsSnapshot(
			f.manifest,
			f.scope,
			f.storage,
		);
		expect(snapshot.kind).toBe("verified-hls-snapshot");
		expect(snapshot.totalBytes).toBe(f.data.length * 2);
		expect(snapshot.objects).toHaveLength(2);
		expect(f.head).toHaveBeenCalledTimes(4);
		expect(f.open).toHaveBeenCalledTimes(2);
		expect(
			snapshot.objects.every(
				(receipt) =>
					receipt.sha256 === createHash("sha256").update(f.data).digest("hex"),
			),
		).toBe(true);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.manifest.inventory.entries)).toBe(true);
		expect(f.manifest).toEqual(before);
		expect(Object.isFrozen(f.manifest)).toBe(false);
		for (const [request] of f.open.mock.calls) {
			expect(request.identity.provider).toBe(provider);
			expect(request.signal).toBeInstanceOf(AbortSignal);
		}
	},
);

it.each([
	"ownerId",
	"videoId",
	"attemptId",
	"generationId",
	"storageProvider",
	"storageBindingId",
] as const)("denies mismatched binding %s without storage", async (field) => {
	const f = fixture();
	const scope = { ...f.scope, [field]: "other" };
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, scope, f.storage),
	).rejects.toMatchObject({ code: "scope-mismatch" });
	expect(f.head).not.toHaveBeenCalled();
	expect(f.open).not.toHaveBeenCalled();
});
it("rejects invalid digests before storage", async () => {
	const f = fixture();
	await expect(
		prepareVerifiedHlsSnapshot(
			{ ...f.manifest, digest: "0".repeat(64) },
			f.scope,
			f.storage,
		),
	).rejects.toMatchObject({ code: "invalid-contract" });
	expect(f.head).not.toHaveBeenCalled();
});
it.each(["size", "key", "sha256", "versionId", "etag"])(
	"rejects changed S3 head %s before opening bytes",
	async (field) => {
		const f = fixture();
		f.head.mockImplementation(async (request) => {
			const observation = f.observation(request);
			return field === "size"
				? { ...observation, size: 1 }
				: field === "key"
					? { ...observation, key: "other/video/secret" }
					: {
							...observation,
							identity: { ...observation.identity, [field]: "changed" },
						};
		});
		await expect(
			prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage),
		).rejects.toMatchObject({ code: "object-changed" });
		expect(f.open).not.toHaveBeenCalled();
	},
);
it.each(["fileId", "revisionId", "sha256"])(
	"rejects changed Drive head %s",
	async (field) => {
		const f = fixture("drive");
		f.head.mockImplementation(async (request) => ({
			...f.observation(request),
			identity: { ...request.identity, [field]: "changed" },
		}));
		await expect(
			prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage),
		).rejects.toMatchObject({ code: "object-changed" });
		expect(f.open).not.toHaveBeenCalled();
	},
);
it("cancels a response whose identity changed between HEAD and GET", async () => {
	const f = fixture();
	const cancel = vi.fn();
	f.open.mockImplementation(async (request) => ({
		observation: { ...f.observation(request), size: 1 },
		body: new ReadableStream({ cancel }),
	}));
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage),
	).rejects.toMatchObject({ code: "object-changed" });
	expect(cancel).toHaveBeenCalledOnce();
});
it("rejects mutation observed after a completed read", async () => {
	const f = fixture();
	f.head.mockImplementation(async (request) => ({
		...f.observation(request),
		size: f.head.mock.calls.length === 2 ? 1 : f.data.length,
	}));
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage),
	).rejects.toMatchObject({ code: "object-changed" });
	expect(f.open).toHaveBeenCalledTimes(1);
});
it.each(["corrupt", "truncated", "oversized"])(
	"rejects %s bytes despite matching metadata",
	async (kind) => {
		const f = fixture();
		const cancel = vi.fn();
		f.open.mockImplementation(async (request) => ({
			observation: f.observation(request),
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(
						kind === "truncated"
							? f.data.slice(0, -1)
							: kind === "oversized"
								? new Uint8Array(f.data.length + 1)
								: new Uint8Array(f.data.length),
					);
					if (kind !== "oversized") controller.close();
				},
				cancel,
			}),
		}));
		await expect(
			prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage),
		).rejects.toMatchObject({ code: "content-mismatch" });
		expect(f.open).toHaveBeenCalledTimes(1);
		if (kind === "oversized") expect(cancel).toHaveBeenCalledOnce();
	},
);
it.each([
	{ maxObjectBytes: 1 },
	{ maxTotalBytes: 1 },
	{ maxObjects: 1 },
	{ timeoutMs: 0 },
	{ maxObjectBytes: Infinity },
	{ maxObjects: 1001 },
])("rejects limits before storage %#", async (options) => {
	const f = fixture();
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage, options),
	).rejects.toMatchObject({ code: "limit-exceeded" });
	expect(f.head).not.toHaveBeenCalled();
});
it("denies an already aborted operation without storage", async () => {
	const f = fixture();
	const controller = new AbortController();
	controller.abort();
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage, {
			signal: controller.signal,
		}),
	).rejects.toMatchObject({ code: "aborted" });
	expect(f.head).not.toHaveBeenCalled();
});
it("aborts a stalled byte reader and cancels its stream", async () => {
	const f = fixture();
	const controller = new AbortController();
	const cancel = vi.fn();
	f.open.mockImplementation(async (request) => ({
		observation: f.observation(request),
		body: new ReadableStream({
			start() {
				controller.abort();
			},
			cancel,
		}),
	}));
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage, {
			signal: controller.signal,
		}),
	).rejects.toMatchObject({ code: "aborted" });
	expect(cancel).toHaveBeenCalledOnce();
});
it("times out a pending HEAD even if the adapter ignores the signal", async () => {
	const f = fixture();
	f.head.mockImplementation(() => new Promise(() => {}));
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage, {
			timeoutMs: 10,
		}),
	).rejects.toMatchObject({ code: "aborted" });
	expect(f.open).not.toHaveBeenCalled();
});
it("cancels a late-opened body after timeout", async () => {
	const f = fixture();
	let resolveOpen:
		| ((result: Awaited<ReturnType<typeof f.storage.open>>) => void)
		| undefined;
	f.open.mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveOpen = resolve;
			}),
	);
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage, {
			timeoutMs: 10,
		}),
	).rejects.toMatchObject({ code: "aborted" });
	const cancel = vi.fn();
	resolveOpen?.({
		observation: {
			key: "late",
			size: 1,
			identity:
				f.manifest.inventory.entries[2]?.role === "init"
					? f.manifest.inventory.entries[2].identity
					: {
							provider: "s3",
							versionId: "v",
							etag: '"v"',
							sha256: "a".repeat(64),
						},
		},
		body: new ReadableStream({ cancel }),
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(cancel).toHaveBeenCalledOnce();
});
it("sanitizes missing objects and provider failures", async () => {
	const f = fixture();
	f.head.mockRejectedValue(new Error("https://secret.s3.example?token=secret"));
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage),
	).rejects.toMatchObject({
		code: "storage-unavailable",
		message: "HLS snapshot verification failed: storage-unavailable",
	});
	expect(f.open).not.toHaveBeenCalled();
});
it("detects storage binding replacement during verification", async () => {
	const f = fixture();
	const original = f.head.getMockImplementation();
	f.head.mockImplementation(async (request) => {
		f.storage.scope.storageBindingId = "other";
		return original ? original(request) : f.observation(request);
	});
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage),
	).rejects.toMatchObject({ code: "scope-mismatch" });
});

it("can retry after failure without accepting any partial prior result", async () => {
	const f = fixture();
	f.head.mockRejectedValueOnce(new Error("offline"));
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage),
	).rejects.toMatchObject({ code: "storage-unavailable" });
	const snapshot = await prepareVerifiedHlsSnapshot(
		f.manifest,
		f.scope,
		f.storage,
	);
	expect(snapshot.objects).toHaveLength(2);
	expect(snapshot.totalBytes).toBe(f.data.length * 2);
});
it("does not retain failed bytes between attempts", async () => {
	const f = fixture();
	const original = f.open.getMockImplementation();
	f.open.mockImplementationOnce(async (request) => ({
		observation: f.observation(request),
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(f.data.length));
				controller.close();
			},
		}),
	}));
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage),
	).rejects.toMatchObject({ code: "content-mismatch" });
	if (original) f.open.mockImplementation(original);
	const first = await prepareVerifiedHlsSnapshot(
		f.manifest,
		f.scope,
		f.storage,
	);
	const second = await prepareVerifiedHlsSnapshot(
		f.manifest,
		f.scope,
		f.storage,
	);
	expect(first).toEqual(second);
});
it("rejects an untrusted scope even if storage repeats it", async () => {
	const f = fixture();
	const wrong = { ...f.scope, videoId: "other" };
	f.storage.scope = wrong;
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, wrong, f.storage),
	).rejects.toMatchObject({ code: "scope-mismatch" });
	expect(f.head).not.toHaveBeenCalled();
});
it("stops during a pending reader.read and releases the origin", async () => {
	const f = fixture();
	const controller = new AbortController();
	const cancel = vi.fn();
	let started: (() => void) | undefined;
	const reading = new Promise<void>((resolve) => {
		started = resolve;
	});
	f.open.mockImplementation(async (request) => ({
		observation: f.observation(request),
		body: new ReadableStream(
			{
				pull() {
					started?.();
				},
				cancel,
			},
			{ highWaterMark: 0 },
		),
	}));
	const operation = prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage, {
		signal: controller.signal,
	});
	const rejected = expect(operation).rejects.toMatchObject({ code: "aborted" });
	await reading;
	controller.abort();
	await rejected;
	expect(cancel).toHaveBeenCalledOnce();
});
it("sanitizes a provider error during streaming and cancels the reader", async () => {
	const f = fixture();
	f.open.mockImplementation(async (request) => ({
		observation: f.observation(request),
		body: new ReadableStream({
			pull(controller) {
				controller.error(new Error("https://secret.example?signature=secret"));
			},
		}),
	}));
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage),
	).rejects.toMatchObject({
		code: "storage-unavailable",
		message: "HLS snapshot verification failed: storage-unavailable",
	});
});
it("does not emit a partial snapshot when the final object is missing", async () => {
	const f = fixture();
	f.head.mockImplementation(async (request) => {
		if (request.key.endsWith(".m4s")) throw new Error("NoSuchKey");
		return f.observation(request);
	});
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage),
	).rejects.toMatchObject({ code: "storage-unavailable" });
	expect(f.open).toHaveBeenCalledTimes(1);
});

it("rejects empty chunks instead of allowing a no-progress stream", async () => {
	const f = fixture();
	const cancel = vi.fn();
	f.open.mockImplementation(async (request) => ({
		observation: f.observation(request),
		body: new ReadableStream(
			{
				pull(controller) {
					controller.enqueue(new Uint8Array(0));
				},
				cancel,
			},
			{ highWaterMark: 0 },
		),
	}));
	await expect(
		prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage),
	).rejects.toMatchObject({ code: "content-mismatch" });
	expect(cancel).toHaveBeenCalledOnce();
});
it("checks elapsed time even when immediate stream promises prevent timers from running", async () => {
	const f = fixture();
	const now = vi.spyOn(performance, "now").mockReturnValue(0);
	const cancel = vi.fn();
	try {
		f.open.mockImplementation(async (request) => ({
			observation: f.observation(request),
			body: new ReadableStream(
				{
					pull(controller) {
						now.mockReturnValue(100);
						controller.enqueue(f.data.slice(0, 1));
					},
					cancel,
				},
				{ highWaterMark: 0 },
			),
		}));
		await expect(
			prepareVerifiedHlsSnapshot(f.manifest, f.scope, f.storage, {
				timeoutMs: 10,
			}),
		).rejects.toMatchObject({ code: "aborted" });
		expect(cancel).toHaveBeenCalledOnce();
	} finally {
		now.mockRestore();
	}
});
