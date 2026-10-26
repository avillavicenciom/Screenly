import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { getSharePlaybackUrl } from "@/lib/share-playback";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	sign: vi.fn(),
}));

vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo: mocks.access },
}));

vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));

const video = {
	id: "video",
	owner: { id: "owner" },
	orgId: "organization",
	name: "Recording",
	public: true,
	source: { type: "desktopMP4" },
	metadata: null,
	bucket: "custom-bucket",
	storageIntegrationId: null,
	transcriptionStatus: "COMPLETE",
	width: 1920,
	height: 1080,
	duration: 60,
	createdAt: new Date("2026-09-09T00:00:00.000Z"),
	updatedAt: new Date("2026-09-09T00:00:00.000Z"),
} as unknown as Parameters<typeof getSharePlaybackUrl>[0];

describe("share page playback URL", () => {
	it.each(["desktopMP4", "webMP4"] as const)(
		"emits a same-origin proxy for %s without signing",
		async (type) => {
			expect(await getSharePlaybackUrl({ ...video, source: { type } })).toBe(
				"/api/playback/mp4?videoId=video",
			);
			expect(mocks.access).not.toHaveBeenCalled();
			expect(mocks.sign).not.toHaveBeenCalled();
		},
	);
	it("keeps the key and provider server-side even for published edits", async () => {
		expect(
			await getSharePlaybackUrl({
				...video,
				source: {
					type: "desktopMP4",
					outputKey: "owner/video/.recording/outputs/edit/result.mp4",
				},
			}),
		).toBe("/api/playback/mp4?videoId=video");
		expect(mocks.access).not.toHaveBeenCalled();
	});
	it.each(["MediaConvert", "local", "desktopSegments"] as const)(
		"leaves %s to its existing playback path",
		async (type) => {
			expect(
				await getSharePlaybackUrl({ ...video, source: { type } }),
			).toBeNull();
		},
	);
	it("does not emit a URL for invalid video metadata", async () => {
		expect(
			await getSharePlaybackUrl({
				...video,
				name: null,
			} as unknown as typeof video),
		).toBeNull();
	});
});
