import { randomUUID } from "node:crypto";
import { serverEnv } from "@cap/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractAudioViaMediaServer } from "@/lib/media-client";
import { verifyMediaCapability } from "../../../media-server/src/lib/media-capability";

vi.mock("@cap/env", () => ({ serverEnv: vi.fn() }));
const secret = "p".repeat(32);
const job = {
	jobId: "transcribe:video",
	attemptId: randomUUID(),
	videoId: "video",
	ownerId: "owner",
};
const videoUrl = "https://storage.test/owner/video/result.mp4";
const fetchMock = vi.fn();
const authorize = vi.fn();
const audio = () => new Response(new Uint8Array([1, 2, 3]));

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", fetchMock);
	vi.mocked(serverEnv).mockReturnValue({
		MEDIA_SERVER_URL: "https://media.test",
		MEDIA_SERVER_WEBHOOK_SECRET: "legacy-test",
		MEDIA_INTERNAL_CAPABILITY_SECRET: secret,
	} as ReturnType<typeof serverEnv>);
	authorize.mockResolvedValue(undefined);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("processing-only extraction client", () => {
	it("sends a scoped capability, no broad secret, and refuses redirects", async () => {
		fetchMock.mockResolvedValue(audio());
		expect(
			await extractAudioViaMediaServer(videoUrl, { job, authorize }),
		).toEqual(Buffer.from([1, 2, 3]));
		const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://media.test/audio/extract");
		expect(options.redirect).toBe("error");
		const headers = new Headers(options.headers);
		expect(headers.has("x-media-server-secret")).toBe(false);
		expect(
			verifyMediaCapability(
				headers.get("x-screenly-media-capability") ?? "",
				secret,
				{ job, videoUrl, method: "POST", path: "/audio/extract" },
			),
		).not.toBeNull();
		expect(JSON.parse(String(options.body))).toMatchObject({
			job,
			videoUrl,
			stream: true,
		});
	});
	it("checks current authority before any network request", async () => {
		authorize.mockRejectedValue(new Error("Job canceled"));
		await expect(
			extractAudioViaMediaServer(videoUrl, { job, authorize }),
		).rejects.toThrow("Job canceled");
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("does not retry a rejected capability or fall back to the legacy secret", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
		);
		await expect(
			extractAudioViaMediaServer(videoUrl, { job, authorize }),
		).rejects.toThrow("Unauthorized");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("renews after retryable failure only after checking authority again", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
		const tokens: string[] = [];
		fetchMock
			.mockImplementationOnce((_url: string, options: RequestInit) => {
				tokens.push(
					new Headers(options.headers).get("x-screenly-media-capability") ?? "",
				);
				vi.setSystemTime(Date.now() + 300_001);
				return Promise.resolve(new Response("busy", { status: 503 }));
			})
			.mockImplementationOnce((_url: string, options: RequestInit) => {
				tokens.push(
					new Headers(options.headers).get("x-screenly-media-capability") ?? "",
				);
				return Promise.resolve(audio());
			});
		const result = extractAudioViaMediaServer(videoUrl, { job, authorize });
		await vi.runAllTimersAsync();
		await expect(result).resolves.toEqual(Buffer.from([1, 2, 3]));
		expect(authorize).toHaveBeenCalledTimes(2);
		const expected = { job, videoUrl, method: "POST", path: "/audio/extract" };
		expect(verifyMediaCapability(tokens[0] ?? "", secret, expected)).toBeNull();
		expect(
			verifyMediaCapability(tokens[1] ?? "", secret, expected),
		).not.toBeNull();
	});
	it("does not renew a canceled job on retry", async () => {
		vi.useFakeTimers();
		authorize
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("Job canceled"));
		fetchMock.mockResolvedValue(new Response("busy", { status: 503 }));
		const assertion = expect(
			extractAudioViaMediaServer(videoUrl, { job, authorize }),
		).rejects.toThrow("Job canceled");
		await vi.runAllTimersAsync();
		await assertion;
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
