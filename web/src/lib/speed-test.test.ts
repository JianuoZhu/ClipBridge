import { afterEach, describe, expect, it, vi } from "vitest";
import { transportFetch } from "./transport";
import { SPEED_BYTE_LIMIT, testConnectionSpeed } from "./speed-test";

vi.mock("./transport", () => ({ transportFetch: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers(); });

describe("bounded bidirectional throughput measurement", () => {
  it("measures confirmed bytes on both paths and caps test data in each direction", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock += 10);
    const totals = { GET: 0, POST: 0 };
    vi.mocked(transportFetch).mockImplementation(async (path, options) => {
      const size = Number(new URL(path, "https://test.invalid").searchParams.get("bytes"));
      expect(size).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(options?.cache).toBe("no-store");
      if (options?.method === "POST") {
        expect((options.body as Blob).size).toBe(size);
        expect(options.headers).toMatchObject({ "X-Clip-Request": "1" });
        totals.POST += size;
        return Response.json({ bytes: size });
      }
      totals.GET += size;
      return new Response(new Uint8Array(size), { headers: { "Content-Length": String(size), "X-Clip-Transport": "direct" } });
    });
    const result = await testConnectionSpeed(new AbortController().signal, vi.fn());
    expect(totals).toEqual({ GET: SPEED_BYTE_LIMIT, POST: SPEED_BYTE_LIMIT });
    expect(result.download).toMatchObject({ bytes: SPEED_BYTE_LIMIT, durationMs: 140, routes: ["direct"] });
    expect(result.download!.bytesPerSecond).toBeCloseTo(SPEED_BYTE_LIMIT / 0.14);
    expect(result.upload).toMatchObject({ bytes: SPEED_BYTE_LIMIT, durationMs: 70, routes: ["https"] });
    expect(result.upload!.bytesPerSecond).toBeCloseTo(SPEED_BYTE_LIMIT / 0.07);
  });

  it("does not report compressed downloads or unacknowledged uploads as successful speeds", async () => {
    vi.mocked(transportFetch).mockImplementation(async (_path, options) => options?.method === "GET"
      ? new Response("compressed", { headers: { "Content-Encoding": "gzip" } })
      : Response.json({ bytes: 0 }));
    const result = await testConnectionSpeed(new AbortController().signal, vi.fn());
    expect(result.download).toBeUndefined();
    expect(result.upload).toBeUndefined();
    expect(result.downloadError).toContain("代理压缩");
    expect(result.uploadError).toContain("未确认完整接收");
  });

  it("aborts an active sample without starting upload or returning a success result", async () => {
    const controller = new AbortController();
    vi.mocked(transportFetch).mockImplementation((_path, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = testConnectionSpeed(controller.signal, vi.fn());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(transportFetch).toHaveBeenCalledTimes(1);
  });

  it("stops adding samples after the target duration on a slow connection", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock += 4_000);
    vi.mocked(transportFetch).mockImplementation(async (path, options) => {
      const bytes = Number(new URL(path, "https://test.invalid").searchParams.get("bytes"));
      return options?.method === "GET" ? new Response(new Uint8Array(bytes), { headers: { "Content-Length": String(bytes) } }) : Response.json({ bytes });
    });
    const result = await testConnectionSpeed(new AbortController().signal, vi.fn());
    expect(result.download?.bytes).toBe(65_536);
    expect(result.upload?.bytes).toBe(65_536);
    expect(transportFetch).toHaveBeenCalledTimes(2);
  });

  it("bounds stalled requests and clears all deadline timers", async () => {
    vi.useFakeTimers();
    vi.mocked(transportFetch).mockImplementation((_path, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
    }));
    const pending = testConnectionSpeed(new AbortController().signal, vi.fn());
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await pending;
    expect(result.downloadError).toContain("超时");
    expect(result.uploadError).toContain("超时");
    expect(vi.getTimerCount()).toBe(0);
  });
});
