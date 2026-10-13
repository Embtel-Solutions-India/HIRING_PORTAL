// Prisma CLI settings (migrate / generate / studio). The running app connects in src/db.ts.
import { defineConfig } from "prisma/config";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env file: use the real environment */
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Migrations need a session-mode connection (Supabase: the :5432 pooler), not the transaction-mode pooler the app uses.
  datasource: { url: process.env.DIRECT_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5433/hirely" },
});
