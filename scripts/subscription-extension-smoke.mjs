import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const apiBaseUrl = normalizeApiBaseUrl(
  process.env.SMOKE_API_BASE_URL ?? process.env.API_BASE_URL ?? "http://localhost:3001/api"
);
const username = process.env.SMOKE_ADMIN_USERNAME ?? process.env.SMOKE_USERNAME ?? "admin";
const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.SMOKE_PASSWORD ?? "Admin@123456";
const portalCookie = normalizeCookie(process.env.PORTAL_CUSTOMER_COOKIE);
const timeoutMs = positiveInteger(process.env.SUBSCRIPTION_EXTENSION_SMOKE_TIMEOUT_MS, 10_000);
const templateEnvironmentKeys = [
  "RENEWAL_REMINDER_D30_TEMPLATE_CODE",
  "RENEWAL_REMINDER_D14_TEMPLATE_CODE",
  "RENEWAL_REMINDER_D3_TEMPLATE_CODE",
  "RENEWAL_EXPIRY_RETURN_TEMPLATE_CODE",
  "RENEWAL_RETURN_OVERDUE_D1_TEMPLATE_CODE"
];

let failures = 0;

async function main() {
  checkReleaseConfiguration();
  await runCheck("GET /health", () => getJson("/health"));
  const cookie = await login();
  await runCheck("GET /renewal-considerations", () =>
    getJson("/renewal-considerations?page=1&pageSize=1", cookie)
  );
  await runCheck("GET /contract-versions and validate extension template", async () => {
    const versions = await getJson("/contract-versions", cookie);
    const rows = Array.isArray(versions) ? versions : [];
    const today = new Date().toISOString().slice(0, 10);
    const active = rows.find(
      (version) =>
        version?.templateType === "SUBSCRIPTION_EXTENSION" &&
        version?.status === "ACTIVE" &&
        (!version.effectiveFrom || version.effectiveFrom <= today) &&
        (!version.effectiveTo || version.effectiveTo >= today)
    );
    if (!active) throw new Error("No currently effective ACTIVE SUBSCRIPTION_EXTENSION template.");
    return { status: 200 };
  });

  const scenario = await loadScenario();
  if (scenario) await checkScenario(scenario, cookie);

  if (portalCookie) {
    await runCheck("GET /portal/renewal-considerations", () =>
      getJson("/portal/renewal-considerations", portalCookie)
    );
    if (scenario?.changeId) {
      await runCheck(`GET /portal/subscription-changes/${scenario.changeId}`, () =>
        getJson(
          `/portal/subscription-changes/${encodeURIComponent(scenario.changeId)}`,
          portalCookie
        )
      );
    }
  } else if (process.env.SUBSCRIPTION_EXTENSION_SMOKE_REQUIRE_PORTAL === "1") {
    fail("PORTAL_CUSTOMER_COOKIE is required for Portal smoke checks.");
  } else {
    console.log("SKIP Portal checks: PORTAL_CUSTOMER_COOKIE is not set.");
  }

  if (failures > 0) {
    throw new Error(`${failures} subscription extension smoke check(s) failed.`);
  }
  console.log(`PASS subscription extension smoke against ${apiBaseUrl}`);
}

function checkReleaseConfiguration() {
  if (process.env.SUBSCRIPTION_EXTENSION_ENABLED !== "true") {
    fail("SUBSCRIPTION_EXTENSION_ENABLED must be true for the staging smoke.");
  } else {
    console.log("PASS SUBSCRIPTION_EXTENSION_ENABLED=true");
  }
  for (const key of templateEnvironmentKeys) {
    const value = process.env[key]?.trim();
    if (!value || value === "<CHANGE_ME>") fail(`${key} is not configured.`);
    else console.log(`PASS ${key} configured`);
  }
}

async function checkScenario(scenario, cookie) {
  if (scenario.orderId) {
    await runCheck(`GET /subscription-changes/orders/${scenario.orderId}`, () =>
      getJson(`/subscription-changes/orders/${encodeURIComponent(scenario.orderId)}`, cookie)
    );
  }
  if (scenario.considerationId) {
    await runCheck(`GET /renewal-considerations/${scenario.considerationId}`, () =>
      getJson(`/renewal-considerations/${encodeURIComponent(scenario.considerationId)}`, cookie)
    );
  }
  if (scenario.changeId) {
    await runCheck(`GET /subscription-changes/${scenario.changeId}`, () =>
      getJson(`/subscription-changes/${encodeURIComponent(scenario.changeId)}`, cookie)
    );
    await runCheck(`GET /subscription-changes/${scenario.changeId}/timeline`, () =>
      getJson(`/subscription-changes/${encodeURIComponent(scenario.changeId)}/timeline`, cookie)
    );
  }
  if (scenario.contractId) {
    await runCheck(`GET /contracts/${scenario.contractId}`, () =>
      getJson(`/contracts/${encodeURIComponent(scenario.contractId)}`, cookie)
    );
  }
}

async function login() {
  const response = await fetchWithTimeout(`${apiBaseUrl}/auth/login`, {
    body: JSON.stringify({ password, username }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!response.ok) throw new Error(`Admin login failed with HTTP ${response.status}.`);
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Admin login did not return a cookie.");
  console.log("PASS POST /auth/login");
  return cookie;
}

async function getJson(endpoint, cookie) {
  const response = await fetchWithTimeout(`${apiBaseUrl}${endpoint}`, {
    headers: cookie ? { cookie } : undefined
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${redact(text)}`);
  if (!text) return { status: response.status };
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${endpoint}.`);
  }
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(name, operation) {
  try {
    await operation();
    console.log(`PASS ${name}`);
  } catch (error) {
    fail(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadScenario() {
  const scenarioFile = args.scenarioFile ?? process.env.SUBSCRIPTION_EXTENSION_SMOKE_SCENARIO_FILE;
  if (!scenarioFile) {
    console.log("SKIP scenario-specific reads: no scenario file configured.");
    return null;
  }
  const file = resolve(scenarioFile);
  try {
    await access(file);
  } catch {
    throw new Error(`Scenario file does not exist: ${file}`);
  }
  return JSON.parse(await readFile(file, "utf8"));
}

function parseArgs(argv) {
  const parsed = { scenarioFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--scenario-file" || !argv[index + 1]) {
      throw new Error("Only --scenario-file <path> is supported.");
    }
    parsed.scenarioFile = argv[index + 1];
    index += 1;
  }
  return parsed;
}

function fail(message) {
  failures += 1;
  console.error(`FAIL ${message}`);
}

function normalizeCookie(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.includes("=") ? trimmed : `customer_access_token=${trimmed}`;
}

function normalizeApiBaseUrl(value) {
  const stripped = value.replace(/\/+$/, "");
  return stripped.endsWith("/api") ? stripped : `${stripped}/api`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function redact(value) {
  return value.replace(/eyJ[0-9A-Za-z._-]+/g, "<redacted-token>").slice(0, 300);
}

main().catch((error) => {
  console.error(
    `FAIL subscription extension smoke: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
