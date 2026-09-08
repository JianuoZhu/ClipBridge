import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThemePicker } from "./ThemePicker";

describe("ThemePicker", () => {
  it("persists and applies a fixed dark theme", async () => {
    localStorage.clear();
    render(<ThemePicker />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "切换主题" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByText("梅紫"));
    expect(document.documentElement.dataset.theme).toBe("plum");
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("clipbridge.theme")).toBe("plum");
  });
});
