import { z } from "zod";
import {
	type HlsObjectObservation,
	type HlsPinnedRead,
	HlsSnapshotVerificationError,
	type HlsVerificationScope,
	type HlsVerificationStorage,
} from "@/lib/hls-snapshot-verification";

const BASE = "https://www.googleapis.com/drive/v3";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const validId = (value: unknown): value is string =>
	typeof value === "string" && ID.test(value);
const HASH = /^[a-f0-9]{64}$/;
const MIME = new Set([
	"video/mp4",
	"audio/mp4",
	"video/iso.segment",
	"audio/iso.segment",
	"application/octet-stream",
]);
const METADATA_BYTES = 64 * 1024;
type DriveIdentity = Extract<HlsPinnedRead["identity"], { provider: "drive" }>;
type DriveRequest = {
	key: string;
	identity: DriveIdentity;
	signal: AbortSignal;
};
export type HlsDriveVerificationDependencies = {
	scope: HlsVerificationScope;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	getAccessToken: (signal: AbortSignal) => Promise<string>;
	resolveFileId: (key: string, signal: AbortSignal) => Promise<string | null>;
};
function check(
	condition: unknown,
	code: "scope-mismatch" | "object-changed" = "object-changed",
): asserts condition {
	if (!condition) throw new HlsSnapshotVerificationError(code);
}
function available(signal: AbortSignal) {
	if (signal.aborted) throw new HlsSnapshotVerificationError("aborted");
}
function discard(body: ReadableStream<Uint8Array> | null) {
	void body?.cancel().catch(() => {});
}
function abortable<T>(
	operation: Promise<T>,
	signal: AbortSignal,
	late?: (value: T) => void,
) {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new HlsSnapshotVerificationError("aborted"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				if (signal.aborted) {
					late?.(value);
					abort();
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
function scopedRequest(
	scope: HlsVerificationScope,
	input: HlsPinnedRead,
): DriveRequest {
	check(input?.signal instanceof AbortSignal, "scope-mismatch");
	available(input.signal);
	const prefix = `${scope.ownerId}/${scope.videoId}/.recording/hls/${scope.attemptId}/${scope.generationId}/`;
	check(
		typeof input.key === "string" &&
			input.key.length <= 1024 &&
			input.key.startsWith(prefix) &&
			/^[A-Za-z0-9_./-]+$/.test(input.key) &&
			input.key
				.split("/")
				.every((part) => part !== "" && part !== "." && part !== "..") &&
			/\.(mp4|m4s)$/.test(input.key),
		"scope-mismatch",
	);
	check(
		input.identity?.provider === "drive" &&
			validId(input.identity.fileId) &&
			validId(input.identity.revisionId) &&
			typeof input.identity.sha256 === "string" &&
			HASH.test(input.identity.sha256),
		"scope-mismatch",
	);
	return {
		key: input.key,
		identity: { ...input.identity },
		signal: input.signal,
	};
}
function streamBody(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
	const reader = body.getReader();
	let stopped = false;
	let abort = () => {};
	const clean = () => signal.removeEventListener("abort", abort);
	const cancel = () => {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	};
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				abort = () => {
					if (stopped) return;
					stopped = true;
					clean();
					cancel();
					controller.error(new HlsSnapshotVerificationError("aborted"));
				};
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
			},
			async pull(controller) {
				if (stopped) return;
				try {
					const part = await reader.read();
					if (stopped) return;
					if (part.done) {
						stopped = true;
						clean();
						reader.releaseLock();
						controller.close();
					} else controller.enqueue(part.value);
				} catch {
					if (stopped) return;
					stopped = true;
					clean();
					cancel();
					controller.error(
						new HlsSnapshotVerificationError("storage-unavailable"),
					);
				}
			},
			cancel() {
				if (stopped) return;
				stopped = true;
				clean();
				cancel();
			},
		},
		{ highWaterMark: 0 },
	);
}
async function readMetadata(response: Response, signal: AbortSignal) {
	check(response.body);
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let size = 0;
	let text = "";
	let complete = false;
	try {
		for (;;) {
			available(signal);
			const part = await abortable(reader.read(), signal);
			if (part.done) break;
			check(part.value instanceof Uint8Array && part.value.byteLength > 0);
			size += part.value.byteLength;
			check(size <= METADATA_BYTES);
			text += decoder.decode(part.value, { stream: true });
		}
		text += decoder.decode();
		complete = true;
		return JSON.parse(text) as unknown;
	} finally {
		if (!complete) void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
export function createHlsDriveVerificationStorage(
	dependencies: HlsDriveVerificationDependencies,
): HlsVerificationStorage {
	const { fetch: fetchClient, getAccessToken, resolveFileId } = dependencies;
	const scope = Object.freeze({ ...dependencies.scope });
	check(
		scope.storageProvider === "drive" &&
			validId(scope.ownerId) &&
			validId(scope.videoId) &&
			validId(scope.storageBindingId) &&
			z.string().uuid().safeParse(scope.attemptId).success &&
			z.string().uuid().safeParse(scope.generationId).success,
		"scope-mismatch",
	);
	const mapped = async (request: DriveRequest) => {
		available(request.signal);
		const fileId = await abortable(
			resolveFileId(request.key, request.signal),
			request.signal,
		);
		check(fileId === request.identity.fileId, "scope-mismatch");
		return fileId;
	};
	const fetchFixed = async (
		url: string,
		request: DriveRequest,
		accept: string,
	) => {
		available(request.signal);
		const token = await abortable(
			getAccessToken(request.signal),
			request.signal,
		);
		check(
			typeof token === "string" &&
				/^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/.test(token),
			"scope-mismatch",
		);
		available(request.signal);
		const response = await abortable(
			fetchClient(url, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: accept,
					"Accept-Encoding": "identity",
				},
				redirect: "manual",
				cache: "no-store",
				signal: request.signal,
			}),
			request.signal,
			(response) => discard(response.body),
		);
		try {
			available(request.signal);
			check(
				response.status === 200 &&
					!response.redirected &&
					(!response.url || response.url === url) &&
					!response.headers.has("content-range") &&
					!response.headers.has("location"),
			);
			return response;
		} catch (error) {
			discard(response.body);
			throw error;
		}
	};
	const metadata = async (
		request: DriveRequest,
	): Promise<HlsObjectObservation & { mime: string }> => {
		const fileId = await mapped(request);
		const params = new URLSearchParams({
			fields: "id,mimeType,size,sha256Checksum,headRevisionId,trashed",
			supportsAllDrives: "true",
		});
		const response = await fetchFixed(
			`${BASE}/files/${encodeURIComponent(fileId)}?${params}`,
			request,
			"application/json",
		);
		try {
			check(
				response.headers
					.get("content-type")
					?.split(";")[0]
					?.trim()
					.toLowerCase() === "application/json",
			);
			const json = await readMetadata(response, request.signal);
			const parsed = z
				.object({
					id: z.string(),
					mimeType: z.string(),
					size: z.string().regex(/^[1-9][0-9]*$/),
					sha256Checksum: z.string().regex(/^[a-fA-F0-9]{64}$/),
					headRevisionId: z.string(),
					trashed: z.literal(false),
				})
				.strict()
				.safeParse(json);
			check(parsed.success);
			const file = parsed.data;
			const size = Number(file.size);
			const sha256 = file.sha256Checksum.toLowerCase();
			check(
				file.id === fileId &&
					file.headRevisionId === request.identity.revisionId &&
					sha256 === request.identity.sha256 &&
					Number.isSafeInteger(size) &&
					size > 0 &&
					MIME.has(file.mimeType),
			);
			await mapped(request);
			return {
				key: request.key,
				size,
				mime: file.mimeType,
				identity: {
					provider: "drive",
					fileId: file.id,
					revisionId: file.headRevisionId,
					sha256,
				},
			};
		} catch (error) {
			if (!response.body?.locked) discard(response.body);
			throw error;
		}
	};
	const sanitize = (error: unknown, signal: AbortSignal): never => {
		if (error instanceof HlsSnapshotVerificationError) throw error;
		throw new HlsSnapshotVerificationError(
			signal.aborted ? "aborted" : "storage-unavailable",
		);
	};
	return Object.freeze({
		scope,
		async head(input: HlsPinnedRead) {
			const request = scopedRequest(scope, input);
			try {
				const observed = await metadata(request);
				const { mime: _, ...result } = observed;
				return result;
			} catch (error) {
				return sanitize(error, request.signal);
			}
		},
		async open(input: HlsPinnedRead) {
			const request = scopedRequest(scope, input);
			let response: Response | undefined;
			try {
				const before = await metadata(request);
				response = await fetchFixed(
					`${BASE}/files/${encodeURIComponent(request.identity.fileId)}/revisions/${encodeURIComponent(request.identity.revisionId)}?alt=media`,
					request,
					"application/octet-stream",
				);
				const length = response.headers.get("content-length");
				const mime = response.headers
					.get("content-type")
					?.split(";")[0]
					?.trim()
					.toLowerCase();
				check(
					response.body &&
						length !== null &&
						/^[1-9][0-9]*$/.test(length) &&
						Number(length) === before.size &&
						mime &&
						(mime === before.mime || mime === "application/octet-stream") &&
						(!response.headers.get("content-encoding") ||
							response.headers.get("content-encoding") === "identity"),
				);
				const after = await metadata(request);
				check(after.size === before.size && after.mime === before.mime);
				available(request.signal);
				const { mime: _, ...observation } = after;
				return { observation, body: streamBody(response.body, request.signal) };
			} catch (error) {
				if (response) discard(response.body);
				return sanitize(error, request.signal);
			}
		},
	});
}
