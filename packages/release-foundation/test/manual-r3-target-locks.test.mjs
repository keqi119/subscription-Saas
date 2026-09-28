import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../src/canonical-json.mjs";
import { suiteDatabaseName } from "../src/database-target.mjs";
import { sha256Canonical } from "../src/digest.mjs";
import { planManualR3TargetLocks } from "../src/manual-r3-target-locks.mjs";

const operationRef = "123e4567-e89b-42d3-a456-426614174000";
const facts = (shard = 0) => ({
  markerVersion: "subscription-s1-ephemeral/v1",
  runIdDigest: sha256Canonical(operationRef),
  suiteIdDigest: sha256Canonical(`suite-${shard}`),
  shard,
  createdAt: "2026-09-28T00:00:00.000Z"
});
const target = (shard = 0, databaseOid = "5001") => ({
  databaseName: suiteDatabaseName(operationRef, `suite-${shard}`, shard),
  databaseOid,
  marker: canonicalJson(facts(shard))
});
const plan = (targets = [target()], engineId = "engine-synthetic") =>
  planManualR3TargetLocks({ operationRef, engineId, systemIdentifier: "7123456789", targets });
const refused = (fn) => assert.throws(fn, { code: "MANUAL_TARGET_LOCK_INVALID" });

test("R3 target locks bind physical identities and two lifecycle reservations in digest order", () => {
  const result = plan([target(1, "5002"), target()]);
  assert.equal(result.entries.length, 4);
  assert.deepEqual(
    result.entries.map((entry) => entry.lockDigest),
    [...result.entries.map((entry) => entry.lockDigest)].sort()
  );
  for (const entry of result.entries)
    assert.equal(entry.lockDigest, sha256Canonical(entry.identity));
  const reservations = result.entries.filter(
    (entry) => entry.identity.kind === "r3-database-reservation"
  );
  assert.deepEqual(
    reservations.map((entry) => entry.databaseName).sort(),
    [0, 1].map((shard) => suiteDatabaseName(operationRef, "database-lifecycle", shard)).sort()
  );
  assert.ok(reservations.every(({ identity }) => !Object.hasOwn(identity, "databaseOid")));
  assert.notDeepEqual(
    plan().entries.map((entry) => entry.lockDigest),
    plan(undefined, "engine-other").entries.map((entry) => entry.lockDigest)
  );
});

test("R3 target locks reject duplicate targets, physical OIDs and foreign operation markers", () => {
  refused(() => plan([target(), target()]));
  refused(() => plan([target(), target(1)]));
  refused(() =>
    plan([{ ...target(), databaseName: suiteDatabaseName(operationRef, "database-lifecycle", 0) }])
  );
  refused(() =>
    plan([
      { ...target(), marker: canonicalJson({ ...facts(), runIdDigest: sha256Canonical("other") }) }
    ])
  );
});

test("R3 target locks require closed inputs and return immutable exact markers", () => {
  refused(() => plan([{ ...target(), password: "never" }]));
  refused(() => plan([{ ...target(), marker: JSON.stringify(facts()) }]));
  refused(() => plan([{ ...target(), marker: canonicalJson({ ...facts(), extra: true }) }]));
  refused(() => plan([{ ...target(), databaseOid: "0" }]));
  const marker = `subscription-s1-ephemeral/v1:${canonicalJson(facts())}`;
  const result = plan([{ ...target(), marker }]);
  const physical = result.entries.find((entry) => entry.identity.kind === "r3-database-target");
  assert.equal(physical.identity.marker, marker);
  assert.ok(
    Object.isFrozen(result) && Object.isFrozen(result.entries) && Object.isFrozen(physical.identity)
  );
  assert.throws(() => {
    physical.identity.marker = "changed";
  }, TypeError);
});
