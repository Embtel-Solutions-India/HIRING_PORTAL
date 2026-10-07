// Local Postgres for development without Docker: `npm run dev:db` (keeps running; Ctrl+C to stop).
import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs";

const dir = new URL("../.dev-db", import.meta.url).pathname;
const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port: 5433, persistent: true });

if (!fs.existsSync(dir)) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase("hirely");
} catch {
  /* already exists */
}
console.log("Postgres running on postgres://postgres:postgres@localhost:5433/hirely  (Ctrl+C to stop)");
const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
