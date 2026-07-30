import path from "node:path";

import { config } from "dotenv";
import { defineConfig } from "prisma/config";

config({ path: path.resolve(__dirname, "../../.env") });
config();

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
