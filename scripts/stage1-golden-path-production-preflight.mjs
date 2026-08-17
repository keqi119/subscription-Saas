import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SENSITIVE_NAME = /(SECRET|KEY|CERT|PASSWORD|OPENID|TOKEN)/i;
const REQUIRED_SENSITIVE_KEYS = [
  "FADADA_APP_SECRET",
  "STAGE1_ACCEPTANCE_PAYER_OPENID",
  "WECHAT_OFFICIAL_ACCOUNT_APP_SECRET",
  "WECHAT_PAY_API_V3_KEY",
  "WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH"
];
const REQUIRED_PROVIDER_KEYS = [
  "FADADA_APP_ID",
  "WECHAT_OFFICIAL_ACCOUNT_APP_ID",
  "WECHAT_PAY_APP_ID",
  "WECHAT_PAY_MCH_ID",
  "WECHAT_PAY_MERCHANT_SERIAL_NO",
  "WECHAT_PAY_PLATFORM_CERT_PATH",
  "WECHAT_TEMPLATE_APPLICATION_PROGRESS",
  "WECHAT_TEMPLATE_CONTRACT_PENDING",
  "WECHAT_TEMPLATE_FINAL_PLAN_PENDING",
  "WECHAT_TEMPLATE_HANDOVER_PENDING",
  "WECHAT_TEMPLATE_PAYMENT_PENDING"
];

export function validateStage1GoldenPathPreflight(env) {
  const blockers = [];
  const add = (code, key, message) => blockers.push({ code, key, message });

  requireTrue(env, "SUBSCRIPTION_JOURNEY_ENABLED", "JOURNEY_DISABLED", add);
  requireTrue(env, "SUBSCRIPTION_JOURNEY_WORKER_ENABLED", "WORKER_DISABLED", add);
  if (
    !configured(env.SUBSCRIPTION_JOURNEY_ALLOWLIST_APPLICATION_IDS) &&
    !configured(env.SUBSCRIPTION_JOURNEY_ALLOWLIST_CUSTOMER_IDS)
  ) {
    add("ALLOWLIST_EMPTY", "SUBSCRIPTION_JOURNEY_ALLOWLIST_*", "At least one Journey acceptance allowlist must be non-empty.");
  }

  if (normalized(env.ESIGN_PROVIDER) !== "fadada") {
    add("ESIGN_PROVIDER_INVALID", "ESIGN_PROVIDER", "ESIGN_PROVIDER must be fadada.");
  }
  if (normalized(env.FADADA_ENV) !== "production") {
    add("FADADA_ENV_INVALID", "FADADA_ENV", "FADADA_ENV must be production.");
  }
  if (!isFadadaProductionUrl(env.FADADA_BASE_URL)) {
    add("FADADA_BASE_URL_INVALID", "FADADA_BASE_URL", "FADADA_BASE_URL must be the confirmed production endpoint.");
  }
  requireProductionUrl(env, "FADADA_SIGN_NOTIFY_URL", "FADADA_CALLBACK_URL_MISSING", add);
  requireProductionUrl(env, "FADADA_SIGN_RETURN_URL", "FADADA_RETURN_URL_MISSING", add);
  requireConfigured(env, "FADADA_TEST_CUSTOMER_ID", "FADADA_SIGNER_ID_MISSING", add);
  requireConfigured(env, "FADADA_TEST_LOCAL_CUSTOMER_ID", "TEST_CUSTOMER_ID_MISSING", add);
  requireConfigured(env, "STAGE1_ACCEPTANCE_CONTRACT_TEMPLATE_ID", "CONTRACT_TEMPLATE_ID_MISSING", add);

  requireTrue(env, "WECHAT_PAY_ENABLED", "WECHAT_PAY_DISABLED", add);
  if (
    normalized(env.PAYMENT_DEFAULT_CHANNEL) !== "wechat_jsapi" ||
    normalized(env.WECHAT_PAY_DEFAULT_CHANNEL) !== "wechat_jsapi"
  ) {
    add("WECHAT_TRADE_TYPE_INVALID", "PAYMENT_DEFAULT_CHANNEL", "The controlled payment channel must be WECHAT_JSAPI.");
  }
  if (!isProductionHttpsUrl(env.WECHAT_PAY_NOTIFY_URL)) {
    add("WECHAT_NOTIFY_URL_INVALID", "WECHAT_PAY_NOTIFY_URL", "WECHAT_PAY_NOTIFY_URL must be a production HTTPS callback.");
  }
  requireConfigured(env, "STAGE1_ACCEPTANCE_PAYER_OPENID", "PAYER_OPENID_MISSING", add);

  if (normalized(env.NOTIFICATION_PROVIDER) !== "wechat_official_account") {
    add("NOTIFICATION_PROVIDER_INVALID", "NOTIFICATION_PROVIDER", "NOTIFICATION_PROVIDER must be wechat_official_account.");
  }
  requireTrue(env, "NOTIFICATION_WECHAT_ENABLED", "WECHAT_NOTIFICATION_DISABLED", add);
  if (truthy(env.AUTO_DEBIT_ENABLED)) {
    add("AUTO_DEBIT_MUST_BE_DISABLED", "AUTO_DEBIT_ENABLED", "Delegated debit must stay disabled for this acceptance.");
  }
  if (normalized(env.PAYMENT_MANDATE_PROVIDER) !== "disabled") {
    add(
      "AUTO_DEBIT_PROVIDER_MUST_BE_DISABLED",
      "PAYMENT_MANDATE_PROVIDER",
      "Stage 1 requires the delegated debit provider to stay disabled."
    );
  }
  if (truthy(env.PAYMENT_MANDATE_MOCK_ENABLED)) {
    add(
      "AUTO_DEBIT_MOCK_MUST_BE_DISABLED",
      "PAYMENT_MANDATE_MOCK_ENABLED",
      "Stage 1 forbids delegated debit mock execution."
    );
  }

  requireConfigured(env, "STAGE1_ACCEPTANCE_TEST_VEHICLE_ID", "TEST_VEHICLE_ID_MISSING", add);
  requireConfigured(env, "STAGE1_ACCEPTANCE_TEST_APPLICATION_ID", "TEST_APPLICATION_ID_MISSING", add);
  requireTrue(
    env,
    "STAGE1_ACCEPTANCE_TEST_VEHICLE_CONFIRMED_NON_OPERATIONAL",
    "TEST_VEHICLE_NOT_CONFIRMED_NON_OPERATIONAL",
    add
  );
  const paymentLimit = positiveInteger(env.STAGE1_ACCEPTANCE_MAX_PAYMENT_FEN);
  const refundLimit = positiveInteger(env.STAGE1_ACCEPTANCE_MAX_REFUND_FEN);
  if (paymentLimit === null) {
    add("PAYMENT_LIMIT_INVALID", "STAGE1_ACCEPTANCE_MAX_PAYMENT_FEN", "A positive controlled payment limit is required.");
  }
  if (refundLimit === null) {
    add("REFUND_LIMIT_INVALID", "STAGE1_ACCEPTANCE_MAX_REFUND_FEN", "A positive controlled refund limit is required.");
  }
  if (paymentLimit !== null && refundLimit !== null && refundLimit > paymentLimit) {
    add("REFUND_LIMIT_EXCEEDS_PAYMENT", "STAGE1_ACCEPTANCE_MAX_REFUND_FEN", "The refund limit cannot exceed the payment limit.");
  }

  for (const key of REQUIRED_SENSITIVE_KEYS) {
    if (!configured(env[key])) {
      add("PROVIDER_CONFIGURATION_MISSING", key, `${key} must be configured.`);
    }
  }
  for (const key of REQUIRED_PROVIDER_KEYS) {
    if (!configured(env[key])) {
      add("PROVIDER_CONFIGURATION_MISSING", key, `${key} must be configured.`);
    }
  }

  return {
    blockers,
    ok: blockers.length === 0,
    summary: buildSafeSummary(env)
  };
}

export function validateProductionImageGoldenPathConfig(env) {
  const blockers = [];
  if (truthy(env.AUTO_DEBIT_ENABLED)) {
    blockers.push(blocker("AUTO_DEBIT_MUST_BE_DISABLED", "AUTO_DEBIT_ENABLED", "Production acceptance examples must keep auto debit disabled."));
  }
  if (normalized(env.PAYMENT_MANDATE_PROVIDER) !== "disabled") {
    blockers.push(
      blocker(
        "AUTO_DEBIT_PROVIDER_MUST_BE_DISABLED",
        "PAYMENT_MANDATE_PROVIDER",
        "Stage 1 requires the delegated debit provider to stay disabled."
      )
    );
  }
  if (truthy(env.PAYMENT_MANDATE_MOCK_ENABLED)) {
    blockers.push(
      blocker(
        "AUTO_DEBIT_MOCK_MUST_BE_DISABLED",
        "PAYMENT_MANDATE_MOCK_ENABLED",
        "Stage 1 forbids delegated debit mock execution."
      )
    );
  }
  if (!truthy(env.SUBSCRIPTION_JOURNEY_ENABLED)) return blockers;
  if (normalized(env.ESIGN_PROVIDER) !== "fadada") {
    blockers.push(blocker("ENABLED_ESIGN_PROVIDER_UNSAFE", "ESIGN_PROVIDER", "Enabled Journey requires fadada."));
  }
  if (normalized(env.FADADA_ENV) !== "production") {
    blockers.push(blocker("ENABLED_FADADA_ENV_UNSAFE", "FADADA_ENV", "Enabled Journey requires Fadada production."));
  }
  if (normalized(env.NOTIFICATION_PROVIDER) !== "wechat_official_account") {
    blockers.push(blocker("ENABLED_NOTIFICATION_PROVIDER_UNSAFE", "NOTIFICATION_PROVIDER", "Enabled Journey requires official-account notifications."));
  }
  if (
    !configured(env.SUBSCRIPTION_JOURNEY_ALLOWLIST_APPLICATION_IDS) &&
    !configured(env.SUBSCRIPTION_JOURNEY_ALLOWLIST_CUSTOMER_IDS)
  ) {
    blockers.push(blocker("ENABLED_ALLOWLIST_EMPTY", "SUBSCRIPTION_JOURNEY_ALLOWLIST_*", "Enabled Journey requires a non-empty allowlist."));
  }
  return blockers;
}

export async function checkReadOnlyHealth(env, transport = fetch) {
  const baseUrl = new URL(requiredValue(env.API_BASE_URL, "API_BASE_URL"));
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/health`;
  baseUrl.search = "";
  baseUrl.hash = "";
  if (!isProductionHttpsUrl(baseUrl.toString())) {
    throw new Error("API_BASE_URL must resolve to a production HTTPS health endpoint.");
  }
  const response = await transport(baseUrl, {
    headers: { accept: "application/json" },
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  return {
    endpoint: `${baseUrl.origin}${baseUrl.pathname}`,
    ok: response.ok,
    status: response.status
  };
}

export function parseEnvExample(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function checkProductionExamples() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = path.join(root, ".env.production.images.example");
  const composePath = path.join(root, "docker-compose.production.images.example.yml");
  const [envText, compose] = await Promise.all([
    readFile(envPath, "utf8"),
    readFile(composePath, "utf8")
  ]);
  const blockers = validateProductionImageGoldenPathConfig(parseEnvExample(envText));
  const requiredComposeKeys = [
    "AUTO_DEBIT_ENABLED",
    "PAYMENT_MANDATE_MOCK_ENABLED",
    "PAYMENT_MANDATE_PROVIDER",
    "ESIGN_PROVIDER",
    "FADADA_ENV",
    "NOTIFICATION_PROVIDER",
    "SUBSCRIPTION_JOURNEY_ALLOWLIST_APPLICATION_IDS",
    "SUBSCRIPTION_JOURNEY_ALLOWLIST_CUSTOMER_IDS",
    "SUBSCRIPTION_JOURNEY_ENABLED",
    "SUBSCRIPTION_JOURNEY_WORKER_ENABLED"
  ];
  for (const key of requiredComposeKeys) {
    if (!compose.includes(`${key}:`)) {
      blockers.push(blocker("COMPOSE_VARIABLE_MISSING", key, `${key} must be passed explicitly by the production image compose file.`));
    }
  }
  return blockers;
}

function buildSafeSummary(env) {
  const identifiers = {
    application: maskIdentifier(env.STAGE1_ACCEPTANCE_TEST_APPLICATION_ID),
    contractTemplate: maskIdentifier(env.STAGE1_ACCEPTANCE_CONTRACT_TEMPLATE_ID),
    customer: maskIdentifier(env.FADADA_TEST_LOCAL_CUSTOMER_ID),
    fadadaSigner: maskIdentifier(env.FADADA_TEST_CUSTOMER_ID),
    vehicle: maskIdentifier(env.STAGE1_ACCEPTANCE_TEST_VEHICLE_ID)
  };
  const sensitive = {};
  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_NAME.test(key)) sensitive[key] = configured(value) ? "configured" : "missing";
  }
  return {
    identifiers,
    runtime: {
      autoDebit: truthy(env.AUTO_DEBIT_ENABLED) ? "enabled" : "disabled",
      collectionMode: "active-payment-only",
      journey: truthy(env.SUBSCRIPTION_JOURNEY_ENABLED) ? "enabled" : "disabled",
      notificationProvider: normalized(env.NOTIFICATION_PROVIDER) === "wechat_official_account" ? "official-account" : "invalid",
      worker: truthy(env.SUBSCRIPTION_JOURNEY_WORKER_ENABLED) ? "enabled" : "disabled"
    },
    sensitive
  };
}

function maskIdentifier(value) {
  if (!configured(value)) return "missing";
  const text = String(value).trim();
  if (text.length <= 8) return "configured";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function requireTrue(env, key, code, add) {
  if (!truthy(env[key])) add(code, key, `${key} must be true.`);
}

function requireConfigured(env, key, code, add) {
  if (!configured(env[key])) add(code, key, `${key} must be configured.`);
}

function requireProductionUrl(env, key, code, add) {
  if (!isProductionHttpsUrl(env[key])) add(code, key, `${key} must be a production HTTPS URL.`);
}

function configured(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return Boolean(text) && !/^<CHANGE_ME/i.test(text) && !/^replace-with/i.test(text);
}

function truthy(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function normalized(value) {
  return String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function isFadadaProductionUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "textapi.fadada.com" &&
      url.pathname.replace(/\/+$/, "") === "/api2"
    );
  } catch {
    return false;
  }
}

function isProductionHttpsUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname) &&
      !url.hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

function blocker(code, key, message) {
  return { code, key, message };
}

function requiredValue(value, key) {
  if (!configured(value)) throw new Error(`${key} is required.`);
  return value.trim();
}

async function main() {
  if (process.argv.includes("--check-examples")) {
    const blockers = await checkProductionExamples();
    console.log(JSON.stringify({ blockers, ok: blockers.length === 0 }, null, 2));
    process.exitCode = blockers.length === 0 ? 0 : 1;
    return;
  }
  const validation = validateStage1GoldenPathPreflight(process.env);
  if (!validation.ok) {
    console.log(JSON.stringify(validation, null, 2));
    process.exitCode = 1;
    return;
  }
  const health = await checkReadOnlyHealth(process.env);
  const result = { ...validation, health };
  console.log(JSON.stringify(result, null, 2));
  if (!health.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message, ok: false }));
    process.exitCode = 1;
  });
}
