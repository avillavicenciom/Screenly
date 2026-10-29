import { Organisation, User, Video } from "@cap/web-domain";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ where: vi.fn(), limit: vi.fn() }));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({ innerJoin: () => ({ where: mocks.where }) }),
		}),
	}),
}));

import { authorizeTranscriptionExtraction } from "@/lib/transcription-media-authorization";

const video = {
	id: Video.VideoId.make("video"),
	ownerId: User.UserId.make("owner"),
	orgId: Organisation.OrganisationId.make("org"),
	source: { type: "webMP4" as const },
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.where.mockReturnValue({ limit: mocks.limit });
	mocks.limit.mockResolvedValue([{ source: video.source }]);
});

describe("transcription authority before issue or renewal", () => {
	it("requires the current owner, organization, processing state and non-deleted organization", async () => {
		await authorizeTranscriptionExtraction(video);
		const query = new MySqlDialect().sqlToQuery(mocks.where.mock.calls[0]?.[0]);
		expect(query.sql).toContain("`videos`.`transcriptionStatus`");
		expect(query.sql).toContain("`organizations`.`tombstoneAt` is null");
		expect(query.params).toEqual(["video", "owner", "org", "PROCESSING"]);
	});
	it.each([{ rows: [] }, { rows: [{ source: { type: "desktopMP4" } }] }])(
		"rejects a missing, stopped or changed source %j",
		async ({ rows }) => {
			mocks.limit.mockResolvedValue(rows);
			await expect(authorizeTranscriptionExtraction(video)).rejects.toThrow(
				"no longer authorized",
			);
		},
	);
	it("fails closed when authority cannot be loaded", async () => {
		mocks.limit.mockRejectedValue(new Error("Database unavailable"));
		await expect(authorizeTranscriptionExtraction(video)).rejects.toThrow(
			"Database unavailable",
		);
	});
});
