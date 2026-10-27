import { comments } from "@cap/database/schema";
import { createStorageObjectToken } from "@cap/web-backend/src/Storage/SignedObject";
import { buildCanViewLoaded } from "@cap/web-backend/src/Videos/VideosPolicy";
import {
	CurrentUser,
	DatabaseError,
	Organisation,
	Policy,
	User,
	Video,
} from "@cap/web-domain";
import type { HttpApi } from "@effect/platform";
import type { Layer as EffectLayer } from "effect";
import { Effect, Option } from "effect";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ NEXTAUTH_SECRET: "fixture-signing-secret" }),
}));

const state = vi.hoisted(() => ({
	user: null as string | null,
	member: true,
	exists: true,
	databaseFails: false,
	deletedOrganization: false,
	password: null as string | null,
	verified: [] as string[],
	drive: false,
	commentExists: true,
	commentDatabaseFails: false,
	commentKey: "owner/video/comments/comment/media.webm",
	commentType: "video",
	commentMime: "video/webm",
	thumbnail: "owner/video/comments/comment/thumbnail.jpg",
	listObjects: vi.fn(),
	generate: vi.fn(),
	dispose: async () => {},
	head: vi.fn(),
	read: vi.fn(),
	access: vi.fn(),
	sign: vi.fn(),
	list: vi.fn(),
}));
let video = Video.Video.make({
	id: Video.VideoId.make("video"),
	ownerId: User.UserId.make("owner"),
	orgId: Organisation.OrganisationId.make("org"),
	name: "Recording",
	public: false,
	source: { type: "desktopMP4" },
	metadata: Option.none(),
	bucketId: Option.none(),
	storageIntegrationId: Option.none(),
	folderId: Option.none(),
	transcriptionStatus: Option.none(),
	width: Option.none(),
	height: Option.none(),
	duration: Option.none(),
	createdAt: new Date(),
	updatedAt: new Date(),
});
function load(id: string) {
	if (state.databaseFails)
		return Effect.fail(new DatabaseError({ cause: "Database unavailable" }));
	if (!state.exists || id !== video.id) return Effect.succeed(Option.none());
	const policy = buildCanViewLoaded(
		{
			repo: {
				getById: () => Effect.die("Unexpected lookup"),
				hasViewerGrant: () => Effect.succeed(false),
			},
			orgsRepo: {
				membershipForVideo: (user) =>
					Effect.succeed(
						user === "member" && state.member ? [{ membershipId: "m" }] : [],
					),
				allowedEmailDomain: () => Effect.succeed(Option.none()),
			},
			spacesRepo: {
				membershipForVideo: () => Effect.succeed(Option.none()),
				passwordsForVideo: () => Effect.succeed([]),
			},
		},
		video,
		Option.fromNullable(state.password),
	);
	return Effect.succeed(Option.some([video])).pipe(
		Policy.withPublicPolicy(policy),
	);
}
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: unknown) => ({
				where: () => ({
					limit: async () => {
						if (table === comments) {
							if (state.commentDatabaseFails)
								throw new Error("origin database failure");
							return state.commentExists
								? [
										{
											id: "comment",
											videoId: "video",
											type: state.commentType,
											mediaKey: state.commentKey,
											mediaMeta: {
												mime: state.commentMime,
												thumbnailKey: state.thumbnail,
											},
										},
									]
								: [];
						}
						return [
							{ tombstoneAt: state.deletedOrganization ? new Date() : null },
						];
					},
				}),
			}),
		}),
	}),
}));
vi.mock("@/lib/loom-preview-gif", () => ({
	ensureLoomPreviewGif: state.generate,
}));

vi.mock("@cap/web-backend", () => ({
	findScreenshotObjectKey: (objects: { Key?: string }[]) =>
		objects[0]?.Key ?? null,
	Videos: Effect.succeed({ getByIdForViewing: load }),
	Storage: { getAccessForVideo: state.access },
	provideOptionalAuth: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
		const withPassword = Effect.provideService(
			effect,
			Video.VideoPasswordAttachment,
			{ passwords: state.verified },
		);
		return state.user
			? withPassword.pipe(
					Effect.provideService(CurrentUser, {
						id: User.UserId.make(state.user),
						email: `${state.user}@test.invalid`,
						activeOrganizationId: video.orgId,
						iconUrlOrKey: Option.none(),
					}),
				)
			: withPassword;
	},
}));
vi.mock("@/lib/server", async () => {
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Layer } = await import("effect");
	return {
		apiToHandler: (api: EffectLayer.Layer<HttpApi.Api>) => {
			const handler = api.pipe(
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			const previous = state.dispose;
			state.dispose = async () => {
				await previous();
				await handler.dispose();
			};
			return handler.handler;
		},
	};
});
afterAll(() => state.dispose());

import { GET, HEAD } from "@/app/api/playback/resource/route";
import {
	GET as thumbnailGet,
	HEAD as thumbnailHead,
} from "@/app/api/thumbnail/route";
import {
	GET as previewGet,
	HEAD as previewHead,
} from "@/app/api/video/preview/route";
import { commentMediaUrl } from "@/lib/comment-media";
import { derivativeUrl } from "@/lib/viewer-derivatives";

function request(
	headers: Record<string, string> = {},
	method = "GET",
	query = "videoId=video&resource=vtt",
	signal?: AbortSignal,
) {
	return (method === "HEAD" ? HEAD : GET)(
		new NextRequest(`https://screenly.test/api/playback/resource?${query}`, {
			headers,
			method,
			signal,
		}),
	);
}
function expectNoStorage() {
	expect(state.access).not.toHaveBeenCalled();
	expect(state.head).not.toHaveBeenCalled();
	expect(state.read).not.toHaveBeenCalled();
	expect(state.sign).not.toHaveBeenCalled();
	expect(state.list).not.toHaveBeenCalled();
	expect(state.listObjects).not.toHaveBeenCalled();
}
function expectPrivate(response: Response) {
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	expect(response.headers.get("Location")).toBeNull();
}
beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(state, {
		user: "owner",
		member: true,
		exists: true,
		databaseFails: false,
		deletedOrganization: false,
		password: null,
		verified: [],
		drive: false,
		commentExists: true,
		commentDatabaseFails: false,
		commentKey: "owner/video/comments/comment/media.webm",
		commentType: "video",
		commentMime: "video/webm",
		thumbnail: "owner/video/comments/comment/thumbnail.jpg",
	});
	video = Video.Video.make({
		...video,
		public: false,
		source: { type: "desktopMP4" },
	});
	state.generate.mockReturnValue(Effect.succeed(false));
	state.listObjects.mockReturnValue(
		Effect.succeed({
			Contents: [{ Key: "owner/video/screenshot/screen-capture.jpg" }],
		}),
	);
	state.head.mockReturnValue(
		Effect.succeed({
			ContentLength: 10,
			ContentType: "video/mp4",
			ETag: '"v1"',
		}),
	);
	state.read.mockImplementation((_key: string, range: string | null) =>
		Effect.sync(() => {
			const match = range?.match(/bytes=(\d+)-(\d+)/);
			const start = match ? Number(match[1]) : 0;
			const end = match ? Number(match[2]) : 9;
			return new Response("0123456789".slice(start, end + 1), {
				status: match ? 206 : 200,
				headers: {
					"Content-Length": String(end - start + 1),
					...(match ? { "Content-Range": `bytes ${start}-${end}/10` } : {}),
				},
			});
		}),
	);
	state.access.mockImplementation(() =>
		Effect.succeed([
			{
				headObject: state.head,
				getSignedObjectUrl: state.sign,
				listObjects: state.listObjects,
				...(state.drive
					? { getObjectResponse: state.read }
					: { getPlaybackObjectResponse: state.read }),
			},
		]),
	);
});

const resources = [
	{ resource: "thumbnail", mime: "image/jpeg" },
	{ resource: "preview", mime: "image/gif" },
	{ resource: "vtt", mime: "text/vtt; charset=utf-8" },
	{ resource: "enhanced-audio", mime: "audio/mpeg" },
	{ resource: "comment-media", mime: "video/webm" },
	{ resource: "comment-thumbnail", mime: "image/jpeg" },
];
const query = (resource: string) =>
	`videoId=video&resource=${resource}&commentId=comment`;
function cache(response: Response) {
	expectPrivate(response);
	expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
	expect(response.headers.get("Vercel-CDN-Cache-Control")).toBe("no-store");
}

describe.each(resources)("derived resource $resource", ({ resource, mime }) => {
	it.each(["owner", "member"])("delivers GET bytes to %s", async (user) => {
		state.user = user;
		const response = await request({}, "GET", query(resource));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(mime);
		expect(response.headers.get("content-length")).toBe("10");
		expect(response.headers.get("etag")).toBe('"v1"');
		cache(response);
		expect(await response.text()).toBe("0123456789");
		expect(state.sign).not.toHaveBeenCalled();
	});
	it.each([null, "outsider"])(
		"denies %s and valid legacy tokens before storage",
		async (user) => {
			state.user = user;
			const token = createStorageObjectToken({
				videoId: "video",
				key: "owner/video/transcription.vtt",
			});
			const response = await request(
				{},
				"GET",
				`${query(resource)}&token=${token}`,
			);
			expect(response.status).toBe(404);
			cache(response);
			expectNoStorage();
		},
	);
	it("allows explicit public access but denies the next read after privatization", async () => {
		state.user = null;
		video = Video.Video.make({ ...video, public: true });
		const admitted = await request({}, "GET", query(resource));
		expect(admitted.status).toBe(200);
		video = Video.Video.make({ ...video, public: false });
		vi.clearAllMocks();
		const response = await request({}, "GET", query(resource));
		expect(response.status).toBe(404);
		expectNoStorage();
		expect(await admitted.text()).toBe("0123456789");
	});
	it("revokes membership for the next Range", async () => {
		state.user = "member";
		expect((await request({}, "GET", query(resource))).status).toBe(200);
		state.member = false;
		vi.clearAllMocks();
		const response = await request(
			{ Range: "bytes=2-4" },
			"GET",
			query(resource),
		);
		expect(response.status).toBe(404);
		cache(response);
		expectNoStorage();
	});
	it("checks changed passwords", async () => {
		state.user = "member";
		state.password = "old";
		state.verified = ["old"];
		expect((await request({}, "GET", query(resource))).status).toBe(200);
		state.password = "new";
		vi.clearAllMocks();
		expect((await request({}, "GET", query(resource))).status).toBe(404);
		expectNoStorage();
	});
	it.each(["deleted", "org", "db", "other-id"])(
		"denies %s before storage",
		async (reason) => {
			if (reason === "deleted") state.exists = false;
			if (reason === "org") state.deletedOrganization = true;
			if (reason === "db") state.databaseFails = true;
			const response = await request(
				{},
				"GET",
				reason === "other-id"
					? query(resource).replace("videoId=video", "videoId=other")
					: query(resource),
			);
			expect(response.status).toBe(reason === "db" ? 503 : 404);
			cache(response);
			expectNoStorage();
		},
	);
	it.each(["other/video/a.jpg", "../secret"])(
		"rejects key override %s",
		async (key) => {
			const response = await request(
				{},
				"GET",
				`${query(resource)}&key=${encodeURIComponent(key)}`,
			);
			expect(response.status).toBe(400);
			cache(response);
			expectNoStorage();
		},
	);
	it("supports HEAD and reauthorizes an anonymous HEAD", async () => {
		const response = await request({}, "HEAD", query(resource));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("");
		expect(response.headers.get("content-type")).toBe(mime);
		expect(state.read).not.toHaveBeenCalled();
		cache(response);
		state.user = null;
		vi.clearAllMocks();
		expect((await request({}, "HEAD", query(resource))).status).toBe(404);
		expectNoStorage();
	});
	it("returns 206 and 416 with safe ranges", async () => {
		const response = await request(
			{ Range: "bytes=2-4" },
			"GET",
			query(resource),
		);
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe("bytes 2-4/10");
		expect(response.headers.get("content-length")).toBe("3");
		expect(await response.text()).toBe("234");
		cache(response);
		state.read.mockClear();
		const invalid = await request(
			{ Range: "bytes=90-100" },
			"GET",
			query(resource),
		);
		expect(invalid.status).toBe(416);
		expect(state.read).not.toHaveBeenCalled();
		cache(invalid);
	});
	it("sanitizes storage errors and forbids origin redirects", async () => {
		state.read.mockReturnValueOnce(
			Effect.fail(new Error("https://secret.s3.example?signature=origin")),
		);
		const response = await request({}, "GET", query(resource));
		expect(response.status).toBe(502);
		expect(await response.text()).toBe("");
		cache(response);
		state.read.mockReturnValueOnce(
			Effect.succeed(
				new Response(null, {
					status: 302,
					headers: { Location: "https://secret.s3.example?signature=origin" },
				}),
			),
		);
		const redirect = await request({}, "GET", query(resource));
		expect(redirect.status).toBe(502);
		cache(redirect);
	});
	it("cancels the upstream stream", async () => {
		const cancel = vi.fn();
		state.read.mockReturnValue(
			Effect.succeed(new Response(new ReadableStream({ cancel }))),
		);
		const response = await request({}, "GET", query(resource));
		await response.body?.cancel();
		expect(cancel).toHaveBeenCalledOnce();
	});
});

describe("resource resolution and consumers", () => {
	it.each(["thumbnail", "preview"])(
		"returns safe 404 for missing %s",
		async (resource) => {
			state.head.mockReturnValue(Effect.fail({ name: "NotFound" }));
			const response = await request({}, "GET", query(resource));
			expect(response.status).toBe(404);
			cache(response);
			expect(state.sign).not.toHaveBeenCalled();
			expect(state.read).not.toHaveBeenCalled();
		},
	);
	it("serves PNG with its correct MIME", async () => {
		state.listObjects.mockReturnValue(
			Effect.succeed({
				Contents: [{ Key: "owner/video/screenshot/screen-capture.png" }],
			}),
		);
		const response = await request({}, "GET", query("thumbnail"));
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.status).toBe(200);
	});
	it.each(["desktopMP4", "webMP4"] as const)(
		"uses published %s thumbnails without scanning older outputs",
		async (type) => {
			const key = "owner/video/.recording/outputs/edit/thumbnail.jpg";
			video = Video.Video.make({
				...video,
				source: { type, thumbnailKey: key },
			});
			const response = await request({}, "GET", query("thumbnail"));
			expect(response.status).toBe(200);
			expect(state.listObjects).not.toHaveBeenCalled();
			expect(state.head).toHaveBeenCalledWith(key);
		},
	);
	it.each(["owner/other/image.jpg", "owner/video/../image.jpg"])(
		"rejects persisted thumbnail traversal or another video: %s",
		async (thumbnailKey) => {
			video = Video.Video.make({
				...video,
				source: { type: "desktopMP4", thumbnailKey },
			});
			expect((await request({}, "GET", query("thumbnail"))).status).toBe(404);
			expectNoStorage();
		},
	);
	it.each(["missing", "foreign-key", "traversal", "db"])(
		"denies comment %s before storage",
		async (reason) => {
			if (reason === "missing") state.commentExists = false;
			if (reason === "db") state.commentDatabaseFails = true;
			if (reason === "foreign-key")
				state.commentKey = "owner/other/comments/comment/media.webm";
			if (reason === "traversal")
				state.commentKey = "owner/video/comments/comment/../media.webm";
			const response = await request({}, "GET", query("comment-media"));
			expect(response.status).toBe(reason === "db" ? 503 : 404);
			expectNoStorage();
			cache(response);
		},
	);
	it("does not serve a comment thumbnail from another record", async () => {
		state.thumbnail = "owner/video/comments/other/thumbnail.jpg";
		expect((await request({}, "GET", query("comment-thumbnail"))).status).toBe(
			404,
		);
		expectNoStorage();
	});
	it("preserves the JSON thumbnail contract with only a proxy URL", async () => {
		const response = await thumbnailGet(
			new NextRequest("https://screenly.test/api/thumbnail?videoId=video"),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			screen: derivativeUrl("video", "thumbnail"),
		});
		expect(state.sign).not.toHaveBeenCalled();
		cache(response);
		const head = await thumbnailHead(
			new NextRequest("https://screenly.test/api/thumbnail?videoId=video", {
				method: "HEAD",
			}),
		);
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
	});
	it("serves GIF bytes at the existing image consumer path", async () => {
		const response = await previewGet(
			new NextRequest("https://screenly.test/api/video/preview?videoId=video"),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/gif");
		cache(response);
		const head = await previewHead(
			new NextRequest("https://screenly.test/api/video/preview?videoId=video", {
				method: "HEAD",
			}),
		);
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
	});
	it("does not generate a GIF or use the public fallback on storage failure", async () => {
		state.head.mockReturnValue(
			Effect.fail(new Error("origin storage failure")),
		);
		const response = await previewGet(
			new NextRequest(
				"https://screenly.test/api/video/preview?videoId=video&fallback=og",
			),
		);
		expect(response.status).toBe(502);
		expect(state.generate).not.toHaveBeenCalled();
		cache(response);
	});
	it("preserves authorized generation only for a known missing GIF, never for HEAD", async () => {
		state.head.mockReturnValueOnce(Effect.fail({ name: "NotFound" }));
		state.generate.mockReturnValue(Effect.succeed(true));
		const response = await previewGet(
			new NextRequest("https://screenly.test/api/video/preview?videoId=video"),
		);
		expect(response.status).toBe(200);
		expect(state.generate).toHaveBeenCalledOnce();
		state.generate.mockClear();
		state.head.mockReturnValueOnce(Effect.fail({ name: "NotFound" }));
		const head = await previewHead(
			new NextRequest("https://screenly.test/api/video/preview?videoId=video", {
				method: "HEAD",
			}),
		);
		expect(head.status).toBe(404);
		expect(state.generate).not.toHaveBeenCalled();
	});
	it("keeps comment IDs in URLs and object keys server-side", () => {
		expect(commentMediaUrl("video", "comment")).toBe(
			`${query("comment-media").replace("videoId=video&", "/api/playback/resource?videoId=video&")}`,
		);
		expect(commentMediaUrl("video", "comment", true)).toContain(
			"resource=comment-thumbnail&commentId=comment",
		);
	});
	it("aborts an admitted origin read on request interruption", async () => {
		const cancel = vi.fn();
		state.read.mockReturnValue(
			Effect.succeed(new Response(new ReadableStream({ cancel }))),
		);
		const controller = new AbortController();
		const response = await request({}, "GET", query("vtt"), controller.signal);
		controller.abort();
		await expect(response.text()).rejects.toThrow();
		expect(cancel).toHaveBeenCalledOnce();
	});
});

it("preserves VTT cue timing and UTF-8 bytes", async () => {
	const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nVídeo privado\n";
	const length = new TextEncoder().encode(vtt).length;
	state.head.mockReturnValue(Effect.succeed({ ContentLength: length }));
	state.read.mockReturnValue(Effect.succeed(new Response(vtt)));
	const response = await request({}, "GET", query("vtt"));
	expect(response.status).toBe(200);
	expect(response.headers.get("content-length")).toBe(String(length));
	expect(response.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
	expect(await response.text()).toBe(vtt);
});

it.each([
	["audio/webm", "webm"],
	["audio/mp4", "m4a"],
	["audio/mpeg", "mp3"],
	["audio/aac", "aac"],
	["audio/ogg", "ogg"],
])("serves audio comments as %s", async (mime, ext) => {
	state.commentType = "audio";
	state.commentMime = mime;
	state.commentKey = `owner/video/comments/comment/media.${ext}`;
	state.thumbnail = "";
	const response = await request({}, "GET", query("comment-media"));
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe(mime);
});

it("denies a different comment identifier before storage", async () => {
	const response = await request(
		{},
		"GET",
		query("comment-media").replace("commentId=comment", "commentId=other"),
	);
	expect(response.status).toBe(404);
	expectNoStorage();
});

it("keeps Drive-derived bytes behind the same proxy", async () => {
	state.drive = true;
	const response = await request({ Range: "bytes=0-0" }, "GET", query("vtt"));
	expect(response.status).toBe(206);
	cache(response);
	expect(await response.text()).toBe("0");
	expect(state.sign).not.toHaveBeenCalled();
});

it.each(["../other.gif", "owner/other/preview.gif"])(
	"rejects persisted preview manipulation %s",
	async (previewKey) => {
		video = Video.Video.make({
			...video,
			source: { type: "desktopMP4", previewKey },
		});
		const response = await request({}, "GET", query("preview"));
		expect(response.status).toBe(404);
		expectNoStorage();
	},
);
