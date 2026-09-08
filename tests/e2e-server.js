import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { createClipServer } from "../src/server.js";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "clip-e2e-"));
const store = new Store(dataDir);
const app = await createClipServer({
  config: {
    port: 4173, dataDir, domain: "", pin: "1223", username: "admin",
    password: "correct-horse-battery-staple", retentionHours: 24,
    maxFileBytes: 128 * 1024 * 1024, maxStorageBytes: 256 * 1024 * 1024,
    maxTextBytes: 1024 * 1024, sessionDays: 30, cookieSecure: false
  },
  store
});
app.server.listen(4173, "127.0.0.1");

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  app.close(() => {
    store.close();
    fs.rm(dataDir, { recursive: true, force: true }).finally(() => process.exit(0));
  });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
