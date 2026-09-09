export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.method && !["GET", "HEAD"].includes(options.method)) headers.set("X-Clip-Request", "1");
  const response = await transportFetch(path, { ...options, headers, credentials: "same-origin" });
  const payload = response.headers.get("content-type")?.includes("application/json")
    ? await response.json() : null;
  if (!response.ok) throw new ApiError(payload?.error || `请求失败（${response.status}）`, response.status);
  return payload as T;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function relativeTime(timestamp: number): string {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* Older/insecure browsers. */ }
  const previousFocus = document.activeElement as HTMLElement | null;
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.className = "clipboard-helper";
  helper.setAttribute("aria-hidden", "true");
  document.body.append(helper);
  try { helper.select(); return document.execCommand("copy"); }
  catch { return false; }
  finally { helper.remove(); previousFocus?.focus({ preventScroll: true }); }
}

export function uploadFile(file: File, library: boolean, signal: AbortSignal, onProgress: (value: number) => void): Promise<void> {
  const { mode } = getTransportSnapshot();
  if (mode === "direct" || mode === "relay") {
    return transportFetch(library ? "/api/library" : "/api/items/file", {
      method: "POST", signal, body: file,
      headers: {
        "X-Clip-Request": "1", "X-Clip-File-Name": encodeURIComponent(file.name),
        "Content-Type": file.type || "application/octet-stream",
      },
    }, onProgress).then(async (response) => {
      // Only the home server's successful response confirms durable storage.
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new ApiError(payload?.error || `上传失败（${response.status}）`, response.status);
      }
      await response.arrayBuffer();
    });
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const clean = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) { reject(new DOMException("上传已取消", "AbortError")); return; }
    signal.addEventListener("abort", abort, { once: true });
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    });
    request.addEventListener("load", () => {
      clean();
      if (request.status >= 200 && request.status < 300) resolve();
      else {
        let message = "上传失败";
        try { message = JSON.parse(request.responseText).error || message; } catch { /* Non-JSON proxy errors. */ }
        reject(new ApiError(message, request.status));
      }
    });
    request.addEventListener("error", () => { clean(); reject(new Error("网络中断，文件上传失败")); });
    request.addEventListener("timeout", () => { clean(); reject(new Error("上传超时")); });
    request.addEventListener("abort", () => { clean(); reject(new DOMException("上传已取消", "AbortError")); });
    try {
      request.open("POST", library ? "/api/library" : "/api/items/file");
      request.timeout = 60 * 60 * 1000;
      request.setRequestHeader("X-Clip-Request", "1");
      request.setRequestHeader("X-Clip-File-Name", encodeURIComponent(file.name));
      request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      request.send(file);
    } catch (error) { clean(); reject(error); }
  });
}
import { getTransportSnapshot, transportFetch } from "./transport";
