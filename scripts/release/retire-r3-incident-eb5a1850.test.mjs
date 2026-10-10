import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { generateKeyPairSync } from "node:crypto";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import * as incident from "../../packages/release-foundation/src/manual-r3-incident.mjs";

test("eb5a executor binds seven originals, live identity, signed partial resume and readback", async (t) => {
  const posix = path.posix;
  const entries = new Map();
  let nextIno = 10n;
  const absent = () => Object.assign(new Error("absent"), { code: "ENOENT" });
  const add = (name, bytes = null, mode = 0o600n) => {
    const file = bytes !== null;
    entries.set(name, {
      bytes: file ? Buffer.from(bytes) : null,
      stat: {
        dev: 1n,
        ino: nextIno++,
        uid: 0n,
        gid: 0n,
        mode: (file ? 0o100000n : 0o40000n) | mode,
        nlink: 1n,
        size: file ? BigInt(bytes.length) : 0n,
        mtimeNs: 1n,
        ctimeNs: 1n,
        isFile: () => file,
        isDirectory: () => !file,
        isSymbolicLink: () => false
      }
    });
  };
  add("/", null, 0o755n);
  const dir = (name, mode = 0o700n) => {
    let current = "/";
    for (const segment of name.split("/").filter(Boolean)) {
      current = posix.join(current, segment);
      if (!entries.has(current)) add(current, null, mode);
    }
  };
  const put = (name, bytes) => {
    dir(posix.dirname(name));
    add(name, bytes);
  };
  const keys = generateKeyPairSync("ed25519");
  const profile = {
    ownerId: "test-owner",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
    keyFingerprint: sha256Bytes(keys.publicKey.export({ type: "spki", format: "der" })),
    storage: {
      archiveRoot: "/var/lib/test/archive",
      journalRoot: "/var/lib/test/journal",
      keyRoot: "/var/lib/test/keys",
      keyRef: "key.pem"
    }
  };
  for (const name of [
    profile.storage.archiveRoot,
    posix.join(profile.storage.archiveRoot, "objects"),
    profile.storage.journalRoot,
    posix.join(profile.storage.journalRoot, "objects"),
    posix.join(profile.storage.journalRoot, "locks"),
    posix.join(profile.storage.journalRoot, "consumptions"),
    profile.storage.keyRoot
  ])
    dir(name);
  put(
    posix.join(profile.storage.keyRoot, profile.storage.keyRef),
    keys.privateKey.export({ type: "pkcs8", format: "pem" })
  );
  const proposal = encodeManualJson({ incident: "eb5a" });
  const approval = encodeManualJson({ approved: "eb5a" });
  const lockBytes = encodeManualJson({
    sessionId: "717ac0f0-a136-4f87-ba89-fe5daef4cc97",
    pid: 938945,
    profileDigest: sha256Canonical(profile),
    scope: incident.APPROVED_R3_INCIDENT_EB5A1850.lockScope
  });
  const p = {
    ...incident.APPROVED_R3_INCIDENT_EB5A1850,
    profileDigest: sha256Canonical(profile),
    ownerId: profile.ownerId,
    proposalDigest: sha256Bytes(proposal),
    approvalDigest: sha256Bytes(approval),
    lockDigest: sha256Bytes(lockBytes)
  };
  const root = posix.join(profile.storage.archiveRoot, "incidents", p.operationRef);
  dir(root);
  put(posix.join(root, "proposal.json"), proposal);
  put(posix.join(root, "approval.json"), approval);
  for (const [field, role] of [
    ["openingDigest", "journal"],
    ["allocationDigest", "archive"],
    ["requestDigest", "archive"],
    ["authorizationDigest", "archive"],
    ["consumptionDigest", "journal"],
    ["executionDigest", "journal"],
    ["sessionDigest", "journal"]
  ]) {
    const bytes = encodeManualJson({
      field,
      sessionId: p.sessionId,
      kind:
        field === "openingDigest" || field === "sessionDigest"
          ? "session"
          : field === "executionDigest"
            ? "execution"
            : "evidence",
      status: field === "openingDigest" ? "OPEN" : "INTERRUPTED_UNKNOWN"
    });
    p[field] = sha256Bytes(bytes);
    put(posix.join(profile.storage[`${role}Root`], "objects", `${p[field].slice(7)}.json`), bytes);
    if (field === "consumptionDigest")
      put(posix.join(profile.storage.journalRoot, "consumptions", p.consumptionSlotName), bytes);
  }
  for (const name of p.lockNames)
    put(posix.join(profile.storage.journalRoot, "locks", name), lockBytes);
  const originalIdentities = p.lockNames.map((name) =>
    incident.r3IncidentFileIdentity(
      entries.get(posix.join(profile.storage.journalRoot, "locks", name)).stat
    )
  );
  put("/run/stage1-github-app-convert.lock", "");
  dir("/proc", 0o755n);
  dir("/run/stage1-r3-evidence", 0o755n);
  for (const name of ["evidence", "forward"]) put(`/etc/ssh/stage1-r3-${name}/authorized_keys`, "");
  for (const name of ["evidence", "forward"])
    entries.get(`/etc/ssh/stage1-r3-${name}/authorized_keys`).stat.mode = 33188n;
  const readEntry = (name) => {
    const value = entries.get(name);
    if (!value) throw absent();
    return value;
  };
  const fakeFs = {
    lstat: async (name) => readEntry(name).stat,
    stat: async (name) => readEntry(name).stat,
    realpath: async (name) => name,
    readdir: async (name) => {
      readEntry(name);
      if (name === "/proc") return [];
      return [...entries.keys()]
        .filter((key) => key !== name && posix.dirname(key) === name)
        .map((key) => posix.basename(key));
    },
    readFile: async (name, encoding) => {
      const synthetic = {
        "/proc/swaps": "Filename Type Size Used Priority\n",
        "/proc/sys/kernel/core_pattern": "|/bin/false\n",
        "/proc/locks": "1: FLOCK ADVISORY WRITE 777 0:1:10 0 EOF\n",
        "/proc/self/mountinfo": ""
      };
      if (name === "/proc/locks") {
        const s = entries.get("/run/stage1-github-app-convert.lock").stat;
        return `1: FLOCK ADVISORY WRITE 777 0:1:${s.ino} 0 EOF\n`;
      }
      if (Object.hasOwn(synthetic, name)) return synthetic[name];
      const bytes = readEntry(name).bytes;
      return encoding === "utf8" ? bytes.toString("utf8") : Buffer.from(bytes);
    },
    open: async (name, flags) => {
      if (flags & constants.O_CREAT) {
        if (entries.has(name)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        readEntry(posix.dirname(name));
        add(name, Buffer.alloc(0));
      }
      const item = readEntry(name);
      return {
        stat: async () => item.stat,
        readFile: async () => Buffer.from(item.bytes),
        writeFile: async (bytes) => {
          item.bytes = Buffer.from(bytes);
          item.stat.size = BigInt(item.bytes.length);
        },
        sync: async () => {},
        close: async () => {}
      };
    },
    mkdir: async (name) => {
      if (entries.has(name)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      add(name, null, 0o700n);
    }
  };
  let moveCount = 0;
  let failSecond = true;
  const fakeExec = (binary, args, options, callback) => {
    if (binary === "/usr/bin/findmnt") {
      const target = args.at(-1),
        name = posix.basename(target);
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
    } else if (binary === "/usr/local/bin/gh") {
      const isRun = args[1].includes("/attempts/");
      callback(null, {
        stdout: JSON.stringify(
          isRun
            ? {
                id: p.github.runId,
                run_attempt: p.github.runAttempt,
                status: "completed",
                conclusion: "failure",
                head_sha: "d789f752c477bd58294eb267d06e75da1a0b42f0"
              }
            : {
                id: p.github.jobId,
                run_id: p.github.runId,
                run_attempt: p.github.runAttempt,
                status: "completed",
                conclusion: "failure",
                completed_at: p.github.completedAt,
                head_sha: "d789f752c477bd58294eb267d06e75da1a0b42f0",
                url: `https://api.github.com/repos/${p.github.repository}/actions/jobs/${p.github.jobId}`
              }
        )
      });
    } else if (binary === "/usr/bin/pgrep") {
      callback(Object.assign(new Error("absent"), { code: 1, stdout: "", stderr: "" }));
    } else if (binary === "/usr/bin/ss") {
      callback(null, { stdout: "" });
    } else if (binary === "/usr/bin/bash") {
      assert.equal(args[1], "check-idle");
      callback(null, {
        stdout:
          "IDLE: formal evidence and forward surfaces are empty; check-only made no changes\n",
        stderr: ""
      });
    } else {
      assert.equal(binary, "/usr/bin/python3");
      moveCount++;
      if (failSecond && moveCount === 2) {
        callback(new Error("interrupted second move"));
        return;
      }
      assert.equal(args[0], "-c");
      assert.equal(entries.has(args[3]), false);
      entries.set(args[3], readEntry(args[2]));
      entries.delete(args[2]);
      callback(null, { stdout: "" });
    }
  };
  const fakeProcess = {
    pid: 777,
    ppid: 1,
    platform: "linux",
    getuid: () => 0,
    env: { GH_TOKEN: "synthetic" },
    argv: [],
    stdout: process.stdout,
    stderr: process.stderr
  };
  t.mock.module("node:fs/promises", { defaultExport: fakeFs });
  t.mock.module("node:path", { defaultExport: posix });
  t.mock.module("node:process", { defaultExport: fakeProcess });
  t.mock.module("node:child_process", { namedExports: { execFile: fakeExec } });
  t.mock.module("../../packages/release-foundation/src/manual-r3-incident.mjs", {
    namedExports: { ...incident, APPROVED_R3_INCIDENT_EB5A1850: p }
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
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-10T04:00:00.000Z") });
  const { retireApprovedR3Incident, resumeApprovedR3Incident, readBackApprovedR3Incident } =
    await import("./retire-r3-incident-eb5a1850.mjs");
  const input = { repoRoot: "/var/lib/test" };
  await assert.rejects(readBackApprovedR3Incident(input), {
    code: "MANUAL_R3_INCIDENT_UNVERIFIED"
  });
  await assert.rejects(resumeApprovedR3Incident(input), { code: "MANUAL_R3_INCIDENT_UNVERIFIED" });
  assert.equal(moveCount, 0);
  await assert.rejects(retireApprovedR3Incident(input), { code: "MANUAL_R3_INCIDENT_UNVERIFIED" });
  assert.equal(moveCount, 2);
  const intentBytes = Buffer.from(readEntry(posix.join(root, "intent.json")).bytes);
  const movedFirst = posix.join(root, "locks", p.lockNames[0]);
  assert.ok(entries.has(movedFirst));
  assert.equal(entries.has(posix.join(root, "disposition.json")), false);
  const activeSecond = posix.join(profile.storage.journalRoot, "locks", p.lockNames[1]);
  await assert.rejects(retireApprovedR3Incident(input), { code: "MANUAL_R3_INCIDENT_UNVERIFIED" });
  assert.equal(moveCount, 2);
  entries.get(activeSecond).stat.ino = 999999n;
  failSecond = false;
  await assert.rejects(resumeApprovedR3Incident(input), { code: "MANUAL_R3_INCIDENT_UNVERIFIED" });
  assert.equal(moveCount, 2);
  entries.get(activeSecond).stat.ino = BigInt(originalIdentities[1].ino);
  const result = await resumeApprovedR3Incident(input);
  assert.equal(result.status, "OWNER_ACCEPTED_UNRESOLVED_FAILURE");
  assert.equal(result.promotionEligible, false);
  assert.equal(moveCount, 3);
  assert.deepEqual(readEntry(posix.join(root, "intent.json")).bytes, intentBytes);
  for (const [index, name] of p.lockNames.entries()) {
    const item = readEntry(posix.join(root, "locks", name));
    assert.deepEqual(item.bytes, lockBytes);
    assert.deepEqual(incident.r3IncidentFileIdentity(item.stat), originalIdentities[index]);
  }
  t.mock.timers.setTime(Date.parse("2026-10-10T08:00:00.001Z"));
  assert.equal(
    (await readBackApprovedR3Incident(input)).dispositionDigest,
    result.dispositionDigest
  );
  await assert.rejects(resumeApprovedR3Incident(input), { code: "MANUAL_R3_INCIDENT_UNVERIFIED" });
  assert.equal(moveCount, 3);
});
