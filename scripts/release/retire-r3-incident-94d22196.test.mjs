import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("94d retirement retains the reviewed B7 execution and readback shape", async () => {
  const b7 = await readFile(new URL("./retire-r3-incident-b7a1429c.mjs", import.meta.url), "utf8");
  const actual = await readFile(
    new URL("./retire-r3-incident-94d22196.mjs", import.meta.url),
    "utf8"
  );
  const substitutions = [
    ["APPROVED_R3_INCIDENT_B7A1429C", "APPROVED_R3_INCIDENT_94D22196"],
    ["1c8ecfdc52c46fa1c6ead634fe2c6eaa1b664825", "471796a3be1fd0eda3f3be2f1364574e90b5ca96"],
    ["/opt/stage1-r3-candidate-1c8ecfd", "/opt/stage1-r3-candidate-471796a3"],
    ["retire-r3-incident-b7a1429c", "retire-r3-incident-94d22196"]
  ];
  let expected = b7;
  for (const [oldValue, newValue] of substitutions) {
    assert.equal(expected.split(oldValue).length - 1, 1, oldValue);
    expected = expected.replace(oldValue, newValue);
  }
  assert.equal(actual, expected);
});
