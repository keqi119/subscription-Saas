import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import readline from "node:readline/promises";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";

const operationRef = randomUUID(),
  sessionId = randomUUID(),
  sessionNonce = "a".repeat(64);
const root = `/dev/shm/r3-caller-${operationRef}`;
const profile = {
  ownerId: "keqi119",
  storage: { archiveRoot: `${root}/archive`, journalRoot: `${root}/journal` }
};
const key = generateKeyPairSync("ed25519").publicKey;
const spec = { operationRef, phase: "source", chain: "fresh" };
const job = {
  expiresAt: new Date(Date.now() + 120000).toISOString(),
  host: { forwardingPublicKeyPem: key.export({ type: "spki", format: "pem" }) }
};
const events = [];
let answerMode = "correct";
const execution = {
  schemaVersion: "manual-operation-record.v3",
  kind: "execution",
  status: "SUCCEEDED",
  operationId: operationRef,
  sessionId,
  sessionNonce,
  reasonCode: null,
  promotionEligible: false
};
const executionBytes = encodeManualJson(execution),
  executionRecordDigest = sha256Bytes(executionBytes);
const acknowledgementBytes = encodeManualJson({
  schemaVersion: "manual-operation-record.v3",
  kind: "custody",
  purpose: "owner-acknowledgement",
  subjectDigest: executionRecordDigest,
  observedDigest: executionRecordDigest
});
const ackDigest = sha256Bytes(acknowledgementBytes);
const closedBytes = encodeManualJson({
  schemaVersion: "manual-operation-record.v3",
  kind: "session",
  status: "CLOSED",
  sessionId,
  sessionNonce,
  reasonCode: null,
  promotionEligible: false
});
const closedDigest = sha256Bytes(closedBytes);
const cleanupBytes = Buffer.from("signed cleanup fixture");
let sshChild,
  earlyExit = false;
const writeObject = (role, digest, bytes) =>
  fs.writeFile(`${profile.storage[`${role}Root`]}/objects/${digest.slice(7)}.json`, bytes, {
    mode: 0o600
  });

mock.module("./manual-stage1-trust.mjs", {
  namedExports: {
    loadFixedManualProfile: async () => profile,
    readFixedR3JobAdmission: async () => ({
      spec,
      admission: job,
      recheck: async () => {},
      close: async () => {}
    })
  }
});
mock.module("./launch-manual-stage1.mjs", {
  namedExports: {
    launchR3TargetCreate: async () => {
      events.push("launch");
      return {
        session: { sessionId, sessionNonce },
        async importHostedEvidence() {
          events.push("creation-import");
        },
        async provisionPostgres() {
          events.push("postgres");
        },
        async provisionDatabases() {
          events.push("databases");
        },
        async recordDestination() {
          events.push("destination");
        },
        async completeCreation() {
          events.push("creation-complete");
        },
        async runSourceManifest() {
          events.push("manifest");
          await writeObject("journal", executionRecordDigest, executionBytes);
          return { executionStatus: "SUCCEEDED", executionRecordDigest };
        },
        async acknowledgeSource(input) {
          events.push("owner-ack");
          assert.deepEqual(input, { executionRecordDigest });
          await writeObject("archive", ackDigest, acknowledgementBytes);
          return { acknowledgementRecordDigest: ackDigest };
        },
        async importHostedCleanupEvidence(bytes) {
          events.push("cleanup-import");
          assert.deepEqual(bytes, cleanupBytes);
          return { bundleDigest: sha256Bytes(bytes) };
        },
        async completeCleanup() {
          events.push("cleanup-complete");
        },
        async close() {
          events.push("native-close");
          await writeObject("journal", closedDigest, closedBytes);
          return closedDigest;
        }
      };
    }
  }
});
mock.module("./r3-h1-evidence-delivery.mjs", {
  namedExports: {
    openR3H1EvidenceDelivery: async () => ({
      async receiveCreation() {
        events.push("creation-receive");
        return Buffer.from("signed creation fixture");
      },
      async publishCleanupRequest(input) {
        events.push("cleanup-request");
        assert.deepEqual(input, { executionBytes, acknowledgementBytes });
      },
      async receiveCleanup() {
        events.push("cleanup-receive");
        return cleanupBytes;
      },
      async publishCleanupImported(input) {
        events.push("cleanup-imported");
        assert.equal(input.bundleDigest, sha256Bytes(cleanupBytes));
      },
      async publishClosed(input) {
        events.push("closed-delivery");
        assert.deepEqual(input.sessionBytes, closedBytes);
      },
      async close() {
        events.push("delivery-close");
      },
      recheck: async () => {}
    })
  }
});
mock.module("./r3-operation-inputs.mjs", {
  namedExports: {
    readR3HostedOperationKey: async () => ({
      creationSpecBytes: encodeManualJson(spec),
      jobAdmissionBytes: encodeManualJson(job),
      privateKey: "synthetic signing key handle",
      sshPrivateKeyPath: `${root}/forwarding.key`,
      async recheck() {
        events.push("key-recheck");
      },
      async close() {
        events.push("key-close");
      }
    })
  }
});
mock.module("./r3-hosted-creation-control.mjs", {
  namedExports: {
    openR3HostedCreationControl: async () => ({
      socketPath: `/dev/shm/stage1-keys/${operationRef.replaceAll("-", "")}.sock`,
      created: Promise.resolve(),
      postgresForward: Promise.resolve(),
      async exportEvidence() {
        events.push("creation-sign");
        return Buffer.from("signed creation fixture");
      },
      async cleanupOwnedTarget() {
        events.push("owned-cleanup");
      },
      async exportCleanupEvidence() {
        events.push("cleanup-sign");
        return cleanupBytes;
      },
      async close() {
        events.push("controller-close");
      }
    })
  }
});
mock.module("./r3-hosted-evidence-delivery.mjs", {
  namedExports: {
    openR3HostedEvidenceDelivery: async () => {
      events.push("sftp-ready");
      return {
        async sendCreation() {
          events.push("creation-send");
        },
        async receiveCleanupRequest() {
          events.push("request-receive");
        },
        async sendCleanup(bytes) {
          events.push("cleanup-send");
          assert.deepEqual(bytes, cleanupBytes);
        },
        async receiveCleanupImported() {
          events.push("imported-receive");
          if (earlyExit) {
            events.push("unexpected-forward-exit");
            sshChild.emit("close", 255, null);
          }
        },
        async receiveClosed() {
          events.push("closed-receive");
          assert.ok(events.includes("forward-exit"));
          return { sessionDigest: closedDigest };
        },
        async close() {
          events.push("sftp-close");
        }
      };
    }
  }
});

test("source fresh caller requires exact owner ACK before cleanup and publishes actual close readback", async (t) => {
  await fs.mkdir(root, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const value of Object.values(profile.storage)) {
    await fs.mkdir(value, { mode: 0o700 });
    await fs.mkdir(`${value}/objects`, { mode: 0o700 });
  }
  const blob = Buffer.concat([
    Buffer.from("0000000b7373682d6564323535313900000020", "hex"),
    key.export({ type: "spki", format: "der" }).subarray(-32)
  ]);
  const forwardKey = `${root}/authorized_keys`;
  await fs.writeFile(
    forwardKey,
    `restrict,port-forwarding,permitlisten="127.0.0.1:55440",permitlisten="127.0.0.1:55441" ssh-ed25519 ${blob.toString("base64")} r3-${operationRef}\n`,
    { mode: 0o644 }
  );
  const actualOpen = fs.open.bind(fs),
    actualLstat = fs.lstat.bind(fs);
  const mapped = (file) =>
    file === "/etc/ssh/stage1-r3-forward/authorized_keys" ? forwardKey : file;
  mock.method(fs, "open", (file, ...rest) => actualOpen(mapped(file), ...rest));
  mock.method(fs, "lstat", (file, ...rest) => actualLstat(mapped(file), ...rest));
  mock.method(childProcess, "execFile", (file, args, options, callback) => {
    events.push(file.endsWith("pgrep") ? "forward-process-absent" : "forward-ports-absent");
    queueMicrotask(() =>
      callback(file.endsWith("pgrep") ? { code: 1 } : null, Buffer.alloc(0), Buffer.alloc(0))
    );
    return { stdin: { end() {} } };
  });
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  t.after(() => {
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
    else delete process.stdin.isTTY;
    mock.restoreAll();
  });
  mock.method(readline, "createInterface", () => ({
    async question(prompt) {
      events.push("prompt");
      assert.ok(prompt.includes(executionRecordDigest));
      if (answerMode === "eof") throw new Error("EOF");
      return answerMode === "correct"
        ? `ACK ${executionRecordDigest}`
        : `ACK sha256:${"f".repeat(64)}`;
    },
    close() {}
  }));
  const { runR3SourceFreshH1 } = await import("./run-r3-source-fresh.mjs");
  const result = await runR3SourceFreshH1({ repoRoot: "/synthetic-h1", operationRef });
  assert.equal(result.status, "CLOSED");
  assert.equal(result.sessionRecordDigest, closedDigest);
  assert.deepEqual(events, [
    "launch",
    "creation-receive",
    "creation-import",
    "postgres",
    "databases",
    "destination",
    "creation-complete",
    "manifest",
    "prompt",
    "owner-ack",
    "cleanup-request",
    "cleanup-receive",
    "cleanup-import",
    "cleanup-imported",
    "forward-ports-absent",
    "forward-process-absent",
    "cleanup-complete",
    "native-close",
    "closed-delivery",
    "delivery-close"
  ]);
  for (const mode of ["wrong", "eof"]) {
    answerMode = mode;
    events.length = 0;
    await assert.rejects(runR3SourceFreshH1({ repoRoot: "/synthetic-h1", operationRef }), {
      code: "R3_SOURCE_FRESH_CALLER_INVALID"
    });
    assert.ok(events.includes("manifest"));
    assert.ok(events.includes("prompt"));
    assert.equal(events.includes("owner-ack"), false);
    assert.equal(events.includes("cleanup-import"), false);
    assert.equal(events.includes("cleanup-complete"), false);
    assert.equal(events.includes("closed-delivery"), false);
  }
});

test("hosted caller waits for imported cleanup and actual forward exit before CLOSED", async (t) => {
  await fs.mkdir(root, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => mock.restoreAll());
  mock.method(childProcess, "spawn", (file, args) => {
    assert.equal(file, "/usr/bin/ssh");
    assert.ok(args.includes("stage1-r3-forward@139.196.227.195"));
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    events.push("forward-start");
    sshChild = new EventEmitter();
    sshChild.stdout = new PassThrough();
    sshChild.stderr = new PassThrough();
    sshChild.kill = (signal) => {
      queueMicrotask(() => {
        events.push("forward-exit");
        sshChild.emit("close", null, signal);
      });
      return true;
    };
    return sshChild;
  });
  const { runR3SourceFreshHosted } = await import("./run-r3-source-fresh.mjs");
  const input = { repoRoot: path.resolve(import.meta.dirname, "../.."), operationRef };
  for (const name of ["forwarding.key", "signing-key.pem"])
    await fs.writeFile(`${root}/${name}`, "synthetic private file", { mode: 0o600 });
  events.length = 0;
  assert.equal((await runR3SourceFreshHosted(input)).status, "CLOSED");
  assert.deepEqual(
    events.filter((event) => !event.startsWith("key-")),
    [
      "sftp-ready",
      "forward-start",
      "creation-sign",
      "creation-send",
      "request-receive",
      "owned-cleanup",
      "cleanup-sign",
      "cleanup-send",
      "imported-receive",
      "forward-exit",
      "closed-receive",
      "sftp-close",
      "controller-close"
    ]
  );
  await assert.rejects(fs.lstat(`${root}/forwarding.key`), { code: "ENOENT" });
  for (const name of ["forwarding.key", "signing-key.pem"])
    await fs.writeFile(`${root}/${name}`, "synthetic private file", { mode: 0o600 });
  earlyExit = true;
  events.length = 0;
  await assert.rejects(runR3SourceFreshHosted(input), { code: "R3_SOURCE_FRESH_CALLER_INVALID" });
  assert.equal(events.includes("closed-receive"), false);
  assert.ok(events.includes("sftp-close"));
  assert.ok((await fs.lstat(`${root}/forwarding.key`)).isFile());
});
