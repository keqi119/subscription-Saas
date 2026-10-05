// Read-only, fixed closure for the H1 private worker. No package installation or execution.
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { SNAPSHOT_POSTGRES_TOOL_IMAGE } from "./snapshot-postgres-tools.mjs";

const NODE_SHA256 = "fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48";
const LIMIT_BYTES = 32 * 1024 * 1024;
const LIMIT_FILE = 4 * 1024 * 1024;
const LIMIT_COUNT = 2000;
// The pinned ali-oss dependency closure adds 2,000 files to the control bundle.
// Worker limits and its unchanged installed bytes remain separate.
const CONTROL_LIMIT_COUNT = 4096;
const worker = "scripts/release/snapshot-h1-data-worker.mjs";
const fixedFiles = [
  "apps/api/package.json",
  "release/contracts/sanitization-contract.v1.json",
  "release/contracts/snapshot-ownership-map.v1.json",
  "release/contracts/policies/snapshot-object-addressing.v2.json"
];
const allowedSource = (name) =>
  name.endsWith(".mjs") &&
  (name.startsWith("scripts/release/") || name.startsWith("packages/release-foundation/src/"));
const fail = (code) => {
  throw new Error(code);
};
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function safePath(name) {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9@_./+-]+$/u.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((part) => !part || part === "." || part === "..") ||
    path.posix.normalize(name) !== name
  )
    fail("H1_BUNDLE_PATH_INVALID");
  return name;
}

export async function buildH1SnapshotRuntimeBundle(repoRoot) {
  return buildFixedRuntime(repoRoot, false);
}

export async function buildH1SnapshotControlRuntimeBundle(repoRoot) {
  return buildFixedRuntime(repoRoot, true);
}

async function buildFixedRuntime(repoRoot, control) {
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) fail("H1_BUNDLE_ROOT_INVALID");
  const root = await realpath(repoRoot);
  if (!(await lstat(root)).isDirectory()) fail("H1_BUNDLE_ROOT_INVALID");
  const encoded = new Map();
  const inventory = new Map();
  const packageVersions = new Map();
  const sourceSeen = new Set();
  let total = 0;
  const within = (candidate) => candidate === root || candidate.startsWith(root + path.sep);

  async function rootFile(name) {
    safePath(name);
    const nominal = path.join(root, ...name.split("/"));
    const resolved = await realpath(nominal);
    if (!within(resolved)) fail("H1_BUNDLE_ESCAPE");
    if (!(await lstat(nominal)).isFile() || nominal !== resolved) fail("H1_BUNDLE_SYMLINK");
    return resolved;
  }

  async function addFile(source, destination) {
    safePath(destination);
    if (encoded.has(destination)) fail("H1_BUNDLE_DUPLICATE");
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT_FILE)
      fail("H1_BUNDLE_FILE_INVALID");
    const bytes = await readFile(source);
    if (
      bytes.length > LIMIT_FILE ||
      encoded.size >= (control ? CONTROL_LIMIT_COUNT : LIMIT_COUNT) ||
      total + bytes.length > LIMIT_BYTES
    )
      fail("H1_BUNDLE_LIMIT");
    total += bytes.length;
    encoded.set(destination, bytes.toString("base64"));
    inventory.set(destination, {
      path: destination,
      sha256: sha256Bytes(bytes),
      sizeBytes: bytes.length
    });
    return bytes;
  }

  async function addRootFile(name) {
    return addFile(await rootFile(name), name);
  }

  async function rootDirectory(name) {
    safePath(name);
    const nominal = path.join(root, ...name.split("/"));
    const resolved = await realpath(nominal);
    if (!within(resolved) || resolved !== nominal || !(await lstat(nominal)).isDirectory())
      fail("H1_BUNDLE_SYMLINK");
    return resolved;
  }

  async function source(name) {
    if (!allowedSource(name)) fail("H1_BUNDLE_SOURCE_INVALID");
    if (sourceSeen.has(name)) return;
    sourceSeen.add(name);
    const contents = (await addRootFile(name)).toString("utf8");
    const dynamicImports = [...contents.matchAll(/\bimport\s*\(([^)]*)\)/gu)];
    if (
      dynamicImports.length &&
      (name !== "scripts/release/export-sanitized-snapshot.mjs" ||
        dynamicImports.length !== 1 ||
        dynamicImports[0][1] !== "trustedAdapterUrl")
    )
      fail("H1_BUNDLE_DYNAMIC_IMPORT");
    const imports = [...contents.matchAll(/\b(?:from\s*|import\s*)["']([^"']+)["']/gu)];
    for (const match of imports) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      if (specifier === "canonicalize" || specifier === "ajv/dist/2020.js") continue;
      if (!specifier.startsWith(".")) fail("H1_BUNDLE_IMPORT_INVALID");
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
      if (!allowedSource(dependency)) fail("H1_BUNDLE_SOURCE_INVALID");
      await source(dependency);
    }
  }

  async function tree(directory, destination, keep = () => true) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const sourcePath = path.join(directory, entry.name);
      const targetPath = `${destination}/${entry.name}`;
      if (entry.isSymbolicLink()) fail("H1_BUNDLE_SYMLINK");
      if (entry.isDirectory()) await tree(sourcePath, targetPath, keep);
      else if (entry.isFile() && keep(entry.name)) await addFile(sourcePath, targetPath);
      else if (!entry.isFile()) fail("H1_BUNDLE_FILE_INVALID");
    }
  }

  async function dependency(packageDirectory) {
    const packageRoot = await realpath(packageDirectory);
    if (!within(packageRoot)) fail("H1_BUNDLE_ESCAPE");
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (
      typeof manifest.name !== "string" ||
      typeof manifest.version !== "string" ||
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(manifest.name)
    )
      fail("H1_BUNDLE_PACKAGE_INVALID");
    if (packageVersions.has(manifest.name)) {
      if (packageVersions.get(manifest.name) !== manifest.version)
        fail("H1_BUNDLE_PACKAGE_CONFLICT");
      return;
    }
    packageVersions.set(manifest.name, manifest.version);
    await tree(
      packageRoot,
      `node_modules/${manifest.name}`,
      (name) =>
        !name.endsWith(".map") &&
        !name.endsWith(".ts") &&
        !name.endsWith(".test.js") &&
        !name.endsWith(".spec.js")
    );
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies
    })) {
      // OpenAPI's generated SDK declares several versions of Node compiler
      // types as dependencies. This JS-only bundle already excludes .ts files;
      // those type packages (and their undici-types closure) have no runtime code.
      if (control && name === "@types/node") continue;
      let cursor = packageRoot;
      let found;
      while (within(cursor)) {
        try {
          found = await realpath(path.join(cursor, "node_modules", name));
          break;
        } catch {
          cursor = path.dirname(cursor);
        }
      }
      if (!found && manifest.optionalDependencies?.[name]) continue;
      if (!found || !within(found)) fail("H1_BUNDLE_DEPENDENCY_MISSING");
      await dependency(found);
    }
  }

  for (const entry of control
    ? [
        "scripts/release/snapshot-h1-dispatch-journal.mjs",
        "scripts/release/snapshot-h1-signing.mjs",
        "scripts/release/snapshot-h1-admit.mjs",
        "scripts/release/snapshot-h1-authority.mjs",
        "scripts/release/snapshot-h1-observations.mjs",
        "scripts/release/evidence-archive-storage.mjs",
        "scripts/release/snapshot-h1-github-reader.mjs"
      ]
    : [worker])
    await source(entry);
  for (const name of fixedFiles) await addRootFile(name);
  if (control) {
    for (const name of ["manual-stage1-profile.v2.json", "manual-stage1-owner-binding.v1.json"])
      await addRootFile(`release/contracts/${name}`);
    for (const name of [
      "snapshot-h1-github-query.py",
      "snapshot-h1-github.py",
      "snapshot-h1-route-journal.py"
    ])
      await addRootFile(`scripts/release/${name}`);
  }
  await tree(await rootDirectory("release/contracts/schemas"), "release/contracts/schemas");
  for (const name of [
    ...(control
      ? ["apps/api/node_modules/ali-oss", "apps/api/node_modules/@alicloud/openapi-client"]
      : ["apps/api/node_modules/pg"]),
    "packages/release-foundation/node_modules/ajv",
    "packages/release-foundation/node_modules/canonicalize"
  ])
    await dependency(path.join(root, ...name.split("/")));

  const manifest = {
    format: control ? "stage1-h1-control-runtime/v1" : "stage1-h1-worker-runtime/v1",
    nodeSha256: NODE_SHA256,
    postgresImage: SNAPSHOT_POSTGRES_TOOL_IMAGE,
    packages: [...packageVersions]
      .map(([name, version]) => ({ name, version }))
      .sort((a, b) => order(a.name, b.name)),
    files: [...inventory.values()].sort((a, b) => order(a.path, b.path))
  };
  return {
    bundleDigest: sha256Canonical(manifest),
    manifest,
    files: Object.fromEntries([...encoded].sort(([a], [b]) => order(a, b)))
  };
}
