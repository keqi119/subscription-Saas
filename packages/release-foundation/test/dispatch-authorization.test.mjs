import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertVerifiedDispatchAuthorization,
  dispatchAuthorizationSigningBytes,
  verifyDispatchAuthorization
} from "../src/dispatch-authorization.mjs";
import { sha256Bytes, sha256Canonical } from "../src/digest.mjs";
import { canonicalJson } from "../src/canonical-json.mjs";

const NOW = "2026-09-04T00:01:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

const encode = (value) => Buffer.from(canonicalJson(value));
function signerFixture(issuer) {
  const keys = generateKeyPairSync("ed25519");
  return {
    policy: {
      issuer,
      keyId: issuer + "-key",
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" })
    },
    sign(value, domain, name) {
      return {
        algorithm: "Ed25519",
        issuer,
        keyId: issuer + "-key",
        subjectDigest: sha256Canonical(value),
        signature: sign(null, encode({ domain, [name]: value }), keys.privateKey).toString("base64")
      };
    }
  };
}

function makeDispatchFixture() {
  const authorization = {
    schemaVersion: "rc-dispatch-authorization.v1",
    authorizationId: "test-authorization",
    executionPurpose: "qualification",
    releaseAttemptId: "test-attempt",
    sourceSha: "b".repeat(40),
    producerWorkflow: {
      path: ".github/workflows/sanitized-snapshot.yml",
      ref: "main",
      blobDigest: DIGEST
    },
    rcWorkflow: {
      path: ".github/workflows/release-candidate-gate.yml",
      ref: "main",
      blobDigest: DIGEST
    },
    buildProofDigest: DIGEST,
    buildBundleDigest: DIGEST,
    repositoryContractDigest: DIGEST,
    adapterDigest: DIGEST,
    issuer: "test-dispatch-authority",
    issuedAt: "2026-09-04T00:00:00.000Z",
    notAfter: "2026-09-04T00:10:00.000Z",
    revocationPolicyDigest: DIGEST
  };
  const expected = structuredClone({
    executionPurpose: "qualification",
    releaseAttemptId: "test-attempt",
    sourceSha: "b".repeat(40),
    producerWorkflow: {
      path: ".github/workflows/sanitized-snapshot.yml",
      ref: "main",
      blobDigest: DIGEST
    },
    rcWorkflow: {
      path: ".github/workflows/release-candidate-gate.yml",
      ref: "main",
      blobDigest: DIGEST
    },
    buildProofDigest: DIGEST,
    buildBundleDigest: DIGEST,
    repositoryContractDigest: DIGEST,
    adapterDigest: DIGEST,
    revocationPolicyDigest: DIGEST
  });
  const dispatch = signerFixture("test-dispatch-authority");
  const observer = signerFixture("test-observer");
  const revoker = signerFixture("test-i0");
  const calls = { privileged: [], reads: [], heads: [], journal: [] };
  const archive = {
    reference: "authorization/test",
    objectKey: "authorization/test",
    objectVersion: "version-1",
    terminalAt: "2026-09-04T00:00:00.000Z",
    snapshotExpiresAt: null,
    downstreamRetainUntil: "2027-03-03T00:00:00.000Z",
    legalHoldUntil: null
  };
  const custodyPolicy = {
    signer: observer.policy,
    writerIdentity: "test-writer",
    readerIdentity: "test-independent-reader",
    storeRef: "test-private-store",
    owner: "release-engineering",
    readers: ["audit"]
  };
  const archiveEvidence = (body, detached, location) => {
    const originalBytes = encode(body);
    const contentDigest = sha256Bytes(originalBytes);
    const receipt = {
      schemaVersion: "custody-receipt.v1",
      receiptId: "90d96a42-b007-4050-9c86-7d98a926a1d0",
      contentDigest,
      contentSizeBytes: originalBytes.length,
      storeRef: custodyPolicy.storeRef,
      uploadedAt: "2026-09-04T00:00:00.000Z",
      readbackAt: NOW,
      readbackDigest: contentDigest,
      owner: custodyPolicy.owner,
      readers: [...custodyPolicy.readers],
      retainUntil: "2027-03-04T00:00:00.000Z",
      expiryDisposition: "review",
      attestationRef: "test-attestation"
    };
    const { reference, ...object } = location;
    const observation = {
      schemaVersion: "authoritative-custody-observation.v1",
      issuer: observer.policy.issuer,
      keyId: observer.policy.keyId,
      ...object,
      contentDigest,
      contentSizeBytes: originalBytes.length,
      receiptDigest: sha256Canonical(receipt),
      storeRef: custodyPolicy.storeRef,
      writerIdentity: custodyPolicy.writerIdentity,
      readerIdentity: custodyPolicy.readerIdentity,
      conditionalCreate: "created",
      headDigest: contentDigest,
      getDigest: contentDigest,
      acl: "private",
      lastModified: receipt.uploadedAt,
      readbackAt: NOW,
      worm: {
        id: "test-worm",
        state: "Locked",
        retentionDays: 181,
        retainUntil: receipt.retainUntil
      }
    };
    return {
      originalBytes,
      signature: detached,
      receipt,
      observation,
      observationSignature: observer.sign(
        observation,
        "authoritative-custody-observation.v1",
        "observation"
      )
    };
  };
  let state = {
    schemaVersion: "i0-revocation-state.v1",
    policyDigest: DIGEST,
    sequence: 1,
    revokedAuthorizationIds: [],
    revokedAuthorizationDigests: []
  };
  let checkpoint = { sequence: 1, headDigest: sha256Canonical(state) };
  const input = {
    authorization,
    expected,
    signature: dispatch.sign(authorization, "rc-dispatch-authorization.v1", "authorization"),
    trustPolicy: {
      repository: { id: "1253231368", name: "keqi119/subscription-Saas" },
      actorId: "275060624",
      dispatchSigner: dispatch.policy,
      workflow: {
        executionPurpose: "qualification",
        producerWorkflow: structuredClone(expected.producerWorkflow),
        rcWorkflow: structuredClone(expected.rcWorkflow)
      },
      maxAuthorizationLifetimeMs: 3600000,
      custody: custodyPolicy,
      revocation: {
        policyDigest: DIGEST,
        signer: revoker.policy,
        reader: { identity: "test-controlled-reader", endpoint: "test-controlled-file" },
        initialCheckpoint: { ...checkpoint },
        timeoutMs: 30000,
        maxAgeMs: 120000
      }
    },
    clock: { now: () => NOW },
    revocationJournal: {
      readCheckpoint(policyDigest) {
        assert.equal(policyDigest, DIGEST);
        return { ...checkpoint };
      },
      recordVerifiedHead(next) {
        assert.equal(next.policyDigest, DIGEST);
        if (
          next.sequence < checkpoint.sequence ||
          (next.sequence === checkpoint.sequence && next.headDigest !== checkpoint.headDigest)
        )
          throw Object.assign(new Error(), { code: "DISPATCH_REVOCATION_ROLLBACK" });
        checkpoint = { sequence: next.sequence, headDigest: next.headDigest };
        calls.journal.push({ ...next });
      }
    },
    evidenceSource: {
      identity: "test-controlled-reader",
      endpoint: "test-controlled-file",
      async readRevocationHead(request) {
        calls.heads.push(request);
        const response = {
          schemaVersion: "i0-revocation-read.v1",
          issuer: revoker.policy.issuer,
          keyId: revoker.policy.keyId,
          policyDigest: DIGEST,
          nonce: request.nonce,
          authorizationDigest: request.authorizationDigest,
          sequence: state.sequence,
          headDigest: sha256Canonical(state),
          issuedAt: NOW,
          notAfter: "2026-09-04T00:03:00.000Z",
          revokedAuthorizationIds: [...state.revokedAuthorizationIds],
          revokedAuthorizationDigests: [...state.revokedAuthorizationDigests],
          archive: { ...archive, reference: "head/test", objectKey: "head/test" }
        };
        return { response, signature: revoker.sign(response, "i0-revocation-read.v1", "response") };
      },
      async readExact({ reference, expectedDigest }) {
        calls.reads.push({ reference, expectedDigest });
        const body = reference === archive.reference ? authorization : state;
        assert.equal(expectedDigest, sha256Canonical(body));
        return archiveEvidence(
          body,
          reference === archive.reference
            ? input.signature
            : revoker.sign(state, "i0-revocation-state.v1", "state"),
          reference === archive.reference
            ? archive
            : { ...archive, reference: "head/test", objectKey: "head/test" }
        );
      }
    }
  };
  input.expected.authorizationCustody = archive;
  return {
    input,
    calls,
    dispatch,
    observer,
    revoker,
    archiveEvidence,
    setState(value) {
      state = value;
    },
    state: () => structuredClone(state),
    setCheckpoint(value) {
      checkpoint = value;
    },
    resign() {
      input.signature = dispatch.sign(
        authorization,
        "rc-dispatch-authorization.v1",
        "authorization"
      );
    }
  };
}

test("schema-valid unsigned dispatch cannot reach a privileged consumer", async () => {
  const { input, calls } = makeDispatchFixture();
  await assert.rejects(verifyDispatchAuthorization({ ...input, signature: undefined }), {
    code: "DISPATCH_SIGNATURE_INVALID"
  });
  assert.deepEqual(calls.privileged, []);
});

test("caller-created verified decision is rejected", () => {
  const { input } = makeDispatchFixture();
  assert.throws(
    () =>
      assertVerifiedDispatchAuthorization(
        { verified: true, authorization: input.authorization },
        { expected: input.expected, now: input.clock.now() }
      ),
    { code: "DISPATCH_DECISION_UNVERIFIED" }
  );
});

async function consumer(fixture) {
  const decision = await verifyDispatchAuthorization(fixture.input);
  assertVerifiedDispatchAuthorization(decision, {
    expected: fixture.input.expected,
    now: fixture.input.clock.now()
  });
  fixture.calls.privileged.push("sign-admission", "jit", "credentials", "dispatch");
  return decision;
}

test("real signatures and private custody yield an immutable process-local decision", async () => {
  const f = makeDispatchFixture();
  const decision = await consumer(f);
  assert.equal(decision.authorizationDigest, sha256Canonical(f.input.authorization));
  assert.equal(decision.revocationSequence, 1);
  assert.ok(Object.isFrozen(decision.authorization.producerWorkflow));
  assert.ok(Object.isFrozen(decision.expected.authorizationCustody));
  assert.throws(() => {
    decision.authorization.producerWorkflow.path = "changed";
  }, TypeError);
  for (const clone of [
    { ...decision },
    structuredClone(decision),
    JSON.parse(JSON.stringify(decision))
  ])
    assert.throws(
      () => assertVerifiedDispatchAuthorization(clone, { expected: f.input.expected, now: NOW }),
      { code: "DISPATCH_DECISION_UNVERIFIED" }
    );
  assert.throws(
    () =>
      assertVerifiedDispatchAuthorization(decision, {
        expected: f.input.expected,
        now: "2026-09-04T00:03:00.000Z"
      }),
    { code: "DISPATCH_EVIDENCE_EXPIRED" }
  );
});

test("signing bytes are domain-separated canonical authorization bytes only", () => {
  const f = makeDispatchFixture();
  assert.deepEqual(
    Buffer.from(dispatchAuthorizationSigningBytes(f.input.authorization)),
    encode({ domain: "rc-dispatch-authorization.v1", authorization: f.input.authorization })
  );
  assert.equal(Object.keys(f.input.signature).length, 5);
});

test("schema-valid UTC timestamp spellings remain signed verbatim and verify", async () => {
  const f = makeDispatchFixture();
  f.input.authorization.issuedAt = "2026-09-04T00:00:00Z";
  f.input.authorization.notAfter = "2026-09-04T00:10:00.123456Z";
  f.input.clock.now = () => "2026-09-04T00:01:00Z";
  f.resign();
  const read = f.input.evidenceSource.readRevocationHead;
  f.input.evidenceSource.readRevocationHead = async (request) => {
    const frame = await read(request);
    frame.response.issuedAt = "2026-09-04T00:01:00Z";
    frame.response.notAfter = "2026-09-04T00:02:59.123456Z";
    frame.signature = f.revoker.sign(frame.response, "i0-revocation-read.v1", "response");
    return frame;
  };
  const decision = await consumer(f);
  assert.equal(decision.authorization.issuedAt, "2026-09-04T00:00:00Z");
  assert.equal(decision.authorization.notAfter, "2026-09-04T00:10:00.123456Z");
});

test("invalid detached signatures fail before evidence and privileged side effects", async () => {
  for (const mutate of [
    (v) => {
      v.signature = undefined;
    },
    (v) => {
      v.signature.algorithm = "RSA";
    },
    (v) => {
      v.signature.keyId = "other";
    },
    (v) => {
      v.signature.issuer = "other";
    },
    (v) => {
      v.signature.subjectDigest = DIGEST;
    },
    (v) => {
      v.signature.signature = "AAAA";
    },
    (v) => {
      v.signature.signature += "\n";
    },
    (v) => {
      v.signature.verified = true;
    },
    (v) => {
      v.authorization.authorizationId = "changed";
    },
    (v) => {
      v.trustPolicy.dispatchSigner.publicKey = signerFixture("wrong").policy.publicKey;
    }
  ]) {
    const f = makeDispatchFixture();
    mutate(f.input);
    await assert.rejects(consumer(f), { code: "DISPATCH_SIGNATURE_INVALID" });
    assert.deepEqual(f.calls.privileged, []);
    assert.deepEqual(f.calls.reads, []);
    assert.deepEqual(f.calls.heads, []);
  }
});

test("every expected identity is mandatory and binds independently of signed authorization", async () => {
  for (const field of [
    "executionPurpose",
    "releaseAttemptId",
    "sourceSha",
    "buildProofDigest",
    "buildBundleDigest",
    "repositoryContractDigest",
    "adapterDigest",
    "revocationPolicyDigest",
    "producerWorkflow.path",
    "producerWorkflow.ref",
    "producerWorkflow.blobDigest",
    "rcWorkflow.path",
    "rcWorkflow.ref",
    "rcWorkflow.blobDigest"
  ]) {
    const f = makeDispatchFixture();
    const [outer, inner] = field.split(".");
    if (inner) f.input.expected[outer][inner] = "different";
    else f.input.expected[outer] = "different";
    await assert.rejects(consumer(f), { code: "DISPATCH_BINDING_MISMATCH" });
    assert.deepEqual(f.calls.privileged, []);
    assert.deepEqual(f.calls.heads, []);
  }
  const f = makeDispatchFixture();
  f.input.authorization.executionPurpose = "release-candidate";
  f.resign();
  await assert.rejects(consumer(f), { code: "DISPATCH_BINDING_MISMATCH" });
});

test("approval classes, legacy purpose and future dispatch fields never authorize", async () => {
  for (const mutate of [
    ...["external-change-approval.v1", "approval-record.v1", "exact-capability-approval.v1"].map(
      (schema) => (v) => {
        v.schemaVersion = schema;
      }
    ),
    (v) => {
      v.executionPurpose = "stage1-qualification";
    },
    (v) => {
      delete v.executionPurpose;
    },
    ...["futureRunId", "manifestDigest", "database", "commandId", "planDigest"].map(
      (field) => (v) => {
        v[field] = "not-dispatch";
      }
    )
  ]) {
    const f = makeDispatchFixture();
    mutate(f.input.authorization);
    f.resign();
    await assert.rejects(consumer(f), { code: "DISPATCH_SIGNATURE_INVALID" });
    assert.deepEqual(f.calls.privileged, []);
  }
});

test("authorization and caller clock require finite bounded valid intervals", async () => {
  for (const mutate of [
    (v) => {
      v.authorization.issuedAt = "2026-09-04T00:02:00.000Z";
    },
    (v) => {
      v.authorization.notAfter = NOW;
    },
    (v) => {
      v.authorization.notAfter = "2026-09-05T00:00:00.000Z";
    },
    (v) => {
      v.clock.now = () => Infinity;
    }
  ]) {
    const f = makeDispatchFixture();
    mutate(f.input);
    f.resign();
    await assert.rejects(consumer(f), { code: "DISPATCH_EVIDENCE_EXPIRED" });
    assert.deepEqual(f.calls.privileged, []);
  }
  for (const issuedAt of ["Infinity", "2026-02-30T00:00:00.000Z"]) {
    const f = makeDispatchFixture();
    f.input.authorization.issuedAt = issuedAt;
    f.resign();
    await assert.rejects(consumer(f), { code: "DISPATCH_SIGNATURE_INVALID" });
  }
});

test("closed protected policy and reader frames reject missing or unapproved trust", async () => {
  for (const mutate of [
    (v) => {
      delete v.expected.adapterDigest;
    },
    (v) => {
      v.expected.verified = true;
    },
    (v) => {
      v.trustPolicy.actorId = "other";
    },
    (v) => {
      v.trustPolicy.repository.id = "other";
    },
    (v) => {
      v.trustPolicy.repository.name = "other";
    },
    (v) => {
      v.trustPolicy.extra = true;
    },
    (v) => {
      v.trustPolicy.custody.signer.extra = true;
    },
    (v) => {
      v.trustPolicy.revocation.timeoutMs = 0;
    },
    (v) => {
      v.trustPolicy.revocation.maxAgeMs = Infinity;
    },
    (v) => {
      delete v.trustPolicy.revocation.initialCheckpoint;
    },
    (v) => {
      v.evidenceSource.endpoint = "unapproved";
    },
    (v) => {
      v.evidenceSource.identity = "other";
    },
    (v) => {
      v.evidenceSource.cached = true;
    },
    (v) => {
      v.evidenceSource.readRevocationHead = undefined;
    },
    (v) => {
      v.revocationJournal.readCheckpoint = () => undefined;
    }
  ]) {
    const f = makeDispatchFixture();
    mutate(f.input);
    await assert.rejects(consumer(f));
    assert.deepEqual(f.calls.privileged, []);
  }
});

test("online signed head rejects substitution, unsigned facts and replay", async () => {
  for (const [mutate, code] of [
    [
      (v) => {
        v.response.policyDigest = `sha256:${"b".repeat(64)}`;
      },
      "DISPATCH_EVIDENCE_INVALID"
    ],
    [
      (v) => {
        v.response.nonce = "b".repeat(64);
      },
      "DISPATCH_EVIDENCE_INVALID"
    ],
    [
      (v) => {
        v.response.authorizationDigest = DIGEST;
      },
      "DISPATCH_EVIDENCE_INVALID"
    ],
    [
      (v) => {
        v.response.issuer = "wrong";
      },
      "DISPATCH_EVIDENCE_INVALID"
    ],
    [
      (v) => {
        v.response.headDigest = DIGEST;
      },
      "DISPATCH_EVIDENCE_INVALID"
    ],
    [
      (v) => {
        v.response.sequence = NaN;
      },
      "DISPATCH_EVIDENCE_INVALID"
    ],
    [
      (v) => {
        v.response.issuedAt = "2026-09-03T00:00:00.000Z";
      },
      "DISPATCH_EVIDENCE_EXPIRED"
    ],
    [
      (v) => {
        v.response.notAfter = NOW;
      },
      "DISPATCH_EVIDENCE_EXPIRED"
    ],
    [
      (v) => {
        v.response.verified = true;
      },
      "DISPATCH_EVIDENCE_INVALID"
    ],
    [
      (v) => {
        v.signature = undefined;
      },
      "DISPATCH_EVIDENCE_INVALID"
    ]
  ]) {
    const f = makeDispatchFixture();
    const read = f.input.evidenceSource.readRevocationHead;
    f.input.evidenceSource.readRevocationHead = async (request) => {
      const frame = await read(request);
      mutate(frame);
      if (frame.signature && Number.isFinite(frame.response.sequence))
        frame.signature = f.revoker.sign(frame.response, "i0-revocation-read.v1", "response");
      return frame;
    };
    await assert.rejects(consumer(f), { code });
    assert.deepEqual(f.calls.privileged, []);
  }
});

test("same committed head accepts new nonce but revocation after prior success is rejected", async () => {
  const f = makeDispatchFixture();
  await verifyDispatchAuthorization(f.input);
  await verifyDispatchAuthorization(f.input);
  assert.notEqual(f.calls.heads[0].nonce, f.calls.heads[1].nonce);
  for (const revokedField of ["revokedAuthorizationIds", "revokedAuthorizationDigests"]) {
    f.setState({
      ...f.state(),
      sequence: f.state().sequence + 1,
      revokedAuthorizationIds: [],
      revokedAuthorizationDigests: [],
      [revokedField]: [
        revokedField.endsWith("Ids")
          ? f.input.authorization.authorizationId
          : sha256Canonical(f.input.authorization)
      ]
    });
    await assert.rejects(consumer(f), { code: "DISPATCH_REVOKED" });
    assert.deepEqual(f.calls.privileged, []);
  }
});

test("verified revoked heads advance high-water mark before rejection", async () => {
  const f = makeDispatchFixture();
  f.setState({
    ...f.state(),
    sequence: 2,
    revokedAuthorizationIds: [f.input.authorization.authorizationId]
  });
  await assert.rejects(consumer(f), { code: "DISPATCH_REVOKED" });
  assert.equal(f.calls.journal.at(-1)?.sequence, 2);
  f.setState({ ...f.state(), sequence: 1, revokedAuthorizationIds: [] });
  await assert.rejects(consumer(f), { code: "DISPATCH_REVOCATION_ROLLBACK" });
  assert.deepEqual(f.calls.privileged, []);
});

test("closed entry frames reject extra purpose and getters without invoking caller code", async () => {
  const extra = makeDispatchFixture();
  extra.input.purpose = "release-candidate";
  await assert.rejects(consumer(extra));
  assert.deepEqual(extra.calls.privileged, []);
  const f = makeDispatchFixture();
  let reads = 0;
  Object.defineProperty(f.input, "authorization", {
    get() {
      reads++;
      return {};
    },
    enumerable: true
  });
  await assert.rejects(consumer(f));
  assert.equal(reads, 0);
  assert.deepEqual(f.calls.privileged, []);
});

test("temporary persistent journal survives independent verifier restart", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dispatch-journal-"));
  const checkpointFile = path.join(directory, "checkpoint.json");
  try {
    const f = makeDispatchFixture();
    writeFileSync(checkpointFile, JSON.stringify(f.input.trustPolicy.revocation.initialCheckpoint));
    const journal = () => ({
      readCheckpoint() {
        return JSON.parse(readFileSync(checkpointFile, "utf8"));
      },
      recordVerifiedHead({ sequence, headDigest }) {
        const previous = JSON.parse(readFileSync(checkpointFile, "utf8"));
        if (
          sequence < previous.sequence ||
          (sequence === previous.sequence && headDigest !== previous.headDigest)
        )
          throw Object.assign(new Error(), { code: "DISPATCH_REVOCATION_ROLLBACK" });
        writeFileSync(checkpointFile, JSON.stringify({ sequence, headDigest }));
      }
    });
    f.input.revocationJournal = journal();
    f.setState({ ...f.state(), sequence: 2 });
    await verifyDispatchAuthorization(f.input);
    const restarted = await import("../src/dispatch-authorization.mjs?restart=persistent");
    f.input.revocationJournal = journal();
    f.setState({ ...f.state(), sequence: 1 });
    await assert.rejects(restarted.verifyDispatchAuthorization(f.input), {
      code: "DISPATCH_REVOCATION_ROLLBACK"
    });
    assert.deepEqual(f.calls.privileged, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("journal disappearance, write failure and concurrent advancement deny decisions", async () => {
  for (const record of [
    (f) => {
      throw new Error("write failed");
    },
    (f) => {
      f.setCheckpoint(undefined);
    },
    (f) => {
      f.setCheckpoint({ sequence: 3, headDigest: DIGEST });
    }
  ]) {
    const f = makeDispatchFixture();
    f.input.revocationJournal.recordVerifiedHead = () => record(f);
    await assert.rejects(consumer(f));
    assert.deepEqual(f.calls.privileged, []);
  }
});

test("index exposes the unique read-only verifier and contract manifest covers its dependencies", async () => {
  const index = await import("../src/index.mjs");
  assert.equal(index.verifyDispatchAuthorization, verifyDispatchAuthorization);
  assert.equal(index.dispatchAuthorizationSigningBytes, dispatchAuthorizationSigningBytes);
  assert.equal(typeof index.verifyAuthoritativeCustodyObservation, "function");
  const manifest = JSON.parse(
    readFileSync(
      new URL("../../../release/contracts/repository-contract-files.v1.json", import.meta.url),
      "utf8"
    )
  );
  for (const file of [
    "packages/release-foundation/src/dispatch-authorization.mjs",
    "release/contracts/schemas/authoritative-custody-observation.v1.schema.json"
  ])
    assert.ok(manifest.files.includes(file));
});

test("journal rejects same-sequence equivocation, rollback and old empty head after restart", async () => {
  const f = makeDispatchFixture();
  f.setState({ ...f.state(), sequence: 2 });
  await verifyDispatchAuthorization(f.input);
  f.setState({ ...f.state(), sequence: 1 });
  await assert.rejects(consumer(f), { code: "DISPATCH_REVOCATION_ROLLBACK" });
  f.setState({ ...f.state(), sequence: 2, revokedAuthorizationIds: ["another-authorization"] });
  await assert.rejects(consumer(f), { code: "DISPATCH_REVOCATION_ROLLBACK" });
  const restarted = await import("../src/dispatch-authorization.mjs?restart=monotonic");
  f.setState({ ...f.state(), sequence: 1, revokedAuthorizationIds: [] });
  await assert.rejects(restarted.verifyDispatchAuthorization(f.input), {
    code: "DISPATCH_REVOCATION_ROLLBACK"
  });
  assert.deepEqual(f.calls.privileged, []);
});

test("inaccessible and timed out evidence cannot enter privileged consumers", async () => {
  for (const mode of ["throw", "timeout"]) {
    const f = makeDispatchFixture();
    f.input.trustPolicy.revocation.timeoutMs = 5;
    f.input.evidenceSource.readRevocationHead = () => {
      if (mode === "throw") throw new Error("not available");
      return new Promise(() => {});
    };
    await assert.rejects(consumer(f), { code: "DISPATCH_EVIDENCE_UNAVAILABLE" });
    assert.deepEqual(f.calls.privileged, []);
  }
});

test("original authorization and head archives reject incomplete or forged private custody", async () => {
  for (const target of ["authorization/test", "head/test"]) {
    for (const mutate of [
      (v) => {
        v.originalBytes = Buffer.from("tampered");
      },
      (v) => {
        v.receipt.immutable = true;
      },
      (v) => {
        v.observationSignature = undefined;
      },
      (v) => {
        v.observation.readerIdentity = "test-writer";
      },
      (v) => {
        v.observation.worm.state = "Unlocked";
      },
      (v) => {
        v.signature.subjectDigest = DIGEST;
      }
    ]) {
      const f = makeDispatchFixture();
      const read = f.input.evidenceSource.readExact;
      f.input.evidenceSource.readExact = async (request) => {
        const frame = await read(request);
        if (request.reference === target) mutate(frame);
        return frame;
      };
      await assert.rejects(consumer(f), { code: "DISPATCH_EVIDENCE_INVALID" });
      assert.deepEqual(f.calls.privileged, []);
    }
  }
});

test("asynchronous reads cannot mutate the verified snapshots or extend expiry", async () => {
  const f = makeDispatchFixture();
  const originalExpected = structuredClone(f.input.expected);
  const read = f.input.evidenceSource.readRevocationHead;
  f.input.evidenceSource.readRevocationHead = async (request) => {
    const result = await read(request);
    f.input.expected.sourceSha = "c".repeat(40);
    f.input.trustPolicy.workflow.executionPurpose = "release-candidate";
    return result;
  };
  const decision = await verifyDispatchAuthorization(f.input);
  assert.equal(decision.expected.sourceSha, originalExpected.sourceSha);
  assert.throws(
    () => assertVerifiedDispatchAuthorization(decision, { expected: f.input.expected, now: NOW }),
    { code: "DISPATCH_BINDING_MISMATCH" }
  );
  const expiring = makeDispatchFixture();
  const exact = expiring.input.evidenceSource.readExact;
  // The clock method is captured; its trusted source still advances, not its caller-owned property.
  let clockValue = NOW;
  expiring.input.clock.now = () => clockValue;
  expiring.input.evidenceSource.readExact = async (request) => {
    const result = await exact(request);
    clockValue = "2026-09-04T00:11:00.000Z";
    return result;
  };
  await assert.rejects(consumer(expiring), { code: "DISPATCH_EVIDENCE_EXPIRED" });
  assert.deepEqual(expiring.calls.privileged, []);
});

test("public dispatch handler surface is read-only and has no forward runtime imports", async () => {
  const module = await import("../src/dispatch-authorization.mjs");
  assert.deepEqual(Object.keys(module).sort(), [
    "assertVerifiedDispatchAuthorization",
    "dispatchAuthorizationSigningBytes",
    "verifyDispatchAuthorization"
  ]);
  const source = readFileSync(
    new URL("../src/dispatch-authorization.mjs", import.meta.url),
    "utf8"
  );
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(
    imports.every((name) =>
      [
        "node:crypto",
        "node:perf_hooks",
        "./canonical-json.mjs",
        "./digest.mjs",
        "./schema-registry.mjs",
        "./evidence-custody.mjs"
      ].includes(name)
    )
  );
  assert.ok(!/\b(?:sign|spawn|exec|fetch)\s*\(/.test(source));
});
