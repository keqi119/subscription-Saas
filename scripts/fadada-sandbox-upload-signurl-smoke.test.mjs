import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAccountRegisterRequest,
  isMainModule,
  maskMiddle,
  parseEnvText,
  runFadadaSandboxSmoke,
  sanitizeForOutput,
  validatePreflight
} from "./fadada-sandbox-upload-signurl-smoke.mjs";

const baseEnv = {
  ESIGN_PROVIDER: "fadada",
  FADADA_API_VERSION: "2.0",
  FADADA_APP_ID: "app-123456",
  FADADA_APP_SECRET: "secret-abcdef",
  FADADA_BASE_URL: "https://testapi.fadada.com:8443/api/",
  FADADA_ENABLED: "true",
  FADADA_ENV: "sandbox",
  FADADA_SANDBOX_SMOKE: "1",
  FADADA_SIGN_NOTIFY_URL: "https://api.subauto.keybox.cloud/api/esign/callback/fadada",
  FADADA_SIGN_RETURN_URL: "https://app.subauto.keybox.cloud/portal/contracts"
};

test("parseEnvText ignores comments and preserves values after the first equals sign", () => {
  const env = parseEnvText("A=1\n# comment\nB=value=with=equals\nEMPTY=\n");

  assert.equal(env.A, "1");
  assert.equal(env.B, "value=with=equals");
  assert.equal(env.EMPTY, "");
  assert.equal(Object.hasOwn(env, "# comment"), false);
});

test("validatePreflight blocks real calls unless sandbox smoke gates are enabled", () => {
  const result = validatePreflight({
    ...baseEnv,
    FADADA_ENABLED: "false",
    FADADA_SANDBOX_SMOKE: "0"
  });

  assert.equal(result.ok, false);
  assert.match(result.blockers.join("\n"), /FADADA_ENABLED=true/);
  assert.match(result.blockers.join("\n"), /FADADA_SANDBOX_SMOKE=1/);
});

test("validatePreflight accepts missing FADADA_TEST_CUSTOMER_ID when account registration can supply one", () => {
  const result = validatePreflight(baseEnv);

  assert.equal(result.ok, true);
  assert.equal(result.requiresAccountRegister, true);
});

test("buildAccountRegisterRequest uses account_type and open_id as digest business params", () => {
  const request = buildAccountRegisterRequest({
    appId: "app-123456",
    appSecret: "secret-abcdef",
    baseUrl: "https://testapi.fadada.com:8443/api/",
    openId: "subauto-sandbox-person-smoke-001",
    timestamp: "20260625010203",
    version: "2.0"
  });

  assert.equal(request.url, "https://testapi.fadada.com:8443/api/account_register.api");
  assert.equal(request.params.account_type, "1");
  assert.equal(request.params.open_id, "subauto-sandbox-person-smoke-001");
  assert.equal(request.params.app_id, "app-123456");
  assert.equal(request.params.timestamp, "20260625010203");
  assert.equal(request.params.v, "2.0");
  assert.match(request.params.msg_digest, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Object.values(request.params).includes("secret-abcdef"), false);
});

test("runFadadaSandboxSmoke registers customer id, uploads PDF, creates masked sign URL, and never opens it", async () => {
  const calls = [];
  const result = await runFadadaSandboxSmoke({
    env: baseEnv,
    now: () => new Date("2026-06-25T01:02:03.000Z"),
    pdfBuffer: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8"),
    transport: async (request) => {
      calls.push({
        body: request.body.toString("utf8"),
        headers: request.headers,
        url: request.url
      });
      if (request.url.endsWith("/account_register.api")) {
        return { bodyText: JSON.stringify({ code: 1, data: "CUSTOMER-1234567890", msg: "success" }), headers: {}, status: 200 };
      }
      if (request.url.endsWith("/uploaddocs.api")) {
        return { bodyText: JSON.stringify({ code: 1, msg: "success" }), headers: {}, status: 200 };
      }
      if (request.url.endsWith("/extsign_validation.api")) {
        return {
          bodyText: JSON.stringify({
            code: 1,
            data: "https://sign.example.test/path?token=super-secret",
            msg: "success"
          }),
          headers: {},
          status: 200
        };
      }
      throw new Error(`unexpected URL ${request.url}`);
    }
  });

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname.split("/").pop()), [
    "account_register.api",
    "uploaddocs.api",
    "extsign_validation.api"
  ]);
  assert.equal(result.accountRegister.status, "success");
  assert.equal(result.uploadDocs.status, "success");
  assert.equal(result.extSignValidation.status, "success");
  assert.equal(result.signUrl.present, true);
  assert.notEqual(result.signUrl.masked, "https://sign.example.test/path?token=super-secret");
  assert.equal(JSON.stringify(result).includes("super-secret"), false);
});

test("maskMiddle keeps identifiers useful without exposing complete values", () => {
  assert.equal(maskMiddle("ABCDEFGH12345678"), "ABCD...5678");
  assert.equal(maskMiddle("short"), "present");
  assert.equal(maskMiddle(""), "missing");
});

test("isMainModule recognizes Windows script paths", () => {
  assert.equal(
    isMainModule(
      "file:///D:/Projects/auto-subscription-platform/scripts/fadada-sandbox-upload-signurl-smoke.mjs",
      "D:\\Projects\\auto-subscription-platform\\scripts\\fadada-sandbox-upload-signurl-smoke.mjs"
    ),
    true
  );
});

test("sanitizeForOutput preserves preflight status words for sensitive env keys", () => {
  const sanitized = sanitizeForOutput({
    envStatus: {
      FADADA_APP_SECRET: "present",
      FADADA_TEST_CUSTOMER_ID: "missing"
    }
  });

  assert.equal(sanitized.envStatus.FADADA_APP_SECRET, "present");
  assert.equal(sanitized.envStatus.FADADA_TEST_CUSTOMER_ID, "missing");
});
