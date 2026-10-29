export const PRIVATE_RESOURCE_HEADERS = {
	"Cache-Control": "private, no-store",
	"CDN-Cache-Control": "no-store",
	"Vercel-CDN-Cache-Control": "no-store",
	Pragma: "no-cache",
	Expires: "0",
} as const;

export function privateResourceResponse(response: Response, head = false) {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(PRIVATE_RESOURCE_HEADERS))
		headers.set(name, value);
	return new Response(head ? null : response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
