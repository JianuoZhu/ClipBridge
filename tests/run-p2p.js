import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cache = path.join(root, ".cache", "p2p-tests");
await fs.mkdir(cache, { recursive: true });
const binary = path.join(cache, process.platform === "win32" ? "clip-gateway.exe" : "clip-gateway");
const env = { ...process.env, GOCACHE: process.env.GOCACHE || path.join(cache, "go-build"), GOMODCACHE: process.env.GOMODCACHE || path.join(cache, "go-mod") };
const run = (command, args, cwd, childEnv) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env: childEnv, stdio: "inherit", windowsHide: true });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}`)));
});
try {
  await run(process.env.GO_BINARY || "go", ["build", "-o", binary, "."], path.join(root, "gateway"), env);
  await run(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.p2p.config.ts"], root,
    { ...process.env, CLIP_E2E_P2P: "1", CLIP_E2E_GATEWAY_BINARY: binary });
} catch (error) { console.error(error.message); process.exitCode = 1; }
