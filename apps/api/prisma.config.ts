import path from "node:path";

import { defineConfig } from "prisma/config";

import { loadPrismaEnvironment } from "./prisma-env-policy";

loadPrismaEnvironment({ repositoryEnvPath: path.resolve(__dirname, "../../.env") });

export default defineConfig({
  datasource: {
    url: normalizeLocalhostDatabaseUrl(process.env["DATABASE_URL"])
  },
  migrations: {
    path: "prisma/migrations",
    seed: "node prisma/seed.mjs"
  },
  schema: "prisma/schema.prisma"
});

function normalizeLocalhostDatabaseUrl(databaseUrl?: string) {
  if (!databaseUrl) {
    return databaseUrl;
  }

  const url = new URL(databaseUrl);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}
