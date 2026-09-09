import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPreviewCache, loadImagePreview } from "./thumbnails";
import { transportFetch } from "./transport";
import type { PreviewFile } from "./types";

vi.mock("./transport", () => ({ transportFetch: vi.fn() }));
const file: PreviewFile = { scope: "items", id: "private", fileName: "private.png", size: 4, previewType: "image" };

describe("private preview cache", () => {
  beforeEach(() => { clearPreviewCache(); vi.mocked(transportFetch).mockReset(); });
  afterEach(clearPreviewCache);

  it("shares a fetch across cards and releases it only when every consumer cancels", async () => {
    let signal: AbortSignal;
    vi.mocked(transportFetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init!.signal!;
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const first = new AbortController(); const second = new AbortController();
    const a = loadImagePreview(file, 1, first.signal).catch((error) => error);
    const b = loadImagePreview(file, 1, second.signal).catch((error) => error);
    expect(transportFetch).toHaveBeenCalledOnce();
    first.abort();
    expect((await a).name).toBe("AbortError");
    expect(signal!.aborted).toBe(false);
    second.abort();
    expect((await b).name).toBe("AbortError");
    expect(signal!.aborted).toBe(true);
  });

  it("revokes cached blobs on sign out and cannot reuse them in a later session", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    vi.mocked(transportFetch).mockImplementation(async () => new Response(new Uint8Array(4)));
    const first = await loadImagePreview(file, 1, new AbortController().signal);
    expect(await loadImagePreview(file, 1, new AbortController().signal)).toBe(first);
    expect(transportFetch).toHaveBeenCalledOnce();
    clearPreviewCache();
    expect(revoke).toHaveBeenCalledWith(first);
    await loadImagePreview(file, 2, new AbortController().signal);
    expect(transportFetch).toHaveBeenCalledTimes(2);
  });

  it("does not repopulate the cache if a fetch finishes after sign out", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(transportFetch).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const create = vi.spyOn(URL, "createObjectURL");
    const result = loadImagePreview(file, 1, new AbortController().signal).catch((error) => error);
    clearPreviewCache();
    finish(new Response(new Uint8Array(4)));
    expect((await result).name).toBe("AbortError");
    expect(create).not.toHaveBeenCalled();
  });
});
