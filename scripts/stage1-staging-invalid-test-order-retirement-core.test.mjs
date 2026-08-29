import assert from "node:assert/strict";
import test from "node:test";

const core = await import("./stage1-staging-invalid-test-order-retirement-core.mjs").catch(
  () => ({})
);

const selectors = {
  orderId: "c392fa54-4784-4e04-ad4a-bfe2fd7e2d10",
  orderNo: "ORD20260726073922TFHF",
  vehicleId: "70565059-1841-4c97-a32c-7bd09ce0b90f",
  vehicleNo: "VEH20260713140950K4BT",
  vin: "TESTVINET50000001"
};
const operatorId = "11111111-1111-4111-8111-111111111111";

function required(name) {
  assert.equal(typeof core[name], "function", `${name} must be exported`);
  return core[name];
}

function selectorArgs(overrides = {}) {
  const current = { ...selectors, ...overrides };
  return [
    "--order-id",
    current.orderId,
    "--order-no",
    current.orderNo,
    "--vehicle-id",
    current.vehicleId,
    "--vehicle-no",
    current.vehicleNo,
    "--vin",
    current.vin,
    "--operator-id",
    operatorId
  ];
}

test("parses the exact dry-run contract", () => {
  const parse = required("parseStage1StagingInvalidTestOrderRetirementArgs");
  assert.deepEqual(
    parse(["--dry-run", ...selectorArgs(), "--output", "output/retirement-dry-run.json"]),
    {
      expectedEvidenceDigest: null,
      mode: "dry-run",
      operatorId,
      output: "output/retirement-dry-run.json",
      selectors
    }
  );
});

test("apply requires one lowercase sha256 evidence digest", () => {
  const parse = required("parseStage1StagingInvalidTestOrderRetirementArgs");
  const base = ["--apply", ...selectorArgs()];

  assert.throws(
    () => parse(base),
    /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_EXPECTED_EVIDENCE_DIGEST_REQUIRED/
  );
  assert.throws(
    () => parse([...base, "--expected-evidence-digest", "A".repeat(64)]),
    /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_ARGUMENTS_INVALID/
  );
  assert.equal(
    parse([...base, "--expected-evidence-digest", "a".repeat(64)]).expectedEvidenceDigest,
    "a".repeat(64)
  );
});

test("rejects unknown, repeated, malformed, missing, or mode-incompatible arguments", () => {
  const parse = required("parseStage1StagingInvalidTestOrderRetirementArgs");
  for (const args of [
    [],
    ["--dry-run", "--apply", ...selectorArgs()],
    ["--dry-run", ...selectorArgs(), "--unknown", "x"],
    ["--dry-run", ...selectorArgs(), "--expected-evidence-digest", "a".repeat(64)],
    ["--dry-run", ...selectorArgs(), "--output"],
    ["--dry-run", ...selectorArgs(), "--output", "   "],
    ["--dry-run", ...selectorArgs(), "--order-id", selectors.orderId],
    ["--dry-run", ...selectorArgs().filter((value) => value !== "--vin" && value !== selectors.vin)],
    [
      "--dry-run",
      ...selectorArgs().map((value) => (value === operatorId ? "not-a-uuid" : value))
    ]
  ]) {
    assert.throws(
      () => parse(args),
      /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_/,
      JSON.stringify(args)
    );
  }
});

test("supports equals syntax for output only", () => {
  const parse = required("parseStage1StagingInvalidTestOrderRetirementArgs");
  assert.equal(
    parse(["--dry-run", ...selectorArgs(), "--output=output/report.json"]).output,
    "output/report.json"
  );
});

test("target assertion accepts only the frozen five-field identity", () => {
  const assertTarget = required("assertStage1StagingInvalidTestOrderRetirementTarget");
  assert.doesNotThrow(() => assertTarget(selectors));
  for (const field of Object.keys(selectors)) {
    assert.throws(
      () => assertTarget({ ...selectors, [field]: `${selectors[field]}-other` }),
      /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET_MISMATCH/
    );
  }
});
