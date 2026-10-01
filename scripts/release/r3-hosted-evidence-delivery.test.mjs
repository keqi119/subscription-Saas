import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as codec from "./r3-evidence-delivery.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
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

test("SFTP keeps private download permissions and waits for explicit CLOSED receipt", async () => {
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
  const files = new Map(),
    scripts = [];
  const notice = Buffer.from("validated CLOSED fixture");
  const receipt = Buffer.from("exact CLOSED receipt fixture");
  const fileStat = (file) => ({
    ...stat(false),
    mode: 0o100600n,
    size: BigInt(files.get(file).length)
  });
  try {
    mock.module("./r3-evidence-delivery.mjs", {
      namedExports: {
        ...codec,
        r3EvidenceScope: () => scope,
        decodeR3CleanupRequest: () => ({ fixture: "request" }),
        decodeR3CleanupImported: () => ({ fixture: "imported" }),
        decodeR3Closed: ({ bytes: received }) => {
          assert.deepEqual(received, notice);
          return { sourceGateEvidenceBytes: Buffer.from("public evidence") };
        },
        encodeR3ClosedReceived: ({ closedBytes }) => {
          assert.deepEqual(closedBytes, notice);
          return receipt;
        }
      }
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
        lstat: async (file) =>
          files.has(file)
            ? fileStat(file)
            : stat(typeof file === "string" && file.endsWith("/transfer")),
        unlink: async (file) => {
          files.delete(file);
        },
        open: async (file) =>
          typeof file === "string"
            ? {
                stat: async () => fileStat(file),
                writeFile: async (data) => {
                  files.set(file, Buffer.from(data));
                },
                read: async (buffer, offset, length, position) => ({
                  bytesRead: files.get(file).copy(buffer, offset, position, position + length)
                }),
                sync: async () => {},
                close: async () => {}
              }
            : {
                stat: async () => stat(false),
                readFile: async () => "139.196.227.195 ssh-ed25519 AAAA\n",
                close: async () => {}
              }
      }
    });
    mock.method(childProcess, "spawn", (file) => {
      assert.equal(file, "/usr/bin/sftp");
      inheritedMask = process.umask();
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: (script, callback) => {
          scripts.push(script);
          const download = /^-get \/out\/[^ ]+ ([^\n]+)\n/u.exec(script);
          if (download) files.set(download[1], notice);
          if (script.includes("put ") && script.includes("closed-received.json")) {
            assert.deepEqual(files.get(script.split(" ")[1]), receipt);
          }
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
    await delivery.sendCreation(bytes);
    await delivery.receiveCleanupRequest();
    await delivery.sendCleanup(bytes);
    await delivery.receiveCleanupImported({ bundleDigest: sha256Bytes(bytes) });
    const closed = await delivery.receiveClosed();
    assert.deepEqual(closed.sourceGateEvidenceBytes, Buffer.from("public evidence"));
    assert.equal(
      scripts.some((script) => script.includes("closed-received.json")),
      false
    );
    // Mutating the returned value cannot alter the adapter's retained receipt.
    closed.sourceGateEvidenceBytes.fill(0);
    await delivery.confirmClosedReceived();
    assert.equal(scripts.filter((script) => script.includes("closed-received.json")).length, 1);
    await assert.rejects(delivery.confirmClosedReceived(), {
      code: "R3_HOSTED_EVIDENCE_DELIVERY_UNAVAILABLE"
    });
    await delivery.close();
    assert.equal(inheritedMask, 0o077);
    assert.equal(process.umask(), 0o022);
  } finally {
    process.umask(originalMask);
    mock.restoreAll();
  }
});
