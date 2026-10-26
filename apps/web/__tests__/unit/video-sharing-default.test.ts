import { getNewVideoPublic } from "@cap/database/video-sharing-default";
import type { Organisation } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => ({
	limit: vi.fn(),
	serverDefaultPublic: true,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: lookup.limit }),
			}),
		}),
	}),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		CAP_VIDEOS_DEFAULT_PUBLIC: lookup.serverDefaultPublic,
	}),
}));

const ORGANIZATION_ID = "org-1" as Organisation.OrganisationId;

describe("new recording visibility", () => {
	beforeEach(() => {
		lookup.limit.mockReset();
		lookup.serverDefaultPublic = true;
	});

	it("starts recordings private even when the legacy server default is public", async () => {
		lookup.limit.mockResolvedValue([
			{ defaultVideoVisibility: null, tombstoneAt: null },
		]);
		expect(await getNewVideoPublic(ORGANIZATION_ID)).toBe(false);

		lookup.serverDefaultPublic = false;
		expect(await getNewVideoPublic(ORGANIZATION_ID)).toBe(false);
	});

	it("starts recordings private after the organization opts in", async () => {
		lookup.limit.mockResolvedValue([
			{ defaultVideoVisibility: "private", tombstoneAt: null },
		]);
		expect(await getNewVideoPublic(ORGANIZATION_ID)).toBe(false);
	});

	it("rejects a deleted organization", async () => {
		lookup.limit.mockResolvedValue([
			{ defaultVideoVisibility: null, tombstoneAt: new Date() },
		]);
		await expect(getNewVideoPublic(ORGANIZATION_ID)).rejects.toThrow(
			"Organization not found",
		);
	});

	it("propagates lookup failures", async () => {
		lookup.limit.mockRejectedValue(new Error("Database unavailable"));
		await expect(getNewVideoPublic(ORGANIZATION_ID)).rejects.toThrow(
			"Database unavailable",
		);
	});

	it("rejects a missing organization", async () => {
		lookup.limit.mockResolvedValue([]);
		await expect(getNewVideoPublic(ORGANIZATION_ID)).rejects.toThrow(
			"Organization not found",
		);
	});
});
