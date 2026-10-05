import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import * as tools from "./snapshot-postgres-tools.mjs";

async function fixture(t) {
  const workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), "snapshot-native-test-"));
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));
  const calls = [];
  const runNative = async (binary, args, options) => {
    calls.push({ binary, args, options });
    assert.ok(!args.join(" ").includes("synthetic:secret"));
    assert.ok(!JSON.stringify(options.env).includes("synthetic:secret"));
    assert.equal(options.env.PATH, "/usr/sbin:/usr/bin:/sbin:/bin");
    assert.equal(
      Object.keys(options.env).sort().join(","),
      options.env.PGPASSFILE ? "LANG,LC_ALL,PATH,PGPASSFILE" : "LANG,LC_ALL,PATH"
    );
    if (options.env.PGPASSFILE) {
      const passfile = options.env.PGPASSFILE;
      if (process.platform === "linux") assert.equal((await lstat(passfile)).mode & 0o777, 0o600);
      assert.match(await readFile(passfile, "utf8"), /^127\.0\.0\.1:55432:/u);
    }
    const stdout = args.includes("--version")
      ? Buffer.from(`${path.basename(binary)} (PostgreSQL) 17.11 (Debian)\n`)
      : binary.endsWith("pg_dump")
        ? Buffer.from("PGDMP\0fixture")
        : args.includes("--file=-")
          ? Buffer.from("COPY fixture\n")
          : Buffer.alloc(0);
    return { exitCode: 0, signal: null, stdout, stderr: Buffer.alloc(0), cleanupUnknown: false };
  };
  return { workspaceDirectory, calls, runNative, assertWorkspace: async () => {} };
}

test("native source dump uses loopback pgpass and no Docker or inherited secret", async (t) => {
  assert.equal(typeof tools.createNativePostgresSnapshotToolCallbacks, "function");
  const f = await fixture(t);
  const tool = tools.createNativePostgresSnapshotToolCallbacks(
    {
      workspaceDirectory: f.workspaceDirectory,
      port: 55432,
      databaseName: "stage1_fixture",
      roleName: "reader",
      password: "synthetic:secret",
      purpose: "source"
    },
    f
  );
  const dump = await tool.exportDump({ snapshotId: "00000003-0000001A-1" });
  assert.equal(dump.subarray(0, 5).toString(), "PGDMP");
  assert.deepEqual(
    f.calls.map((c) => c.binary),
    ["/usr/bin/pg_dump", "/usr/bin/pg_dump"]
  );
  assert.ok(f.calls[1].args.includes("--host=127.0.0.1"));
  assert.ok(f.calls[1].args.includes("--port=55432"));
  assert.ok(f.calls[1].args.includes("--snapshot=00000003-0000001A-1"));
  assert.deepEqual(await readdir(f.workspaceDirectory), []);
});

test("native restore and archive expansion preserve existing fixed operations", async (t) => {
  const f = await fixture(t);
  const archive = Buffer.from("PGDMP\0fixture");
  const tool = tools.createNativePostgresSnapshotToolCallbacks(
    {
      workspaceDirectory: f.workspaceDirectory,
      port: 55432,
      databaseName: "stage1_fixture",
      roleName: "writer",
      password: "synthetic:secret",
      purpose: "workspace"
    },
    f
  );
  await tool.restoreDump(archive);
  assert.ok(f.calls.some((c) => c.args.includes("--single-transaction")));
  assert.ok(f.calls.some((c) => c.options.input?.equals(archive)));
  const expanded = await tools.expandNativePostgresSnapshotArchive(
    {
      archive,
      expectedArchiveDigest: sha256Bytes(archive),
      maxExpandedBytes: 1073741824
    },
    f
  );
  assert.equal(expanded.expandedBytes.toString(), "COPY fixture\n");
  assert.deepEqual(await readdir(f.workspaceDirectory), []);
});

test("native failure removes passfile only after confirmed exit; unknown cleanup retains it", async (t) => {
  const f = await fixture(t);
  const settings = {
    workspaceDirectory: f.workspaceDirectory,
    port: 55432,
    databaseName: "stage1_fixture",
    roleName: "reader",
    password: "synthetic:secret",
    purpose: "source"
  };
  let passfile;
  const failed = tools.createNativePostgresSnapshotToolCallbacks(settings, {
    ...f,
    runNative: async (binary, args, options) => {
      if (args.includes("--version")) return f.runNative(binary, args, options);
      passfile = options.env.PGPASSFILE;
      if (process.platform === "linux") assert.equal((await lstat(passfile)).mode & 0o777, 0o600);
      return {
        exitCode: 1,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        cleanupUnknown: false
      };
    }
  });
  await assert.rejects(failed.exportDump({ snapshotId: "00000003-0000001A-1" }), {
    code: "SNAPSHOT_ARCHIVE_TOOL_FAILED"
  });
  await assert.rejects(lstat(passfile), { code: "ENOENT" });
  const unknown = tools.createNativePostgresSnapshotToolCallbacks(settings, {
    ...f,
    runNative: async (binary, args, options) => {
      if (args.includes("--version")) return f.runNative(binary, args, options);
      passfile = options.env.PGPASSFILE;
      return {
        exitCode: null,
        signal: "SIGKILL",
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        cleanupUnknown: true
      };
    }
  });
  await assert.rejects(
    unknown.exportDump({ snapshotId: "00000003-0000001A-1" }),
    (cause) => cause.code === "SNAPSHOT_ARCHIVE_TOOL_CLEANUP_FAILED" && cause.details.cleanupUnknown
  );
  if (process.platform === "linux") assert.equal((await lstat(passfile)).mode & 0o777, 0o600);
  else assert.ok(await lstat(passfile));
});
