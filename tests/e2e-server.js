import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Store } from "../src/store.js";
import { createClipServer } from "../src/server.js";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "clip-e2e-"));
const store = new Store(dataDir);
const p2pEnabled = process.env.CLIP_E2E_P2P === "1";
const port = p2pEnabled ? 4183 : 4173;
const secret = randomBytes(32).toString("base64url");
let gateway;
const app = await createClipServer({
  config: {
    port, dataDir, domain: "", pin: "1223", username: "admin",
    password: "correct-horse-battery-staple", retentionHours: 24,
    maxFileBytes: 128 * 1024 * 1024, maxStorageBytes: 256 * 1024 * 1024,
    maxTextBytes: 1024 * 1024, sessionDays: 30, cookieSecure: false,
    p2p: { enabled: p2pEnabled, secret, gatewayUrl: "http://127.0.0.1:8099", stunUrls: [] }
  },
  store
});
if (p2pEnabled) {
  if (!process.env.CLIP_E2E_GATEWAY_BINARY) throw new Error("Build the gateway with npm run test:p2p");
  gateway = spawn(process.env.CLIP_E2E_GATEWAY_BINARY, [], { stdio: "inherit", windowsHide: true,
    env: { ...process.env, CLIP_P2P_SECRET: secret, CLIP_P2P_LISTEN: "127.0.0.1:8099",
      CLIP_P2P_BACKEND_URL: `http://127.0.0.1:${port}`, CLIP_P2P_UDP_PORT: "50002", CLIP_P2P_STUN_URLS: "" } });
  gateway.on("error", (error) => { console.error(error.message); process.exitCode = 1; stop(); });
}
app.server.listen(port, "127.0.0.1");

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  gateway?.kill();
  app.server.closeAllConnections();
  app.close(() => {
    store.close();
    if (path.dirname(dataDir) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith("clip-e2e-")) throw new Error("Unsafe test cleanup path");
    fs.rm(dataDir, { recursive: true, force: true }).finally(() => process.exit(process.exitCode || 0));
  });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
