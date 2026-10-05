// Root-only, one-operation entry. stdin contains public GitHub IDs only; all
// authority, keys, sessions and runtime pins come from fixed H1 locations.
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { createInstalledH1DispatchVerification } from "./snapshot-h1-dispatch.mjs";
import { createH1SnapshotObservations } from "./snapshot-h1-observations.mjs";
import { createH1GitHubReader } from "./snapshot-h1-github-reader.mjs";
import { createH1GitHubJwtSupplier } from "./snapshot-h1-github-jwt.mjs";
import { verifyAndSignH1SnapshotAdmission } from "./snapshot-h1-signing.mjs";

const CODE = "H1_SNAPSHOT_ADMIT_REJECTED";
const requireThat = (value) => {
  if (!value) throw Object.assign(new Error(CODE), { code: CODE });
};

export async function admitH1Snapshot(input) {
  assertKernelFrame(input, ["selection", "approvalSelection"], CODE);
  const captured = snapshotKernelData(input, CODE);
  assertKernelFrame(
    captured.selection,
    [
      "repository",
      "runId",
      "runAttempt",
      "sourceSha",
      "admissionJobId",
      "jobId",
      "artifactId",
      "artifactName"
    ],
    CODE
  );
  assertKernelFrame(
    captured.approvalSelection,
    ["runId", "runAttempt", "jobId", "deploymentId"],
    CODE
  );
  const { selection, approvalSelection } = captured;
  assertKernelFrame(selection.repository, ["id", "name"], CODE);
  requireThat(
    selection.repository.id === "1253231368" &&
      selection.repository.name === "keqi119/subscription-Saas" &&
      selection.artifactName === "snapshot-admission" &&
      selection.runAttempt === 1 &&
      approvalSelection.runAttempt === 1 &&
      approvalSelection.runId === selection.runId &&
      approvalSelection.jobId === selection.jobId &&
      typeof selection.sourceSha === "string" &&
      /^[a-f0-9]{40}$/.test(selection.sourceSha) &&
      [
        selection.runId,
        selection.admissionJobId,
        selection.jobId,
        selection.artifactId,
        approvalSelection.deploymentId
      ].every((id) => typeof id === "string" && /^[1-9][0-9]*$/.test(id)) &&
      selection.admissionJobId !== selection.jobId
  );
  const { rootPolicy, dispatchVerification } = await createInstalledH1DispatchVerification();
  const installation = {};
  // These files are part of this immutable installed control bundle. The reader
  // checks the separately installed Python controls against these exact bytes.
  for (const name of [
    "snapshot-h1-github-query.py",
    "snapshot-h1-github.py",
    "snapshot-h1-route-journal.py"
  ])
    installation[name] = sha256Bytes(await readFile(new URL(`./${name}`, import.meta.url)));
  const readGitHub = createH1GitHubReader({
    jwtSupplier: createH1GitHubJwtSupplier(),
    installation
  });
  const raw = await readGitHub(selection);
  // One actual bounded API frame per invocation. Both checks use that same
  // frame; its observedAt is rechecked by the mapper. No external caller can
  // supply it or reuse this local source after this operation returns.
  const source = createH1SnapshotObservations({
    selection,
    rootPolicy,
    readGitHub: async () => raw,
    clock: dispatchVerification.clock
  });
  const actual = await source.githubObservations.readExact(selection);
  const admission = JSON.parse(actual.artifact.bytes.toString("utf8"));
  const postApproval = await source.readPostApproval({ admission, approvalSelection });
  // Fresh nonce/OSS/journal verification is last, after approval observation.
  const verification = await verifyAndSignH1SnapshotAdmission({
    admission,
    rootPolicy,
    dispatchVerification,
    githubObservations: source.githubObservations
  });
  return snapshotKernelData({ admission, verification, postApproval }, CODE);
}

async function main() {
  requireThat(process.argv.length === 2 && process.platform === "linux" && process.getuid() === 0);
  const parts = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    requireThat(length <= 16384);
    parts.push(chunk);
  }
  const bytes = Buffer.concat(parts, length);
  const input = JSON.parse(bytes.toString("utf8"));
  requireThat(bytes.equals(Buffer.from(canonicalJson(input))));
  process.stdout.write(canonicalJson(await admitH1Snapshot(input)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code =
      typeof error?.code === "string" &&
      /^(H1_|DISPATCH_|SNAPSHOT_|ENVIRONMENT_)[A-Z0-9_]{1,100}$/.test(error.code)
        ? error.code
        : CODE;
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
