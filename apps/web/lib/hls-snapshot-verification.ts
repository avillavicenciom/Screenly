import { createHash } from "node:crypto";
import {
	type HlsEntry,
	type HlsManifest,
	type HlsObjectIdentity,
	validateHlsManifest,
} from "@/lib/hls-publication-contract";

type StoredEntry = Extract<HlsEntry, { role: "init" | "segment" }>;
export type HlsVerificationScope = {
	ownerId: string;
	videoId: string;
	attemptId: string;
	generationId: string;
	storageProvider: "s3" | "drive";
	storageBindingId: string;
};
export type HlsObjectObservation = {
	key: string;
	size: number;
	identity: HlsObjectIdentity;
};
export type HlsPinnedRead = {
	key: string;
	identity: HlsObjectIdentity;
	signal: AbortSignal;
};
export type HlsVerificationStorage = {
	scope: HlsVerificationScope;
	head: (request: HlsPinnedRead) => Promise<HlsObjectObservation>;
	open: (request: HlsPinnedRead) => Promise<{
		observation: HlsObjectObservation;
		body: ReadableStream<Uint8Array>;
	}>;
};
export const HLS_VERIFICATION_LIMITS = {
	objectBytes: 256 * 1024 * 1024,
	totalBytes: 2 * 1024 * 1024 * 1024,
	objects: 1000,
	timeoutMs: 30_000,
} as const;
export type HlsVerificationOptions = {
	signal?: AbortSignal;
	maxObjectBytes?: number;
	maxTotalBytes?: number;
	maxObjects?: number;
	timeoutMs?: number;
};
type VerificationCode =
	| "invalid-contract"
	| "scope-mismatch"
	| "storage-unavailable"
	| "object-changed"
	| "content-mismatch"
	| "limit-exceeded"
	| "aborted";
export class HlsSnapshotVerificationError extends Error {
	constructor(readonly code: VerificationCode) {
		super(`HLS snapshot verification failed: ${code}`);
		this.name = "HlsSnapshotVerificationError";
	}
}
function check(condition: unknown, code: VerificationCode): asserts condition {
	if (!condition) throw new HlsSnapshotVerificationError(code);
}
function sameIdentity(a: HlsObjectIdentity, b: HlsObjectIdentity) {
	if (!a || a.provider !== b.provider || a.sha256 !== b.sha256) return false;
	return a.provider === "s3" && b.provider === "s3"
		? a.versionId === b.versionId && a.etag === b.etag
		: a.provider === "drive" &&
				b.provider === "drive" &&
				a.fileId === b.fileId &&
				a.revisionId === b.revisionId;
}
function observed(value: HlsObjectObservation, entry: StoredEntry) {
	check(
		value &&
			value.key === entry.key &&
			value.size === entry.size &&
			sameIdentity(value.identity, entry.identity),
		"object-changed",
	);
}
function scoped(a: HlsVerificationScope, b: HlsVerificationScope) {
	return [
		"ownerId",
		"videoId",
		"attemptId",
		"generationId",
		"storageProvider",
		"storageBindingId",
	].every(
		(key) =>
			a[key as keyof HlsVerificationScope] ===
			b[key as keyof HlsVerificationScope],
	);
}
function boundedOption(value: number | undefined, ceiling: number) {
	const result = value ?? ceiling;
	check(
		Number.isSafeInteger(result) && result > 0 && result <= ceiling,
		"limit-exceeded",
	);
	return result;
}
function awaitAbortable<T>(
	operation: Promise<T>,
	signal: AbortSignal,
	abandoned?: (value: T) => Promise<void>,
) {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new HlsSnapshotVerificationError("aborted"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				if (signal.aborted) {
					void abandoned?.(value).catch(() => {});
					reject(new HlsSnapshotVerificationError("aborted"));
				} else resolve(value);
			},
			() => {
				signal.removeEventListener("abort", abort);
				reject(
					new HlsSnapshotVerificationError(
						signal.aborted ? "aborted" : "storage-unavailable",
					),
				);
			},
		);
	});
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
export async function prepareVerifiedHlsSnapshot(
	input: unknown,
	expectedScope: HlsVerificationScope,
	storage: HlsVerificationStorage,
	options: HlsVerificationOptions = {},
) {
	let manifest: HlsManifest;
	try {
		manifest = validateHlsManifest(input);
	} catch {
		throw new HlsSnapshotVerificationError("invalid-contract");
	}
	const scope = { ...expectedScope };
	check(
		typeof scope.storageBindingId === "string" &&
			/^[A-Za-z0-9_-]{1,128}$/.test(scope.storageBindingId),
		"scope-mismatch",
	);
	check(scoped(scope, storage.scope), "scope-mismatch");
	for (const key of [
		"ownerId",
		"videoId",
		"attemptId",
		"generationId",
		"storageProvider",
	] as const)
		check(manifest.inventory[key] === scope[key], "scope-mismatch");
	const objectLimit = boundedOption(
		options.maxObjectBytes,
		HLS_VERIFICATION_LIMITS.objectBytes,
	);
	const totalLimit = boundedOption(
		options.maxTotalBytes,
		HLS_VERIFICATION_LIMITS.totalBytes,
	);
	const countLimit = boundedOption(
		options.maxObjects,
		HLS_VERIFICATION_LIMITS.objects,
	);
	const timeout = boundedOption(
		options.timeoutMs,
		HLS_VERIFICATION_LIMITS.timeoutMs,
	);
	const entries = manifest.inventory.entries.filter(
		(entry): entry is StoredEntry =>
			entry.role === "init" || entry.role === "segment",
	);
	check(entries.length <= countLimit, "limit-exceeded");
	let expectedBytes = 0;
	for (const entry of entries) {
		expectedBytes += entry.size;
		check(
			entry.size <= objectLimit && expectedBytes <= totalLimit,
			"limit-exceeded",
		);
	}
	freeze(manifest);
	const controller = new AbortController();
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	const timer = setTimeout(abort, timeout);
	const signal = controller.signal;
	const deadline = performance.now() + timeout;
	const checkActive = () => {
		if (performance.now() >= deadline) controller.abort();
		check(!signal.aborted, "aborted");
	};
	const receipts: {
		entryId: string;
		key: string;
		bytes: number;
		sha256: string;
		identity: HlsObjectIdentity;
	}[] = [];
	let total = 0;
	try {
		for (const entry of entries) {
			checkActive();
			check(scoped(scope, storage.scope), "scope-mismatch");
			const request = Object.freeze({
				key: entry.key,
				identity: entry.identity,
				signal,
			});
			observed(await awaitAbortable(storage.head(request), signal), entry);
			checkActive();
			check(scoped(scope, storage.scope), "scope-mismatch");
			const opened = await awaitAbortable(
				storage.open(request),
				signal,
				async (value) => {
					await value.body?.cancel();
				},
			);
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			let complete = false;
			try {
				check(scoped(scope, storage.scope), "scope-mismatch");
				observed(opened.observation, entry);
				reader = opened.body.getReader();
				let bytes = 0;
				const hash = createHash("sha256");
				for (;;) {
					checkActive();
					const part = await awaitAbortable(reader.read(), signal);
					if (part.done) break;
					check(
						part.value instanceof Uint8Array && part.value.byteLength > 0,
						"content-mismatch",
					);
					bytes += part.value.byteLength;
					total += part.value.byteLength;
					check(
						bytes <= entry.size && bytes <= objectLimit && total <= totalLimit,
						"content-mismatch",
					);
					hash.update(part.value);
				}
				const sha256 = hash.digest("hex");
				check(
					bytes === entry.size && sha256 === entry.identity.sha256,
					"content-mismatch",
				);
				complete = true;
				checkActive();
				check(scoped(scope, storage.scope), "scope-mismatch");
				observed(await awaitAbortable(storage.head(request), signal), entry);
				check(scoped(scope, storage.scope), "scope-mismatch");
				receipts.push({
					entryId: entry.id,
					key: entry.key,
					bytes,
					sha256,
					identity: entry.identity,
				});
			} finally {
				if (!complete) {
					if (reader) {
						void reader.cancel().catch(() => {});
						reader.releaseLock();
					} else void opened.body?.cancel().catch(() => {});
				} else reader?.releaseLock();
			}
		}
		checkActive();
		return freeze({
			version: 1 as const,
			kind: "verified-hls-snapshot" as const,
			storageBindingId: scope.storageBindingId,
			manifest,
			objects: receipts,
			totalBytes: total,
		});
	} catch (error) {
		controller.abort();
		if (error instanceof HlsSnapshotVerificationError) throw error;
		throw new HlsSnapshotVerificationError("storage-unavailable");
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}
