// Fixed, owner-approved incident only. Run under the existing protected H1
// volume controller and its exclusive /run/stage1-github-app-convert.lock.
import fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import process from "node:process";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  APPROVED_R3_INCIDENT_EB5A1850 as P,
  assessR3IncidentIntent,
  assessR3IncidentRecords,
  assertR3IncidentSessionShape,
  planR3IncidentLockRetirement,
  r3IncidentFileIdentity
} from "../../packages/release-foundation/src/manual-r3-incident.mjs";
import { loadFixedManualProfile } from "./manual-stage1-trust.mjs";
import { observeR3H1ForwardShutdown, assessR3H1ForwardShutdown } from "./r3-h1-forward-lease.mjs";

const EXPECTED_JOB_SOURCE = "d789f752c477bd58294eb267d06e75da1a0b42f0";

const execute = promisify(execFile);
const CODE = "MANUAL_R3_INCIDENT_UNVERIFIED";
const need = (value) => {
  if (!value) throw Object.assign(new Error(CODE), { code: CODE });
};
const equal = (a, b) => encodeManualJson(a).equals(encodeManualJson(b));
const stamp = () => new Date().toISOString();
const beforeDeadline = () => need(Date.now() <= Date.parse(P.executeNotAfter));
const GLOBAL_LOCK = "/run/stage1-github-app-convert.lock";
const command = async (binary, args, extraEnv = {}) =>
  (
    await execute(binary, args, {
      shell: false,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1048576,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C", ...extraEnv }
    })
  ).stdout;

async function checked(file, directory = false) {
  need(path.isAbsolute(file) && path.normalize(file) === file);
  let part = path.parse(file).root;
  for (const segment of file.slice(part.length).split(path.sep).filter(Boolean)) {
    part = path.join(part, segment);
    const s = await fs.lstat(part, { bigint: true });
    need(
      !s.isSymbolicLink() &&
        s.uid === 0n &&
        s.gid === 0n &&
        (s.mode & 0o022n) === 0n &&
        (await fs.realpath(part)) === part
    );
    if (part !== file) need(s.isDirectory());
  }
  const s = await fs.lstat(file, { bigint: true });
  need(
    directory
      ? s.isDirectory() && (s.mode & 0o777n) === 0o700n
      : s.isFile() && s.nlink === 1n && (s.mode & 0o777n) === 0o600n && s.size <= 1048576n
  );
  return s;
}
async function read(file) {
  const before = await checked(file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    need(
      equal(
        r3IncidentFileIdentity(before),
        r3IncidentFileIdentity(await handle.stat({ bigint: true }))
      )
    );
    const bytes = await handle.readFile();
    const after = await checked(file);
    need(
      equal(r3IncidentFileIdentity(before), r3IncidentFileIdentity(after)) &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs &&
        BigInt(bytes.length) === before.size
    );
    return { bytes, identity: r3IncidentFileIdentity(after) };
  } finally {
    await handle.close();
  }
}
async function optional(file) {
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return read(file);
}
async function syncDirectory(dir) {
  const handle = await fs.open(
    dir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function create(file, bytes) {
  await checked(path.dirname(file), true);
  const handle = await fs.open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
  need((await read(file)).bytes.equals(bytes));
}
async function mkdir(dir) {
  await checked(path.dirname(dir), true);
  try {
    await fs.mkdir(dir, { mode: 0o700 });
    await syncDirectory(path.dirname(dir));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await checked(dir, true);
}
async function ancestry() {
  const ids = new Set([process.pid]);
  let pid = process.ppid;
  while (pid > 1 && !ids.has(pid)) {
    ids.add(pid);
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    need(/^Uid:\s+0\s+0\s+0\s+0$/mu.test(status));
    pid = Number(/^PPid:\s+(\d+)$/mu.exec(status)?.[1]);
    need(Number.isInteger(pid));
  }
  return ids;
}
async function protectionAndLock() {
  need(process.platform === "linux" && process.getuid?.() === 0);
  need(
    (await fs.readFile("/proc/swaps", "utf8")).trim().split("\n").length === 1 &&
      (await fs.readFile("/proc/sys/kernel/core_pattern", "utf8")).trim() === "|/bin/false"
  );
  const lock = await checked(GLOBAL_LOCK);
  const ancestors = await ancestry();
  const major = ((lock.dev >> 8n) & 0xfffn) | ((lock.dev >> 32n) & 0xfffff000n);
  const minor = (lock.dev & 0xffn) | ((lock.dev >> 12n) & 0xffffff00n);
  const held = (await fs.readFile("/proc/locks", "utf8")).split("\n").some((line) => {
    const match =
      /^\d+: FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF$/u.exec(
        line.trim()
      );
    return (
      match &&
      ancestors.has(Number(match[1])) &&
      BigInt(`0x${match[2]}`) === major &&
      BigInt(`0x${match[3]}`) === minor &&
      BigInt(match[4]) === lock.ino
    );
  });
  need(held);
  for (const name of ["main", "recovery"]) {
    const info = JSON.parse(
      await command("/usr/bin/findmnt", [
        "-J",
        "-o",
        "SOURCE,TARGET,OPTIONS",
        "--mountpoint",
        `/var/lib/stage1-volumes/${name}`
      ])
    ).filesystems;
    need(
      info?.length === 1 &&
        info[0].target === `/var/lib/stage1-volumes/${name}` &&
        (await fs.realpath(info[0].source)) ===
          (await fs.realpath(`/dev/mapper/stage1-h1-${name}`)) &&
        ["nosuid", "nodev", "noexec"].every((option) => info[0].options.split(",").includes(option))
    );
  }
  return ancestors;
}
async function evidenceTransportAbsent() {
  for (const name of ["evidence", "forward"]) {
    const key = `/etc/ssh/stage1-r3-${name}/authorized_keys`;
    const handle = await fs.open(key, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const held = await handle.stat({ bigint: true });
      const named = await fs.lstat(key, { bigint: true });
      need(
        held.isFile() &&
          held.uid === 0n &&
          held.gid === 0n &&
          held.mode === 33188n &&
          held.nlink === 1n &&
          held.size === 0n &&
          equal(r3IncidentFileIdentity(held), r3IncidentFileIdentity(named))
      );
      need((await handle.readFile()).length === 0);
    } finally {
      await handle.close();
    }
  }
  for (const uid of ["993", "994"]) {
    let absent = false;
    try {
      await command("/usr/bin/pgrep", ["-u", uid]);
    } catch (error) {
      need(error.code === 1 && error.stdout === "" && error.stderr === "");
      absent = true;
    }
    need(absent);
  }
  need((await command("/usr/bin/ss", ["-H", "-ltn", "sport = :55440 or sport = :55441"])) === "");
  const root = "/run/stage1-r3-evidence";
  const status = await fs.lstat(root, { bigint: true });
  need(
    status.isDirectory() &&
      !status.isSymbolicLink() &&
      status.uid === 0n &&
      status.gid === 0n &&
      (status.mode & 0o022n) === 0n
  );
  need((await fs.readdir(root)).length === 0);
  need(
    !(await fs.readFile("/proc/self/mountinfo", "utf8"))
      .split("\n")
      .some((line) => line.split(" ")[4] === root)
  );
  for (const entry of await fs.readdir("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      need(!(await fs.readFile(`/proc/${entry}/maps`, "utf8")).includes(root));
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
}

async function formalIdle() {
  const account =
    "/opt/stage1-r3-candidate-d789f75/scripts/release/maintenance/stage1-r3-evidence-account.sh";
  const result = await execute("/usr/bin/bash", [account, "check-idle"], {
    shell: false,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 65536,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" }
  });
  need(
    result.stdout.trim() ===
      "IDLE: formal evidence and forward surfaces are empty; check-only made no changes"
  );
  need(
    [
      "",
      "/etc/ssh/sshd_config line 150: Deprecated option RSAAuthentication\nreprocess config line 150: Deprecated option RSAAuthentication\n"
    ].includes(result.stderr.replaceAll("\r\n", "\n"))
  );
}

async function liveChecks(profile) {
  const ancestors = await protectionAndLock();
  const activeRoot = path.join(profile.storage.journalRoot, "locks"),
    retiredRoot = path.join(profile.storage.archiveRoot, "incidents", P.operationRef, "locks");
  const [active, retired] = await lockLocations(activeRoot, retiredRoot);
  need(active.every((value, index) => Boolean(value) !== Boolean(retired[index])));
  const pids = new Set();
  for (const [index, name] of P.lockNames.entries()) {
    const file = path.join(active[index] ? activeRoot : retiredRoot, name);
    const value = JSON.parse((await read(file)).bytes);
    pids.add(value.pid);
  }
  need(pids.size === 1);
  for (const pid of pids) {
    need(Number.isSafeInteger(pid) && pid > 1);
    try {
      await fs.lstat(`/proc/${pid}`);
      need(false);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const entry of await fs.readdir("/proc")) {
    if (!/^\d+$/u.test(entry) || ancestors.has(Number(entry))) continue;
    try {
      if ((await fs.stat(`/proc/${entry}`)).uid !== 0) continue;
      const commandLine = (await fs.readFile(`/proc/${entry}/cmdline`)).toString("utf8");
      need(
        !commandLine.includes(P.operationRef) &&
          !/(?:run-r3-source-fresh|launch-manual-stage1|r3-source-fresh-owner|retire-r3-incident-eb5a1850)\.(?:mjs|py)/u.test(
            commandLine
          )
      );
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
  need(typeof process.env.GH_TOKEN === "string" && process.env.GH_TOKEN.length > 0);
  const run = JSON.parse(
    await command(
      "/usr/local/bin/gh",
      [
        "api",
        `repos/${P.github.repository}/actions/runs/${P.github.runId}/attempts/${P.github.runAttempt}`
      ],
      { GH_TOKEN: process.env.GH_TOKEN, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" }
    )
  );
  need(
    String(run.id) === P.github.runId &&
      run.run_attempt === P.github.runAttempt &&
      run.status === P.github.status &&
      run.conclusion === P.github.conclusion &&
      run.head_sha === EXPECTED_JOB_SOURCE
  );
  const job = JSON.parse(
    await command(
      "/usr/local/bin/gh",
      ["api", `repos/${P.github.repository}/actions/jobs/${P.github.jobId}`],
      { GH_TOKEN: process.env.GH_TOKEN, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" }
    )
  );
  need(
    String(job.id) === P.github.jobId &&
      String(job.run_id) === P.github.runId &&
      job.run_attempt === P.github.runAttempt &&
      job.status === P.github.status &&
      job.conclusion === P.github.conclusion &&
      job.completed_at === P.github.completedAt &&
      job.head_sha === EXPECTED_JOB_SOURCE &&
      job.url ===
        `https://api.github.com/repos/${P.github.repository}/actions/jobs/${P.github.jobId}`
  );
  await evidenceTransportAbsent();
  await formalIdle();
  const forward = await observeR3H1ForwardShutdown();
  const bytes = encodeManualJson(forward.observation);
  assessR3H1ForwardShutdown({
    observationBytes: bytes,
    rawInputs: forward.rawInputs,
    now: stamp()
  });
  return bytes;
}
async function originals(profile) {
  for (const [digest, role] of [
    [P.openingDigest, "journal"],
    [P.allocationDigest, "archive"],
    [P.authorizationDigest, "archive"],
    [P.consumptionDigest, "journal"],
    [P.executionDigest, "journal"],
    [P.sessionDigest, "journal"],
    [P.requestDigest, "archive"]
  ]) {
    const { bytes } = await read(
      path.join(profile.storage[`${role}Root`], "objects", `${digest.slice(7)}.json`)
    );
    need(sha256Bytes(bytes) === digest && encodeManualJson(JSON.parse(bytes)).equals(bytes));
  }
  const slot = await read(
    path.join(profile.storage.journalRoot, "consumptions", P.consumptionSlotName)
  );
  need(
    sha256Bytes(slot.bytes) === P.consumptionDigest &&
      encodeManualJson(JSON.parse(slot.bytes)).equals(slot.bytes)
  );
  const journalObjects = path.join(profile.storage.journalRoot, "objects");
  await checked(journalObjects, true);
  const graph = new Map();
  for (const name of await fs.readdir(journalObjects)) {
    need(/^[0-9a-f]{64}\.json$/u.test(name));
    const { bytes } = await read(path.join(journalObjects, name));
    const digest = `sha256:${name.slice(0, 64)}`;
    need(sha256Bytes(bytes) === digest);
    const value = JSON.parse(bytes);
    need(encodeManualJson(value).equals(bytes));
    graph.set(digest, { value });
  }
  assertR3IncidentSessionShape(P, graph);
}
async function storedForward(root, record, now) {
  const { bytes } = await read(
    path.join(root, `forward-${record.forwardShutdownDigest.slice(7)}.json`)
  );
  need(sha256Bytes(bytes) === record.forwardShutdownDigest);
  assessR3H1ForwardShutdown({
    observationBytes: bytes,
    now,
    rawInputs: Object.fromEntries(
      ["key", "ss.stdout", "ss.stderr", "pgrep.stdout", "pgrep.stderr"].map((key) => [
        key,
        Buffer.alloc(0)
      ])
    )
  });
}
async function lockLocations(activeRoot, retiredRoot) {
  const roots = [];
  for (const root of [activeRoot, retiredRoot]) {
    const row = [];
    for (const name of P.lockNames) {
      const input = await optional(path.join(root, name));
      if (!input) {
        row.push(null);
        continue;
      }
      const value = JSON.parse(input.bytes);
      need(
        sha256Bytes(input.bytes) === P.lockDigest &&
          value.sessionId === P.sessionId &&
          value.profileDigest === P.profileDigest &&
          equal(value.scope, P.lockScope) &&
          Number.isSafeInteger(value.pid) &&
          value.pid > 1
      );
      row.push({ name, digest: sha256Bytes(input.bytes), identity: input.identity });
    }
    roots.push(row);
  }
  return roots;
}
// renameat2(RENAME_NOREPLACE) preserves the inode and fails if the destination
// exists. The host is Linux x86_64; no shell, overwrite or copy fallback.
const RENAME =
  "import ctypes,os,platform,sys\nassert platform.machine()=='x86_64'\nc=ctypes.CDLL(None,use_errno=True)\nr=c.syscall(316,-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),1)\nif r: raise OSError(ctypes.get_errno(),'RENAME_FAILED')\n";

async function performApprovedR3Incident(input, readOnly, requireIntent = false) {
  try {
    need(input && Object.keys(input).length === 1 && typeof input.repoRoot === "string");
    await protectionAndLock();
    const profile = await loadFixedManualProfile(input);
    need(sha256Canonical(profile) === P.profileDigest);
    const root = path.join(profile.storage.archiveRoot, "incidents", P.operationRef);
    await checked(root, true);
    need(
      sha256Bytes((await read(path.join(root, "proposal.json"))).bytes) === P.proposalDigest &&
        sha256Bytes((await read(path.join(root, "approval.json"))).bytes) === P.approvalDigest
    );
    await originals(profile);
    const activeRoot = path.join(profile.storage.journalRoot, "locks"),
      retiredRoot = path.join(root, "locks");
    let intentInput = await optional(path.join(root, "intent.json"));
    const done = await optional(path.join(root, "disposition.json"));
    if (requireIntent) need(intentInput && !done);
    else if (!readOnly) need(!intentInput && !done);
    if (done) {
      need(intentInput);
      const [active, retired] = await lockLocations(activeRoot, retiredRoot);
      need(active.every((value) => value === null));
      const receipt = assessR3IncidentRecords({
        profile,
        policy: P,
        intentBytes: intentInput.bytes,
        dispositionBytes: done.bytes,
        retiredLocks: retired,
        now: stamp()
      });
      await storedForward(root, receipt.intent, receipt.intent.createdAt);
      await storedForward(root, receipt.disposition, receipt.disposition.completedAt);
      await liveChecks(profile);
      return {
        status: receipt.status,
        dispositionDigest: sha256Bytes(done.bytes),
        promotionEligible: false
      };
    }
    need(!readOnly);
    beforeDeadline();
    const before = await liveChecks(profile);
    await mkdir(retiredRoot);
    need((await checked(activeRoot, true)).dev === (await checked(retiredRoot, true)).dev);
    const keyInput = await read(path.join(profile.storage.keyRoot, profile.storage.keyRef));
    let signingKey;
    try {
      signingKey = createPrivateKey(keyInput.bytes);
    } finally {
      keyInput.bytes.fill(0);
    }
    need(
      signingKey.asymmetricKeyType === "ed25519" &&
        sha256Bytes(createPublicKey(signingKey).export({ type: "spki", format: "der" })) ===
          profile.keyFingerprint
    );
    const seal = (record) =>
      encodeManualJson({
        record,
        signature: sign(
          null,
          Buffer.concat([
            Buffer.from("subscription-saas/r3-incident/v1\n"),
            encodeManualJson(record)
          ]),
          signingKey
        ).toString("base64")
      });
    const saveForward = async (bytes) => {
      const digest = sha256Bytes(bytes),
        file = path.join(root, `forward-${digest.slice(7)}.json`);
      const existing = await optional(file);
      if (existing) need(existing.bytes.equals(bytes));
      else await create(file, bytes);
      return digest;
    };
    if (!intentInput) {
      const [active, retired] = await lockLocations(activeRoot, retiredRoot);
      need(active.every(Boolean) && retired.every((value) => value === null));
      const record = {
        schemaVersion: "manual-r3-incident-intent.v1",
        policyDigest: sha256Canonical(P),
        decision: "OWNER_ACCEPTED_UNRESOLVED_FAILURE",
        createdAt: stamp(),
        remoteCreationKnown: false,
        remoteCleanupVerified: false,
        promotionEligible: false,
        ownerProcessesAbsent: true,
        job: P.github,
        forwardShutdownDigest: await saveForward(before),
        locks: active
      };
      const bytes = seal(record);
      assessR3IncidentIntent({ profile, policy: P, intentBytes: bytes, now: stamp() });
      beforeDeadline();
      await create(path.join(root, "intent.json"), bytes);
      intentInput = await read(path.join(root, "intent.json"));
    }
    const intent = assessR3IncidentIntent({
      profile,
      policy: P,
      intentBytes: intentInput.bytes,
      now: stamp()
    });
    await storedForward(root, intent, intent.createdAt);
    const [active, retired] = await lockLocations(activeRoot, retiredRoot);
    const names = planR3IncidentLockRetirement(intent, active, retired);
    for (const name of names) {
      beforeDeadline();
      const pair = await lockLocations(activeRoot, retiredRoot);
      need(planR3IncidentLockRetirement(intent, ...pair).includes(name));
      await command("/usr/bin/python3", [
        "-c",
        RENAME,
        path.join(activeRoot, name),
        path.join(retiredRoot, name)
      ]);
      await syncDirectory(activeRoot);
      await syncDirectory(retiredRoot);
    }
    await originals(profile);
    const after = await liveChecks(profile);
    const [remaining, retained] = await lockLocations(activeRoot, retiredRoot);
    need(
      remaining.every((value) => value === null) &&
        planR3IncidentLockRetirement(intent, remaining, retained).length === 0
    );
    const disposition = {
      schemaVersion: "manual-r3-incident-disposition.v1",
      intentDigest: sha256Bytes(intentInput.bytes),
      status: "LOCAL_CHANNEL_SLOTS_RETIRED_WITH_OWNER_EXCEPTION",
      completedAt: stamp(),
      remoteCreationKnown: false,
      remoteCleanupVerified: false,
      promotionEligible: false,
      ownerProcessesAbsent: true,
      job: P.github,
      forwardShutdownDigest: await saveForward(after),
      locks: retained
    };
    const bytes = seal(disposition);
    assessR3IncidentRecords({
      profile,
      policy: P,
      intentBytes: intentInput.bytes,
      dispositionBytes: bytes,
      retiredLocks: retained,
      now: stamp()
    });
    beforeDeadline();
    await create(path.join(root, "disposition.json"), bytes);
    return {
      status: "OWNER_ACCEPTED_UNRESOLVED_FAILURE",
      dispositionDigest: sha256Bytes(bytes),
      promotionEligible: false
    };
  } catch {
    throw Object.assign(new Error(CODE), { code: CODE });
  }
}

export const retireApprovedR3Incident = (input) => performApprovedR3Incident(input, false);
export const resumeApprovedR3Incident = (input) => performApprovedR3Incident(input, false, true);
export const readBackApprovedR3Incident = (input) => performApprovedR3Incident(input, true);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const readOnly = process.argv.length === 3 && process.argv[2] === "--readback";
    const resume = process.argv.length === 3 && process.argv[2] === "--resume";
    need(process.argv.length === 2 || readOnly || resume);
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const run = readOnly
      ? readBackApprovedR3Incident
      : resume
        ? resumeApprovedR3Incident
        : retireApprovedR3Incident;
    process.stdout.write(`${JSON.stringify(await run({ repoRoot }))}\n`);
  } catch {
    process.stderr.write(`${CODE}\n`);
    process.exitCode = 1;
  }
}
