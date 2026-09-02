import { runnerError } from "./error-codes.mjs";
import { sha256Canonical, validateContract } from "@subscription-saas/release-foundation";

import { loadCommandRegistry, registeredCommand } from "./command-registry.mjs";

function requireAdapter(adapters, name) {
  if (typeof adapters?.[name] !== "function") {
    throw runnerError("RUNNER_TRUSTED_ADAPTER_MISSING", { adapter: name });
  }
}

const forbiddenSecretKey =
  /^(?:authorization|clientsecret|connectionstring|databaseurl|password|rawcredential|token)$/iu;
const rawDatabaseUrl = /postgres(?:ql)?:\/\//iu;

function containsRawSecret(value, key = "") {
  if (forbiddenSecretKey.test(key)) return true;
  if (typeof value === "string") return rawDatabaseUrl.test(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsRawSecret(entry));
  return Object.entries(value).some(([childKey, child]) => containsRawSecret(child, childKey));
}

export async function runTrustedEntrypoint({ envelopeFile, argv = [], adapters } = {}) {
  if (argv.length > 0) throw runnerError("RUNNER_ENTRYPOINT_OVERRIDE_REJECTED");
  if (!envelopeFile) throw runnerError("RUNNER_LAUNCH_ENVELOPE_REQUIRED");
  requireAdapter(adapters, "readEnvelope");
  const envelope = await adapters.readEnvelope(envelopeFile);
  if (envelope?.executionMode === "database-test") {
    requireAdapter(adapters, "runDatabaseTests");
    validateContract("database-test-launch-envelope.v1", envelope);
    if (containsRawSecret(envelope)) {
      throw runnerError("RUNNER_LAUNCH_ENVELOPE_SECRET_FORBIDDEN");
    }
    return adapters.runDatabaseTests(envelope);
  }
  requireAdapter(adapters, "launch");
  validateContract("runner-launch-envelope.v1", envelope);
  if (containsRawSecret(envelope)) {
    throw runnerError("RUNNER_LAUNCH_ENVELOPE_SECRET_FORBIDDEN");
  }
  if (
    envelope.requestDigest !== sha256Canonical(envelope.request) ||
    envelope.buildProofDigest !== envelope.request.buildProofDigest ||
    envelope.actualRunnerDigest !== envelope.request.actualRunnerDigest ||
    envelope.launchAttestationDigest !== sha256Canonical(envelope.request.launchAttestation)
  ) {
    throw runnerError("RUNNER_LAUNCH_ENVELOPE_IDENTITY_MISMATCH");
  }
  const registry = adapters.loadRegistry
    ? await adapters.loadRegistry()
    : await loadCommandRegistry();
  registeredCommand(registry, envelope.commandKey);
  return adapters.launch({
    commandKey: envelope.commandKey,
    request: envelope.request,
    envelope
  });
}
