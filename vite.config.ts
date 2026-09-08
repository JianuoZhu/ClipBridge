import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const root = import.meta.dirname;
const require = createRequire(import.meta.url);
const pdfRequire = createRequire(require.resolve("react-pdf"));
const pdfDir = path.dirname(pdfRequire.resolve("pdfjs-dist/package.json"));

function localAssets(): Plugin {
  return {
    name: "clipbridge-local-assets",
    enforce: "post",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (request, response, next) => {
        const relative = decodeURIComponent((request.url || "").split("?")[0]).replace(/^\/+/, "");
        const file = relative === "pdf.worker.min.mjs"
          ? path.join(pdfDir, "build/pdf.worker.min.mjs")
          : path.resolve(pdfDir, relative);
        if (!file.startsWith(pdfDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        response.setHeader("Content-Type", file.endsWith(".mjs") ? "text/javascript" : file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        fs.createReadStream(file).pipe(response);
      });
    },
    generateBundle(_, bundle) {
      const copy = (directory: string, prefix: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          const name = prefix + "/" + entry.name;
          if (entry.isDirectory()) copy(file, name);
          else this.emitFile({ type: "asset", fileName: name, source: fs.readFileSync(file) });
        }
      };
      this.emitFile({ type: "asset", fileName: "pdfjs/pdf.worker.min.mjs", source: fs.readFileSync(path.join(pdfDir, "build/pdf.worker.min.mjs")) });
      for (const dir of ["cmaps", "standard_fonts", "wasm"]) copy(path.join(pdfDir, dir), "pdfjs/" + dir);
      const entries = new Set<string>(["/", "/index.html", "/theme-init.js", "/manifest.webmanifest", "/icon.svg"]);
      const visit = (name: string) => {
        if (entries.has("/" + name)) return;
        entries.add("/" + name);
        const output = bundle[name];
        if (output?.type === "chunk") output.imports.forEach(visit);
      };
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk" && output.isEntry) visit(output.fileName);
        if (output.fileName.endsWith(".css")) entries.add("/" + output.fileName);
      }
      const assetNames = Object.keys(bundle).filter((name) => name.startsWith("assets/")).map((name) => "/" + name);
      const version = createHash("sha256").update([...entries, ...assetNames].sort().join("|")).digest("hex").slice(0, 12);
      const template = fs.readFileSync(path.join(root, "web/sw.js"), "utf8");
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template.replace('"__BUILD_VERSION__"', JSON.stringify(version))
          .replace('["__APP_SHELL__"]', JSON.stringify([...entries]))
          .replace('["__STATIC_ASSETS__"]', JSON.stringify([...entries, ...assetNames])),
      });
    },
  };
}

export default defineConfig({
  root: path.join(root, "web"),
  plugins: [react(), tailwindcss(), localAssets()],
  resolve: { alias: { "@": path.join(root, "web/src") }, dedupe: ["react", "react-dom", "get-nonce"] },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:" + (process.env.CLIP_PORT || "8080"), changeOrigin: false },
      "/healthz": { target: "http://127.0.0.1:" + (process.env.CLIP_PORT || "8080"), changeOrigin: false }
    }
  },
  build: { outDir: path.join(root, "dist/web"), emptyOutDir: true, sourcemap: false }
});
