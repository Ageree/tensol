// T076 — Tests for createPoller (plain, testable polling primitive).
// Constitution V: polling, not SSE. Default cadence 3000ms.
//
// We test the plain `createPoller` function (no React) to avoid pulling in
// @testing-library/react. The `usePolling` hook is a thin wrapper.

import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { createPoller } from "./poll.ts";

// Small helper: wait for queued microtasks to drain.
async function flush(): Promise<void> {
  // 4 microtask cycles is plenty for our await chains.
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

// Bun lacks fake timers natively, so we patch setTimeout/clearTimeout on
// globalThis with a controllable scheduler. This gives us deterministic
// time advancement without flaky real-clock waits.

interface ScheduledTask {
  id: number;
  runAt: number;
  fn: () => void;
}

interface FakeClock {
  now: number;
  nextId: number;
  tasks: ScheduledTask[];
  origSetTimeout: typeof setTimeout;
  origClearTimeout: typeof clearTimeout;
}

let clock: FakeClock | null = null;

function installFakeTimers(): void {
  if (clock) return;
  const orig = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  clock = {
    now: 0,
    nextId: 1,
    tasks: [],
    origSetTimeout: orig.setTimeout,
    origClearTimeout: orig.clearTimeout,
  };
  // @ts-expect-error — overriding global for tests
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const id = clock!.nextId++;
    clock!.tasks.push({ id, runAt: clock!.now + ms, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  });
  // @ts-expect-error — overriding global for tests
  globalThis.clearTimeout = ((id: number) => {
    if (!clock) return;
    clock.tasks = clock.tasks.filter((t) => t.id !== id);
  });
}

function restoreTimers(): void {
  if (!clock) return;
  globalThis.setTimeout = clock.origSetTimeout;
  globalThis.clearTimeout = clock.origClearTimeout;
  clock = null;
}

async function advance(ms: number): Promise<void> {
  if (!clock) throw new Error("fake timers not installed");
  const target = clock.now + ms;
  // Run tasks in order of runAt, allowing microtasks to drain between.
  // Allow each tick's async work (fetcher promise) to fully resolve.
  while (true) {
    const due = clock.tasks
      .filter((t) => t.runAt <= target)
      .sort((a, b) => a.runAt - b.runAt);
    if (due.length === 0) break;
    const next = due[0]!;
    clock.now = next.runAt;
    clock.tasks = clock.tasks.filter((t) => t.id !== next.id);
    next.fn();
    await flush();
  }
  clock.now = target;
}

beforeEach(() => {
  installFakeTimers();
});

afterEach(() => {
  restoreTimers();
});

describe("createPoller", () => {
  test("immediate fetch on start: fetcher called once", async () => {
    const fetcher = mock(() => Promise.resolve("ok"));
    const poller = createPoller(fetcher, { intervalMs: 1000 });

    poller.start();
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  test("interval scheduling: fetcher called again after intervalMs", async () => {
    const fetcher = mock(() => Promise.resolve("ok"));
    const poller = createPoller(fetcher, { intervalMs: 1000 });

    poller.start();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advance(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await advance(1000);
    expect(fetcher).toHaveBeenCalledTimes(3);

    poller.stop();
  });

  test("stopWhen short-circuits: predicate true → no more calls", async () => {
    let callCount = 0;
    const fetcher = mock(() => {
      callCount += 1;
      return Promise.resolve(callCount);
    });
    const poller = createPoller(fetcher, {
      intervalMs: 500,
      stopWhen: (r) => r >= 2,
    });

    poller.start();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advance(500);
    // 2nd call returns 2 → stopWhen true → poller stops.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(poller.isRunning()).toBe(false);

    await advance(2000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("stop() clears interval: no further calls", async () => {
    const fetcher = mock(() => Promise.resolve("ok"));
    const poller = createPoller(fetcher, { intervalMs: 1000 });

    poller.start();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    poller.stop();
    expect(poller.isRunning()).toBe(false);

    await advance(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("error handling: fetcher rejects → onError called, polling continues", async () => {
    let attempt = 0;
    const fetcher = mock(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve("ok");
    });
    const errors: unknown[] = [];
    const poller = createPoller(fetcher, {
      intervalMs: 1000,
      onError: (e) => errors.push(e),
    });

    poller.start();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
    expect(poller.isRunning()).toBe(true);

    await advance(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);

    poller.stop();
  });

  test("refetch: manual trigger fires immediately", async () => {
    const fetcher = mock(() => Promise.resolve("ok"));
    const poller = createPoller(fetcher, { intervalMs: 10000 });

    poller.start();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await poller.refetch();
    expect(fetcher).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  test("serialization: refetch while in-flight doesn't double-fetch", async () => {
    let resolveFirst: ((v: string) => void) | null = null;
    let callCount = 0;
    const fetcher = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<string>((res) => {
          resolveFirst = res;
        });
      }
      return Promise.resolve("ok");
    });

    const poller = createPoller(fetcher, { intervalMs: 10000 });
    poller.start();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // While first call is in-flight, fire refetch — should be coalesced.
    const refetchPromise = poller.refetch();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Resolve the in-flight call.
    resolveFirst!("first");
    await refetchPromise;
    await flush();

    // No phantom extra calls after resolution.
    expect(fetcher).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  test("start() is idempotent: multiple calls do not stack intervals", async () => {
    const fetcher = mock(() => Promise.resolve("ok"));
    const poller = createPoller(fetcher, { intervalMs: 1000 });

    poller.start();
    poller.start();
    poller.start();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advance(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  test("default interval is 3000ms (Constitution V cadence)", async () => {
    const fetcher = mock(() => Promise.resolve("ok"));
    const poller = createPoller(fetcher);

    poller.start();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advance(2999);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  test("onResult fires for each successful fetch", async () => {
    const results: string[] = [];
    let n = 0;
    const fetcher = mock(() => {
      n += 1;
      return Promise.resolve(`r${n}`);
    });
    const poller = createPoller(fetcher, {
      intervalMs: 500,
      onResult: (r) => results.push(r),
    });

    poller.start();
    await flush();
    await advance(500);
    await advance(500);

    expect(results).toEqual(["r1", "r2", "r3"]);
    poller.stop();
  });
});
