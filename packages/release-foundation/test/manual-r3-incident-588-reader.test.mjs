import test from "node:test";
import { Buffer } from "node:buffer";
import process from "node:process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { encodeManualJson } from "../src/manual-stage1-contracts.mjs";
import { sha256Bytes as realBytes, sha256Canonical as realCanonical } from "../src/digest.mjs";

test(
  "fixed 588 closing incident reads signed disposition and original retired inodes only",
  {
    skip: process.platform !== "linux" || process.getuid?.() !== 0
  },
  async (t) => {
    const root = await fs.mkdtemp("/root/r3-incident-reader-");
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bytesByDigest = new Map();
    const canonicalByValue = new Map();
    const keyed = (value) => encodeManualJson(value).toString("hex");
    t.mock.module("../src/digest.mjs", {
      namedExports: {
        sha256Bytes: (bytes) =>
          bytesByDigest.get(Buffer.from(bytes).toString("hex")) ?? realBytes(bytes),
        sha256Canonical: (value) => canonicalByValue.get(keyed(value)) ?? realCanonical(value)
      }
    });
    t.mock.module("../../../scripts/release/r3-h1-forward-lease.mjs", {
      namedExports: {
        assessR3H1ForwardShutdown: ({ observationBytes }) =>
          assert.equal(JSON.parse(observationBytes).status, "VERIFIED")
      }
    });
    const incident = await import("../src/manual-r3-incident.mjs");
    const p = incident.APPROVED_R3_INCIDENT_588DA0DC;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const profile = {
      ownerId: p.ownerId,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      storage: {
        archiveRoot: path.join(root, "archive"),
        journalRoot: path.join(root, "journal")
      }
    };
    canonicalByValue.set(keyed(profile), p.profileDigest);
    const directories = [
      profile.storage.archiveRoot,
      profile.storage.journalRoot,
      path.join(profile.storage.archiveRoot, "objects"),
      path.join(profile.storage.journalRoot, "objects"),
      path.join(profile.storage.archiveRoot, "incidents"),
      path.join(profile.storage.archiveRoot, "incidents", p.operationRef),
      path.join(profile.storage.archiveRoot, "incidents", p.operationRef, "locks")
    ];
    for (const directory of directories) await fs.mkdir(directory, { mode: 0o700 });
    const write = async (file, bytes) => fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    const pinBytes = (bytes, digest) => {
      bytesByDigest.set(bytes.toString("hex"), digest);
      return bytes;
    };
    const graph = new Map();
    for (const [digest, role, value] of [
      [p.openingDigest, "journal", { kind: "session", sessionId: p.sessionId, status: "OPEN" }],
      [p.consumptionDigest, "journal", { kind: "consumption", operationId: p.operationRef }],
      [
        p.executionDigest,
        "journal",
        { kind: "execution", sessionId: p.sessionId, status: "INTERRUPTED_UNKNOWN" }
      ],
      [
        p.sessionDigest,
        "journal",
        { kind: "session", sessionId: p.sessionId, status: "INTERRUPTED_UNKNOWN" }
      ],
      [p.requestDigest, "archive", { kind: "request", operationId: p.operationRef }]
    ]) {
      const bytes = pinBytes(encodeManualJson(value), digest);
      graph.set(digest, { bytes, value });
      await write(
        path.join(profile.storage[`${role}Root`], "objects", `${digest.slice(7)}.json`),
        bytes
      );
    }
    const consumed = graph.get(p.consumptionDigest).value;
    const execution = graph.get(p.executionDigest).value;
    canonicalByValue.set(keyed(consumed), p.consumptionDigest);
    canonicalByValue.set(keyed(execution), p.executionDigest);
    const incidentRoot = path.join(profile.storage.archiveRoot, "incidents", p.operationRef);
    await write(
      path.join(incidentRoot, "proposal.json"),
      pinBytes(encodeManualJson({ approved: true }), p.proposalDigest)
    );
    await write(
      path.join(incidentRoot, "approval.json"),
      pinBytes(encodeManualJson({ user: p.ownerId }), p.approvalDigest)
    );
    const lockBytes = pinBytes(
      encodeManualJson({ sessionId: p.sessionId, pid: 309527 }),
      p.lockDigest
    );
    const locks = [];
    for (const name of p.lockNames) {
      const file = path.join(incidentRoot, "locks", name);
      await write(file, lockBytes);
      locks.push({
        name,
        digest: p.lockDigest,
        identity: incident.r3IncidentFileIdentity(await fs.lstat(file, { bigint: true }))
      });
    }
    const forward = encodeManualJson({ status: "VERIFIED" });
    const forwardDigest = realBytes(forward);
    await write(path.join(incidentRoot, `forward-${forwardDigest.slice(7)}.json`), forward);
    const seal = (record) =>
      encodeManualJson({
        record,
        signature: sign(
          null,
          Buffer.concat([
            Buffer.from("subscription-saas/r3-incident/v1\n"),
            encodeManualJson(record)
          ]),
          privateKey
        ).toString("base64")
      });
    const facts = {
      remoteCreationKnown: false,
      remoteCleanupVerified: false,
      promotionEligible: false,
      ownerProcessesAbsent: true,
      job: p.github,
      forwardShutdownDigest: forwardDigest,
      locks
    };
    const intentBytes = seal({
      schemaVersion: "manual-r3-incident-intent.v1",
      policyDigest: realCanonical(p),
      decision: "OWNER_ACCEPTED_UNRESOLVED_FAILURE",
      createdAt: "2026-10-07T02:01:00.000Z",
      ...facts
    });
    const dispositionBytes = seal({
      schemaVersion: "manual-r3-incident-disposition.v1",
      intentDigest: realBytes(intentBytes),
      status: "LOCAL_CHANNEL_SLOTS_RETIRED_WITH_OWNER_EXCEPTION",
      completedAt: "2026-10-07T02:02:00.000Z",
      ...facts
    });
    await write(path.join(incidentRoot, "intent.json"), intentBytes);
    await write(path.join(incidentRoot, "disposition.json"), dispositionBytes);
    const pinned = [];
    const environment = {
      profile,
      store: {
        checkedPath: (file) => fs.lstat(file, { bigint: true }),
        read: (file) => fs.readFile(file)
      },
      retainedLocks: [],
      stamp: () => "2026-10-07T02:03:00.000Z",
      capture: { pinIdentity: (file, identity) => pinned.push({ file, identity }) }
    };
    const read = () =>
      incident.readApprovedR3IncidentDisposition(environment, graph, p.openingDigest, [consumed]);
    const receipt = await read();
    assert.equal(receipt.status, "OWNER_ACCEPTED_UNRESOLVED_FAILURE");
    assert.equal(receipt.remoteCleanupVerified, false);
    assert.equal(pinned.length, 2);
    assert.equal(incident.matchesR3IncidentDisposition(receipt, consumed, execution), true);
    assert.equal(
      incident.matchesR3IncidentDisposition(
        receipt,
        { operationId: incident.APPROVED_R3_INCIDENT_0AF9C545.operationRef },
        execution
      ),
      false
    );
    const extra = "sha256:" + "f".repeat(64);
    graph.set(extra, {
      value: { kind: "session", sessionId: p.sessionId, status: "INTERRUPTED_UNKNOWN" }
    });
    await assert.rejects(read(), { code: "MANUAL_R3_INCIDENT_UNVERIFIED" });
    graph.delete(extra);
    await assert.rejects(
      incident.readApprovedR3IncidentDisposition(environment, graph, p.openingDigest, [
        { ...consumed, operationId: incident.APPROVED_R3_INCIDENT_0AF9C545.operationRef }
      ]),
      { code: "MANUAL_R3_INCIDENT_UNVERIFIED" }
    );
    await fs.rename(
      path.join(incidentRoot, "disposition.json"),
      path.join(incidentRoot, "incomplete.json")
    );
    await assert.rejects(read(), { code: "MANUAL_R3_INCIDENT_UNVERIFIED" });
  }
);
