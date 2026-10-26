import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import { provideOptionalAuth, Storage, Videos } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { NextRequest } from "next/server";
import { playbackRange, playbackStream } from "@/lib/mp4-playback";
import { privateResourceResponse } from "@/lib/private-resource-response";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function getResponse(request: NextRequest) {
	return Effect.gen(function* () {
		const id = request.nextUrl.searchParams.get("videoId");
		if (
			!id ||
			!/^[A-Za-z0-9_-]{1,255}$/.test(id) ||
			request.nextUrl.searchParams.has("key")
		)
			return new Response(null, { status: 400 });
		const authorized = yield* Effect.exit(
			Effect.gen(function* () {
				const service = yield* Videos;
				const found = yield* service.getByIdForViewing(Video.VideoId.make(id));
				if (Option.isNone(found)) return null;
				const [video] = found.value;
				const [organization] = yield* Effect.tryPromise(() =>
					db()
						.select({ tombstoneAt: organizations.tombstoneAt })
						.from(organizations)
						.where(eq(organizations.id, video.orgId))
						.limit(1),
				);
				return organization && !organization.tombstoneAt ? video : null;
			}).pipe(provideOptionalAuth),
		);
		if (Exit.isFailure(authorized)) {
			const error = Option.getOrUndefined(
				Cause.failureOption(authorized.cause),
			);
			const tag =
				typeof error === "object" && error !== null && "_tag" in error
					? error._tag
					: null;
			return new Response(null, {
				status:
					tag === "PolicyDenied" || tag === "VerifyVideoPasswordError"
						? 404
						: 503,
			});
		}
		const video = authorized.value;
		if (!video) return new Response(null, { status: 404 });
		const source = Video.Video.getSource(video);
		if (!(source instanceof Video.Mp4Source))
			return new Response(null, { status: 404 });
		if (
			(video.source.type === "desktopMP4" || video.source.type === "webMP4") &&
			video.source.outputKey &&
			(!video.source.outputKey.startsWith(`${video.ownerId}/${video.id}/`) ||
				!video.source.outputKey.endsWith(".mp4") ||
				/[^A-Za-z0-9_./-]/.test(video.source.outputKey) ||
				video.source.outputKey
					.split("/")
					.some((part) => part === "." || part === ".."))
		)
			return new Response(null, { status: 404 });
		const key = source.getFileKey();
		if (
			!key.startsWith(`${video.ownerId}/${video.id}/`) ||
			!key.endsWith(".mp4") ||
			/[^A-Za-z0-9_./-]/.test(key) ||
			key.split("/").some((part) => part === "." || part === "..")
		)
			return new Response(null, { status: 404 });
		if (request.signal.aborted) return new Response(null, { status: 408 });
		const result = yield* Effect.exit(
			Effect.gen(function* () {
				const [storage] = yield* Storage.getAccessForVideo(video);
				const head = yield* storage.headObject(key);
				const size = head.ContentLength;
				if (size === undefined || !Number.isSafeInteger(size) || size < 0)
					return new Response(null, { status: 502 });
				const headers = new Headers({
					"Content-Type": "video/mp4",
					"Accept-Ranges": "bytes",
					"Content-Length": String(size),
					"X-Content-Type-Options": "nosniff",
				});
				if (head.ETag) headers.set("ETag", head.ETag);
				if (request.method === "HEAD") return new Response(null, { headers });
				const ifRange = request.headers.get("if-range");
				const range = playbackRange(
					ifRange && (ifRange.startsWith("W/") || ifRange !== head.ETag)
						? null
						: request.headers.get("range"),
					size,
				);
				if (range === false) {
					headers.set("Content-Range", `bytes */${size}`);
					headers.delete("Content-Length");
					return new Response(null, { status: 416, headers });
				}
				const upstream =
					"getPlaybackObjectResponse" in storage
						? yield* storage.getPlaybackObjectResponse(
								key,
								range?.header ?? null,
								{
									signal: request.signal,
									ifMatch: head.ETag,
								},
							)
						: yield* storage.getObjectResponse(key, range?.header ?? null, {
								signal: request.signal,
							});
				if (upstream.status === 416) {
					yield* Effect.promise(async () => {
						await upstream.body?.cancel();
					});
					headers.set("Content-Range", `bytes */${size}`);
					headers.delete("Content-Length");
					return new Response(null, { status: 416, headers });
				}
				const length = range ? range.length : size;
				if (length > 0 && !upstream.body)
					return new Response(null, { status: 502 });
				if (
					upstream.status !== (range ? 206 : 200) ||
					(upstream.headers.has("Content-Length") &&
						Number(upstream.headers.get("Content-Length")) !== length) ||
					(range &&
						upstream.headers.get("Content-Range") !==
							`bytes ${range.start}-${range.end}/${size}`)
				) {
					yield* Effect.promise(async () => {
						await upstream.body?.cancel();
					});
					return new Response(null, { status: 502 });
				}
				if (range)
					headers.set(
						"Content-Range",
						`bytes ${range.start}-${range.end}/${size}`,
					);
				headers.set("Content-Length", String(length));
				return new Response(
					upstream.body ? playbackStream(upstream.body, request.signal) : null,
					{ status: upstream.status, headers },
				);
			}),
		);
		return Exit.isSuccess(result)
			? result.value
			: new Response(null, { status: 502 });
	});
}

class Api extends HttpApi.make("Mp4PlaybackApi").add(
	HttpApiGroup.make("playback")
		.add(HttpApiEndpoint.get("getMp4")`/api/playback/mp4`)
		.add(HttpApiEndpoint.head("headMp4")`/api/playback/mp4`),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "playback", (handlers) => {
			const serve = ({
				request,
			}: {
				request: import("@effect/platform/HttpServerRequest").HttpServerRequest;
			}) => {
				if (!(request.source instanceof Request)) {
					const response = privateResourceResponse(
						new Response(null, { status: 503 }),
					);
					return Effect.succeed(
						HttpServerResponse.raw(null, {
							status: response.status,
							headers: response.headers,
						}),
					);
				}
				const native = new NextRequest(request.source);
				return getResponse(native).pipe(
					Effect.catchAllCause(() =>
						Effect.succeed(new Response(null, { status: 503 })),
					),
					Effect.map((value) => {
						const response = privateResourceResponse(
							value,
							native.method === "HEAD",
						);
						return HttpServerResponse.raw(response.body, {
							status: response.status,
							headers: response.headers,
						});
					}),
				);
			};
			return handlers.handleRaw("getMp4", serve).handleRaw("headMp4", serve);
		}),
	),
);
const handler = apiToHandler(ApiLive);
export const GET = (request: Request) => handler(request);
export const HEAD = (request: Request) => handler(request);
