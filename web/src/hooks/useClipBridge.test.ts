import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClipBridge } from "./useClipBridge";
import { api } from "../lib/client";
import type { ClipItem } from "../lib/types";

vi.mock("../lib/client", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/client")>(), api: vi.fn() }));
vi.mock("../lib/transport", () => ({
  transportFetch: vi.fn(), getTransportSnapshot: () => ({ mode: "http", detail: "" }),
  startTransport: vi.fn(), stopTransport: vi.fn(), subscribeTransport: () => () => {},
}));
class FakeEventSource extends EventTarget {
  readyState = 1;
  close() { this.readyState = 2; }
}
const session = { authenticated: true, role: "member", settings: { maxTextBytes: 64_000 } };
const item: ClipItem = { id: "saved", kind: "text", text: "saved at home", size: 13, createdAt: 1, expiresAt: 99_999 };

describe("saved message visibility", () => {
  beforeEach(() => { vi.stubGlobal("EventSource", FakeEventSource); vi.mocked(api).mockReset(); });
  afterEach(() => vi.unstubAllGlobals());

  it("acknowledges a successful POST without waiting for refresh and ignores older in-flight lists", async () => {
    const lists: Array<(value: unknown) => void> = [];
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/session") return Promise.resolve(session) as never;
      if (path === "/api/items/text") return Promise.resolve({ item }) as never;
      if (path === "/api/items") return new Promise((resolve) => { lists.push(resolve); }) as never;
      throw new Error(path);
    });
    const { result } = renderHook(useClipBridge);
    await waitFor(() => expect(lists).toHaveLength(1));
    let sent = false;
    await act(async () => { sent = await result.current.sendText("saved at home"); });
    expect(sent).toBe(true);
    expect(result.current.sending).toBe(false);
    expect(result.current.items).toEqual([item]);
    expect(result.current.toast?.message).toBe("文字已保存到家中");
    await act(async () => { lists[0]({ items: [] }); });
    expect(result.current.items).toEqual([item]);
    expect(lists).toHaveLength(2);
    await act(async () => { lists[1]({ items: [item] }); });
    expect(result.current.items).toEqual([item]);
  });

  it("does not restore private messages when an old response arrives after sign out", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementation((path) => {
      if (path === "/api/session") return Promise.resolve(session) as never;
      if (path === "/api/items") return new Promise((resolve) => { finish = resolve; }) as never;
      throw new Error(path);
    });
    const { result } = renderHook(useClipBridge);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    act(() => result.current.signOut());
    await act(async () => { finish({ items: [item] }); });
    expect(result.current.session).toBeNull();
    expect(result.current.items).toEqual([]);
    expect(result.current.latest).toEqual([]);
  });
});
