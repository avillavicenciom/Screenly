import { derivativeResponse } from "@/lib/viewer-derivatives";
import { viewerMediaApi } from "@/lib/viewer-media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;
const handler = viewerMediaApi("/api/video/preview", (request) =>
	derivativeResponse(request, "preview"),
);
export const GET = (request: Request) => handler(request);
export const HEAD = (request: Request) => handler(request);
