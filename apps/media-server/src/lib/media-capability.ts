import {
	createHash,
	createHmac,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import {
	type MediaJob,
	mediaCapabilitySchema,
	mediaJobSchema,
	validMediaCapabilityTime,
} from "./media-capability-contract";

const PREFIX = "screenly-processing-v1";
const MAX_TOKEN_LENGTH = 8192;

export function mediaInputDigest(videoUrl: string) {
	return createHash("sha256").update(videoUrl).digest("hex");
}

function signature(payload: string, secret: string) {
	if (Buffer.byteLength(secret) < 32)
		throw new Error("Processing capability key must have at least 32 bytes");
	return createHmac("sha256", secret).update(`${PREFIX}.${payload}`).digest();
}

export function createMediaCapability(
	job: MediaJob,
	videoUrl: string,
	secret: string,
	now = Date.now(),
) {
	const claims = mediaCapabilitySchema.parse({
		...mediaJobSchema.parse(job),
		version: 1,
		issuer: "screenly-web",
		audience: "screenly-media-server",
		purpose: "processing",
		operation: "audio.extract",
		method: "POST",
		path: "/audio/extract",
		inputSha256: mediaInputDigest(videoUrl),
		jti: randomUUID(),
		issuedAt: now,
		expiresAt: now + 300_000,
	});
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${PREFIX}.${payload}.${signature(payload, secret).toString("base64url")}`;
}

export function verifyMediaCapability(
	token: string,
	secret: string,
	expected: { job: MediaJob; videoUrl: string; method: string; path: string },
	now = Date.now(),
) {
	if (!secret || token.length > MAX_TOKEN_LENGTH) return null;
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== PREFIX) return null;
	const [, payload, signed] = parts;
	if (
		!payload ||
		!signed ||
		!/^[A-Za-z0-9_-]+$/.test(payload) ||
		!/^[A-Za-z0-9_-]{43}$/.test(signed)
	)
		return null;
	try {
		const supplied = Buffer.from(signed, "base64url");
		const canonical = Buffer.from(payload, "base64url");
		if (
			supplied.toString("base64url") !== signed ||
			canonical.toString("base64url") !== payload ||
			!timingSafeEqual(supplied, signature(payload, secret))
		)
			return null;
		const parsed = mediaCapabilitySchema.safeParse(
			JSON.parse(canonical.toString("utf8")),
		);
		const job = mediaJobSchema.safeParse(expected.job);
		if (!parsed.success || !job.success) return null;
		const claims = parsed.data;
		if (
			!validMediaCapabilityTime(claims, now) ||
			claims.method !== expected.method ||
			claims.path !== expected.path ||
			claims.inputSha256 !== mediaInputDigest(expected.videoUrl)
		)
			return null;
		if (
			claims.jobId !== job.data.jobId ||
			claims.attemptId !== job.data.attemptId ||
			claims.videoId !== job.data.videoId ||
			claims.ownerId !== job.data.ownerId
		)
			return null;
		return claims;
	} catch {
		return null;
	}
}
