#!/usr/bin/env node

const imageTag = process.env.IMAGE_TAG?.trim() ?? "";
const rawApiBaseUrl = process.env.API_BASE_URL ?? "";
const apiBaseUrl = rawApiBaseUrl.trim();
const deploymentEnvironment = process.env.DEPLOYMENT_ENVIRONMENT?.trim() ?? "";

if (!imageTag) {
  fail("imageTag is required");
}

if (!apiBaseUrl) {
  fail("apiBaseUrl is required");
}

if (rawApiBaseUrl !== apiBaseUrl) {
  fail("apiBaseUrl must not include leading or trailing whitespace");
}

if (!apiBaseUrl.endsWith("/api")) {
  fail("apiBaseUrl must end with exactly /api");
}

if (!["staging", "production"].includes(deploymentEnvironment)) {
  fail("environment must be staging or production");
}

let parsedApiBaseUrl;
try {
  parsedApiBaseUrl = new URL(apiBaseUrl);
} catch {
  fail("apiBaseUrl must be an absolute HTTPS URL");
}

if (parsedApiBaseUrl.protocol !== "https:") {
  fail("apiBaseUrl must be an absolute HTTPS URL");
}

if (parsedApiBaseUrl.pathname !== "/api") {
  fail("apiBaseUrl must end with exactly /api");
}

if (
  parsedApiBaseUrl.username ||
  parsedApiBaseUrl.password ||
  parsedApiBaseUrl.port ||
  parsedApiBaseUrl.search ||
  parsedApiBaseUrl.hash
) {
  fail("apiBaseUrl must not include credentials, a port, query parameters, or a fragment");
}

if (deploymentEnvironment === "production" && apiBaseUrl.toLowerCase().includes("staging")) {
  fail("Production build cannot use staging API base URL");
}

console.log("Image build inputs are valid.");

function fail(message) {
  console.error(message);
  process.exit(1);
}
