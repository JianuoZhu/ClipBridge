import { ApiError } from "./client";
import { downloadUrl } from "./thumbnails";
import { getTransportSnapshot, transportFetch } from "./transport";
import type { PreviewFile } from "./types";

export const MAX_BLOB_DOWNLOAD = 64 * 1024 * 1024;
export type DownloadRoute = "direct" | "relay" | "http" | "webrtc";
type SaveHandle = { createWritable(): Promise<WritableStream<Uint8Array>> };
type SaveWindow = Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<SaveHandle> };

function nativeDownload(file: PreviewFile, href = downloadUrl(file)) {
  const anchor = document.createElement("a");
  anchor.href = href; anchor.download = file.fileName;
  document.body.append(anchor); anchor.click(); anchor.remove();
}

/** Call synchronously from a user gesture so the browser can show the save picker. */
export async function downloadFile(file: PreviewFile, options: {
  signal: AbortSignal; onProgress?: (percent: number) => void; onRoute?: (route: DownloadRoute, detail: string) => void;
}) {
  if (options.signal.aborted) throw new DOMException("下载已取消", "AbortError");
  const mode = getTransportSnapshot().mode;
  const picker = (window as SaveWindow).showSaveFilePicker;
  if (mode !== "direct" && mode !== "relay") {
    options.onRoute?.("http", "已交给浏览器，通过 HTTPS 下载");
    nativeDownload(file); return;
  }
  if (!picker && file.size > MAX_BLOB_DOWNLOAD) {
    options.onRoute?.("http", "浏览器不支持直接写入文件；大于 64 MB 的文件通过 HTTPS 下载");
    nativeDownload(file); return;
  }
  // Acquire the destination before starting network I/O. Never replay a partial download.
  const handle = picker ? await picker.call(window, { suggestedName: file.fileName }) : null;
  if (options.signal.aborted) throw new DOMException("下载已取消", "AbortError");
  const response = await transportFetch(downloadUrl(file), { signal: options.signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(payload?.error || `下载失败（${response.status}）`, response.status);
  }
  if (!response.body) throw new Error("下载响应没有内容");
  const route = response.headers.get("X-Clip-Transport") || "http";
  options.onRoute?.(route as DownloadRoute, route === "http" ? "通过 HTTPS 下载" : route === "relay" ? "通过 WebRTC 中继下载" : route === "direct" ? "从家中直连下载" : "通过 WebRTC 下载，正在确认路径");
  let received = 0;
  const meter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if ((!handle && received > MAX_BLOB_DOWNLOAD) || received > file.size) throw new Error("文件大小发生变化，请刷新后重试");
      options.onProgress?.(Math.min(100, Math.round(received / Math.max(1, file.size) * 100)));
      controller.enqueue(chunk);
    },
    flush() { if (received !== file.size) throw new Error("文件传输不完整，请重试"); },
  });
  if (handle) {
    let destination: WritableStream<Uint8Array>;
    try { destination = await handle.createWritable(); }
    catch (error) { await response.body.cancel(); throw error; }
    // pipeTo aborts the destination on any transfer failure; partial files are not committed.
    await response.body.pipeThrough(meter).pipeTo(destination, { signal: options.signal });
    return;
  }
  const blob = await new Response(response.body.pipeThrough(meter)).blob();
  if (options.signal.aborted) throw new DOMException("下载已取消", "AbortError");
  const url = URL.createObjectURL(blob);
  nativeDownload(file, url);
  // Give the browser's download manager time to acquire the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
