/**
 * Fire-and-forget a pub/sub `subscribe(...)` without leaving an unhandled rejection behind.
 *
 * A subscriber duplicated from a connection queues its `subscribe` until the socket is ready. If the
 * owner closes first, `disconnect()` makes ioredis reject that queued command with
 * "Connection is closed." — which, with a bare `void`, surfaces as `unhandledRejection` and can crash
 * the process during shutdown. Once closing has begun the rejection is expected and ignored; before
 * that it is a real failure and is logged (never thrown: a failed subscribe must not take the app down).
 */
export function swallowSubscribe(result: unknown, isClosing: () => boolean, label: string): void {
  if (!result || typeof (result as PromiseLike<unknown>).then !== 'function') return;
  Promise.resolve(result).catch((error: unknown) => {
    if (isClosing()) return;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[adonis-durable] ${label} subscribe failed: ${message}`);
  });
}
