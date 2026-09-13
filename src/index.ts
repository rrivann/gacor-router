// gacor-router entrypoint — Hono on Bun.

import { Hono } from "hono";
import { env } from "./lib/env";
import { api } from "./api";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, name: "gacor-router" }));
app.route("/", api);

const server = Bun.serve({
  port: env.port,
  hostname: env.host,
  fetch: app.fetch,
});

console.log(`gacor-router listening on http://${env.host}:${server.port}`);
