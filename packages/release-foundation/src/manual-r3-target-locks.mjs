// Pure descriptions of the R3 physical and reserved database locks. Possessing
// these descriptions grants no access to a database or to the lock journal.
import { canonicalJson } from "./canonical-json.mjs";
import { suiteDatabaseName } from "./database-target.mjs";
import { sha256Canonical } from "./digest.mjs";

const CODE = "MANUAL_TARGET_LOCK_INVALID";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL = /^[1-9][0-9]*$/u;
const DATABASE = /^s1ci_[0-9a-f]{24}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const MARKER_VERSION = "subscription-s1-ephemeral/v1";
const APPLICATION_PREFIX = `${MARKER_VERSION}:`;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (condition) => {
  if (!condition) fail();
};
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exact(value, names) {
  need(
    plain(value) &&
      Reflect.ownKeys(value).length === names.length &&
      names.every((name) => Object.hasOwn(value, name))
  );
}
function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (plain(value))
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)]))
    );
  return value;
}
function checkedMarker(marker, operationRef) {
  need(typeof marker === "string" && marker.length > 0);
  const json = marker.startsWith(APPLICATION_PREFIX)
    ? marker.slice(APPLICATION_PREFIX.length)
    : marker;
  let facts;
  try {
    facts = JSON.parse(json);
  } catch {
    fail();
  }
  exact(facts, ["markerVersion", "runIdDigest", "suiteIdDigest", "shard", "createdAt"]);
  need(
    canonicalJson(facts) === json &&
      facts.markerVersion === MARKER_VERSION &&
      facts.runIdDigest === sha256Canonical(operationRef) &&
      DIGEST.test(facts.suiteIdDigest) &&
      Number.isSafeInteger(facts.shard) &&
      facts.shard >= 0 &&
      typeof facts.createdAt === "string" &&
      TIMESTAMP.test(facts.createdAt) &&
      !Number.isNaN(Date.parse(facts.createdAt)) &&
      new Date(facts.createdAt).toISOString() === facts.createdAt
  );
}

export function planManualR3TargetLocks(input) {
  try {
    exact(input, ["operationRef", "engineId", "systemIdentifier", "targets"]);
    const { operationRef, engineId, systemIdentifier, targets } = input;
    need(
      UUID.test(operationRef) &&
        typeof engineId === "string" &&
        /^[A-Za-z0-9_.:-]{1,128}$/u.test(engineId) &&
        typeof systemIdentifier === "string" &&
        DECIMAL.test(systemIdentifier) &&
        Array.isArray(targets) &&
        targets.length > 0
    );
    const reservedNames = [0, 1].map((shard) =>
      suiteDatabaseName(operationRef, "database-lifecycle", shard)
    );
    const names = new Set(reservedNames);
    const oids = new Set();
    const entries = [];
    for (const target of targets) {
      exact(target, ["databaseName", "databaseOid", "marker"]);
      const { databaseName, databaseOid, marker } = target;
      need(
        typeof databaseName === "string" && DATABASE.test(databaseName) && !names.has(databaseName)
      );
      need(typeof databaseOid === "string" && DECIMAL.test(databaseOid) && !oids.has(databaseOid));
      checkedMarker(marker, operationRef);
      names.add(databaseName);
      oids.add(databaseOid);
      const identity = {
        kind: "r3-database-target",
        engineId,
        systemIdentifier,
        databaseOid,
        marker
      };
      entries.push({ lockDigest: sha256Canonical(identity), identity, databaseName });
    }
    for (const databaseName of reservedNames) {
      const identity = {
        kind: "r3-database-reservation",
        engineId,
        systemIdentifier,
        databaseName
      };
      entries.push({ lockDigest: sha256Canonical(identity), identity, databaseName });
    }
    entries.sort((left, right) => left.lockDigest.localeCompare(right.lockDigest, "en"));
    need(new Set(entries.map(({ lockDigest }) => lockDigest)).size === entries.length);
    return freeze({ operationRef, engineId, systemIdentifier, entries });
  } catch {
    fail();
  }
}
