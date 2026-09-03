#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  sha256Canonical,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const sourceShaPattern = /^[0-9a-f]{40}$/u;
const actionShaPattern = /^[0-9a-f]{40}$/u;

function materialError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function baseRepository(baseImage) {
  const lastSlash = baseImage.lastIndexOf("/");
  const lastColon = baseImage.lastIndexOf(":");
  return lastColon > lastSlash ? baseImage.slice(0, lastColon) : baseImage;
}

export function provenanceMaterialMatchesBase({
  material,
  baseImage,
  declaredDigest,
  resolvedDigest
}) {
  const repository = baseRepository(baseImage);
  const uri = String(material?.uri ?? "");
  const repositoryMatches =
    uri.startsWith(`pkg:docker/${repository}@`) || uri.includes(`/${repository}@`);
  const observedDigests = Object.values(material?.digest ?? {});
  const expectedDigests = [declaredDigest, resolvedDigest]
    .filter((value) => digestPattern.test(value ?? ""))
    .map((value) => value.replace(/^sha256:/u, ""));
  return repositoryMatches && expectedDigests.some((digest) => observedDigests.includes(digest));
}

function assertPolicy(policy) {
  const trustedBuild = policy?.trustedBuild;
  if (
    policy?.schemaVersion !== "build-material-policy.v1" ||
    !trustedBuild ||
    typeof trustedBuild.workflow !== "string" ||
    typeof trustedBuild.eventName !== "string" ||
    typeof trustedBuild.ref !== "string" ||
    !Number.isInteger(trustedBuild.runAttempt) ||
    typeof trustedBuild.platform !== "string" ||
    typeof trustedBuild.protectedEnvironment !== "string" ||
    !Array.isArray(policy.requiredImages) ||
    Object.keys(policy.externalActions ?? {}).length === 0 ||
    Object.keys(policy.baseImages ?? {}).length === 0 ||
    !policy.requiredBaseImagesByArtifact ||
    !Array.isArray(policy.requiredRunnerAssets) ||
    policy.requiredRunnerAssets.length === 0 ||
    policy.requireRegistryDigest !== true ||
    policy.requireBuildAttestation !== true ||
    policy.requireBuilderProvenance !== true
  ) {
    throw materialError("BUILD_MATERIAL_POLICY_INVALID");
  }
  for (const commitSha of Object.values(policy.externalActions)) {
    if (!actionShaPattern.test(commitSha)) {
      throw materialError("BUILD_MATERIAL_POLICY_INVALID", { field: "externalActions" });
    }
  }
  for (const imageDigest of Object.values(policy.baseImages)) {
    if (!digestPattern.test(imageDigest)) {
      throw materialError("BUILD_MATERIAL_POLICY_INVALID", { field: "baseImages" });
    }
  }
}

function workflowJob(workflow, jobName) {
  const lines = workflow.split(/\r?\n/u);
  const start = lines.findIndex((line) => new RegExp(`^  ${jobName}:\\s*$`, "u").test(line));
  if (start < 0) throw materialError("BUILD_WORKFLOW_JOB_MISSING", { jobName });
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [a-zA-Z0-9_-]+:\s*$/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function workflowActions(workflow) {
  const actions = [];
  const pattern = /^\s*-?\s*uses:\s*([^\s@]+\/[^\s@]+)@([^\s#]+)\s*$/gmu;
  for (const match of workflow.matchAll(pattern)) {
    if (!match[1].startsWith("./")) actions.push({ name: match[1], commitSha: match[2] });
  }
  return actions;
}

function includesTrustedRunGuard(workflow, policy) {
  const escapedRef = policy.trustedBuild.ref.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    new RegExp(`github\\.ref\\s*==\\s*['\"]${escapedRef}['\"]`, "u").test(workflow) &&
    /github\.run_attempt\s*==\s*1/u.test(workflow)
  );
}

export function verifyBuildWorkflow(workflow, policy) {
  assertPolicy(policy);
  if (typeof workflow !== "string" || workflow.length === 0) {
    throw materialError("BUILD_WORKFLOW_INVALID");
  }
  const observedActions = workflowActions(workflow);
  for (const action of observedActions) {
    if (!actionShaPattern.test(action.commitSha)) {
      throw materialError("BUILD_ACTION_UNPINNED", action);
    }
    if (policy.externalActions[action.name] !== action.commitSha) {
      throw materialError("BUILD_ACTION_UNAPPROVED", action);
    }
  }
  for (const [name, commitSha] of Object.entries(policy.externalActions)) {
    if (!observedActions.some((action) => action.name === name && action.commitSha === commitSha)) {
      throw materialError("BUILD_ACTION_REQUIRED", { name, commitSha });
    }
  }
  if (
    /\bpull_request\b/u.test(workflow) ||
    !includesTrustedRunGuard(workflow, policy) ||
    !workflow.includes(`environment: ${policy.trustedBuild.protectedEnvironment}`)
  ) {
    throw materialError("PR_ARTIFACT_NOT_PROMOTABLE");
  }

  const imageBuildArguments = Object.freeze({
    api: "API_SOURCE_REVISION",
    web: "WEB_SOURCE_REVISION",
    runner: "RUNNER_SOURCE_REVISION"
  });
  for (const [name, buildArgument] of Object.entries(imageBuildArguments)) {
    const job = workflowJob(workflow, `build-${name}`);
    if (
      !/^\s*needs:\s*prepare\s*$/mu.test(job) ||
      !/ref:\s*\$\{\{\s*needs\.prepare\.outputs\.source-sha\s*\}\}/u.test(job) ||
      !new RegExp(
        `${buildArgument}=\\$\\{\\{\\s*needs\\.prepare\\.outputs\\.source-sha\\s*\\}\\}`,
        "u"
      ).test(job)
    ) {
      throw materialError("BUILD_IMAGE_SOURCE_NOT_FIXED", { image: name });
    }
    if (
      !new RegExp(`platforms:\\s*${policy.trustedBuild.platform.replace("/", "\\/")}`, "u").test(
        job
      ) ||
      !/provenance:\s*mode=max/u.test(job) ||
      !/sbom:\s*true/u.test(job)
    ) {
      throw materialError("BUILD_PROVENANCE_INCOMPLETE", { image: name });
    }
  }

  const observer = workflowJob(workflow, "observe-build-materials");
  for (const dependency of ["prepare", "build-api", "build-web", "build-runner"]) {
    if (!new RegExp(`needs:[^\\n]*\\b${dependency}\\b`, "u").test(observer)) {
      throw materialError("BUILD_OBSERVER_DEPENDENCY_MISSING", { dependency });
    }
  }
  if (!observer.includes(`environment: ${policy.trustedBuild.protectedEnvironment}`)) {
    throw materialError("BUILD_OBSERVER_UNPROTECTED");
  }
  for (const provenanceMarker of [
    ".Provenance.SLSA",
    "resolvedDependencies",
    ".materials",
    "declaredDigest"
  ]) {
    if (!observer.includes(provenanceMarker)) {
      throw materialError("BUILD_PROVENANCE_OBSERVER_INCOMPLETE", { provenanceMarker });
    }
  }
  return deepFreeze({ status: "verified", actions: observedActions });
}

export function verifyDockerfileBaseImages({ dockerfiles, policy }) {
  assertPolicy(policy);
  const observations = [];
  for (const [artifact, dockerfile] of Object.entries(dockerfiles ?? {})) {
    if (!policy.requiredBaseImagesByArtifact[artifact] || typeof dockerfile !== "string") {
      throw materialError("BUILD_BASE_IMAGE_UNPROVEN", { artifact });
    }
    const stageAliases = new Set();
    const observedBases = [];
    for (const match of dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/gimu)) {
      const reference = match[1];
      const alias = match[2]?.toLowerCase();
      if (!stageAliases.has(reference.toLowerCase())) observedBases.push(reference);
      if (alias) stageAliases.add(alias);
    }
    for (const baseImage of policy.requiredBaseImagesByArtifact[artifact]) {
      const expected = `${baseImage}@${policy.baseImages[baseImage]}`;
      if (!observedBases.includes(expected)) {
        throw materialError("BUILD_BASE_IMAGE_UNPROVEN", { artifact, baseImage });
      }
    }
    for (const observed of observedBases) {
      const separator = observed.lastIndexOf("@sha256:");
      const baseImage = separator >= 0 ? observed.slice(0, separator) : observed;
      const digest = separator >= 0 ? observed.slice(separator + 1) : undefined;
      if (policy.baseImages[baseImage] !== digest) {
        throw materialError("BUILD_BASE_IMAGE_UNPROVEN", { artifact, baseImage });
      }
    }
    observations.push({ artifact, baseImages: [...new Set(observedBases)].sort() });
  }
  for (const artifact of policy.requiredImages) {
    if (!Object.hasOwn(dockerfiles ?? {}, artifact)) {
      throw materialError("BUILD_BASE_IMAGE_UNPROVEN", { artifact });
    }
  }
  return deepFreeze({ status: "verified", observations });
}

export function verifyRunnerDependencyClosure({ dockerfile, inventory, requiredAssets = [] }) {
  const expected = (inventory?.files ?? [])
    .filter(({ disposition }) => disposition === "runner-only")
    .map(({ repositorySource }) => repositorySource)
    .sort();
  if (expected.length === 0 || new Set(expected).size !== expected.length) {
    throw materialError("RUNNER_DEPENDENCY_INVENTORY_INVALID");
  }

  const normalized = String(dockerfile ?? "").replace(/\\\r?\n\s*/gu, " ");
  const observed = [];
  const copiedSources = [];
  for (const match of normalized.matchAll(/^COPY\s+(?!--from=)(.+)$/gimu)) {
    const tokens = match[1].trim().split(/\s+/u);
    for (const source of tokens.slice(0, -1)) {
      if ([".", "./", "scripts", "scripts/"].includes(source)) {
        throw materialError("RUNNER_DEPENDENCY_COPY_TOO_BROAD", { source });
      }
      copiedSources.push(source.replace(/\/$/u, ""));
      if (source.startsWith("scripts/")) observed.push(source);
    }
  }
  observed.sort();
  if (
    observed.length !== expected.length ||
    new Set(observed).size !== expected.length ||
    observed.some((source, index) => source !== expected[index])
  ) {
    throw materialError("RUNNER_DEPENDENCY_CLOSURE_MISMATCH", { expected, observed });
  }
  const missingAssets = requiredAssets.filter((asset) => !copiedSources.includes(asset));
  if (missingAssets.length > 0) {
    throw materialError("RUNNER_REQUIRED_ASSET_MISSING", { missingAssets });
  }
  return deepFreeze({ status: "verified", files: observed, requiredAssets: [...requiredAssets] });
}

function assertDigest(value, code, details) {
  if (!digestPattern.test(value ?? "")) throw materialError(code, details);
}

function assertRepositoryWithoutTag(image) {
  if (typeof image !== "string" || image.length === 0 || image.includes("@")) {
    throw materialError("BUILD_REGISTRY_DIGEST_REQUIRED", { image });
  }
  const finalSegment = image.slice(image.lastIndexOf("/") + 1);
  if (finalSegment.includes(":")) {
    throw materialError("BUILD_REGISTRY_DIGEST_REQUIRED", { image });
  }
}

function normalizeImage(input, policy, context) {
  assertRepositoryWithoutTag(input?.image);
  assertDigest(input?.digest, "BUILD_REGISTRY_DIGEST_REQUIRED", { image: input?.name });
  if (input.registrySubject !== `${input.image}@${input.digest}`) {
    throw materialError("BUILD_REGISTRY_DIGEST_REQUIRED", { image: input?.name });
  }
  if (input.platform !== policy.trustedBuild.platform) {
    throw materialError("BUILD_PLATFORM_MISMATCH", { image: input?.name });
  }
  if (input.sourceRevision !== context.sourceSha) {
    throw materialError("BUILD_SOURCE_REVISION_MISMATCH", { image: input?.name });
  }
  if (input.buildRunRef !== context.ciRunRef) {
    throw materialError("BUILD_RUN_MISMATCH", { image: input?.name });
  }
  if (
    policy.requireBuildAttestation &&
    (typeof input.buildAttestationRef !== "string" ||
      !input.buildAttestationRef.startsWith(`oci://${input.registrySubject}`))
  ) {
    throw materialError("BUILD_ATTESTATION_REQUIRED", { image: input?.name });
  }

  const observedBases = Array.isArray(input.baseImageDigests) ? input.baseImageDigests : [];
  const requiredBases = policy.requiredBaseImagesByArtifact[input.name] ?? [];
  if (
    requiredBases.length === 0 ||
    observedBases.length !== requiredBases.length ||
    requiredBases.some(
      (baseImage) =>
        !observedBases.some(
          (observed) =>
            observed.image === baseImage &&
            observed.declaredDigest === policy.baseImages[baseImage] &&
            digestPattern.test(observed.digest ?? "")
        )
    ) ||
    observedBases.some(
      (observed) =>
        policy.baseImages[observed.image] !== observed.declaredDigest ||
        !digestPattern.test(observed.digest ?? "")
    )
  ) {
    throw materialError("BUILD_BASE_IMAGE_UNPROVEN", { image: input?.name });
  }
  if (typeof input.builderName !== "string" || input.builderName.length === 0) {
    throw materialError("BUILD_BUILDER_PROVENANCE_REQUIRED", { image: input?.name });
  }

  return {
    name: input.name,
    image: input.image,
    platform: input.platform,
    digest: input.digest,
    sourceRevision: input.sourceRevision,
    baseImageDigests: observedBases
      .map(({ image, declaredDigest, digest }) => ({ image, declaredDigest, digest }))
      .sort((left, right) => left.image.localeCompare(right.image)),
    builderName: input.builderName,
    buildAttestationRef: input.buildAttestationRef,
    registrySubject: input.registrySubject,
    buildRunRef: input.buildRunRef
  };
}

export function verifyBuildMaterials(input) {
  const policy = input?.policy;
  assertPolicy(policy);
  verifyBuildWorkflow(input.workflow, policy);
  const context = input.context ?? {};
  if (
    context.eventName !== policy.trustedBuild.eventName ||
    context.ref !== policy.trustedBuild.ref ||
    context.runAttempt !== policy.trustedBuild.runAttempt ||
    context.protectedEnvironment !== policy.trustedBuild.protectedEnvironment
  ) {
    throw materialError("PR_ARTIFACT_NOT_PROMOTABLE");
  }
  if (
    !sourceShaPattern.test(context.sourceSha ?? "") ||
    context.checkoutRef !== context.sourceSha
  ) {
    throw materialError("BUILD_CHECKOUT_REF_MISMATCH");
  }
  assertDigest(input.repositoryContractDigest, "BUILD_REPOSITORY_CONTRACT_DIGEST_INVALID");
  assertDigest(input.migrationCatalogDigest, "BUILD_MIGRATION_CATALOG_DIGEST_INVALID");

  const requiredImages = [...policy.requiredImages].sort();
  const imageInputs = Array.isArray(input.images) ? input.images : [];
  const observedNames = imageInputs.map(({ name }) => name).sort();
  if (
    imageInputs.length !== requiredImages.length ||
    new Set(observedNames).size !== requiredImages.length ||
    JSON.stringify(observedNames) !== JSON.stringify(requiredImages)
  ) {
    throw materialError("BUILD_IMAGE_SET_INCOMPLETE", { requiredImages, observedNames });
  }
  const images = imageInputs
    .map((imageInput) => normalizeImage(imageInput, policy, context))
    .sort((left, right) => left.name.localeCompare(right.name));

  const externalActions = Array.isArray(input.externalActions) ? input.externalActions : [];
  const expectedActions = Object.entries(policy.externalActions).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (
    externalActions.length !== expectedActions.length ||
    expectedActions.some(
      ([name, commitSha]) =>
        !externalActions.some(
          (observed) => observed.name === name && observed.commitSha === commitSha
        )
    )
  ) {
    throw materialError("BUILD_ACTION_MATERIAL_MISMATCH");
  }
  if (
    policy.requireBuilderProvenance &&
    (typeof input.builder?.name !== "string" ||
      typeof input.builder?.provenanceRef !== "string" ||
      input.builder.provenanceRef.length === 0 ||
      images.some(({ builderName }) => builderName !== input.builder.name))
  ) {
    throw materialError("BUILD_BUILDER_PROVENANCE_REQUIRED");
  }
  if (Number.isNaN(Date.parse(input.observedAt)) || !String(input.observedAt).endsWith("Z")) {
    throw materialError("BUILD_OBSERVED_AT_INVALID");
  }

  const observation = {
    schemaVersion: "build-material-observation.v1",
    sourceSha: context.sourceSha,
    checkoutRef: context.checkoutRef,
    ciRunRef: context.ciRunRef,
    repositoryContractDigest: input.repositoryContractDigest,
    migrationCatalogDigest: input.migrationCatalogDigest,
    policyDigest: sha256Canonical(policy),
    promotionEligibility: "trusted-candidate",
    images,
    externalActions: externalActions
      .map(({ name, commitSha }) => ({ name, commitSha }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    builder: { name: input.builder.name, provenanceRef: input.builder.provenanceRef },
    observedAt: input.observedAt
  };
  validateContract("build-material-observation.v1", observation);
  return deepFreeze(observation);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const repoRoot = process.cwd();
  const policy = JSON.parse(
    await readFile(path.join(repoRoot, "release/contracts/build-material-policy.v1.json"), "utf8")
  );
  const workflowPath = argument("--workflow");
  const inputPath = argument("--input");
  const outputPath = argument("--output");
  if (workflowPath) {
    const [workflow, api, web, runner, runnerInventory] = await Promise.all([
      readFile(path.resolve(repoRoot, workflowPath), "utf8"),
      readFile(path.join(repoRoot, "Dockerfile.api"), "utf8"),
      readFile(path.join(repoRoot, "Dockerfile.web"), "utf8"),
      readFile(path.join(repoRoot, "Dockerfile.runner"), "utf8"),
      readFile(
        path.join(repoRoot, "release/contracts/api-runtime-governance-inventory.v1.json"),
        "utf8"
      ).then(JSON.parse)
    ]);
    const result = verifyBuildWorkflow(workflow, policy);
    const baseImages = verifyDockerfileBaseImages({
      policy,
      dockerfiles: { api, web, runner }
    });
    const runnerDependencies = verifyRunnerDependencyClosure({
      dockerfile: runner,
      inventory: runnerInventory,
      requiredAssets: policy.requiredRunnerAssets
    });
    process.stdout.write(
      `${JSON.stringify({
        ...result,
        baseImages: baseImages.observations,
        runnerDependencies: runnerDependencies.files
      })}\n`
    );
    return;
  }
  if (inputPath) {
    const input = JSON.parse(await readFile(path.resolve(repoRoot, inputPath), "utf8"));
    const workflow = await readFile(path.join(repoRoot, policy.trustedBuild.workflow), "utf8");
    const observation = verifyBuildMaterials({ ...input, policy, workflow });
    if (outputPath) {
      await writeFile(path.resolve(repoRoot, outputPath), `${canonicalJson(observation)}\n`, {
        flag: "wx"
      });
    }
    process.stdout.write(`${JSON.stringify(observation)}\n`);
    return;
  }
  throw materialError("BUILD_MATERIAL_ARGUMENT_REQUIRED");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "BUILD_MATERIAL_VERIFY_FAILED"}\n`);
    process.exitCode = 1;
  });
}
