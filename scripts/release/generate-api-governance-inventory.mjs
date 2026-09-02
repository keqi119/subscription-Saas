#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalJson } from "../../packages/release-foundation/src/index.mjs";

const commandPolicies = Object.freeze({
  "scripts/prisma-migration-checksums.mjs": ["db.schema.verify@1", "verify"],
  "scripts/stage1-clean-acceptance-baseline.mjs": ["stage1.clean-acceptance.baseline@1", "repair"],
  "scripts/stage1-clean-acceptance-target-validator.mjs": [
    "stage1.acceptance.target.verify@1",
    "verify"
  ],
  "scripts/billing-maintenance-cycle-evidence.mjs": [
    "stage1.billing-maintenance.evidence@1",
    "evidence"
  ],
  "scripts/stage1-task9-preflight-governance.mjs": ["stage1.task9.preflight@1", "verify"],
  "scripts/stage1-active-source-facts-repair.mjs": [
    "stage1.active-source-facts.repair@1",
    "repair"
  ],
  "scripts/stage1-contract-change-bootstrap.mjs": ["stage1.contract-change.bootstrap@1", "repair"],
  "scripts/stage1-return-closure-backfill.mjs": ["stage1.return-closure.backfill@1", "repair"],
  "scripts/stage1-staging-invalid-test-order-retirement.mjs": [
    "stage1.invalid-test-order.retire@1",
    "repair"
  ],
  "scripts/stage1c-period-backfill.mjs": ["stage1.period.backfill@1", "repair"],
  "scripts/subscription-segment-bootstrap.mjs": ["subscription.segment.bootstrap@1", "repair"]
});

const ignoredTrackedPrefixes = [".superpowers/", "output/", "tmp/"];

function codeError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function asRepoPath(value) {
  return value.replaceAll("\\", "/");
}

function repoPath(repoRoot, value) {
  return path.join(repoRoot, ...value.split("/"));
}

function resolveRepoRoot(repoRoot) {
  return path.resolve(repoRoot instanceof URL ? fileURLToPath(repoRoot) : repoRoot);
}

function trackedFiles(repoRoot) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8"
  })
    .split("\0")
    .filter(Boolean)
    .map(asRepoPath)
    .filter((file) => !ignoredTrackedPrefixes.some((prefix) => file.startsWith(prefix)))
    .sort((left, right) => left.localeCompare(right));
}

function importedRelativeModules(source, sourcePath, copiedSources) {
  const dependencies = new Set();
  const matcher = /(?:from\s*|import\s*\(|import\s*)["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of source.matchAll(matcher)) {
    const resolved = asRepoPath(
      path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), match[1]))
    );
    const candidates = [resolved, `${resolved}.mjs`, `${resolved}.js`, `${resolved}/index.mjs`];
    const dependency = candidates.find((candidate) => copiedSources.has(candidate));
    if (dependency) dependencies.add(dependency);
  }
  return [...dependencies].sort((left, right) => left.localeCompare(right));
}

function dependencyClosure(entrypoint, dependencyGraph) {
  const visited = new Set();
  const pending = [entrypoint];
  while (pending.length > 0) {
    const current = pending.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(dependencyGraph.get(current) ?? []));
  }
  return [...visited].sort((left, right) => left.localeCompare(right));
}

function formalCallerType(file) {
  if (file === "package.json" || file.endsWith("/package.json")) return "package-script";
  if (file.startsWith(".github/workflows/") && /\.ya?ml$/u.test(file)) return "ci";
  if (/(^|\/)docker-compose(?:\.[^/]+)?\.ya?ml$/u.test(file)) return "compose";
  if (file.startsWith("docs/runbooks/") && file.endsWith(".md")) return "runbook";
  return undefined;
}

async function discoverFormalCallers(repoRoot, files, entrypoints) {
  const callers = new Map();
  function register(callerType, file, entrypoint, detail) {
    const callerId = `${callerType}:${file}:${entrypoint}`;
    const existing = callers.get(callerId) ?? {
      callerId,
      callerType,
      location: file,
      details: [],
      referencedEntrypoints: [entrypoint]
    };
    existing.details.push(detail);
    callers.set(callerId, existing);
  }
  for (const file of files) {
    const callerType = formalCallerType(file);
    if (!callerType) continue;
    const source = await readFile(repoPath(repoRoot, file), "utf8");
    if (callerType === "package-script") {
      const packageJson = JSON.parse(source);
      for (const command of Object.values(packageJson.scripts ?? {})) {
        for (const { entrypoint } of entrypoints.filter(({ entrypoint }) =>
          command.includes(entrypoint)
        )) {
          register(callerType, file, entrypoint, "package-script-reference");
        }
      }
      continue;
    }
    const lines = source.split(/\r?\n/u);
    for (const line of lines) {
      for (const { entrypoint } of entrypoints.filter(({ entrypoint }) =>
        line.includes(entrypoint)
      )) {
        register(callerType, file, entrypoint, "command-reference");
      }
    }
  }
  return [...callers.values()]
    .map((caller) => ({
      ...caller,
      details: [...new Set(caller.details)].sort((left, right) => left.localeCompare(right))
    }))
    .sort((left, right) => left.callerId.localeCompare(right.callerId));
}

export async function discoverApiGovernanceSurface(repoRootInput) {
  const repoRoot = resolveRepoRoot(repoRootInput);
  const dockerfile = await readFile(path.join(repoRoot, "Dockerfile.api"), "utf8");
  const copyPattern = /^COPY --from=build \/app\/(scripts\/\S+)\s+\.\/scripts\/\S+$/gmu;
  const imageFiles = [...dockerfile.matchAll(copyPattern)]
    .map((match) => ({ imagePath: `/app/${match[1]}`, repositorySource: match[1] }))
    .sort((left, right) => left.repositorySource.localeCompare(right.repositorySource));
  const copiedSources = new Set(imageFiles.map(({ repositorySource }) => repositorySource));
  const sourceByPath = new Map(
    await Promise.all(
      imageFiles.map(async ({ repositorySource }) => [
        repositorySource,
        await readFile(repoPath(repoRoot, repositorySource), "utf8")
      ])
    )
  );
  const dependencyGraph = new Map(
    [...sourceByPath].map(([sourcePath, source]) => [
      sourcePath,
      importedRelativeModules(source, sourcePath, copiedSources)
    ])
  );
  const entrypoints = [...sourceByPath]
    .filter(([, source]) => source.includes("process.argv"))
    .map(([entrypoint]) => ({
      entrypoint,
      dependencyClosure: dependencyClosure(entrypoint, dependencyGraph)
    }))
    .sort((left, right) => left.entrypoint.localeCompare(right.entrypoint));
  const callers = await discoverFormalCallers(repoRoot, trackedFiles(repoRoot), entrypoints);
  return Object.freeze({ imageFiles, entrypoints, callers, dependencyGraph });
}

function managedCaller(command, callerType) {
  const slug = command.runnerCommandId.replace("@", "-").replaceAll(".", "-");
  return {
    callerId: `${callerType}:${slug}`,
    callerType,
    location:
      callerType === "manual"
        ? `operations-catalog://${command.runnerCommandId}`
        : `external-automation://${command.runnerCommandId}`,
    details: ["owner-attestation-required"],
    owner: "release-engineering",
    migrationStatus: "runner-cutover-required"
  };
}

export function buildApiGovernanceInventory(surface) {
  const commandByEntrypoint = new Map(
    surface.entrypoints.map(({ entrypoint, dependencyClosure: closure }) => {
      const policy = commandPolicies[entrypoint];
      if (!policy) throw codeError("API_GOVERNANCE_COMMAND_POLICY_MISSING", { entrypoint });
      const [runnerCommandId, capabilityProfile] = policy;
      return [
        entrypoint,
        {
          entrypoint,
          dependencyClosure: closure,
          runnerCommandId,
          capabilityProfile,
          migrationOwner: "release-engineering",
          callers: []
        }
      ];
    })
  );
  for (const caller of surface.callers) {
    for (const entrypoint of caller.referencedEntrypoints) {
      const command = commandByEntrypoint.get(entrypoint);
      if (!command)
        throw codeError("API_GOVERNANCE_CALLER_COMMAND_UNKNOWN", { caller, entrypoint });
      command.callers.push({
        callerId: caller.callerId,
        callerType: caller.callerType,
        location: caller.location,
        details: caller.details,
        owner: "release-engineering",
        migrationStatus: "runner-cutover-required"
      });
    }
  }
  for (const command of commandByEntrypoint.values()) {
    command.callers.push(managedCaller(command, "manual"), managedCaller(command, "external"));
    command.callers.sort((left, right) => left.callerId.localeCompare(right.callerId));
  }
  const commands = [...commandByEntrypoint.values()].sort((left, right) =>
    left.entrypoint.localeCompare(right.entrypoint)
  );
  const files = surface.imageFiles.map(({ imagePath, repositorySource }) => {
    const dependentCommands = commands
      .filter(({ dependencyClosure: closure }) => closure.includes(repositorySource))
      .map(({ entrypoint }) => entrypoint);
    return {
      imagePath,
      repositorySource,
      dependentCommands,
      runtimeConsumers: [],
      disposition: dependentCommands.includes(repositorySource)
        ? "retire-after-caller-migration"
        : "runner-only",
      migrationOwner: "release-engineering",
      exitCondition:
        "All callers use the registered Runner command and the API image allowlist passes."
    };
  });
  return {
    schemaVersion: "api-runtime-governance-inventory.v1",
    source: {
      dockerfile: "Dockerfile.api",
      runtimeCopyCount: files.length,
      executableEntrypointCount: commands.length
    },
    files,
    commands
  };
}

export function verifyApiGovernanceInventory(inventory, surface) {
  const inventoryFiles = new Map(inventory.files.map((file) => [file.repositorySource, file]));
  const inventoryCommands = new Map(
    inventory.commands.map((command) => [command.entrypoint, command])
  );
  const surfaceFileSet = new Set(
    surface.imageFiles.map(({ repositorySource }) => repositorySource)
  );
  const surfaceCommandSet = new Set(surface.entrypoints.map(({ entrypoint }) => entrypoint));
  const unmappedDependencies = [];
  for (const { repositorySource } of surface.imageFiles) {
    if (!inventoryFiles.has(repositorySource)) unmappedDependencies.push(repositorySource);
  }
  for (const repositorySource of inventoryFiles.keys()) {
    if (!surfaceFileSet.has(repositorySource)) unmappedDependencies.push(repositorySource);
  }
  for (const { entrypoint, dependencyClosure: discoveredClosure } of surface.entrypoints) {
    const command = inventoryCommands.get(entrypoint);
    if (!command) {
      unmappedDependencies.push(entrypoint);
      continue;
    }
    if (canonicalJson([...command.dependencyClosure].sort()) !== canonicalJson(discoveredClosure)) {
      unmappedDependencies.push(`${entrypoint}:dependency-closure`);
    }
  }
  for (const entrypoint of inventoryCommands.keys()) {
    if (!surfaceCommandSet.has(entrypoint)) unmappedDependencies.push(entrypoint);
  }
  const callerIndex = new Map(
    inventory.commands.flatMap((command) =>
      command.callers.map((caller) => [caller.callerId, { command, caller }])
    )
  );
  const unownedCallers = surface.callers
    .filter((caller) => {
      const record = callerIndex.get(caller.callerId);
      return !record || !record.caller.owner;
    })
    .map(({ callerId }) => callerId);
  if (unmappedDependencies.length > 0 || unownedCallers.length > 0) {
    throw codeError("API_GOVERNANCE_INVENTORY_INCOMPLETE", {
      unmappedDependencies: [...new Set(unmappedDependencies)].sort(),
      unownedCallers: [...new Set(unownedCallers)].sort()
    });
  }
  return {
    fileCount: inventory.files.length,
    commandCount: inventory.commands.length,
    formalCallerCount: surface.callers.length,
    unownedCallers,
    unmappedDependencies
  };
}

async function main() {
  const repoRoot = process.cwd();
  const surface = await discoverApiGovernanceSurface(repoRoot);
  const generated = buildApiGovernanceInventory(surface);
  if (process.argv.includes("--check")) {
    const inventory = JSON.parse(
      await readFile(
        path.join(repoRoot, "release/contracts/api-runtime-governance-inventory.v1.json"),
        "utf8"
      )
    );
    verifyApiGovernanceInventory(inventory, surface);
    if (canonicalJson(inventory) !== canonicalJson(generated)) {
      throw codeError("API_GOVERNANCE_INVENTORY_STALE");
    }
    process.stdout.write(
      `${JSON.stringify({ status: "verified", fileCount: inventory.files.length, commandCount: inventory.commands.length })}\n`
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(generated, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "API_GOVERNANCE_INVENTORY_FAILED"}\n`);
    process.exitCode = 1;
  });
}
