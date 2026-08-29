export const STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET = Object.freeze({
  orderId: "c392fa54-4784-4e04-ad4a-bfe2fd7e2d10",
  orderNo: "ORD20260726073922TFHF",
  vehicleId: "70565059-1841-4c97-a32c-7bd09ce0b90f",
  vehicleNo: "VEH20260713140950K4BT",
  vin: "TESTVINET50000001"
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SELECTOR_OPTIONS = new Map([
  ["--order-id", "orderId"],
  ["--order-no", "orderNo"],
  ["--vehicle-id", "vehicleId"],
  ["--vehicle-no", "vehicleNo"],
  ["--vin", "vin"]
]);

export function parseStage1StagingInvalidTestOrderRetirementArgs(args) {
  let expectedEvidenceDigest = null;
  let mode = null;
  let operatorId = null;
  let output = null;
  const selectors = {};
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run" || argument === "--apply") {
      useOnce(seen, "mode");
      mode = argument === "--apply" ? "apply" : "dry-run";
      continue;
    }
    if (SELECTOR_OPTIONS.has(argument)) {
      const field = SELECTOR_OPTIONS.get(argument);
      useOnce(seen, field);
      selectors[field] = optionValue(args, ++index);
      continue;
    }
    if (argument === "--operator-id") {
      useOnce(seen, "operatorId");
      operatorId = optionValue(args, ++index);
      continue;
    }
    if (argument === "--expected-evidence-digest") {
      useOnce(seen, "expectedEvidenceDigest");
      expectedEvidenceDigest = optionValue(args, ++index);
      continue;
    }
    if (argument === "--output") {
      useOnce(seen, "output");
      output = optionValue(args, ++index);
      continue;
    }
    if (typeof argument === "string" && argument.startsWith("--output=")) {
      useOnce(seen, "output");
      output = nonempty(argument.slice("--output=".length));
      continue;
    }
    invalidArguments();
  }

  if (mode === null || operatorId === null || !UUID.test(operatorId)) invalidArguments();
  for (const field of Object.keys(STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET)) {
    if (typeof selectors[field] !== "string") invalidArguments();
  }
  if (!UUID.test(selectors.orderId) || !UUID.test(selectors.vehicleId)) invalidArguments();
  if (mode === "apply") {
    if (expectedEvidenceDigest === null) {
      throw new Error(
        "STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_EXPECTED_EVIDENCE_DIGEST_REQUIRED"
      );
    }
    if (!SHA256.test(expectedEvidenceDigest)) invalidArguments();
  } else if (expectedEvidenceDigest !== null) {
    invalidArguments();
  }

  assertStage1StagingInvalidTestOrderRetirementTarget(selectors);
  return { expectedEvidenceDigest, mode, operatorId, output, selectors };
}

export function assertStage1StagingInvalidTestOrderRetirementTarget(selectors) {
  for (const [field, expected] of Object.entries(
    STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET
  )) {
    if (selectors?.[field] !== expected) {
      throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET_MISMATCH");
    }
  }
}

function optionValue(args, index) {
  const value = args[index];
  if (typeof value !== "string" || value.startsWith("--")) invalidArguments();
  return nonempty(value);
}

function nonempty(value) {
  if (value.trim().length === 0) invalidArguments();
  return value;
}

function useOnce(seen, key) {
  if (seen.has(key)) invalidArguments();
  seen.add(key);
}

function invalidArguments() {
  throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_ARGUMENTS_INVALID");
}
