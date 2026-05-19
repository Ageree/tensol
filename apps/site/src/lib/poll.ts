// T075 — Generic polling primitive + React hook.
//
// Constitution V (NON-NEGOTIABLE): we MUST poll, NOT use SSE / WebSockets.
// Default cadence is 3000ms — matches the design doc's 3-second target for
// scan status / events / findings UIs in the Blackbox MVP.
//
// Design split:
//   - `createPoller(fetcher, opts)` — plain (no React) testable primitive.
//     Owns the setTimeout schedule, in-flight serialization, stop predicate.
//   - `usePolling(fetcher, opts)` — thin React-hook wrapper that exposes
//     {data, error, loading, isPolling, refetch}. The hook delegates all
//     scheduling to `createPoller` so business logic stays unit-testable.

import { useEffect, useRef, useState } from "react";

// ─── Plain primitive ────────────────────────────────────────────────────────

export interface PollerOpts<T> {
  /** Polling cadence in ms. Default 3000 (Constitution V). */
  intervalMs?: number;
  /** Predicate: when it returns true after a fetch, the poller stops itself. */
  stopWhen?: (result: T) => boolean;
  /** Called on every successful fetch. */
  onResult?: (result: T) => void;
  /** Called when the fetcher throws/rejects. Polling continues. */
  onError?: (err: unknown) => void;
}

export interface Poller {
  start(): void;
  stop(): void;
  refetch(): Promise<void>;
  isRunning(): boolean;
}

const DEFAULT_INTERVAL_MS = 3000;

export function createPoller<T>(
  fetcher: () => Promise<T>,
  opts: PollerOpts<T> = {},
): Poller {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight: Promise<void> | null = null;

  function stop(): void {
    running = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function tick(): Promise<void> {
    // Serialize: a tick already in flight absorbs concurrent calls.
    if (inFlight) {
      return inFlight;
    }
    const work = (async () => {
      try {
        const r = await fetcher();
        opts.onResult?.(r);
        if (opts.stopWhen?.(r)) {
          stop();
        }
      } catch (e) {
        opts.onError?.(e);
      } finally {
        inFlight = null;
      }
    })();
    inFlight = work;
    return work;
  }

  function schedule(): void {
    if (!running) return;
    timer = setTimeout(() => {
      // Fire & forget — tick chains the next schedule via .then.
      void tick().then(() => {
        if (running) schedule();
      });
    }, intervalMs);
  }

  function start(): void {
    if (running) return;
    running = true;
    void tick().then(() => {
      if (running) schedule();
    });
  }

  async function refetch(): Promise<void> {
    await tick();
  }

  function isRunning(): boolean {
    return running;
  }

  return { start, stop, refetch, isRunning };
}

// ─── React hook wrapper ─────────────────────────────────────────────────────

export interface UsePollingOptions<T> {
  intervalMs?: number;
  /** If false, poller is paused. Flipping back to true resumes. Default true. */
  enabled?: boolean;
  stopWhen?: (result: T) => boolean;
  onError?: (err: unknown) => void;
}

export interface UsePollingResult<T> {
  data: T | null;
  error: unknown | null;
  loading: boolean;
  isPolling: boolean;
  refetch: () => Promise<void>;
}

/**
 * React hook: polls `fetcher` every `intervalMs` (default 3000).
 *
 * Note on referential stability: this hook re-creates the poller when
 * `intervalMs`, `enabled`, `stopWhen`, or `onError` change identity. Callers
 * that pass inline arrow functions for `stopWhen`/`onError` will recreate the
 * poller on every render. Memoize them with `useCallback` if that matters.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  opts: UsePollingOptions<T> = {},
): UsePollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [isPolling, setIsPolling] = useState<boolean>(opts.enabled !== false);

  // Keep the latest fetcher in a ref so the effect doesn't re-fire on every
  // render just because the caller passes an inline function.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const pollerRef = useRef<Poller | null>(null);

  const { intervalMs, enabled, stopWhen, onError } = opts;

  useEffect(() => {
    const poller = createPoller<T>(() => fetcherRef.current(), {
      intervalMs,
      stopWhen,
      onResult: (r) => {
        setData(r);
        setError(null);
        setLoading(false);
      },
      onError: (e) => {
        setError(e);
        setLoading(false);
        onError?.(e);
      },
    });
    pollerRef.current = poller;

    if (enabled !== false) {
      poller.start();
      setIsPolling(true);
    } else {
      setIsPolling(false);
    }

    return () => {
      poller.stop();
      pollerRef.current = null;
      setIsPolling(false);
    };
  }, [intervalMs, enabled, stopWhen, onError]);

  async function refetch(): Promise<void> {
    const p = pollerRef.current;
    if (p) await p.refetch();
  }

  return { data, error, loading, isPolling, refetch };
}
