import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { createMediaCapability } from "../../lib/media-capability";

const check = mock(async () => true);
const extract = mock(() => ({
	stream: new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array([1, 2, 3]));
			controller.close();
		},
	}),
	cleanup: () => {},
}));
mock.module("../../lib/media-audio", () => ({
	checkHasAudioTrack: check,
	extractAudioStream: extract,
	extractAudio: mock(),
	canAcceptNewAudioOperation: () => true,
	getActiveAudioOperationCount: () => 0,
}));
const { default: audio } = await import("../../routes/audio");
const app = new Hono().route("/audio", audio);
const secret = "p".repeat(32);
const oldKey = process.env.MEDIA_INTERNAL_CAPABILITY_SECRET;
const oldLegacy = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
const job = {
	jobId: "transcribe:video",
	attemptId: randomUUID(),
	videoId: "video",
	ownerId: "owner",
};
const videoUrl =
	"https://storage.test/owner/video/result.mp4?signature=fixture";
const token = (time?: number) =>
	createMediaCapability(job, videoUrl, secret, time);
const request = (
	capability: string | undefined,
	body: unknown = { videoUrl, job, stream: true },
	legacy = false,
) =>
	app.request("/audio/extract", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(capability !== undefined
				? { "x-screenly-media-capability": capability }
				: {}),
			...(legacy ? { "x-media-server-secret": "legacy-test" } : {}),
		},
		body: JSON.stringify(body),
	});

beforeEach(() => {
	process.env.MEDIA_INTERNAL_CAPABILITY_SECRET = secret;
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = "legacy-test";
	check.mockClear();
	extract.mockClear();
	check.mockResolvedValue(true);
});
afterAll(() => {
	if (oldKey === undefined) delete process.env.MEDIA_INTERNAL_CAPABILITY_SECRET;
	else process.env.MEDIA_INTERNAL_CAPABILITY_SECRET = oldKey;
	if (oldLegacy === undefined) delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = oldLegacy;
});

describe("internal extraction capability admission", () => {
	test("rejects malformed capability requests before touching media", async () => {
		const response = await app.request("/audio/extract", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-screenly-media-capability": token(),
				"x-media-server-secret": "legacy-test",
			},
			body: "{",
		});
		expect(response.status).toBe(401);
		expect(check).not.toHaveBeenCalled();
	});
	test("preserves processing errors without granting another operation", async () => {
		check.mockRejectedValueOnce(new Error("Decoder failed"));
		expect((await request(token())).status).toBe(500);
		expect(extract).not.toHaveBeenCalled();
	});
	test("extracts without a legacy secret or viewer session", async () => {
		const response = await request(token());
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		expect(check).toHaveBeenCalledWith(videoUrl);
		expect(extract).toHaveBeenCalledWith(videoUrl);
	});
	test.each(["", "viewer.token", "invalid"])(
		"never falls back for invalid capability %s",
		async (value) => {
			expect((await request(value, undefined, true)).status).toBe(401);
			expect(check).not.toHaveBeenCalled();
			expect(extract).not.toHaveBeenCalled();
		},
	);
	test.each([
		{ videoUrl: "https://storage.test/other.mp4", job },
		{ videoUrl, job: { ...job, attemptId: randomUUID() } },
		{ videoUrl, job: { ...job, videoId: "other" } },
		{ videoUrl, job: { ...job, jobId: "other" } },
		{ videoUrl },
	])("rejects changed input or job before media access: %j", async (body) => {
		expect((await request(token(), body)).status).toBe(401);
		expect(check).not.toHaveBeenCalled();
		expect(extract).not.toHaveBeenCalled();
	});
	test("rejects expiry and accepts a newly issued capability for the same attempt", async () => {
		expect((await request(token(Date.now() - 300_001))).status).toBe(401);
		expect(check).not.toHaveBeenCalled();
		expect((await request(token())).status).toBe(200);
	});
	test("fails closed on a missing verifier key even with legacy credentials", async () => {
		delete process.env.MEDIA_INTERNAL_CAPABILITY_SECRET;
		expect((await request(token(), undefined, true)).status).toBe(401);
		expect(check).not.toHaveBeenCalled();
	});
	test("retains legacy admission only when no capability is supplied", async () => {
		expect((await request(undefined, undefined, true)).status).toBe(200);
		expect((await request(undefined)).status).toBe(401);
	});
	test("does not authorize other processing operations", async () => {
		const response = await app.request("/audio/check", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-screenly-media-capability": token(),
			},
			body: JSON.stringify({ videoUrl }),
		});
		expect(response.status).toBe(401);
	});
	test("preserves no-audio outcome", async () => {
		check.mockResolvedValue(false);
		expect((await request(token())).status).toBe(422);
		expect(extract).not.toHaveBeenCalled();
	});
});
