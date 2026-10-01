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
  sourceOperationRef = randomUUID(),
  sessionId = randomUUID(),
  sessionNonce = "a".repeat(64);
const root = `/dev/shm/r3-caller-${operationRef}`;
const profile = {
  ownerId: "keqi119",
  storage: { archiveRoot: `${root}/archive`, journalRoot: `${root}/journal` }
};
const key = generateKeyPairSync("ed25519").publicKey;
const spec = { operationRef, phase: "source", chain: "fresh" };
const d = (value) => `sha256:${value.repeat(64)}`;
const sourceGateEvidence = {
  schemaVersion: "source-gate-evidence.v1",
  sourceSha: "a".repeat(40),
  migrationCatalogDigest: d("1"),
  repositoryContractDigest: d("2"),
  databaseTestManifestDigest: d("3"),
  databaseTestDiscoveryDigest: d("4"),
  postgres: { imageDigest: d("5"), serverVersionNum: "170006" },
  chain: "fresh",
  counts: {
    collected: 2,
    selected: 2,
    executed: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
    todo: 0,
    filtered: 0,
    cancelled: 0
  },
  terminalStatus: "PASSED",
  schemaDiffDigest: d("6"),
  migrationStatusDigest: d("7"),
  postSchemaDigest: d("8"),
  sanitizedLogDigest: d("9"),
  provenance: {
    generatedAt: "2026-10-01T00:00:00.000Z",
    ciRunRef: "github://keqi119/subscription-Saas/actions/runs/123/attempts/1",
    executorVersion: "manual-r3-source-database-gate.v1"
  }
};
const sourceGateEvidenceBytes = encodeManualJson(sourceGateEvidence);
const outputFile = `${root}/output/source-fresh/source-gate-fresh.v1.json`;
const snapshotMetadata = {
  schemaVersion: "snapshot-metadata.v1",
  dumpDigest: d("1"),
  sourceMigrationHead: "20260925091000_stage1_operational_completion_settlement_guard",
  sourcePrivilegeObservationDigest: d("2"),
  sourceFingerprintBeforeDigest: d("3"),
  sourceFingerprintAfterDigest: d("3"),
  sanitizationContractDigest: d("4"),
  ownershipMapDigest: d("5"),
  ownershipContractVersion: "1",
  scanDigest: d("6"),
  scanSubjectDigest: d("1"),
  exportToolVersion: "fixture.v1",
  scanToolVersion: "fixture.v1",
  createdAt: "2026-09-27T00:00:00.000Z",
  reviewAt: "2026-09-27T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  owner: "owner",
  readers: ["reader"],
  accessPolicyRef: "fixture-policy",
  workflowRunRef: "fixture-run"
};
const snapshotMetadataBytes = encodeManualJson(snapshotMetadata);
const snapshotGate = {
  ...sourceGateEvidence,
  chain: "snapshot",
  snapshot: {
    snapshotMetadataDigest: sha256Bytes(snapshotMetadataBytes),
    snapshotBundleDigest: d("7"),
    sourceMigrationHead: snapshotMetadata.sourceMigrationHead,
    ownershipMapDigest: snapshotMetadata.ownershipMapDigest,
    ownershipObservationDigest: d("8")
  }
};
const snapshotGateBytes = encodeManualJson(snapshotGate);
const snapshotOutputFile = `${root}/output/source-snapshot/source-gate-snapshot.v1.json`;
const snapshotMetadataFile = `${root}/output/source-snapshot/snapshot-metadata.v1.json`;
const finalFreshOutputFile = `${root}/output/final-fresh/final-native-fresh.v1.json`;
const finalSnapshotOutputFile = `${root}/output/final-snapshot/final-native-snapshot.v1.json`;
const snapshotRef = randomUUID();
let snapshotSelectorValid = true;
const currentGate = () => (spec.chain === "snapshot" ? snapshotGate : sourceGateEvidence);
const currentGateBytes = () =>
  spec.chain === "snapshot" ? snapshotGateBytes : sourceGateEvidenceBytes;
const job = {
  expiresAt: new Date(Date.now() + 120000).toISOString(),
  host: { forwardingPublicKeyPem: key.export({ type: "spki", format: "pem" }) }
};
const events = [];
let answerMode = "correct";
let sourceClosedAt = "2026-10-01T00:00:00.000Z";
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
const sourceTerminalBytes = encodeManualJson({
  kind: "execution",
  stage: "candidate-use",
  status: "SUCCEEDED",
  operationId: sourceOperationRef
});
const sourceTerminalDigest = sha256Bytes(sourceTerminalBytes);
const finalRequestBytes = encodeManualJson({ phase: "final", operationId: operationRef });
const finalRequestDigest = sha256Bytes(finalRequestBytes);
const finalReconstructed = { publicFacts: { sourceGateEvidence } };
const finalResultBytes = encodeManualJson({
  schemaVersion: "manual-r3-final-result.v1",
  reconstructedDigest: sha256Bytes(encodeManualJson(finalReconstructed))
});
const finalResultDigest = sha256Bytes(finalResultBytes);
const finalExecutionBytes = encodeManualJson({
  ...execution,
  requestDigest: finalRequestDigest,
  resultDigest: finalResultDigest
});
const finalExecutionDigest = sha256Bytes(finalExecutionBytes);
const finalAcknowledgementBytes = encodeManualJson({
  kind: "custody",
  purpose: "owner-acknowledgement",
  subjectDigest: finalExecutionDigest
});
const finalAcknowledgementDigest = sha256Bytes(finalAcknowledgementBytes);
const finalEvidence = {
  schemaVersion: "final-native-evidence.v1",
  chain: "fresh",
  operationId: operationRef
};
const currentFinalEvidence = () => ({ ...finalEvidence, chain: spec.chain });
const currentFinalEvidenceBytes = () => encodeManualJson(currentFinalEvidence());
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
    }),
    readTrustedR3SourceCompletion: async (selector) => {
      events.push("source-history-open");
      assert.deepEqual(selector, {
        repoRoot: "/synthetic-h1",
        operationRef: sourceOperationRef,
        executionRecordDigest: sourceTerminalDigest
      });
      return {
        scope: { phase: "source", chain: spec.chain },
        closedAt: sourceClosedAt,
        executionRecordDigest: sourceTerminalDigest,
        sourceGateEvidence: currentGate(),
        sourceGateEvidenceDigest: sha256Bytes(currentGateBytes()),
        async recheck() {
          events.push("source-history-recheck");
        },
        async close() {
          events.push("source-history-close");
        }
      };
    },
    readTrustedR3FinalCompletion: async (selector) => {
      events.push("final-history-open");
      assert.deepEqual(selector, {
        repoRoot: "/synthetic-h1",
        operationRef,
        executionRecordDigest: finalExecutionDigest
      });
      return {
        attemptHistory: { selected: { terminalExecutionDigest: finalExecutionDigest } },
        async recheck() {
          events.push("final-history-recheck");
        },
        async close() {
          events.push("final-history-close");
        }
      };
    }
  }
});
mock.module("./r3-final-evidence.mjs", {
  namedExports: {
    validateR3FinalGateEvidence: (value) => {
      assert.deepEqual(value, currentFinalEvidence());
      return true;
    },
    buildR3FinalGateEvidence: (facts) => {
      events.push("final-project");
      assert.deepEqual(facts.request, JSON.parse(finalRequestBytes));
      assert.deepEqual(facts.execution, JSON.parse(finalExecutionBytes));
      assert.deepEqual(facts.result, JSON.parse(finalResultBytes));
      assert.deepEqual(facts.reconstructed, finalReconstructed);
      assert.deepEqual(facts.acknowledgement, JSON.parse(finalAcknowledgementBytes));
      assert.deepEqual(facts.sessionRecord, JSON.parse(closedBytes));
      assert.equal(facts.cleanupReceipt.status, "CLEANUP_OBSERVED");
      assert.equal(facts.attemptHistory.selected.terminalExecutionDigest, finalExecutionDigest);
      return currentFinalEvidence();
    }
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
          return { destinationDigest: d("d") };
        },
        async consumeSnapshot(selector) {
          events.push("snapshot-consume");
          assert.deepEqual(selector, {
            inputReference: snapshotRef,
            ...(spec.phase === "final"
              ? { matchingSourceEvidenceDigest: sourceTerminalDigest }
              : {})
          });
        },
        async fetchSnapshot() {
          events.push("snapshot-fetch");
        },
        async decryptSnapshot() {
          events.push("snapshot-decrypt");
        },
        async copySnapshot() {
          events.push("snapshot-copy");
        },
        async restoreSnapshot() {
          events.push("snapshot-restore");
        },
        async cleanupSnapshot() {
          events.push("snapshot-cleanup");
        },
        async completeSnapshot() {
          events.push("snapshot-complete");
        },
        async runSourceManifest() {
          events.push("manifest");
          await writeObject("journal", executionRecordDigest, executionBytes);
          return {
            executionStatus: "SUCCEEDED",
            executionRecordDigest,
            sourceGateEvidence: currentGate(),
            ...(spec.chain === "snapshot" ? { snapshotMetadata } : {})
          };
        },
        async runFinalManifest(selector) {
          events.push("final-manifest");
          assert.deepEqual(selector, {
            matchingSourceEvidenceDigest: sourceTerminalDigest,
            sourceGateEvidenceBytes: currentGateBytes()
          });
          await writeObject("journal", finalRequestDigest, finalRequestBytes);
          await writeObject("journal", finalExecutionDigest, finalExecutionBytes);
          await writeObject("archive", finalResultDigest, finalResultBytes);
          return {
            executionStatus: "SUCCEEDED",
            executionRecordDigest: finalExecutionDigest,
            reconstructed: finalReconstructed
          };
        },
        async acknowledgeSource(input) {
          events.push("owner-ack");
          assert.deepEqual(input, { executionRecordDigest });
          await writeObject("archive", ackDigest, acknowledgementBytes);
          return { acknowledgementRecordDigest: ackDigest };
        },
        async acknowledgeFinal(input) {
          events.push("final-owner-ack");
          assert.deepEqual(input, { executionRecordDigest: finalExecutionDigest });
          await writeObject("archive", finalAcknowledgementDigest, finalAcknowledgementBytes);
          return { acknowledgementRecordDigest: finalAcknowledgementDigest };
        },
        async importHostedCleanupEvidence(bytes) {
          events.push("cleanup-import");
          assert.deepEqual(bytes, cleanupBytes);
          return { bundleDigest: sha256Bytes(bytes) };
        },
        async completeCleanup() {
          events.push("cleanup-complete");
          return spec.phase === "final" ? { status: "CLEANUP_OBSERVED" } : undefined;
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
        assert.deepEqual(
          input,
          spec.phase === "final"
            ? {
                executionBytes: finalExecutionBytes,
                acknowledgementBytes: finalAcknowledgementBytes
              }
            : { executionBytes, acknowledgementBytes }
        );
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
        if (spec.phase === "final") {
          assert.deepEqual(input.finalNativeEvidenceBytes, currentFinalEvidenceBytes());
          return;
        }
        assert.deepEqual(input.sourceGateEvidenceBytes, currentGateBytes());
        assert.deepEqual(
          input.snapshotMetadataBytes,
          spec.chain === "snapshot" ? snapshotMetadataBytes : undefined
        );
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
          if (spec.phase === "final")
            return {
              sessionDigest: closedDigest,
              finalNativeEvidenceBytes: currentFinalEvidenceBytes(),
              finalNativeEvidenceDigest: sha256Bytes(currentFinalEvidenceBytes())
            };
          return {
            sessionDigest: closedDigest,
            sourceGateEvidenceBytes: currentGateBytes(),
            sourceGateEvidenceDigest: sha256Bytes(currentGateBytes()),
            ...(spec.chain === "snapshot"
              ? {
                  snapshotMetadataBytes,
                  snapshotMetadataDigest: sha256Bytes(snapshotMetadataBytes)
                }
              : {})
          };
        },
        async confirmClosedReceived() {
          events.push("closed-receipt");
          if (spec.phase === "final") {
            assert.deepEqual(
              await fs.readFile(
                spec.chain === "fresh" ? finalFreshOutputFile : finalSnapshotOutputFile
              ),
              currentFinalEvidenceBytes()
            );
            return;
          }
          assert.deepEqual(
            await fs.readFile(spec.chain === "snapshot" ? snapshotOutputFile : outputFile),
            currentGateBytes()
          );
          if (spec.chain === "snapshot")
            assert.deepEqual(await fs.readFile(snapshotMetadataFile), snapshotMetadataBytes);
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
      if (prompt.includes("SOURCE <sha256 digest>")) {
        events.push("source-selector");
        return `SOURCE ${sourceTerminalDigest}`;
      }
      if (prompt.includes("SNAPSHOT")) {
        events.push("snapshot-selector");
        assert.ok(prompt.includes(d("d")));
        return snapshotSelectorValid ? `SNAPSHOT ${snapshotRef}` : "SNAPSHOT ../foreign";
      }
      events.push("prompt");
      assert.ok(
        prompt.includes(spec.phase === "final" ? finalExecutionDigest : executionRecordDigest)
      );
      if (answerMode === "eof") throw new Error("EOF");
      return answerMode === "correct"
        ? `ACK ${spec.phase === "final" ? finalExecutionDigest : executionRecordDigest}`
        : `ACK sha256:${"f".repeat(64)}`;
    },
    close() {}
  }));
  const { runR3SourceFreshH1, runR3SourceSnapshotH1, runR3FinalFreshH1, runR3FinalSnapshotH1 } =
    await import("./run-r3-source-fresh.mjs");
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
  answerMode = "correct";
  spec.chain = "snapshot";
  t.after(() => {
    spec.chain = "fresh";
  });
  events.length = 0;
  await assert.rejects(runR3SourceFreshH1({ repoRoot: "/synthetic-h1", operationRef }));
  assert.equal(events.includes("launch"), false);
  assert.equal(
    (await runR3SourceSnapshotH1({ repoRoot: "/synthetic-h1", operationRef })).status,
    "CLOSED"
  );
  assert.deepEqual(
    events.slice(events.indexOf("creation-complete"), events.indexOf("manifest") + 1),
    [
      "creation-complete",
      "snapshot-selector",
      "snapshot-consume",
      "snapshot-fetch",
      "snapshot-decrypt",
      "snapshot-copy",
      "snapshot-restore",
      "snapshot-cleanup",
      "snapshot-complete",
      "manifest"
    ]
  );
  snapshotSelectorValid = false;
  events.length = 0;
  await assert.rejects(runR3SourceSnapshotH1({ repoRoot: "/synthetic-h1", operationRef }));
  assert.equal(events.includes("snapshot-consume"), false);
  assert.equal(events.includes("manifest"), false);
  snapshotSelectorValid = true;
  spec.phase = "final";
  t.after(() => {
    spec.phase = "source";
  });
  spec.chain = "fresh";
  await writeObject("journal", sourceTerminalDigest, sourceTerminalBytes);
  events.length = 0;
  assert.equal(
    (await runR3FinalFreshH1({ repoRoot: "/synthetic-h1", operationRef })).status,
    "CLOSED"
  );
  assert.ok(events.indexOf("source-history-close") < events.indexOf("launch"));
  assert.ok(events.indexOf("final-history-recheck") < events.indexOf("closed-delivery"));
  assert.ok(events.indexOf("final-project") < events.indexOf("closed-delivery"));
  assert.ok(events.includes("final-history-close"));
  spec.chain = "snapshot";
  events.length = 0;
  assert.equal(
    (await runR3FinalSnapshotH1({ repoRoot: "/synthetic-h1", operationRef })).status,
    "CLOSED"
  );
  assert.ok(events.indexOf("snapshot-consume") < events.indexOf("final-manifest"));
  spec.chain = "fresh";
  sourceClosedAt = null;
  events.length = 0;
  await assert.rejects(runR3FinalFreshH1({ repoRoot: "/synthetic-h1", operationRef }), {
    code: "R3_SOURCE_FRESH_CALLER_INVALID"
  });
  assert.equal(events.includes("launch"), false);
  sourceClosedAt = "2026-10-01T00:00:00.000Z";
  spec.phase = "source";
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
  const {
    runR3SourceFreshHosted,
    runR3SourceSnapshotHosted,
    runR3FinalFreshHosted,
    runR3FinalSnapshotHosted
  } = await import("./run-r3-source-fresh.mjs");
  const input = { repoRoot: path.resolve(import.meta.dirname, "../.."), operationRef };
  const outputRoot = path.join(input.repoRoot, ".release-output");
  const mapped = (file) =>
    typeof file === "string" && (file === outputRoot || file.startsWith(`${outputRoot}/`))
      ? `${root}/output${file.slice(outputRoot.length)}`
      : file;
  for (const method of ["open", "lstat", "mkdir", "chmod"]) {
    const actual = fs[method].bind(fs);
    mock.method(fs, method, (file, ...rest) => actual(mapped(file), ...rest));
  }
  for (const name of ["forwarding.key", "signing-key.pem"])
    await fs.writeFile(`${root}/${name}`, "synthetic private file", { mode: 0o600 });
  events.length = 0;
  const originalMask = process.umask(0o077);
  let result;
  try {
    result = await runR3SourceFreshHosted(input);
  } finally {
    process.umask(originalMask);
  }
  assert.equal(result.status, "CLOSED");
  assert.deepEqual(result.sourceGateEvidence, sourceGateEvidence);
  assert.equal(result.sourceGateEvidenceDigest, sha256Bytes(sourceGateEvidenceBytes));
  assert.equal(
    result.sourceGateEvidenceFile,
    path.join(outputRoot, "source-fresh/source-gate-fresh.v1.json")
  );
  assert.deepEqual(await fs.readFile(outputFile), sourceGateEvidenceBytes);
  assert.equal((await fs.lstat(path.dirname(outputFile))).mode & 0o777, 0o755);
  assert.equal((await fs.lstat(outputFile)).mode & 0o777, 0o644);
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
      "closed-receipt",
      "sftp-close",
      "controller-close"
    ]
  );
  await assert.rejects(fs.lstat(`${root}/forwarding.key`), { code: "ENOENT" });
  for (const name of ["forwarding.key", "signing-key.pem"])
    await fs.writeFile(`${root}/${name}`, "synthetic private file", { mode: 0o600 });
  // A previously created file cannot be overwritten or acknowledged away.
  events.length = 0;
  await assert.rejects(runR3SourceFreshHosted(input), { code: "R3_SOURCE_FRESH_CALLER_INVALID" });
  assert.equal(events.includes("closed-receipt"), false);
  assert.deepEqual(await fs.readFile(outputFile), sourceGateEvidenceBytes);
  assert.ok((await fs.lstat(`${root}/forwarding.key`)).isFile());
  earlyExit = true;
  events.length = 0;
  await assert.rejects(runR3SourceFreshHosted(input), { code: "R3_SOURCE_FRESH_CALLER_INVALID" });
  assert.equal(events.includes("closed-receive"), false);
  assert.ok(events.includes("sftp-close"));
  assert.ok((await fs.lstat(`${root}/forwarding.key`)).isFile());
  earlyExit = false;
  spec.chain = "snapshot";
  t.after(() => {
    spec.chain = "fresh";
  });
  events.length = 0;
  await assert.rejects(runR3SourceFreshHosted(input));
  assert.equal(events.includes("sftp-ready"), false);
  const snapshotResult = await runR3SourceSnapshotHosted(input);
  assert.equal(snapshotResult.status, "CLOSED");
  assert.deepEqual(snapshotResult.sourceGateEvidence, snapshotGate);
  assert.deepEqual(snapshotResult.snapshotMetadata, snapshotMetadata);
  assert.equal(
    snapshotResult.snapshotMetadataFile,
    path.join(outputRoot, "source-snapshot/snapshot-metadata.v1.json")
  );
  assert.deepEqual(await fs.readFile(snapshotOutputFile), snapshotGateBytes);
  assert.deepEqual(await fs.readFile(snapshotMetadataFile), snapshotMetadataBytes);
  assert.equal((await fs.lstat(snapshotMetadataFile)).mode & 0o777, 0o644);
  for (const name of ["forwarding.key", "signing-key.pem"])
    await fs.writeFile(`${root}/${name}`, "synthetic private file", { mode: 0o600 });
  // A blocked metadata write must not acknowledge even if the gate can be saved.
  await fs.unlink(snapshotOutputFile);
  events.length = 0;
  await assert.rejects(runR3SourceSnapshotHosted(input));
  assert.equal(events.includes("closed-receipt"), false);
  assert.ok((await fs.lstat(`${root}/forwarding.key`)).isFile());
  spec.phase = "final";
  spec.chain = "fresh";
  t.after(() => {
    spec.phase = "source";
  });
  events.length = 0;
  const finalFresh = await runR3FinalFreshHosted(input);
  assert.equal(finalFresh.status, "CLOSED");
  assert.deepEqual(await fs.readFile(finalFreshOutputFile), currentFinalEvidenceBytes());
  assert.ok(events.indexOf("closed-receive") < events.indexOf("closed-receipt"));
  assert.equal((await fs.lstat(finalFreshOutputFile)).mode & 0o777, 0o644);
  for (const name of ["forwarding.key", "signing-key.pem"])
    await fs.writeFile(`${root}/${name}`, "synthetic private file", { mode: 0o600 });
  events.length = 0;
  await assert.rejects(runR3FinalFreshHosted(input), { code: "R3_SOURCE_FRESH_CALLER_INVALID" });
  assert.equal(events.includes("closed-receipt"), false);
  assert.ok((await fs.lstat(`${root}/forwarding.key`)).isFile());
  spec.chain = "snapshot";
  events.length = 0;
  const finalSnapshot = await runR3FinalSnapshotHosted(input);
  assert.equal(finalSnapshot.status, "CLOSED");
  assert.deepEqual(await fs.readFile(finalSnapshotOutputFile), currentFinalEvidenceBytes());
});
