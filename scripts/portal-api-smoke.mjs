#!/usr/bin/env node

const DEFAULT_API_BASE_URL = "http://localhost:3001/api";

const publicEndpoints = [
  "/portal/catalog/vehicles",
  "/portal/catalog/subscription-plans"
];

const authenticatedEndpoints = [
  "/portal/auth/me",
  "/portal/applications",
  "/portal/contracts",
  "/portal/payment-orders",
  "/portal/orders",
  "/portal/bills",
  "/portal/deposit",
  "/portal/entitlements",
  "/portal/service-cases",
  "/portal/notifications"
];

const apiBaseUrl = stripTrailingSlash(process.env.PORTAL_API_BASE_URL ?? process.env.SMOKE_API_BASE_URL ?? process.env.API_BASE_URL ?? DEFAULT_API_BASE_URL);
const cookie = normalizeCookie(process.env.PORTAL_CUSTOMER_COOKIE);
const requireAuth = process.env.PORTAL_API_SMOKE_REQUIRE_AUTH === "1";
const timeoutMs = Number(process.env.PORTAL_API_SMOKE_TIMEOUT_MS ?? "10000");
let failures = 0;

async function main() {
  console.log(`Portal API smoke started: ${apiBaseUrl}`);

  for (const endpoint of publicEndpoints) {
    await checkEndpoint("public", endpoint);
  }

  if (!cookie) {
    const message = "SKIP authenticated Portal API smoke: PORTAL_CUSTOMER_COOKIE is not set.";
    if (requireAuth) {
      console.error(message);
      process.exit(1);
    }
    console.log(message);
  } else {
    for (const endpoint of authenticatedEndpoints) {
      await checkEndpoint("authenticated", endpoint, cookie);
    }
  }

  if (failures > 0) {
    console.error(`FAIL Portal API smoke: ${failures} endpoint(s) failed.`);
    process.exit(1);
  }

  console.log("PASS Portal API smoke");
}

async function checkEndpoint(scope, endpoint, cookieHeader) {
  const url = new URL(endpoint.replace(/^\/+/, ""), `${apiBaseUrl}/`).toString();
  try {
    const response = await fetchWithTimeout(url, cookieHeader);
    const bodyText = await response.text();
    const failed = response.status >= 500 || response.status === 404 || (scope === "public" && response.status >= 400);

    if (failed) {
      failures += 1;
      console.error(`FAIL ${scope} ${endpoint}: status=${response.status} body=${redactBody(bodyText)}`);
      return;
    }

    if (scope === "authenticated" && response.status === 401) {
      failures += 1;
      console.error(`FAIL authenticated ${endpoint}: customer cookie was rejected.`);
      return;
    }

    console.log(`PASS ${scope} ${endpoint}: status=${response.status}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${scope} ${endpoint}: ${errorMessage(error)}`);
  }
}

async function fetchWithTimeout(url, cookieHeader) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeCookie(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.includes("=")) return trimmed;
  return `customer_access_token=${trimmed}`;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function redactBody(value) {
  return value.replace(/eyJ[0-9A-Za-z._-]+/g, "<redacted-token>").slice(0, 300);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
