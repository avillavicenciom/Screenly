import { isDeepStrictEqual } from "node:util";
import { db } from "@cap/database";
import { organizations, videos } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";

export async function authorizeTranscriptionExtraction(
	video: Pick<
		typeof videos.$inferSelect,
		"id" | "ownerId" | "orgId" | "source"
	>,
) {
	const [current] = await db()
		.select({ source: videos.source })
		.from(videos)
		.innerJoin(organizations, eq(videos.orgId, organizations.id))
		.where(
			and(
				eq(videos.id, video.id),
				eq(videos.ownerId, video.ownerId),
				eq(videos.orgId, video.orgId),
				eq(videos.transcriptionStatus, "PROCESSING"),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);
	if (!current || !isDeepStrictEqual(current.source, video.source)) {
		throw new Error("Transcription extraction is no longer authorized");
	}
}
