import { afterEach, describe, expect, it, vi } from "vitest";
import { transportFetch } from "./transport";
import { testConnectionLatency } from "./connection-test";

vi.mock("./transport", () => ({ transportFetch: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("connection latency measurement", () => {
  it("reports the paths actually used, including an HTTPS fallback, and counts failed samples", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock += 10);
    vi.mocked(transportFetch)
      .mockResolvedValueOnce(Response.json({ ok: true }, { headers: { "X-Clip-Transport": "direct" } }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ ok: true }, { headers: { "X-Clip-Transport": "direct" } }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const progress = vi.fn();
    const result = await testConnectionLatency(new AbortController().signal, progress);
    expect(result).toMatchObject({ failed: 1, averageMs: 10, minMs: 10, maxMs: 10 });
    expect(result.samples.map((sample) => sample.route)).toEqual(["direct", "https", "direct", "https"]);
    expect(progress).toHaveBeenLastCalledWith(5);
    expect(transportFetch).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/connection\/ping\?/), expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  });

  it("cancels an in-flight request and sends no remaining probes", async () => {
    const controller = new AbortController();
    vi.mocked(transportFetch).mockImplementation((_path, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = testConnectionLatency(controller.signal, vi.fn());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(transportFetch).toHaveBeenCalledTimes(1);
  });

  it("bounds a completely stalled test and never presents a successful result", async () => {
    vi.useFakeTimers();
    vi.mocked(transportFetch).mockImplementation((_path, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
    }));
    const failed = expect(testConnectionLatency(new AbortController().signal, vi.fn())).rejects.toThrow("5 次请求均未成功");
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    expect(transportFetch).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });
});
