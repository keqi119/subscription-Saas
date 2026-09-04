#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  computeRepositoryContract,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

function fail(code) {
  throw Object.assign(new Error(code), { code });
}
export async function createInfrastructureChange({
  mainSha,
  ownerId,
  output,
  repoRoot = process.cwd(),
  now = new Date()
}) {
  if (
    !/^[0-9a-f]{40}$/.test(mainSha ?? "") ||
    typeof ownerId !== "string" ||
    ownerId.length === 0 ||
    typeof output !== "string" ||
    output.length === 0
  )
    fail("INFRASTRUCTURE_CHANGE_ARGUMENT_INVALID");
  const contract = await computeRepositoryContract(repoRoot);
  const record = {
    schemaVersion: "infrastructure-change.v1",
    infrastructureChangeId: randomBytes(16).toString("hex"),
    mainSha,
    repositoryContractDigest: contract.digest,
    changeScope: "execution-infrastructure-bootstrap",
    createdAt: now.toISOString(),
    ownerId
  };
  validateContract("infrastructure-change.v1", record, { repoRoot });
  try {
    await writeFile(path.resolve(repoRoot, output), canonicalJson(record), { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") fail("INFRASTRUCTURE_CHANGE_EXISTS");
    throw error;
  }
  return Object.freeze(record);
}
async function main() {
  const args = process.argv.slice(2);
  const read = (name) => args[args.indexOf(name) + 1];
  const record = await createInfrastructureChange({
    mainSha: read("--main-sha"),
    ownerId: read("--owner-id"),
    output: read("--output")
  });
  process.stdout.write(`${canonicalJson(record)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write(`${error.code ?? "INFRASTRUCTURE_CHANGE_CREATE_FAILED"}\n`);
    process.exitCode = 1;
  });
