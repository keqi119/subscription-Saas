import { access, readFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const apiBaseUrl = normalizeApiBaseUrl(
  process.env.SMOKE_API_BASE_URL ?? process.env.API_BASE_URL ?? "http://localhost:3001/api"
);
const webBaseUrl = process.env.SMOKE_WEB_BASE_URL
  ? stripTrailingSlash(process.env.SMOKE_WEB_BASE_URL)
  : null;
const username = process.env.SMOKE_ADMIN_USERNAME ?? process.env.SMOKE_USERNAME ?? "admin";
const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.SMOKE_PASSWORD ?? "Admin@123456";

const authenticatedEndpoints = [
  "/auth/me",
  "/applications",
  "/products",
  "/quotes",
  "/vehicle-valuation-reviews?page=1&pageSize=1",
  "/reports/dashboard-summary",
  "/reports/asset-profitability/summary",
  "/users",
  "/roles",
  "/audit-logs",
  "/renewal-considerations?page=1&pageSize=1",
  "/contract-versions"
];

const baseWebRoutes = [
  "/",
  "/applications",
  "/vehicles",
  "/orders",
  "/reports",
  "/reports/asset-profitability",
  "/residual-market",
  "/vehicle-valuation-reviews",
  "/renewal-considerations",
  "/subscription-changes"
];

let failures = 0;

async function main() {
  let cookie = null;

  await runCheck("GET /health", () => assertGet("/health"));
  await runCheck("POST /auth/login", async () => {
    const result = await login();
    cookie = result.cookie;
    return { status: result.status };
  });

  if (!cookie) {
    throw new Error("Cannot continue smoke checks without login cookie.");
  }

  for (const endpoint of authenticatedEndpoints) {
    await runCheck(`GET ${endpoint}`, () => assertGet(endpoint, cookie));
  }

  await runCheck("concurrency burst applications/products/users", async () => {
    for (let index = 0; index < 10; index += 1) {
      await Promise.all([
        assertGet("/applications", cookie),
        assertGet("/products", cookie),
        assertGet("/users", cookie)
      ]);
    }
  });

  if (webBaseUrl) {
    for (const route of baseWebRoutes) {
      await runCheck(`WEB ${route}`, () => assertWebRoute(route));
    }
  } else {
    console.log("SKIP web routes: SMOKE_WEB_BASE_URL is not set.");
  }

  const scenario = await loadScenario();
  if (scenario) {
    await runScenarioChecks(scenario, cookie);
  }

  if (failures > 0) {
    console.error(`FAIL API smoke against ${apiBaseUrl}: ${failures} check(s) failed.`);
    process.exit(1);
  }

  console.log(`PASS API smoke against ${apiBaseUrl}`);
}

async function runScenarioChecks(scenario, cookie) {
  if (scenario.scenario === "mainline") {
    await runMainlineScenarioChecks(scenario, cookie);
    return;
  }

  if (scenario.scenario === "residual") {
    await runResidualScenarioChecks(scenario, cookie);
    return;
  }

  console.log(`SKIP scenario checks: unsupported scenario "${scenario.scenario}".`);
}

async function runMainlineScenarioChecks(scenario, cookie) {
  await assertOptionalScenarioGet(
    "mainline customer",
    scenario.customerId,
    `/customers/${scenario.customerId}`,
    cookie
  );
  await assertOptionalScenarioGet(
    "mainline application",
    scenario.applicationId,
    `/applications/${scenario.applicationId}`,
    cookie
  );
  await assertOptionalScenarioGet(
    "mainline vehicle",
    scenario.vehicleId,
    `/vehicles/${scenario.vehicleId}`,
    cookie
  );
  await assertOptionalScenarioGet(
    "mainline quote",
    scenario.quoteId,
    `/quotes/${scenario.quoteId}`,
    cookie
  );
  await assertOptionalScenarioGet(
    "mainline order",
    scenario.orderId,
    `/orders/${scenario.orderId}`,
    cookie
  );
  await assertOptionalScenarioGet(
    "mainline contract",
    scenario.contractId,
    `/contracts/${scenario.contractId}`,
    cookie
  );

  if (webBaseUrl) {
    for (const route of ["/applications", "/orders", "/contracts", "/vehicles"]) {
      await runCheck(`WEB mainline ${route}`, () => assertWebRoute(route));
    }
  }
}

async function runResidualScenarioChecks(scenario, cookie) {
  await assertOptionalScenarioGet(
    "residual vehicle",
    scenario.vehicleId,
    `/vehicles/${scenario.vehicleId}`,
    cookie
  );
  await assertOptionalScenarioGet(
    "residual curve",
    scenario.curveId,
    `/residual-market/curves/${scenario.curveId}`,
    cookie
  );
  await assertOptionalScenarioGet(
    "residual forecast",
    scenario.forecastId,
    `/residual-market/vehicle-forecasts/${scenario.forecastId}`,
    cookie
  );
  await assertOptionalScenarioGet(
    "residual valuation review",
    scenario.valuationReviewId,
    `/vehicle-valuation-reviews/${scenario.valuationReviewId}`,
    cookie
  );

  if (webBaseUrl) {
    for (const route of [
      "/residual-market",
      "/vehicle-valuation-reviews",
      "/reports/asset-profitability"
    ]) {
      await runCheck(`WEB residual ${route}`, () => assertWebRoute(route));
    }
  }
}

async function assertOptionalScenarioGet(label, id, endpoint, cookie) {
  if (!id) {
    console.log(`SKIP ${label}: id not present in scenario output.`);
    return;
  }

  await runCheck(`GET ${endpoint}`, () => assertGet(endpoint, cookie));
}

async function login() {
  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    body: JSON.stringify({ password, username }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${await response.text()}`);
  }

  const cookie = response.headers.get("set-cookie");
  if (!cookie) {
    throw new Error("Login did not return an auth cookie.");
  }

  return {
    cookie,
    status: response.status
  };
}

async function assertGet(endpoint, cookie) {
  const response = await fetch(`${apiBaseUrl}${endpoint}`, {
    headers: cookie ? { cookie } : undefined
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${await response.text()}`);
  }

  return { status: response.status };
}

async function assertWebRoute(route) {
  const response = await fetch(`${webBaseUrl}${route}`, {
    redirect: "manual"
  });

  if (response.status < 200 || response.status >= 400) {
    throw new Error(`HTTP ${response.status} ${await response.text()}`);
  }

  return { status: response.status };
}

async function runCheck(name, fn) {
  try {
    const result = await fn();
    const status = result?.status ? ` (${result.status})` : "";
    console.log(`PASS ${name}${status}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

async function loadScenario() {
  const scenarioFile = getScenarioFilePath();
  if (!scenarioFile) {
    return null;
  }

  if (!(await fileExists(scenarioFile))) {
    console.log(`SKIP scenario checks: ${scenarioFile} does not exist.`);
    return null;
  }

  const scenario = JSON.parse(await readFile(scenarioFile, "utf8"));
  console.log(`Loaded scenario file: ${scenarioFile}`);
  return scenario;
}

function getScenarioFilePath() {
  const file = args.scenarioFile ?? process.env.SMOKE_SCENARIO_FILE;
  if (file) {
    return path.resolve(file);
  }

  if (args.scenario) {
    return path.resolve(".tmp", "scenarios", `${args.scenario}.json`);
  }

  return null;
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const parsed = {
    scenario: null,
    scenarioFile: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--scenario") {
      parsed.scenario = argv[index + 1];
      index += 1;
    } else if (value === "--scenario-file") {
      parsed.scenarioFile = argv[index + 1];
      index += 1;
    }
  }

  return parsed;
}

function normalizeApiBaseUrl(value) {
  const stripped = stripTrailingSlash(value);
  if (stripped.endsWith("/api")) {
    return stripped;
  }
  return `${stripped}/api`;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

main().catch((error) => {
  console.error(`FAIL API smoke: ${error.message}`);
  process.exit(1);
});
