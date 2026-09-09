import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewFile } from "@/lib/types";
import { clearPreviewCache } from "@/lib/thumbnails";
import { Thumbnail } from "./Thumbnail";

describe("Thumbnail", () => {
  afterEach(() => { clearPreviewCache(); vi.unstubAllGlobals(); });
  it("shows an accessible retry state and reloads a failed private image", async () => {
    let objectId = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:preview-${++objectId}`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(128), { headers: { "Content-Type": "image/png" } })));
    const open = vi.fn();
    const file: PreviewFile = {
      scope: "items",
      id: "24d8d698-e2ea-4123-8ec5-b0d20241ca11",
      fileName: "photo.png",
      mimeType: "image/png",
      previewType: "image",
      size: 128,
    };
    render(<Thumbnail file={file} sessionKey={1} onClick={open} />);
    const image = await screen.findByRole("presentation", { hidden: true });
    expect(image).not.toBeNull();
    const initial = (image as HTMLImageElement).src;
    fireEvent.error(image as Element);
    const retry = await screen.findByRole("button", { name: "重试加载 photo.png" });
    fireEvent.click(retry);
    await waitFor(() => expect((document.querySelector("img") as HTMLImageElement).src).not.toBe(initial));
    expect(open).not.toHaveBeenCalled();
  });

  it("reuses an image request when a list refresh creates an equivalent descriptor", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const file: PreviewFile = { scope: "items", id: "stable", fileName: "stable.png", previewType: "image", size: 4 };
    const view = render(<Thumbnail file={file} sessionKey={1} onClick={vi.fn()} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    view.rerender(<Thumbnail file={{ ...file }} sessionKey={1} onClick={vi.fn()} />);
    finish(new Response(new Uint8Array(4)));
    expect(await screen.findByRole("presentation", { hidden: true })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
