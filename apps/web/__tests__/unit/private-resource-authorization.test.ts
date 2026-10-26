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
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	user: null as string | null,
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
						id === "member" ? [{ membershipId: "membership" }] : [],
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
		getById: () => Effect.die("Unexpected token bypass"),
	}),
	Storage: { getAccessForVideo: state.access },
	verifyStorageObjectToken: () => null,
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
vi.mock("@/utils/helpers", () => ({
	CACHE_CONTROL_HEADERS: {},
	getHeaders: () => ({}),
}));

import { GET, HEAD } from "@/app/api/storage/object/route";
import { GET as thumbnail } from "@/app/api/thumbnail/route";

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
