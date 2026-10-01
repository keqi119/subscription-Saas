import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";

async function fixture(t, failExpansion = false, createResponseLost = false) {
  const workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), "snapshot-tool-test-"));
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));
  const calls = [];
  let sequence = 0;
  const containers = new Map();
  const runDocker = async (args, options = {}) => {
    calls.push({ args, input: options.input });
    assert.equal(args[2], "--host");
    assert.equal(args[3], "unix:///var/run/docker.sock");
    const command = args[4];
    let stdout = "";
    let exitCode = 0;
    if (command === "create") {
      const id = (++sequence).toString(16).padStart(64, "0");
      const tool = args
        .find((arg) => arg.startsWith("--entrypoint="))
        ?.slice("--entrypoint=".length);
      const mode =
        args.at(-1) === "--version"
          ? "version"
          : args.includes("--single-transaction")
            ? "restore"
            : tool === "/usr/bin/pg_dump"
              ? "dump"
              : "expand";
      containers.set(id, { mode, tool });
      if (createResponseLost) throw new Error("synthetic create response lost");
      stdout = `${id}\n`;
      assert.ok(args.includes("--pull=never"));
      assert.ok(
        mode === "version" || mode === "expand"
          ? args.includes("--network=none")
          : args.some((arg) => /^--network=container:[0-9a-f]{64}$/u.test(arg))
      );
      assert.ok(args.includes("--log-driver=none"));
      assert.ok(args.includes("--read-only"));
      assert.ok(args.includes("--cap-drop=ALL"));
      assert.ok(args.includes("--security-opt=no-new-privileges"));
      const mount = args.find((arg) => arg.startsWith("--mount="));
      if (mount) {
        const match = /^--mount=type=bind,src=(.+),dst=\/run\/secrets\/pgpass,readonly$/u.exec(
          mount
        );
        assert.ok(match);
        const stat = await lstat(match[1]);
        assert.equal(stat.mode & 0o777, 0o600);
        assert.match(await readFile(match[1], "utf8"), /^127\.0\.0\.1:5432:/u);
      }
      assert.ok(
        args.some((x) =>
          x.endsWith("@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0")
        )
      );
    } else if (command === "start") {
      const { mode, tool } = containers.get(args.at(-1));
      if (mode === "version")
        stdout = `${path.basename(tool)} (PostgreSQL) 17.11 (Debian 17.11-1.pgdg12+1)\n`;
      else if (failExpansion) exitCode = 1;
      else if (mode === "dump") stdout = "PGDMP\0fixture";
      else if (mode === "expand")
        stdout = "COPY public.customer (mobile) FROM stdin;\nsnap_example\n\\.\n";
    } else if (command === "inspect") {
      stdout = JSON.stringify({
        Running: false,
        Status: "exited",
        ExitCode: 0,
        OOMKilled: false,
        Error: ""
      });
    } else if (command === "rm") {
      const id = args.at(-1);
      containers.delete(id);
      stdout = `${id}\n`;
    } else if (command === "container") {
      assert.equal(args[5], "ls");
      stdout = args.some((arg) => arg.startsWith("name=")) ? [...containers.keys()].join("\n") : "";
    } else assert.fail(`unexpected command ${command}`);
    return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), signal: null };
  };
  return { workspaceDirectory, runDocker, calls, containers };
}

test("fixed archive expansion confines tooling and cleans its exact containers", async (t) => {
  const { expandPostgresSnapshotArchive } = await import("./snapshot-postgres-tools.mjs");
  const f = await fixture(t);
  const archive = Buffer.from("PGDMP\0synthetic compressed payload");
  const result = await expandPostgresSnapshotArchive(
    {
      archive,
      expectedArchiveDigest: sha256Bytes(archive),
      maxExpandedBytes: 1073741824
    },
    f
  );
  assert.equal(result.archiveDigest, sha256Bytes(archive));
  assert.equal(result.exitCode, 0);
  assert.match(result.pgRestoreVersion, /^pg_restore \(PostgreSQL\) 17\.11 /);
  assert.match(result.expandedBytes.toString("utf8"), /COPY public.customer/);
  assert.deepEqual(
    f.calls.filter((x) => x.input?.length).map((x) => x.input),
    [archive]
  );
  assert.equal(f.containers.size, 0);
  assert.deepEqual(await readdir(f.workspaceDirectory), []);
});

test("lost create response reconciles the owned container before returning failure", async (t) => {
  const { expandPostgresSnapshotArchive } = await import("./snapshot-postgres-tools.mjs");
  const f = await fixture(t, false, true);
  const archive = Buffer.from("PGDMP\0synthetic compressed payload");
  await assert.rejects(
    expandPostgresSnapshotArchive(
      {
        archive,
        expectedArchiveDigest: sha256Bytes(archive),
        maxExpandedBytes: 1073741824
      },
      f
    ),
    { code: "SNAPSHOT_ARCHIVE_TOOL_FAILED" }
  );
  assert.equal(f.containers.size, 0);
  const reconciliation = f.calls.find(({ args }) => args.some((arg) => arg.startsWith("name=")));
  assert.ok(reconciliation.args.some((arg) => arg.startsWith("label=stage1.snapshot-operation=")));
});

test("uncertain create without an owned readback remains a cleanup failure", async (t) => {
  const { expandPostgresSnapshotArchive } = await import("./snapshot-postgres-tools.mjs");
  const f = await fixture(t, false, true);
  const runDocker = async (args, options) => {
    if (args.some((arg) => arg.startsWith("name="))) {
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), signal: null };
    }
    return f.runDocker(args, options);
  };
  const archive = Buffer.from("PGDMP\0synthetic compressed payload");
  await assert.rejects(
    expandPostgresSnapshotArchive(
      {
        archive,
        expectedArchiveDigest: sha256Bytes(archive),
        maxExpandedBytes: 1073741824
      },
      { ...f, runDocker }
    ),
    (error) => {
      assert.equal(error.code, "SNAPSHOT_ARCHIVE_TOOL_CLEANUP_FAILED");
      assert.match(error.details.containerName, /^stage1-snapshot-tool-/);
      return true;
    }
  );
});

test("archive identity errors cannot start tooling and failed expansion still cleans", async (t) => {
  const { expandPostgresSnapshotArchive } = await import("./snapshot-postgres-tools.mjs");
  const f = await fixture(t, true);
  const archive = Buffer.from("PGDMP\0synthetic compressed payload");
  await assert.rejects(
    expandPostgresSnapshotArchive(
      {
        archive,
        expectedArchiveDigest: `sha256:${"0".repeat(64)}`,
        maxExpandedBytes: 1073741824
      },
      f
    ),
    { code: "SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID" }
  );
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    expandPostgresSnapshotArchive(
      {
        archive,
        expectedArchiveDigest: sha256Bytes(archive),
        maxExpandedBytes: 1073741824
      },
      f
    ),
    { code: "SNAPSHOT_ARCHIVE_TOOL_FAILED" }
  );
  assert.equal(f.containers.size, 0);
  assert.deepEqual(await readdir(f.workspaceDirectory), []);
});

test("source export pins the snapshot and never exposes its password in Docker arguments", async (t) => {
  const { createPostgresSnapshotToolCallbacks } = await import("./snapshot-postgres-tools.mjs");
  const f = await fixture(t);
  const password = "synthetic:secret\\part";
  const tool = createPostgresSnapshotToolCallbacks(
    {
      workspaceDirectory: f.workspaceDirectory,
      containerId: "a".repeat(64),
      databaseName: "staging_fixture",
      roleName: "snapshot_reader",
      password,
      purpose: "source"
    },
    { runDocker: f.runDocker }
  );
  const dump = await tool.exportDump({ snapshotId: "00000003-0000001A-1" });
  assert.equal(dump.subarray(0, 5).toString(), "PGDMP");
  const creates = f.calls.filter(({ args }) => args[4] === "create");
  assert.equal(creates.length, 2);
  const exportArgs = creates[1].args;
  assert.ok(exportArgs.includes("--snapshot=00000003-0000001A-1"));
  assert.ok(exportArgs.includes(`--network=container:${"a".repeat(64)}`));
  assert.ok(exportArgs.includes("--env=PGPASSFILE=/run/secrets/pgpass"));
  assert.ok(exportArgs.includes(`--user=${process.getuid()}:${process.getgid()}`));
  assert.ok(exportArgs.includes("--entrypoint=/usr/bin/pg_dump"));
  assert.equal(
    f.calls.some(({ args }) => args.join(" ").includes(password)),
    false
  );
  await assert.rejects(tool.exportDump({ snapshotId: "wrong" }), {
    code: "SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID"
  });
  assert.equal(f.containers.size, 0);
  assert.deepEqual(await readdir(f.workspaceDirectory), []);
});

test("workspace restore accepts bounded PGDMP and failure cleans credentials and containers", async (t) => {
  const { createPostgresSnapshotToolCallbacks } = await import("./snapshot-postgres-tools.mjs");
  const input = Buffer.from("PGDMP\0synthetic");
  const settings = (f) => ({
    workspaceDirectory: f.workspaceDirectory,
    containerId: "b".repeat(64),
    databaseName: "isolated_fixture",
    roleName: "snapshot_writer",
    password: "synthetic-password",
    purpose: "workspace"
  });
  const f = await fixture(t);
  const workspace = createPostgresSnapshotToolCallbacks(settings(f), { runDocker: f.runDocker });
  await workspace.restoreDump(input);
  const exportBytes = await workspace.exportDump();
  assert.equal(exportBytes.subarray(0, 5).toString(), "PGDMP");
  const restoreCreate = f.calls.find(
    ({ args }) => args[4] === "create" && args.includes("--single-transaction")
  );
  assert.ok(restoreCreate.args.includes("--exit-on-error"));
  assert.equal(
    restoreCreate.args.some((arg) => arg.startsWith("--snapshot=")),
    false
  );
  assert.ok(f.calls.some(({ args, input: stdin }) => args[4] === "start" && stdin?.equals(input)));
  assert.deepEqual(await readdir(f.workspaceDirectory), []);
  const failing = await fixture(t, true);
  const failedWorkspace = createPostgresSnapshotToolCallbacks(settings(failing), {
    runDocker: failing.runDocker
  });
  await assert.rejects(failedWorkspace.restoreDump(input), {
    code: "SNAPSHOT_ARCHIVE_TOOL_FAILED"
  });
  assert.equal(failing.containers.size, 0);
  assert.deepEqual(await readdir(failing.workspaceDirectory), []);
});
