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
			from: () => ({
				where: () => ({
					limit: async () => [
						{ tombstoneAt: state.deletedOrganization ? new Date() : null },
					],
				}),
			}),
		}),
	}),
}));
vi.mock("@cap/web-backend", () => ({
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
			state.dispose = handler.dispose;
			return handler.handler;
		},
	};
});
afterAll(() => state.dispose());

import { GET, HEAD } from "@/app/api/playback/mp4/route";

function request(
	headers: Record<string, string> = {},
	method = "GET",
	query = "videoId=video",
	signal?: AbortSignal,
) {
	return (method === "HEAD" ? HEAD : GET)(
		new NextRequest(`https://screenly.test/api/playback/mp4?${query}`, {
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
	});
	video = Video.Video.make({
		...video,
		public: false,
		source: { type: "desktopMP4" },
	});
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
				listObjects: state.list,
				...(state.drive
					? { getObjectResponse: state.read }
					: { getPlaybackObjectResponse: state.read }),
			},
		]),
	);
});

describe("MP4 admission and revocation", () => {
	it.each(["owner", "member"])(
		"streams for %s without any origin URL",
		async (user) => {
			state.user = user;
			const response = await request();
			expect(response.status).toBe(200);
			expectPrivate(response);
			expect(await response.text()).toBe("0123456789");
			expect(state.sign).not.toHaveBeenCalled();
			expect(state.list).not.toHaveBeenCalled();
		},
	);
	it.each([null, "outsider"])(
		"denies %s before contacting storage, including legacy tokens",
		async (user) => {
			state.user = user;
			const response = await request(
				{},
				"GET",
				new URLSearchParams({
					videoId: "video",
					token: createStorageObjectToken({
						videoId: "video",
						key: "owner/video/result.mp4",
					}),
				}).toString(),
			);
			expect(response.status).toBe(404);
			expectPrivate(response);
			expectNoStorage();
		},
	);
	it("revokes the next Range after membership removal", async () => {
		state.user = "member";
		const admitted = await request();
		state.member = false;
		expect(await admitted.text()).toBe("0123456789");
		vi.clearAllMocks();
		expect((await request({ Range: "bytes=2-4" })).status).toBe(404);
		expectNoStorage();
	});
	it("rechecks public to private on the next request", async () => {
		state.user = null;
		video = Video.Video.make({ ...video, public: true });
		expect((await request()).status).toBe(200);
		video = Video.Video.make({ ...video, public: false });
		vi.clearAllMocks();
		expect((await request()).status).toBe(404);
		expectNoStorage();
	});
	it("rechecks changed passwords for a member", async () => {
		state.user = "member";
		state.password = "old-hash";
		state.verified = ["old-hash"];
		expect((await request()).status).toBe(200);
		state.password = "new-hash";
		vi.clearAllMocks();
		expect((await request()).status).toBe(404);
		expectNoStorage();
	});
	it.each(["deleted", "other-id", "db", "organization", "key"])(
		"fails closed for %s",
		async (reason) => {
			if (reason === "deleted") state.exists = false;
			if (reason === "db") state.databaseFails = true;
			if (reason === "organization") state.deletedOrganization = true;
			const query =
				reason === "other-id"
					? "videoId=other"
					: reason === "key"
						? "videoId=video&key=other/result.mp4"
						: "videoId=video";
			const response = await request({}, "GET", query);
			expect(response.status).toBe(
				reason === "db" ? 503 : reason === "key" ? 400 : 404,
			);
			expectPrivate(response);
			expectNoStorage();
		},
	);
	it.each([
		"other/video/result.mp4",
		"owner/video/../secret.mp4",
		"owner/video/source.webm",
	])("rejects an invalid published object %s", async (outputKey) => {
		video = Video.Video.make({
			...video,
			source: { type: "desktopMP4", outputKey },
		});
		expect((await request()).status).toBe(404);
		expectNoStorage();
	});
});

describe("MP4 HTTP streaming", () => {
	it("denies HEAD without storage access", async () => {
		state.user = null;
		const response = await request({}, "HEAD");
		expect(response.status).toBe(404);
		expectPrivate(response);
		expect(await response.text()).toBe("");
		expectNoStorage();
	});
	it("keeps an upstream 416 private and bodyless", async () => {
		state.read.mockReturnValue(
			Effect.succeed(new Response("origin error", { status: 416 })),
		);
		const response = await request({ Range: "bytes=2-4" });
		expect(response.status).toBe(416);
		expect(response.headers.get("Content-Range")).toBe("bytes */10");
		expect(await response.text()).toBe("");
		expectPrivate(response);
	});
	it("does not forward an origin with the wrong range or length", async () => {
		const cancel = vi.fn();
		state.read.mockReturnValue(
			Effect.succeed(
				new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), {
					status: 206,
					headers: { "Content-Range": "bytes 1-3/10", "Content-Length": "3" },
				}),
			),
		);
		const response = await request({ Range: "bytes=2-4" });
		expect(response.status).toBe(502);
		expect(await response.text()).toBe("");
		expect(cancel).toHaveBeenCalled();
	});
	it("supports HEAD without a byte read", async () => {
		const response = await request({}, "HEAD");
		expect(response.status).toBe(200);
		expectPrivate(response);
		expect(response.headers.get("Content-Length")).toBe("10");
		expect(response.headers.get("ETag")).toBe('"v1"');
		expect(response.headers.get("Accept-Ranges")).toBe("bytes");
		expect(await response.text()).toBe("");
		expect(state.read).not.toHaveBeenCalled();
	});
	it.each([
		["bytes=2-4", "234", "bytes 2-4/10"],
		["bytes=8-", "89", "bytes 8-9/10"],
		["bytes=-2", "89", "bytes 8-9/10"],
	])("supports Range %s", async (Range, body, contentRange) => {
		const response = await request({ Range });
		expect(response.status).toBe(206);
		expectPrivate(response);
		expect(response.headers.get("Content-Range")).toBe(contentRange);
		expect(response.headers.get("Content-Length")).toBe(String(body.length));
		expect(response.headers.get("Content-Type")).toBe("video/mp4");
		expect(await response.text()).toBe(body);
	});
	it.each(["bytes=20-", "bytes=5-2", "bytes=-0", "bytes=1-2,4-5", "garbage"])(
		"returns 416 without a body read for %s",
		async (Range) => {
			const response = await request({ Range });
			expect(response.status).toBe(416);
			expectPrivate(response);
			expect(response.headers.get("Content-Range")).toBe("bytes */10");
			expect(state.read).not.toHaveBeenCalled();
		},
	);
	it("ignores a mismatched If-Range and returns the full entity", async () => {
		const response = await request({ Range: "bytes=2-4", "If-Range": '"old"' });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("0123456789");
	});
	it("streams through the Drive interface without redirects", async () => {
		state.drive = true;
		const response = await request({ Range: "bytes=2-4" });
		expect(response.status).toBe(206);
		expectPrivate(response);
		expect(await response.text()).toBe("234");
	});
	it("sanitizes storage errors", async () => {
		state.read.mockReturnValue(
			Effect.fail(
				new Error("https://origin.test/private?X-Amz-Signature=secret"),
			),
		);
		const response = await request();
		expect(response.status).toBe(502);
		expectPrivate(response);
		expect(await response.text()).toBe("");
	});
	it("rejects a redirect or mismatched upstream range rather than leaking it", async () => {
		state.read.mockReturnValue(
			Effect.succeed(
				Response.redirect("https://origin.test/private?signature=secret"),
			),
		);
		const response = await request();
		expect(response.status).toBe(502);
		expectPrivate(response);
		expect(await response.text()).toBe("");
	});
	it("propagates request interruption to the upstream reader", async () => {
		const cancel = vi.fn();
		const controller = new AbortController();
		state.read.mockReturnValue(
			Effect.succeed(
				new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })),
			),
		);
		const response = await request(
			{},
			"GET",
			"videoId=video",
			controller.signal,
		);
		controller.abort();
		await expect(response.text()).rejects.toThrow();
		expect(cancel).toHaveBeenCalled();
	});
	it("propagates downstream cancellation without buffering the movie", async () => {
		const cancel = vi.fn();
		state.read.mockReturnValue(
			Effect.succeed(
				new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })),
			),
		);
		const response = await request();
		await response.body?.cancel();
		expect(cancel).toHaveBeenCalled();
	});
});
