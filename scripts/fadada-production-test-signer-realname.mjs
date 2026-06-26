#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_ENV_FILE = ".env.fadada.production.local";
const DEFAULT_STATE_FILE = ".tmp/fadada/test-signer-realname/latest.json";
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded;charset=UTF-8";
const DEFAULT_TEST_PERSON_OPEN_ID = "subauto-production-smoke-person-001";
const PUBLIC_PARAM_KEYS = new Set(["app_id", "timestamp", "v", "msg_digest"]);
const SENSITIVE_KEYS = /secret|token|signurl|sign_url|download_url|viewpdf_url|verifyurl|verify_url|url|customer_id|signature_id|id_card|ident_no|mobile|name/i;
const REAL_CALL_GATE_MESSAGE =
  "Fadada production-host signer real-name prep requires FADADA_ENABLED=true, FADADA_PRODUCTION_SMOKE=1 and FADADA_TEST_SIGNER_REALNAME_PREP=1.";

export async function runCli(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return;
  }

  const envFile = resolve(options.envFile ?? DEFAULT_ENV_FILE);
  const stateFile = resolve(options.stateFile ?? DEFAULT_STATE_FILE);
  const envLoad = loadEnvFileIfExists(envFile);
  const latestState = options.mode === "status" ? loadStateIfExists(stateFile) : undefined;
  const result = await runFadadaProductionTestSignerRealname({
    env: envLoad.env,
    envFile,
    envFileExists: envLoad.exists,
    latestState,
    mode: options.mode
  });

  if (options.mode === "prepare" && result.prepareState) {
    writeJson(stateFile, result.prepareState);
  }

  printSummary(result, stateFile);

  if (options.mode !== "preflight" && !result.ok) {
    process.exitCode = 2;
  }
}

export async function runFadadaProductionTestSignerRealname(input) {
  const mode = input.mode ?? "preflight";
  const now = input.now ?? (() => new Date());
  const env = input.env ?? {};
  const envFileSafety = checkEnvFileSafety(input.envFile ?? DEFAULT_ENV_FILE, input.envFileExists ?? true);
  const preflight = validateProductionPreflight(env, {
    envFileSafety,
    mode,
    state: input.latestState
  });
  const report = {
    accountRegister: { status: "skipped" },
    baseUrl: maskUrlOrigin(env.FADADA_BASE_URL),
    blockers: preflight.blockers,
    envFileSafety,
    generatedAt: now().toISOString(),
    mode,
    ok: mode === "preflight" ? true : preflight.ok,
    personVerifyUrl: { status: "skipped" },
    preflight,
    statusQuery: { status: "skipped" },
    verifyUrl: { masked: "missing", present: false }
  };

  if (mode === "preflight") {
    return withSanitized(report);
  }
  if (!preflight.ok) {
    return withSanitized({
      ...report,
      blockers: preflight.blockers,
      ok: false
    });
  }

  const config = {
    appId: requiredEnvValue(env, "FADADA_APP_ID"),
    appSecret: requiredEnvValue(env, "FADADA_APP_SECRET"),
    baseUrl: normalizeBaseUrl(requiredEnvValue(env, "FADADA_BASE_URL")),
    version: env.FADADA_API_VERSION?.trim() || "2.0"
  };
  const timestamp = formatFadadaTimestamp(now());
  const transport = input.transport ?? defaultTransport;

  if (mode === "status") {
    const statusResult = await runStatusMode({
      config,
      env,
      latestState: input.latestState,
      timestamp,
      transport
    });
    return withSanitized({
      ...report,
      ...statusResult,
      ok: statusResult.statusQuery.status === "success"
    });
  }

  const prepareResult = await runPrepareMode({
    config,
    env,
    timestamp,
    transport
  });
  return withSanitized({
    ...report,
    ...prepareResult,
    ok: prepareResult.personVerifyUrl.status === "success"
  });
}

async function runPrepareMode(input) {
  const openId = sanitizeOpenId(input.env.FADADA_TEST_PERSON_OPEN_ID?.trim() || DEFAULT_TEST_PERSON_OPEN_ID);
  const accountRequest = buildAccountRegisterRequest({
    ...input.config,
    openId,
    timestamp: input.timestamp
  });
  const accountResponse = await sendRequest(accountRequest, input.transport);
  const accountRaw = parseJsonObject(accountResponse.bodyText) ?? accountResponse.bodyText;
  const customerId = stringField(accountRaw, ["data", "customer_id", "customerId"]);
  const accountRegister = {
    code: providerCode(accountRaw),
    customerIdMasked: maskMiddle(customerId),
    msg: providerMsg(accountRaw),
    openIdMasked: maskMiddle(openId),
    status: isProviderSuccess(accountRaw) && customerId ? "success" : "failed"
  };

  if (accountRegister.status !== "success") {
    return {
      accountRegister,
      blockers: ["account_register.api did not return a customer_id"],
      personVerifyUrl: { status: "skipped" },
      verifyUrl: { masked: "missing", present: false }
    };
  }

  const verifyRequest = buildPersonVerifyUrlRequest({
    ...input.config,
    customerId,
    idCardNo: requiredEnvValue(input.env, "FADADA_TEST_PERSON_ID_CARD_NO"),
    mobile: requiredEnvValue(input.env, "FADADA_TEST_PERSON_MOBILE"),
    name: requiredEnvValue(input.env, "FADADA_TEST_PERSON_NAME"),
    notifyUrl: requiredEnvValue(input.env, "FADADA_VERIFY_NOTIFY_URL"),
    option: input.env.FADADA_VERIFY_OPTION?.trim() || "add",
    pageModify: input.env.FADADA_VERIFY_PAGE_MODIFY?.trim() || "1",
    returnUrl: requiredEnvValue(input.env, "FADADA_VERIFY_RETURN_URL"),
    timestamp: input.timestamp,
    verifiedWay: input.env.FADADA_PERSON_VERIFY_WAY?.trim() || "1"
  });
  const verifyResponse = await sendRequest(verifyRequest, input.transport);
  const verifyRaw = parseJsonObject(verifyResponse.bodyText) ?? verifyResponse.bodyText;
  const verifyData = objectField(verifyRaw, "data");
  const encodedVerifyUrl = typeof verifyData?.url === "string" ? verifyData.url : stringField(verifyRaw, ["url"]);
  const verifyUrl = decodeFadadaUrl(encodedVerifyUrl);
  const transactionNo = typeof verifyData?.transactionNo === "string"
    ? verifyData.transactionNo
    : stringField(verifyRaw, ["transactionNo", "transaction_no"]);
  const personVerifyUrl = {
    code: providerCode(verifyRaw),
    customerIdMasked: maskMiddle(customerId),
    msg: providerMsg(verifyRaw),
    status: isProviderSuccess(verifyRaw) && verifyUrl ? "success" : "failed",
    transactionNoMasked: maskMiddle(transactionNo)
  };
  const verifyUrlResult = {
    masked: verifyUrl ? maskUrl(verifyUrl) : "missing",
    present: Boolean(verifyUrl)
  };

  return {
    accountRegister,
    blockers: personVerifyUrl.status === "success" ? undefined : ["get_person_verify_url.api did not return a verification URL"],
    personVerifyUrl,
    prepareState: {
      createdAt: new Date().toISOString(),
      customerId,
      openId,
      transactionNo,
      verifyUrl
    },
    verifyUrl: verifyUrlResult
  };
}

async function runStatusMode(input) {
  const state = input.latestState ?? {};
  const verifiedSerialNo = input.env.FADADA_TEST_PERSON_VERIFY_SERIALNO?.trim() || stringField(state, ["transactionNo"]);
  const customerId = input.env.FADADA_TEST_CUSTOMER_ID?.trim() || stringField(state, ["customerId"]);

  if (!verifiedSerialNo) {
    return {
      blockers: ["status mode requires transactionNo from .tmp state or FADADA_TEST_PERSON_VERIFY_SERIALNO"],
      ok: false,
      statusQuery: { status: "skipped" }
    };
  }

  const statusRequest = buildFindPersonCertInfoRequest({
    ...input.config,
    timestamp: input.timestamp,
    verifiedSerialNo
  });
  const statusResponse = await sendRequest(statusRequest, input.transport);
  const statusRaw = parseJsonObject(statusResponse.bodyText) ?? statusResponse.bodyText;
  const realNameStatus = stringField(statusRaw, ["status", "certStatus", "cert_status", "realNameStatus"]);

  return {
    statusQuery: {
      code: providerCode(statusRaw),
      customerIdMasked: maskMiddle(customerId),
      msg: providerMsg(statusRaw),
      realNameStatus,
      status: isProviderSuccess(statusRaw) ? "success" : "failed",
      transactionNoMasked: maskMiddle(verifiedSerialNo)
    }
  };
}

export function validateProductionPreflight(env, options = {}) {
  const blockers = [];
  const warnings = [];
  const envStatus = {};
  const keys = [
    "ESIGN_PROVIDER",
    "FADADA_ENV",
    "FADADA_BASE_URL",
    "FADADA_APP_ID",
    "FADADA_APP_SECRET",
    "FADADA_API_VERSION",
    "FADADA_ENABLED",
    "FADADA_PRODUCTION_SMOKE",
    "FADADA_TEST_SIGNER_REALNAME_PREP",
    "FADADA_PLATFORM_CUSTOMER_ID",
    "FADADA_PLATFORM_SIGNATURE_ID",
    "FADADA_SIGN_NOTIFY_URL",
    "FADADA_SIGN_RETURN_URL",
    "FADADA_VERIFY_NOTIFY_URL",
    "FADADA_VERIFY_RETURN_URL",
    "FADADA_TEST_PERSON_OPEN_ID",
    "FADADA_TEST_PERSON_NAME",
    "FADADA_TEST_PERSON_ID_CARD_NO",
    "FADADA_TEST_PERSON_MOBILE",
    "FADADA_TEST_CUSTOMER_ID",
    "FADADA_TEST_PERSON_VERIFY_SERIALNO"
  ];

  for (const key of keys) {
    envStatus[key] = env[key]?.trim() ? "present" : "missing";
  }

  const envFileSafety = options.envFileSafety ?? { ignored: true, tracked: false };
  if (!envFileSafety.exists) {
    blockers.push("env file is missing");
  } else {
    if (envFileSafety.tracked) {
      blockers.push(".env.fadada.production.local must not be tracked by Git");
    }
    if (!envFileSafety.ignored) {
      blockers.push(".env.fadada.production.local must be ignored by Git");
    }
  }

  if ((env.ESIGN_PROVIDER ?? "").trim().toLowerCase() !== "fadada") {
    warnings.push("ESIGN_PROVIDER is not fadada; client-level real-name prep can still run with explicit Fadada env.");
  }
  if ((env.FADADA_ENV ?? "").trim().toLowerCase() !== "production") {
    blockers.push("FADADA_ENV=production is required");
  }
  if ((env.FADADA_ENABLED ?? "").trim().toLowerCase() !== "true") {
    blockers.push("FADADA_ENABLED=true is required");
  }
  if ((env.FADADA_PRODUCTION_SMOKE ?? "").trim() !== "1") {
    blockers.push("FADADA_PRODUCTION_SMOKE=1 is required");
  }
  if ((env.FADADA_TEST_SIGNER_REALNAME_PREP ?? "").trim() !== "1") {
    blockers.push("FADADA_TEST_SIGNER_REALNAME_PREP=1 is required");
  }
  for (const key of ["FADADA_BASE_URL", "FADADA_APP_ID", "FADADA_APP_SECRET"]) {
    if (!env[key]?.trim()) {
      blockers.push(`${key} is required`);
    }
  }
  if (env.FADADA_BASE_URL?.trim() && !isProductionBaseUrl(env.FADADA_BASE_URL)) {
    blockers.push("FADADA_BASE_URL must be the confirmed Fadada production API URL");
  }

  if (options.mode === "prepare" || options.mode === undefined) {
    for (const key of ["FADADA_TEST_PERSON_OPEN_ID", "FADADA_TEST_PERSON_NAME", "FADADA_TEST_PERSON_ID_CARD_NO", "FADADA_TEST_PERSON_MOBILE", "FADADA_VERIFY_NOTIFY_URL", "FADADA_VERIFY_RETURN_URL"]) {
      if (!env[key]?.trim()) {
        blockers.push(`${key} is required`);
      }
    }
    for (const key of ["FADADA_VERIFY_NOTIFY_URL", "FADADA_VERIFY_RETURN_URL"]) {
      const value = env[key]?.trim();
      if (value && !isSafeHttpsUrl(value)) {
        blockers.push(`${key} must be an https URL and must not point to localhost`);
      }
    }
  }

  if (options.mode === "status") {
    const state = options.state ?? {};
    if (!env.FADADA_TEST_PERSON_VERIFY_SERIALNO?.trim() && !stringField(state, ["transactionNo"])) {
      blockers.push("status mode requires transactionNo from .tmp state or FADADA_TEST_PERSON_VERIFY_SERIALNO");
    }
  }

  return {
    blockers,
    envStatus,
    gateMessage: blockers.length ? REAL_CALL_GATE_MESSAGE : undefined,
    ok: blockers.length === 0,
    warnings
  };
}

export function buildAccountRegisterRequest(input) {
  return buildFadadaRequest({
    appId: input.appId,
    appSecret: input.appSecret,
    baseUrl: input.baseUrl,
    businessParams: {
      account_type: "1",
      open_id: input.openId
    },
    contentType: FORM_CONTENT_TYPE,
    endpoint: "account_register.api",
    timestamp: input.timestamp,
    version: input.version
  });
}

export function buildPersonVerifyUrlRequest(input) {
  return buildFadadaRequest({
    appId: input.appId,
    appSecret: input.appSecret,
    baseUrl: input.baseUrl,
    businessParams: {
      cert_flag: "1",
      customer_id: input.customerId,
      customer_ident_no: input.idCardNo,
      customer_ident_type: "0",
      customer_name: input.name,
      mobile: input.mobile,
      notify_url: input.notifyUrl,
      option: input.option ?? "add",
      page_modify: input.pageModify ?? "1",
      return_url: input.returnUrl,
      verified_way: input.verifiedWay ?? "1"
    },
    contentType: FORM_CONTENT_TYPE,
    endpoint: "get_person_verify_url.api",
    timestamp: input.timestamp,
    version: input.version
  });
}

export function buildFindPersonCertInfoRequest(input) {
  return buildFadadaRequest({
    appId: input.appId,
    appSecret: input.appSecret,
    baseUrl: input.baseUrl,
    businessParams: {
      verified_serialno: input.verifiedSerialNo
    },
    contentType: FORM_CONTENT_TYPE,
    endpoint: "find_personCertInfo.api",
    timestamp: input.timestamp,
    version: input.version
  });
}

export function buildFadadaRequest(input) {
  const businessParams = stringifyParams(input.businessParams ?? {});
  const msgDigest = buildFadadaMsgDigest({
    appId: input.appId,
    appSecret: input.appSecret,
    businessParams,
    timestamp: input.timestamp
  });

  return {
    contentType: input.contentType,
    endpoint: input.endpoint,
    method: "POST",
    params: {
      ...businessParams,
      app_id: input.appId,
      msg_digest: msgDigest,
      timestamp: input.timestamp,
      v: input.version
    },
    url: `${normalizeBaseUrl(input.baseUrl)}${input.endpoint}`
  };
}

export function buildFadadaMsgDigest(input) {
  const sortString = sortBusinessParams(input.businessParams ?? {});
  return base64(sha1Upper(input.appId + md5Upper(input.timestamp) + sha1Upper(input.appSecret + sortString)));
}

export function md5Upper(input) {
  return createHash("md5").update(input, "utf8").digest("hex").toUpperCase();
}

export function sha1Upper(input) {
  return createHash("sha1").update(input, "utf8").digest("hex").toUpperCase();
}

export function base64(input) {
  return Buffer.from(input, "utf8").toString("base64");
}

export function sortBusinessParams(params) {
  return Object.entries(params)
    .filter(([key, value]) => !PUBLIC_PARAM_KEYS.has(key) && value !== null && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([, value]) => String(value))
    .join("");
}

export function formatFadadaTimestamp(date) {
  const parts = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  ];
  return `${parts[0]}${parts.slice(1).map((part) => String(part).padStart(2, "0")).join("")}`;
}

export function decodeFadadaUrl(value) {
  if (!value) return undefined;
  try {
    return Buffer.from(decodeURIComponent(value), "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

export function parseEnvText(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    const value = stripOptionalQuotes(line.slice(index + 1).trim());
    env[key] = value;
  }
  return env;
}

export function loadEnvFileIfExists(path) {
  if (!existsSync(path)) {
    return { env: {}, exists: false };
  }
  return { env: parseEnvText(readFileSync(path, "utf8")), exists: true };
}

export function loadStateIfExists(path) {
  if (!existsSync(path)) {
    return undefined;
  }
  return parseJsonObject(readFileSync(path, "utf8"));
}

export async function sendRequest(request, transport) {
  const response = await transport(buildTransportRequest(request));
  return {
    bodyText: response.bodyText ?? response.bodyBuffer?.toString("utf8") ?? "",
    headers: response.headers ?? {},
    status: response.status
  };
}

export async function defaultTransport(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      body: request.body,
      headers: request.headers,
      method: request.method,
      signal: controller.signal
    });
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      bodyText: await response.text(),
      headers,
      status: response.status
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function buildTransportRequest(request) {
  return {
    body: new URLSearchParams(request.params).toString(),
    headers: { "content-type": request.contentType },
    method: request.method,
    timeoutMs: 15000,
    url: request.url
  };
}

export function checkEnvFileSafety(envFile, exists = existsSync(envFile)) {
  const relativePath = relative(process.cwd(), resolve(envFile));
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", relativePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).status === 0;
  const ignore = spawnSync("git", ["check-ignore", "-v", relativePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  return {
    exists,
    ignored: ignore.status === 0,
    tracked
  };
}

export function maskMiddle(value) {
  if (!value) return "missing";
  const text = String(value);
  if (text.length < 9) return "present";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

export function maskUrl(value) {
  if (!value) return "missing";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname ? "/..." : ""}`;
  } catch {
    return "present";
  }
}

export function sanitizeForOutput(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeForOutput);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        shouldMaskFieldValue(key, item) ? maskSensitiveValue(key, item) : sanitizeForOutput(item)
      ])
    );
  }
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    return maskUrl(value);
  }
  return value;
}

function withSanitized(report) {
  return {
    ...report,
    sanitized: sanitizeForOutput(report)
  };
}

function parseArgs(args) {
  const options = { mode: "preflight" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--mode") options.mode = parseMode(args[++index]);
    else if (arg === "--env-file") options.envFile = args[++index];
    else if (arg === "--state-file") options.stateFile = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parseMode(value) {
  if (["preflight", "prepare", "status"].includes(value)) {
    return value;
  }
  throw new Error(`Unknown mode: ${value}`);
}

function printHelp() {
  console.log(`Usage: node scripts/fadada-production-test-signer-realname.mjs --mode <preflight|prepare|status> [options]

Options:
  --env-file <path>    Defaults to ${DEFAULT_ENV_FILE}
  --state-file <path>  Defaults to ${DEFAULT_STATE_FILE}
`);
}

function printSummary(result, stateFile) {
  console.log("Fadada production test signer real-name prep summary:");
  console.log(`mode=${result.mode}`);
  console.log(`preflight=${result.preflight.ok ? "passed" : "blocked"}`);
  console.log(`account_register=${result.accountRegister.status}`);
  console.log(`get_person_verify_url=${result.personVerifyUrl.status}`);
  console.log(`status=${result.statusQuery.status}`);
  console.log(`verifyUrl=${result.verifyUrl.present ? "present" : "missing"}`);
  if (result.prepareState) {
    console.log(`full customer_id and verify URL saved to ${basename(stateFile)}; do not commit this file`);
  }
  if (result.blockers?.length) {
    console.log(`blockers=${result.blockers.join("; ")}`);
  }
  if (result.preflight.gateMessage) {
    console.log(result.preflight.gateMessage);
  }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function shouldMaskFieldValue(key, value) {
  return SENSITIVE_KEYS.test(key) &&
    typeof value === "string" &&
    !["missing", "present", "skipped", "success", "failed"].includes(value);
}

function maskSensitiveValue(key, value) {
  return /url/i.test(key) ? maskUrl(value) : maskMiddle(value);
}

function stripOptionalQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeBaseUrl(value) {
  return `${value.replace(/\/+$/, "")}/`;
}

function isProductionBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "textapi.fadada.com" && url.pathname.replace(/\/+$/, "") === "/api2";
  } catch {
    return false;
  }
}

function isSafeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function maskUrlOrigin(value) {
  if (!value) return "missing";
  try {
    return new URL(value).origin;
  } catch {
    return "present";
  }
}

function stringifyParams(params) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)])
  );
}

function requiredEnvValue(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function sanitizeOpenId(value) {
  const sanitized = value.replace(/['!<>^%/&@?*~:\-\s\u4e28]/g, "_").slice(0, 64);
  return sanitized || DEFAULT_TEST_PERSON_OPEN_ID;
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringField(raw, keys) {
  if (!raw || typeof raw !== "object") return undefined;
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const data = raw.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const nested = stringField(data, keys);
    if (nested) return nested;
  }
  for (const value of Object.values(raw)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = stringField(value, keys);
      if (nested) return nested;
    }
  }
  return undefined;
}

function objectField(raw, key) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function providerCode(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw.code ?? raw.result_code ?? raw.result;
  return value === undefined || value === null ? undefined : String(value);
}

function providerMsg(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw.msg ?? raw.message ?? raw.result_desc;
  return value === undefined || value === null ? undefined : String(value);
}

function isProviderSuccess(raw) {
  const code = providerCode(raw);
  return code === "1" || code === "200" || code === "success";
}

export function isMainModule(importMetaUrl, argvPath) {
  if (!argvPath) return false;
  return fileURLToPath(importMetaUrl) === resolve(argvPath);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
