export function privateResourceResponse(response: Response, head = false) {
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "private, no-store");
	headers.set("CDN-Cache-Control", "no-store");
	headers.set("Vercel-CDN-Cache-Control", "no-store");
	headers.set("Pragma", "no-cache");
	headers.set("Expires", "0");
	return new Response(head ? null : response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
