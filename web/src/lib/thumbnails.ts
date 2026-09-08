import type { PreviewFile } from "./types";

const AUTO_PDF_LIMIT = 20 * 1024 * 1024;
const MAX_ENTRIES = 64;
const MAX_BYTES = 16 * 1024 * 1024;
const cache = new Map<string, { url: string; bytes: number; touched: number }>();
const controllers = new Set<AbortController>();
const queue: Array<{
  signal: AbortSignal;
  work: () => Promise<{ url: string; bytes: number }>;
  resolve: (result: { url: string; bytes: number }) => void;
  reject: (error: unknown) => void;
}> = [];
let running = 0;

export const previewUrl = (file: PreviewFile) =>
  "/api/" + file.scope + "/" + file.id + "/preview" + (file.revision ? "?revision=" + file.revision : "");
export const downloadUrl = (file: PreviewFile) => "/api/" + file.scope + "/" + file.id + "/file";
export const thumbnailKey = (file: PreviewFile, sessionKey: number) =>
  [sessionKey, file.scope, file.id, file.revision || 0].join(":");

function trimCache() {
  let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  const ordered = [...cache.entries()].sort((a, b) => a[1].touched - b[1].touched);
  while ((cache.size > MAX_ENTRIES || bytes > MAX_BYTES) && ordered.length) {
    const [key, entry] = ordered.shift()!;
    cache.delete(key);
    bytes -= entry.bytes;
    URL.revokeObjectURL(entry.url);
  }
}

function pump() {
  while (running < 2 && queue.length) {
    const task = queue.shift()!;
    if (task.signal.aborted) { task.reject(new DOMException("Aborted", "AbortError")); continue; }
    running += 1;
    task.work().then(task.resolve, task.reject).finally(() => { running -= 1; pump(); });
  }
}

function limited(signal: AbortSignal, work: () => Promise<{ url: string; bytes: number }>) {
  return new Promise<{ url: string; bytes: number }>((resolve, reject) => {
    queue.push({ signal, work, resolve, reject });
    pump();
  });
}

export async function loadPdfThumbnail(file: PreviewFile, sessionKey: number, signal: AbortSignal): Promise<string> {
  if (file.previewType !== "pdf" || file.size > AUTO_PDF_LIMIT) throw new Error("manual");
  const key = thumbnailKey(file, sessionKey);
  const found = cache.get(key);
  if (found) { found.touched = Date.now(); return found.url; }
  return (await limited(signal, async () => {
    const { pdfjs } = await import("react-pdf");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | undefined;
    let renderTask: { cancel(): void; promise: Promise<unknown> } | undefined;
    const timeout = window.setTimeout(() => loadingTask?.destroy(), 15_000);
    const abort = () => { renderTask?.cancel(); void loadingTask?.destroy(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      loadingTask = pdfjs.getDocument({
        url: previewUrl(file), withCredentials: true, disableRange: false, disableAutoFetch: true, disableStream: true,
        cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/",
        wasmUrl: "/pdfjs/wasm/", isEvalSupported: false
      });
      loadingTask.onPassword = () => { void loadingTask?.destroy(); };
      const document = await loadingTask.promise;
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const page = await document.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.5, 320 / Math.max(1, base.width)) });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      renderTask = page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE });
      await renderTask.promise;
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("无法生成 PDF 缩略图")), "image/webp", .82));
      const result = { url: URL.createObjectURL(blob), bytes: blob.size };
      cache.set(key, { ...result, touched: Date.now() });
      trimCache();
      await document.destroy();
      return result;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      await loadingTask?.destroy().catch(() => {});
    }
  })).url;
}

export function createThumbnailController() {
  const controller = new AbortController();
  controllers.add(controller);
  controller.signal.addEventListener("abort", () => controllers.delete(controller), { once: true });
  return controller;
}

export function clearPreviewCache() {
  for (const controller of controllers) controller.abort();
  controllers.clear();
  queue.splice(0).forEach((task) => task.reject(new DOMException("Aborted", "AbortError")));
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
  cache.clear();
}
