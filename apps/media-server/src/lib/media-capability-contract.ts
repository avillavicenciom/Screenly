import { z } from "zod";

export type MediaPrincipal =
	| { kind: "viewer"; userId: string }
	| { kind: "owner"; userId: string }
	| { kind: "member"; userId: string; organizationId: string }
	| { kind: "processing"; jobId: string; attemptId: string }
	| { kind: "upload"; userId: string; uploadId: string }
	| { kind: "administrative"; userId: string };

const identifier = z
	.string()
	.min(1)
	.max(255)
	.regex(/^[A-Za-z0-9:_-]+$/);

export const mediaJobSchema = z
	.object({
		jobId: identifier,
		attemptId: z.string().uuid(),
		videoId: identifier,
		ownerId: identifier,
	})
	.strict();

export type MediaJob = z.infer<typeof mediaJobSchema>;

export const mediaCapabilitySchema = mediaJobSchema
	.extend({
		version: z.literal(1),
		issuer: z.literal("screenly-web"),
		audience: z.literal("screenly-media-server"),
		purpose: z.literal("processing"),
		operation: z.literal("audio.extract"),
		method: z.literal("POST"),
		path: z.literal("/audio/extract"),
		inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
		jti: z.string().uuid(),
		issuedAt: z.number().int().safe().nonnegative(),
		expiresAt: z.number().int().safe().nonnegative(),
	})
	.strict();

export type MediaCapability = z.infer<typeof mediaCapabilitySchema>;

export const MEDIA_CAPABILITY_MAX_TTL_MS = 5 * 60_000;

export function validMediaCapabilityTime(claims: MediaCapability, now: number) {
	return (
		claims.issuedAt <= now &&
		claims.expiresAt > now &&
		claims.expiresAt > claims.issuedAt &&
		claims.expiresAt - claims.issuedAt <= MEDIA_CAPABILITY_MAX_TTL_MS
	);
}
