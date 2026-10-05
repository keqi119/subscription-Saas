// Private root-to-root pipe for the fixed Python attempt controller. This CLI
// may return an App JWT on its dedicated stdout pipe: never forward that pipe
// to a job, terminal, log or evidence file. No command/path/key override exists.
import { Buffer } from "node:buffer";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { verifyDispatchAuthorization } from "../../packages/release-foundation/src/dispatch-authorization.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { admitH1Snapshot } from "./snapshot-h1-admit.mjs";
import { createInstalledH1DispatchVerification } from "./snapshot-h1-dispatch.mjs";
import { createH1GitHubJwtSupplier } from "./snapshot-h1-github-jwt.mjs";
import { readH1SnapshotProductionInputs } from "./snapshot-h1-signing.mjs";

const CODE = "H1_ATTEMPT_AUTHORITY_REJECTED";
const requireThat = (value) => {
  if (!value) throw Object.assign(new Error(CODE), { code: CODE });
};

function bound(production, admission, dispatch, deploymentId) {
  validateContract("snapshot-admission.v1", admission);
  const auth = production.authorization;
  const pairs = {
    releaseAttemptId: admission.releaseAttemptId,
    sourceSha: admission.producerRun.sourceSha,
    snapshotRunId: admission.producerRun.runId,
    executionPurpose: admission.executionPurpose,
    revocationPolicyDigest: dispatch.revocationPolicyDigest
  };
  requireThat(
    Object.entries(pairs).every(([key, value]) => auth[key] === value) &&
      auth.producer.pendingDeploymentId === deploymentId &&
      auth.producer.environment.policyIdentityDigest ===
        admission.environmentPolicyIdentityDigest &&
      auth.producer.environment.id === "23175152803" &&
      auth.bindings.dispatchAuthorizationDigest === sha256Canonical(dispatch) &&
      admission.dispatchAuthorizationDigest === sha256Canonical(dispatch) &&
      auth.bindings.adapterExecutableDigest === dispatch.adapterDigest &&
      admission.adapterDigest === dispatch.adapterDigest &&
      ["buildProofDigest", "buildBundleDigest", "repositoryContractDigest"].every(
        (key) => auth.bindings[key] === dispatch[key]
      ) &&
      Date.parse(auth.notBefore) <= Date.now() &&
      Date.now() < Date.parse(auth.notAfter)
  );
}

export async function runH1AttemptAuthority(input) {
  assertKernelFrame(input, ["operation", "request"], CODE);
  const captured = snapshotKernelData(input, CODE);
  const { operation, request } = captured;
  requireThat(["admit", "recheck", "jwt"].includes(operation));
  if (operation === "jwt") {
    assertKernelFrame(request, [], CODE);
    return { jwt: await createH1GitHubJwtSupplier()() };
  }
  if (operation === "admit") {
    assertKernelFrame(request, ["selection", "approvalSelection"], CODE);
    const production = await readH1SnapshotProductionInputs();
    const admitted = await admitH1Snapshot(request);
    const { dispatchVerification } = await createInstalledH1DispatchVerification();
    bound(
      production,
      admitted.admission,
      dispatchVerification.authorization,
      request.approvalSelection.deploymentId
    );
    return { ...admitted, production };
  }
  assertKernelFrame(request, ["admission", "producerAuthorizationDigest", "deploymentId"], CODE);
  const production = await readH1SnapshotProductionInputs();
  requireThat(sha256Canonical(production.authorization) === request.producerAuthorizationDigest);
  const { dispatchVerification } = await createInstalledH1DispatchVerification();
  bound(production, request.admission, dispatchVerification.authorization, request.deploymentId);
  const verified = await verifyDispatchAuthorization(dispatchVerification);
  return {
    authorizationDigest: verified.authorizationDigest,
    validUntilEpochMs: Date.parse(verified.notAfter),
    revocationSequence: verified.revocationSequence,
    revocationHeadDigest: verified.revocationHeadDigest
  };
}

async function main() {
  requireThat(process.argv.length === 2 && process.platform === "linux" && process.getuid() === 0);
  const parts = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    requireThat(size <= 1048576);
    parts.push(chunk);
  }
  const raw = Buffer.concat(parts, size),
    input = JSON.parse(raw.toString("utf8"));
  requireThat(raw.equals(Buffer.from(canonicalJson(input))));
  process.stdout.write(canonicalJson(await runH1AttemptAuthority(input)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write(`${CODE}\n`);
    process.exitCode = 1;
  });
