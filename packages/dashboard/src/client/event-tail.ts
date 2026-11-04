import type { EngineEvent } from './durable-client';

/** The most live events a run detail keeps in memory. */
export const EVENT_TAIL_LIMIT = 200;

/** An event the tail kept, with `id`, its position in the stream, to key it by. */
export interface TailedEvent {
  id: number;
  event: EngineEvent;
}

/**
 * The last `limit` engine events a run's live stream delivered while the page was open, oldest
 * first. Nothing is stored: a reload starts empty. Subscribers are told on every push, so only the
 * component drawing the tail re-renders on a busy stream (see `useSyncExternalStore`).
 */
export class EventTail {
  private events: readonly TailedEvent[] = [];
  private pushed = 0;
  private readonly listeners = new Set<() => void>();

  constructor(readonly limit = EVENT_TAIL_LIMIT) {}

  push(event: EngineEvent): void {
    this.pushed += 1;
    const next = [...this.events, { id: this.pushed, event }];
    this.events = next.length > this.limit ? next.slice(next.length - this.limit) : next;
    for (const listener of this.listeners) listener();
  }

  /** The events kept, oldest first. The same array until the next push. */
  snapshot = (): readonly TailedEvent[] => this.events;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
