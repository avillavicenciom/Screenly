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
	viewerGrant: false,
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
				hasViewerGrant: (_id, email) =>
					Effect.succeed(email === "viewer@test.invalid" && state.viewerGrant),
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
	expect(state.generate).not.toHaveBeenCalled();
}
function expectPrivate(response: Response, location: string | null = null) {
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
	expect(response.headers.get("Vercel-CDN-Cache-Control")).toBe("no-store");
	expect(response.headers.get("Pragma")).toBe("no-cache");
	expect(response.headers.get("Expires")).toBe("0");
	expect(response.headers.get("Location")).toBe(location);
}
beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(state, {
		user: "owner",
		member: true,
		viewerGrant: false,
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
}

const retrievals: {
	name: string;
	method: "GET" | "HEAD";
	headers: Record<string, string>;
	status: number;
	body: string;
}[] = [
	{ name: "GET", method: "GET", headers: {}, status: 200, body: "0123456789" },
	{ name: "HEAD", method: "HEAD", headers: {}, status: 200, body: "" },
	{
		name: "Range",
		method: "GET",
		headers: { Range: "bytes=2-4" },
		status: 206,
		body: "234",
	},
	{
		name: "matching If-Range",
		method: "GET",
		headers: { Range: "bytes=2-4", "If-Range": '"v1"' },
		status: 206,
		body: "234",
	},
	{
		name: "stale If-Range",
		method: "GET",
		headers: { Range: "bytes=2-4", "If-Range": '"old"' },
		status: 200,
		body: "0123456789",
	},
];
const revocations = ["membership", "viewer grant", "public access", "password"];
function admitFor(reason: string) {
	state.user = reason === "viewer grant" ? "viewer" : "member";
	state.viewerGrant = reason === "viewer grant";
	if (reason === "public access") {
		state.user = null;
		video = Video.Video.make({ ...video, public: true });
	}
	if (reason === "password") {
		state.password = "old-hash";
		state.verified = ["old-hash"];
	}
}
function revoke(reason: string) {
	if (reason === "membership") state.member = false;
	if (reason === "viewer grant") state.viewerGrant = false;
	if (reason === "public access")
		video = Video.Video.make({ ...video, public: false });
	if (reason === "password") state.password = "new-hash";
}

describe.each(resources)("derived resource $resource", ({ resource, mime }) => {
	it.each(["owner", "member", "viewer"])(
		"delivers GET bytes to %s",
		async (user) => {
			state.user = user;
			state.viewerGrant = user === "viewer";
			const response = await request({}, "GET", query(resource));
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe(mime);
			expect(response.headers.get("content-length")).toBe("10");
			expect(response.headers.get("etag")).toBe('"v1"');
			cache(response);
			expect(await response.text()).toBe("0123456789");
			expect(state.sign).not.toHaveBeenCalled();
		},
	);
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
	describe.each(revocations)("after revoking %s", (reason) => {
		it.each(retrievals)(
			"reauthorizes $name before storage IO",
			async (read) => {
				admitFor(reason);
				const admitted = await request(
					read.headers,
					read.method,
					query(resource),
				);
				expect(admitted.status).toBe(read.status);
				cache(admitted);
				const downloaded = await admitted.text();
				expect(downloaded).toBe(read.body);
				revoke(reason);
				vi.clearAllMocks();
				const denied = await request(
					read.headers,
					read.method,
					query(resource),
				);
				expect(denied.status).toBe(404);
				cache(denied);
				expect(await denied.text()).toBe("");
				expectNoStorage();
			},
		);
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

function aliasRequest(
	alias: "thumbnail" | "preview",
	headers: Record<string, string> = {},
	method: "GET" | "HEAD" = "GET",
) {
	const path = alias === "thumbnail" ? "/api/thumbnail" : "/api/video/preview";
	const handler =
		alias === "thumbnail"
			? method === "HEAD"
				? thumbnailHead
				: thumbnailGet
			: method === "HEAD"
				? previewHead
				: previewGet;
	return handler(
		new NextRequest(`https://screenly.test${path}?videoId=video`, {
			headers,
			method,
		}),
	);
}

describe.each(["thumbnail", "preview"] as const)(
	"compatibility route %s",
	(alias) => {
		it.each(["owner", "member", "viewer"])(
			"admits %s with current access",
			async (user) => {
				state.user = user;
				state.viewerGrant = user === "viewer";
				const response = await aliasRequest(alias);
				expect(response.status).toBe(200);
				cache(response);
				if (alias === "thumbnail")
					expect(await response.json()).toEqual({
						screen: derivativeUrl("video", "thumbnail"),
					});
				else expect(await response.text()).toBe("0123456789");
				expect(state.sign).not.toHaveBeenCalled();
			},
		);
		it.each([null, "outsider"])("denies %s before storage IO", async (user) => {
			state.user = user;
			const response = await aliasRequest(alias);
			expect(response.status).toBe(404);
			cache(response);
			expect(await response.text()).toBe("");
			expectNoStorage();
		});
		describe.each(revocations)("after revoking %s", (reason) => {
			it.each(alias === "thumbnail" ? retrievals.slice(0, 2) : retrievals)(
				"reauthorizes $name before storage IO",
				async (read) => {
					admitFor(reason);
					const admitted = await aliasRequest(alias, read.headers, read.method);
					expect(admitted.status).toBe(
						alias === "thumbnail" ? 200 : read.status,
					);
					cache(admitted);
					if (alias === "thumbnail" && read.method === "GET")
						expect(await admitted.json()).toEqual({
							screen: derivativeUrl("video", "thumbnail"),
						});
					else expect(await admitted.text()).toBe(read.body);
					revoke(reason);
					vi.clearAllMocks();
					const denied = await aliasRequest(alias, read.headers, read.method);
					expect(denied.status).toBe(404);
					cache(denied);
					expect(await denied.text()).toBe("");
					expectNoStorage();
				},
			);
		});
	},
);

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

describe.each(resources)(
	"derived HTTP boundary $resource",
	({ resource, mime }) => {
		it.each([
			{ name: "missing", error: { name: "NotFound" }, status: 404 },
			{
				name: "unavailable",
				error: new Error("origin unavailable"),
				status: 502,
			},
		])(
			"keeps a $name HEAD private without reading or generating",
			async ({ error, status }) => {
				state.head.mockReturnValue(Effect.fail(error));
				const response = await request({}, "HEAD", query(resource));
				expect(response.status).toBe(status);
				expect(await response.text()).toBe("");
				cache(response);
				expect(state.read).not.toHaveBeenCalled();
				expect(state.sign).not.toHaveBeenCalled();
				expect(state.generate).not.toHaveBeenCalled();
			},
		);
		it("ignores a weak If-Range and returns the complete authorized object", async () => {
			const response = await request(
				{ Range: "bytes=2-4", "If-Range": 'W/"v1"' },
				"GET",
				query(resource),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Range")).toBeNull();
			expect(response.headers.get("Content-Length")).toBe("10");
			expect(await response.text()).toBe("0123456789");
			cache(response);
			expect(state.read.mock.calls[0]?.[1]).toBeNull();
			expect(state.sign).not.toHaveBeenCalled();
		});
		it("cancels an origin 416 body and exposes only a private range error", async () => {
			const cancel = vi.fn();
			state.read.mockReturnValue(
				Effect.succeed(
					new Response(
						new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }),
						{
							status: 416,
							headers: {
								Location: "https://secret.s3.example?signature=origin",
								"Set-Cookie": "storage-session=fixture-provider-cookie",
							},
						},
					),
				),
			);
			const response = await request(
				{ Range: "bytes=2-4" },
				"GET",
				query(resource),
			);
			expect(response.status).toBe(416);
			expect(response.headers.get("Content-Range")).toBe("bytes */10");
			expect(response.headers.get("Set-Cookie")).toBeNull();
			expect(await response.text()).toBe("");
			cache(response);
			expect(cancel).toHaveBeenCalledOnce();
			expect(state.sign).not.toHaveBeenCalled();
		});
		it("does not forward origin URLs, provider credentials or public cache headers", async () => {
			state.read.mockReturnValue(
				Effect.succeed(
					new Response("0123456789", {
						headers: {
							"Content-Length": "10",
							"Cache-Control": "public, max-age=300",
							Location: "https://secret.s3.example?signature=origin",
							"Set-Cookie": "storage-session=fixture-provider-cookie",
							Authorization: "Bearer fixture-provider-token",
							"X-Amz-Security-Token": "fixture-provider-token",
						},
					}),
				),
			);
			const response = await request({}, "GET", query(resource));
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe(mime);
			expect(response.headers.get("Authorization")).toBeNull();
			expect(response.headers.get("Set-Cookie")).toBeNull();
			expect(response.headers.get("X-Amz-Security-Token")).toBeNull();
			const serialized = JSON.stringify([...response.headers.entries()]);
			expect(serialized).not.toContain("secret.s3.example");
			expect(serialized).not.toContain("fixture-provider");
			expect(await response.text()).toBe("0123456789");
			cache(response);
			expect(state.sign).not.toHaveBeenCalled();
		});
		it("denies new reads while an already admitted stream can finish", async () => {
			admitFor("viewer grant");
			let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
			const cancel = vi.fn();
			state.read.mockReturnValue(
				Effect.succeed(
					new Response(
						new ReadableStream<Uint8Array>(
							{
								start(controller) {
									upstream = controller;
								},
								cancel,
							},
							{ highWaterMark: 0 },
						),
						{ headers: { "Content-Length": "10" } },
					),
				),
			);
			const admitted = await request({}, "GET", query(resource));
			expect(admitted.status).toBe(200);
			cache(admitted);
			const reader = admitted.body?.getReader();
			if (!reader || !upstream)
				throw new Error("Missing admitted derivative stream");
			try {
				upstream.enqueue(new TextEncoder().encode("01234"));
				const downloaded = await reader.read();
				expect(new TextDecoder().decode(downloaded.value)).toBe("01234");
				revoke("viewer grant");
				vi.clearAllMocks();
				const denied = await request(
					{ Range: "bytes=5-9" },
					"GET",
					query(resource),
				);
				expect(denied.status).toBe(404);
				expect(await denied.text()).toBe("");
				cache(denied);
				expectNoStorage();
				upstream.enqueue(new TextEncoder().encode("56789"));
				upstream.close();
				expect(new TextDecoder().decode((await reader.read()).value)).toBe(
					"56789",
				);
				expect((await reader.read()).done).toBe(true);
				expect(new TextDecoder().decode(downloaded.value)).toBe("01234");
				expect(cancel).not.toHaveBeenCalled();
			} finally {
				await reader.cancel();
				reader.releaseLock();
			}
		});
	},
);

it.each(["GET", "HEAD"] as const)(
	"keeps an authorized OG fallback redirect private for %s and rechecks revocation",
	async (method) => {
		admitFor("viewer grant");
		state.head.mockReturnValue(Effect.fail({ name: "NotFound" }));
		const handler = method === "HEAD" ? previewHead : previewGet;
		const open = () =>
			handler(
				new NextRequest(
					"https://screenly.test/api/video/preview?videoId=video&fallback=og",
					{ method },
				),
			);
		const admitted = await open();
		expect(admitted.status).toBe(302);
		expectPrivate(admitted, "/api/video/og?videoId=video");
		expect(await admitted.text()).toBe("");
		expect(state.read).not.toHaveBeenCalled();
		expect(state.generate).not.toHaveBeenCalled();
		expect(state.sign).not.toHaveBeenCalled();
		revoke("viewer grant");
		vi.clearAllMocks();
		const denied = await open();
		expect(denied.status).toBe(404);
		expect(await denied.text()).toBe("");
		cache(denied);
		expectNoStorage();
	},
);

it("does not turn a retained thumbnail descriptor into a grant for its byte URL", async () => {
	admitFor("viewer grant");
	const admitted = await aliasRequest("thumbnail");
	expect(admitted.status).toBe(200);
	cache(admitted);
	const descriptor: unknown = await admitted.json();
	expect(descriptor).toEqual({ screen: derivativeUrl("video", "thumbnail") });
	if (
		typeof descriptor !== "object" ||
		descriptor === null ||
		!("screen" in descriptor) ||
		typeof descriptor.screen !== "string"
	)
		throw new Error("Missing thumbnail proxy descriptor");
	revoke("viewer grant");
	vi.clearAllMocks();
	const denied = await GET(
		new NextRequest(`https://screenly.test${descriptor.screen}`),
	);
	expect(denied.status).toBe(404);
	expect(await denied.text()).toBe("");
	cache(denied);
	expectNoStorage();
});
