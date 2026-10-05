import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import * as operation from "./evidence-archive-operation.mjs";
import { verifyAuthoritativeCustodyObservation } from "../../packages/release-foundation/src/evidence-custody.mjs";

import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  createEvidenceArchiveReaderTransport,
  createEvidenceArchiveWriterTransport
} from "./evidence-archive-storage.mjs";

const account = "1457643390906675";
const bucket = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const writerRole = `acs:ram::${account}:role/subscription-saas-stage1-archive-writer`;
const readerRole = `acs:ram::${account}:role/subscription-saas-stage1-archive-reader`;
const bytes = Buffer.from('{"schemaVersion":"approval-record.v1","decision":"approve"}');
const parsed = JSON.parse(bytes.toString());
const object = {
  proofType: parsed.schemaVersion,
  canonicalDigest: sha256Canonical(parsed),
  exactKey: `control-evidence/v1/${parsed.schemaVersion}/${sha256Canonical(parsed)}`,
  contentDigest: sha256Bytes(bytes),
  contentSizeBytes: bytes.length
};
const d = (x) => `sha256:${x.repeat(64)}`;
const date = "Thu, 01 Oct 2026 00:00:00 GMT";
const acl = `<AccessControlPolicy><Owner><ID>${account}</ID><DisplayName>owner</DisplayName></Owner><AccessControlList><Grant>private</Grant></AccessControlList></AccessControlPolicy>`;
const worm =
  "<WormConfiguration><WormId>worm-1</WormId><State>Locked</State><RetentionPeriodInDays>210</RetentionPeriodInDays><CreationDate>2026-09-01T00:00:00Z</CreationDate></WormConfiguration>";
const versioning =
  '<VersioningConfiguration xmlns="http://doc.oss-cn-hangzhou.aliyuncs.com"></VersioningConfiguration>';

const keyPair = generateKeyPairSync("ed25519");
const archiveSigner = {
  issuer: "keqi119",
  keyId: sha256Bytes(keyPair.publicKey.export({ type: "spki", format: "der" })),
  publicKey: keyPair.publicKey.export({ type: "spki", format: "pem" })
};
function detached(domain, name, body) {
  return {
    algorithm: "Ed25519",
    issuer: archiveSigner.issuer,
    keyId: archiveSigner.keyId,
    subjectDigest: sha256Canonical(body),
    signature: sign(
      null,
      Buffer.from(canonicalJson({ domain, [name]: body })),
      keyPair.privateKey
    ).toString("base64")
  };
}
function authorized(kind) {
  const auth = authorization(operation.ARCHIVE_PROFILES[kind]);
  auth.issuer = { id: archiveSigner.issuer, keyId: archiveSigner.keyId };
  auth.executor.publicKeyDigest = archiveSigner.keyId;
  auth.identities.management = `acs:ram::${account}:root`;
  const policy = {
    managementIdentity: auth.identities.management,
    revocationPolicyDigest: auth.revocationPolicyDigest,
    owner: archiveSigner.issuer,
    readers: [readerRole],
    downstreamRetainUntil: "2027-03-31T00:00:00.000Z",
    snapshotExpiresAt: null,
    legalHoldUntil: null
  };
  auth.custodyPolicyDigest = sha256Canonical(policy);
  const chainOriginals = Object.fromEntries(
    [
      "changePlanDigest",
      "externalChangeApprovalDigest",
      "applyProofDigest",
      "resourceReadbackDigest"
    ].map((name) => [name, { fixture: name }])
  );
  for (const [name, body] of Object.entries(chainOriginals))
    auth.chain[name] = sha256Canonical(body);
  const state = {
    schemaVersion: "i0-revocation-state.v1",
    policyDigest: auth.revocationPolicyDigest,
    sequence: 0,
    revokedAuthorizationIds: [],
    revokedAuthorizationDigests: []
  };
  return {
    packet: {
      authorization: auth,
      signature: detached("evidence-archive-authorization.v1", "authorization", auth)
    },
    policy,
    chainOriginals,
    revocation: { state, signature: detached("i0-revocation-state.v1", "state", state) },
    expected: {
      authorizationDigest: sha256Canonical(auth),
      kind,
      sourceDigest: auth.executor.sourceDigest,
      runtimeDigest: auth.executor.runtimeDigest
    },
    signer: archiveSigner,
    now: "2026-10-01T00:00:01.000Z",
    active: true
  };
}

async function archiveObserved(kind) {
  const input = authorized(kind),
    auth = input.packet.authorization;
  const role = kind === "writer" ? writerRole : readerRole;
  const fixture = harness(role),
    sts = session(role);
  const transport =
    kind === "writer"
      ? await createEvidenceArchiveWriterTransport(
          {
            authorization: auth,
            originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
            session: sts
          },
          fixture.deps
        )
      : await createEvidenceArchiveReaderTransport(
          { authorization: auth, session: sts },
          fixture.deps
        );
  const result =
    kind === "writer"
      ? await transport.createOnly({ exactKey: object.exactKey, originalBytes: bytes })
      : await transport.readback({ exactKey: object.exactKey });
  const publicSession = {
    arn: sts.arn,
    issuedAt: sts.issuedAt,
    expiresAt: sts.expiresAt,
    fingerprint: operation.archiveSessionFingerprint(sts, transport.identityOriginal)
  };
  const io = {
    status: "ARCHIVE_IO_OBSERVED",
    authorizationDigest: input.expected.authorizationDigest,
    profile: auth.profile,
    operationId: auth.operationId,
    session: publicSession,
    identityOriginal: transport.identityOriginal,
    startedAt: input.now,
    observedAt: input.now,
    objects: [{ exactKey: object.exactKey, result }]
  };
  const terminal = {
    status: "ARCHIVE_TERMINAL_OBSERVED",
    authorizationDigest: io.authorizationDigest,
    profile: auth.profile,
    operationId: auth.operationId,
    ioDigest: sha256Canonical(io),
    session: publicSession,
    ioObservedAt: io.observedAt,
    authority: {
      startedAt: input.now,
      finishedAt: "2026-10-01T00:00:02.000Z",
      exited: true,
      exitCode: 0
    },
    sessionDisposal: {
      path: `/var/lib/stage1-volumes/main/snapshot-authority/archive-${kind}-session.json`,
      removed: true,
      removedAt: "2026-10-01T00:00:03.000Z",
      absent: true,
      expiresAt: publicSession.expiresAt,
      observedAt: "2026-10-01T00:10:01.000Z"
    }
  };
  return {
    authorization: auth,
    io,
    terminal,
    signer: archiveSigner,
    issuedAt: "2026-10-01T00:10:02.000Z"
  };
}

async function custodyFixture(policy = authorized("reader").policy) {
  const writer = globalThis.structuredClone(await archiveObserved("writer"));
  writer.authorization.custodyPolicyDigest = sha256Canonical(policy);
  writer.io.authorizationDigest = writer.terminal.authorizationDigest = sha256Canonical(
    writer.authorization
  );
  writer.terminal.ioDigest = sha256Canonical(writer.io);
  const writerSubject = await operation.buildArchiveAccessSubject({ ...writer, custody: null });
  const writerProof = {
    ...writerSubject,
    signature: detached("h1-evidence-archive-access.v1", "subject", writerSubject)
  };
  const reader = globalThis.structuredClone(await archiveObserved("reader"));
  reader.authorization.custodyPolicyDigest = sha256Canonical(policy);
  reader.authorization.notAfter = "2026-10-01T00:30:00.000Z";
  reader.authorization.chain.predecessorTerminalReceiptDigest = sha256Canonical(
    writerSubject.receipt
  );
  reader.io.authorizationDigest = sha256Canonical(reader.authorization);
  reader.terminal.authorizationDigest = reader.io.authorizationDigest;
  reader.io.session.issuedAt = "2026-10-01T00:10:03.000Z";
  reader.io.session.expiresAt = "2026-10-01T00:20:03.000Z";
  reader.io.session.fingerprint = operation.archiveSessionFingerprint(
    reader.io.session,
    reader.io.identityOriginal
  );
  reader.io.startedAt = reader.io.observedAt = "2026-10-01T00:10:04.000Z";
  const result = reader.io.objects[0].result;
  result.observedAt = reader.io.observedAt;
  for (let i = 0; i < result.evidence.records.length; i++) {
    result.evidence.records[i].observedAt = reader.io.observedAt;
    const raw = Buffer.from(canonicalJson(result.evidence.records[i]));
    result.evidence.originals[i * 2 + 1] = {
      digest: sha256Bytes(raw),
      bytesBase64: raw.toString("base64")
    };
  }
  reader.terminal.session = reader.io.session;
  reader.terminal.ioObservedAt = reader.io.observedAt;
  reader.terminal.ioDigest = sha256Canonical(reader.io);
  reader.terminal.authority.startedAt = reader.io.startedAt;
  reader.terminal.authority.finishedAt = "2026-10-01T00:10:05.000Z";
  reader.terminal.sessionDisposal.removedAt = "2026-10-01T00:10:06.000Z";
  reader.terminal.sessionDisposal.expiresAt = reader.io.session.expiresAt;
  reader.terminal.sessionDisposal.observedAt = "2026-10-01T00:20:04.000Z";
  reader.issuedAt = "2026-10-01T00:20:05.000Z";
  return {
    reader,
    predecessor: {
      authorization: writer.authorization,
      io: writer.io,
      terminal: writer.terminal,
      proof: writerProof
    },
    policy
  };
}

const signedCustody = (records) => ({
  ...records,
  objects: records.objects.map((entry) => ({
    ...entry,
    signature: detached("authoritative-custody-observation.v1", "observation", entry.observation)
  }))
});
async function readerAccessInput() {
  const f = await custodyFixture();
  return {
    ...f.reader,
    custody: signedCustody(
      await operation.buildArchiveCustodyRecords({
        ...f.reader,
        predecessor: f.predecessor,
        policy: f.policy
      })
    )
  };
}

test("authoritative archive custody uses actual readback, writer terminal and physical retention", async () => {
  assert.equal(typeof operation.buildArchiveCustodyRecords, "function");
  const f = await custodyFixture();
  const records = await operation.buildArchiveCustodyRecords({
    ...f.reader,
    predecessor: f.predecessor,
    policy: f.policy
  });
  const packet = signedCustody(records);
  const entry = packet.objects[0],
    observation = entry.observation;
  assert.equal(observation.lastModified, "2026-10-01T00:00:00.000Z");
  assert.equal(observation.worm.retainUntil, "2027-04-29T00:00:00.000Z");
  assert.equal(observation.terminalAt, f.predecessor.proof.receipt.session.terminalAt);
  const {
    contentDigest,
    storeRef,
    objectKey,
    objectVersion,
    terminalAt,
    snapshotExpiresAt,
    downstreamRetainUntil,
    legalHoldUntil
  } = observation;
  assert.doesNotThrow(() =>
    verifyAuthoritativeCustodyObservation({
      originalBytes: bytes,
      receipt: entry.receipt,
      observation,
      signature: entry.signature,
      expected: {
        contentDigest,
        storeRef,
        objectKey,
        objectVersion,
        terminalAt,
        snapshotExpiresAt,
        downstreamRetainUntil,
        legalHoldUntil
      },
      trustPolicy: {
        signer: archiveSigner,
        writerIdentity: writerRole,
        readerIdentity: readerRole,
        storeRef,
        owner: f.policy.owner,
        readers: f.policy.readers
      },
      now: f.reader.issuedAt
    })
  );
  const subject = await operation.buildArchiveAccessSubject({ ...f.reader, custody: packet });
  assert.equal(subject.receipt.observationDigest, sha256Canonical(packet));
  const proof = {
    ...subject,
    signature: detached("h1-evidence-archive-access.v1", "subject", subject)
  };
  const { issuedAt, ...verifyInput } = f.reader;
  assert.equal(issuedAt, proof.receipt.issuedAt);
  await operation.verifyArchiveAccessProof({ ...verifyInput, custody: packet, proof });
  const wrongPredecessor = globalThis.structuredClone(packet);
  wrongPredecessor.writerAccessProofDigest = d("f");
  await assert.rejects(
    operation.verifyArchiveAccessProof({ ...verifyInput, custody: wrongPredecessor, proof })
  );
  const changed = globalThis.structuredClone(packet);
  changed.objects[0].observation.lastModified = "2026-10-01T00:00:01.000Z";
  await assert.rejects(operation.buildArchiveAccessSubject({ ...f.reader, custody: changed }));
});

test("archive custody rejects missing originals, wrong writer ETag and insufficient WORM coverage", async () => {
  assert.equal(typeof operation.buildArchiveCustodyRecords, "function");
  const missing = await custodyFixture();
  missing.reader.io.objects[0].result.evidence.originals = [];
  missing.reader.terminal.ioDigest = sha256Canonical(missing.reader.io);
  const wrongEtag = await custodyFixture();
  wrongEtag.predecessor.io.objects[0].result.putObservation.record.response.headers.etag =
    '"other"';
  wrongEtag.predecessor.terminal.ioDigest = sha256Canonical(wrongEtag.predecessor.io);
  const { proof: oldProof, ...prior } = wrongEtag.predecessor;
  const subject = await operation.buildArchiveAccessSubject({
    ...prior,
    signer: archiveSigner,
    custody: null,
    issuedAt: oldProof.receipt.issuedAt
  });
  wrongEtag.predecessor.proof = {
    ...subject,
    signature: detached("h1-evidence-archive-access.v1", "subject", subject)
  };
  wrongEtag.reader.authorization.chain.predecessorTerminalReceiptDigest = sha256Canonical(
    subject.receipt
  );
  wrongEtag.reader.io.authorizationDigest = wrongEtag.reader.terminal.authorizationDigest =
    sha256Canonical(wrongEtag.reader.authorization);
  wrongEtag.reader.terminal.ioDigest = sha256Canonical(wrongEtag.reader.io);
  const insufficient = await custodyFixture({
    ...authorized("reader").policy,
    downstreamRetainUntil: "2027-05-01T00:00:00.000Z"
  });
  for (const f of [missing, wrongEtag, insufficient]) {
    await assert.rejects(
      operation.buildArchiveCustodyRecords({
        ...f.reader,
        predecessor: f.predecessor,
        policy: f.policy
      })
    );
  }
});

test("archive authorization verifies protected signer, frozen originals, live revocation and time", () => {
  const input = authorized("writer");
  assert.deepEqual(
    operation.verifyArchiveOperationAuthorization(input),
    input.packet.authorization
  );
  for (const mutate of [
    (x) => {
      x.chainOriginals.applyProofDigest.fixture = "changed";
    },
    (x) => {
      x.expected.runtimeDigest = d("f");
    },
    (x) => {
      x.packet.signature.signature = Buffer.alloc(64).toString("base64");
    },
    (x) => {
      x.now = x.packet.authorization.notAfter;
    },
    (x) => {
      x.revocation.state.revokedAuthorizationDigests.push(x.expected.authorizationDigest);
      x.revocation.signature = detached("i0-revocation-state.v1", "state", x.revocation.state);
    }
  ]) {
    const changed = globalThis.structuredClone(input);
    mutate(changed);
    assert.throws(() => operation.verifyArchiveOperationAuthorization(changed));
  }
  assert.doesNotThrow(() =>
    operation.verifyArchiveOperationAuthorization({
      ...input,
      active: false,
      now: "2026-10-02T00:00:00.000Z"
    })
  );
});

test("archive access proof binds actual IO to exited child and disposed expired session", async () => {
  for (const kind of ["writer", "reader"]) {
    const input =
      kind === "reader"
        ? await readerAccessInput()
        : { ...(await archiveObserved(kind)), custody: null };
    const subject = await operation.buildArchiveAccessSubject(input);
    const proof = {
      ...subject,
      signature: detached("h1-evidence-archive-access.v1", "subject", subject)
    };
    assert.deepEqual(
      await operation.verifyArchiveAccessProof({
        proof,
        authorization: input.authorization,
        io: input.io,
        terminal: input.terminal,
        signer: input.signer,
        custody: input.custody
      }),
      subject
    );
    assert.equal(subject.receipt.actions.length, kind === "writer" ? 1 : 2);
    for (const mutate of [
      (x) => {
        x.terminal.authority.exited = false;
      },
      (x) => {
        x.terminal.sessionDisposal.absent = false;
      },
      (x) => {
        x.terminal.sessionDisposal.observedAt = "2026-10-01T00:05:00.000Z";
      },
      (x) => {
        x.io.objects[0].result.exactKey = "wrong";
        if (kind === "reader") x.io.objects[0].result.get.digest = d("f");
        x.terminal.ioDigest = sha256Canonical(x.io);
      }
    ]) {
      const changed = globalThis.structuredClone(input);
      mutate(changed);
      await assert.rejects(operation.buildArchiveAccessSubject(changed));
    }
    const changed = globalThis.structuredClone(proof);
    changed.receipt.issuer = "other";
    await assert.rejects(() =>
      operation.verifyArchiveAccessProof({
        proof: changed,
        authorization: input.authorization,
        io: input.io,
        terminal: input.terminal,
        signer: input.signer,
        custody: input.custody
      })
    );
  }
});

test("archive read waits for the signed writer terminal for the identical objects", async () => {
  const writer = await archiveObserved("writer");
  const reader = authorized("reader").packet.authorization;
  const writerSubject = await operation.buildArchiveAccessSubject({ ...writer, custody: null });
  reader.chain.predecessorTerminalReceiptDigest = sha256Canonical(writerSubject.receipt);
  const input = {
    authorization: reader,
    predecessor: writerSubject.receipt,
    predecessorAuthorization: writer.authorization,
    sessionIssuedAt: "2026-10-01T00:10:02.000Z"
  };
  assert.equal(typeof operation.verifyArchiveReadPredecessor, "function");
  assert.doesNotThrow(() => operation.verifyArchiveReadPredecessor(input));
  for (const mutate of [
    (x) => {
      x.sessionIssuedAt = "2026-10-01T00:00:01.000Z";
    },
    (x) => {
      x.authorization.chain.predecessorTerminalReceiptDigest = d("f");
    },
    (x) => {
      x.authorization.objects[0].contentDigest = d("f");
    }
  ]) {
    const changed = globalThis.structuredClone(input);
    mutate(changed);
    assert.throws(() => operation.verifyArchiveReadPredecessor(changed));
  }
});

test("archive reader sealing rejects missing or inconsistent raw OSS response evidence", async () => {
  const input = await readerAccessInput();
  for (const mutate of [
    (x) => {
      delete x.io.objects[0].result.evidence;
    },
    (x) => {
      x.io.objects[0].result.evidence.originals[0].bytesBase64 =
        Buffer.from("other").toString("base64");
    },
    (x) => {
      x.io.objects[0].result.evidence.records[3].response.headers.etag = '"different"';
    },
    (x) => {
      x.io.objects[0].result.bucket.worm.id = "different";
    }
  ]) {
    const changed = globalThis.structuredClone(input);
    mutate(changed);
    changed.terminal.ioDigest = sha256Canonical(changed.io);
    await assert.rejects(async () => operation.buildArchiveAccessSubject(changed));
  }
});

function authorization(profile) {
  const writer = profile === "archive-create-only-writer";
  return {
    schemaVersion: "evidence-archive-authorization.v1",
    authorizationId: `auth-${profile}`,
    operationId: "op-1",
    profile,
    executor: {
      sourceDigest: d("1"),
      runtimeDigest: d("2"),
      principal: writer ? writerRole : readerRole,
      publicKeyDigest: d("3")
    },
    resource: {
      region: "oss-cn-shanghai",
      bucket,
      bucketFingerprint: d("4"),
      policyDigest: d("5")
    },
    objects: [{ ...object }],
    permissions: {
      actions: writer
        ? ["oss:PutObject"]
        : [
            "oss:HeadObject",
            "oss:GetObject",
            "oss:GetObjectAcl",
            "oss:GetBucketAcl",
            "oss:GetBucketWorm",
            "oss:GetBucketVersioning"
          ],
      conditionalCreate: writer,
      exactKeysOnly: true
    },
    chain: {
      changePlanDigest: d("6"),
      externalChangeApprovalDigest: d("7"),
      applyProofDigest: d("8"),
      resourceReadbackDigest: d("9"),
      predecessorTerminalReceiptDigest: writer ? null : d("a")
    },
    identities: { management: "management-principal", writer: writerRole, reader: readerRole },
    issuer: { id: "archive-control", keyId: "key-1" },
    issuedAt: "2026-10-01T00:00:00.000Z",
    notAfter: "2026-10-01T00:15:00.000Z",
    revocationPolicyDigest: d("b"),
    custodyPolicyDigest: d("c")
  };
}

function session(role) {
  return {
    arn: role.replace(":role/", ":assumed-role/") + "/session-1",
    accessKeyId: "STS.public-id",
    accessKeySecret: "never-export-this-secret",
    stsToken: "never-export-this-token",
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:10:00.000Z"
  };
}

function harness(role) {
  const calls = [],
    state = {
      clock: "2026-10-01T00:00:01.000Z",
      afterIdentity: null,
      afterRequest: null,
      afterPut: null,
      putError: null,
      encryption: "AES256",
      acl,
      versioning,
      content: bytes
    };
  const response = (body, headers = {}) => ({
    status: 200,
    content: Buffer.from(body),
    res: {
      status: 200,
      data: Buffer.from(body),
      headers: {
        date,
        "x-oss-request-id": `request-${calls.length}`,
        ...headers,
        authorization: "do-not-copy"
      }
    }
  });
  const objectHeaders = () => ({
    "content-length": String(state.content.length),
    etag: '"etag-one"',
    "last-modified": date,
    "x-oss-server-side-encryption": state.encryption
  });
  const client = {
    async put(key, body, options) {
      calls.push(["put", key, Buffer.from(body), options]);
      state.afterPut?.();
      if (state.putError) throw state.putError;
      return response(Buffer.alloc(0), { etag: '"etag-one"', "content-length": "0" });
    },
    async request(input) {
      calls.push(["request", input]);
      state.afterRequest?.();
      return response(
        input.subres === "acl" ? state.acl : input.subres === "worm" ? worm : state.versioning
      );
    },
    async head(key) {
      calls.push(["head", key]);
      return response(Buffer.alloc(0), objectHeaders());
    },
    async get(key) {
      calls.push(["get", key]);
      return response(state.content, objectHeaders());
    }
  };
  const deps = {
    now: () => new Date(state.clock),
    createOssClient(config) {
      calls.push(["client", config]);
      return client;
    },
    createStsClient() {
      return {
        async callApi() {
          calls.push(["identity"]);
          state.afterIdentity?.();
          return {
            statusCode: 200,
            body: {
              AccountId: account,
              Arn: session(role).arn,
              IdentityType: "AssumedRoleUser",
              RequestId: "sts-request-1"
            }
          };
        }
      };
    }
  };
  return { calls, state, deps };
}

test("rejects wrong archive scope before STS or OSS access", async () => {
  const f = harness(writerRole),
    auth = authorization("archive-create-only-writer");
  auth.resource.bucket = "other-bucket";
  await assert.rejects(
    createEvidenceArchiveWriterTransport(
      {
        authorization: auth,
        originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
        session: session(writerRole)
      },
      f.deps
    )
  );
  assert.deepEqual(f.calls, []);
});

test("writer verifies independent STS identity and conditionally creates only exact original bytes", async () => {
  const f = harness(writerRole);
  const transport = await createEvidenceArchiveWriterTransport(
    {
      authorization: authorization("archive-create-only-writer"),
      originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
      session: session(writerRole)
    },
    f.deps
  );
  const result = await transport.createOnly({ exactKey: object.exactKey, originalBytes: bytes });
  assert.equal(transport.identityOriginal.Arn, session(writerRole).arn);
  assert.deepEqual(
    f.calls.map((x) => x[0]),
    ["identity", "client", "put"]
  );
  assert.equal(f.calls[2][3].headers["x-oss-forbid-overwrite"], "true");
  assert.equal(f.calls[2][3].headers["x-oss-object-acl"], "private");
  assert.equal(f.calls[2][3].headers["x-oss-server-side-encryption"], "AES256");
  assert.equal(result.putObservation.record.response.headers["x-oss-request-id"], "request-3");
  assert.equal(JSON.stringify(result).includes("never-export"), false);
  assert.equal(JSON.stringify(result).includes("do-not-copy"), false);
  await assert.rejects(transport.createOnly({ exactKey: object.exactKey, originalBytes: bytes }));
  assert.equal(f.calls.filter((x) => x[0] === "put").length, 1);
});

test("writer refuses known overwrite and never retries an unknown PUT", async () => {
  const f = harness(writerRole);
  const transport = await createEvidenceArchiveWriterTransport(
    {
      authorization: authorization("archive-create-only-writer"),
      originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
      session: session(writerRole)
    },
    f.deps
  );
  f.state.putError = { status: 409, code: "FileAlreadyExists" };
  await assert.rejects(transport.createOnly({ exactKey: object.exactKey, originalBytes: bytes }), {
    code: "EVIDENCE_ARCHIVE_OVERWRITE_REFUSED"
  });
  assert.equal(f.calls.filter((x) => x[0] === "put").length, 1);
  const g = harness(writerRole);
  const another = await createEvidenceArchiveWriterTransport(
    {
      authorization: authorization("archive-create-only-writer"),
      originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
      session: session(writerRole)
    },
    g.deps
  );
  g.state.putError = new Error("network lost after send; secret never-export-this-secret");
  await assert.rejects(another.createOnly({ exactKey: object.exactKey, originalBytes: bytes }), {
    code: "EVIDENCE_ARCHIVE_WRITE_OUTCOME_UNKNOWN"
  });
  await assert.rejects(another.createOnly({ exactKey: object.exactKey, originalBytes: bytes }), {
    code: "EVIDENCE_ARCHIVE_PUT_ALREADY_ATTEMPTED"
  });
  assert.equal(g.calls.filter((x) => x[0] === "put").length, 1);
});

test("reader verifies independent STS identity and retains actual safe OSS originals", async () => {
  const f = harness(readerRole);
  const transport = await createEvidenceArchiveReaderTransport(
    { authorization: authorization("archive-readback-reader"), session: session(readerRole) },
    f.deps
  );
  const result = await transport.readback({ exactKey: object.exactKey });
  assert.equal(result.identityOriginal.Arn, session(readerRole).arn);
  assert.deepEqual(
    result.evidence.records.map((r) => r.operation),
    [
      "GetBucketAcl",
      "GetBucketWorm",
      "GetBucketVersioning",
      "HeadObject",
      "GetObjectAcl",
      "GetObject"
    ]
  );
  assert.equal(result.bucket.acl, "private");
  assert.equal(result.bucket.versioning, "Disabled");
  assert.equal(result.bucket.worm.retentionDays, 210);
  assert.equal(result.head.digest, object.contentDigest);
  assert.equal(result.get.digest, object.contentDigest);
  assert.equal(result.evidence.records[4].response.body.bytes > 0, true);
  assert.equal(JSON.stringify(result).includes("never-export"), false);
  assert.equal(JSON.stringify(result).includes("do-not-copy"), false);
});

test("reader refuses weak metadata without accepting bucket ACL as object ACL", async () => {
  for (const change of [
    (s) => {
      s.encryption = "";
    },
    (s) => {
      s.acl = acl.replace("private", "public-read");
    },
    (s) => {
      s.versioning = "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>";
    }
  ]) {
    const f = harness(readerRole);
    change(f.state);
    const transport = await createEvidenceArchiveReaderTransport(
      { authorization: authorization("archive-readback-reader"), session: session(readerRole) },
      f.deps
    );
    await assert.rejects(transport.readback({ exactKey: object.exactKey }), {
      code: "EVIDENCE_ARCHIVE_READBACK_INVALID"
    });
  }
});

test("accepts UTC STS seconds and rechecks authorization after identity readback", async () => {
  const f = harness(writerRole);
  const short = {
    ...session(writerRole),
    issuedAt: "2026-10-01T00:00:00Z",
    expiresAt: "2026-10-01T00:00:02Z"
  };
  const input = {
    authorization: authorization("archive-create-only-writer"),
    originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
    session: short
  };
  await createEvidenceArchiveWriterTransport(input, f.deps);

  const invalid = harness(writerRole);
  await assert.rejects(
    createEvidenceArchiveWriterTransport(
      { ...input, session: { ...short, expiresAt: "2026-10-32T00:00:02Z" } },
      invalid.deps
    ),
    { code: "EVIDENCE_ARCHIVE_SESSION_INVALID" }
  );
  assert.deepEqual(invalid.calls, []);

  const expired = harness(writerRole);
  const deadline = authorization("archive-create-only-writer");
  deadline.notAfter = "2026-10-01T00:00:02.000Z";
  expired.state.afterIdentity = () => {
    expired.state.clock = "2026-10-01T00:00:02.000Z";
  };
  await assert.rejects(
    createEvidenceArchiveWriterTransport(
      { ...input, authorization: deadline, session: session(writerRole) },
      expired.deps
    ),
    { code: "EVIDENCE_ARCHIVE_SESSION_INVALID" }
  );
  assert.deepEqual(
    expired.calls.map((entry) => entry[0]),
    ["identity"]
  );
});

test("reader stops before the next OSS call when authorization expires during metadata readback", async () => {
  const f = harness(readerRole);
  const auth = authorization("archive-readback-reader");
  auth.notAfter = "2026-10-01T00:00:02.000Z";
  const transport = await createEvidenceArchiveReaderTransport(
    { authorization: auth, session: session(readerRole) },
    f.deps
  );
  f.state.afterRequest = () => {
    f.state.clock = "2026-10-01T00:00:02.000Z";
  };
  await assert.rejects(transport.readback({ exactKey: object.exactKey }), {
    code: "EVIDENCE_ARCHIVE_READBACK_INVALID"
  });
  assert.equal(f.calls.filter((entry) => entry[0] === "request").length, 1);
});

test("writer treats an expired response as unknown and does not retry", async () => {
  const f = harness(writerRole);
  const auth = authorization("archive-create-only-writer");
  auth.notAfter = "2026-10-01T00:00:02.000Z";
  const transport = await createEvidenceArchiveWriterTransport(
    {
      authorization: auth,
      originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
      session: session(writerRole)
    },
    f.deps
  );
  f.state.afterPut = () => {
    f.state.clock = "2026-10-01T00:00:02.000Z";
  };
  await assert.rejects(transport.createOnly({ exactKey: object.exactKey, originalBytes: bytes }), {
    code: "EVIDENCE_ARCHIVE_WRITE_OUTCOME_UNKNOWN"
  });
  await assert.rejects(transport.createOnly({ exactKey: object.exactKey, originalBytes: bytes }), {
    code: "EVIDENCE_ARCHIVE_PUT_ALREADY_ATTEMPTED"
  });
  assert.equal(f.calls.filter((entry) => entry[0] === "put").length, 1);

  const g = harness(writerRole);
  const another = await createEvidenceArchiveWriterTransport(
    {
      authorization: auth,
      originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
      session: session(writerRole)
    },
    g.deps
  );
  g.state.afterPut = () => {
    g.state.clock = "2026-10-01T00:00:02.000Z";
  };
  g.state.putError = { status: 409, code: "FileAlreadyExists" };
  await assert.rejects(another.createOnly({ exactKey: object.exactKey, originalBytes: bytes }), {
    code: "EVIDENCE_ARCHIVE_WRITE_OUTCOME_UNKNOWN"
  });
  assert.equal(g.calls.filter((entry) => entry[0] === "put").length, 1);
});
