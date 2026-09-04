import { createPublicKey, sign } from "node:crypto";

import { canonicalJson } from "../canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../digest.mjs";
import { verifyDispatchAuthorization } from "../dispatch-authorization.mjs";
import { validateContract } from "../schema-registry.mjs";
import { buildEnvironmentPolicyIdentity } from "./environment-policy.mjs";
import { buildSnapshotAdmission } from "./snapshot-admission.mjs";

const coded = (code) => Object.assign(new Error(code), { code });
const fail = (code) => {
  throw coded(code);
};
const same = (a, b) => canonicalJson(a) === canonicalJson(b);

function root(rootPolicy) {
  if (!rootPolicy || typeof rootPolicy !== "object" || Array.isArray(rootPolicy))
    fail("SNAPSHOT_ADMISSION_POLICY_INVALID");
  const signer = rootPolicy.rootSigner;
  if (
    !signer ||
    typeof signer !== "object" ||
    Array.isArray(signer) ||
    Object.keys(signer).length !== 3 ||
    typeof signer.issuer !== "string" ||
    typeof signer.keyId !== "string" ||
    typeof signer.publicKey !== "string"
  )
    fail("SNAPSHOT_ADMISSION_POLICY_INVALID");
  let publicKey;
  try {
    publicKey = createPublicKey(signer.publicKey);
  } catch {
    fail("SNAPSHOT_ADMISSION_POLICY_INVALID");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") fail("SNAPSHOT_ADMISSION_POLICY_INVALID");
  try {
    validateContract("environment-policy-identity.v1", rootPolicy.environmentPolicyIdentity);
  } catch {
    fail("SNAPSHOT_ADMISSION_POLICY_INVALID");
  }
  return { signer, publicKey };
}

function observations(githubObservations) {
  if (
    !githubObservations ||
    typeof githubObservations !== "object" ||
    Array.isArray(githubObservations) ||
    Object.keys(githubObservations).length !== 1 ||
    typeof githubObservations.readExact !== "function"
  )
    fail("SNAPSHOT_ADMISSION_OBSERVATION_INVALID");
  return githubObservations.readExact;
}

function exact(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 6
  )
    fail("SNAPSHOT_ADMISSION_OBSERVATION_INVALID");
  const {
    repository,
    producerRun,
    workflowBytes,
    environmentPolicy,
    queuedLabels,
    admissionBytes
  } = value;
  if (
    !repository ||
    repository.id !== "1253231368" ||
    repository.name !== "keqi119/subscription-Saas" ||
    !Array.isArray(queuedLabels) ||
    !Buffer.isBuffer(admissionBytes) ||
    !Buffer.isBuffer(workflowBytes)
  )
    fail("SNAPSHOT_ADMISSION_OBSERVATION_INVALID");
  return {
    repository,
    producerRun: { ...producerRun, queuedLabels },
    workflowBytes: Buffer.from(workflowBytes),
    environmentPolicy,
    queuedLabels,
    admissionBytes
  };
}

// The approved workflow subset permits only a complete, literal `uses:` value on one
// line. This is intentionally not a YAML parser: quoting, flow values, aliases, multiline
// values, local/reusable/dynamic references, and any non-40-hex ref fail closed.
function pinnedActions(workflowBytes) {
  const source = workflowBytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(workflowBytes))
    fail("SNAPSHOT_ADMISSION_WORKFLOW_INVALID");
  const actions = [];
  for (const line of source.split("\n")) {
    if (!line.includes("uses:")) continue;
    const match = line.match(
      /^\s*(?:-\s*)?uses:\s*([a-z0-9_.-]+\/[a-z0-9_.-]+)@([0-9a-f]{40})\s*(?:#.*)?$/
    );
    if (!match) fail("SNAPSHOT_ADMISSION_WORKFLOW_INVALID");
    actions.push({ action: match[1], commit: match[2] });
  }
  if (actions.length === 0 || new Set(actions.map(canonicalJson)).size !== actions.length)
    fail("SNAPSHOT_ADMISSION_WORKFLOW_INVALID");
  return actions.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

function keyDescriptor(privateKeyFd, expectedPublicKey) {
  if (
    !privateKeyFd ||
    typeof privateKeyFd !== "object" ||
    Array.isArray(privateKeyFd) ||
    Object.keys(privateKeyFd).length !== 2 ||
    typeof privateKeyFd.publicKey !== "string" ||
    typeof privateKeyFd.readPrivateKey !== "function"
  )
    fail("SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID");
  try {
    if (
      !createPublicKey(privateKeyFd.publicKey)
        .export({ type: "spki", format: "der" })
        .equals(expectedPublicKey.export({ type: "spki", format: "der" }))
    )
      fail("SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID");
  } catch (error) {
    if (error?.code === "SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID") throw error;
    fail("SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID");
  }
  let privateKey;
  try {
    privateKey = privateKeyFd.readPrivateKey();
  } catch {
    fail("SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID");
  }
  try {
    if (
      privateKey?.asymmetricKeyType !== "ed25519" ||
      !createPublicKey(privateKey)
        .export({ type: "spki", format: "der" })
        .equals(expectedPublicKey.export({ type: "spki", format: "der" }))
    )
      fail("SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID");
  } catch (error) {
    if (error?.code === "SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID") throw error;
    fail("SNAPSHOT_ADMISSION_KEY_DESCRIPTOR_INVALID");
  }
  return privateKey;
}

export async function verifyAndSignSnapshotAdmission({
  admission,
  dispatchVerification,
  githubObservations,
  rootPolicy,
  privateKeyFd
} = {}) {
  // Every GitHub fact is read before the fresh Task 2V verifier and before the descriptor.
  const readExact = observations(githubObservations);
  let received;
  try {
    received = exact(await readExact());
  } catch (error) {
    if (error?.code?.startsWith("SNAPSHOT_ADMISSION_")) throw error;
    fail("SNAPSHOT_ADMISSION_OBSERVATION_UNAVAILABLE");
  }
  const trustedRoot = root(rootPolicy);
  const identity = buildEnvironmentPolicyIdentity({
    rootPolicy,
    apiPolicy: received.environmentPolicy
  });
  const actions = pinnedActions(received.workflowBytes);
  if (
    !same(identity, rootPolicy.environmentPolicyIdentity) ||
    sha256Bytes(received.workflowBytes) !== rootPolicy.workflow.blobDigest ||
    !same(
      actions,
      [...rootPolicy.workflow.actionCommits].sort((a, b) =>
        canonicalJson(a).localeCompare(canonicalJson(b))
      )
    )
  )
    fail("SNAPSHOT_ADMISSION_OBSERVATION_INVALID");
  let verifiedDispatch;
  try {
    verifiedDispatch = await verifyDispatchAuthorization(dispatchVerification);
  } catch (error) {
    if (error?.code?.startsWith("DISPATCH_")) throw error;
    fail("SNAPSHOT_ADMISSION_DISPATCH_INVALID");
  }
  const routeNonce = (() => {
    try {
      const artifact = JSON.parse(received.admissionBytes.toString("utf8"));
      if (!artifact?.route?.nonce || !same(artifact, admission))
        fail("SNAPSHOT_ADMISSION_ARTIFACT_MISMATCH");
      return artifact.route.nonce;
    } catch (error) {
      if (error?.code === "SNAPSHOT_ADMISSION_ARTIFACT_MISMATCH") throw error;
      fail("SNAPSHOT_ADMISSION_ARTIFACT_MISMATCH");
    }
  })();
  const rebuilt = buildSnapshotAdmission({
    verifiedDispatch,
    producerRunObservation: { ...received.producerRun, queuedLabels: received.queuedLabels },
    routeNonce,
    rootPolicy,
    now: dispatchVerification?.clock?.now?.()
  });
  if (!same(rebuilt, admission)) fail("SNAPSHOT_ADMISSION_ARTIFACT_MISMATCH");
  const unsigned = {
    schemaVersion: "snapshot-admission-verification.v1",
    snapshotAdmissionDigest: sha256Canonical(rebuilt),
    environmentPolicyIdentityDigest: sha256Canonical(identity),
    githubApiResponseDigest: sha256Canonical({
      repository: received.repository,
      producerRun: received.producerRun,
      workflowBlobDigest: sha256Bytes(received.workflowBytes),
      environmentPolicy: received.environmentPolicy,
      queuedLabels: received.queuedLabels
    }),
    workflowBlobDigest: sha256Bytes(received.workflowBytes),
    rootSigner: {
      issuer: trustedRoot.signer.issuer,
      keyId: trustedRoot.signer.keyId,
      algorithm: "Ed25519"
    }
  };
  const privateKey = keyDescriptor(privateKeyFd, trustedRoot.publicKey);
  const signature = sign(
    null,
    Buffer.from(
      canonicalJson({ domain: "snapshot-admission-verification.v1", verification: unsigned })
    ),
    privateKey
  ).toString("base64");
  const result = { ...unsigned, signature };
  try {
    validateContract("snapshot-admission-verification.v1", result);
  } catch {
    fail("SNAPSHOT_ADMISSION_SIGNING_INVALID");
  }
  return Object.freeze(result);
}
