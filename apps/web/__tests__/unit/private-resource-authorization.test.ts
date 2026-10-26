import {
	createStorageObjectToken,
	verifyStorageObjectToken,
} from "@cap/web-backend/src/Storage/SignedObject";
import { buildCanViewLoaded } from "@cap/web-backend/src/Videos/VideosPolicy";
import {
	CurrentUser,
	Organisation,
	Policy,
	User,
	Video,
} from "@cap/web-domain";
import { Effect, Option } from "effect";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	user: null as string | null,
	membership: true,
	read: vi.fn(),
	head: vi.fn(),
	sign: vi.fn(),
	access: vi.fn(),
	lookup: vi.fn(),
}));

const video = {
	id: Video.VideoId.make("private-video"),
	ownerId: User.UserId.make("owner"),
	orgId: Organisation.OrganisationId.make("org"),
	public: false,
	source: { type: "desktopMP4" as const },
};

function viewingPolicy() {
	return buildCanViewLoaded(
		{
			repo: {
				getById: () => Effect.die("Loaded policy must not reload the video"),
				hasViewerGrant: () => Effect.succeed(false),
			},
			orgsRepo: {
				membershipForVideo: (id) =>
					Effect.succeed(
						id === "member" && state.membership
							? [{ membershipId: "membership" }]
							: [],
					),
				allowedEmailDomain: () => Effect.succeed(Option.none()),
			},
			spacesRepo: {
				membershipForVideo: () => Effect.succeed(Option.none()),
				passwordsForVideo: () => Effect.succeed([]),
			},
		},
		video,
		Option.none(),
	);
}

function withUser<A, E, R>(effect: Effect.Effect<A, E, R>) {
	return state.user
		? effect.pipe(
				Effect.provideService(CurrentUser, {
					id: User.UserId.make(state.user),
					email: `${state.user}@example.test`,
					activeOrganizationId: video.orgId,
					iconUrlOrKey: Option.none(),
				}),
			)
		: effect;
}

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({ from: () => ({ where: state.lookup }) }),
	}),
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: withUser,
	VideosPolicy: Effect.succeed({ canView: () => viewingPolicy() }),
	Videos: Effect.succeed({
		getByIdForViewing: () =>
			Effect.succeed(Option.some([video])).pipe(
				Policy.withPublicPolicy(viewingPolicy()),
			),
	}),
	VideosRepo: Effect.succeed({
		getById: () => Effect.succeed(Option.some([video])),
	}),
	Storage: { getAccessForVideo: state.access },
	verifyStorageObjectToken,
	findScreenshotObjectKey: () =>
		"owner/private-video/screenshot/screen-capture.jpg",
}));
vi.mock("@/lib/server", () => ({
	runPromise: Effect.runPromise,
	runPromiseExit: Effect.runPromiseExit,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (value: unknown) => value,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ NEXTAUTH_SECRET: "isolated-test-signing-secret" }),
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://screenly.test" },
}));
vi.mock("@/lib/loom-preview-gif", () => ({
	ensureLoomPreviewGif: () => Effect.succeed(false),
}));
vi.mock("@/utils/helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/utils/helpers")>()),
}));

import { GET, HEAD } from "@/app/api/storage/object/route";
import { GET as thumbnail } from "@/app/api/thumbnail/route";
import { GET as preview } from "@/app/api/video/preview/route";

const profiles = [
	{ name: "anonymous", user: null, allowed: false },
	{ name: "owner", user: "owner", allowed: true },
	{ name: "authorized organization member", user: "member", allowed: true },
	{ name: "authenticated outsider", user: "outsider", allowed: false },
];
const resources = [
	{ name: "MP4 video", key: "result.mp4", type: "video/mp4" },
	{
		name: "thumbnail bytes",
		key: "screenshot/screen-capture.jpg",
		type: "image/jpeg",
	},
	{
		name: "HLS manifest",
		key: "combined-source/stream.m3u8",
		type: "application/vnd.apple.mpegurl",
	},
	{
		name: "HLS segment",
		key: "combined-source/segment_0.ts",
		type: "video/mp2t",
	},
	{ name: "transcript", key: "transcription.vtt", type: "text/vtt" },
];

beforeEach(() => {
	vi.clearAllMocks();
	state.user = null;
	state.membership = true;
	state.lookup.mockResolvedValue([video]);
	state.read.mockImplementation(() =>
		Effect.succeed(new Response("private-bytes")),
	);
	state.head.mockReturnValue(
		Effect.succeed({ ContentLength: 13, ContentType: "video/mp4" }),
	);
	state.sign.mockReturnValue(
		Effect.succeed("https://storage.example.test/private-thumbnail"),
	);
	state.access.mockReturnValue(
		Effect.succeed([
			{
				getObjectResponse: state.read,
				headObject: state.head,
				getSignedObjectUrl: state.sign,
				listObjects: () => Effect.succeed({ Contents: [] }),
			},
		]),
	);
});

describe.each(profiles)(
	"private file endpoints: $name",
	({ user, allowed }) => {
		it.each(resources)(
			"authorizes $name before reading or signing",
			async ({ key }) => {
				state.user = user;
				const response = await GET(
					new NextRequest(
						`https://screenly.test/api/storage/object?videoId=private-video&key=${encodeURIComponent(`owner/private-video/${key}`)}`,
					),
				);
				expect(response.status).toBe(allowed ? 200 : 404);
				expect(await response.text()).toBe(
					allowed ? "private-bytes" : "Not found",
				);
				expect(state.access).toHaveBeenCalledTimes(allowed ? 1 : 0);
				expect(state.read).toHaveBeenCalledTimes(allowed ? 1 : 0);
				expect(state.sign).not.toHaveBeenCalled();
			},
		);

		it("authorizes thumbnail URL issuance", async () => {
			state.user = user;
			const response = await thumbnail(
				new NextRequest(
					"https://screenly.test/api/thumbnail?videoId=private-video",
				),
			);
			expect(response.status).toBe(allowed ? 200 : 404);
			expect(state.sign).toHaveBeenCalledTimes(allowed ? 1 : 0);
			expect(state.lookup).toHaveBeenCalledTimes(allowed ? 1 : 0);
		});

		it("authorizes HEAD before revealing file metadata", async () => {
			state.user = user;
			const response = await HEAD(
				new NextRequest(
					"https://screenly.test/api/storage/object?videoId=private-video&key=owner/private-video/result.mp4",
					{ method: "HEAD" },
				),
			);
			expect(response.status).toBe(allowed ? 200 : 404);
			expect(state.head).toHaveBeenCalledTimes(allowed ? 1 : 0);
			expect(state.read).not.toHaveBeenCalled();
		});
	},
);

afterEach(() => vi.useRealTimers());

const objectKey = "owner/private-video/result.mp4";
const signedRequest = (
	token?: string,
	key = objectKey,
	videoId = "private-video",
) =>
	GET(
		new NextRequest(
			`https://screenly.test/api/storage/object?${new URLSearchParams({ videoId, key, ...(token ? { token } : {}) })}`,
		),
	);

describe("signed private link lifecycle: current behavior", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
	});

	it("expires the default token after one hour", () => {
		const token = createStorageObjectToken({
			videoId: video.id,
			key: objectKey,
		});
		vi.advanceTimersByTime(3_599_999);
		expect(verifyStorageObjectToken(token)).not.toBeNull();
		vi.advanceTimersByTime(2);
		expect(verifyStorageObjectToken(token)).toBeNull();
	});

	it("currently accepts the exact expiration millisecond", () => {
		const token = createStorageObjectToken(
			{ videoId: video.id, key: objectKey },
			1,
		);
		vi.advanceTimersByTime(1000);
		expect(verifyStorageObjectToken(token)).not.toBeNull();
	});

	it("rejects a modified signature", async () => {
		const token = createStorageObjectToken({
			videoId: video.id,
			key: objectKey,
		});
		expect((await signedRequest(`${token}invalid`)).status).toBe(404);
		expect(state.read).not.toHaveBeenCalled();
	});

	it.each([
		{ key: "owner/private-video/transcription.vtt", id: "private-video" },
		{ key: "owner/other-video/result.mp4", id: "other-video" },
	])(
		"does not authorize a different key or identifier: $key",
		async ({ key, id }) => {
			const token = createStorageObjectToken({
				videoId: video.id,
				key: objectKey,
			});
			expect((await signedRequest(token, key, id)).status).toBe(404);
			expect(state.read).not.toHaveBeenCalled();
		},
	);

	it("revokes session access but an old valid bearer link still reads bytes", async () => {
		state.user = "member";
		expect((await signedRequest()).status).toBe(200);
		const token = createStorageObjectToken({
			videoId: video.id,
			key: objectKey,
		});
		state.membership = false;
		expect((await signedRequest()).status).toBe(404);
		state.user = null;
		expect((await signedRequest(token)).status).toBe(200);
		vi.advanceTimersByTime(3_600_001);
		expect((await signedRequest(token)).status).toBe(404);
	});

	it("instructs compliant caches not to store proxied bytes", async () => {
		state.user = "owner";
		const response = await signedRequest();
		expect(response.headers.get("cache-control")).toContain("no-store");
		expect(response.headers.get("pragma")).toBe("no-cache");
	});

	it("currently omits cache restrictions on storage redirects", async () => {
		state.user = "owner";
		state.access.mockReturnValue(
			Effect.succeed([{ getSignedObjectUrl: state.sign }]),
		);
		const response = await signedRequest();
		expect(response.status).toBe(302);
		expect(response.headers.get("cache-control")).toBeNull();
	});

	it("currently omits cache restrictions on thumbnail URL responses", async () => {
		state.user = "owner";
		const response = await thumbnail(
			new NextRequest(
				"https://screenly.test/api/thumbnail?videoId=private-video",
			),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBeNull();
	});

	it("currently marks an authorized GIF redirect publicly cacheable for five minutes", async () => {
		state.user = "owner";
		const response = await preview(
			new NextRequest(
				"https://screenly.test/api/video/preview?videoId=private-video",
			),
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
	});
});
