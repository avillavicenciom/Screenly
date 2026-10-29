import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { db } from "./index.ts";
import { organizations } from "./schema.ts";

export async function getNewVideoPublic(
	organizationId: Organisation.OrganisationId,
): Promise<boolean> {
	const [organization] = await db()
		.select({
			tombstoneAt: organizations.tombstoneAt,
		})
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);

	if (!organization || organization.tombstoneAt) {
		throw new Error("Organization not found");
	}

	return false;
}
