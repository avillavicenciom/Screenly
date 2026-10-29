import { Readable } from "node:stream";
import * as S3 from "@aws-sdk/client-s3";
import { createS3BucketAccess } from "@cap/web-backend/src/S3Buckets/S3BucketAccess";
import { S3BucketClientProvider } from "@cap/web-backend/src/S3Buckets/S3BucketClientProvider";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

describe("S3 playback origin streaming", () => {
	it.each([false, true])(
		"reads internally without signing; range=%s",
		async (partial) => {
			const client = new S3.S3Client({
				region: "us-east-1",
				credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
			});
			const source = Readable.from([Buffer.from(partial ? "23" : "0123")]);
			const body = Object.assign(source, {
				transformToWebStream: () => Readable.toWeb(source),
				transformToByteArray: vi.fn(),
				transformToString: vi.fn(),
			});
			const send = vi.spyOn(client, "send").mockImplementation(async () => ({
				Body: body,
				ContentLength: partial ? 2 : 4,
				ContentRange: partial ? "bytes 2-3/4" : undefined,
				ETag: '"v1"',
				$metadata: { httpStatusCode: partial ? 206 : 200 },
			}));
			try {
				const access = await Effect.runPromise(
					createS3BucketAccess.pipe(
						Effect.provideService(S3BucketClientProvider, {
							bucket: "private-bucket",
							isPathStyle: true,
							getInternal: Effect.succeed(client),
							getPublic: Effect.die("Public signer must not be used"),
						}),
					),
				);
				const controller = new AbortController();
				const response = await Effect.runPromise(
					access.getPlaybackObjectResponse(
						"owner/video/result.mp4",
						partial ? "bytes=2-3" : null,
						{ signal: controller.signal, ifMatch: '"v1"' },
					),
				);
				const [command, options] = send.mock.calls[0] ?? [];
				expect(command).toBeInstanceOf(S3.GetObjectCommand);
				expect(command?.input).toMatchObject({
					Bucket: "private-bucket",
					Key: "owner/video/result.mp4",
					IfMatch: '"v1"',
					Range: partial ? "bytes=2-3" : undefined,
				});
				expect(options).toMatchObject({ abortSignal: controller.signal });
				expect(response.status).toBe(partial ? 206 : 200);
				expect(await response.text()).toBe(partial ? "23" : "0123");
				expect(body.transformToByteArray).not.toHaveBeenCalled();
				expect(body.transformToString).not.toHaveBeenCalled();
			} finally {
				client.destroy();
			}
		},
	);
	it("cancels the origin stream when the downstream reader cancels", async () => {
		const client = new S3.S3Client({ region: "us-east-1" });
		const source = new Readable({ read() {} });
		vi.spyOn(client, "send").mockImplementation(async () => ({
			Body: Object.assign(source, {
				transformToWebStream: () => Readable.toWeb(source),
				transformToByteArray: vi.fn(),
				transformToString: vi.fn(),
			}),
			$metadata: { httpStatusCode: 200 },
		}));
		try {
			const access = await Effect.runPromise(
				createS3BucketAccess.pipe(
					Effect.provideService(S3BucketClientProvider, {
						bucket: "private-bucket",
						isPathStyle: true,
						getInternal: Effect.succeed(client),
						getPublic: Effect.succeed(client),
					}),
				),
			);
			const response = await Effect.runPromise(
				access.getPlaybackObjectResponse("owner/video/result.mp4", null, {
					signal: new AbortController().signal,
				}),
			);
			await response.body?.cancel();
			expect(source.destroyed).toBe(true);
		} finally {
			client.destroy();
		}
	});
	it("keeps S3 invalid ranges as 416 without returning XML errors", async () => {
		const client = new S3.S3Client({ region: "us-east-1" });
		vi.spyOn(client, "send").mockRejectedValue(
			new S3.S3ServiceException({
				name: "InvalidRange",
				$fault: "client",
				$metadata: { httpStatusCode: 416 },
			}),
		);
		try {
			const access = await Effect.runPromise(
				createS3BucketAccess.pipe(
					Effect.provideService(S3BucketClientProvider, {
						bucket: "private-bucket",
						isPathStyle: true,
						getInternal: Effect.succeed(client),
						getPublic: Effect.succeed(client),
					}),
				),
			);
			const response = await Effect.runPromise(
				access.getPlaybackObjectResponse(
					"owner/video/result.mp4",
					"bytes=99-100",
					{ signal: new AbortController().signal },
				),
			);
			expect(response.status).toBe(416);
			expect(await response.text()).toBe("");
		} finally {
			client.destroy();
		}
	});
});
