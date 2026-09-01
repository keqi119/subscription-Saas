import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256Canonical } from "../src/index.mjs";

test("uses RFC 8785 object ordering without sorting array elements", () => {
  assert.equal(canonicalJson({ z: [2, 1], a: "中" }), '{"a":"中","z":[2,1]}');
});

for (const [name, value] of [
  ["NaN", Number.NaN],
  ["positive infinity", Number.POSITIVE_INFINITY],
  ["undefined", undefined],
  ["bigint", 1n],
  ["function", () => null],
  ["symbol", Symbol("not-json")]
]) {
  test(`rejects non-I-JSON value ${name}`, () => {
    assert.throws(() => canonicalJson({ value }), { code: "CANONICAL_JSON_REFUSED" });
  });
}

test("rejects cyclic input with the deterministic refusal code", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), { code: "CANONICAL_JSON_REFUSED" });
});

test("emits a lowercase SHA-256 digest over UTF-8 canonical JSON", () => {
  assert.equal(
    sha256Canonical({ b: 2, a: 1 }),
    "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
  );
});
