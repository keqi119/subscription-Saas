import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  verifyApiRuntimeDockerfile,
  verifyApiRuntimeFileInventory,
  verifyComposeRuntimeBoundary,
  verifyFormalCallerCutover
} from "./verify-api-runtime-image.mjs";

const repoRoot = new URL("../../", import.meta.url);

test("the API runtime contains only approved application capabilities", async () => {
  const [dockerfile, allowlist] = await Promise.all([
    read("Dockerfile.api"),
    readJson("release/contracts/api-runtime-allowlist.v1.json")
  ]);
  const result = verifyApiRuntimeDockerfile({ dockerfile, allowlist });
  assert.equal(result.status, "verified");
  assert.deepEqual(result.forbiddenCapabilities, []);
});

test("renaming a governance tool cannot bypass capability detection", async () => {
  const allowlist = await readJson("release/contracts/api-runtime-allowlist.v1.json");
  assert.throws(
    () =>
      verifyApiRuntimeDockerfile({
        allowlist,
        dockerfile: `FROM node:22-bookworm-slim AS runtime\nCOPY --from=build /app/node_modules/.bin/prisma /app/bin/schema-admin\n`
      }),
    { code: "API_RUNTIME_FORBIDDEN_CAPABILITY" }
  );
});

test("the exported API filesystem contains the application and Prisma Client only", async () => {
  const allowlist = await readJson("release/contracts/api-runtime-allowlist.v1.json");
  const result = verifyApiRuntimeFileInventory({
    allowlist,
    paths: [
      "app/apps/api/dist/src/main.js",
      "app/apps/api/node_modules/@prisma/client/package.json",
      "app/apps/api/node_modules/.pnpm/@prisma+client@7.8.0/node_modules/.prisma/client/index.js"
    ],
    packageNames: ["@prisma/client", "@nestjs/core"]
  });
  assert.equal(result.status, "verified");
});

test("a renamed Prisma CLI package remains forbidden in the exported filesystem", async () => {
  const allowlist = await readJson("release/contracts/api-runtime-allowlist.v1.json");
  assert.throws(
    () =>
      verifyApiRuntimeFileInventory({
        allowlist,
        paths: [
          "app/apps/api/dist/src/main.js",
          "app/apps/api/node_modules/@prisma/client/package.json",
          "app/apps/api/node_modules/.pnpm/@prisma+client@7.8.0/node_modules/.prisma/client/index.js",
          "app/bin/schema-admin",
          "app/apps/api/node_modules/prisma/package.json"
        ],
        packageNames: ["@prisma/client", "prisma"]
      }),
    { code: "API_RUNTIME_FORBIDDEN_CAPABILITY" }
  );
});

test("formal package commands use exact registered Runner entries", async () => {
  const [packageJson, inventory] = await Promise.all([
    readJson("package.json"),
    readJson("release/contracts/api-runtime-governance-inventory.v1.json")
  ]);
  const result = verifyFormalCallerCutover({ inventory, packageJson });
  assert.equal(result.status, "verified");
});

test("deployment Compose files do not mount governance scripts into API", async () => {
  const contents = await Promise.all([
    read("docker-compose.staging.example.yml"),
    read("docker-compose.staging.images.example.yml")
  ]);
  assert.equal(verifyComposeRuntimeBoundary(contents).status, "verified");
});

async function read(relativePath) {
  return readFile(new URL(relativePath, repoRoot), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await read(relativePath));
}
