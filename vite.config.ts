import { mkdirSync, writeFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/**
 * Dev-only: POST a PNG data URL to /__snapshot?name=x to save it under .debug/x.png.
 * Used to check rendering when the browser pane cannot be screenshotted.
 */
function snapshotPlugin(): Plugin {
  return {
    name: "debug-snapshot",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__snapshot", (req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const name = (new URL(req.url ?? "", "http://x").searchParams.get("name") ?? "snap").replace(/[^\w-]/g, "");
          mkdirSync(".debug", { recursive: true });
          writeFileSync(`.debug/${name}.png`, Buffer.from(body.replace(/^data:image\/png;base64,/, ""), "base64"));
          res.end("ok");
        });
      });
    },
  };
}

export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  server: { port: 5173 },
  plugins: [snapshotPlugin()],
});
