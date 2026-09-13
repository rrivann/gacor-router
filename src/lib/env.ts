// gacor-router env helpers. Single-user, local-first: defaults are sane,
// everything overridable via env or .env file (Bun loads .env automatically).

export const env = {
  port: Number(process.env.PORT ?? 7788),
  host: process.env.HOST ?? "127.0.0.1",
  dbPath: process.env.DB_PATH ?? "./gacor.db",
};
