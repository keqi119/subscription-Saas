// Internal browser package transport. Authority stays with the native release session.
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { load as loadYaml, JSON_SCHEMA } from "js-yaml";

const CODE = "R3_BROWSER_PACKAGES_INVALID";
const VERSION = "1.62.1";
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const PACKAGE_TIMEOUT_MS = 30_000;
const PACKAGES = [
  {
    name: "@playwright/test",
    filename: "test-1.62.1.tgz",
    url: "https://registry.npmjs.org/@playwright/test/-/test-1.62.1.tgz"
  },
  {
    name: "playwright",
    filename: "playwright-1.62.1.tgz",
    url: "https://registry.npmjs.org/playwright/-/playwright-1.62.1.tgz"
  },
  {
    name: "playwright-core",
    filename: "playwright-core-1.62.1.tgz",
    url: "https://registry.npmjs.org/playwright-core/-/playwright-core-1.62.1.tgz"
  }
];

const failure = () => Object.assign(new Error(CODE), { code: CODE });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function lockedPackages(lock) {
  if (
    !object(lock) ||
    lock.lockfileVersion !== "9.0" ||
    !object(lock.importers?.["."]?.devDependencies?.["@playwright/test"]) ||
    lock.importers["."].devDependencies["@playwright/test"].specifier !== VERSION ||
    lock.importers["."].devDependencies["@playwright/test"].version !== VERSION ||
    !object(lock.packages) ||
    !object(lock.snapshots) ||
    lock.snapshots["@playwright/test@1.62.1"]?.dependencies?.playwright !== VERSION ||
    lock.snapshots["playwright@1.62.1"]?.dependencies?.["playwright-core"] !== VERSION ||
    !object(lock.snapshots["playwright-core@1.62.1"])
  ) {
    throw failure();
  }

  return PACKAGES.map((entry) => {
    const packageRecord = lock.packages[`${entry.name}@${VERSION}`];
    const resolution = packageRecord?.resolution;
    const integrity = resolution?.integrity;
    if (
      !object(packageRecord) ||
      !object(resolution) ||
      Object.keys(resolution).length !== 1 ||
      typeof integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)
    ) {
      throw failure();
    }
    const expected = Buffer.from(integrity.slice(7), "base64");
    if (expected.length !== 64 || expected.toString("base64") !== integrity.slice(7))
      throw failure();
    return { ...entry, integrity, expected };
  });
}

async function downloadPackage(entry, fetchImpl, signal, remainingBytes) {
  if (signal?.aborted) throw failure();
  const controller = new globalThis.AbortController();
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const deadline = setTimeout(() => controller.abort(), PACKAGE_TIMEOUT_MS);
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(failure()), { once: true });
    if (controller.signal.aborted) reject(failure());
  });
  let reader;
  try {
    const response = await Promise.race([
      fetchImpl(entry.url, { redirect: "manual", signal: controller.signal }),
      aborted
    ]);
    if (response?.status !== 200 || response.redirected || !response.body?.getReader)
      throw failure();
    const header = response.headers?.get?.("content-length");
    if (
      header !== null &&
      header !== undefined &&
      (!/^(0|[1-9][0-9]*)$/u.test(header) ||
        Number(header) > Math.min(MAX_PACKAGE_BYTES, remainingBytes))
    ) {
      throw failure();
    }
    reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw failure();
      length += part.value.byteLength;
      if (length > MAX_PACKAGE_BYTES || length > remainingBytes) throw failure();
      chunks.push(Buffer.from(part.value));
    }
    if (length === 0 || (header !== null && header !== undefined && length !== Number(header))) {
      throw failure();
    }
    const bytes = Buffer.concat(chunks, length);
    const actual = createHash("sha512").update(bytes).digest();
    if (!timingSafeEqual(actual, entry.expected)) throw failure();
    return {
      name: entry.name,
      version: VERSION,
      filename: entry.filename,
      integrity: entry.integrity,
      bytes,
      digest: createHash("sha256").update(bytes).digest("hex")
    };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", forwardAbort);
    controller.abort();
    try {
      if (reader) void reader.cancel().catch(() => {});
    } catch {
      // An injected reader cannot delay or replace the generic failure.
    }
  }
}

export async function loadR3BrowserPackages({ repoRoot, signal, fetchImpl = globalThis.fetch }) {
  try {
    if (
      typeof repoRoot !== "string" ||
      repoRoot.length === 0 ||
      typeof fetchImpl !== "function" ||
      signal?.aborted
    ) {
      throw failure();
    }
    const lockPath = path.join(repoRoot, "pnpm-lock.yaml");
    const size = (await stat(lockPath)).size;
    if (size < 1 || size > MAX_LOCK_BYTES) throw failure();
    const lockBytes = await readFile(lockPath);
    if (lockBytes.length > MAX_LOCK_BYTES) throw failure();
    const entries = lockedPackages(loadYaml(lockBytes.toString("utf8"), { schema: JSON_SCHEMA }));
    const result = [];
    let totalBytes = 0;
    for (const entry of entries) {
      const item = await downloadPackage(entry, fetchImpl, signal, MAX_TOTAL_BYTES - totalBytes);
      result.push(item);
      totalBytes += item.bytes.length;
    }
    return result;
  } catch {
    throw failure();
  }
}
