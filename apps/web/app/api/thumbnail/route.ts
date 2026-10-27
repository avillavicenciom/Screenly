import { derivativeResponse } from "@/lib/viewer-derivatives";
import { viewerMediaApi } from "@/lib/viewer-media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handler = viewerMediaApi("/api/thumbnail", (request) =>
	derivativeResponse(request, "thumbnail-json"),
);
export const GET = (request: Request) => handler(request);
export const HEAD = (request: Request) => handler(request);
