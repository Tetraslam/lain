import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithRetry, TimeoutError } from "../src/http.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

const ok = () => new Response("ok", { status: 200 });
const fast = { baseDelayMs: 1, timeoutMs: 1000 };

describe("fetchWithRetry", () => {
  it("retries 5xx then succeeds", async () => {
    let n = 0;
    const f = mockFetch(async () => (++n < 3 ? new Response("", { status: 503 }) : ok()));
    const res = await fetchWithRetry("u", {}, fast);
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("retries 429 honoring Retry-After", async () => {
    let n = 0;
    const f = mockFetch(async () =>
      ++n < 2 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : ok()
    );
    expect((await fetchWithRetry("u", {}, fast)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry 4xx (client error)", async () => {
    const f = mockFetch(async () => new Response("bad", { status: 400 }));
    const res = await fetchWithRetry("u", {}, fast);
    expect(res.status).toBe(400);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries on network error then succeeds", async () => {
    let n = 0;
    const f = mockFetch(async () => { if (++n < 2) throw new Error("ECONNRESET"); return ok(); });
    expect((await fetchWithRetry("u", {}, fast)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const f = mockFetch(async () => { throw new Error("down"); });
    await expect(fetchWithRetry("u", {}, { baseDelayMs: 1, maxRetries: 2 })).rejects.toThrow("down");
    expect(f).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("times out when headers don't arrive, as TimeoutError", async () => {
    mockFetch((_u, init) => new Promise((_res, rej) => {
      (init.signal as AbortSignal).addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
    }));
    await expect(fetchWithRetry("u", {}, { timeoutMs: 20, maxRetries: 0 })).rejects.toBeInstanceOf(TimeoutError);
  });

  it("respects caller cancellation without retrying", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const f = mockFetch(async () => ok());
    await expect(fetchWithRetry("u", {}, { signal: ctrl.signal })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});
