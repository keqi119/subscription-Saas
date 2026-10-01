import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadR3BrowserPackages } from "./r3-browser-packages.mjs";

const { AbortController, AbortSignal, Response } = globalThis;

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NAMES = ["@playwright/test", "playwright", "playwright-core"];
const URLS = [
  "https://registry.npmjs.org/@playwright/test/-/test-1.62.1.tgz",
  "https://registry.npmjs.org/playwright/-/playwright-1.62.1.tgz",
  "https://registry.npmjs.org/playwright-core/-/playwright-core-1.62.1.tgz"
];
const bodies = NAMES.map((name) => Buffer.from(`fixture tarball for ${name}`));
const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

async function fixtureRoot(t, lockText) {
  const root = await mkdtemp(path.join(tmpdir(), "r3-browser-packages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "pnpm-lock.yaml"), lockText);
  return root;
}

function fixtureLock() {
  return `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      '@playwright/test':
        specifier: 1.62.1
        version: 1.62.1
packages:
  '@playwright/test@1.62.1':
    resolution: {integrity: ${integrity(bodies[0])}}
  playwright@1.62.1:
    resolution: {integrity: ${integrity(bodies[1])}}
  playwright-core@1.62.1:
    resolution: {integrity: ${integrity(bodies[2])}}
snapshots:
  '@playwright/test@1.62.1':
    dependencies:
      playwright: 1.62.1
  playwright@1.62.1:
    dependencies:
      playwright-core: 1.62.1
  playwright-core@1.62.1: {}
`;
}

test("loads only the three pinned packages with verified bytes and fixed registry URLs", async (t) => {
  const repoRoot = await fixtureRoot(t, fixtureLock());
  const requested = [];
  const packages = await loadR3BrowserPackages({
    repoRoot,
    fetchImpl: async (url, options) => {
      const index = requested.length;
      requested.push({ url, options });
      return new Response(bodies[index], { status: 200 });
    }
  });

  assert.deepEqual(
    requested.map(({ url }) => url),
    URLS
  );
  for (const { options } of requested) {
    assert.equal(options.redirect, "manual");
    assert.equal(options.signal instanceof AbortSignal, true);
    assert.equal(Object.hasOwn(options, "headers"), false);
  }
  assert.deepEqual(
    packages.map(({ name, version, filename, integrity: sri, bytes, digest }) => ({
      name,
      version,
      filename,
      integrity: sri,
      bytes,
      digest
    })),
    NAMES.map((name, index) => ({
      name,
      version: "1.62.1",
      filename: `${index === 0 ? "test" : name}-1.62.1.tgz`,
      integrity: integrity(bodies[index]),
      bytes: bodies[index],
      digest: createHash("sha256").update(bodies[index]).digest("hex")
    }))
  );
});

test("rejects malformed real lock metadata before any package request", async (t) => {
  const realLock = await readFile(path.join(SOURCE_ROOT, "pnpm-lock.yaml"), "utf8");
  const variants = [
    realLock.replace(
      "specifier: 1.62.1\n        version: 1.62.1",
      "specifier: 1.62.1\n        version: 1.62.2"
    ),
    realLock.replace("playwright: 1.62.1\n", "playwright: 1.62.2\n"),
    realLock.replace(
      "resolution: {integrity: sha512-DTcUc8qii+cpHvtOwggMtBRMjKZHXYWdw8syRYu2vtzuq4Wxphqq4NfCs5Zt44L6mA8rfDfj+PHnxFc/FeK6mQ==}",
      "resolution: {integrity: sha512-invalid, tarball: https://example.test/other.tgz}"
    ),
    `${realLock}\nlockfileVersion: '9.0'\n`
  ];
  for (const lockText of variants) {
    assert.notEqual(lockText, realLock);
    const repoRoot = await fixtureRoot(t, lockText);
    await assert.rejects(
      loadR3BrowserPackages({
        repoRoot,
        fetchImpl: () => {
          throw new Error("fetch should not run");
        }
      }),
      { code: "R3_BROWSER_PACKAGES_INVALID" }
    );
  }
});

test("rejects redirects, oversized bodies, tampered tarballs, and a preaborted request", async (t) => {
  const repoRoot = await fixtureRoot(t, fixtureLock());
  const cases = [
    () => new Response(null, { status: 302, headers: { location: "https://example.test/" } }),
    () => new Response(Buffer.alloc(8 * 1024 * 1024 + 1), { status: 200 }),
    () => new Response(Buffer.from("tampered"), { status: 200 })
  ];
  for (const response of cases) {
    await assert.rejects(
      loadR3BrowserPackages({
        repoRoot,
        fetchImpl: () => response()
      }),
      { code: "R3_BROWSER_PACKAGES_INVALID" }
    );
  }
  const controller = new AbortController();
  controller.abort();
  let abortedFetchCalls = 0;
  await assert.rejects(
    loadR3BrowserPackages({
      repoRoot,
      signal: controller.signal,
      fetchImpl: () => {
        abortedFetchCalls++;
        return new Response(bodies[0], { status: 200 });
      }
    }),
    { code: "R3_BROWSER_PACKAGES_INVALID" }
  );
  assert.equal(abortedFetchCalls, 0);
});
