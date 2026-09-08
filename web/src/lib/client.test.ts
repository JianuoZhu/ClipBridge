import { describe, expect, it } from "vitest";
import { formatSize, relativeTime } from "./client";

describe("client formatting", () => {
  it("formats byte counts and relative timestamps for the compact cards", () => {
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(relativeTime(Date.now())).toMatch(/现在|秒/);
  });
});
