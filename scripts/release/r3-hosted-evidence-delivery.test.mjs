import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as codec from "./r3-evidence-delivery.mjs";
import { openR3HostedEvidenceDelivery } from "./r3-hosted-evidence-delivery.mjs";

test("hosted adapter rejects caller-supplied path, host, key and process overrides before opening a key", async () => {
  const bytes = Buffer.from("{}");
  for (const extra of [
    { host: "127.0.0.1" },
    { sshPrivateKeyPath: "/tmp/other.key" },
    { privateKey: bytes },
    { command: "/tmp/sftp" },
    { io: {} }
  ]) {
    await assert.rejects(
      openR3HostedEvidenceDelivery({
        creationSpecBytes: bytes,
        jobAdmissionBytes: bytes,
        ...extra
      }),
      { code: "R3_HOSTED_EVIDENCE_DELIVERY_UNAVAILABLE" }
    );
  }
});

test("SFTP child inherits private download permissions while the parent mask is restored", async () => {
  const originalMask = process.umask(0o022);
  const bytes = Buffer.from("{}");
  const scope = {
    operationRef: "test-operation",
    expiresAt: new Date(Date.now() + 60000).toISOString()
  };
  const stat = (directory) => ({
    dev: 1n,
    ino: directory ? 2n : 3n,
    mode: directory ? 0o40700n : 0o100644n,
    uid: 0n,
    gid: 0n,
    nlink: 1n,
    size: 40n,
    mtimeNs: 1n,
    ctimeNs: 1n,
    isFile: () => !directory,
    isDirectory: () => directory,
    isSymbolicLink: () => false
  });
  let inheritedMask;
  try {
    mock.module("./r3-evidence-delivery.mjs", {
      namedExports: { ...codec, r3EvidenceScope: () => scope }
    });
    mock.module("./r3-operation-inputs.mjs", {
      namedExports: {
        readR3HostedOperationKey: async () => ({
          creationSpecBytes: bytes,
          jobAdmissionBytes: bytes,
          sshPrivateKeyPath: "/dev/shm/stage1-keys/test/forwarding.key",
          recheck: async () => {},
          close: async () => {}
        })
      }
    });
    mock.module("node:fs/promises", {
      defaultExport: {
        lstat: async (file) => stat(typeof file === "string" && file.endsWith("/transfer")),
        open: async () => ({
          stat: async () => stat(false),
          readFile: async () => "139.196.227.195 ssh-ed25519 AAAA\n",
          close: async () => {}
        })
      }
    });
    mock.method(childProcess, "spawn", (file) => {
      assert.equal(file, "/usr/bin/sftp");
      inheritedMask = process.umask();
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: (_text, callback) => {
          callback();
          queueMicrotask(() =>
            child.stdout.emit("data", Buffer.from("Remote working directory: /\n"))
          );
        },
        end: () => queueMicrotask(() => child.emit("close", 0, null))
      };
      child.kill = () => queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return child;
    });
    const { openR3HostedEvidenceDelivery: open } =
      await import("./r3-hosted-evidence-delivery.mjs?private-download-mask");
    const delivery = await open({ creationSpecBytes: bytes, jobAdmissionBytes: bytes });
    await delivery.close();
    assert.equal(inheritedMask, 0o077);
    assert.equal(process.umask(), 0o022);
  } finally {
    process.umask(originalMask);
    mock.restoreAll();
  }
});
