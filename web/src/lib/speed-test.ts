import { transportFetch } from "./transport";
import type { LatencyRoute } from "./connection-test";

export const SPEED_BYTE_LIMIT = 8 * 1024 * 1024;
type Direction = "download" | "upload";
export type SpeedProgress = { direction: Direction; bytes: number };
export type SpeedMeasurement = { bytes: number; durationMs: number; bytesPerSecond: number; routes: LatencyRoute[] };
export type SpeedResult = { at: string; download?: SpeedMeasurement; upload?: SpeedMeasurement; downloadError?: string; uploadError?: string };

function randomPayload(size: number): Blob {
  const data = new Uint8Array(size);
  for (let at = 0; at < size; at += 65_536) crypto.getRandomValues(data.subarray(at, Math.min(size, at + 65_536)));
  return new Blob([data], { type: "application/octet-stream" });
}

async function measure(direction: Direction, signal: AbortSignal, progress: (value: SpeedProgress) => void): Promise<SpeedMeasurement> {
  let bytes = 0;
  let durationMs = 0;
  let nextSize = 64 * 1024;
  const routes = new Set<LatencyRoute>();
  progress({ direction, bytes });
  while (bytes < SPEED_BYTE_LIMIT && durationMs < 3_000) {
    signal.throwIfAborted();
    const size = Math.min(nextSize, SPEED_BYTE_LIMIT - bytes);
    const payload = direction === "upload" ? randomPayload(size) : undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 20_000);
    let response: Response | undefined;
    try {
      const started = performance.now();
      response = await transportFetch(`/api/connection/speed?bytes=${size}&t=${Date.now()}`, {
        method: direction === "download" ? "GET" : "POST", body: payload,
        headers: direction === "upload" ? { "Content-Type": "application/octet-stream", "X-Clip-Request": "1" } : undefined,
        cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw new Error(response.status === 401 ? "登录已失效，请重新登录。" : response.status === 404
        ? "测速接口尚未就绪，请更新家中应用和 P2P 服务。" : response.status === 429 ? "测速服务繁忙，请稍后重试。" : `测速请求失败（HTTP ${response.status}）。`);
      if (direction === "download") {
        const encoding = response.headers.get("Content-Encoding");
        if (encoding && encoding !== "identity") throw new Error("测速数据被代理压缩，请更新反向代理配置后重试。");
        if (response.headers.get("Content-Length") !== String(size) || !response.body) throw new Error("测速响应长度不正确，请更新服务后重试。");
        const reader = response.body.getReader();
        let received = 0;
        let lastUpdate = started;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (controller.signal.aborted) throw new Error("测速超时，请检查连接后重试。");
            if (done) break;
            received += value.byteLength;
            if (received > size) throw new Error("测速数据超过预期大小。");
            const now = performance.now();
            if (now - lastUpdate >= 150) { progress({ direction, bytes: bytes + received }); lastUpdate = now; }
          }
          if (received !== size) throw new Error("测速传输中断，请重试。");
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } else {
        const receipt = await response.json();
        if (receipt?.bytes !== size) throw new Error("家中服务未确认完整接收测速数据，请重试。");
      }
      signal.throwIfAborted();
      if (controller.signal.aborted) throw new Error("测速超时，请检查连接后重试。");
      durationMs += Math.max(0, performance.now() - started);
      bytes += size;
      const route = response.headers.get("X-Clip-Transport");
      routes.add(route === "direct" || route === "relay" || route === "webrtc" ? route : "https");
      progress({ direction, bytes });
      nextSize = Math.min(nextSize * 4, 2 * 1024 * 1024);
    } catch (error) {
      signal.throwIfAborted();
      if (controller.signal.aborted) throw new Error("测速超时，请检查连接后重试。");
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
  return { bytes, durationMs, bytesPerSecond: bytes * 1_000 / Math.max(durationMs, 1), routes: [...routes] };
}

/** Completed transfers only; upload ends when the home server confirms receipt. */
export async function testConnectionSpeed(signal: AbortSignal, progress: (value: SpeedProgress) => void): Promise<SpeedResult> {
  const result: SpeedResult = { at: new Date().toISOString() };
  for (const direction of ["download", "upload"] as const) {
    try { result[direction] = await measure(direction, signal, progress); }
    catch (error) {
      signal.throwIfAborted();
      result[direction === "download" ? "downloadError" : "uploadError"] = error instanceof Error ? error.message : "测速失败，请重试。";
    }
  }
  result.at = new Date().toISOString();
  return result;
}
