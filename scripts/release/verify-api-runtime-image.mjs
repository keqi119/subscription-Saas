#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function runtimeError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function runtimeStage(dockerfile) {
  const marker = /^FROM\s+\S+\s+AS\s+runtime\s*$/imu;
  const match = marker.exec(dockerfile);
  if (!match) throw runtimeError("API_RUNTIME_STAGE_MISSING");
  return dockerfile.slice(match.index);
}

function assertAllowlist(allowlist) {
  if (
    allowlist?.schemaVersion !== "api-runtime-allowlist.v1" ||
    !Array.isArray(allowlist.allowedCapabilities) ||
    !Array.isArray(allowlist.requiredPaths) ||
    !Array.isArray(allowlist.requiredPathFragments) ||
    !Array.isArray(allowlist.requiredPackageNames) ||
    !Array.isArray(allowlist.forbiddenPaths) ||
    !Array.isArray(allowlist.forbiddenPackageNames) ||
    !Array.isArray(allowlist.forbiddenExecutables) ||
    !Array.isArray(allowlist.inspectionPolicy)
  ) {
    throw runtimeError("API_RUNTIME_ALLOWLIST_INVALID");
  }
}

function detectForbiddenRuntimeCapabilities(runtime, allowlist) {
  const findings = [];
  const normalized = runtime.replaceAll("\\", "/");
  if (
    allowlist.forbiddenPaths.some((forbiddenPath) =>
      new RegExp(
        `^(?:COPY|ADD)\\b[^\\n]*${forbiddenPath.replaceAll("/", "\\/")}(?:/|\\s)`,
        "imu"
      ).test(normalized)
    ) ||
    /^(?:COPY|ADD)\b[^\n]*(?:\/app\/)?scripts(?:\/|\s)/imu.test(normalized)
  ) {
    findings.push("governance-scripts");
  }
  if (
    /^(?:COPY|ADD)\b[^\n]*(?:node_modules\/\.bin\/prisma|\/prisma)(?:\s|$)/imu.test(normalized) ||
    /^RUN\b(?![^\n]*test\s+!\s+-e)[^\n]*(?:\.bin\/prisma|\bprisma)\s+--/imu.test(normalized)
  ) {
    findings.push("prisma-cli");
  }
  if (
    /apt-get[^\n]*install[^\n]*postgresql-client/imu.test(normalized) ||
    /^(?:COPY|ADD)\b[^\n]*\/bin\/psql(?:\s|$)/imu.test(normalized) ||
    /^RUN\b(?![^\n]*!\s+command\s+-v)[^\n]*\bpsql\s+--/imu.test(normalized)
  ) {
    findings.push("psql");
  }
  if (/docker\.sock|\b(?:docker|podman)\s+(?:exec|run)\b/imu.test(normalized)) {
    findings.push("container-control");
  }
  return [...new Set(findings)].sort();
}

export function verifyApiRuntimeDockerfile({ dockerfile, allowlist }) {
  assertAllowlist(allowlist);
  const runtime = runtimeStage(dockerfile);
  const forbiddenCapabilities = detectForbiddenRuntimeCapabilities(runtime, allowlist);
  if (forbiddenCapabilities.length > 0) {
    throw runtimeError("API_RUNTIME_FORBIDDEN_CAPABILITY", { forbiddenCapabilities });
  }
  if (!/^FROM\s+build\s+AS\s+production-deps\s*$/imu.test(dockerfile)) {
    throw runtimeError("API_RUNTIME_PRODUCTION_DEPENDENCIES_MISSING");
  }
  if (
    !/pnpm\s+--filter\s+@subscription-saas\/api\s+deploy\s+--prod\s+--legacy\s+--offline\s+\/prod\/api/imu.test(
      dockerfile
    )
  ) {
    throw runtimeError("API_RUNTIME_PRODUCTION_DEPENDENCIES_MISSING");
  }
  for (const dependencyPath of ["/prod/api/node_modules", "/prod/api/dist"]) {
    if (!runtime.includes(`COPY --from=production-deps ${dependencyPath} `)) {
      throw runtimeError("API_RUNTIME_PRODUCTION_DEPENDENCIES_MISSING", { dependencyPath });
    }
  }
  if (!/CMD\s+\["node",\s*"apps\/api\/dist\/src\/main\.js"\]/u.test(runtime)) {
    throw runtimeError("API_RUNTIME_APPLICATION_ENTRYPOINT_MISSING");
  }
  return Object.freeze({ status: "verified", forbiddenCapabilities });
}

function normalizedImagePath(value) {
  return value
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/|\/)+/u, "")
    .replace(/\/$/u, "");
}

function inferredPackageNames(paths) {
  const names = new Set();
  for (const filePath of paths) {
    if (/(?:^|\/)node_modules\/@prisma\/client(?:\/|$)/u.test(filePath)) {
      names.add("@prisma/client");
    }
    if (
      /(?:^|\/)node_modules\/prisma(?:\/|$)/u.test(filePath) ||
      /(?:^|\/)node_modules\/\.pnpm\/prisma@[^/]+\/node_modules\/prisma(?:\/|$)/u.test(filePath)
    ) {
      names.add("prisma");
    }
  }
  return [...names].sort();
}

export function verifyApiRuntimeFileInventory({ paths, packageNames, allowlist }) {
  assertAllowlist(allowlist);
  const normalizedPaths = [...new Set((paths ?? []).map(normalizedImagePath))].sort();
  const observedPackages = [
    ...new Set(packageNames ?? inferredPackageNames(normalizedPaths))
  ].sort();
  const forbiddenCapabilities = [];

  const forbiddenPaths = allowlist.forbiddenPaths.map(normalizedImagePath);
  if (
    normalizedPaths.some((filePath) =>
      forbiddenPaths.some(
        (forbiddenPath) => filePath === forbiddenPath || filePath.startsWith(`${forbiddenPath}/`)
      )
    )
  ) {
    forbiddenCapabilities.push("governance-scripts");
  }
  if (
    observedPackages.some((packageName) => allowlist.forbiddenPackageNames.includes(packageName)) ||
    normalizedPaths.some((filePath) =>
      allowlist.forbiddenExecutables.some(
        (executable) =>
          filePath.endsWith(`/node_modules/.bin/${executable}`) ||
          filePath.endsWith(`/.bin/${executable}`)
      )
    )
  ) {
    forbiddenCapabilities.push("prisma-cli");
  }
  if (
    normalizedPaths.some(
      (filePath) =>
        filePath === "usr/bin/psql" ||
        filePath === "usr/local/bin/psql" ||
        /\/postgresql\/\d+\/bin\/psql$/u.test(filePath)
    )
  ) {
    forbiddenCapabilities.push("psql");
  }
  if (
    normalizedPaths.some(
      (filePath) =>
        filePath === "usr/bin/docker" ||
        filePath === "usr/local/bin/docker" ||
        filePath === "usr/bin/podman" ||
        filePath === "usr/local/bin/podman" ||
        filePath.endsWith("/docker.sock")
    )
  ) {
    forbiddenCapabilities.push("container-control");
  }
  if (forbiddenCapabilities.length > 0) {
    throw runtimeError("API_RUNTIME_FORBIDDEN_CAPABILITY", {
      forbiddenCapabilities: [...new Set(forbiddenCapabilities)].sort()
    });
  }

  for (const requiredPathValue of allowlist.requiredPaths) {
    const requiredPath = normalizedImagePath(requiredPathValue);
    const present = normalizedPaths.includes(requiredPath);
    if (!present) throw runtimeError("API_RUNTIME_REQUIRED_ASSET_MISSING", { requiredPath });
  }
  for (const fragmentValue of allowlist.requiredPathFragments) {
    const requiredPathFragment = normalizedImagePath(fragmentValue);
    if (!normalizedPaths.some((filePath) => filePath.includes(requiredPathFragment))) {
      throw runtimeError("API_RUNTIME_REQUIRED_ASSET_MISSING", { requiredPathFragment });
    }
  }
  for (const requiredPackageName of allowlist.requiredPackageNames) {
    if (!observedPackages.includes(requiredPackageName)) {
      throw runtimeError("API_RUNTIME_REQUIRED_ASSET_MISSING", { requiredPackageName });
    }
  }

  return Object.freeze({
    status: "verified",
    fileCount: normalizedPaths.length,
    packageNames: Object.freeze(observedPackages),
    forbiddenCapabilities: Object.freeze([])
  });
}

async function runFile(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
  } catch (error) {
    throw runtimeError("API_RUNTIME_IMAGE_INSPECTION_FAILED", {
      command,
      exitCode: error?.code,
      stderr: String(error?.stderr ?? "").slice(0, 2000)
    });
  }
}

export async function verifyApiRuntimeImage({ image, allowlist }) {
  if (typeof image !== "string" || image.length === 0) {
    throw runtimeError("API_RUNTIME_IMAGE_REQUIRED");
  }
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "api-runtime-inventory-"));
  const archivePath = path.join(temporaryDirectory, "rootfs.tar");
  let containerId;
  try {
    ({ stdout: containerId } = await runFile("docker", ["create", image]));
    containerId = containerId.trim();
    if (!/^[a-f0-9]{12,64}$/u.test(containerId)) {
      throw runtimeError("API_RUNTIME_IMAGE_INSPECTION_FAILED", { reason: "container-id" });
    }
    await runFile("docker", ["export", "--output", archivePath, containerId]);
    const { stdout } = await runFile("tar", ["-tf", archivePath]);
    const paths = stdout.split(/\r?\n/u).filter(Boolean);
    return verifyApiRuntimeFileInventory({ paths, allowlist });
  } finally {
    if (containerId && /^[a-f0-9]{12,64}$/u.test(containerId)) {
      await execFileAsync("docker", ["rm", containerId], { maxBuffer: 1024 * 1024 }).catch(
        () => {}
      );
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function serviceBlock(compose, serviceName) {
  const lines = compose.split(/\r?\n/u);
  const start = lines.findIndex((line) => new RegExp(`^  ${serviceName}:\\s*$`, "u").test(line));
  if (start < 0) throw runtimeError("COMPOSE_API_SERVICE_MISSING");
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [a-zA-Z0-9_-]+:\s*$/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function verifyComposeRuntimeBoundary(contents) {
  for (const compose of contents) {
    const api = serviceBlock(compose, "api");
    const forbidden = [
      /(?:^|[\s:/])scripts(?:\/|\\)/imu,
      /docker\.sock/imu,
      /^\s{4}(?:entrypoint|command):/imu,
      /\b(?:privileged|cap_add):/imu
    ].find((pattern) => pattern.test(api));
    if (forbidden) throw runtimeError("COMPOSE_API_RUNTIME_BOUNDARY_VIOLATION");
  }
  return Object.freeze({ status: "verified" });
}

function runnerCommandKeys(command) {
  return [
    command.runnerCommandId,
    ...(command.additionalRunnerCommands ?? []).map(({ runnerCommandId }) => runnerCommandId)
  ];
}

export function verifyFormalCallerCutover({ inventory, packageJson }) {
  const scripts = Object.entries(packageJson.scripts ?? {});
  if (scripts.some(([name]) => name === "runner:exec" || name.startsWith("runner:exec:"))) {
    throw runtimeError("API_GOVERNANCE_GENERIC_RUNNER_ENTRY_FORBIDDEN");
  }
  const directCallers = [];
  const missingRunnerCommands = [];
  for (const command of inventory.commands ?? []) {
    if (command.runnerRegistrationStatus !== "registered") {
      missingRunnerCommands.push(command.runnerCommandId);
    }
    for (const caller of command.callers ?? []) {
      if (!caller.owner || caller.migrationStatus !== "runner-cutover-complete") {
        throw runtimeError("API_GOVERNANCE_CALLER_CUTOVER_INCOMPLETE", {
          callerId: caller.callerId
        });
      }
    }
    for (const [name, value] of scripts) {
      if (value.includes(command.entrypoint) && !/^node\s+--test\b/u.test(value)) {
        directCallers.push(name);
      }
    }
    const hadPackageCaller = (command.callers ?? []).some(
      ({ callerType }) => callerType === "package-script"
    );
    if (hadPackageCaller) {
      for (const commandKey of runnerCommandKeys(command)) {
        const fixedEntries = scripts.filter(([, value]) =>
          value.includes(`node scripts/release/trusted-launch-runner.mjs --command ${commandKey} `)
        );
        if (
          fixedEntries.length === 0 ||
          fixedEntries.some(
            ([, value]) => !/--request-file\s+\.release-inputs\/[a-z0-9.-]+\.json\s*$/u.test(value)
          )
        ) {
          missingRunnerCommands.push(commandKey);
        }
      }
    }
  }
  if (directCallers.length > 0) {
    throw runtimeError("API_GOVERNANCE_DIRECT_CALLER_REMAINS", { directCallers });
  }
  if (missingRunnerCommands.length > 0) {
    throw runtimeError("API_GOVERNANCE_RUNNER_ENTRY_MISSING", {
      commandKeys: [...new Set(missingRunnerCommands)].sort()
    });
  }
  return Object.freeze({ status: "verified" });
}

async function main() {
  const repoRoot = process.cwd();
  const imageIndex = process.argv.indexOf("--image");
  const image = imageIndex >= 0 ? process.argv[imageIndex + 1] : undefined;
  const [dockerfile, allowlist, inventory, packageJson, sourceCompose, imageCompose] =
    await Promise.all([
      readFile(path.join(repoRoot, "Dockerfile.api"), "utf8"),
      readFile(path.join(repoRoot, "release/contracts/api-runtime-allowlist.v1.json"), "utf8").then(
        JSON.parse
      ),
      readFile(
        path.join(repoRoot, "release/contracts/api-runtime-governance-inventory.v1.json"),
        "utf8"
      ).then(JSON.parse),
      readFile(path.join(repoRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(path.join(repoRoot, "docker-compose.staging.example.yml"), "utf8"),
      readFile(path.join(repoRoot, "docker-compose.staging.images.example.yml"), "utf8")
    ]);
  verifyApiRuntimeDockerfile({ dockerfile, allowlist });
  verifyFormalCallerCutover({ inventory, packageJson });
  verifyComposeRuntimeBoundary([sourceCompose, imageCompose]);
  const imageResult = image ? await verifyApiRuntimeImage({ image, allowlist }) : undefined;
  process.stdout.write(
    `${JSON.stringify({ status: "verified", image: imageResult ? { reference: image, ...imageResult } : null })}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "API_RUNTIME_VERIFY_FAILED"}\n`);
    process.exitCode = 1;
  });
}
