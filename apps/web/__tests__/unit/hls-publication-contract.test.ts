import { describe, expect, it, vi } from "vitest";
import {
	canonicalHlsInventory,
	digestHlsInventory,
	HLS_CONTRACT_LIMITS,
	type HlsInventory,
	sealHlsInventory,
	validateHlsInventory,
	validateHlsManifest,
	validateHlsProgression,
} from "@/lib/hls-publication-contract";

function fixture(
	audio: "none" | "optional" | "required" = "none",
): HlsInventory {
	const attemptId = "11111111-1111-4111-8111-111111111111";
	const generationId = "22222222-2222-4222-8222-222222222222";
	const prefix = `owner/video/.recording/hls/${attemptId}/${generationId}/`;
	const identity = {
		provider: "s3" as const,
		versionId: "version+1/=",
		etag: '"opaque-2"',
		sha256: "a".repeat(64),
	};
	const inventory: HlsInventory = {
		version: 1,
		storageProvider: "s3",
		ownerId: "owner",
		videoId: "video",
		attemptId,
		generationId,
		revision: 1,
		previousDigest: null,
		mode: "EVENT",
		audioIntent: audio,
		masterId: "master",
		tracks: [{ id: "v", kind: "video", codec: "h264", variantId: "variant-v" }],
		entries: [
			{ role: "master", id: "master", variantIds: ["variant-v"] },
			{
				role: "variant",
				id: "variant-v",
				trackId: "v",
				initId: "init-v",
				segmentIds: ["seg-v-1"],
			},
			{
				role: "init",
				id: "init-v",
				trackId: "v",
				codec: "h264",
				key: `${prefix}v/init.mp4`,
				size: 128,
				identity,
			},
			{
				role: "segment",
				id: "seg-v-1",
				trackId: "v",
				codec: "h264",
				key: `${prefix}v/segment_001.m4s`,
				size: 256,
				identity,
				sequence: 1,
				duration: 3,
			},
		],
	};
	if (audio === "required") {
		inventory.tracks.push({
			id: "a",
			kind: "audio",
			codec: "aac",
			variantId: "variant-a",
		});
		const master = inventory.entries[0];
		if (master?.role === "master") master.variantIds.push("variant-a");
		inventory.entries.push(
			{
				role: "variant",
				id: "variant-a",
				trackId: "a",
				initId: "init-a",
				segmentIds: ["seg-a-1"],
			},
			{
				role: "init",
				id: "init-a",
				trackId: "a",
				codec: "aac",
				key: `${prefix}a/init.mp4`,
				size: 128,
				identity,
			},
			{
				role: "segment",
				id: "seg-a-1",
				trackId: "a",
				codec: "aac",
				key: `${prefix}a/segment_001.m4s`,
				size: 256,
				identity,
				sequence: 1,
				duration: 3,
			},
		);
	}
	return inventory;
}
function append(input: HlsInventory) {
	const next = structuredClone(input);
	next.revision++;
	next.previousDigest = digestHlsInventory(input);
	const variant = next.entries.find((entry) => entry.id === "variant-v");
	const segment = next.entries.find((entry) => entry.id === "seg-v-1");
	if (variant?.role !== "variant" || segment?.role !== "segment")
		throw new Error("Invalid fixture");
	variant.segmentIds.push("seg-v-2");
	next.entries.push({
		...segment,
		id: "seg-v-2",
		sequence: 2,
		key: segment.key.replace("001", "002"),
	});
	return next;
}
function mutateEntry(
	input: HlsInventory,
	change: Record<string, unknown>,
	id = "seg-v-1",
) {
	return {
		...input,
		entries: input.entries.map((entry) =>
			entry.id === id ? { ...entry, ...change } : entry,
		),
	};
}

describe("isolated HLS inventory", () => {
	it.each(["none", "optional", "required"] as const)(
		"validates EVENT and VOD with %s audio",
		(audio) => {
			const input = fixture(audio);
			expect(validateHlsManifest(sealHlsInventory(input)).inventory).toEqual(
				input,
			);
			expect(validateHlsInventory({ ...input, mode: "VOD" }).mode).toBe("VOD");
		},
	);
	it("validates explicit Drive revisions and checksum", () => {
		const input = fixture();
		input.storageProvider = "drive";
		input.entries = input.entries.map((entry) =>
			entry.role === "init" || entry.role === "segment"
				? {
						...entry,
						identity: {
							provider: "drive",
							fileId: entry.id,
							revisionId: "revision",
							sha256: "b".repeat(64),
						},
					}
				: entry,
		);
		expect(validateHlsInventory(input)).toEqual(input);
	});
	it("is deterministic across object keys and inventory enumeration order", () => {
		const a = fixture("required");
		const b = {
			...a,
			entries: [...a.entries].reverse(),
			tracks: [...a.tracks].reverse(),
		};
		expect(canonicalHlsInventory(a)).toBe(canonicalHlsInventory(b));
		expect(digestHlsInventory(a)).toBe(digestHlsInventory(b));
		expect(digestHlsInventory(JSON.parse(JSON.stringify(a, null, 2)))).toBe(
			digestHlsInventory(a),
		);
	});
	it.each([
		"other/video/x.m4s",
		"owner/other/x.m4s",
		"../x.m4s",
		"https://s3.example/x.m4s",
		"//s3.example/x.m4s",
	])("rejects foreign or external key %s", (key) => {
		expect(() =>
			validateHlsInventory(mutateEntry(fixture(), { key })),
		).toThrow();
	});
	it.each([
		"../x.m4s",
		"%2e%2e/x.m4s",
		"./x.m4s",
		"a//x.m4s",
		"a.m4s?token=secret",
	])("rejects traversal and encoded escapes %s", (suffix) => {
		const input = fixture();
		const segment = input.entries[3];
		if (segment?.role !== "segment") throw new Error("fixture");
		expect(() =>
			validateHlsInventory(
				mutateEntry(input, {
					key: segment.key.replace("v/segment_001.m4s", suffix),
				}),
			),
		).toThrow();
	});
	it.each([0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid segment size %s",
		(size) =>
			expect(() =>
				validateHlsInventory(mutateEntry(fixture(), { size })),
			).toThrow(),
	);
	it.each([0, -1, NaN, Infinity, 3601])(
		"rejects invalid duration %s",
		(duration) =>
			expect(() =>
				validateHlsInventory(mutateEntry(fixture(), { duration })),
			).toThrow(),
	);
	it.each([0, 2, 1.5, -1])("rejects noncontiguous sequence %s", (sequence) =>
		expect(() =>
			validateHlsInventory(mutateEntry(fixture(), { sequence })),
		).toThrow(),
	);
	it.each([
		{ provider: "s3", etag: '"multipart-2"' },
		{
			provider: "s3",
			versionId: "null",
			etag: '"hash"',
			sha256: "a".repeat(64),
		},
		{ provider: "s3", versionId: "v", etag: '"hash"', sha256: "bad" },
		{ provider: "drive", fileId: "f", sha256: "a".repeat(64) },
		{ provider: "drive", fileId: "f", revisionId: "r", sha256: "a".repeat(64) },
	])("rejects missing, ambiguous or mismatched identity %#", (identity) =>
		expect(() =>
			validateHlsInventory(mutateEntry(fixture(), { identity })),
		).toThrow(),
	);
	it.each(["master", "missing", "variant-v"])(
		"rejects circular, missing or wrong-role segment ref %s",
		(reference) => {
			expect(() =>
				validateHlsInventory(
					mutateEntry(fixture(), { segmentIds: [reference] }, "variant-v"),
				),
			).toThrow();
		},
	);
	it("rejects cyclic JS inputs before serialization", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => validateHlsInventory(cyclic)).toThrow();
	});
	it("rejects getters without evaluating them", () => {
		let invoked = false;
		const input = {
			get version() {
				invoked = true;
				return 1;
			},
		};
		expect(() => validateHlsInventory(input)).toThrow();
		expect(invoked).toBe(false);
	});
	it("rejects duplicate entries and references", () => {
		const input = fixture();
		expect(() =>
			validateHlsInventory({
				...input,
				entries: [...input.entries, input.entries[3]],
			}),
		).toThrow();
		expect(() =>
			validateHlsInventory(
				mutateEntry(input, { segmentIds: ["seg-v-1", "seg-v-1"] }, "variant-v"),
			),
		).toThrow();
	});
	it("rejects mismatched track, init codec, and missing required audio", () => {
		expect(() =>
			validateHlsInventory(mutateEntry(fixture(), { trackId: "other" })),
		).toThrow();
		expect(() =>
			validateHlsInventory(mutateEntry(fixture(), { codec: "aac" }, "init-v")),
		).toThrow();
		expect(() =>
			validateHlsInventory({ ...fixture(), audioIntent: "required" }),
		).toThrow();
	});
	it("rejects unknown versions and extra metadata", () => {
		expect(() => validateHlsInventory({ ...fixture(), version: 2 })).toThrow();
		expect(() =>
			validateHlsInventory({ ...fixture(), public: true }),
		).toThrow();
		expect(() =>
			validateHlsInventory(
				mutateEntry(fixture(), { originUrl: "https://s3.example" }),
			),
		).toThrow();
	});
	it("rejects missing and incorrect digests", () => {
		expect(() => validateHlsManifest({ inventory: fixture() })).toThrow();
		expect(() =>
			validateHlsManifest({
				...sealHlsInventory(fixture()),
				digest: "0".repeat(64),
			}),
		).toThrow();
	});
	it("bounds depth, strings, entry count, and sparse arrays", () => {
		let deep: unknown = null;
		for (let i = 0; i < 20; i++) deep = { deep };
		expect(() => validateHlsInventory(deep)).toThrow();
		expect(() =>
			validateHlsInventory({
				...fixture(),
				videoId: "x".repeat(HLS_CONTRACT_LIMITS.bytes + 1),
			}),
		).toThrow();
		expect(() =>
			validateHlsInventory({
				...fixture(),
				entries: new Array(HLS_CONTRACT_LIMITS.entries + 1).fill(null),
			}),
		).toThrow();
		expect(() =>
			validateHlsInventory({ ...fixture(), entries: new Array(4) }),
		).toThrow();
	});
});
describe("EVENT revision progression", () => {
	it("appends and closes to VOD without altering admitted objects", () => {
		const a = fixture();
		const b = append(a);
		expect(
			validateHlsProgression(sealHlsInventory(a), sealHlsInventory(b)).inventory
				.revision,
		).toBe(2);
		expect(
			validateHlsProgression(
				sealHlsInventory(a),
				sealHlsInventory({ ...b, mode: "VOD" }),
			).inventory.mode,
		).toBe("VOD");
	});
	it.each(["size", "key", "duration", "identity"])(
		"rejects retroactive %s changes even with a newly computed digest",
		(field) => {
			const a = fixture();
			const b = append(a);
			const segment = b.entries[3];
			if (segment?.role !== "segment") throw new Error("fixture");
			const changes = {
				size: 512,
				key: segment.key.replace("001", "old"),
				duration: 4,
				identity: { ...segment.identity, sha256: "b".repeat(64) },
			};
			expect(() =>
				validateHlsProgression(
					sealHlsInventory(a),
					sealHlsInventory(
						mutateEntry(b, { [field]: changes[field as keyof typeof changes] }),
					),
				),
			).toThrow();
		},
	);
	it.each([
		"attemptId",
		"generationId",
		"videoId",
		"ownerId",
		"audioIntent",
		"revision",
		"previousDigest",
	])("rejects changes to %s", (field) => {
		const a = fixture();
		const b = append(a);
		const changed = {
			...b,
			[field]:
				field === "revision"
					? 4
					: field === "previousDigest"
						? "0".repeat(64)
						: field === "audioIntent"
							? "optional"
							: "other",
		};
		expect(() =>
			validateHlsProgression(sealHlsInventory(a), sealHlsInventory(changed)),
		).toThrow();
	});
	it("never extends a VOD generation", () => {
		const a = { ...fixture(), mode: "VOD" as const };
		expect(() =>
			validateHlsProgression(sealHlsInventory(a), sealHlsInventory(append(a))),
		).toThrow();
	});
});

it("rejects a structurally valid next inventory belonging to another attempt", () => {
	const a = fixture();
	const b = append(a);
	const attemptId = "33333333-3333-4333-8333-333333333333";
	const changed = {
		...b,
		attemptId,
		entries: b.entries.map((item) =>
			item.role === "init" || item.role === "segment"
				? { ...item, key: item.key.replace(a.attemptId, attemptId) }
				: item,
		),
	};
	expect(() => sealHlsInventory(changed)).not.toThrow();
	expect(() =>
		validateHlsProgression(sealHlsInventory(a), sealHlsInventory(changed)),
	).toThrow();
});
it("rejects removing an already published segment from an otherwise valid inventory", () => {
	const a = append(fixture());
	const next = {
		...fixture(),
		revision: 3,
		previousDigest: digestHlsInventory(a),
	};
	expect(() => sealHlsInventory(next)).not.toThrow();
	expect(() =>
		validateHlsProgression(sealHlsInventory(a), sealHlsInventory(next)),
	).toThrow();
});
it("rejects reordering an otherwise valid published sequence", () => {
	const a = append(fixture());
	const b = structuredClone(a);
	b.revision++;
	b.previousDigest = digestHlsInventory(a);
	b.entries = b.entries.map((item) =>
		item.role === "segment"
			? { ...item, sequence: item.sequence === 1 ? 2 : 1 }
			: item.role === "variant"
				? { ...item, segmentIds: [...item.segmentIds].reverse() }
				: item,
	);
	expect(() => sealHlsInventory(b)).not.toThrow();
	expect(() =>
		validateHlsProgression(sealHlsInventory(a), sealHlsInventory(b)),
	).toThrow();
});
it("enforces a maximum total duration per track", () => {
	const input = fixture();
	const source = input.entries[3];
	if (source?.role !== "segment") throw new Error("fixture");
	const segments = Array.from({ length: 25 }, (_, index) => ({
		...source,
		id: `s${index}`,
		sequence: index + 1,
		duration: 3600,
		key: source.key.replace("segment_001", `segment_${index}`),
	}));
	input.entries = input.entries
		.filter((item) => item.role !== "segment")
		.map((item) =>
			item.role === "variant"
				? { ...item, segmentIds: segments.map((segment) => segment.id) }
				: item,
		);
	input.entries.push(...segments);
	expect(() => validateHlsInventory(input)).toThrow();
});
it("rejects unreachable objects, excess tracks and unknown reference fields", () => {
	const input = fixture();
	const source = input.entries[3];
	if (source?.role !== "segment") throw new Error("fixture");
	expect(() =>
		validateHlsInventory({
			...input,
			entries: [
				...input.entries,
				{ ...source, id: "orphan", key: source.key.replace("001", "999") },
			],
		}),
	).toThrow();
	expect(() =>
		validateHlsInventory({ ...input, tracks: Array(33).fill(input.tracks[0]) }),
	).toThrow();
	expect(() =>
		validateHlsInventory({
			...input,
			entries: input.entries.map((item) =>
				item.role === "master"
					? { ...item, uri: "https://origin.example" }
					: item,
			),
		}),
	).toThrow();
});
it("does not mutate caller inputs during validation or canonicalization", () => {
	const input = fixture();
	const original = structuredClone(input);
	validateHlsManifest(sealHlsInventory(input));
	canonicalHlsInventory(input);
	expect(input).toEqual(original);
});

it("rejects inherited array iterators without executing their getters", () => {
	const input = fixture();
	let invoked = false;
	const prototype = Object.create(Array.prototype);
	Object.defineProperty(prototype, Symbol.iterator, {
		get() {
			invoked = true;
			return Array.prototype[Symbol.iterator];
		},
	});
	Object.setPrototypeOf(input.entries, prototype);
	expect(() => validateHlsInventory(input)).toThrow();
	expect(invoked).toBe(false);
});

it("rejects custom prototypes on nested reference arrays", () => {
	const input = fixture();
	const master = input.entries[0];
	if (master?.role !== "master") throw new Error("fixture");
	Object.setPrototypeOf(master.variantIds, Object.create(Array.prototype));
	expect(() => validateHlsInventory(input)).toThrow();
});

it("rejects oversized property names before serializing them", () => {
	const name = "x".repeat(HLS_CONTRACT_LIMITS.bytes + 1);
	const stringify = vi.spyOn(JSON, "stringify");
	try {
		expect(() => validateHlsInventory({ [name]: 0 })).toThrow();
		expect(stringify.mock.calls.some(([value]) => value === name)).toBe(false);
	} finally {
		stringify.mockRestore();
	}
});
