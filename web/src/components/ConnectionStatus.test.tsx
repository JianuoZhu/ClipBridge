import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStatus } from "./ConnectionStatus";
import type { TransportSnapshot } from "@/lib/transport";

const transport = vi.hoisted(() => ({
  snapshot: { mode: "direct", detail: "已直连", rttMs: 12.4 } as TransportSnapshot,
  listeners: new Set<() => void>(), retry: vi.fn(),
}));
vi.mock("@/lib/transport", () => ({
  getTransportSnapshot: () => transport.snapshot,
  subscribeTransport: (listener: () => void) => { transport.listeners.add(listener); return () => transport.listeners.delete(listener); },
  retryTransport: transport.retry,
}));

describe("connection status", () => {
  it("separates the actual transport path from real-time sync state and lets users retry", () => {
    render(<ConnectionStatus connection="online" />);
    fireEvent.click(screen.getByRole("button", { name: "连接状态：家中直连，同步正常" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("12 ms");
    expect(screen.getByRole("dialog")).toHaveTextContent("已保存到家中");
    act(() => {
      transport.snapshot = { mode: "relay", detail: "通过 TURN 中继连接家中服务器" };
      transport.listeners.forEach((listener) => listener());
    });
    expect(screen.getByRole("dialog")).toHaveTextContent("中继连接");
    expect(screen.getByRole("dialog")).toHaveTextContent("速度受中继链路限制");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("12 ms");
    fireEvent.click(screen.getByRole("button", { name: "重新尝试直连" }));
    expect(transport.retry).toHaveBeenCalledOnce();
    act(() => {
      transport.snapshot = { mode: "connecting", detail: "正在打洞" };
      transport.listeners.forEach((listener) => listener());
    });
    expect(screen.getByRole("button", { name: "重新尝试直连" })).toBeDisabled();
  });
});
