#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
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
const execFile = promisify(execFileCallback);

async function assertExactMergedMain(repoRoot, mainSha) {
  let main;
  try {
    ({ stdout: main } = await execFile("git", ["rev-parse", "refs/heads/main"], { cwd: repoRoot }));
  } catch {
    fail("INFRASTRUCTURE_CHANGE_MAIN_UNAVAILABLE");
  }
  if (main.trim() !== mainSha) fail("INFRASTRUCTURE_CHANGE_MAIN_SHA_INVALID");
  try {
    await execFile("git", ["diff", "--quiet", mainSha, "--"], { cwd: repoRoot });
  } catch (error) {
    if (error?.code === 1) fail("INFRASTRUCTURE_CHANGE_REVISION_DIRTY");
    fail("INFRASTRUCTURE_CHANGE_MAIN_UNAVAILABLE");
  }
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
  await assertExactMergedMain(repoRoot, mainSha);
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
  const names = new Set(["--main-sha", "--owner-id", "--output"]);
  if (
    args.length !== 6 ||
    args.some((value, index) => (index % 2 === 0 ? !names.has(value) : names.has(value)))
  )
    fail("INFRASTRUCTURE_CHANGE_ARGUMENT_INVALID");
  const read = (name) => {
    const matches = args.reduce((count, value) => count + (value === name), 0);
    if (matches !== 1) fail("INFRASTRUCTURE_CHANGE_ARGUMENT_INVALID");
    const value = args[args.indexOf(name) + 1];
    if (!value) fail("INFRASTRUCTURE_CHANGE_ARGUMENT_INVALID");
    return value;
  };
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
