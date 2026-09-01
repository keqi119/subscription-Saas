import { relative, resolve } from "node:path";
import { defineConfig } from "vitest/config";

import databaseTestManifest from "../../release/contracts/database-test-manifest.v1.json";

const repoRoot = resolve(__dirname, "../..");
const apiRoot = resolve(repoRoot, "apps/api");
const databaseTestFiles = databaseTestManifest.suites
  .filter((suite) => suite.runner === "vitest")
  .flatMap((suite) => suite.files)
  .map((file) => relative(apiRoot, resolve(repoRoot, file)).replaceAll("\\", "/"))
  .sort();

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        test: {
          environment: "node",
          exclude: databaseTestFiles,
          include: ["test/**/*.spec.ts"],
          name: "unit",
          sequence: {
            groupOrder: 0
          }
        }
      },
      {
        test: {
          environment: "node",
          fileParallelism: false,
          hookTimeout: 30_000,
          include: databaseTestFiles,
          name: "database",
          sequence: {
            groupOrder: 1
          },
          testTimeout: 30_000
        }
      }
    ]
  }
});
