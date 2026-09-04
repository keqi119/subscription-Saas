import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createInfrastructureChange } from "./create-infrastructure-change.mjs";

const script = fileURLToPath(new URL("./create-infrastructure-change.mjs", import.meta.url));
const schemaPath = "release/contracts/schemas/infrastructure-change.v1.schema.json";
const manifestPath = "release/contracts/repository-contract-files.v1.json";
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const git = (root, ...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

async function withRepo(callback) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "infrastructure-change-"));
  const root = path.join(temp, "checkout");
  try {
    await mkdir(root);
    git(temp, "init", "--bare", "origin.git");
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Local fixture");
    git(root, "config", "user.email", "fixture@example.invalid");
    git(root, "config", "core.autocrlf", "false");
    git(root, "config", "commit.gpgsign", "false");
    await mkdir(path.join(root, "release/contracts/schemas"), { recursive: true });
    await writeFile(
      path.join(root, schemaPath),
      await readFile(new URL(`../../${schemaPath}`, import.meta.url))
    );
    await writeFile(
      path.join(root, manifestPath),
      JSON.stringify({
        contractVersion: "repository-contract-files.v1",
        files: [manifestPath, schemaPath]
      })
    );
    git(root, "add", ".");
    git(root, "commit", "-m", "initial");
    const oldSha = git(root, "rev-parse", "HEAD");
    await writeFile(path.join(root, "README.md"), "merged main\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "merged main");
    const mainSha = git(root, "rev-parse", "HEAD");
    git(root, "remote", "add", "origin", path.join(temp, "origin.git"));
    git(root, "push", "origin", "main");
    git(root, "checkout", "--detach", mainSha);
    // A stale user's local main must not override the pinned Task0 source.
    git(root, "branch", "-f", "main", oldSha);
    await callback({
      root,
      mainSha,
      oldSha,
      options: {
        repoRoot: root,
        mainSha,
        ownerId: "owner-1",
        output: "record.json",
        now: new Date("2026-09-04T00:00:00.000Z")
      }
    });
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(temp, { recursive: true, force: true });
  }
}

test("creates canonical records from pinned origin/main with computed blob digest and unique 128-bit IDs", async () => {
  await withRepo(async ({ root, mainSha, options }) => {
    const first = await createInfrastructureChange(options);
    const second = await createInfrastructureChange({ ...options, output: "second.json" });
    assert.match(first.infrastructureChangeId, /^[0-9a-f]{32}$/);
    assert.match(second.infrastructureChangeId, /^[0-9a-f]{32}$/);
    assert.notEqual(first.infrastructureChangeId, second.infrastructureChangeId);
    const entries = [manifestPath, schemaPath].map((file) => ({
      path: file,
      sha256: hash(execFileSync("git", ["show", `${mainSha}:${file}`], { cwd: root }))
    }));
    // Hand-constructed RFC8785 representation for these ASCII fixture values.
    const identityBytes = `{"canonicalization":"RFC8785","catalogVersion":"repository-contract.v1","entries":${JSON.stringify(entries)}}`;
    assert.equal(first.repositoryContractDigest, hash(identityBytes));
    assert.equal(first.mainSha, mainSha);
    const ordered = Object.fromEntries(
      Object.entries(first).sort(([a], [b]) => a.localeCompare(b))
    );
    assert.equal(await readFile(path.join(root, "record.json"), "utf8"), JSON.stringify(ordered));
    assert.deepEqual(Object.keys(first).sort(), [
      "changeScope",
      "createdAt",
      "infrastructureChangeId",
      "mainSha",
      "ownerId",
      "repositoryContractDigest",
      "schemaVersion"
    ]);
    const bytes = await readFile(path.join(root, "record.json"), "utf8");
    await assert.rejects(createInfrastructureChange(options), {
      code: "INFRASTRUCTURE_CHANGE_EXISTS"
    });
    assert.equal(await readFile(path.join(root, "record.json"), "utf8"), bytes);
  });
});

for (const kind of [
  "malformed",
  "nonexistent",
  "old",
  "unmerged",
  "wrong-checkout",
  "dirty",
  "staged",
  "untracked-contract",
  "assume-unchanged",
  "missing-origin"
]) {
  test(`rejects ${kind} revision without writing`, async () => {
    await withRepo(async ({ root, options, oldSha }) => {
      let code = "INFRASTRUCTURE_CHANGE_MAIN_SHA_INVALID";
      if (kind === "malformed") {
        options.mainSha = "BAD";
        code = "INFRASTRUCTURE_CHANGE_ARGUMENT_INVALID";
      }
      if (kind === "nonexistent") options.mainSha = "f".repeat(40);
      if (kind === "old") options.mainSha = oldSha;
      if (kind === "unmerged") {
        await writeFile(path.join(root, "README.md"), "unmerged\n");
        git(root, "add", ".");
        git(root, "commit", "-m", "unmerged");
        options.mainSha = git(root, "rev-parse", "HEAD");
      }
      if (kind === "wrong-checkout") {
        git(root, "checkout", "--detach", oldSha);
        code = "INFRASTRUCTURE_CHANGE_REVISION_DIRTY";
      }
      if (["dirty", "staged", "assume-unchanged"].includes(kind)) {
        if (kind === "assume-unchanged")
          git(root, "update-index", "--assume-unchanged", schemaPath);
        await writeFile(
          path.join(root, schemaPath),
          (await readFile(path.join(root, schemaPath), "utf8")) + "\n"
        );
        if (kind === "staged") git(root, "add", schemaPath);
        code = "INFRASTRUCTURE_CHANGE_REVISION_DIRTY";
      }
      if (kind === "untracked-contract") {
        await writeFile(path.join(root, "release/contracts/untracked.json"), "{}");
        code = "CONTRACT_FILE_SET_DRIFT";
      }
      if (kind === "missing-origin") {
        git(root, "update-ref", "-d", "refs/remotes/origin/main");
        code = "INFRASTRUCTURE_CHANGE_MAIN_UNAVAILABLE";
      }
      const before = await readdir(root);
      await assert.rejects(createInfrastructureChange(options), { code });
      assert.deepEqual(await readdir(root), before);
    });
  });
}

test("CLI rejects missing, duplicate, unknown and valueless options before writes", async () => {
  await withRepo(async ({ root, mainSha }) => {
    const valid = ["--main-sha", mainSha, "--owner-id", "owner-1", "--output", "record.json"];
    const cases = [
      [],
      valid.slice(0, 4),
      valid.slice(2),
      [...valid.slice(0, 2), ...valid.slice(4)],
      [...valid, "--output", "other.json"],
      ["--main-sha", mainSha, "--owner-id", "owner", "--owner-id", "other"],
      [...valid.slice(0, 4), "--unknown", "record.json"],
      valid.slice(0, 5),
      [...valid.slice(0, 3), "--unknown-value", ...valid.slice(4)],
      [...valid.slice(0, 5), ""]
    ];
    for (const args of cases) {
      const before = await readdir(root);
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd: root,
        encoding: "utf8"
      });
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.match(result.stderr, /INFRASTRUCTURE_CHANGE_ARGUMENT_INVALID/);
      assert.deepEqual(await readdir(root), before);
    }
    const success = spawnSync(process.execPath, [script, ...valid], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).mainSha, mainSha);
  });
});
