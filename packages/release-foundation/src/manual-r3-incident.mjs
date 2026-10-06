import { createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { encodeManualJson } from "./manual-stage1-contracts.mjs";
import { sha256Bytes, sha256Canonical } from "./digest.mjs";

const CODE = "MANUAL_R3_INCIDENT_UNVERIFIED";
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (condition) => {
  if (!condition) fail();
};
const equal = (a, b) => encodeManualJson(a).equals(encodeManualJson(b));
const exact = (value, keys) =>
  need(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      equal(Object.keys(value).sort(), [...keys].sort())
  );
const digest = (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
const epoch = (value) => {
  const time = Date.parse(value);
  need(
    typeof value === "string" && Number.isFinite(time) && new Date(time).toISOString() === value
  );
  return time;
};
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

// The only approved exception. This registry is source controlled; a private
// record cannot nominate another operation, profile, approval or expiry.
export const APPROVED_R3_INCIDENT = freeze({
  proposalDigest: "sha256:b9cfd396cf5292ea6b0373577f5d2abac38dfa0947b9c8ae935c131a58772034",
  approvalDigest: "sha256:b2176111555f3b8c41f67ad70b859ed3bbc02a1161cefe7c238e19bd0621855a",
  profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
  ownerId: "keqi119",
  operationRef: "3b451859-631a-49d7-9059-d8051cb9e7d9",
  sessionId: "7c72f1eb-d1ff-41f4-8be7-6b06f4dc5745",
  openingDigest: "sha256:b6ecee93109b19d284fc6b5c6221d3e311034b1140507fa9b36e6f7da082a04c",
  requestDigest: "sha256:15028729d757ec0a27211b2e1e6a83f3474ced3abe2aa5c71d0a743a46738c7c",
  consumptionDigest: "sha256:adc83edd47ec41b15d8145419e74bc4d13c4671a0cc48a94d2d5815e4a268cff",
  executionDigest: "sha256:c6d70e8f7107781d93ec93bab0cb2f3d9d76e7e4f05aa13871c604317c1c699c",
  sessionDigest: "sha256:75f58fd2b85729b5da85c0cf087966747c947c5eef92eae772a33fb6e2e26978",
  lockDigest: "sha256:e7b0be262e0aaca5816bf3daf7a7cee65095f3fd3d8e0e69fd2d744cdb9f979f",
  lockNames: [
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json",
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json"
  ],
  github: {
    repository: "keqi119/subscription-Saas",
    runId: "37500711005",
    runAttempt: 1,
    jobId: "112398453639",
    status: "completed",
    conclusion: "failure",
    completedAt: "2026-10-06T17:18:11Z"
  },
  executeNotAfter: "2026-10-07T06:53:54.742Z"
});

export function r3IncidentFileIdentity(stat) {
  return Object.fromEntries(
    ["dev", "ino", "uid", "gid", "mode", "nlink", "size"].map((key) => [key, String(stat[key])])
  );
}

function locks(value, policy) {
  need(Array.isArray(value) && value.length === 2 && policy.lockNames.length === 2);
  for (const [index, lock] of value.entries()) {
    exact(lock, ["name", "digest", "identity"]);
    need(lock.name === policy.lockNames[index] && lock.digest === policy.lockDigest);
    exact(lock.identity, ["dev", "ino", "uid", "gid", "mode", "nlink", "size"]);
    need(
      Object.values(lock.identity).every(
        (item) => typeof item === "string" && /^(?:0|[1-9][0-9]*)$/u.test(item)
      )
    );
    need(
      lock.identity.uid === "0" &&
        lock.identity.gid === "0" &&
        lock.identity.mode === "33152" &&
        lock.identity.nlink === "1" &&
        Number(lock.identity.size) > 0 &&
        Number(lock.identity.size) <= 8192
    );
  }
  need(
    value[0].identity.dev === value[1].identity.dev &&
      value[0].identity.ino !== value[1].identity.ino
  );
}

function signed(bytes, profile) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 32768);
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  exact(value, ["record", "signature"]);
  need(encodeManualJson(value).equals(bytes) && typeof value.signature === "string");
  const signature = Buffer.from(value.signature, "base64"),
    key = createPublicKey(profile.publicKeyPem);
  need(
    signature.length === 64 &&
      signature.toString("base64") === value.signature &&
      key.asymmetricKeyType === "ed25519"
  );
  need(
    verify(
      null,
      Buffer.concat([
        Buffer.from("subscription-saas/r3-incident/v1\n"),
        encodeManualJson(value.record)
      ]),
      key,
      signature
    )
  );
  return value.record;
}

// Pure signature/byte assessment only. The native history reader separately
// pins the approved registry, original graph, private paths and actual inodes.
export function assessR3IncidentIntent({ profile, policy, intentBytes, now }) {
  try {
    need(sha256Canonical(profile) === policy.profileDigest && profile.ownerId === policy.ownerId);
    need(digest(policy.approvalDigest) && digest(policy.proposalDigest));
    const intent = signed(intentBytes, profile);
    exact(intent, [
      "schemaVersion",
      "policyDigest",
      "decision",
      "createdAt",
      "remoteCreationKnown",
      "remoteCleanupVerified",
      "promotionEligible",
      "ownerProcessesAbsent",
      "job",
      "forwardShutdownDigest",
      "locks"
    ]);
    need(
      intent.schemaVersion === "manual-r3-incident-intent.v1" &&
        intent.policyDigest === sha256Canonical(policy) &&
        intent.decision === "OWNER_ACCEPTED_UNRESOLVED_FAILURE" &&
        intent.remoteCreationKnown === false &&
        intent.remoteCleanupVerified === false &&
        intent.promotionEligible === false &&
        intent.ownerProcessesAbsent === true &&
        equal(intent.job, policy.github) &&
        digest(intent.forwardShutdownDigest)
    );
    locks(intent.locks, policy);
    need(
      Date.parse(policy.github.completedAt) <= epoch(intent.createdAt) &&
        epoch(intent.createdAt) <= epoch(policy.executeNotAfter) &&
        epoch(intent.createdAt) <= epoch(now)
    );
    return freeze(intent);
  } catch {
    fail();
  }
}

// Pure transition planning; it confers no authority and performs no I/O.
export function planR3IncidentLockRetirement(intent, active, retired) {
  try {
    need(active.length === 2 && retired.length === 2 && intent.locks.length === 2);
    return intent.locks.flatMap((lock, index) => {
      need(Boolean(active[index]) !== Boolean(retired[index]));
      need(equal(lock, active[index] ?? retired[index]));
      return active[index] ? [lock.name] : [];
    });
  } catch {
    fail();
  }
}

export function assessR3IncidentRecords({
  profile,
  policy,
  intentBytes,
  dispositionBytes,
  retiredLocks,
  now
}) {
  try {
    const intent = assessR3IncidentIntent({ profile, policy, intentBytes, now }),
      disposition = signed(dispositionBytes, profile);
    exact(disposition, [
      "schemaVersion",
      "intentDigest",
      "status",
      "completedAt",
      "remoteCreationKnown",
      "remoteCleanupVerified",
      "promotionEligible",
      "ownerProcessesAbsent",
      "job",
      "forwardShutdownDigest",
      "locks"
    ]);
    need(
      disposition.schemaVersion === "manual-r3-incident-disposition.v1" &&
        disposition.intentDigest === sha256Bytes(intentBytes) &&
        disposition.status === "LOCAL_CHANNEL_SLOTS_RETIRED_WITH_OWNER_EXCEPTION"
    );
    for (const record of [intent, disposition]) {
      need(
        record.remoteCreationKnown === false &&
          record.remoteCleanupVerified === false &&
          record.promotionEligible === false &&
          record.ownerProcessesAbsent === true &&
          equal(record.job, policy.github) &&
          digest(record.forwardShutdownDigest)
      );
      locks(record.locks, policy);
    }
    need(
      Date.parse(policy.github.completedAt) <= epoch(intent.createdAt) &&
        epoch(intent.createdAt) <= epoch(disposition.completedAt) &&
        epoch(disposition.completedAt) <= epoch(policy.executeNotAfter) &&
        epoch(disposition.completedAt) <= epoch(now)
    );
    locks(retiredLocks, policy);
    need(equal(intent.locks, disposition.locks) && equal(disposition.locks, retiredLocks));
    return freeze({
      status: "OWNER_ACCEPTED_UNRESOLVED_FAILURE",
      remoteCleanupVerified: false,
      promotionEligible: false,
      intent,
      disposition
    });
  } catch {
    fail();
  }
}

const dispositions = new WeakSet();
export function matchesR3IncidentDisposition(receipt, consumed, execution) {
  return Boolean(
    receipt &&
    dispositions.has(receipt) &&
    sha256Canonical(consumed) === APPROVED_R3_INCIDENT.consumptionDigest &&
    sha256Canonical(execution) === APPROVED_R3_INCIDENT.executionDigest
  );
}

// Only this native reader brands a disposition. Ordinary assessments, booleans,
// job completion and records supplied by a caller cannot enable the exception.
export async function readApprovedR3IncidentDisposition(
  environment,
  graph,
  openingDigest,
  consumptions
) {
  const p = APPROVED_R3_INCIDENT;
  const opening = graph.get(openingDigest)?.value;
  const relevant =
    opening?.sessionId === p.sessionId ||
    consumptions.some((value) => value.operationId === p.operationRef);
  if (!relevant) return null;
  try {
    const { profile, store, retainedLocks, stamp } = environment;
    need(
      sha256Canonical(profile) === p.profileDigest &&
        openingDigest === p.openingDigest &&
        consumptions.length === 1 &&
        sha256Canonical(consumptions[0]) === p.consumptionDigest
    );
    const originals = [
      [p.openingDigest, "journal"],
      [p.consumptionDigest, "journal"],
      [p.executionDigest, "journal"],
      [p.sessionDigest, "journal"],
      [p.requestDigest, "archive"]
    ];
    for (const [digest, role] of originals) {
      const item = graph.get(digest);
      need(
        item &&
          sha256Bytes(item.bytes) === digest &&
          encodeManualJson(item.value).equals(item.bytes)
      );
      need(
        (
          await store.read(
            path.join(profile.storage[`${role}Root`], "objects", `${digest.slice(7)}.json`)
          )
        ).equals(item.bytes)
      );
    }
    const values = [...graph.values()].map((item) => item.value);
    need(
      values.filter((v) => v.kind === "execution" && v.sessionId === p.sessionId).length === 1 &&
        values.filter((v) => v.kind === "session" && v.sessionId === p.sessionId).length === 2 &&
        graph.get(p.executionDigest).value.status === "INTERRUPTED_UNKNOWN" &&
        graph.get(p.sessionDigest).value.status === "INTERRUPTED_UNKNOWN" &&
        retainedLocks.every(({ value }) => value.sessionId !== p.sessionId)
    );
    const root = path.join(profile.storage.archiveRoot, "incidents", p.operationRef);
    await store.checkedPath(root);
    need(
      sha256Bytes(await store.read(path.join(root, "proposal.json"), true)) === p.proposalDigest &&
        sha256Bytes(await store.read(path.join(root, "approval.json"), true)) === p.approvalDigest
    );
    const intentBytes = await store.read(path.join(root, "intent.json"));
    const dispositionBytes = await store.read(path.join(root, "disposition.json"));
    const retiredLocks = [];
    for (const name of p.lockNames) {
      const file = path.join(root, "locks", name);
      const before = await store.checkedPath(file);
      const bytes = await store.read(file);
      const after = await store.checkedPath(file);
      need(
        equal(r3IncidentFileIdentity(before), r3IncidentFileIdentity(after)) &&
          sha256Bytes(bytes) === p.lockDigest
      );
      retiredLocks.push({
        name,
        digest: sha256Bytes(bytes),
        identity: r3IncidentFileIdentity(after)
      });
      environment.capture.pinIdentity(file, r3IncidentFileIdentity(after));
    }
    const receipt = assessR3IncidentRecords({
      profile,
      policy: p,
      intentBytes,
      dispositionBytes,
      retiredLocks,
      now: stamp()
    });
    const { assessR3H1ForwardShutdown } =
      await import("../../../scripts/release/r3-h1-forward-lease.mjs");
    for (const [record, at] of [
      [receipt.intent, receipt.intent.createdAt],
      [receipt.disposition, receipt.disposition.completedAt]
    ]) {
      const bytes = await store.read(
        path.join(root, `forward-${record.forwardShutdownDigest.slice(7)}.json`)
      );
      need(sha256Bytes(bytes) === record.forwardShutdownDigest);
      assessR3H1ForwardShutdown({
        observationBytes: bytes,
        rawInputs: Object.fromEntries(
          ["key", "ss.stdout", "ss.stderr", "pgrep.stdout", "pgrep.stderr"].map((key) => [
            key,
            Buffer.alloc(0)
          ])
        ),
        now: at
      });
    }
    dispositions.add(receipt);
    return receipt;
  } catch {
    fail();
  }
}
