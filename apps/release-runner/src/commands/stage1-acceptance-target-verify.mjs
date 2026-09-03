import { sha256Canonical } from "@subscription-saas/release-foundation";

import { validateStage1CleanAcceptanceTargetBaseline } from "../../../../scripts/stage1-clean-acceptance-baseline-executor.mjs";
import { runnerError } from "../error-codes.mjs";
import { assertReadOnlyStatements } from "./db-schema-verify.mjs";

function assertInput(context, input) {
  if (
    typeof context?.withReadOnlyTransaction !== "function" ||
    !/^sha256:[0-9a-f]{64}$/.test(context.databaseIdentityFingerprint ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(input?.expectedDatabaseIdentityFingerprint ?? "") ||
    typeof input?.approvedManifest !== "object" ||
    input.approvedManifest === null ||
    Array.isArray(input.approvedManifest) ||
    !/^[0-9a-f]{64}$/.test(input.approvedManifestSha256 ?? "")
  ) {
    throw runnerError("TARGET_VERIFICATION_INPUT_INVALID");
  }
  if (context.databaseIdentityFingerprint !== input.expectedDatabaseIdentityFingerprint) {
    throw runnerError("TARGET_IDENTITY_MISMATCH");
  }
}

export async function verifyAcceptanceTarget(context, input) {
  assertInput(context, input);
  const validateTarget = context.validateTarget ?? validateStage1CleanAcceptanceTargetBaseline;
  const result = await context.withReadOnlyTransaction((tx) =>
    validateTarget(tx, {
      approvedManifest: input.approvedManifest,
      approvedManifestSha256: input.approvedManifestSha256
    })
  );
  assertReadOnlyStatements(context.statementLog ?? []);
  if (result?.safe !== true) throw runnerError("FORBIDDEN_DOMAIN_NOT_EMPTY");
  return Object.freeze({
    schemaVersion: "stage1-acceptance-target-verification.v1",
    safe: true,
    counts: Object.freeze({ ...(result.counts ?? {}) }),
    manifestSha256: result.manifestSha256,
    target: Object.freeze({ ...(result.target ?? {}) }),
    databaseIdentityFingerprint: context.databaseIdentityFingerprint,
    statementLogDigest: sha256Canonical(context.statementLog ?? []),
    terminalStatus: "PASSED"
  });
}

export async function stage1AcceptanceTargetVerifyHandler({ baseline, request, database }) {
  const verification = await verifyAcceptanceTarget(database, request.input);
  return Object.freeze({ baseline, verification, terminalStatus: "PASSED" });
}
