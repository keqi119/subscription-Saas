import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { buildEvidenceArchiveRamPolicy } from "./evidence-archive-ram-policy.mjs";

const bucket = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const account = "1457643390906675";
const writer = `acs:ram::${account}:role/subscription-saas-stage1-archive-writer`;
const reader = `acs:ram::${account}:role/subscription-saas-stage1-archive-reader`;
const digest = (value) => `sha256:${value.repeat(64)}`;

function fixture(profile = "archive-create-only-writer") {
  const bytes = Buffer.from('{"schemaVersion":"approval-record.v1","decision":"approve"}');
  const original = JSON.parse(bytes.toString("utf8"));
  const canonicalDigest = sha256Canonical(original);
  const exactKey = `control-evidence/v1/${original.schemaVersion}/${canonicalDigest}`;
  const expectedPrincipal = profile === "archive-create-only-writer" ? writer : reader;
  return {
    authorization: {
      schemaVersion: "evidence-archive-authorization.v1",
      authorizationId: "archive-auth-001",
      operationId: "archive-operation-001",
      profile,
      executor: {
        sourceDigest: digest("2"),
        runtimeDigest: digest("3"),
        principal: expectedPrincipal,
        publicKeyDigest: digest("4")
      },
      resource: {
        region: "oss-cn-shanghai",
        bucket,
        bucketFingerprint: digest("5"),
        policyDigest: digest("6")
      },
      objects: [
        {
          proofType: original.schemaVersion,
          canonicalDigest,
          exactKey,
          contentDigest: sha256Bytes(bytes),
          contentSizeBytes: bytes.length
        }
      ],
      permissions:
        profile === "archive-create-only-writer"
          ? { actions: ["oss:PutObject"], conditionalCreate: true, exactKeysOnly: true }
          : {
              actions: [
                "oss:HeadObject",
                "oss:GetObject",
                "oss:GetObjectAcl",
                "oss:GetBucketAcl",
                "oss:GetBucketWorm",
                "oss:GetBucketVersioning"
              ],
              conditionalCreate: false,
              exactKeysOnly: true
            },
      chain: {
        changePlanDigest: digest("7"),
        externalChangeApprovalDigest: digest("8"),
        applyProofDigest: digest("9"),
        resourceReadbackDigest: digest("a"),
        predecessorTerminalReceiptDigest:
          profile === "archive-create-only-writer" ? null : digest("b")
      },
      identities: {
        management: "archive-management-principal",
        writer,
        reader
      },
      issuer: { id: "archive-control-plane", keyId: "archive-root-key-001" },
      issuedAt: "2026-09-03T00:00:00.000Z",
      notAfter: "2026-09-03T00:15:00.000Z",
      revocationPolicyDigest: digest("c"),
      custodyPolicyDigest: digest("d")
    },
    originals: [{ exactKey, originalBytes: bytes }]
  };
}

test("compiles isolated writer and reader policies with Head mapped to GetObject", () => {
  const write = buildEvidenceArchiveRamPolicy(fixture());
  assert.deepEqual(write.Statement[0].Action, ["oss:PutObject"]);
  assert.deepEqual(write.Statement[0].Resource, [
    `acs:oss:*:${account}:${bucket}/control-evidence/v1/approval-record.v1/${fixture().authorization.objects[0].canonicalDigest}`
  ]);
  assert.equal(write.Statement[0].Condition.Bool["acs:SecureTransport"], "true");
  assert.equal(write.Statement[0].Condition.StringEquals["oss:x-oss-object-acl"], "private");

  const read = buildEvidenceArchiveRamPolicy(fixture("archive-readback-reader"));
  assert.deepEqual(read.Statement[0].Action, ["oss:GetObject"]);
  assert.deepEqual(read.Statement[1].Action, ["oss:GetObjectAcl"]);
  assert.deepEqual(read.Statement[1].Resource, write.Statement[0].Resource);
  assert.deepEqual(read.Statement[2].Action, [
    "oss:GetBucketAcl",
    "oss:GetBucketWorm",
    "oss:GetBucketVersioning"
  ]);
  assert.deepEqual(read.Statement[2].Resource, [`acs:oss:*:${account}:${bucket}`]);
  assert.ok(
    read.Statement.every((statement) => statement.Condition.Bool["acs:SecureTransport"] === "true")
  );
  assert.ok(read.Statement.every((statement) => !JSON.stringify(statement).includes("HeadObject")));
});

test("rejects altered originals, scope expansion, and accessor inputs", () => {
  const altered = fixture();
  altered.originals[0].originalBytes[0] ^= 1;
  assert.throws(() => buildEvidenceArchiveRamPolicy(altered));

  const expanded = fixture();
  expanded.originals.push({ ...expanded.originals[0] });
  assert.throws(() => buildEvidenceArchiveRamPolicy(expanded));

  let getterCalled = false;
  const withGetter = fixture();
  Object.defineProperty(withGetter, "originals", {
    enumerable: true,
    get() {
      getterCalled = true;
      return [];
    }
  });
  assert.throws(() => buildEvidenceArchiveRamPolicy(withGetter));
  assert.equal(getterCalled, false);

  const future = fixture();
  future.authorization.objects[0].canonicalDigest = digest("f");
  assert.throws(() => buildEvidenceArchiveRamPolicy(future));
});

test("accepts only the three signed H1 wrapper shapes under their embedded proof types", () => {
  const signature = (subject) => ({
    algorithm: "Ed25519",
    issuer: "h1-root",
    keyId: digest("1"),
    subjectDigest: sha256Canonical(subject),
    signature: Buffer.alloc(64, 1).toString("base64")
  });
  for (const [proofType, field, extra] of [
    ["producer-crypto-use-proof.v2", "proof", { dataResultDigest: digest("2") }],
    ["publisher-sts-use-proof.v1", "proof", {}],
    [
      "snapshot-destruction-receipt.v1",
      "receipt",
      {
        dataResultDigest: digest("2"),
        cryptoUseProofDigest: digest("3"),
        publicationDigest: digest("4"),
        publisherTerminalDigest: digest("5")
      }
    ]
  ]) {
    const subject = { [field]: { schemaVersion: proofType }, ...extra };
    const value = { ...subject, signature: signature(subject) };
    const raw = Buffer.from(canonicalJson(value));
    const input = fixture();
    input.authorization.objects[0] = {
      proofType,
      canonicalDigest: sha256Canonical(value),
      exactKey: `control-evidence/v1/${proofType}/${sha256Canonical(value)}`,
      contentDigest: sha256Bytes(raw),
      contentSizeBytes: raw.length
    };
    input.originals[0] = { exactKey: input.authorization.objects[0].exactKey, originalBytes: raw };
    assert.doesNotThrow(() => buildEvidenceArchiveRamPolicy(input));
    const extended = { ...value, schemaVersion: proofType };
    input.originals[0].originalBytes = Buffer.from(canonicalJson(extended));
    input.authorization.objects[0].contentDigest = sha256Bytes(input.originals[0].originalBytes);
    input.authorization.objects[0].contentSizeBytes = input.originals[0].originalBytes.length;
    input.authorization.objects[0].canonicalDigest = sha256Canonical(extended);
    input.authorization.objects[0].exactKey = `control-evidence/v1/${proofType}/${sha256Canonical(extended)}`;
    input.originals[0].exactKey = input.authorization.objects[0].exactKey;
    assert.throws(() => buildEvidenceArchiveRamPolicy(input), {
      code: "EVIDENCE_ARCHIVE_ORIGINAL_CANONICAL_MISMATCH"
    });
    value.signature.subjectDigest = digest("f");
    input.originals[0].originalBytes = Buffer.from(canonicalJson(value));
    input.authorization.objects[0].contentDigest = sha256Bytes(input.originals[0].originalBytes);
    input.authorization.objects[0].contentSizeBytes = input.originals[0].originalBytes.length;
    input.authorization.objects[0].canonicalDigest = sha256Canonical(value);
    input.authorization.objects[0].exactKey = `control-evidence/v1/${proofType}/${sha256Canonical(value)}`;
    input.originals[0].exactKey = input.authorization.objects[0].exactKey;
    assert.throws(() => buildEvidenceArchiveRamPolicy(input), {
      code: "EVIDENCE_ARCHIVE_ORIGINAL_CANONICAL_MISMATCH"
    });
  }
});

test("rejects policies whose canonical UTF-8 representation exceeds 2048 bytes", () => {
  const oversized = fixture();
  oversized.authorization.objects = Array.from({ length: 30 }, (_, index) => {
    const proofType = "approval-record.v1";
    const parsed = { schemaVersion: proofType, id: index };
    const canonicalDigest = sha256Canonical(parsed);
    const exactKey = `control-evidence/v1/${proofType}/${canonicalDigest}`;
    const original = Buffer.from(canonicalJson(parsed));
    return {
      proofType,
      canonicalDigest,
      exactKey,
      contentDigest: sha256Bytes(original),
      contentSizeBytes: original.length
    };
  });
  oversized.originals = oversized.authorization.objects.map((object, index) => ({
    exactKey: object.exactKey,
    originalBytes: Buffer.from(canonicalJson({ schemaVersion: object.proofType, id: index }))
  }));
  assert.throws(() => buildEvidenceArchiveRamPolicy(oversized), {
    code: "EVIDENCE_ARCHIVE_RAM_POLICY_TOO_LARGE"
  });
});
