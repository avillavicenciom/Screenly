export const mp4PlaybackUrl = (videoId: string) =>
	`/api/playback/mp4?videoId=${encodeURIComponent(videoId)}`;

export function playbackRange(value: string | null, size: number) {
	if (!value) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(value);
	if (!match || (!match[1] && !match[2]) || size === 0) return false;
	const first = match[1] ? Number(match[1]) : undefined;
	const last = match[2] ? Number(match[2]) : undefined;
	if (
		(first !== undefined && !Number.isSafeInteger(first)) ||
		(last !== undefined && !Number.isSafeInteger(last))
	)
		return false;
	const start = first ?? Math.max(0, size - (last ?? 0));
	const end =
		first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1);
	if (start >= size || end < start || (first === undefined && last === 0))
		return false;
	return {
		start,
		end,
		header: `bytes=${start}-${end}`,
		length: end - start + 1,
	};
}

export function playbackStream(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
) {
	const reader = body.getReader();
	let stopped = false;
	let abort = () => {};
	const clean = () => signal.removeEventListener("abort", abort);
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				abort = () => {
					if (stopped) return;
					stopped = true;
					clean();
					void reader.cancel().catch(() => {});
					controller.error(new DOMException("Playback aborted", "AbortError"));
				};
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
			},
			async pull(controller) {
				if (stopped) return;
				try {
					const next = await reader.read();
					if (stopped) return;
					if (next.done) {
						stopped = true;
						clean();
						controller.close();
					} else controller.enqueue(next.value);
				} catch {
					if (!stopped) {
						stopped = true;
						clean();
						controller.error(new Error("Playback unavailable"));
					}
				}
			},
			cancel() {
				stopped = true;
				clean();
				return reader.cancel();
			},
		},
		{ highWaterMark: 0 },
	);
}
