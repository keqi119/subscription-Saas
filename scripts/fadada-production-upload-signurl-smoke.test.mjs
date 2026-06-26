import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExtSignValidationRequest,
  buildTransportRequest,
  buildUploadDocsRequest,
  createTestPdf,
  isMainModule,
  maskMiddle,
  parseEnvText,
  runFadadaProductionUploadSignUrlSmoke,
  sanitizeForOutput,
  validatePreflight
} from "./fadada-production-upload-signurl-smoke.mjs";

const baseEnv = {
  ESIGN_PROVIDER: "fadada",
  FADADA_API_VERSION: "2.0",
  FADADA_APP_ID: "501040",
  FADADA_APP_SECRET: "secret-abcdef",
  FADADA_BASE_URL: "https://textapi.fadada.com/api2/",
  FADADA_ENABLED: "true",
  FADADA_ENV: "production",
  FADADA_PRODUCTION_SMOKE: "1",
  FADADA_UPLOAD_SIGNURL_SMOKE: "1",
  FADADA_SIGN_NOTIFY_URL: "https://api.subauto.keybox.cloud/api/esign/callback/fadada",
  FADADA_SIGN_RETURN_URL: "https://app.subauto.keybox.cloud/portal/contracts",
  FADADA_TEST_CUSTOMER_ID: "CUSTOMER-1234567890"
};

test("parseEnvText ignores comments and preserves values after the first equals sign", () => {
  const env = parseEnvText("A=1\n# comment\nB=value=with=equals\nEMPTY=\n");

  assert.equal(env.A, "1");
  assert.equal(env.B, "value=with=equals");
  assert.equal(env.EMPTY, "");
  assert.equal(Object.hasOwn(env, "# comment"), false);
});

test("validatePreflight blocks production run unless upload/signUrl gates are enabled", () => {
  const result = validatePreflight({
    ...baseEnv,
    FADADA_ENABLED: "false",
    FADADA_UPLOAD_SIGNURL_SMOKE: "0"
  });

  assert.equal(result.ok, false);
  assert.match(result.blockers.join("\n"), /FADADA_ENABLED=true/);
  assert.match(result.blockers.join("\n"), /FADADA_UPLOAD_SIGNURL_SMOKE=1/);
});

test("validatePreflight blocks non-production host and missing customer id", () => {
  const result = validatePreflight({
    ...baseEnv,
    FADADA_BASE_URL: "https://testapi.fadada.com:8443/api/",
    FADADA_TEST_CUSTOMER_ID: ""
  });

  assert.equal(result.ok, false);
  assert.match(result.blockers.join("\n"), /production API URL/);
  assert.match(result.blockers.join("\n"), /FADADA_TEST_CUSTOMER_ID is required/);
});

test("buildUploadDocsRequest uses production endpoint and does not leak app secret", () => {
  const request = buildUploadDocsRequest({
    appId: baseEnv.FADADA_APP_ID,
    appSecret: baseEnv.FADADA_APP_SECRET,
    baseUrl: baseEnv.FADADA_BASE_URL,
    contractId: "SUBAUTO_CONTRACT_20260626_TEST",
    docTitle: "SubAuto Fadada Production Host Smoke Test",
    timestamp: "20260626120000",
    version: "2.0"
  });

  assert.equal(request.url, "https://textapi.fadada.com/api2/uploaddocs.api");
  assert.equal(request.params.contract_id, "SUBAUTO_CONTRACT_20260626_TEST");
  assert.equal(request.params.doc_type, ".pdf");
  assert.equal(Object.values(request.params).includes(baseEnv.FADADA_APP_SECRET), false);
  assert.match(request.params.msg_digest, /^[A-Za-z0-9+/]+={0,2}$/);
});

test("buildExtSignValidationRequest uses sign urls and masks customer id in output helpers", () => {
  const request = buildExtSignValidationRequest({
    appId: baseEnv.FADADA_APP_ID,
    appSecret: baseEnv.FADADA_APP_SECRET,
    baseUrl: baseEnv.FADADA_BASE_URL,
    contractId: "SUBAUTO_CONTRACT_20260626_TEST",
    customerId: baseEnv.FADADA_TEST_CUSTOMER_ID,
    notifyUrl: baseEnv.FADADA_SIGN_NOTIFY_URL,
    quantity: 1,
    returnUrl: baseEnv.FADADA_SIGN_RETURN_URL,
    timestamp: "20260626120000",
    transactionId: "SUBAUTO_TX_20260626_TEST",
    validity: 30,
    version: "2.0"
  });

  assert.equal(request.url, "https://textapi.fadada.com/api2/extsign_validation.api");
  assert.equal(request.method, "GET");
  assert.equal(request.params.customer_id, baseEnv.FADADA_TEST_CUSTOMER_ID);
  assert.equal(request.params.notify_url, baseEnv.FADADA_SIGN_NOTIFY_URL);
  assert.equal(request.params.return_url, baseEnv.FADADA_SIGN_RETURN_URL);
  assert.equal(maskMiddle(baseEnv.FADADA_TEST_CUSTOMER_ID), "CUST...7890");
});

test("buildTransportRequest sends extsign_validation as GET query without request body", () => {
  const request = buildExtSignValidationRequest({
    appId: baseEnv.FADADA_APP_ID,
    appSecret: baseEnv.FADADA_APP_SECRET,
    baseUrl: baseEnv.FADADA_BASE_URL,
    contractId: "SAES20260626120000ABC123",
    customerId: baseEnv.FADADA_TEST_CUSTOMER_ID,
    notifyUrl: baseEnv.FADADA_SIGN_NOTIFY_URL,
    quantity: 1,
    returnUrl: baseEnv.FADADA_SIGN_RETURN_URL,
    timestamp: "20260626120000",
    transactionId: "SATX20260626120000ABC123",
    validity: 30,
    version: "2.0"
  });

  const transportRequest = buildTransportRequest(request);
  const url = new URL(transportRequest.url);

  assert.equal(transportRequest.method, "GET");
  assert.equal(transportRequest.body, undefined);
  assert.equal(transportRequest.headers["content-type"], undefined);
  assert.equal(url.pathname.endsWith("/extsign_validation.api"), true);
  assert.equal(url.searchParams.get("contract_id"), "SAES20260626120000ABC123");
  assert.equal(url.searchParams.get("transaction_id"), "SATX20260626120000ABC123");
  assert.equal(url.searchParams.get("customer_id"), baseEnv.FADADA_TEST_CUSTOMER_ID);
  assert.equal(url.searchParams.has("msg_digest"), true);
  assert.equal(url.toString().includes(baseEnv.FADADA_APP_SECRET), false);
});

test("createTestPdf returns a non-sensitive PDF fixture", () => {
  const pdf = createTestPdf();
  const text = pdf.toString("utf8");

  assert.equal(pdf.subarray(0, 5).toString("utf8"), "%PDF-");
  assert.match(text, /SubAuto Fadada Production Host Smoke Test/);
  assert.doesNotMatch(text, /身份证|手机号|VIN|车牌/);
  assert.ok(pdf.length < 20 * 1024 * 1024);
});

test("runFadadaProductionUploadSignUrlSmoke uploads PDF, creates masked sign URL, and never opens it", async () => {
  const calls = [];
  const openUrlCalls = [];
  const result = await runFadadaProductionUploadSignUrlSmoke({
    env: baseEnv,
    now: () => new Date("2026-06-26T12:00:00.000Z"),
    openUrl: (url) => openUrlCalls.push(url),
    transport: async (request) => {
      calls.push({
        body: request.body?.toString("utf8"),
        headers: request.headers,
        method: request.method,
        url: request.url
      });
      if (request.url.includes("/uploaddocs.api")) {
        return { bodyText: JSON.stringify({ code: 1000, msg: "操作成功" }), headers: {}, status: 200 };
      }
      if (request.url.includes("/extsign_validation.api")) {
        return {
          bodyText: "https://sign.example.test/path?token=super-secret",
          headers: {},
          status: 200
        };
      }
      throw new Error(`unexpected URL ${request.url}`);
    }
  });

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname.split("/").pop()), [
    "uploaddocs.api",
    "extsign_validation.api"
  ]);
  assert.equal(result.uploadDocs.status, "success");
  assert.equal(result.extSignValidation.status, "success");
  assert.equal(result.signUrl.present, true);
  assert.notEqual(result.signUrl.masked, "https://sign.example.test/path?token=super-secret");
  assert.equal(JSON.stringify(result.sanitized).includes("super-secret"), false);
  assert.deepEqual(openUrlCalls, []);
  assert.equal(result.state?.signUrl, "https://sign.example.test/path?token=super-secret");
  assert.equal(calls[1].headers["content-type"], undefined);
  assert.equal(calls[1].body, undefined);
});

test("runFadadaProductionUploadSignUrlSmoke records explicit upload diagnostics on upload failure", async () => {
  const result = await runFadadaProductionUploadSignUrlSmoke({
    env: baseEnv,
    now: () => new Date("2026-06-26T12:00:00.000Z"),
    pdfBuffer: createTestPdf(),
    transport: async (request) => {
      if (request.url.endsWith("/uploaddocs.api")) {
        return {
          bodyText: JSON.stringify({ code: 2002, msg: "invalid contract id" }),
          headers: {},
          status: 200
        };
      }
      throw new Error(`unexpected URL ${request.url}`);
    }
  });

  assert.equal(result.uploadDocs.status, "failed");
  assert.equal(result.extSignValidation.status, "skipped");
  assert.equal(result.signUrl.present, false);
  assert.equal(result.diagnosticState?.requests.uploadDocs.endpoint, "uploaddocs.api");
  assert.equal(result.diagnosticState?.requests.uploadDocs.method, "POST");
  assert.equal(result.diagnosticState?.requests.uploadDocs.contentType, "multipart/form-data;charset=utf8");
  assert.equal(result.diagnosticState?.requests.uploadDocs.params.doc_title, "SubAuto Fadada Production Host Smoke Test");
  assert.equal(result.diagnosticState?.requests.uploadDocs.params.doc_type, ".pdf");
  assert.equal(result.diagnosticState?.requests.uploadDocs.params.app_id, baseEnv.FADADA_APP_ID);
  assert.match(result.diagnosticState?.requests.uploadDocs.params.contract_id, /^SAES\d{14}[A-Z0-9]{6}$/);
  assert.ok(result.diagnosticState?.requests.uploadDocs.params.contract_id.length <= 40);
  assert.doesNotMatch(result.diagnosticState?.requests.uploadDocs.params.contract_id, /CUSTOMER|PHONE|VIN|PLATE/i);
  assert.match(result.diagnosticState?.transactionId, /^SATX\d{14}[A-Z0-9]{6}$/);
  assert.ok(result.diagnosticState?.transactionId.length <= 40);
  assert.doesNotMatch(result.diagnosticState?.transactionId, /CUSTOMER|PHONE|VIN|PLATE/i);
  assert.match(result.diagnosticState?.requests.uploadDocs.params.msg_digest, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(result.diagnosticState?.requests.uploadDocs.file.fieldName, "file");
  assert.equal(result.diagnosticState?.requests.uploadDocs.file.contentType, "application/pdf");
  assert.equal(result.diagnosticState?.provider.uploadDocs.code, "2002");
  assert.equal(result.diagnosticState?.provider.uploadDocs.msg, "invalid contract id");
  assert.equal(JSON.stringify(result.diagnosticState).includes(baseEnv.FADADA_APP_SECRET), false);
});

test("runFadadaProductionUploadSignUrlSmoke records text response diagnostics when sign URL is missing", async () => {
  const result = await runFadadaProductionUploadSignUrlSmoke({
    env: baseEnv,
    now: () => new Date("2026-06-26T12:00:00.000Z"),
    pdfBuffer: createTestPdf(),
    transport: async (request) => {
      if (request.url.includes("/uploaddocs.api")) {
        return {
          bodyText: JSON.stringify({ code: 1000, msg: "操作成功" }),
          headers: {},
          status: 200
        };
      }
      if (request.url.includes("/extsign_validation.api")) {
        return {
          bodyText: "签署链接暂不可用",
          headers: { "content-type": "text/plain;charset=utf-8" },
          status: 200
        };
      }
      throw new Error(`unexpected URL ${request.url}`);
    }
  });

  assert.equal(result.uploadDocs.status, "success");
  assert.equal(result.extSignValidation.status, "failed");
  assert.equal(result.signUrl.present, false);
  assert.equal(result.diagnosticState?.provider.extSignValidation.httpStatus, 200);
  assert.equal(result.diagnosticState?.provider.extSignValidation.bodyKind, "text");
  assert.equal(result.diagnosticState?.provider.extSignValidation.bodyTextLength, 8);
  assert.equal(result.diagnosticState?.provider.extSignValidation.bodyTextPreview, "签署链接暂不可用");
});

test("sanitizeForOutput masks customer ids and sign urls", () => {
  const sanitized = sanitizeForOutput({
    customer_id: "CUSTOMER-1234567890",
    signUrl: "https://sign.example.test/path?token=super-secret",
    status: "success"
  });

  assert.equal(sanitized.customer_id, "CUST...7890");
  assert.equal(sanitized.signUrl, "https://sign.example.test/...");
  assert.equal(sanitized.status, "success");
});

test("isMainModule recognizes Windows script paths", () => {
  assert.equal(
    isMainModule(
      "file:///D:/Projects/auto-subscription-platform/scripts/fadada-production-upload-signurl-smoke.mjs",
      "D:\\Projects\\auto-subscription-platform\\scripts\\fadada-production-upload-signurl-smoke.mjs"
    ),
    true
  );
});
