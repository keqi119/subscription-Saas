import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInfrastructureChange } from "./create-infrastructure-change.mjs";

test("rejects a non-main SHA without writing a change record", async () => {
  await assert.rejects(
    () => createInfrastructureChange({ mainSha: "BAD", ownerId: "owner", output: "record.json" }),
    { code: "INFRASTRUCTURE_CHANGE_ARGUMENT_INVALID" }
  );
});
