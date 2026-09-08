import { randomInt } from "node:crypto";

// Some Windows configurations allocate port 0 from a range containing fetch-blocked ports.
export async function listenOnLoopback(server) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => { server.off("listening", ready); reject(error); };
        const ready = () => { server.off("error", failed); resolve(); };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(randomInt(49152, 65536), "127.0.0.1");
      });
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
    }
  }
  throw new Error("Unable to bind a browser-safe loopback test port");
}
