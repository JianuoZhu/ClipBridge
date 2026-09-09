import { transportFetch } from "./transport";

export type LatencyRoute = "direct" | "relay" | "webrtc" | "https";
export type LatencyResult = {
  at: string;
  samples: { ms: number; route: LatencyRoute }[];
  failed: number;
  averageMs: number;
  minMs: number;
  maxMs: number;
};

/** Small authenticated requests measure application response time, not bandwidth. */
export async function testConnectionLatency(signal: AbortSignal, progress: (completed: number) => void): Promise<LatencyResult> {
  const samples: LatencyResult["samples"] = [];
  let failed = 0;
  for (let index = 0; index < 5; index++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 4_000);
    try {
      const started = performance.now();
      const response = await transportFetch(`/api/connection/ping?sample=${index}&t=${Date.now()}`, {
        cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("probe failed"); }
      const body = await response.json();
      signal.throwIfAborted();
      if (controller.signal.aborted || body?.ok !== true) throw new Error("invalid probe");
      const route = response.headers.get("X-Clip-Transport");
      samples.push({ ms: performance.now() - started, route: route === "direct" || route === "relay" || route === "webrtc" ? route : "https" });
    } catch {
      signal.throwIfAborted();
      failed++;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    progress(index + 1);
  }
  if (!samples.length) throw new Error("5 次请求均未成功，请检查连接或重新登录后再试。");
  const values = samples.map((sample) => sample.ms);
  return { at: new Date().toISOString(), samples, failed,
    averageMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    minMs: Math.min(...values), maxMs: Math.max(...values) };
}
