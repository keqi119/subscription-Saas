// Public verification of the fixed H1 result. No signing or cloud credentials.
import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { TextDecoder } from "node:util";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { buildH1CryptoUseProof } from "./snapshot-h1-data-proof.mjs";

const CODE = "H1_SNAPSHOT_PUBLICATION_REJECTED";
const NAMES = [
  "snapshot.enc",
  "encryption-envelope.json",
  "snapshot-proof.json",
  "data-result.json"
];
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const requireThat = (value) => {
  if (!value) fail();
};
const same = (a, b) => canonicalJson(a) === canonicalJson(b);

export function readPublicSnapshotJson(bytes) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1048576);
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    requireThat(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Buffer.from(canonicalJson(value)).equals(bytes)
    );
    return value;
  } catch {
    fail();
  }
}

function signature(domain, subject, value, signer) {
  assertKernelFrame(signer, ["issuer", "keyId", "publicKey"], CODE);
  assertKernelFrame(value, ["algorithm", "issuer", "keyId", "subjectDigest", "signature"], CODE);
  const key = createPublicKey(signer.publicKey);
  requireThat(
    key.asymmetricKeyType === "ed25519" &&
      sha256Bytes(key.export({ type: "spki", format: "der" })) === signer.keyId &&
      value.algorithm === "Ed25519" &&
      value.issuer === signer.issuer &&
      value.keyId === signer.keyId &&
      value.subjectDigest === sha256Canonical(subject) &&
      typeof value.signature === "string" &&
      /^[A-Za-z0-9+/]{86}==$/.test(value.signature) &&
      verify(
        null,
        Buffer.from(canonicalJson({ domain, subject })),
        key,
        Buffer.from(value.signature, "base64")
      )
  );
}

function expectedIdentity(value) {
  assertKernelFrame(
    value,
    ["releaseAttemptId", "snapshotRunId", "sourceSha", "dispatchAuthorizationDigest"],
    CODE
  );
  requireThat(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.releaseAttemptId
    ) &&
      /^[1-9][0-9]*$/.test(value.snapshotRunId) &&
      /^[0-9a-f]{40}$/.test(value.sourceSha) &&
      /^sha256:[0-9a-f]{64}$/.test(value.dispatchAuthorizationDigest)
  );
  return value;
}

export function verifyH1SnapshotData({ dataResultBytes, proofBytes, expected, signer }) {
  try {
    expectedIdentity(expected);
    const result = readPublicSnapshotJson(dataResultBytes),
      sealed = readPublicSnapshotJson(proofBytes);
    assertKernelFrame(sealed, ["proof", "dataResultDigest", "signature"], CODE);
    const subject = { proof: sealed.proof, dataResultDigest: sealed.dataResultDigest };
    signature("h1-snapshot-data-proof.v1", subject, sealed.signature, signer);
    requireThat(
      result.status === "DATA_PREPARED" && sealed.dataResultDigest === sha256Bytes(dataResultBytes)
    );
    const auth = result.cryptoAuthorization;
    requireThat(
      auth &&
        auth.issuer.issuerId === signer.issuer &&
        auth.releaseAttemptId === expected.releaseAttemptId &&
        auth.snapshotRunId === expected.snapshotRunId &&
        auth.sourceSha === expected.sourceSha &&
        auth.bindings.dispatchAuthorizationDigest === expected.dispatchAuthorizationDigest &&
        result.admission.releaseAttemptId === auth.releaseAttemptId &&
        result.admission.producerRun.runId === auth.snapshotRunId &&
        result.admission.producerRun.sourceSha === auth.sourceSha &&
        result.admission.dispatchAuthorizationDigest ===
          auth.bindings.dispatchAuthorizationDigest &&
        result.admission.adapterDigest === auth.bindings.adapterExecutableDigest &&
        result.terminalObservation.runningJobObservationDigest ===
          sha256Canonical(result.runningJobObservation)
    );
    const rebuilt = buildH1CryptoUseProof({
      authorization: auth,
      data: result.data,
      observation: result.executionObservation,
      terminal: result.terminalObservation,
      cleanup: result.cleanup,
      volume: result.volumeObservation,
      disposal: result.disposalObservation
    });
    requireThat(same(rebuilt, sealed.proof));
    return snapshotKernelData({ result, sealed }, CODE);
  } catch {
    fail();
  }
}

export function prepareH1SnapshotObjects({
  dataResultBytes,
  proofBytes,
  ciphertext,
  expected,
  signer
}) {
  const verified = verifyH1SnapshotData({ dataResultBytes, proofBytes, expected, signer });
  const envelope = verified.result.data.envelope;
  requireThat(
    Buffer.isBuffer(ciphertext) &&
      ciphertext.length === envelope.ciphertextSizeBytes &&
      sha256Bytes(ciphertext) === envelope.ciphertextDigest
  );
  const prefix = `snapshot-slots/v2/${expected.releaseAttemptId}/${expected.snapshotRunId}/`;
  const bytes = [ciphertext, Buffer.from(canonicalJson(envelope)), proofBytes, dataResultBytes];
  return {
    ...verified,
    objects: NAMES.map((name, index) => ({
      key: prefix + name,
      bytes: Buffer.from(bytes[index]),
      contentDigest: sha256Bytes(bytes[index])
    }))
  };
}

function verifyIdentityOriginal(value, arn) {
  assertKernelFrame(value, ["AccountId", "Arn", "IdentityType", "RequestId"], CODE);
  requireThat(
    value.AccountId === "1457643390906675" &&
      value.Arn === arn.replace(":role/", ":assumed-role/") &&
      value.IdentityType === "AssumedRoleUser" &&
      typeof value.RequestId === "string" &&
      /^[A-Za-z0-9-]{1,256}$/.test(value.RequestId)
  );
}

function verifyPutObservation(item, publication) {
  const capture = item.putObservation;
  assertKernelFrame(capture, ["record", "bodyBase64"], CODE);
  const record = capture.record;
  assertKernelFrame(
    record,
    [
      "recordVersion",
      "operation",
      "bucket",
      "objectKey",
      "principal",
      "observedAt",
      "requestHeaders",
      "response"
    ],
    CODE
  );
  assertKernelFrame(record.requestHeaders, ["x-oss-forbid-overwrite"], CODE);
  assertKernelFrame(record.response, ["status", "headers", "body"], CODE);
  assertKernelFrame(record.response.body, ["digest", "bytes"], CODE);
  const headers = record.response.headers,
    observed = Date.parse(record.observedAt);
  requireThat(
    record.recordVersion === "r3-snapshot-oss-response.v1" &&
      record.operation === "PutObject" &&
      record.bucket === "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai" &&
      record.objectKey === item.key &&
      record.principal === publication.writerArn.replace(":role/", ":assumed-role/") &&
      Number.isFinite(observed) &&
      new Date(observed).toISOString() === record.observedAt &&
      observed >= Date.parse(publication.writerIssuedAt) &&
      observed <= Date.parse(publication.publishedAt) &&
      record.requestHeaders["x-oss-forbid-overwrite"] === "true" &&
      record.response.status === 200 &&
      capture.bodyBase64 === "" &&
      record.response.body.bytes === 0 &&
      record.response.body.digest === sha256Bytes(Buffer.alloc(0)) &&
      headers &&
      typeof headers === "object" &&
      !Array.isArray(headers) &&
      Object.entries(headers).every(
        ([name, value]) =>
          ["date", "x-oss-request-id", "etag", "content-length"].includes(name) &&
          typeof value === "string" &&
          value.length > 0 &&
          value.length <= 2048 &&
          ![...value].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
          )
      ) &&
      Number.isFinite(Date.parse(headers.date)) &&
      Date.parse(headers.date) <= observed &&
      headers["x-oss-request-id"] === item.requestId &&
      headers.etag === item.etag &&
      (headers["content-length"] === undefined || headers["content-length"] === "0")
  );
}

export function verifyH1SnapshotPublication({ bytes, expected, signer }) {
  try {
    expectedIdentity(expected);
    const sealed = readPublicSnapshotJson(bytes);
    assertKernelFrame(sealed, ["publication", "signature"], CODE);
    const value = sealed.publication;
    assertKernelFrame(
      value,
      [
        "releaseAttemptId",
        "snapshotRunId",
        "sourceSha",
        "dispatchAuthorizationDigest",
        "writerArn",
        "writerIdentityOriginal",
        "writerIssuedAt",
        "writerExpiresAt",
        "cryptoExitedAt",
        "publishedAt",
        "objects"
      ],
      CODE
    );
    signature("h1-snapshot-publication.v1", value, sealed.signature, signer);
    verifyIdentityOriginal(value.writerIdentityOriginal, value.writerArn);
    requireThat(
      Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue) &&
        /^acs:ram::1457643390906675:(?:assumed-role|role)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(
          value.writerArn
        ) &&
        Array.isArray(value.objects) &&
        value.objects.length === NAMES.length
    );
    const times = [
      value.cryptoExitedAt,
      value.writerIssuedAt,
      value.publishedAt,
      value.writerExpiresAt
    ].map((time) => {
      const n = Date.parse(time);
      requireThat(Number.isFinite(n) && new Date(n).toISOString() === time);
      return n;
    });
    requireThat(
      times[0] <= times[1] &&
        times[1] <= times[2] &&
        times[2] < times[3] &&
        times[3] - times[1] <= 900000
    );
    const prefix = `snapshot-slots/v2/${expected.releaseAttemptId}/${expected.snapshotRunId}/`;
    for (const [index, item] of value.objects.entries()) {
      assertKernelFrame(
        item,
        ["key", "digest", "sizeBytes", "requestId", "etag", "putObservation"],
        CODE
      );
      requireThat(
        item.key === prefix + NAMES[index] &&
          /^sha256:[a-f0-9]{64}$/.test(item.digest) &&
          Number.isSafeInteger(item.sizeBytes) &&
          item.sizeBytes > 0 &&
          item.sizeBytes <= (index === 0 ? 134217728 : 1048576) &&
          typeof item.requestId === "string" &&
          item.requestId.length > 0 &&
          typeof item.etag === "string" &&
          item.etag.length > 0
      );
      verifyPutObservation(item, value);
    }
    return snapshotKernelData(value, CODE);
  } catch {
    fail();
  }
}

// The last, signed diagnostics object is the publication marker. The reader
// must independently retrieve all objects; publisher PUT responses alone do
// not establish custody or completion of the GitHub producer run.
export async function readH1SnapshotPublication({ reader, expected, signer }) {
  expectedIdentity(expected);
  const prefix = `snapshot-slots/v2/${expected.releaseAttemptId}/${expected.snapshotRunId}/`;
  const marker = await reader.readPublicJson({ key: prefix + "diagnostics.redacted.json" });
  verifyIdentityOriginal(reader.identityOriginal, marker.observation.readerArn);
  const publication = verifyH1SnapshotPublication({ bytes: marker.bytes, expected, signer });
  requireThat(
    publication.writerArn.replace(":role/", ":assumed-role/") ===
      marker.observation.expectedWriterArn
  );
  const observations = [marker.observation],
    documents = new Map();
  for (const object of publication.objects) {
    const request = { key: object.key, contentDigest: object.digest, sizeBytes: object.sizeBytes };
    if (object.key.endsWith("/snapshot.enc")) {
      observations.push(await reader.readback(request));
    } else {
      const value = await reader.readPublicJson({ key: object.key });
      requireThat(
        value.observation.get.digest === object.digest &&
          value.observation.get.sizeBytes === object.sizeBytes
      );
      documents.set(object.key.slice(prefix.length), value.bytes);
      observations.push(value.observation);
    }
    requireThat(observations.at(-1).get.etag === object.etag);
  }
  const verified = verifyH1SnapshotData({
    dataResultBytes: documents.get("data-result.json"),
    proofBytes: documents.get("snapshot-proof.json"),
    expected,
    signer
  });
  const envelope = readPublicSnapshotJson(documents.get("encryption-envelope.json"));
  requireThat(
    same(envelope, verified.result.data.envelope) &&
      publication.cryptoExitedAt === verified.sealed.proof.cleanup.processExitedAt &&
      publication.objects[0].digest === envelope.ciphertextDigest &&
      publication.objects[0].sizeBytes === envelope.ciphertextSizeBytes &&
      observations.every(
        (x) =>
          same(x.bucket, marker.observation.bucket) && x.readerArn === marker.observation.readerArn
      )
  );
  return snapshotKernelData(
    {
      status: "READBACK_VERIFIED",
      publication,
      data: verified.result,
      proof: verified.sealed,
      readerIdentityOriginal: reader.identityOriginal,
      observations,
      observedAt: new Date().toISOString()
    },
    CODE
  );
}

// Captures R3 storage originals. The caller must perform this again AFTER the
// independently observed workflow terminal. This function grants no terminal
// status and cannot turn a provisional custody receipt into a final receipt.
export async function readH1SnapshotStorageOriginals({
  reader,
  publicationBytes,
  expected,
  signer
}) {
  const publication = verifyH1SnapshotPublication({ bytes: publicationBytes, expected, signer });
  const object = publication.objects[0];
  const observation = await reader.readbackOriginals({
    key: object.key,
    contentDigest: object.digest,
    sizeBytes: object.sizeBytes
  });
  verifyIdentityOriginal(observation.readerIdentityOriginal, observation.readerArn);
  requireThat(
    publication.writerIdentityOriginal.Arn === observation.expectedWriterArn &&
      observation.readerArn !== observation.expectedWriterArn &&
      observation.head.etag === object.etag &&
      observation.get.etag === object.etag &&
      [observation.head, observation.get].every(
        (value) =>
          value.key === object.key &&
          value.digest === object.digest &&
          value.sizeBytes === object.sizeBytes
      )
  );
  const originals = new Map();
  const retain = (bytes) => {
    requireThat(Buffer.isBuffer(bytes) && bytes.length <= 1048576);
    const digest = sha256Bytes(bytes);
    originals.set(digest, { digest, bytesBase64: bytes.toString("base64") });
    return { digest, bytes: bytes.length };
  };
  for (const original of observation.evidence.originals) {
    assertKernelFrame(original, ["digest", "bytesBase64"], CODE);
    const bytes = Buffer.from(original.bytesBase64, "base64");
    requireThat(
      bytes.toString("base64") === original.bytesBase64 && sha256Bytes(bytes) === original.digest
    );
    retain(bytes);
  }
  const json = (value) => retain(Buffer.from(canonicalJson(value)));
  const storageReadback = {
    recordVersion: "r3-snapshot-storage-readback.v1",
    bucket: object.putObservation.record.bucket,
    objectKey: object.key,
    writerIdentity: publication.writerIdentityOriginal.Arn,
    readerIdentity: observation.readerArn,
    writerIdentityOriginal: json(publication.writerIdentityOriginal),
    readerIdentityOriginal: json(observation.readerIdentityOriginal),
    conditionalCreate: json(object.putObservation.record)
  };
  retain(Buffer.from(object.putObservation.bodyBase64, "base64"));
  const operations = {
    head: "HeadObject",
    get: "GetObject",
    bucketAcl: "GetBucketAcl",
    objectAcl: "GetObjectAcl",
    versioning: "GetBucketVersioning",
    worm: "GetBucketWorm"
  };
  assertKernelFrame(observation.evidence.records, Object.keys(operations), CODE);
  for (const [name, operation] of Object.entries(operations)) {
    const record = observation.evidence.records[name];
    requireThat(
      record.operation === operation &&
        record.bucket === storageReadback.bucket &&
        record.principal === storageReadback.readerIdentity &&
        record.objectKey === (["head", "get", "objectAcl"].includes(name) ? object.key : null)
    );
    // The ciphertext reference is intentionally excluded from declaration originals.
    if (name !== "get") {
      const body = originals.get(record.response.body.digest);
      requireThat(
        body && Buffer.from(body.bytesBase64, "base64").length === record.response.body.bytes
      );
    } else
      requireThat(
        record.response.body.digest === object.digest &&
          record.response.body.bytes === object.sizeBytes
      );
    storageReadback[name] = json(record);
  }
  return snapshotKernelData(
    { storageReadback, originals: [...originals.values()], observation },
    CODE
  );
}
