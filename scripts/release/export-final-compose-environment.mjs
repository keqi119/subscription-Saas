#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateContract } from "../../packages/release-foundation/src/index.mjs";
import { releaseImageReferences } from "./run-final-compose-gate.mjs";

const chains = new Set(["fresh", "snapshot"]);

function environmentError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function safeLaunchPath(root, relative) {
  if (
    typeof relative !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]+\.(?:json|secret)$/u.test(relative)
  ) {
    throw environmentError("FINAL_COMPOSE_ENVIRONMENT_INVALID");
  }
  const absolute = path.resolve(root, ...relative.split("/"));
  const difference = path.relative(path.resolve(root), absolute);
  if (!difference || difference.startsWith("..") || path.isAbsolute(difference)) {
    throw environmentError("FINAL_COMPOSE_ENVIRONMENT_INVALID");
  }
  return absolute;
}

function assertEnvironmentValue(value) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/u.test(value)) {
    throw environmentError("FINAL_COMPOSE_ENVIRONMENT_INVALID");
  }
  return value;
}

async function loadJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw environmentError("FINAL_COMPOSE_ENVIRONMENT_INVALID", { cause: error?.code });
  }
}

export async function exportFinalComposeEnvironment({
  chain,
  buildProof,
  launchRoot,
  githubEnvFile
}) {
  if (!chains.has(chain) || typeof launchRoot !== "string" || typeof githubEnvFile !== "string") {
    throw environmentError("FINAL_COMPOSE_ENVIRONMENT_INVALID");
  }
  try {
    validateContract("build-proof.v1", buildProof);
  } catch (error) {
    throw environmentError("FINAL_COMPOSE_ENVIRONMENT_INVALID", { cause: error?.code });
  }
  const root = path.resolve(launchRoot);
  const [runtime, target] = await Promise.all([
    loadJson(path.join(root, "final-compose-runtime.v1.json")),
    loadJson(path.join(root, "final-compose-target.v1.json"))
  ]);
  try {
    validateContract("final-compose-runtime.v1", runtime);
    validateContract("final-compose-target.v1", target);
  } catch (error) {
    throw environmentError("FINAL_COMPOSE_ENVIRONMENT_INVALID", { cause: error?.code });
  }
  if (runtime.chain !== chain || target.chain !== chain) {
    throw environmentError("FINAL_COMPOSE_ENVIRONMENT_INVALID");
  }
  const images = releaseImageReferences(buildProof);
  const secrets = Object.fromEntries(
    Object.entries(runtime.composeSecretFiles).map(([name, reference]) => [
      name,
      safeLaunchPath(root, reference)
    ])
  );
  const values = Object.freeze({
    RELEASE_API_DATABASE_URL:
      "postgresql://runtime:policy-only@postgres:5432/release_gate?sslmode=require",
    RELEASE_API_IMAGE: images.api,
    RELEASE_WEB_IMAGE: images.web,
    RELEASE_RUNNER_IMAGE: images.runner,
    RELEASE_SOURCE_REVISION: buildProof.identity.sourceSha,
    RELEASE_MANIFEST_ID: runtime.apiManifestId,
    RELEASE_SESSION_NONCE: runtime.apiSessionNonce,
    RELEASE_GATE_API_BASE: runtime.apiBase,
    RELEASE_GATE_WEB_BASE: runtime.webBase,
    RELEASE_GATE_PUBLIC_API_BASE: runtime.publicApiBase,
    RELEASE_GATE_EMBEDDED_API_BASE: runtime.embeddedApiBase,
    RELEASE_GATE_API_PORT: new URL(runtime.apiBase).port,
    RELEASE_GATE_WEB_PORT: new URL(runtime.webBase).port,
    RELEASE_GATE_DATABASE_PORT: String(target.port),
    RELEASE_POSTGRES_PASSWORD_FILE: secrets.postgresPassword,
    RELEASE_MIGRATION_CREDENTIAL_FILE: secrets.migrationCredential,
    RELEASE_VERIFY_CREDENTIAL_FILE: secrets.verifyCredential,
    RELEASE_DATABASE_TEST_CREDENTIAL_FILE: secrets.databaseTestCredential,
    RELEASE_DATABASE_TEST_SOURCE_CREDENTIAL_FILE: secrets.databaseTestSourceCredential,
    RELEASE_RUNNER_LAUNCH_ENVELOPE_FILE: safeLaunchPath(root, "migration-dry-run.json")
  });
  const lines = Object.entries(values).map(
    ([name, value]) => `${name}=${assertEnvironmentValue(value)}`
  );
  await appendFile(path.resolve(githubEnvFile), `${lines.join("\n")}\n`, {
    encoding: "utf8",
    flag: "a"
  });
  return values;
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function runExportFinalComposeEnvironmentCli(argv) {
  const expected = ["--chain", "--build-proof-file", "--launch-root", "--github-env-file"];
  if (
    argv.length !== expected.length * 2 ||
    expected.some((flag, index) => argv[index * 2] !== flag)
  ) {
    throw environmentError("FINAL_COMPOSE_ENVIRONMENT_ARGUMENT_INVALID");
  }
  return exportFinalComposeEnvironment({
    chain: argument(argv, "--chain"),
    buildProof: await loadJson(path.resolve(argument(argv, "--build-proof-file"))),
    launchRoot: argument(argv, "--launch-root"),
    githubEnvFile: argument(argv, "--github-env-file")
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runExportFinalComposeEnvironmentCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code ?? "FINAL_COMPOSE_ENVIRONMENT_FAILED"}\n`);
    process.exitCode = 1;
  });
}
