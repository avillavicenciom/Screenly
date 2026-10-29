import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	mediaCapabilitySchema,
	validMediaCapabilityTime,
} from "../../../media-server/src/lib/media-capability-contract";

const claims = {
	version: 1,
	issuer: "screenly-web",
	audience: "screenly-media-server",
	purpose: "processing",
	operation: "audio.extract",
	method: "POST",
	path: "/audio/extract",
	jobId: "transcribe:video",
	attemptId: randomUUID(),
	videoId: "video",
	ownerId: "owner",
	inputSha256: "a".repeat(64),
	jti: randomUUID(),
	issuedAt: 1000,
	expiresAt: 2000,
};

describe("processing capability contract", () => {
	it("accepts only the defined extraction resource", () => {
		expect(mediaCapabilitySchema.safeParse(claims).success).toBe(true);
	});
	it.each([
		{ purpose: "viewer" },
		{ purpose: "upload" },
		{ purpose: "administrative" },
		{ audience: "screenly-browser" },
		{ method: "GET" },
		{ path: "/video/process" },
		{ operation: "storage.list" },
		{ attemptId: "unknown" },
		{ jobId: "" },
		{ inputSha256: "not-a-digest" },
		{ extra: true },
	])("rejects an incompatible contract: %j", (change) => {
		expect(
			mediaCapabilitySchema.safeParse({ ...claims, ...change }).success,
		).toBe(false);
	});
	it.each([999, 2000, 2001])(
		"denies outside the admission lifetime at %i",
		(now) => {
			expect(
				validMediaCapabilityTime(mediaCapabilitySchema.parse(claims), now),
			).toBe(false);
		},
	);
	it("allows admission before expiry without granting stream renewal", () => {
		expect(
			validMediaCapabilityTime(mediaCapabilitySchema.parse(claims), 1500),
		).toBe(true);
		expect(
			validMediaCapabilityTime(
				mediaCapabilitySchema.parse({ ...claims, expiresAt: 400_000 }),
				1500,
			),
		).toBe(false);
	});
});
