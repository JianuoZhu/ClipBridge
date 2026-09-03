import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { createClipServer } from "./server.js";

try {
  const config = loadConfig();
  const store = new Store(config.dataDir);
  const app = await createClipServer({ config, store });

  app.server.listen(config.port, "0.0.0.0", () => {
    console.log(`Jianuo Clip listening on port ${config.port}`);
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    app.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
