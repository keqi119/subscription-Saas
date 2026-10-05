// Pure projection of protected H1 originals. The caller owns GitHub/OSS reads,
// final custody revalidation, and the later independent archive GET.
import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";
import { validateSnapshotCustody } from "../../packages/release-foundation/src/snapshot/custody-contracts.mjs";
import { provisionalSnapshotCustody } from "./snapshot-custody-job.mjs";
import {
  readPublicSnapshotJson,
  verifyH1SnapshotData,
  verifyH1SnapshotPublication,
  verifyH1SnapshotDestruction,
  verifyH1SnapshotPublisherUse
} from "./snapshot-h1-publication.mjs";

const CODE = "H1_SNAPSHOT_COMPLETION_REJECTED";
const REPOSITORY = "keqi119/subscription-Saas";
const WORKFLOW = ".github/workflows/sanitized-snapshot.yml";
const NAMES = ["admission", "snapshot-data", "snapshot-custody"];
const requireThat = (value) => {
  if (!value) throw Object.assign(new Error(CODE), { code: CODE });
};
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const exact = (value, keys) =>
  requireThat(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      same(Object.keys(value).sort(), [...keys].sort())
  );
const instant = (value) => {
  requireThat(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value));
  const time = Date.parse(value);
  requireThat(
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
  );
  return time;
};
const id = (value) => {
  requireThat(Number.isSafeInteger(value) && value > 0);
  return String(value);
};
const originalBytes = (value) => {
  requireThat(Buffer.isBuffer(value) && value.length > 0 && value.length <= 4 * 1024 * 1024);
  return value;
};

function terminalFacts(raw, expected) {
  exact(raw, ["selection", "run", "jobs", "observedAt"]);
  exact(raw.selection, [
    "repository",
    "runId",
    "runAttempt",
    "sourceSha",
    "admissionJobId",
    "jobId",
    "custodyJobId"
  ]);
  requireThat(raw.run && Array.isArray(raw.jobs));
  const { selection, run, jobs } = raw;
  requireThat(
    same(selection.repository, { id: "1253231368", name: REPOSITORY }) &&
      selection.runId === expected.snapshotRunId &&
      selection.runAttempt === 1 &&
      selection.sourceSha === expected.sourceSha &&
      id(run.id) === selection.runId &&
      run.run_attempt === 1 &&
      run.head_sha === expected.sourceSha &&
      run.path === WORKFLOW &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.repository?.full_name === REPOSITORY &&
      run.head_repository?.full_name === REPOSITORY &&
      run.event === "workflow_dispatch" &&
      run.head_branch === "main" &&
      jobs.length === 3 &&
      instant(run.updated_at) <= instant(raw.observedAt)
  );
  const selected = [selection.admissionJobId, selection.jobId, selection.custodyJobId];
  requireThat(new Set(selected).size === 3);
  const ordered = NAMES.map((name, index) => {
    const matched = jobs.filter((job) => job.name === name);
    requireThat(matched.length === 1);
    const job = matched[0];
    requireThat(
      id(job.id) === selected[index] &&
        id(job.run_id) === selection.runId &&
        job.run_attempt === 1 &&
        job.head_sha === expected.sourceSha &&
        job.status === "completed" &&
        job.conclusion === "success" &&
        instant(job.completed_at) <= instant(run.updated_at)
    );
    return { id: selected[index], name, status: job.status, conclusion: job.conclusion };
  });
  return { run, jobs: ordered, observedAt: raw.observedAt };
}

function admissionVerification(result, signer) {
  const value = result.admissionVerification;
  validateContract("snapshot-admission.v1", result.admission);
  validateContract("snapshot-admission-verification.v1", value);
  const { signature, ...unsigned } = value;
  const key = createPublicKey(signer.publicKey);
  requireThat(
    key.asymmetricKeyType === "ed25519" &&
      sha256Bytes(key.export({ type: "spki", format: "der" })) === signer.keyId &&
      value.rootSigner.issuer === signer.issuer &&
      value.rootSigner.keyId === signer.keyId &&
      value.snapshotAdmissionDigest === sha256Canonical(result.admission) &&
      value.environmentPolicyIdentityDigest === result.admission.environmentPolicyIdentityDigest &&
      value.workflowBlobDigest === result.admission.producerRun.workflowBlobDigest &&
      verify(
        null,
        Buffer.from(
          canonicalJson({ domain: "snapshot-admission-verification.v1", verification: unsigned })
        ),
        key,
        Buffer.from(signature, "base64")
      )
  );
  return sha256Canonical(value);
}

export function buildH1FinalSnapshotCustody({
  expected,
  githubTerminalReadback,
  finalSnapshotReadback,
  accessPolicyDigest
}) {
  try {
    const github = terminalFacts(githubTerminalReadback, expected);
    requireThat(
      finalSnapshotReadback?.status === "READBACK_VERIFIED" &&
        instant(github.observedAt) <= instant(finalSnapshotReadback.observedAt)
    );
    const provisional = provisionalSnapshotCustody(finalSnapshotReadback, accessPolicyDigest);
    const finalCustody = {
      ...provisional,
      terminalAt: github.observedAt,
      provisional: false
    };
    validateSnapshotCustody(finalCustody);
    requireThat(
      finalCustody.releaseAttemptId === expected.releaseAttemptId &&
        finalCustody.snapshotRunId === expected.snapshotRunId &&
        finalCustody.sourceSha === expected.sourceSha
    );
    return finalCustody;
  } catch {
    throw Object.assign(new Error(CODE), { code: CODE });
  }
}

export function buildH1SnapshotCompletion(input) {
  try {
    const {
      expected,
      signer,
      dataResultBytes,
      proofBytes,
      publicationBytes,
      terminalBytes,
      destructionBytes,
      publisherUseBytes,
      githubTerminalReadback,
      finalSnapshotReadback,
      accessPolicyDigest
    } = input;
    for (const bytes of [
      dataResultBytes,
      proofBytes,
      publicationBytes,
      terminalBytes,
      destructionBytes,
      publisherUseBytes
    ])
      originalBytes(bytes);
    const { result, sealed } = verifyH1SnapshotData({
      dataResultBytes,
      proofBytes,
      expected,
      signer
    });
    const publication = verifyH1SnapshotPublication({ bytes: publicationBytes, expected, signer });
    const destruction = verifyH1SnapshotDestruction({
      dataResultBytes,
      proofBytes,
      publicationBytes,
      terminalBytes,
      destructionBytes,
      expected,
      signer
    });
    const publisher = verifyH1SnapshotPublisherUse({
      dataResultBytes,
      proofBytes,
      publicationBytes,
      terminalBytes,
      publisherUseBytes,
      expected,
      signer
    });
    const github = terminalFacts(githubTerminalReadback, expected);
    const run = result.admission.producerRun;
    const running = result.runningJobObservation;
    requireThat(
      run.repository === REPOSITORY &&
        run.runId === expected.snapshotRunId &&
        run.runAttempt === 1 &&
        run.workflowPath === WORKFLOW &&
        run.sourceSha === expected.sourceSha &&
        running.run?.id === expected.snapshotRunId &&
        running.run?.runAttempt === 1 &&
        running.run?.sourceSha === expected.sourceSha &&
        running.job?.id === github.jobs[1].id &&
        running.job?.name === "snapshot-data" &&
        sealed.dataResultDigest === sha256Bytes(dataResultBytes) &&
        destruction.cryptoUseProofDigest === sha256Canonical(sealed.proof) &&
        publisher.proof.cryptoUseProofDigest === destruction.cryptoUseProofDigest
    );
    const finalCustody = buildH1FinalSnapshotCustody({
      expected,
      githubTerminalReadback,
      finalSnapshotReadback,
      accessPolicyDigest
    });
    requireThat(
      finalCustody.terminalAt === github.observedAt &&
        finalCustody.object.key === publication.objects[0].key &&
        finalCustody.object.ciphertextDigest === publication.objects[0].digest &&
        finalCustody.object.ciphertextSizeBytes === publication.objects[0].sizeBytes &&
        finalCustody.object.envelopeDigest === sha256Canonical(result.data.envelope) &&
        finalSnapshotReadback?.status === "READBACK_VERIFIED" &&
        same(finalSnapshotReadback.publication, publication) &&
        same(finalSnapshotReadback.data, result) &&
        same(finalSnapshotReadback.proof, sealed) &&
        finalCustody.worm.readbackAt === finalSnapshotReadback.observedAt &&
        finalCustody.authoritativeObservationDigest === sha256Canonical(finalSnapshotReadback)
    );
    const completion = {
      schemaVersion: "snapshot-producer-completion.v1",
      snapshotAdmissionVerificationDigest: admissionVerification(result, signer),
      producerRun: {
        repository: run.repository,
        runId: run.runId,
        runAttempt: run.runAttempt,
        workflowPath: run.workflowPath,
        sourceSha: run.sourceSha
      },
      dataJob: { id: github.jobs[1].id, name: "snapshot-data" },
      dataExportDigest: result.data.metadata.dumpDigest,
      scanReportDigest: sha256Canonical(result.data.scan),
      encryptedObject: {
        objectDigest: finalCustody.object.ciphertextDigest,
        objectVersion: finalCustody.object.version,
        custodyReference: `oss://${finalCustody.bucket.name}/${finalCustody.object.key}?versionId=${encodeURIComponent(finalCustody.object.version)}`
      },
      cryptoUseProofDigest: sha256Canonical(sealed.proof),
      publisherUseProofDigest: sha256Canonical(publisher.proof),
      destructionReceiptDigest: sha256Canonical(destruction.receipt),
      dataCustodyReceiptDigest: sha256Canonical(finalCustody)
    };
    validateContract("snapshot-producer-completion.v1", completion);
    requireThat(result.data.envelope.snapshotDigest === completion.dataExportDigest);
    return { completion, finalCustody };
  } catch {
    throw Object.assign(new Error(CODE), { code: CODE });
  }
}

export function buildH1SnapshotTerminalObservation({
  completion,
  githubTerminalReadback,
  externalCompletionReadback
}) {
  try {
    validateContract("snapshot-producer-completion.v1", completion);
    const expected = {
      snapshotRunId: completion.producerRun.runId,
      sourceSha: completion.producerRun.sourceSha
    };
    const github = terminalFacts(githubTerminalReadback, expected);
    const bytes = originalBytes(externalCompletionReadback.bytes);
    requireThat(
      completion.producerRun.repository === REPOSITORY &&
        completion.producerRun.workflowPath === WORKFLOW &&
        completion.dataJob.id === github.jobs[1].id &&
        same(readPublicSnapshotJson(bytes), completion) &&
        typeof externalCompletionReadback.reference === "string" &&
        externalCompletionReadback.reference.length > 0 &&
        instant(externalCompletionReadback.observedAt) >= instant(github.observedAt)
    );
    const observation = {
      schemaVersion: "producer-terminal-observation.v1",
      snapshotProducerCompletionDigest: sha256Canonical(completion),
      producerRun: {
        ...completion.producerRun,
        status: github.run.status,
        conclusion: github.run.conclusion
      },
      requiredJobs: github.jobs,
      githubApiReadback: {
        responseDigest: sha256Canonical({
          run: githubTerminalReadback.run,
          jobs: githubTerminalReadback.jobs
        }),
        observedAt: github.observedAt
      },
      externalCustodyReadback: {
        reference: externalCompletionReadback.reference,
        contentDigest: sha256Bytes(bytes),
        observedAt: externalCompletionReadback.observedAt
      }
    };
    validateContract("producer-terminal-observation.v1", observation);
    return observation;
  } catch {
    throw Object.assign(new Error(CODE), { code: CODE });
  }
}
