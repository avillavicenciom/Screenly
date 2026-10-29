import {
	BucketAlreadyOwnedByYou,
	CreateBucketCommand,
	PutBucketPolicyCommand,
} from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	dockerBuild: "true" as string | undefined,
	migrate: vi.fn(async () => {}),
	send: vi.fn(async (_command: unknown) => ({})),
	client: vi.fn(),
	serverEnv: vi.fn(() => ({
		S3_INTERNAL_ENDPOINT: "https://storage.fixture.invalid",
		CAP_AWS_REGION: "fixture-region",
		CAP_AWS_ACCESS_KEY: "fixture-access",
		CAP_AWS_SECRET_KEY: "fixture-secret",
		CAP_AWS_BUCKET: "fixture-bucket",
		S3_PATH_STYLE: true,
	})),
}));

vi.mock("@aws-sdk/client-s3", () => ({
	BucketAlreadyOwnedByYou: class extends Error {
		constructor(options: { message: string }) {
			super(options.message);
		}
	},
	CreateBucketCommand: class {
		constructor(readonly input: unknown) {}
	},
	PutBucketPolicyCommand: class {
		constructor(readonly input: unknown) {}
	},
	S3Client: class {
		constructor(options: unknown) {
			state.client(options);
		}
		send = state.send;
	},
}));
vi.mock("@cap/database/migrate", () => ({ migrateDb: state.migrate }));
vi.mock("@cap/env", () => ({
	serverEnv: state.serverEnv,
	buildEnv: {
		get NEXT_PUBLIC_DOCKER_BUILD() {
			return state.dockerBuild;
		},
	},
}));

import { register } from "../../instrumentation.node";

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("NEXT_PUBLIC_IS_CAP", "");
	vi.clearAllMocks();
	state.dockerBuild = "true";
	state.send.mockResolvedValue({});
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process, "exit").mockImplementation(() => {
		throw new Error("fixture stopped process exit");
	});
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("current self-host bootstrap side effects (characterization)", () => {
	it("schedules migrations and anonymous bucket read policy after startup", async () => {
		await register();
		expect(state.migrate).not.toHaveBeenCalled();
		expect(state.send).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(4999);
		expect(state.migrate).not.toHaveBeenCalled();
		expect(state.send).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(state.migrate).toHaveBeenCalledOnce();
		expect(state.client).toHaveBeenCalledWith(
			expect.objectContaining({
				endpoint: "https://storage.fixture.invalid",
				region: "fixture-region",
				forcePathStyle: true,
			}),
		);
		expect(state.send).toHaveBeenCalledTimes(2);
		expect(state.send.mock.calls[0]?.[0]).toBeInstanceOf(CreateBucketCommand);
		expect(state.send.mock.calls[0]?.[0]).toMatchObject({
			input: { Bucket: "fixture-bucket" },
		});
		const policy = state.send.mock.calls[1]?.[0];
		expect(policy).toBeInstanceOf(PutBucketPolicyCommand);
		if (!(policy instanceof PutBucketPolicyCommand))
			throw new Error("Missing policy command fixture");
		expect(policy.input.Bucket).toBe("fixture-bucket");
		expect(JSON.parse(policy.input.Policy ?? "null")).toEqual({
			Version: "2012-10-17",
			Statement: [
				{
					Effect: "Allow",
					Principal: "*",
					Action: ["s3:GetObject"],
					Resource: ["arn:aws:s3:::fixture-bucket/*"],
				},
			],
		});
		expect(process.exit).not.toHaveBeenCalled();
	});
	it("still creates a bucket outside Docker while skipping migrations", async () => {
		state.dockerBuild = "false";
		await register();
		await vi.advanceTimersByTimeAsync(5000);
		expect(state.migrate).not.toHaveBeenCalled();
		expect(state.send).toHaveBeenCalledTimes(2);
		expect(state.send.mock.calls[0]?.[0]).toBeInstanceOf(CreateBucketCommand);
		expect(state.send.mock.calls[1]?.[0]).toBeInstanceOf(
			PutBucketPolicyCommand,
		);
	});
	it("treats the textual hosted-brand value false as a truthy startup guard", async () => {
		vi.stubEnv("NEXT_PUBLIC_IS_CAP", "false");
		await register();
		await vi.advanceTimersByTimeAsync(5000);
		expect(state.serverEnv).not.toHaveBeenCalled();
		expect(state.migrate).not.toHaveBeenCalled();
		expect(state.client).not.toHaveBeenCalled();
		expect(state.send).not.toHaveBeenCalled();
	});
	it("does not write a policy when creation reports an already owned bucket", async () => {
		state.send.mockRejectedValueOnce(
			new BucketAlreadyOwnedByYou({
				message: "fixture already owned",
				$metadata: {},
			}),
		);
		await register();
		await vi.advanceTimersByTimeAsync(5000);
		expect(state.migrate).toHaveBeenCalledOnce();
		expect(state.send).toHaveBeenCalledOnce();
		expect(state.send.mock.calls[0]?.[0]).toBeInstanceOf(CreateBucketCommand);
		expect(process.exit).not.toHaveBeenCalled();
	});
	it("attempts to exit before scheduling work when environment validation fails", async () => {
		state.serverEnv.mockImplementationOnce(() => {
			throw new Error("fixture invalid environment");
		});
		await expect(register()).rejects.toThrow("fixture stopped process exit");
		expect(process.exit).toHaveBeenCalledWith(1);
		expect(vi.getTimerCount()).toBe(0);
		expect(state.migrate).not.toHaveBeenCalled();
		expect(state.client).not.toHaveBeenCalled();
		expect(state.send).not.toHaveBeenCalled();
	});
});
