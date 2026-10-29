import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	lockedRows: vi.fn(),
	insert: vi.fn(),
	update: vi.fn(),
	listObjects: vi.fn(),
	copyObject: vi.fn(),
	syncNames: vi.fn(),
}));

vi.mock("@cap/database", () => {
	const tx = {
		select: () => ({
			from: () => ({
				where: () => ({ limit: () => ({ for: mocks.lockedRows }) }),
			}),
		}),
		insert: () => ({ values: mocks.insert }),
		update: () => ({ set: () => ({ where: mocks.update }) }),
	};
	return {
		db: () => ({
			transaction: (run: (client: typeof tx) => unknown) => run(tx),
		}),
	};
});
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{ listObjects: mocks.listObjects, copyObject: mocks.copyObject },
			]),
	},
}));
vi.mock("@cap/web-backend/src/Organisations/index", () => ({
	Organisations: {},
}));
vi.mock("@/actions/organization/domain-utils", () => ({
	addDomain: vi.fn(),
	checkDomainStatus: vi.fn(),
	getDomainResponse: vi.fn(),
}));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: vi.fn(),
}));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: mocks.syncNames,
}));
vi.mock("@/lib/workflow-runtime", async () => ({
	runWorkflowPromise: (await import("effect")).Effect.runPromise,
}));

import { agentCapOperationWorkflow } from "@/workflows/agent-cap-operation";

const snapshot = {
	id: "original",
	ownerId: "owner",
	orgId: "org",
	name: "Shared recording",
	public: true,
	source: { type: "webMP4" },
	bucket: null,
	storageIntegrationId: null,
	duration: 5,
	width: 320,
	height: 180,
	fps: 30,
	metadata: null,
	settings: null,
	transcriptionStatus: null,
	folderId: null,
	isScreenshot: false,
	skipProcessing: false,
};

describe("agent duplicate privacy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.lockedRows.mockResolvedValueOnce([
			{
				kind: "duplicate_cap",
				state: "queued",
				payload: { snapshot, destinationId: "copy" },
			},
		]);
		mocks.listObjects.mockReturnValue(Effect.succeed({ Contents: [] }));
	});

	it("keeps a copy private without changing its public source", async () => {
		mocks.lockedRows.mockResolvedValueOnce([]);
		await agentCapOperationWorkflow({ operationId: "operation" });
		expect(mocks.insert).toHaveBeenCalledWith(
			expect.objectContaining({ id: "copy", ownerId: "owner", public: false }),
		);
		expect(snapshot.public).toBe(true);
		expect(mocks.syncNames).toHaveBeenCalledWith("copy");
	});

	it("does not reset an existing copy's explicit sharing on replay", async () => {
		mocks.lockedRows.mockResolvedValueOnce([{ ownerId: "owner" }]);
		await agentCapOperationWorkflow({ operationId: "operation" });
		expect(mocks.insert).not.toHaveBeenCalled();
	});
});
