import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
      containers.set(id, args.at(-1) === "--version" ? "version" : "expand");
      if (createResponseLost) throw new Error("synthetic create response lost");
      stdout = `${id}\n`;
      assert.ok(args.includes("--pull=never"));
      assert.ok(args.includes("--network=none"));
      assert.ok(args.includes("--log-driver=none"));
      assert.ok(args.includes("--read-only"));
      assert.ok(args.includes("--cap-drop=ALL"));
      assert.ok(args.includes("--security-opt=no-new-privileges"));
      assert.ok(
        args.some((x) =>
          x.endsWith("@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0")
        )
      );
    } else if (command === "start") {
      const mode = containers.get(args.at(-1));
      if (mode === "version") stdout = "pg_restore (PostgreSQL) 17.11 (Debian 17.11-1.pgdg12+1)\n";
      else if (failExpansion) exitCode = 1;
      else stdout = "COPY public.customer (mobile) FROM stdin;\nsnap_example\n\\.\n";
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
