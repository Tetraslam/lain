/**
 * Resilient fetch for LLM provider calls.
 *
 * Adds two things every provider needs but none had:
 *  - a time-to-headers timeout, so a hung/slow endpoint can't pin a concurrency
 *    slot forever (the timer is cleared once headers arrive, so it never kills
 *    an in-progress streaming body read);
 *  - retry with exponential backoff + jitter on transient failures (network
 *    errors and 429/5xx), honoring Retry-After on 429.
 *
 * Caller cancellation (a user/abort signal) is respected and never retried.
 */

export interface RetryOptions {
  /** Abort if response headers don't arrive within this many ms. Default 120s. */
  timeoutMs?: number;
  /** Max retry attempts after the first try. Default 3. */
  maxRetries?: number;
  /** Base backoff in ms (grows ~2^attempt). Default 500. */
  baseDelayMs?: number;
  /** Caller cancellation — when this aborts, we stop and do NOT retry. */
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoffMs(base: number, attempt: number): number {
  const exp = base * 2 ** attempt;
  return exp + Math.random() * base; // full-ish jitter
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`request timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * fetch() with a headers timeout and transient-failure retries. Returns the
 * Response for the caller to read (body is left intact on the returned
 * response; bodies of retried responses are drained).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxRetries = opts.maxRetries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => ctrl.abort();
    if (opts.signal) {
      if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");
      opts.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);

    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCallerAbort);

      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
        const wait = retryAfterMs(res) ?? backoffMs(base, attempt);
        try { await res.arrayBuffer(); } catch { /* drain to free the socket */ }
        await sleep(wait);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCallerAbort);
      // Caller cancelled — surface immediately, never retry.
      if (opts.signal?.aborted) throw err;
      lastErr = timedOut ? new TimeoutError(timeoutMs) : err;
      if (attempt < maxRetries) {
        await sleep(backoffMs(base, attempt));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error("fetchWithRetry: retries exhausted");
}
