import { db } from "@cap/database";
import { comments } from "@cap/database/schema";
import { findScreenshotObjectKey, Storage } from "@cap/web-backend";
import {
	getPublishedRecordingThumbnailKey,
	resolveRecordingObjectKey,
} from "@cap/web-backend/src/Storage/recording-output";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";
import type { NextRequest } from "next/server";
import { baseContentType, commentMediaKeys } from "@/lib/comment-media";
import { ensureLoomPreviewGif } from "@/lib/loom-preview-gif";
import {
	authorizeViewerVideo,
	isVideoObjectKey,
	streamViewerObject,
	type ViewerStorage,
	validViewerId,
} from "@/lib/viewer-media";

export const derivativeUrl = (videoId: string, resource: string) =>
	`/api/playback/resource?videoId=${encodeURIComponent(videoId)}&resource=${encodeURIComponent(resource)}`;

export function isMissingObject(cause: unknown, depth = 0): boolean {
	if (depth > 8 || typeof cause !== "object" || cause === null) return false;
	if (
		("status" in cause && cause.status === 404) ||
		("_tag" in cause && cause._tag === "NotFound")
	)
		return true;
	if (
		"name" in cause &&
		["NotFound", "NoSuchKey", "NoSuchFile"].includes(String(cause.name))
	)
		return true;
	if (
		"$metadata" in cause &&
		typeof cause.$metadata === "object" &&
		cause.$metadata !== null &&
		"httpStatusCode" in cause.$metadata &&
		cause.$metadata.httpStatusCode === 404
	)
		return true;
	return "cause" in cause && cause.cause !== cause
		? isMissingObject(cause.cause, depth + 1)
		: false;
}

function resolveComment(
	video: Video.Video,
	request: NextRequest,
	thumbnail: boolean,
) {
	return Effect.gen(function* () {
		const id = request.nextUrl.searchParams.get("commentId");
		if (!validViewerId(id)) return null;
		const [comment] = yield* Effect.tryPromise(() =>
			db()
				.select()
				.from(comments)
				.where(
					and(
						eq(comments.id, id as typeof comments.$inferSelect.id),
						eq(comments.videoId, video.id),
					),
				)
				.limit(1),
		);
		if (
			!comment ||
			comment.id !== id ||
			comment.videoId !== video.id ||
			(comment.type !== "video" && comment.type !== "audio") ||
			!comment.mediaMeta
		)
			return null;
		const mime = baseContentType(comment.mediaMeta.mime);
		const expected = commentMediaKeys({
			ownerId: video.ownerId,
			videoId: video.id,
			commentId: comment.id,
			kind: comment.type,
			contentType: mime,
			withThumbnail: !!comment.mediaMeta.thumbnailKey,
		});
		if (!expected || expected.key !== comment.mediaKey) return null;
		if (thumbnail) {
			if (
				!expected.thumbnailKey ||
				comment.mediaMeta.thumbnailKey !== expected.thumbnailKey
			)
				return null;
			return { key: expected.thumbnailKey, mime: "image/jpeg" };
		}
		return { key: expected.key, mime };
	});
}

function resolveThumbnail(video: Video.Video, storage: ViewerStorage) {
	return Effect.gen(function* () {
		const published = getPublishedRecordingThumbnailKey(video);
		const key =
			published ??
			findScreenshotObjectKey(
				(yield* storage.listObjects({
					prefix: `${video.ownerId}/${video.id}/`,
				})).Contents ?? [],
			);
		if (!key || !isVideoObjectKey(video, key) || !/\.(png|jpe?g)$/.test(key))
			return null;
		return { key, mime: key.endsWith(".png") ? "image/png" : "image/jpeg" };
	});
}

export function derivativeResponse(
	request: NextRequest,
	fixedResource?: "thumbnail-json" | "preview",
) {
	return Effect.gen(function* () {
		const params = request.nextUrl.searchParams;
		const id = params.get("videoId");
		const resource = fixedResource ?? params.get("resource");
		if (
			!validViewerId(id) ||
			params.has("key") ||
			![
				"thumbnail-json",
				"thumbnail",
				"preview",
				"vtt",
				"enhanced-audio",
				"comment-media",
				"comment-thumbnail",
			].includes(resource ?? "")
		)
			return new Response(null, { status: 400 });
		const video = yield* authorizeViewerVideo(id);
		if (video instanceof Response) return video;
		const prefix = `${video.ownerId}/${video.id}/`;
		let spec: { key: string; mime: string } | null = null;
		if (resource === "comment-media" || resource === "comment-thumbnail") {
			const comment = yield* Effect.exit(
				resolveComment(video, request, resource === "comment-thumbnail"),
			);
			if (Exit.isFailure(comment)) return new Response(null, { status: 503 });
			spec = comment.value;
			if (!spec) return new Response(null, { status: 404 });
		}
		const publishedThumbnail =
			video.source.type === "desktopMP4" || video.source.type === "webMP4"
				? video.source.thumbnailKey
				: undefined;
		if (
			(resource === "thumbnail" || resource === "thumbnail-json") &&
			publishedThumbnail &&
			(!isVideoObjectKey(video, publishedThumbnail) ||
				!/\.(png|jpe?g)$/.test(publishedThumbnail))
		)
			return new Response(null, { status: 404 });
		const publishedPreview =
			video.source.type === "desktopMP4" || video.source.type === "webMP4"
				? video.source.previewKey
				: undefined;
		if (
			resource === "preview" &&
			publishedPreview &&
			(!isVideoObjectKey(video, publishedPreview) ||
				!publishedPreview.endsWith(".gif"))
		)
			return new Response(null, { status: 404 });
		if (resource === "preview")
			spec = {
				key: resolveRecordingObjectKey(
					video,
					`${prefix}preview/animated-preview.gif`,
				),
				mime: "image/gif",
			};
		if (resource === "vtt")
			spec = {
				key: `${prefix}transcription.vtt`,
				mime: "text/vtt; charset=utf-8",
			};
		if (resource === "enhanced-audio")
			spec = { key: `${prefix}enhanced-audio.mp3`, mime: "audio/mpeg" };
		if (
			spec &&
			(!isVideoObjectKey(video, spec.key) ||
				(resource === "preview" && !spec.key.endsWith(".gif")))
		)
			return new Response(null, { status: 404 });
		if (request.signal.aborted) return new Response(null, { status: 408 });
		const result = yield* Effect.exit(
			Effect.gen(function* () {
				const [storage] = yield* Storage.getAccessForVideo(video);
				if (resource === "thumbnail" || resource === "thumbnail-json")
					spec = yield* resolveThumbnail(video, storage);
				if (!spec) return new Response(null, { status: 404 });
				if (resource === "preview") {
					const head = yield* Effect.exit(storage.headObject(spec.key));
					if (Exit.isFailure(head)) {
						const failure = Option.getOrUndefined(
							Cause.failureOption(head.cause),
						);
						if (!isMissingObject(failure))
							return new Response(null, { status: 502 });
						const generated =
							request.method !== "HEAD" &&
							params.get("fallback") !== "og" &&
							(yield* ensureLoomPreviewGif(
								video,
								storage,
								`${prefix}preview/animated-preview.gif`,
							));
						if (!generated) {
							if (params.get("fallback") === "og")
								return new Response(null, {
									status: 302,
									headers: {
										Location: `/api/video/og?videoId=${encodeURIComponent(video.id)}`,
									},
								});
							return new Response(null, { status: 404 });
						}
					}
				}
				if (resource === "thumbnail-json") {
					yield* storage.headObject(spec.key);
					return Response.json({
						screen: derivativeUrl(video.id, "thumbnail"),
					});
				}
				return yield* streamViewerObject(request, storage, spec.key, spec.mime);
			}),
		);
		if (Exit.isSuccess(result)) return result.value;
		const failure = Option.getOrUndefined(Cause.failureOption(result.cause));
		return new Response(null, { status: isMissingObject(failure) ? 404 : 502 });
	});
}
