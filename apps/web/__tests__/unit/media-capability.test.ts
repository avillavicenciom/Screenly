import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	createMediaCapability,
	verifyMediaCapability,
} from "../../../media-server/src/lib/media-capability";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ NEXTAUTH_SECRET: "n".repeat(32) }),
}));

import {
	createStorageObjectToken,
	verifyStorageObjectToken,
} from "@cap/web-backend/src/Storage/SignedObject";

const secret = "p".repeat(32);
const job = {
	jobId: "transcribe:video",
	attemptId: randomUUID(),
	videoId: "video",
	ownerId: "owner",
};
const videoUrl =
	"https://storage.test/owner/video/result.mp4?signature=fixture";
const expected = { job, videoUrl, method: "POST", path: "/audio/extract" };
const now = 1_000_000;
const token = () => createMediaCapability(job, videoUrl, secret, now);

describe("isolated processing capability signatures", () => {
	it("authenticates a bounded extraction without exposing the input URL", () => {
		const encoded = token();
		expect(verifyMediaCapability(encoded, secret, expected, now)?.videoId).toBe(
			"video",
		);
		expect(
			Buffer.from(encoded.split(".")[1] ?? "", "base64url").toString(),
		).not.toContain(videoUrl);
	});
	it.each([
		{ method: "GET" },
		{ path: "/video/process" },
		{ videoUrl: "https://storage.test/other.mp4" },
		{ job: { ...job, jobId: "other" } },
		{ job: { ...job, attemptId: randomUUID() } },
		{ job: { ...job, videoId: "other" } },
		{ job: { ...job, ownerId: "other" } },
	])("rejects changed binding %j", (change) => {
		expect(
			verifyMediaCapability(token(), secret, { ...expected, ...change }, now),
		).toBeNull();
	});
	it.each([now - 1, now + 300_000, now + 300_001])(
		"rejects outside the admission window %i",
		(time) => {
			expect(verifyMediaCapability(token(), secret, expected, time)).toBeNull();
		},
	);
	it("rejects weak or different keys and malformed tokens", () => {
		expect(() => createMediaCapability(job, videoUrl, "short")).toThrow();
		for (const encoded of [
			"",
			`${token()}.extra`,
			`${token()}changed`,
			"x".repeat(9000),
		]) {
			expect(verifyMediaCapability(encoded, secret, expected, now)).toBeNull();
		}
		expect(
			verifyMediaCapability(token(), "q".repeat(32), expected, now),
		).toBeNull();
	});
	it("does not interchange viewer and processing capabilities even with the same key", () => {
		const sharedKey = "n".repeat(32);
		const viewer = createStorageObjectToken({
			videoId: "video",
			key: "owner/video/result.mp4",
		});
		expect(verifyMediaCapability(viewer, sharedKey, expected, now)).toBeNull();
		expect(
			verifyStorageObjectToken(createMediaCapability(job, videoUrl, sharedKey)),
		).toBeNull();
	});
});
