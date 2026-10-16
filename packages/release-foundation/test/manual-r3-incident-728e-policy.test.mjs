import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as incident from "../src/manual-r3-incident.mjs";
import { sha256Bytes } from "../src/digest.mjs";

test("728e created-target approval binds the exact 233d source and catalog", async () => {
  const p = incident.APPROVED_R3_INCIDENT_728EAFD7;
  assert.equal(p.operationRef, "728eafd7-f137-4d7f-a0ad-73b2a687e59b");
  assert.equal(p.incidentKind, "CREATED_TARGET_CANDIDATE_USE_UNCONSUMED");
  assert.equal(
    p.proposalDigest,
    "sha256:39f46f8027885180627f661c7a91c80fac0748d56ae593eb96dcfee28151d8be"
  );
  assert.equal(
    p.approvalDigest,
    "sha256:fab527a21cda619b7e0a7164a56ceddf6e2f78e87afcb1a9e2e58420afe2685f"
  );
  assert.equal(p.github.runId, "38740679900");
  assert.equal(p.github.jobId, "116442664424");
  assert.equal(p.executeNotAfter, "2026-10-17T04:00:00.000Z");
  const binding = {
    operationRef: p.operationRef,
    profileDigest: p.profileDigest,
    sourceSha: "233d237227fbcbf5bb03efb068decca63dc6bca7",
    proofRawDigest: "sha256:190a632600b9f8a5f338f891d08d6b720c8e146d6c55cd816aad9bf9cd3b364b",
    materialRawDigest: "sha256:7316c0fff00814f470d2abfac9437ece2620f06784e403562f4c3046b5f1256d",
    creationSpecDigest: p.lockScope.creationSpecDigest,
    jobAdmissionDigest: p.lockScope.jobAdmissionDigest
  };
  assert.equal(
    incident.approvedR3HistoricalSourceBinding(binding),
    "/opt/stage1-r3-candidate-233d237"
  );
  assert.deepEqual(incident.approvedR3HistoricalContractCompatibility(binding), {
    sourceRoot: "/opt/stage1-r3-candidate-233d237",
    sourceSha: "233d237227fbcbf5bb03efb068decca63dc6bca7",
    catalogRawDigest: "sha256:c34beff7b479440cc4390d679fb9073a854b2543f959ac64b4c5174f68823d3b",
    discoveryVersion: "r3-historical-entrypoints-literal.v1"
  });
  // Original catalogs.mjs bytes from the 233d Git object, not its contract manifest.
  const catalogBytes = await readFile(
    new URL("./fixtures/r3-catalogs-233d237.mjs.txt", import.meta.url)
  );
  assert.equal(
    incident.approvedR3HistoricalContractCompatibility(binding).catalogRawDigest,
    sha256Bytes(catalogBytes)
  );
  for (const changed of [
    { operationRef: "b7a1429c-ede5-4036-9091-078b766204ac" },
    { sourceSha: "119c6" },
    { proofRawDigest: "sha256:" + "0".repeat(64) },
    { materialRawDigest: "sha256:" + "0".repeat(64) },
    { creationSpecDigest: "sha256:" + "0".repeat(64) },
    { jobAdmissionDigest: "sha256:" + "0".repeat(64) }
  ]) {
    assert.equal(incident.approvedR3HistoricalSourceBinding({ ...binding, ...changed }), null);
    assert.equal(
      incident.approvedR3HistoricalContractCompatibility({ ...binding, ...changed }),
      null
    );
  }
});
