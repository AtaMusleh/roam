import { defineConfig } from "prisma/config";

// Prisma 7 stopped loading .env automatically: the CLI reads whatever is on
// process.env when this file is evaluated, so the trip has to be made here.
// Next.js loads .env itself at runtime, so this only matters for CLI commands.
process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
