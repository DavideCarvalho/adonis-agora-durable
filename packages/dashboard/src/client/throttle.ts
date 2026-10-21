/** A throttled call: {@link Throttled.call} requests it, {@link Throttled.cancel} drops a pending one. */
export interface Throttled {
  call(): void;
  cancel(): void;
}

/**
 * Run `fn` at most once per `ms`. A call outside the window runs at once; calls inside it collapse
 * into one trailing run at the window's end, so the last request is never lost.
 */
export function throttle(fn: () => void, ms: number, now: () => number = Date.now): Throttled {
  let lastRun = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    timer = undefined;
    lastRun = now();
    fn();
  };
  return {
    call() {
      if (timer !== undefined) return;
      const wait = lastRun + ms - now();
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
