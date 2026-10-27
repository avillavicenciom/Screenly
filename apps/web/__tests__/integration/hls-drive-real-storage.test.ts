import { closeSync, openSync, readSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createHlsDriveVerificationStorage } from "@/lib/hls-drive-verification-storage";
import { sealHlsInventory } from "@/lib/hls-publication-contract";
import {
	type HlsVerificationScope,
	prepareVerifiedHlsSnapshot,
} from "@/lib/hls-snapshot-verification";

const expected = [
	{
		name: "init.mp4",
		size: 826,
		sha256: "96c57394149a06bd56a7e7510561bddd41d5e3e3341822e4328b9f6f8cb007e2",
	},
	{
		name: "segment_000.m4s",
		size: 1151,
		sha256: "89a500a7fee616f091278abb7f15b88225dc6a860b902dbcad744a2fc1febdc4",
	},
] as const;
const mappingSchema = z
	.array(
		z
			.object({
				name: z.enum(["init.mp4", "segment_000.m4s"]),
				size: z.number().int().positive(),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
				fileId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
				revisionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
				mimeType: z.enum(["video/mp4", "application/octet-stream"]),
			})
			.strict(),
	)
	.length(2);
type Mapping = z.infer<typeof mappingSchema>;
const scope: HlsVerificationScope = {
	ownerId: "screenly-lab-owner",
	videoId: "screenly-lab-video",
	attemptId: "11111111-1111-4111-8111-111111111111",
	generationId: "22222222-2222-4222-8222-222222222222",
	storageProvider: "drive",
	storageBindingId: "screenly-lab-drive",
};
const prefix = `${scope.ownerId}/${scope.videoId}/.recording/hls/${scope.attemptId}/${scope.generationId}/video/`;
const live = process.env.SCREENLY_HLS_DRIVE_LIVE === "1";
const credentialMarker = "screenly-lab-transport-credential";

describe.skipIf(!live)(
	"isolated read-only Drive storage (explicit opt-in)",
	() => {
		let mapping: Mapping;
		beforeAll(() => {
			const path = process.env.SCREENLY_HLS_TEST_DRIVE_MAPPING_FILE;
			if (!path || !process.env.SCREENLY_HLS_TEST_DRIVE_ACCESS_TOKEN)
				throw new Error("Drive lab mapping and credential are required");
			try {
				const file = openSync(path, "r");
				try {
					const buffer = Buffer.alloc(64 * 1024 + 1);
					let size = 0;
					while (size < buffer.length) {
						const count = readSync(
							file,
							buffer,
							size,
							buffer.length - size,
							null,
						);
						if (count === 0) break;
						size += count;
					}
					if (size > 64 * 1024) throw new Error("Oversized mapping");
					const text = new TextDecoder("utf-8", { fatal: true }).decode(
						buffer.subarray(0, size),
					);
					mapping = mappingSchema.parse(JSON.parse(text) as unknown);
				} finally {
					closeSync(file);
				}
			} catch {
				throw new Error("Invalid Drive lab mapping");
			}
			for (const wanted of expected) {
				const matches = mapping.filter((file) => file.name === wanted.name);
				if (
					matches.length !== 1 ||
					matches[0]?.size !== wanted.size ||
					matches[0]?.sha256 !== wanted.sha256
				)
					throw new Error("Drive mapping differs from local synthetic fixture");
			}
			if (mapping[0]?.fileId === mapping[1]?.fileId)
				throw new Error("Drive fixtures must be distinct files");
		});
		function setup() {
			let requests = 0;
			const storage = createHlsDriveVerificationStorage({
				scope,
				getAccessToken: async () => credentialMarker,
				resolveFileId: async (key) =>
					mapping.find((file) => key === `${prefix}${file.name}`)?.fileId ??
					null,
				fetch: async (url, init) => {
					const target = new URL(url);
					const headers = new Headers(init.headers);
					const allowed = mapping.some(
						(file) =>
							target.pathname === `/drive/v3/files/${file.fileId}` ||
							target.pathname ===
								`/drive/v3/files/${file.fileId}/revisions/${file.revisionId}`,
					);
					if (
						target.origin !== "https://www.googleapis.com" ||
						!allowed ||
						init.method !== "GET" ||
						init.redirect !== "manual" ||
						headers.get("authorization") !== `Bearer ${credentialMarker}` ||
						++requests > 12
					)
						throw new Error("Drive lab read boundary rejected request");
					const token = process.env.SCREENLY_HLS_TEST_DRIVE_ACCESS_TOKEN;
					if (!token) throw new Error("Drive lab credential unavailable");
					headers.set("authorization", `Bearer ${token}`);
					return fetch(url, { ...init, headers });
				},
			});
			const entries = mapping.map((file) => ({
				role:
					file.name === "init.mp4" ? ("init" as const) : ("segment" as const),
				id: file.name === "init.mp4" ? "init" : "segment",
				trackId: "v",
				codec: "h264" as const,
				key: `${prefix}${file.name}`,
				size: file.size,
				identity: {
					provider: "drive" as const,
					fileId: file.fileId,
					revisionId: file.revisionId,
					sha256: file.sha256,
				},
				...(file.name === "segment_000.m4s"
					? { sequence: 1, duration: 1 }
					: {}),
			}));
			const manifest = sealHlsInventory({
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
				tracks: [
					{ id: "v", kind: "video", codec: "h264", variantId: "variant" },
				],
				entries: [
					{ role: "master", id: "master", variantIds: ["variant"] },
					{
						role: "variant",
						id: "variant",
						trackId: "v",
						initId: "init",
						segmentIds: ["segment"],
					},
					...entries,
				],
			});
			const file = mapping.find((entry) => entry.name === "init.mp4");
			if (!file) throw new Error("Missing init fixture");
			const request = {
				key: `${prefix}${file.name}`,
				identity: {
					provider: "drive" as const,
					fileId: file.fileId,
					revisionId: file.revisionId,
					sha256: file.sha256,
				},
				signal: AbortSignal.timeout(15_000),
			};
			return { storage, manifest, request, requests: () => requests };
		}
		it("verifies both exact revisions and independently hashes 1977 bytes", async () => {
			const f = setup();
			const result = await prepareVerifiedHlsSnapshot(
				f.manifest,
				scope,
				f.storage,
				{
					maxObjectBytes: 2048,
					maxTotalBytes: 4096,
					maxObjects: 2,
					timeoutMs: 15_000,
				},
			);
			expect(result.kind).toBe("verified-hls-snapshot");
			expect(result.totalBytes).toBe(1977);
			expect(result.objects).toHaveLength(2);
			expect(f.requests()).toBe(10);
			expect(Object.isFrozen(result)).toBe(true);
		});
		it.each(["revision", "sha256"])(
			"rejects incorrect %s against real metadata",
			async (field) => {
				const f = setup();
				const identity = {
					...f.request.identity,
					...(field === "revision"
						? { revisionId: `${f.request.identity.revisionId}-wrong` }
						: { sha256: "0".repeat(64) }),
				};
				await expect(
					f.storage.head({ ...f.request, identity }),
				).rejects.toMatchObject({
					code: "object-changed",
				});
				expect(f.requests()).toBe(1);
			},
		);
		it("rejects wrong expected size without returning a snapshot", async () => {
			const f = setup();
			const changed = structuredClone(f.manifest.inventory);
			for (const entry of changed.entries)
				if (entry.role === "init") entry.size += 1;
			await expect(
				prepareVerifiedHlsSnapshot(sealHlsInventory(changed), scope, f.storage),
			).rejects.toMatchObject({ code: "object-changed" });
			expect(f.requests()).toBe(1);
		});
		it("rejects a foreign key before network IO", async () => {
			const f = setup();
			await expect(
				f.storage.open({ ...f.request, key: "other/video/init.mp4" }),
			).rejects.toMatchObject({ code: "scope-mismatch" });
			expect(f.requests()).toBe(0);
		});
		it("rejects a foreign file identity before network IO", async () => {
			const f = setup();
			await expect(
				f.storage.open({
					...f.request,
					identity: { ...f.request.identity, fileId: "not-the-mapped-file" },
				}),
			).rejects.toMatchObject({ code: "scope-mismatch" });
			expect(f.requests()).toBe(0);
		});
		it("rejects an invalid digest before network IO", async () => {
			const f = setup();
			await expect(
				prepareVerifiedHlsSnapshot(
					{ ...f.manifest, digest: "0".repeat(64) },
					scope,
					f.storage,
				),
			).rejects.toMatchObject({ code: "invalid-contract" });
			expect(f.requests()).toBe(0);
		});
		it("honors abort before network IO", async () => {
			const f = setup();
			await expect(
				f.storage.open({ ...f.request, signal: AbortSignal.abort() }),
			).rejects.toMatchObject({ code: "aborted" });
			expect(f.requests()).toBe(0);
		});
		it("allows the consumer to cancel an opened real revision", async () => {
			const f = setup();
			const opened = await f.storage.open(f.request);
			const reader = opened.body.getReader();
			await reader.cancel();
			reader.releaseLock();
			expect(opened.body.locked).toBe(false);
			expect(f.requests()).toBe(3);
		});
	},
);
