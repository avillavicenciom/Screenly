import {
	GetObjectCommand,
	type GetObjectCommandOutput,
	HeadObjectCommand,
	type HeadObjectCommandOutput,
	type S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import {
	type HlsObjectObservation,
	type HlsPinnedRead,
	HlsSnapshotVerificationError,
	type HlsVerificationScope,
	type HlsVerificationStorage,
} from "@/lib/hls-snapshot-verification";

function check(condition: unknown): asserts condition {
	if (!condition) throw new HlsSnapshotVerificationError("object-changed");
}
function available(signal: AbortSignal) {
	if (signal.aborted) throw new HlsSnapshotVerificationError("aborted");
}
function scopedRequest(scope: HlsVerificationScope, request: HlsPinnedRead) {
	if (!(request?.signal instanceof AbortSignal))
		throw new HlsSnapshotVerificationError("scope-mismatch");
	available(request.signal);
	const prefix = `${scope.ownerId}/${scope.videoId}/.recording/hls/${scope.attemptId}/${scope.generationId}/`;
	if (
		typeof request.key !== "string" ||
		request.key.length > 1024 ||
		!request.key.startsWith(prefix) ||
		!/^[A-Za-z0-9_./-]+$/.test(request.key) ||
		!request.key
			.split("/")
			.every((part) => part !== "" && part !== "." && part !== "..") ||
		!/\.(mp4|m4s)$/.test(request.key) ||
		request.identity?.provider !== "s3" ||
		typeof request.identity.versionId !== "string" ||
		typeof request.identity.etag !== "string" ||
		typeof request.identity.sha256 !== "string" ||
		!/^[A-Za-z0-9_+/=.:-]{1,1024}$/.test(request.identity.versionId) ||
		request.identity.versionId === "null" ||
		request.identity.versionId.includes("://") ||
		!/^"[A-Za-z0-9-]{1,128}"$/.test(request.identity.etag) ||
		!/^[a-f0-9]{64}$/.test(request.identity.sha256)
	)
		throw new HlsSnapshotVerificationError("scope-mismatch");
	return {
		key: request.key,
		identity: { ...request.identity },
		signal: request.signal,
	};
}
function observation(
	key: string,
	result: HeadObjectCommandOutput | GetObjectCommandOutput,
	expected: Extract<HlsPinnedRead["identity"], { provider: "s3" }>,
): HlsObjectObservation {
	check(
		result.$metadata.httpStatusCode === 200 && result.DeleteMarker !== true,
	);
	check(!result.ContentRange);
	check(
		Number.isSafeInteger(result.ContentLength) &&
			(result.ContentLength ?? 0) > 0,
	);
	check(result.ChecksumType === "FULL_OBJECT");
	const checksum = result.ChecksumSHA256;
	check(typeof checksum === "string" && /^[A-Za-z0-9+/]{43}=$/.test(checksum));
	const bytes = Buffer.from(checksum, "base64");
	check(bytes.length === 32 && bytes.toString("base64") === checksum);
	const sha256 = bytes.toString("hex");
	check(
		result.VersionId === expected.versionId &&
			result.ETag === expected.etag &&
			sha256 === expected.sha256,
	);
	return {
		key,
		size: result.ContentLength as number,
		identity: {
			provider: "s3",
			versionId: result.VersionId,
			etag: result.ETag,
			sha256,
		},
	};
}
function discard(body: GetObjectCommandOutput["Body"]) {
	if (!body) return;
	try {
		if ("destroy" in body && typeof body.destroy === "function") body.destroy();
		else
			void body
				.transformToWebStream()
				.cancel()
				.catch(() => {});
	} catch {}
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
export function createHlsS3VerificationStorage({
	client,
	bucket,
	scope: inputScope,
}: {
	client: Pick<S3Client, "send">;
	bucket: string;
	scope: HlsVerificationScope;
}): HlsVerificationStorage {
	const scope = Object.freeze({ ...inputScope });
	const validId = (value: unknown) =>
		typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
	const validUuid = (value: string) =>
		z.string().uuid().safeParse(value).success;
	if (
		scope.storageProvider !== "s3" ||
		!validId(scope.ownerId) ||
		!validId(scope.videoId) ||
		!validId(scope.storageBindingId) ||
		!validUuid(scope.attemptId) ||
		!validUuid(scope.generationId) ||
		!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
		bucket.includes("..")
	)
		throw new HlsSnapshotVerificationError("scope-mismatch");
	return Object.freeze({
		scope,
		async head(input: HlsPinnedRead) {
			const request = scopedRequest(scope, input);
			try {
				const result = await client.send(
					new HeadObjectCommand({
						Bucket: bucket,
						Key: request.key,
						VersionId: request.identity.versionId,
						IfMatch: request.identity.etag,
						ChecksumMode: "ENABLED",
					}),
					{ abortSignal: request.signal },
				);
				available(request.signal);
				return observation(request.key, result, request.identity);
			} catch (error) {
				if (error instanceof HlsSnapshotVerificationError) throw error;
				throw new HlsSnapshotVerificationError(
					request.signal.aborted ? "aborted" : "storage-unavailable",
				);
			}
		},
		async open(input: HlsPinnedRead) {
			const request = scopedRequest(scope, input);
			let result: GetObjectCommandOutput | undefined;
			try {
				result = await client.send(
					new GetObjectCommand({
						Bucket: bucket,
						Key: request.key,
						VersionId: request.identity.versionId,
						IfMatch: request.identity.etag,
						ChecksumMode: "ENABLED",
					}),
					{ abortSignal: request.signal },
				);
				available(request.signal);
				const observed = observation(request.key, result, request.identity);
				check(result.Body);
				return {
					observation: observed,
					body: streamBody(result.Body.transformToWebStream(), request.signal),
				};
			} catch (error) {
				discard(result?.Body);
				if (error instanceof HlsSnapshotVerificationError) throw error;
				throw new HlsSnapshotVerificationError(
					request.signal.aborted ? "aborted" : "storage-unavailable",
				);
			}
		},
	});
}
