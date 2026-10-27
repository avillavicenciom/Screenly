import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const HLS_CONTRACT_LIMITS = {
	bytes: 4 * 1024 * 1024,
	depth: 12,
	nodes: 250_000,
	entries: 10_000,
	tracks: 32,
	propertyName: 128,
} as const;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = integer.positive();
const identity = z.discriminatedUnion("provider", [
	z
		.object({
			provider: z.literal("s3"),
			versionId: z
				.string()
				.regex(/^[A-Za-z0-9_+/=.:-]{1,1024}$/)
				.refine((value) => value !== "null" && !value.includes("://")),
			etag: z.string().regex(/^"[A-Za-z0-9-]{1,128}"$/),
			sha256: hash,
		})
		.strict(),
	z
		.object({
			provider: z.literal("drive"),
			fileId: id,
			revisionId: id,
			sha256: hash,
		})
		.strict(),
]);
const codec = z.enum(["h264", "hevc", "av1", "aac", "opus"]);
const stored = {
	id,
	trackId: id,
	codec,
	key: z.string().max(1024),
	size: positive,
	identity,
};
const entry = z.discriminatedUnion("role", [
	z.object({ ...stored, role: z.literal("init") }).strict(),
	z
		.object({
			...stored,
			role: z.literal("segment"),
			sequence: positive,
			duration: z.number().finite().positive().max(3600),
		})
		.strict(),
	z
		.object({
			role: z.literal("variant"),
			id,
			trackId: id,
			initId: id,
			segmentIds: z.array(id).min(1).max(HLS_CONTRACT_LIMITS.entries),
		})
		.strict(),
	z
		.object({
			role: z.literal("master"),
			id,
			variantIds: z.array(id).min(1).max(HLS_CONTRACT_LIMITS.tracks),
		})
		.strict(),
]);
const inventorySchema = z
	.object({
		version: z.literal(1),
		storageProvider: z.enum(["s3", "drive"]),
		videoId: id,
		ownerId: id,
		attemptId: uuid,
		generationId: uuid,
		revision: positive,
		previousDigest: hash.nullable(),
		mode: z.enum(["EVENT", "VOD"]),
		audioIntent: z.enum(["none", "optional", "required"]),
		tracks: z
			.array(
				z
					.object({
						id,
						kind: z.enum(["video", "audio"]),
						codec,
						variantId: id,
					})
					.strict(),
			)
			.min(1)
			.max(HLS_CONTRACT_LIMITS.tracks),
		masterId: id,
		entries: z.array(entry).min(3).max(HLS_CONTRACT_LIMITS.entries),
	})
	.strict();
export type HlsInventory = z.infer<typeof inventorySchema>;
export type HlsEntry = HlsInventory["entries"][number];
export type HlsObjectIdentity = z.infer<typeof identity>;
const manifestSchema = z
	.object({ inventory: inventorySchema, digest: hash })
	.strict();
export type HlsManifest = z.infer<typeof manifestSchema>;

export class HlsContractError extends Error {
	constructor() {
		super("Invalid HLS publication contract");
		this.name = "HlsContractError";
	}
}
function requireContract(condition: unknown): asserts condition {
	if (!condition) throw new HlsContractError();
}
function bounded(input: unknown, reserve = 0) {
	let nodes = 0;
	let bytes = 0;
	const active = new Set<object>();
	const walk = (value: unknown, depth: number): void => {
		requireContract(
			++nodes <= HLS_CONTRACT_LIMITS.nodes &&
				depth <= HLS_CONTRACT_LIMITS.depth,
		);
		if (typeof value === "string") {
			requireContract(value.length <= HLS_CONTRACT_LIMITS.bytes);
			bytes += Buffer.byteLength(JSON.stringify(value));
		} else if (typeof value === "number") {
			requireContract(Number.isFinite(value));
			bytes += 24;
		} else if (value === null || typeof value === "boolean") {
			bytes += 5;
		} else {
			requireContract(
				typeof value === "object" && value !== null && !active.has(value),
			);
			requireContract(
				Array.isArray(value)
					? Object.getPrototypeOf(value) === Array.prototype
					: Object.getPrototypeOf(value) === Object.prototype ||
							Object.getPrototypeOf(value) === null,
			);
			if (Array.isArray(value))
				requireContract(
					value.length <= HLS_CONTRACT_LIMITS.entries &&
						Object.keys(value).length === value.length,
				);
			active.add(value);
			requireContract(Object.keys(value).length <= HLS_CONTRACT_LIMITS.nodes);
			requireContract(
				Reflect.ownKeys(value).every(
					(key) =>
						typeof key === "string" &&
						key.length <= HLS_CONTRACT_LIMITS.propertyName,
				),
			);
			const descriptors = Object.getOwnPropertyDescriptors(value);
			for (const [key, descriptor] of Object.entries(descriptors)) {
				if (Array.isArray(value) && key === "length") continue;
				requireContract("value" in descriptor && descriptor.enumerable);
				bytes += Buffer.byteLength(JSON.stringify(key)) + 3;
				requireContract(bytes <= HLS_CONTRACT_LIMITS.bytes - reserve);
				walk(descriptor.value, depth + 1);
			}
			active.delete(value);
		}
		requireContract(bytes <= HLS_CONTRACT_LIMITS.bytes - reserve);
	};
	walk(input, 0);
}
function unique(values: readonly string[]) {
	return new Set(values).size === values.length;
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function validateHlsInventory(input: unknown): HlsInventory {
	bounded(input, 1024);
	const result = inventorySchema.safeParse(input);
	requireContract(result.success);
	const inventory = result.data;
	const { entries, tracks } = inventory;
	requireContract(
		unique(entries.map((item) => item.id)) &&
			unique(tracks.map((track) => track.id)),
	);
	requireContract(tracks.some((track) => track.kind === "video"));
	const audio = tracks.filter((track) => track.kind === "audio");
	requireContract(inventory.audioIntent !== "none" || audio.length === 0);
	requireContract(inventory.audioIntent !== "required" || audio.length > 0);
	requireContract(
		inventory.revision !== 1 || inventory.previousDigest === null,
	);
	requireContract(
		inventory.revision === 1 || inventory.previousDigest !== null,
	);
	const byId = new Map(entries.map((item) => [item.id, item]));
	const master = byId.get(inventory.masterId);
	requireContract(master?.role === "master" && unique(master.variantIds));
	requireContract(
		entries.filter((item) => item.role === "master").length === 1,
	);
	requireContract(unique(tracks.map((track) => track.variantId)));
	requireContract(
		master.variantIds.length === tracks.length &&
			tracks.every((track) => master.variantIds.includes(track.variantId)),
	);
	const reached = new Set([master.id]);
	const keys = new Set<string>();
	const identities = new Set<string>();
	const prefix = `${inventory.ownerId}/${inventory.videoId}/.recording/hls/${inventory.attemptId}/${inventory.generationId}/`;
	for (const track of tracks) {
		requireContract(
			track.kind === "video"
				? ["h264", "hevc", "av1"].includes(track.codec)
				: ["aac", "opus"].includes(track.codec),
		);
		const variant = byId.get(track.variantId);
		requireContract(
			variant?.role === "variant" &&
				variant.trackId === track.id &&
				unique(variant.segmentIds),
		);
		const init = byId.get(variant.initId);
		requireContract(
			init?.role === "init" &&
				init.trackId === track.id &&
				init.codec === track.codec,
		);
		reached.add(variant.id);
		reached.add(init.id);
		let duration = 0;
		variant.segmentIds.forEach((segmentId, index) => {
			const segment = byId.get(segmentId);
			requireContract(
				segment?.role === "segment" &&
					segment.sequence === index + 1 &&
					segment.trackId === track.id &&
					segment.codec === track.codec,
			);
			duration += segment.duration;
			requireContract(duration <= 86400);
			reached.add(segment.id);
		});
	}
	for (const item of entries) {
		requireContract(reached.has(item.id));
		if (item.role !== "init" && item.role !== "segment") continue;
		requireContract(
			item.key.startsWith(prefix) && /^[A-Za-z0-9_./-]+$/.test(item.key),
		);
		const parts = item.key.split("/");
		requireContract(
			parts.every((part) => part !== "" && part !== "." && part !== ".."),
		);
		requireContract(item.key.endsWith(item.role === "init" ? ".mp4" : ".m4s"));
		requireContract(item.identity.provider === inventory.storageProvider);
		requireContract(!keys.has(item.key));
		keys.add(item.key);
		const objectId =
			item.identity.provider === "drive"
				? `drive:${item.identity.fileId}`
				: `s3:${item.key}:${item.identity.versionId}`;
		requireContract(!identities.has(objectId));
		identities.add(objectId);
	}
	requireContract(
		Buffer.byteLength(canonical(inventory)) <= HLS_CONTRACT_LIMITS.bytes - 1024,
	);
	return inventory;
}
export function canonicalHlsInventory(input: unknown): string {
	const inventory = validateHlsInventory(input);
	return canonical({
		...inventory,
		tracks: [...inventory.tracks].sort((a, b) => (a.id < b.id ? -1 : 1)),
		entries: [...inventory.entries].sort((a, b) => (a.id < b.id ? -1 : 1)),
	});
}
export function digestHlsInventory(input: unknown): string {
	return createHash("sha256")
		.update(canonicalHlsInventory(input))
		.digest("hex");
}
export function sealHlsInventory(input: unknown): HlsManifest {
	const inventory = validateHlsInventory(input);
	return { inventory, digest: digestHlsInventory(inventory) };
}
export function validateHlsManifest(input: unknown): HlsManifest {
	bounded(input);
	const result = manifestSchema.safeParse(input);
	requireContract(result.success);
	const inventory = validateHlsInventory(result.data.inventory);
	requireContract(
		timingSafeEqual(
			Buffer.from(result.data.digest, "hex"),
			Buffer.from(digestHlsInventory(inventory), "hex"),
		),
	);
	return { inventory, digest: result.data.digest };
}
export function validateHlsProgression(
	previous: unknown,
	next: unknown,
): HlsManifest {
	const before = validateHlsManifest(previous);
	const after = validateHlsManifest(next);
	const a = before.inventory;
	const b = after.inventory;
	requireContract(
		a.mode === "EVENT" &&
			b.revision === a.revision + 1 &&
			b.previousDigest === before.digest,
	);
	for (const field of [
		"videoId",
		"ownerId",
		"attemptId",
		"generationId",
		"audioIntent",
		"masterId",
		"storageProvider",
	] as const)
		requireContract(a[field] === b[field]);
	requireContract(
		canonical([...a.tracks].sort((x, y) => (x.id < y.id ? -1 : 1))) ===
			canonical([...b.tracks].sort((x, y) => (x.id < y.id ? -1 : 1))),
	);
	const entries = new Map(b.entries.map((item) => [item.id, item]));
	for (const item of a.entries) {
		const later = entries.get(item.id);
		requireContract(later);
		if (item.role === "variant") {
			requireContract(
				later.role === "variant" &&
					later.trackId === item.trackId &&
					later.initId === item.initId,
			);
			requireContract(
				item.segmentIds.every((id, index) => later.segmentIds[index] === id),
			);
		} else requireContract(canonical(item) === canonical(later));
	}
	return after;
}
