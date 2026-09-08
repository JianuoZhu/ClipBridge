import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

class FakeEventSource extends EventTarget {
  static OPEN = 1;
  static CLOSED = 2;
  readyState = FakeEventSource.OPEN;
  close() { this.readyState = FakeEventSource.CLOSED; }
}

const session = {
  authenticated: true,
  role: "member",
  adminEnabled: true,
  settings: {
    retentionHours: 24,
    maxFileBytes: 1024 * 1024,
    maxTextBytes: 64 * 1024,
    maxStorageBytes: 10 * 1024 * 1024
  }
};

describe("App authentication", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("submits only the PIN and enters the compact workspace after cookie verification", async () => {
    let authenticated = false;
    let loginBody = "";
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/auth/login") {
        authenticated = true;
        loginBody = String(init?.body);
        return Response.json({ role: "member" });
      }
      if (path === "/api/session") return Response.json(authenticated ? session : { authenticated: false, adminEnabled: true });
      if (path === "/api/items") return Response.json({ items: [], latest: [] });
      throw new Error("unexpected " + path);
    }));
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("访问 PIN"), "0012");
    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    expect(await screen.findByRole("heading", { name: "发送" })).toBeInTheDocument();
    expect(JSON.parse(loginBody)).toEqual({ pin: "0012" });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "工作空间" })).toBeInTheDocument());
  });
});
