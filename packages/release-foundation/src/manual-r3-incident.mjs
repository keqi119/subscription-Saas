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

export const APPROVED_R3_INCIDENT_0AF9C545 = freeze({
  proposalDigest: "sha256:fb7cc8b7ad1cf061df318652531a5951f71723f506c6dff88171d9171550b21e",
  approvalDigest: "sha256:d7134cd9149590d8c5bf489918e0763a576c1916b8d29845552455bc0da49a76",
  profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
  ownerId: "keqi119",
  operationRef: "0af9c545-8cbc-4d1a-9027-e840c39ce9fd",
  sessionId: "c8ba1430-b06a-401a-a047-dc0d131a88ac",
  openingDigest: "sha256:805e81d3662e0c7144a3d72dfa8ea7cd9c9eb908307ca7ca02e034da4fe96b13",
  requestDigest: "sha256:93933ebd31e5cb043d9f898b84979ded260f2281ca44f40819760944c349bc69",
  consumptionDigest: "sha256:a7ba9e8f521880b36ec38cef73eec2acf53df338b853ad14b5e1c14c834bc041",
  executionDigest: "sha256:ec58b4714b7919c0b33b09a080ab32eacdab471aac489af930f12c8c0f3dc450",
  sessionDigest: null,
  lockDigest: "sha256:98286db237d1a7cdda84d309e8206f8c1c9bc091284327686f746ae8f230e7e6",
  lockNames: [
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json",
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json"
  ],
  github: {
    repository: "keqi119/subscription-Saas",
    runId: "37545515835",
    runAttempt: 1,
    jobId: "112549922961",
    status: "completed",
    conclusion: "cancelled",
    completedAt: "2026-10-06T23:32:26Z"
  },
  executeNotAfter: "2026-10-07T06:53:54.742Z"
});

export const APPROVED_R3_INCIDENT_588DA0DC = freeze({
  proposalDigest: "sha256:e891c70738cebae883bb0032f9bd3c20c08c11542a6415ab69cbce0eed64f6d3",
  approvalDigest: "sha256:5944c7bc7c638135f718950a8001718c7cf5527441d92f4a7558ea8bc881e3c4",
  profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
  ownerId: "keqi119",
  operationRef: "588da0dc-713a-4832-ab04-96421ed50236",
  sessionId: "5a06703e-4dff-4872-be81-a92ef822ae5c",
  openingDigest: "sha256:e36ed588835f38d4b1e29d6e388c647fd96bc082f79c00f9925935ad20b95ce1",
  requestDigest: "sha256:86c7c77a360de111037a0e354d2714e55e3f09affe97597508e502ff9e9316a6",
  consumptionDigest: "sha256:cda4f6a4cd34c1d5225fc87fd8dad4f6043446e9729ff976810ab5c68982f345",
  executionDigest: "sha256:9b267d09687253c6081f3ad64a9a09c68e1a10cb9dd9a395e7a821d6c0c07834",
  sessionDigest: "sha256:64fd3913b34cd24602bb5d0a22c4245a166fa79108a1ef5293b2e57462107015",
  lockDigest: "sha256:0250e8ae3f07ae05e04e3fe03770140c279dc8ee7edd29d49b9e855033658018",
  lockNames: [
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json",
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json"
  ],
  github: {
    repository: "keqi119/subscription-Saas",
    runId: "37556016543",
    runAttempt: 1,
    jobId: "112583597083",
    status: "completed",
    conclusion: "failure",
    completedAt: "2026-10-07T01:30:12Z"
  },
  executeNotAfter: "2026-10-07T06:53:54.742Z"
});

// The approved incident's original source is installed independently of later
// verifier releases. This binding grants no authority; the historical reader
// still authenticates every archived input, source file and CI attestation.
const APPROVED_R3_HISTORICAL_SOURCE = freeze({
  operationRef: "3b451859-631a-49d7-9059-d8051cb9e7d9",
  profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
  sourceSha: "127a9eb281a65b216b53e863ad9734ac4650399e",
  proofRawDigest: "sha256:08dbcfa5fba486e15e919745ce79c83145d0489faddba7325bd4bf5d6958ef16",
  materialRawDigest: "sha256:601d61606ace6e4566c6ed632d06880ff0f9d2f7ba8f19793aaa4bfb07c15aab",
  creationSpecDigest: "sha256:36ccc8274c9c5b3688581faf63a4346138b9fc9248eec2b715b34b559777de54",
  jobAdmissionDigest: "sha256:211fdcd1327da1dae8dc348d70dc35f445f4173a65a964705dc29a8536e5129e",
  sourceRoot: "/opt/stage1-r3-candidate-127a9eb"
});

const APPROVED_R3_HISTORICAL_SOURCE_0AF9C545 = freeze({
  operationRef: APPROVED_R3_INCIDENT_0AF9C545.operationRef,
  profileDigest: APPROVED_R3_INCIDENT_0AF9C545.profileDigest,
  sourceSha: "b16f5aebb6b8599eb807c65751018a4d4efe224b",
  proofRawDigest: "sha256:4541fd36e754bd2c86fbef8a30f69050c3c5e480c54cae2d94c7dc9d7e1d776a",
  materialRawDigest: "sha256:59f6f9e61a8676d3113b73f7e6bbf193f09d2822d4d533f38d5596e428ae028d",
  creationSpecDigest: "sha256:b67f92679b7af2130714a765bda0b92462e166e436058f033cd638e20fc213f7",
  jobAdmissionDigest: "sha256:89e88f63fb306e16634cd0952fe7c03a7e87004abfc2199fc2e79f1be60ba301",
  sourceRoot: "/opt/stage1-r3-candidate-b16f5ae"
});

const APPROVED_R3_HISTORICAL_SOURCE_588DA0DC = freeze({
  operationRef: APPROVED_R3_INCIDENT_588DA0DC.operationRef,
  profileDigest: APPROVED_R3_INCIDENT_588DA0DC.profileDigest,
  sourceSha: "8928a0ffa3c29609e0da99144de2415438c9d081",
  proofRawDigest: "sha256:db884e1a359b40e5085b72f90d77e428d52557b03613838904d4748a3f867c3f",
  materialRawDigest: "sha256:c845f7a0edf3a88685c77823f9fd2ab2135ee0083c54a117eaf8f44a134a7d4d",
  creationSpecDigest: "sha256:de38862595bf073531fc8ce6a987f1583dd45e4207f1ff5455dfb76ffd692555",
  jobAdmissionDigest: "sha256:49836924c8b071bd7f19bf09b6f15f88279c83d6f38214b6864029d7739eb6d4",
  sourceRoot: "/opt/stage1-r3-candidate-8928a0f"
});

const APPROVED_R3_HISTORICAL_CONTRACT_588DA0DC = freeze({
  sourceRoot: APPROVED_R3_HISTORICAL_SOURCE_588DA0DC.sourceRoot,
  sourceSha: APPROVED_R3_HISTORICAL_SOURCE_588DA0DC.sourceSha,
  unlistedEntrypoint: "scripts/release/retire-r3-incident-0af9c545.mjs"
});

export function approvedR3HistoricalContractCompatibility(input) {
  return approvedR3HistoricalSourceBinding(input) ===
    APPROVED_R3_HISTORICAL_SOURCE_588DA0DC.sourceRoot
    ? APPROVED_R3_HISTORICAL_CONTRACT_588DA0DC
    : null;
}

export function approvedR3HistoricalSourceBinding(input) {
  exact(input, [
    "operationRef",
    "profileDigest",
    "sourceSha",
    "proofRawDigest",
    "materialRawDigest",
    "creationSpecDigest",
    "jobAdmissionDigest"
  ]);
  for (const binding of [
    APPROVED_R3_HISTORICAL_SOURCE,
    APPROVED_R3_HISTORICAL_SOURCE_0AF9C545,
    APPROVED_R3_HISTORICAL_SOURCE_588DA0DC
  ])
    if (Object.entries(input).every(([key, value]) => binding[key] === value))
      return binding.sourceRoot;
  return null;
}

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

const dispositions = new WeakMap();
export function matchesR3IncidentDisposition(receipt, consumed, execution) {
  const policy = receipt && dispositions.get(receipt);
  return Boolean(
    policy &&
    sha256Canonical(consumed) === policy.consumptionDigest &&
    sha256Canonical(execution) === policy.executionDigest
  );
}

export function assertR3IncidentSessionShape(policy, graph) {
  const opening = graph.get(policy.openingDigest)?.value;
  const execution = graph.get(policy.executionDigest)?.value;
  const sessionRecords = [...graph.entries()].filter(
    ([, item]) => item.value.kind === "session" && item.value.sessionId === policy.sessionId
  );
  const executions = [...graph.entries()].filter(
    ([, item]) => item.value.kind === "execution" && item.value.sessionId === policy.sessionId
  );
  need(opening?.kind === "session" && opening.status === "OPEN");
  need(execution?.kind === "execution" && execution.status === "INTERRUPTED_UNKNOWN");
  need(executions.length === 1 && executions[0][0] === policy.executionDigest);
  if (policy.sessionDigest === null) {
    need(sessionRecords.length === 1 && sessionRecords[0][0] === policy.openingDigest);
  } else {
    need(
      sessionRecords.length === 2 &&
        sessionRecords.some(([digest]) => digest === policy.openingDigest) &&
        sessionRecords.some(
          ([digest, item]) =>
            digest === policy.sessionDigest && item.value.status === "INTERRUPTED_UNKNOWN"
        )
    );
  }
}

// Only this native reader brands a disposition. Ordinary assessments, booleans,
// job completion and records supplied by a caller cannot enable the exception.
export async function readApprovedR3IncidentDisposition(
  environment,
  graph,
  openingDigest,
  consumptions
) {
  const opening = graph.get(openingDigest)?.value;
  const policies = [
    APPROVED_R3_INCIDENT,
    APPROVED_R3_INCIDENT_0AF9C545,
    APPROVED_R3_INCIDENT_588DA0DC
  ];
  const matched = policies.filter(
    (policy) =>
      opening?.sessionId === policy.sessionId ||
      consumptions.some((value) => value.operationId === policy.operationRef)
  );
  if (matched.length === 0) return null;
  try {
    need(matched.length === 1);
    const p = matched[0];
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
      [p.requestDigest, "archive"]
    ];
    if (p.sessionDigest !== null) originals.push([p.sessionDigest, "journal"]);
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
    assertR3IncidentSessionShape(p, graph);
    need(retainedLocks.every(({ value }) => value.sessionId !== p.sessionId));
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
    dispositions.set(receipt, p);
    return receipt;
  } catch {
    fail();
  }
}
