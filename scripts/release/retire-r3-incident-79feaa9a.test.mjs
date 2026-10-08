import test from "node:test";
import { Buffer } from "node:buffer";
import process from "node:process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import childProcess from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import * as incident from "../../packages/release-foundation/src/manual-r3-incident.mjs";

test(
  "fixed 79fe retirement preserves its real closing and resumes only the signed original intent",
  {
    skip: process.platform !== "linux" || process.getuid?.() !== 0
  },
  async (t) => {
    const root = await fs.mkdtemp("/root/r3-incident-test-");
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const keys = generateKeyPairSync("ed25519");
    const profile = {
      ownerId: "test-owner",
      publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
      keyFingerprint: sha256Bytes(keys.publicKey.export({ type: "spki", format: "der" })),
      storage: {
        archiveRoot: path.join(root, "archive"),
        journalRoot: path.join(root, "journal"),
        keyRoot: path.join(root, "keys"),
        keyRef: "key.pem"
      }
    };
    for (const dir of [
      "archive",
      "archive/objects",
      "journal",
      "journal/objects",
      "journal/locks",
      "keys"
    ])
      await fs.mkdir(path.join(root, dir), { mode: 0o700 });
    const write = (file, bytes) => fs.writeFile(file, bytes, { mode: 0o600, flag: "wx" });
    await write(
      path.join(root, "keys/key.pem"),
      keys.privateKey.export({ type: "pkcs8", format: "pem" })
    );
    const proposal = encodeManualJson({ approved: true }),
      approval = encodeManualJson({ user: "test-owner" });
    const sessionId = "70000000-0000-4000-8000-000000000001";
    const lockBytes = encodeManualJson({ sessionId, pid: 492654 });
    const p = {
      ...incident.APPROVED_R3_INCIDENT_79FEAA9A,
      profileDigest: sha256Canonical(profile),
      ownerId: profile.ownerId,
      sessionId,
      proposalDigest: sha256Bytes(proposal),
      approvalDigest: sha256Bytes(approval),
      lockDigest: sha256Bytes(lockBytes)
    };
    for (const [field, role] of [
      ["openingDigest", "journal"],
      ["consumptionDigest", "journal"],
      ["executionDigest", "journal"],
      ["sessionDigest", "journal"],
      ["requestDigest", "archive"]
    ]) {
      const bytes = encodeManualJson({
        field,
        kind:
          field === "openingDigest" || field === "sessionDigest"
            ? "session"
            : field === "executionDigest"
              ? "execution"
              : "request",
        sessionId,
        status: field === "openingDigest" ? "OPEN" : "INTERRUPTED_UNKNOWN"
      });
      p[field] = sha256Bytes(bytes);
      await write(
        path.join(profile.storage[`${role}Root`], "objects", `${p[field].slice(7)}.json`),
        bytes
      );
    }
    const incidentRoot = path.join(profile.storage.archiveRoot, "incidents", p.operationRef);
    await fs.mkdir(path.dirname(incidentRoot), { mode: 0o700 });
    await fs.mkdir(incidentRoot, { mode: 0o700 });
    await write(path.join(incidentRoot, "proposal.json"), proposal);
    await write(path.join(incidentRoot, "approval.json"), approval);
    for (const name of p.lockNames)
      await write(path.join(profile.storage.journalRoot, "locks", name), lockBytes);
    const originalIdentities = await Promise.all(
      p.lockNames.map(async (name) =>
        incident.r3IncidentFileIdentity(
          await fs.lstat(path.join(profile.storage.journalRoot, "locks", name), { bigint: true })
        )
      )
    );
    p.lockIdentities = Object.fromEntries(
      p.lockNames.map((name, index) => [name, originalIdentities[index]])
    );
    const globalLock = "/run/stage1-github-app-convert.lock",
      localLock = path.join(root, "global.lock");
    await write(localLock, "");
    const stat = await fs.stat(localLock, { bigint: true });
    const major = ((stat.dev >> 8n) & 0xfffn) | ((stat.dev >> 32n) & 0xfffff000n);
    const minor = (stat.dev & 0xffn) | ((stat.dev >> 12n) & 0xffffff00n);
    const mapping = (file) => (file === globalLock ? localLock : file);
    let held = true,
      secondMoveFails = true,
      moveCount = 0,
      foreignJob = false,
      sftpResidue = false;
    const realFs = { ...fs },
      realExec = childProcess.execFile;
    const evidenceKey = "/etc/ssh/stage1-r3-evidence/authorized_keys";
    const evidenceRoot = "/run/stage1-r3-evidence";
    const evidenceKeyStat = {
      isFile: () => true,
      uid: 0n,
      gid: 0n,
      mode: 33188n,
      nlink: 1n,
      size: 0n,
      dev: 64771n,
      ino: 798081n
    };
    const noFile = () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    t.mock.module("node:fs/promises", {
      defaultExport: {
        ...realFs,
        lstat: (file, ...args) => {
          if (file === "/proc/492654") return noFile();
          if (file === evidenceKey) return Promise.resolve(evidenceKeyStat);
          if (file === evidenceRoot)
            return Promise.resolve({
              isDirectory: () => true,
              isSymbolicLink: () => false,
              uid: 0n,
              gid: 0n,
              mode: 0o40755n
            });
          return realFs.lstat(mapping(file), ...args);
        },
        open: (file, ...args) =>
          file === evidenceKey
            ? Promise.resolve({
                stat: async () => evidenceKeyStat,
                readFile: async () => Buffer.alloc(0),
                close: async () => {}
              })
            : realFs.open(mapping(file), ...args),
        realpath: (file) =>
          file === globalLock || file.startsWith("/dev/mapper/")
            ? Promise.resolve(file)
            : realFs.realpath(file),
        readdir: (file, ...args) =>
          file === "/proc" || file === evidenceRoot
            ? Promise.resolve([])
            : realFs.readdir(file, ...args),
        readFile: (file, ...args) => {
          if (file === "/proc/swaps") return Promise.resolve("Filename Type Size Used Priority\n");
          if (file === "/proc/sys/kernel/core_pattern") return Promise.resolve("|/bin/false\n");
          if (file === "/proc/locks")
            return Promise.resolve(
              held
                ? `1: FLOCK ADVISORY WRITE ${process.pid} ${major.toString(16)}:${minor.toString(16)}:${stat.ino} 0 EOF\n`
                : ""
            );
          if (file === "/proc/self/mountinfo") return Promise.resolve("");
          return realFs.readFile(file, ...args);
        }
      }
    });
    t.mock.module("node:child_process", {
      namedExports: {
        execFile(binary, args, options, callback) {
          if (binary === "/usr/bin/findmnt") {
            const target = args.at(-1),
              name = path.basename(target);
            callback(null, {
              stdout: JSON.stringify({
                filesystems: [
                  {
                    target,
                    source: `/dev/mapper/stage1-h1-${name}`,
                    options: "nosuid,nodev,noexec"
                  }
                ]
              })
            });
            return;
          }
          if (binary === "/usr/local/bin/gh") {
            callback(null, {
              stdout: JSON.stringify({
                id: foreignJob ? "1" : p.github.jobId,
                run_id: p.github.runId,
                run_attempt: p.github.runAttempt,
                status: p.github.status,
                conclusion: p.github.conclusion,
                completed_at: p.github.completedAt,
                head_sha: "ba872d6cb2c0e054e5ab099a8218b7220a215301",
                url: `https://api.github.com/repos/${p.github.repository}/actions/jobs/${p.github.jobId}`
              })
            });
            return;
          }
          if (binary === "/usr/bin/pgrep") {
            const error = Object.assign(new Error("no fixed evidence user processes"), {
              code: 1,
              stdout: "",
              stderr: ""
            });
            if (sftpResidue) callback(null, { stdout: "494486\n" });
            else callback(error);
            return;
          }
          if (binary === "/usr/bin/ss") {
            callback(null, { stdout: "" });
            return;
          }
          assert.equal(binary, "/usr/bin/python3");
          moveCount++;
          if (secondMoveFails && moveCount === 2) {
            callback(new Error("private subprocess failure"));
            return;
          }
          return realExec(binary, args, options, (error, stdout, stderr) =>
            callback(error, { stdout, stderr })
          );
        }
      }
    });
    t.mock.module("../../packages/release-foundation/src/manual-r3-incident.mjs", {
      namedExports: { ...incident, APPROVED_R3_INCIDENT_79FEAA9A: p }
    });
    t.mock.module("./manual-stage1-trust.mjs", {
      namedExports: { loadFixedManualProfile: async () => profile }
    });
    t.mock.module("./r3-h1-forward-lease.mjs", {
      namedExports: {
        observeR3H1ForwardShutdown: async () => ({
          observation: { status: "VERIFIED", observedAt: new Date().toISOString() },
          rawInputs: {}
        }),
        assessR3H1ForwardShutdown: ({ observationBytes }) =>
          assert.equal(JSON.parse(observationBytes).status, "VERIFIED")
      }
    });
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-08T03:00:00.000Z") });
    const oldToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "synthetic-test-token";
    t.after(() => {
      if (oldToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = oldToken;
    });
    const { retireApprovedR3Incident, readBackApprovedR3Incident } =
      await import("./retire-r3-incident-79feaa9a.mjs");
    const input = { repoRoot: root };
    await assert.rejects(readBackApprovedR3Incident(input), {
      code: "MANUAL_R3_INCIDENT_UNVERIFIED"
    });
    assert.equal(moveCount, 0);
    await assert.rejects(fs.lstat(path.join(incidentRoot, "intent.json")), { code: "ENOENT" });
    await assert.rejects(fs.lstat(path.join(incidentRoot, "locks")), { code: "ENOENT" });
    t.mock.timers.setTime(Date.parse("2026-10-08T06:53:54.743Z"));
    await assert.rejects(retireApprovedR3Incident(input), {
      code: "MANUAL_R3_INCIDENT_UNVERIFIED"
    });
    assert.equal(moveCount, 0);
    t.mock.timers.setTime(Date.parse("2026-10-08T03:00:00.000Z"));
    held = false;
    await assert.rejects(retireApprovedR3Incident(input), {
      code: "MANUAL_R3_INCIDENT_UNVERIFIED"
    });
    assert.equal(moveCount, 0);
    held = true;
    foreignJob = true;
    await assert.rejects(retireApprovedR3Incident(input), {
      code: "MANUAL_R3_INCIDENT_UNVERIFIED"
    });
    assert.equal(moveCount, 0);
    foreignJob = false;
    sftpResidue = true;
    await assert.rejects(retireApprovedR3Incident(input), {
      code: "MANUAL_R3_INCIDENT_UNVERIFIED"
    });
    assert.equal(moveCount, 0);
    sftpResidue = false;
    const fakeClosing = encodeManualJson({
      kind: "session",
      sessionId,
      status: "INTERRUPTED_UNKNOWN"
    });
    const fakeClosingFile = path.join(
      profile.storage.journalRoot,
      "objects",
      `${sha256Bytes(fakeClosing).slice(7)}.json`
    );
    await write(fakeClosingFile, fakeClosing);
    await assert.rejects(retireApprovedR3Incident(input), {
      code: "MANUAL_R3_INCIDENT_UNVERIFIED"
    });
    assert.equal(moveCount, 0);
    await fs.unlink(fakeClosingFile);
    await assert.rejects(retireApprovedR3Incident(input), {
      code: "MANUAL_R3_INCIDENT_UNVERIFIED"
    });
    assert.equal(moveCount, 2);
    const intentBytes = await fs.readFile(path.join(incidentRoot, "intent.json"));
    const retainedRoot = path.join(incidentRoot, "locks");
    assert.deepEqual(await fs.readdir(retainedRoot), [p.lockNames[0]]);
    await assert.rejects(fs.readFile(path.join(incidentRoot, "disposition.json")), {
      code: "ENOENT"
    });
    secondMoveFails = false;
    const result = await retireApprovedR3Incident(input);
    assert.equal(result.status, "OWNER_ACCEPTED_UNRESOLVED_FAILURE");
    assert.equal(result.promotionEligible, false);
    assert.equal(moveCount, 3);
    t.mock.timers.setTime(Date.parse("2026-10-08T06:53:54.743Z"));
    assert.equal(
      (await readBackApprovedR3Incident(input)).dispositionDigest,
      result.dispositionDigest
    );
    assert.equal(moveCount, 3);
    assert.deepEqual(await fs.readFile(path.join(incidentRoot, "intent.json")), intentBytes);
    const retained = [];
    for (const [index, name] of p.lockNames.entries()) {
      const bytes = await fs.readFile(path.join(retainedRoot, name));
      const identity = incident.r3IncidentFileIdentity(
        await fs.lstat(path.join(retainedRoot, name), { bigint: true })
      );
      assert.deepEqual(bytes, lockBytes);
      assert.deepEqual(identity, originalIdentities[index]);
      retained.push({ name, digest: sha256Bytes(bytes), identity });
    }
    const receipt = incident.assessR3IncidentRecords({
      profile,
      policy: p,
      intentBytes,
      dispositionBytes: await fs.readFile(path.join(incidentRoot, "disposition.json")),
      retiredLocks: retained,
      now: new Date().toISOString()
    });
    assert.equal(receipt.remoteCleanupVerified, false);
    assert.equal(incident.matchesR3IncidentDisposition(receipt, {}, {}), false);
    assert.equal(
      (await retireApprovedR3Incident(input)).dispositionDigest,
      result.dispositionDigest
    );
    assert.equal(moveCount, 3);
  }
);
