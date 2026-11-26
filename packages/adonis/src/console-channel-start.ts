/**
 * When a process starts answering the federated console. The durable provider resolves (and
 * validates) `consoleCommands` at boot, but opens the console channel — Redis subscriptions — only in
 * a process that should answer: the web server (and test processes), once booted, and a worker
 * process when its loop starts (`durable:work`). A one-off ace command that merely boots the
 * providers never subscribes.
 */

const pending = new WeakMap<object, () => Promise<void>>();

/** Register what starts the console channel of `engine`'s app once a worker loop runs it. */
export function startConsoleChannelWithWorker(engine: object, start: () => Promise<void>): void {
  pending.set(engine, start);
}

/** A worker loop started on `engine`: open its console channel, when one is waiting. */
export async function workerStarted(engine: object): Promise<void> {
  const start = pending.get(engine);
  if (!start) return;
  pending.delete(engine);
  await start();
}
