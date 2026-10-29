import { describe, expect, it } from "vitest";
import { readCompletedRecordingManifest } from "@/lib/desktop-recording-verification";
import {
	getEarlySegmentTracks,
	getSegmentPlaybackState,
} from "@/lib/segment-playback";
import { generateM3U8Playlist } from "@/utils/video/ffmpeg/helpers";

const manifest = {
	version: 2,
	video_init_uploaded: true,
	audio_init_uploaded: false,
	video_segments: [{ index: 1, duration: 3 }],
	audio_segments: [],
	is_complete: true,
};

describe("existing HLS publication evidence boundaries", () => {
	it("accepts a structural completed manifest without object identities or reading bytes", () => {
		const proof = readCompletedRecordingManifest(JSON.stringify(manifest));
		expect(proof.videoSegments).toEqual([1]);
		expect(proof.hasAudio).toBe(false);
		expect(proof.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(getSegmentPlaybackState(manifest)).toBe("ready");
	});
	it("hashes the exact JSON bytes, not a canonical semantic inventory", () => {
		expect(
			readCompletedRecordingManifest(JSON.stringify(manifest)).manifestSha256,
		).not.toBe(
			readCompletedRecordingManifest(JSON.stringify(manifest, null, 2))
				.manifestSha256,
		);
	});
	it("does not accept an unfinished manifest as completion evidence", () => {
		expect(() =>
			readCompletedRecordingManifest(
				JSON.stringify({ ...manifest, is_complete: false }),
			),
		).toThrow();
		expect(getSegmentPlaybackState({ ...manifest, is_complete: false })).toBe(
			"uploading",
		);
	});
	it.each([{ indices: [2] }, { indices: [1, 3] }, { indices: [1, 1] }])(
		"rejects missing, repeated or unordered completed indices %j",
		({ indices }) => {
			expect(() =>
				readCompletedRecordingManifest(
					JSON.stringify({ ...manifest, video_segments: indices }),
				),
			).toThrow();
		},
	);
	it("includes only the contiguous early prefix, not a later uploaded index", () => {
		expect(
			getEarlySegmentTracks({
				...manifest,
				is_complete: false,
				audio_init_uploaded: true,
				audio_segments: [1],
				video_segments: [1, 3],
			}),
		).toEqual({
			video: [{ index: 1, duration: 3 }],
			audio: [{ index: 1, duration: 3 }],
		});
	});
	it("waits for audio intent to become observable in early manifests", () => {
		expect(
			getEarlySegmentTracks({ ...manifest, is_complete: false }),
		).toBeNull();
	});
	it("characterizes VOD generation as formatting, not a publication validator", () => {
		const playlist = generateM3U8Playlist([
			{
				url: "https://storage.example/abandoned.tmp?token=fixture",
				duration: "3",
			},
		]);
		expect(playlist).toContain("abandoned.tmp?token=fixture");
		expect(playlist).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
		expect(playlist).toContain("#EXT-X-ENDLIST");
	});
	it("characterizes the existing hardcoded CDN host substitution", () => {
		expect(
			generateM3U8Playlist([
				{
					url: "https://capso.s3.us-east-1.amazonaws.com/video/one.ts",
					duration: "3",
				},
			]),
		).toContain("https://v.cap.so/video/one.ts");
	});
});
