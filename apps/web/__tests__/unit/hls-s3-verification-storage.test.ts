import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
	GetObjectCommand,
	type GetObjectCommandOutput,
	HeadObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { expect, it, vi } from "vitest";
import {
	type HlsInventory,
	sealHlsInventory,
} from "@/lib/hls-publication-contract";
import { createHlsS3VerificationStorage } from "@/lib/hls-s3-verification-storage";
import {
	type HlsPinnedRead,
	type HlsVerificationScope,
	prepareVerifiedHlsSnapshot,
} from "@/lib/hls-snapshot-verification";

function sdkStreamFixture(source: Readable) {
	return Object.assign(source, {
		transformToWebStream: () => {
			const reader = Readable.toWeb(source).getReader();
			return new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						try {
							const part = await reader.read();
							if (part.done) {
								reader.releaseLock();
								controller.close();
							} else {
								if (!(part.value instanceof Uint8Array))
									throw new Error("Invalid fixture chunk");
								controller.enqueue(part.value);
							}
						} catch (error) {
							reader.releaseLock();
							throw error;
						}
					},
					cancel() {
						void reader.cancel().catch(() => {});
						reader.releaseLock();
					},
				},
				{ highWaterMark: 0 },
			);
		},
		transformToByteArray: vi.fn(async () => new Uint8Array(0)),
		transformToString: vi.fn(async () => ""),
	});
}

function fixture() {
	const scope: HlsVerificationScope = {
		ownerId: "owner",
		videoId: "video",
		attemptId: "11111111-1111-4111-8111-111111111111",
		generationId: "22222222-2222-4222-8222-222222222222",
		storageProvider: "s3",
		storageBindingId: "private-s3",
	};
	const prefix = `owner/video/.recording/hls/${scope.attemptId}/${scope.generationId}/`;
	const data = Buffer.from("S3 fixture");
	const sha256 = createHash("sha256").update(data).digest("hex");
	const identity = {
		provider: "s3" as const,
		versionId: "version+1/=",
		etag: '"opaque-2"',
		sha256,
	};
	const request: HlsPinnedRead = {
		key: `${prefix}video/init.mp4`,
		identity,
		signal: new AbortController().signal,
	};
	const client = new S3Client({
		region: "us-east-1",
		credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
	});
	const result = () => ({
		$metadata: { httpStatusCode: 200 },
		ContentLength: data.length,
		VersionId: identity.versionId,
		ETag: identity.etag,
		ChecksumType: "FULL_OBJECT" as const,
		ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
	});
	const sources: Readable[] = [];
	const send = vi.spyOn(client, "send").mockImplementation(async (command) => {
		if (command instanceof GetObjectCommand) {
			const source = Readable.from([data.subarray(0, 3), data.subarray(3)]);
			sources.push(source);
			return { ...result(), Body: sdkStreamFixture(source) };
		}
		return result();
	});
	const storage = createHlsS3VerificationStorage({
		client,
		bucket: "private-bucket",
		scope,
	});
	return {
		scope,
		prefix,
		data,
		identity,
		request,
		client,
		send,
		result,
		sources,
		storage,
	};
}

function snapshotManifest(f: ReturnType<typeof fixture>) {
	const inventory: HlsInventory = {
		version: 1,
		storageProvider: "s3",
		ownerId: f.scope.ownerId,
		videoId: f.scope.videoId,
		attemptId: f.scope.attemptId,
		generationId: f.scope.generationId,
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
				key: f.request.key,
				size: f.data.length,
				identity: f.identity,
			},
			{
				role: "segment",
				id: "segment",
				trackId: "v",
				codec: "h264",
				key: `${f.prefix}video/segment_001.m4s`,
				size: f.data.length,
				identity: f.identity,
				sequence: 1,
				duration: 3,
			},
		],
	};
	return sealHlsInventory(inventory);
}

it("pins HEAD and GET to the actual bucket/version/ETag with checksum mode and abort signal", async () => {
	const f = fixture();
	try {
		expect(await f.storage.head(f.request)).toEqual({
			key: f.request.key,
			size: f.data.length,
			identity: f.identity,
		});
		const response = await f.storage.open(f.request);
		expect(await new Response(response.body).text()).toBe(f.data.toString());
		expect(f.send).toHaveBeenCalledTimes(2);
		const [head, headOptions] = f.send.mock.calls[0] ?? [];
		const [get, getOptions] = f.send.mock.calls[1] ?? [];
		expect(head).toBeInstanceOf(HeadObjectCommand);
		expect(get).toBeInstanceOf(GetObjectCommand);
		for (const command of [head, get])
			expect(command?.input).toEqual({
				Bucket: "private-bucket",
				Key: f.request.key,
				VersionId: f.identity.versionId,
				IfMatch: f.identity.etag,
				ChecksumMode: "ENABLED",
			});
		expect(headOptions).toEqual({ abortSignal: f.request.signal });
		expect(getOptions).toEqual({ abortSignal: f.request.signal });
	} finally {
		f.client.destroy();
	}
});
it("copies and freezes trusted binding without freezing the caller", async () => {
	const f = fixture();
	try {
		f.scope.videoId = "changed";
		expect(Object.isFrozen(f.storage.scope)).toBe(true);
		expect(f.storage.scope.videoId).toBe("video");
		await f.storage.head(f.request);
		expect(f.send.mock.calls[0]?.[0].input).toMatchObject({
			Bucket: "private-bucket",
		});
	} finally {
		f.client.destroy();
	}
});
it.each([
	"other/video/init.mp4",
	"owner/other/init.mp4",
	"https://origin.example/init.mp4",
	"//origin/init.mp4",
])("rejects unrelated key %s before SDK", async (key) => {
	const f = fixture();
	try {
		await expect(f.storage.head({ ...f.request, key })).rejects.toMatchObject({
			code: "scope-mismatch",
		});
		expect(f.send).not.toHaveBeenCalled();
	} finally {
		f.client.destroy();
	}
});
it.each([
	"../init.mp4",
	"%2e%2e/init.mp4",
	"./init.mp4",
	"a//init.mp4",
	"init.mp4?token=x",
	"init.jpg",
])("rejects malicious suffix %s", async (suffix) => {
	const f = fixture();
	try {
		await expect(
			f.storage.open({ ...f.request, key: f.prefix + suffix }),
		).rejects.toMatchObject({ code: "scope-mismatch" });
		expect(f.send).not.toHaveBeenCalled();
	} finally {
		f.client.destroy();
	}
});
it.each([
	{
		provider: "s3",
		versionId: "null",
		etag: '"opaque-2"',
		sha256: "a".repeat(64),
	},
	{
		provider: "s3",
		versionId: "https://s3.example",
		etag: '"opaque-2"',
		sha256: "a".repeat(64),
	},
	{
		provider: "s3",
		versionId: "version",
		etag: "unquoted",
		sha256: "a".repeat(64),
	},
	{ provider: "s3", versionId: "version", etag: '"opaque-2"', sha256: "bad" },
	{ provider: "drive", fileId: "f", revisionId: "r", sha256: "a".repeat(64) },
])("rejects ambiguous requested identity %# before SDK", async (identity) => {
	const f = fixture();
	try {
		await expect(
			f.storage.head({
				...f.request,
				identity: identity as HlsPinnedRead["identity"],
			}),
		).rejects.toMatchObject({ code: "scope-mismatch" });
		expect(f.send).not.toHaveBeenCalled();
	} finally {
		f.client.destroy();
	}
});
it.each([
	{ VersionId: "other" },
	{ VersionId: undefined },
	{ ETag: '"other"' },
	{ ETag: undefined },
	{ ChecksumSHA256: undefined },
	{ ChecksumSHA256: "bad" },
	{ ChecksumSHA256: Buffer.alloc(32, 1).toString("base64") },
	{ ChecksumType: "COMPOSITE" },
	{ ChecksumType: undefined },
	{ ChecksumType: "UNKNOWN" },
	{ ContentLength: 0 },
	{ ContentLength: -1 },
	{ ContentLength: undefined },
	{ ContentLength: NaN },
	{ ContentLength: Infinity },
	{ DeleteMarker: true },
	{ $metadata: { httpStatusCode: 302 } },
	{ $metadata: { httpStatusCode: 206 } },
	{ ContentRange: "bytes 0-1/10" },
])(
	"rejects actual HEAD identity/status/checksum mismatch %#",
	async (change) => {
		const f = fixture();
		try {
			f.send.mockImplementation(async () => ({ ...f.result(), ...change }));
			await expect(f.storage.head(f.request)).rejects.toMatchObject({
				code: "object-changed",
			});
		} finally {
			f.client.destroy();
		}
	},
);
it("rejects noncanonical base64 with nonzero padding bits", async () => {
	const f = fixture();
	try {
		const canonical = f.result().ChecksumSHA256;
		const chars =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		const tail = canonical[42];
		if (!tail) throw new Error("fixture");
		const noncanonical = `${canonical.slice(0, 42)}${chars[chars.indexOf(tail) + 1]}=`;
		expect(Buffer.from(noncanonical, "base64")).toEqual(
			Buffer.from(canonical, "base64"),
		);
		f.send.mockImplementation(async () => ({
			...f.result(),
			ChecksumSHA256: noncanonical,
		}));
		await expect(f.storage.head(f.request)).rejects.toMatchObject({
			code: "object-changed",
		});
	} finally {
		f.client.destroy();
	}
});
it.each([
	{ VersionId: "other" },
	{ ChecksumType: "COMPOSITE" },
	{ $metadata: { httpStatusCode: 206 } },
	{ DeleteMarker: true },
])(
	"destroys rejected GET body before handing it to callers %#",
	async (change) => {
		const f = fixture();
		const source = new Readable({ read() {} });
		try {
			f.send.mockImplementation(async () => ({
				...f.result(),
				...change,
				Body: sdkStreamFixture(source),
			}));
			await expect(f.storage.open(f.request)).rejects.toMatchObject({
				code: "object-changed",
			});
			expect(source.destroyed).toBe(true);
		} finally {
			source.destroy();
			f.client.destroy();
		}
	},
);
it("requires a GET body and sanitizes provider failures", async () => {
	const f = fixture();
	try {
		const initial = await f.storage.open(f.request);
		await initial.body.cancel();
		f.send.mockImplementation(async () => f.result());
		await expect(f.storage.open(f.request)).rejects.toMatchObject({
			code: "object-changed",
		});
		f.send.mockRejectedValue(
			new Error("https://origin.example?signature=secret"),
		);
		await expect(f.storage.head(f.request)).rejects.toMatchObject({
			code: "storage-unavailable",
			message: "HLS snapshot verification failed: storage-unavailable",
		});
	} finally {
		f.client.destroy();
	}
});
it("does not contact SDK for an already aborted read", async () => {
	const f = fixture();
	try {
		const controller = new AbortController();
		controller.abort();
		await expect(
			f.storage.open({ ...f.request, signal: controller.signal }),
		).rejects.toMatchObject({ code: "aborted" });
		expect(f.send).not.toHaveBeenCalled();
	} finally {
		f.client.destroy();
	}
});
it("destroys late GET bytes when the request aborts during send", async () => {
	const f = fixture();
	const source = new Readable({ read() {} });
	const controller = new AbortController();
	try {
		f.send.mockImplementation(async () => {
			controller.abort();
			return { ...f.result(), Body: sdkStreamFixture(source) };
		});
		await expect(
			f.storage.open({ ...f.request, signal: controller.signal }),
		).rejects.toMatchObject({ code: "aborted" });
		expect(source.destroyed).toBe(true);
	} finally {
		source.destroy();
		f.client.destroy();
	}
});
it("cancels the S3 stream on downstream cancellation without buffering", async () => {
	const f = fixture();
	const source = new Readable({ read() {} });
	try {
		const body = Object.assign(source, {
			transformToWebStream: () => {
				const reader = Readable.toWeb(source).getReader();
				return new ReadableStream<Uint8Array>(
					{
						async pull(controller) {
							try {
								const part = await reader.read();
								if (part.done) {
									reader.releaseLock();
									controller.close();
								} else {
									if (!(part.value instanceof Uint8Array))
										throw new Error("Invalid fixture chunk");
									controller.enqueue(part.value);
								}
							} catch (error) {
								reader.releaseLock();
								throw error;
							}
						},
						cancel() {
							void reader.cancel().catch(() => {});
							reader.releaseLock();
						},
					},
					{ highWaterMark: 0 },
				);
			},
			transformToByteArray: vi.fn(),
			transformToString: vi.fn(),
		});
		f.send.mockImplementation(async () => ({ ...f.result(), Body: body }));
		const response = await f.storage.open(f.request);
		await response.body.cancel();
		expect(source.destroyed).toBe(true);
		expect(body.transformToByteArray).not.toHaveBeenCalled();
		expect(body.transformToString).not.toHaveBeenCalled();
	} finally {
		source.destroy();
		f.client.destroy();
	}
});
it("cancels the origin on AbortSignal and sanitizes stream errors", async () => {
	const f = fixture();
	const controller = new AbortController();
	const source = new Readable({ read() {} });
	try {
		f.send.mockImplementation(async () => ({
			...f.result(),
			Body: sdkStreamFixture(source),
		}));
		const response = await f.storage.open({
			...f.request,
			signal: controller.signal,
		});
		controller.abort();
		await expect(new Response(response.body).text()).rejects.toMatchObject({
			code: "aborted",
		});
		expect(source.destroyed).toBe(true);
	} finally {
		source.destroy();
		f.client.destroy();
	}
});
it("rejects invalid bucket/scope bindings without SDK", () => {
	const f = fixture();
	try {
		for (const bucket of [
			"https://origin.example",
			"bucket/key",
			"bad..bucket",
		])
			expect(() =>
				createHlsS3VerificationStorage({
					client: f.client,
					bucket,
					scope: f.scope,
				}),
			).toThrow();
		expect(() =>
			createHlsS3VerificationStorage({
				client: f.client,
				bucket: "private-bucket",
				scope: { ...f.scope, storageProvider: "drive" },
			}),
		).toThrow();
		expect(f.send).not.toHaveBeenCalled();
	} finally {
		f.client.destroy();
	}
});
it("verifies an entire inactive snapshot using the real adapter and SDK command fixtures", async () => {
	const f = fixture();
	try {
		const snapshot = await prepareVerifiedHlsSnapshot(
			snapshotManifest(f),
			f.scope,
			f.storage,
		);
		expect(snapshot.objects).toHaveLength(2);
		expect(snapshot.totalBytes).toBe(f.data.length * 2);
		expect(f.send).toHaveBeenCalledTimes(6);
		expect(
			f.send.mock.calls.every(
				([command]) =>
					command instanceof HeadObjectCommand ||
					command instanceof GetObjectCommand,
			),
		).toBe(true);
	} finally {
		f.client.destroy();
	}
});

it("sanitizes failures emitted by the origin byte stream", async () => {
	const f = fixture();
	const source = new Readable({
		read() {
			this.destroy(new Error("https://origin.example?signature=secret"));
		},
	});
	try {
		f.send.mockImplementation(async () => ({
			...f.result(),
			Body: sdkStreamFixture(source),
		}));
		const response = await f.storage.open(f.request);
		await expect(new Response(response.body).text()).rejects.toMatchObject({
			code: "storage-unavailable",
			message: "HLS snapshot verification failed: storage-unavailable",
		});
	} finally {
		source.destroy();
		f.client.destroy();
	}
});
it("releases the upstream reader even when stream cancellation never settles", async () => {
	const f = fixture();
	const source = new Readable({ read() {} });
	const cancel = vi.fn(() => new Promise<void>(() => {}));
	const origin = new ReadableStream<Uint8Array>(
		{ cancel },
		{ highWaterMark: 0 },
	);
	try {
		const body = Object.assign(source, {
			transformToWebStream: () => origin,
			transformToByteArray: vi.fn(async () => new Uint8Array()),
			transformToString: vi.fn(async () => ""),
		});
		f.send.mockImplementation(async () => ({ ...f.result(), Body: body }));
		const response = await f.storage.open(f.request);
		expect(origin.locked).toBe(true);
		await response.body.cancel();
		expect(cancel).toHaveBeenCalledOnce();
		expect(origin.locked).toBe(false);
	} finally {
		source.destroy();
		f.client.destroy();
	}
});
it("the engine rejects wrong bytes even when S3 metadata claims the expected full-object SHA256", async () => {
	const f = fixture();
	try {
		f.send.mockImplementation(async (command) =>
			command instanceof GetObjectCommand
				? {
						...f.result(),
						Body: sdkStreamFixture(
							Readable.from([Buffer.alloc(f.data.length)]),
						),
					}
				: f.result(),
		);
		await expect(
			prepareVerifiedHlsSnapshot(snapshotManifest(f), f.scope, f.storage),
		).rejects.toMatchObject({ code: "content-mismatch" });
		expect(f.send).toHaveBeenCalledTimes(2);
	} finally {
		f.client.destroy();
	}
});
it("destroys an ignored-signal late SDK GET body after the engine timed out", async () => {
	const f = fixture();
	const source = new Readable({ read() {} });
	let finish: (() => void) | undefined;
	try {
		f.send.mockImplementation(async (command) =>
			command instanceof GetObjectCommand
				? new Promise<GetObjectCommandOutput>((resolve) => {
						finish = () =>
							resolve({ ...f.result(), Body: sdkStreamFixture(source) });
					})
				: f.result(),
		);
		await expect(
			prepareVerifiedHlsSnapshot(snapshotManifest(f), f.scope, f.storage, {
				timeoutMs: 10,
			}),
		).rejects.toMatchObject({ code: "aborted" });
		expect(finish).toBeTypeOf("function");
		finish?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(source.destroyed).toBe(true);
	} finally {
		source.destroy();
		f.client.destroy();
	}
});
it("rejects keys longer than the contract maximum before SDK calls", async () => {
	const f = fixture();
	try {
		await expect(
			f.storage.head({
				...f.request,
				key: `${f.prefix}${"x".repeat(1024)}.m4s`,
			}),
		).rejects.toMatchObject({ code: "scope-mismatch" });
		expect(f.send).not.toHaveBeenCalled();
	} finally {
		f.client.destroy();
	}
});
