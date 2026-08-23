#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ENV_FILE = ".env.fadada.sandbox.local";
const DEFAULT_RESULT_FILE = ".tmp/fadada-smoke/upload-signurl-smoke-result.json";
const DEFAULT_TEST_PDF_FILE = ".tmp/fadada-smoke/test-contract.pdf";
const DEFAULT_TEST_PERSON_OPEN_ID = "subauto-sandbox-person-smoke-001";
const DEFAULT_DOC_TITLE = "SubAuto Fadada Sandbox Smoke Test";
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded;charset=UTF-8";
const MULTIPART_CONTENT_TYPE = "multipart/form-data;charset=utf8";
const PUBLIC_PARAM_KEYS = new Set(["app_id", "timestamp", "v", "msg_digest"]);
const SENSITIVE_KEYS = /secret|token|signurl|sign_url|download_url|viewpdf_url|customer_id|signature_id/i;

export async function runCli(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return;
  }

  const envFile = resolve(options.envFile ?? DEFAULT_ENV_FILE);
  const resultFile = resolve(options.resultFile ?? DEFAULT_RESULT_FILE);
  const env = loadEnvFile(envFile);
  const pdfBuffer = loadOrCreateTestPdf(env, options.pdfFile);
  const result = await runFadadaSandboxSmoke({ env, pdfBuffer });

  writeJson(resultFile, result);
  printSummary(result, resultFile);

  if (result.preflight.ok !== true || result.uploadDocs.status === "failed" || result.extSignValidation.status === "failed") {
    process.exitCode = 2;
  }
}

export async function runFadadaSandboxSmoke(input) {
  const now = input.now ?? (() => new Date());
  const env = input.env;
  const preflight = validatePreflight(env);
  const generatedAt = now().toISOString();
  const report = {
    accountRegister: { status: "skipped" },
    baseUrl: maskUrlOrigin(env.FADADA_BASE_URL),
    extSignValidation: { status: "skipped" },
    generatedAt,
    pdf: {
      contentType: "application/pdf",
      present: Boolean(input.pdfBuffer),
      sizeBytes: input.pdfBuffer?.length ?? 0
    },
    preflight,
    signUrl: { masked: "missing", present: false },
    uploadDocs: { status: "skipped" }
  };

  if (!preflight.ok) {
    return report;
  }

  const config = {
    appId: requiredEnvValue(env, "FADADA_APP_ID"),
    appSecret: requiredEnvValue(env, "FADADA_APP_SECRET"),
    baseUrl: normalizeBaseUrl(requiredEnvValue(env, "FADADA_BASE_URL")),
    version: env.FADADA_API_VERSION?.trim() || "2.0"
  };
  const transport = input.transport ?? defaultTransport;
  const timestamp = formatFadadaTimestamp(now());
  const contractId = buildSmokeId("contract", now());
  const transactionId = buildSmokeId("tx", now());
  let customerId = env.FADADA_TEST_CUSTOMER_ID?.trim();

  if (!customerId) {
    const openId = sanitizeOpenId(env.FADADA_TEST_PERSON_OPEN_ID?.trim() || DEFAULT_TEST_PERSON_OPEN_ID);
    const request = buildAccountRegisterRequest({
      ...config,
      openId,
      timestamp
    });
    const response = await sendRequest(request, transport);
    const raw = parseJsonObject(response.bodyText) ?? response.bodyText;
    const code = providerCode(raw);
    customerId = stringField(raw, ["data", "customer_id", "customerId"]);
    report.accountRegister = {
      code,
      customerIdMasked: maskMiddle(customerId),
      msg: providerMsg(raw),
      openIdMasked: maskMiddle(openId),
      status: isProviderSuccess(raw) && customerId ? "success" : "failed"
    };
    if (report.accountRegister.status !== "success") {
      report.blockers = ["account_register.api did not return a customer_id"];
      return report;
    }
  } else {
    report.accountRegister = {
      customerIdMasked: maskMiddle(customerId),
      status: "skipped-existing-customer-id"
    };
  }

  const uploadRequest = buildUploadDocsRequest({
    ...config,
    contractId,
    docTitle: DEFAULT_DOC_TITLE,
    timestamp
  });
  const uploadResponse = await sendRequest(uploadRequest, transport, {
    buffer: input.pdfBuffer,
    contentType: "application/pdf",
    fieldName: "file",
    fileName: "subauto-fadada-sandbox-smoke.pdf"
  });
  const uploadRaw = parseJsonObject(uploadResponse.bodyText) ?? uploadResponse.bodyText;
  const uploadSuccess = isProviderSuccess(uploadRaw);
  report.uploadDocs = {
    code: providerCode(uploadRaw),
    contractIdMasked: maskMiddle(contractId),
    msg: providerMsg(uploadRaw),
    status: uploadSuccess ? "success" : "failed"
  };
  if (!uploadSuccess) {
    report.blockers = ["uploaddocs.api failed"];
    return report;
  }

  const validity = positiveInt(env.FADADA_SIGN_URL_VALIDITY_MINUTES, 30);
  const quantity = positiveInt(env.FADADA_SIGN_URL_QUANTITY, 1);
  const signRequest = buildExtSignValidationRequest({
    ...config,
    contractId,
    customerId,
    notifyUrl: requiredEnvValue(env, "FADADA_SIGN_NOTIFY_URL"),
    quantity,
    returnUrl: requiredEnvValue(env, "FADADA_SIGN_RETURN_URL"),
    timestamp,
    transactionId,
    validity
  });
  const signResponse = await sendRequest(signRequest, transport);
  const signRaw = parseJsonObject(signResponse.bodyText) ?? signResponse.bodyText;
  const signUrl = extractSignUrl(signRaw);
  const signSuccess = isProviderSuccess(signRaw) && Boolean(signUrl);
  report.extSignValidation = {
    code: providerCode(signRaw),
    customerIdMasked: maskMiddle(customerId),
    msg: providerMsg(signRaw),
    status: signSuccess ? "success" : "failed",
    transactionIdMasked: maskMiddle(transactionId)
  };
  report.signUrl = {
    masked: signUrl ? maskUrl(signUrl) : "missing",
    present: Boolean(signUrl)
  };
  if (!signSuccess) {
    report.blockers = ["extsign_validation.api did not return a signUrl; customer may require real-name binding"];
  }

  return report;
}

export function validatePreflight(env) {
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
    "FADADA_PLATFORM_CUSTOMER_ID",
    "FADADA_PLATFORM_SIGNATURE_ID",
    "FADADA_AUTH_PERSON_CUSTOMER_ID",
    "FADADA_TEST_CUSTOMER_ID",
    "FADADA_TEST_PERSON_NAME",
    "FADADA_TEST_PERSON_ID_CARD_NO",
    "FADADA_TEST_PERSON_MOBILE",
    "FADADA_SIGN_NOTIFY_URL",
    "FADADA_SIGN_RETURN_URL",
    "FADADA_SIGN_URL_VALIDITY_MINUTES",
    "FADADA_SIGN_URL_QUANTITY",
    "FADADA_SANDBOX_SMOKE"
  ];

  for (const key of keys) {
    envStatus[key] = env[key]?.trim() ? "present" : "missing";
  }

  if ((env.ESIGN_PROVIDER ?? "").trim().toLowerCase() !== "fadada") {
    warnings.push("ESIGN_PROVIDER is not fadada; client-level smoke can still run with explicit Fadada env.");
  }
  if ((env.FADADA_ENV ?? "").trim().toLowerCase() !== "sandbox") {
    blockers.push("FADADA_ENV=sandbox is required");
  }
  if ((env.FADADA_ENABLED ?? "").trim().toLowerCase() !== "true") {
    blockers.push("FADADA_ENABLED=true is required");
  }
  if ((env.FADADA_SANDBOX_SMOKE ?? "").trim() !== "1") {
    blockers.push("FADADA_SANDBOX_SMOKE=1 is required");
  }
  for (const key of ["FADADA_BASE_URL", "FADADA_APP_ID", "FADADA_APP_SECRET", "FADADA_SIGN_NOTIFY_URL", "FADADA_SIGN_RETURN_URL"]) {
    if (!env[key]?.trim()) {
      blockers.push(`${key} is required`);
    }
  }
  if (env.FADADA_BASE_URL?.trim() && !isSandboxBaseUrl(env.FADADA_BASE_URL)) {
    blockers.push("FADADA_BASE_URL must be the Fadada sandbox/test API URL");
  }
  for (const key of ["FADADA_SIGN_NOTIFY_URL", "FADADA_SIGN_RETURN_URL"]) {
    const value = env[key]?.trim();
    if (value && !isSafeHttpsUrl(value)) {
      blockers.push(`${key} must be an https URL and must not point to localhost`);
    }
  }

  return {
    blockers,
    envStatus,
    ok: blockers.length === 0,
    requiresAccountRegister: !env.FADADA_TEST_CUSTOMER_ID?.trim(),
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

export function buildUploadDocsRequest(input) {
  return buildFadadaRequest({
    appId: input.appId,
    appSecret: input.appSecret,
    baseUrl: input.baseUrl,
    businessParams: {
      contract_id: input.contractId,
      doc_title: input.docTitle,
      doc_type: ".pdf"
    },
    contentType: MULTIPART_CONTENT_TYPE,
    endpoint: "uploaddocs.api",
    explicitSortString: input.contractId,
    timestamp: input.timestamp,
    version: input.version
  });
}

export function buildExtSignValidationRequest(input) {
  return buildFadadaRequest({
    appId: input.appId,
    appSecret: input.appSecret,
    baseUrl: input.baseUrl,
    businessParams: {
      contract_id: input.contractId,
      customer_id: input.customerId,
      doc_title: input.docTitle ?? DEFAULT_DOC_TITLE,
      notify_url: input.notifyUrl,
      quantity: input.quantity,
      return_url: input.returnUrl,
      transaction_id: input.transactionId,
      validity: input.validity
    },
    contentType: FORM_CONTENT_TYPE,
    endpoint: "extsign_validation.api",
    explicitMd5Seed: `${input.transactionId}${input.timestamp}${input.validity}${input.quantity}`,
    explicitSortString: input.customerId,
    timestamp: input.timestamp,
    version: input.version
  });
}

export function buildFadadaRequest(input) {
  const businessParams = stringifyParams(input.businessParams ?? {});
  const msgDigest = input.explicitMd5Seed
    ? buildFadadaMsgDigestFromParts({
        appId: input.appId,
        appSecret: input.appSecret,
        md5Seed: input.explicitMd5Seed,
        secretSortString: input.explicitSortString ?? ""
      })
    : buildFadadaMsgDigest({
        appId: input.appId,
        appSecret: input.appSecret,
        businessParams,
        explicitSortString: input.explicitSortString,
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
  const sortString = input.explicitSortString ?? sortBusinessParams(input.businessParams ?? {});
  return buildFadadaMsgDigestFromParts({
    appId: input.appId,
    appSecret: input.appSecret,
    md5Seed: input.timestamp,
    secretSortString: sortString
  });
}

export function buildFadadaMsgDigestFromParts(input) {
  return base64(sha1Upper(input.appId + md5Upper(input.md5Seed) + sha1Upper(input.appSecret + input.secretSortString)));
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

export function loadEnvFile(path) {
  return parseEnvText(readFileSync(path, "utf8"));
}

export function loadOrCreateTestPdf(env, pdfFile) {
  const configured = pdfFile ?? env.FADADA_TEST_PDF_PATH?.trim();
  if (configured) {
    const filePath = resolve(configured);
    const buffer = readFileSync(filePath);
    assertPdf(buffer, basename(filePath));
    return buffer;
  }

  const filePath = resolve(DEFAULT_TEST_PDF_FILE);
  const buffer = createTestPdf();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buffer);
  return buffer;
}

export function createTestPdf() {
  const content = "BT /F1 16 Tf 72 720 Td (SubAuto Fadada Sandbox Smoke Test - Not a real contract) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`
  ];
  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(chunks.join(""), "utf8"));
    chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(""), "utf8");
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push("0000000000 65535 f \n");
  for (const offset of offsets.slice(1)) {
    chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(""), "utf8");
}

export async function sendRequest(request, transport, file) {
  const transportRequest = buildTransportRequest(request, file);
  const response = await transport(transportRequest);
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

export function buildTransportRequest(request, file) {
  if (request.contentType === MULTIPART_CONTENT_TYPE) {
    const multipart = buildMultipartBody(request.params, file);
    return {
      body: multipart.body,
      headers: { "content-type": `multipart/form-data; boundary=${multipart.boundary}` },
      method: request.method,
      timeoutMs: 15000,
      url: request.url
    };
  }

  return {
    body: new URLSearchParams(request.params).toString(),
    headers: { "content-type": request.contentType },
    method: request.method,
    timeoutMs: 15000,
    url: request.url
  };
}

export function buildMultipartBody(params, file) {
  const boundary = `----subscription-saas-fadada-smoke-${randomUUID()}`;
  const chunks = [];
  for (const [key, value] of Object.entries(params)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${escapeMultipartName(key)}"\r\n\r\n`, "utf8"));
    chunks.push(Buffer.from(`${value}\r\n`, "utf8"));
  }
  if (file) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    chunks.push(Buffer.from(
      `Content-Disposition: form-data; name="${escapeMultipartName(file.fieldName ?? "file")}"; filename="${escapeMultipartName(file.fileName)}"\r\n`,
      "utf8"
    ));
    chunks.push(Buffer.from(`Content-Type: ${file.contentType}\r\n\r\n`, "utf8"));
    chunks.push(file.buffer);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(chunks), boundary };
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

function maskUrlOrigin(value) {
  if (!value) return "missing";
  try {
    return new URL(value).origin;
  } catch {
    return "present";
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--env-file") options.envFile = args[++index];
    else if (arg === "--result-file") options.resultFile = args[++index];
    else if (arg === "--pdf-file") options.pdfFile = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/fadada-sandbox-upload-signurl-smoke.mjs [options]

Options:
  --env-file <path>     Defaults to ${DEFAULT_ENV_FILE}
  --pdf-file <path>     Optional local non-sensitive PDF
  --result-file <path>  Defaults to ${DEFAULT_RESULT_FILE}
`);
}

function printSummary(result, resultFile) {
  console.log("Fadada sandbox upload/signUrl smoke summary:");
  console.log(`preflight=${result.preflight.ok ? "passed" : "blocked"}`);
  console.log(`account_register=${result.accountRegister.status}`);
  console.log(`uploaddocs=${result.uploadDocs.status}`);
  console.log(`extsign_validation=${result.extSignValidation.status}`);
  console.log(`signUrl=${result.signUrl.present ? "present" : "missing"}`);
  if (result.blockers?.length) {
    console.log(`blockers=${result.blockers.join("; ")}`);
  }
  console.log(`sanitized result saved to ${maskPath(resultFile)}`);
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitizeForOutput(data), null, 2)}\n`, "utf8");
}

export function sanitizeForOutput(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeForOutput);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        shouldMaskFieldValue(key, item) ? maskMiddle(item) : sanitizeForOutput(item)
      ])
    );
  }
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    return maskUrl(value);
  }
  return value;
}

function shouldMaskFieldValue(key, value) {
  return SENSITIVE_KEYS.test(key) &&
    typeof value === "string" &&
    !["missing", "present", "skipped", "success", "failed"].includes(value);
}

function maskPath(path) {
  return basename(path);
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

function isSandboxBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "testapi.fadada.com" && url.pathname.replace(/\/+$/, "") === "/api";
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

function stringifyParams(params) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)])
  );
}

function assertPdf(buffer, fileName) {
  if (!fileName.toLowerCase().endsWith(".pdf") || !buffer.subarray(0, 5).equals(Buffer.from("%PDF-", "utf8"))) {
    throw new Error("FADADA_SMOKE_TEST_PDF_INVALID: test file must be a PDF");
  }
  if (buffer.length > 20 * 1024 * 1024) {
    throw new Error("FADADA_SMOKE_TEST_PDF_TOO_LARGE: test PDF must be <=20MB");
  }
}

function requiredEnvValue(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildSmokeId(prefix, now) {
  const date = formatFadadaTimestamp(now).slice(0, 8);
  return `SUBAUTO_${prefix.toUpperCase()}_${date}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function sanitizeOpenId(value) {
  const sanitized = value.replace(/['!<>^丨%/&@?*~:\-\s]/g, "_").slice(0, 64);
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
  return undefined;
}

function extractSignUrl(raw) {
  const direct = stringField(raw, ["sign_url", "signUrl", "url"]);
  if (direct) return direct;
  const data = raw && typeof raw === "object" ? raw.data : undefined;
  if (typeof data === "string" && /^https?:\/\//i.test(data)) return data;
  if (data && typeof data === "object") return stringField(data, ["sign_url", "signUrl", "url"]);
  return undefined;
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

function escapeMultipartName(value) {
  return value.replace(/["\r\n]/g, "_");
}

export function isMainModule(importMetaUrl, argvPath) {
  if (!argvPath) return false;
  return normalizeModulePath(fileURLToPath(importMetaUrl)) === normalizeModulePath(argvPath);
}

function normalizeModulePath(value) {
  const normalized = value.replace(/\\/g, "/");
  if (/^\/?[A-Za-z]:\//.test(normalized)) {
    return normalized.replace(/^\//, "").toLowerCase();
  }
  return resolve(value).replace(/\\/g, "/");
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
