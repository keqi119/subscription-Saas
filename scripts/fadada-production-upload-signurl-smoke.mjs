#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_ENV_FILE = ".env.fadada.production.local";
const DEFAULT_RESULT_FILE = ".tmp/fadada/upload-signurl-smoke/latest.json";
const DEFAULT_TEST_PDF_FILE = ".tmp/fadada/upload-signurl-smoke/test-contract.pdf";
const DEFAULT_DOC_TITLE = "SubAuto Fadada Production Host Smoke Test";
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded;charset=UTF-8";
const MULTIPART_CONTENT_TYPE = "multipart/form-data;charset=utf8";
const PUBLIC_PARAM_KEYS = new Set(["app_id", "timestamp", "v", "msg_digest"]);
const SENSITIVE_KEYS = /secret|token|signurl|sign_url|download_url|viewpdf_url|verifyurl|verify_url|url|customer_id|signature_id/i;
const REAL_CALL_GATE_MESSAGE =
  "Fadada production-host upload/signUrl smoke requires FADADA_ENABLED=true, FADADA_PRODUCTION_SMOKE=1 and FADADA_UPLOAD_SIGNURL_SMOKE=1.";

export async function runCli(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return;
  }

  const envFile = resolve(options.envFile ?? DEFAULT_ENV_FILE);
  const resultFile = resolve(options.resultFile ?? DEFAULT_RESULT_FILE);
  const envLoad = loadEnvFileIfExists(envFile);
  const result = await runFadadaProductionUploadSignUrlSmoke({
    env: envLoad.env,
    envFile,
    envFileExists: envLoad.exists,
    mode: options.mode,
    resultFile,
    testPdfFile: options.pdfFile ? resolve(options.pdfFile) : resolve(DEFAULT_TEST_PDF_FILE)
  });

  if (options.mode === "run" && result.diagnosticState) {
    writeJson(resultFile, result.diagnosticState);
  }

  printSummary(result, resultFile);

  if (options.mode !== "preflight" && !result.ok) {
    process.exitCode = 2;
  }
}

export async function runFadadaProductionUploadSignUrlSmoke(input) {
  const mode = input.mode ?? "run";
  const now = input.now ?? (() => new Date());
  const env = input.env ?? {};
  const envFileSafety = checkEnvFileSafety(input.envFile ?? DEFAULT_ENV_FILE, input.envFileExists ?? true);
  const preflight = validatePreflight(env, { envFileSafety });
  const report = {
    baseUrl: maskUrlOrigin(env.FADADA_BASE_URL),
    blockers: preflight.blockers,
    envFileSafety,
    extSignValidation: { status: "skipped" },
    generatedAt: now().toISOString(),
    mode,
    ok: mode === "preflight" ? true : preflight.ok,
    pdf: { contentType: "application/pdf", present: false, sizeBytes: 0 },
    preflight,
    signUrl: { masked: "missing", present: false },
    uploadDocs: { status: "skipped" }
  };

  if (mode === "preflight") {
    return withSanitized(report);
  }
  if (!preflight.ok) {
    return withSanitized({
      ...report,
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
  const pdfBuffer = input.pdfBuffer ?? loadOrCreateTestPdf(input.testPdfFile ?? DEFAULT_TEST_PDF_FILE);
  const contractId = buildSmokeId("contract", now());
  const transactionId = buildSmokeId("tx", now());
  const customerId = requiredEnvValue(env, "FADADA_TEST_CUSTOMER_ID");

  const uploadRequest = buildUploadDocsRequest({
    ...config,
    contractId,
    docTitle: DEFAULT_DOC_TITLE,
    timestamp
  });
  const uploadFile = {
    buffer: pdfBuffer,
    contentType: "application/pdf",
    fieldName: "file",
    fileName: "subauto-fadada-production-host-smoke.pdf"
  };
  const diagnosticBase = {
    contractId,
    createdAt: new Date().toISOString(),
    provider: {},
    requests: {
      uploadDocs: buildRequestDiagnostic(uploadRequest, uploadFile)
    },
    transactionId
  };
  const uploadResponse = await sendRequest(uploadRequest, transport, uploadFile);
  const uploadRaw = parseJsonObject(uploadResponse.bodyText) ?? uploadResponse.bodyText;
  const uploadSuccess = isProviderSuccess(uploadRaw);
  const uploadDocs = {
    code: providerCode(uploadRaw),
    contractIdMasked: maskMiddle(contractId),
    msg: providerMsg(uploadRaw),
    status: uploadSuccess ? "success" : "failed"
  };
  const afterUpload = {
    ...report,
    pdf: {
      contentType: "application/pdf",
      present: true,
      sizeBytes: pdfBuffer.length
    },
    uploadDocs
  };
  if (!uploadSuccess) {
    return withSanitized({
      ...afterUpload,
      blockers: ["uploaddocs.api failed"],
      diagnosticState: {
        ...diagnosticBase,
        provider: {
          uploadDocs: buildProviderDiagnostic(uploadRaw, uploadResponse)
        }
      },
      ok: false
    });
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
  const diagnosticWithSignRequest = {
    ...diagnosticBase,
    provider: {
      uploadDocs: buildProviderDiagnostic(uploadRaw, uploadResponse)
    },
    requests: {
      ...diagnosticBase.requests,
      extSignValidation: buildRequestDiagnostic(signRequest)
    }
  };
  const signResponse = await sendRequest(signRequest, transport);
  const signRaw = parseJsonObject(signResponse.bodyText) ?? signResponse.bodyText;
  const signUrl = extractSignUrl(signRaw);
  const signSuccess = isProviderSuccess(signRaw) && Boolean(signUrl);
  const extSignValidation = {
    code: providerCode(signRaw),
    customerIdMasked: maskMiddle(customerId),
    msg: providerMsg(signRaw),
    status: signSuccess ? "success" : "failed",
    transactionIdMasked: maskMiddle(transactionId)
  };
  const signUrlResult = {
    masked: signUrl ? maskUrl(signUrl) : "missing",
    present: Boolean(signUrl)
  };
  const state = signSuccess
    ? {
        contractId,
        createdAt: new Date().toISOString(),
        extSignValidation: sanitizeForOutput(extSignValidation),
        signUrl,
        transactionId,
        uploadDocs: sanitizeForOutput(uploadDocs)
      }
    : undefined;
  const diagnosticState = {
    ...diagnosticWithSignRequest,
    provider: {
      ...diagnosticWithSignRequest.provider,
      extSignValidation: buildProviderDiagnostic(signRaw, signResponse)
    },
    signUrl: signSuccess ? signUrl : undefined
  };

  return withSanitized({
    ...afterUpload,
    blockers: signSuccess ? undefined : ["extsign_validation.api did not return a signUrl"],
    extSignValidation,
    ok: signSuccess,
    signUrl: signUrlResult,
    diagnosticState,
    state
  });
}

export function validatePreflight(env, options = {}) {
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
    "FADADA_UPLOAD_SIGNURL_SMOKE",
    "FADADA_PLATFORM_CUSTOMER_ID",
    "FADADA_PLATFORM_SIGNATURE_ID",
    "FADADA_TEST_CUSTOMER_ID",
    "FADADA_SIGN_NOTIFY_URL",
    "FADADA_SIGN_RETURN_URL",
    "FADADA_SIGN_URL_VALIDITY_MINUTES",
    "FADADA_SIGN_URL_QUANTITY"
  ];

  for (const key of keys) {
    envStatus[key] = env[key]?.trim() ? "present" : "missing";
  }

  const envFileSafety = options.envFileSafety ?? { exists: true, ignored: true, tracked: false };
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
    warnings.push("ESIGN_PROVIDER is not fadada; client-level upload/signUrl smoke can still run with explicit Fadada env.");
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
  if ((env.FADADA_UPLOAD_SIGNURL_SMOKE ?? "").trim() !== "1") {
    blockers.push("FADADA_UPLOAD_SIGNURL_SMOKE=1 is required");
  }
  for (const key of ["FADADA_BASE_URL", "FADADA_APP_ID", "FADADA_APP_SECRET", "FADADA_TEST_CUSTOMER_ID", "FADADA_SIGN_NOTIFY_URL", "FADADA_SIGN_RETURN_URL"]) {
    if (!env[key]?.trim()) {
      blockers.push(`${key} is required`);
    }
  }
  if (env.FADADA_BASE_URL?.trim() && !isProductionBaseUrl(env.FADADA_BASE_URL)) {
    blockers.push("FADADA_BASE_URL must be the confirmed Fadada production API URL");
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
    gateMessage: blockers.length ? REAL_CALL_GATE_MESSAGE : undefined,
    ok: blockers.length === 0,
    warnings
  };
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

export function loadEnvFileIfExists(path) {
  if (!existsSync(path)) {
    return { env: {}, exists: false };
  }
  return { env: parseEnvText(readFileSync(path, "utf8")), exists: true };
}

export function loadOrCreateTestPdf(pdfFile = DEFAULT_TEST_PDF_FILE) {
  const filePath = resolve(pdfFile);
  const buffer = createTestPdf();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buffer);
  return buffer;
}

export function createTestPdf() {
  const content = "BT /F1 16 Tf 72 720 Td (SubAuto Fadada Production Host Smoke Test - Not a real contract) Tj ET";
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
  const response = await transport(buildTransportRequest(request, file));
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

export function isMainModule(importMetaUrl, argvPath) {
  if (!argvPath) return false;
  return fileURLToPath(importMetaUrl) === resolve(argvPath);
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
    else if (arg === "--result-file") options.resultFile = args[++index];
    else if (arg === "--pdf-file") options.pdfFile = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parseMode(value) {
  if (["preflight", "run"].includes(value)) {
    return value;
  }
  throw new Error(`Unknown mode: ${value}`);
}

function printHelp() {
  console.log(`Usage: node scripts/fadada-production-upload-signurl-smoke.mjs --mode <preflight|run> [options]

Options:
  --env-file <path>     Defaults to ${DEFAULT_ENV_FILE}
  --pdf-file <path>     Defaults to ${DEFAULT_TEST_PDF_FILE}
  --result-file <path>  Defaults to ${DEFAULT_RESULT_FILE}
`);
}

function printSummary(result, resultFile) {
  console.log("Fadada production upload/signUrl smoke summary:");
  console.log(`mode=${result.mode}`);
  console.log(`preflight=${result.preflight.ok ? "passed" : "blocked"}`);
  console.log(`uploaddocs=${result.uploadDocs.status}`);
  console.log(`extsign_validation=${result.extSignValidation.status}`);
  console.log(`signUrl=${result.signUrl.present ? "present" : "missing"}`);
  if (result.diagnosticState) {
    console.log(`full request diagnostics saved to ${basename(resultFile)}; do not commit this file`);
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

function buildRequestDiagnostic(request, file) {
  const diagnostic = {
    contentType: request.contentType,
    endpoint: request.endpoint,
    method: request.method,
    params: request.params,
    url: request.url
  };
  if (file) {
    diagnostic.file = {
      contentType: file.contentType,
      fieldName: file.fieldName ?? "file",
      fileName: file.fileName,
      sha256: sha256Hex(file.buffer),
      sizeBytes: file.buffer.length
    };
  }
  return diagnostic;
}

function buildProviderDiagnostic(raw, response) {
  return {
    code: providerCode(raw),
    httpStatus: response.status,
    msg: providerMsg(raw)
  };
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
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

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildSmokeId(prefix, now) {
  const kind = prefix === "tx" ? "SATX" : "SAES";
  const timestamp = formatFadadaTimestamp(now);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return `${kind}${timestamp}${suffix}`;
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
  if (typeof data === "string" && keys.some((key) => /url/i.test(key)) && /^https?:\/\//i.test(data)) {
    return data;
  }
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

function extractSignUrl(raw) {
  return stringField(raw, ["sign_url", "signUrl", "url"]);
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
  return code === "1000";
}

function escapeMultipartName(value) {
  return value.replace(/["\r\n]/g, "_");
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
