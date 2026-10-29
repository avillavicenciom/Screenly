import { Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Effect, Exit } from "effect";
import type { NextRequest } from "next/server";
import {
	authorizeViewerVideo,
	isVideoObjectKey,
	streamViewerObject,
	validViewerId,
	viewerMediaApi,
} from "@/lib/viewer-media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function getResponse(request: NextRequest) {
	return Effect.gen(function* () {
		const id = request.nextUrl.searchParams.get("videoId");
		if (!validViewerId(id) || request.nextUrl.searchParams.has("key"))
			return new Response(null, { status: 400 });
		const video = yield* authorizeViewerVideo(id);
		if (video instanceof Response) return video;
		const source = Video.Video.getSource(video);
		if (!(source instanceof Video.Mp4Source))
			return new Response(null, { status: 404 });
		if (
			(video.source.type === "desktopMP4" || video.source.type === "webMP4") &&
			video.source.outputKey &&
			(!isVideoObjectKey(video, video.source.outputKey) ||
				!video.source.outputKey.endsWith(".mp4"))
		)
			return new Response(null, { status: 404 });
		const key = source.getFileKey();
		if (!isVideoObjectKey(video, key) || !key.endsWith(".mp4"))
			return new Response(null, { status: 404 });
		if (request.signal.aborted) return new Response(null, { status: 408 });
		const result = yield* Effect.exit(
			Effect.gen(function* () {
				const [storage] = yield* Storage.getAccessForVideo(video);
				return yield* streamViewerObject(request, storage, key, "video/mp4");
			}),
		);
		return Exit.isSuccess(result)
			? result.value
			: new Response(null, { status: 502 });
	});
}
const handler = viewerMediaApi("/api/playback/mp4", getResponse);
export const GET = (request: Request) => handler(request);
export const HEAD = (request: Request) => handler(request);
