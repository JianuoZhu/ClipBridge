import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PreviewFile } from "@/lib/types";
import { Thumbnail } from "./Thumbnail";

describe("Thumbnail", () => {
  it("shows an accessible retry state and reloads a failed private image", async () => {
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
    const image = await screen.findByRole("presentation", { hidden: true }).catch(() => document.querySelector("img"));
    expect(image).not.toBeNull();
    const initial = (image as HTMLImageElement).src;
    fireEvent.error(image as Element);
    const retry = await screen.findByRole("button", { name: "重试加载 photo.png" });
    fireEvent.click(retry);
    await waitFor(() => expect((document.querySelector("img") as HTMLImageElement).src).not.toBe(initial));
    expect(open).not.toHaveBeenCalled();
  });
});
