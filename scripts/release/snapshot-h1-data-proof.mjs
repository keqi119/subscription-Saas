// Private H1 proof assembly. The protected root signer supplies observations;
// this module has no authority to observe the host or sign a result itself.
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  validateProducerCryptoAuthorization,
  validateProducerCryptoUseProof,
  validateSnapshotEncryptionEnvelope
} from "../../packages/release-foundation/src/snapshot/producer-crypto-contracts.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";

const CODE = "H1_DATA_PROOF_REJECTED";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const WORKER_ID = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IMAGE =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const CLEANUP_KEYS = [
  "runnerStopped",
  "controlStopped",
  "producerStopped",
  "runnerNotRoutable",
  "githubTokenRevoked",
  "volumeDestroyed"
];
const VOLUME_KEYS = [
  "attemptId",
  "destroyed",
  "keyslotsBefore",
  "keyslotsAfter",
  "oldKeyRejected",
  "destroyedAt"
];
const VOLUME_OPTIONAL = ["capacityBytes", "luksUuid", "swapRestored", "corePatternRestored"];
const reject = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const requireThat = (condition) => {
  if (!condition) reject();
};
const frame = (value, keys) => assertKernelFrame(value, keys, CODE);
const digest = (value) => typeof value === "string" && DIGEST.test(value);
const instant = (value) => {
  requireThat(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
  );
  const epoch = Date.parse(value);
  requireThat(
    Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 19) === value.slice(0, 19)
  );
  return epoch;
};

function memory(value) {
  frame(value, [
    "observedAt",
    "hostSwapDisabled",
    "coreDumpDisabled",
    "swapTableDigest",
    "corePatternDigest",
    "coreLimit"
  ]);
  requireThat(
    value.hostSwapDisabled === true &&
      value.coreDumpDisabled === true &&
      digest(value.swapTableDigest) &&
      digest(value.corePatternDigest) &&
      Array.isArray(value.coreLimit) &&
      value.coreLimit.length === 2 &&
      value.coreLimit[0] === 0 &&
      value.coreLimit[1] === 0
  );
  return instant(value.observedAt);
}

function volumeObservation(value, attemptId) {
  const keys = Object.keys(value);
  requireThat(
    VOLUME_KEYS.every((key) => Object.hasOwn(value, key)) &&
      keys.every((key) => VOLUME_KEYS.includes(key) || VOLUME_OPTIONAL.includes(key))
  );
  frame(value, keys);
  requireThat(
    value.attemptId === attemptId &&
      value.destroyed === true &&
      Array.isArray(value.keyslotsBefore) &&
      value.keyslotsBefore.length === 1 &&
      value.keyslotsBefore[0] === 0 &&
      Array.isArray(value.keyslotsAfter) &&
      value.keyslotsAfter.length === 0 &&
      value.oldKeyRejected === true &&
      (!Object.hasOwn(value, "capacityBytes") ||
        (Number.isSafeInteger(value.capacityBytes) && value.capacityBytes > 0)) &&
      (!Object.hasOwn(value, "luksUuid") ||
        (typeof value.luksUuid === "string" &&
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value.luksUuid))) &&
      (!Object.hasOwn(value, "swapRestored") || typeof value.swapRestored === "boolean") &&
      (!Object.hasOwn(value, "corePatternRestored") ||
        typeof value.corePatternRestored === "boolean")
  );
  return instant(value.destroyedAt);
}

export function buildH1CryptoUseProof(input) {
  try {
    frame(input, ["authorization", "data", "observation", "terminal", "cleanup", "volume"]);
    const { authorization, data, observation, terminal, cleanup, volume } = snapshotKernelData(
      input,
      CODE
    );
    validateProducerCryptoAuthorization(authorization);
    requireThat(authorization.schemaVersion === "producer-crypto-run-authorization.v2");
    frame(data, [
      "status",
      "metadata",
      "privilegeObservation",
      "fingerprintObservation",
      "scan",
      "envelope",
      "ciphertextPath",
      "cryptoOperation"
    ]);
    requireThat(data.status === "COMPLETE");
    validateSnapshotEncryptionEnvelope(data.envelope, { authorization });
    const operation = data.cryptoOperation;
    frame(operation, [
      "requestId",
      "action",
      "callCount",
      "outcome",
      "startedAt",
      "finishedAt",
      "envelopeDigest",
      "keyBufferClear"
    ]);
    requireThat(
      UUID_V4.test(operation.requestId) &&
        operation.action === "local:GenerateAndWrapDataKey" &&
        operation.callCount === 1 &&
        operation.outcome === "SUCCESS" &&
        operation.envelopeDigest === sha256Canonical(data.envelope) &&
        operation.keyBufferClear === "BEST_EFFORT_COMPLETED"
    );

    frame(observation, [
      "attemptId",
      "snapshotRunId",
      "authorizationDigest",
      "workerBundleDigest",
      "issuedAt",
      "expiresAt",
      "memoryBefore",
      "memoryAfter",
      "processExit"
    ]);
    const authorizationDigest = sha256Canonical(authorization);
    requireThat(
      observation.attemptId === authorization.releaseAttemptId &&
        observation.snapshotRunId === authorization.snapshotRunId &&
        observation.authorizationDigest === authorizationDigest &&
        digest(observation.workerBundleDigest) &&
        observation.workerBundleDigest === authorization.bindings.cryptoExecutableDigest
    );
    const exit = observation.processExit;
    frame(exit, [
      "workerId",
      "image",
      "startedAt",
      "finishedAt",
      "observedAt",
      "exitCode",
      "signal",
      "oomKilled",
      "stdoutClosed",
      "toolExitCode"
    ]);
    requireThat(
      WORKER_ID.test(exit.workerId) &&
        exit.image === IMAGE &&
        exit.exitCode === 0 &&
        exit.signal === null &&
        exit.oomKilled === false &&
        exit.stdoutClosed === true &&
        exit.toolExitCode === 0
    );
    frame(terminal, [
      "observedAt",
      "cleanupFactsDigest",
      "volumeObservationDigest",
      "runningJobObservationDigest"
    ]);
    frame(cleanup, CLEANUP_KEYS);
    requireThat(CLEANUP_KEYS.every((key) => cleanup[key] === true));
    const volumeDestroyed = volumeObservation(volume, authorization.releaseAttemptId);
    requireThat(
      terminal.cleanupFactsDigest === sha256Canonical(cleanup) &&
        terminal.volumeObservationDigest === sha256Canonical(volume) &&
        digest(terminal.runningJobObservationDigest)
    );

    const issued = instant(observation.issuedAt);
    const before = memory(observation.memoryBefore);
    const processStarted = instant(exit.startedAt);
    const cryptoStarted = instant(operation.startedAt);
    const cryptoFinished = instant(operation.finishedAt);
    const processFinished = instant(exit.finishedAt);
    const processObserved = instant(exit.observedAt);
    const after = memory(observation.memoryAfter);
    const closed = instant(terminal.observedAt);
    const expires = instant(observation.expiresAt);
    requireThat(
      issued <= before &&
        before <= processStarted &&
        processStarted <= cryptoStarted &&
        cryptoStarted <= cryptoFinished &&
        cryptoFinished <= processFinished &&
        processFinished <= expires &&
        processFinished <= processObserved &&
        processFinished <= volumeDestroyed &&
        volumeDestroyed <= closed &&
        processObserved <= closed &&
        processFinished <= after &&
        after <= closed
    );

    const envelope = data.envelope;
    const proof = {
      schemaVersion: "producer-crypto-use-proof.v2",
      publishable: true,
      failureKind: null,
      authorizationDigest,
      prerequisiteReadbackDigest: authorization.prerequisites.readbackDigest,
      dataObservationDigest: sha256Canonical(observation),
      request: {
        requestId: operation.requestId,
        action: operation.action,
        keySpec: "AES_256",
        keyFingerprint: authorization.localKey.keyFingerprint,
        contextDigest: authorization.localKey.contextDigest,
        callCount: operation.callCount,
        outcome: operation.outcome
      },
      execution: {
        fingerprint: sha256Canonical({
          authorizationDigest,
          workerId: exit.workerId,
          workerBundleDigest: observation.workerBundleDigest
        }),
        issuedAt: observation.issuedAt,
        expiresAt: observation.expiresAt,
        terminalState: closed <= expires ? "ADMISSION_CLOSED" : "ADMISSION_EXPIRED",
        terminalAt: terminal.observedAt,
        terminalReceiptDigest: sha256Canonical(terminal),
        processExitCode: exit.exitCode,
        processSignal: exit.signal,
        processExitRecordDigest: sha256Canonical(exit)
      },
      encryption: {
        envelopeDigest: sha256Canonical(envelope),
        ciphertextDigest: envelope.ciphertextDigest,
        wrappedDekDigest: envelope.wrappedDek.digest
      },
      cleanup: {
        coreDumpDisabled: observation.memoryAfter.coreDumpDisabled,
        memoryLocked: false,
        hostSwapDisabled: observation.memoryAfter.hostSwapDisabled,
        keyBufferClear: operation.keyBufferClear,
        processExitedAt: exit.finishedAt
      },
      issuer: authorization.issuer.issuerId,
      issuedAt: terminal.observedAt
    };
    validateProducerCryptoUseProof(proof, { authorization, envelope });
    return snapshotKernelData(proof, CODE);
  } catch {
    reject();
  }
}
