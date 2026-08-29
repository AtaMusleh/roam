import { defineConfig } from "prisma/config";

// Prisma 7 stopped loading .env automatically: the CLI reads whatever is on
// process.env when this file is evaluated, so the trip has to be made here.
// Next.js loads .env itself at runtime, so this only matters for CLI commands.
// On Vercel and other platforms there is no .env file — variables are already
// on process.env — so a missing file is expected, not an error.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file present; rely on platform-provided environment variables.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});