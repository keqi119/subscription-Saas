#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const immutableImagePattern = /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/i;
const runnerServices = Object.freeze({
  "runner-migration": "migrate",
  "runner-verify": "verify"
});
const closedRunnerServices = Object.freeze(["runner-database-test"]);
const requiredServices = Object.freeze([
  "postgres",
  ...Object.keys(runnerServices),
  ...closedRunnerServices,
  "api",
  "web",
  "playwright"
]);

function policyError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function environmentMap(environment) {
  if (!environment) return {};
  if (!Array.isArray(environment)) return environment;
  return Object.fromEntries(
    environment.map((entry) => {
      const separator = entry.indexOf("=");
      return separator < 0 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
    })
  );
}

function volumesOf(service) {
  return Array.isArray(service.volumes) ? service.volumes : [];
}

function assertImmutableImage(serviceName, service) {
  if (!immutableImagePattern.test(service.image ?? "")) {
    throw policyError("COMPOSE_IMAGE_NOT_IMMUTABLE", { service: serviceName });
  }
}

function assertServiceSafety(serviceName, service) {
  if (service.build !== undefined)
    throw policyError("COMPOSE_BUILD_FORBIDDEN", { service: serviceName });
  if (service.entrypoint !== undefined && service.entrypoint !== null) {
    throw policyError("COMPOSE_ENTRYPOINT_OVERRIDE_FORBIDDEN", { service: serviceName });
  }
  const postgresTlsCommand = [
    "postgres",
    "-c",
    "ssl=on",
    "-c",
    "ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem",
    "-c",
    "ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key"
  ];
  if (
    service.command !== undefined &&
    service.command !== null &&
    !(
      serviceName === "postgres" &&
      JSON.stringify(service.command) === JSON.stringify(postgresTlsCommand)
    )
  ) {
    throw policyError("COMPOSE_COMMAND_OVERRIDE_FORBIDDEN", { service: serviceName });
  }
  if (
    service.privileged === true ||
    (service.cap_add?.length ?? 0) > 0 ||
    (service.devices?.length ?? 0) > 0
  ) {
    throw policyError("COMPOSE_PRIVILEGED_FORBIDDEN", { service: serviceName });
  }
  if (
    service.stdin_open === true ||
    service.tty === true ||
    service.pid === "host" ||
    service.ipc === "host"
  ) {
    throw policyError("COMPOSE_EXEC_PATH_FORBIDDEN", { service: serviceName });
  }
  for (const volume of volumesOf(service)) {
    const source = typeof volume === "string" ? volume.split(":", 1)[0] : volume.source;
    const target = typeof volume === "string" ? volume.split(":")[1] : volume.target;
    if (/docker\.sock$/i.test(source ?? "") || /docker\.sock$/i.test(target ?? "")) {
      throw policyError("COMPOSE_DOCKER_SOCKET_FORBIDDEN", { service: serviceName });
    }
    if (typeof volume === "object" && volume.type === "bind") {
      throw policyError("COMPOSE_SOURCE_MOUNT_FORBIDDEN", { service: serviceName });
    }
  }
}

function assertExpectedImage(serviceName, actual, expected) {
  if (expected && actual !== expected) {
    throw policyError("COMPOSE_RELEASE_IMAGE_MISMATCH", { service: serviceName });
  }
}

function labelMap(labels) {
  if (!labels) return {};
  if (!Array.isArray(labels)) return labels;
  return Object.fromEntries(
    labels.map((label) => {
      const separator = label.indexOf("=");
      return separator < 0 ? [label, ""] : [label.slice(0, separator), label.slice(separator + 1)];
    })
  );
}

export function verifyComposeConfig(config, { expectedImages = {}, expectedSourceSha } = {}) {
  if (!config || typeof config !== "object" || !config.services) {
    throw policyError("COMPOSE_CONFIG_INVALID");
  }
  for (const serviceName of requiredServices) {
    if (!config.services[serviceName]) {
      throw policyError("COMPOSE_RELEASE_SERVICE_MISSING", { service: serviceName });
    }
  }
  for (const [serviceName, service] of Object.entries(config.services)) {
    assertImmutableImage(serviceName, service);
    assertServiceSafety(serviceName, service);
  }

  assertExpectedImage("api", config.services.api.image, expectedImages.api);
  assertExpectedImage("web", config.services.web.image, expectedImages.web);
  assertExpectedImage("playwright", config.services.playwright.image, expectedImages.playwright);
  if (!config.services.playwright.image.includes("playwright:v1.62.1-")) {
    throw policyError("COMPOSE_PLAYWRIGHT_VERSION_MISMATCH");
  }
  if (environmentMap(config.services.playwright.environment).PLAYWRIGHT_VERSION !== "1.62.1") {
    throw policyError("COMPOSE_PLAYWRIGHT_VERSION_MISMATCH");
  }

  const capabilities = [];
  for (const [serviceName, capability] of Object.entries(runnerServices)) {
    const service = config.services[serviceName];
    assertExpectedImage(serviceName, service.image, expectedImages.runner);
    if (service.image !== config.services["runner-verify"].image) {
      throw policyError("COMPOSE_RUNNER_BUNDLE_SPLIT", { service: serviceName });
    }
    const environment = environmentMap(service.environment);
    if (
      environment.RUNNER_CAPABILITY_PROFILE !== capability ||
      !Array.isArray(service.profiles) ||
      service.profiles.length !== 1 ||
      service.profiles[0] !== `runner-${capability}` ||
      service.restart !== "no"
    ) {
      throw policyError("COMPOSE_RUNNER_CAPABILITY_INVALID", { service: serviceName });
    }
    capabilities.push(capability);
  }
  const databaseTest = config.services["runner-database-test"];
  assertExpectedImage("runner-database-test", databaseTest.image, expectedImages.runner);
  const databaseTestEnvironment = environmentMap(databaseTest.environment);
  if (
    databaseTest.image !== config.services["runner-verify"].image ||
    databaseTestEnvironment.RUNNER_CAPABILITY_PROFILE !== undefined ||
    databaseTestEnvironment.RUNNER_LAUNCH_ENVELOPE_FILE !==
      "/run/launch/runner-launch-envelope.v1.json" ||
    !Array.isArray(databaseTest.profiles) ||
    databaseTest.profiles.length !== 1 ||
    databaseTest.profiles[0] !== "runner-database-test" ||
    databaseTest.restart !== "no"
  ) {
    throw policyError("COMPOSE_RUNNER_EXECUTION_MODE_INVALID", {
      service: "runner-database-test"
    });
  }

  if (expectedSourceSha) {
    for (const serviceName of [
      "api",
      "web",
      ...Object.keys(runnerServices),
      ...closedRunnerServices
    ]) {
      if (
        labelMap(config.services[serviceName].labels)[
          "com.subscription.release.source-revision"
        ] !== expectedSourceSha
      ) {
        throw policyError("COMPOSE_SOURCE_REVISION_MISMATCH", { service: serviceName });
      }
    }
  }

  const apiEnvironment = environmentMap(config.services.api.environment);
  if (
    apiEnvironment.RELEASE_FINAL_GATE !== "true" ||
    !apiEnvironment.DATABASE_MANIFEST_ID ||
    !apiEnvironment.DATABASE_SESSION_NONCE
  ) {
    throw policyError("COMPOSE_API_SESSION_IDENTITY_MISSING");
  }

  return Object.freeze({
    serviceCount: Object.keys(config.services).length,
    runnerCapabilities: Object.freeze(capabilities.sort())
  });
}

export function readComposeConfig(file, { environment = process.env } = {}) {
  const policyEnvironment = {
    RELEASE_API_DATABASE_URL:
      "postgresql://runtime:policy-only@postgres:5432/release_gate?sslmode=require",
    RELEASE_API_IMAGE: `ghcr.io/policy/subscription-api@sha256:${"a".repeat(64)}`,
    RELEASE_DATABASE_TEST_CREDENTIAL_FILE: "/run/policy/database-test",
    RELEASE_DATABASE_TEST_SOURCE_CREDENTIAL_FILE: "/run/policy/database-test-source",
    RELEASE_MANIFEST_ID: "manifest-policy",
    RELEASE_MIGRATION_CREDENTIAL_FILE: "/run/policy/migrate",
    RELEASE_POSTGRES_PASSWORD_FILE: "/run/policy/postgres",
    RELEASE_RUNNER_LAUNCH_ENVELOPE_FILE: "/run/policy/runner-launch-envelope.v1.json",
    RELEASE_RUNNER_IMAGE: `ghcr.io/policy/subscription-runner@sha256:${"c".repeat(64)}`,
    RELEASE_SESSION_NONCE: "session-policy",
    RELEASE_SOURCE_REVISION: "f".repeat(40),
    RELEASE_VERIFY_CREDENTIAL_FILE: "/run/policy/verify",
    RELEASE_WEB_IMAGE: `ghcr.io/policy/subscription-web@sha256:${"b".repeat(64)}`,
    ...environment
  };
  const output = execFileSync(
    "docker",
    ["compose", "--profile", "*", "-f", path.resolve(file), "config", "--format", "json"],
    { encoding: "utf8", env: policyEnvironment, stdio: ["ignore", "pipe", "pipe"] }
  );
  return JSON.parse(output);
}

export function verifyComposeFile(file, options = {}) {
  return verifyComposeConfig(readComposeConfig(file, options), options);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const result = verifyComposeFile(process.argv[2]);
    process.stdout.write(`${JSON.stringify({ status: "PASSED", ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code ?? "COMPOSE_POLICY_FAILED"}\n`);
    process.exitCode = 1;
  }
}
