import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAccountRegisterRequest,
  buildPersonVerifyUrlRequest,
  decodeFadadaUrl,
  runFadadaProductionTestSignerRealname,
  validateProductionPreflight
} from "./fadada-production-test-signer-realname.mjs";

const baseEnv = {
  ESIGN_PROVIDER: "fadada",
  FADADA_API_VERSION: "2.0",
  FADADA_APP_ID: "501040",
  FADADA_APP_SECRET: "secret-abcdef",
  FADADA_BASE_URL: "https://textapi.fadada.com/api2/",
  FADADA_ENABLED: "true",
  FADADA_ENV: "production",
  FADADA_PRODUCTION_SMOKE: "1",
  FADADA_TEST_SIGNER_REALNAME_PREP: "1",
  FADADA_TEST_PERSON_OPEN_ID: "subauto-production-smoke-person-001",
  FADADA_TEST_PERSON_ID_CARD_NO: "110101199001011234",
  FADADA_TEST_PERSON_MOBILE: "13800138000",
  FADADA_TEST_PERSON_NAME: "Test User",
  FADADA_VERIFY_NOTIFY_URL: "https://api.subauto.keybox.cloud/api/esign/verify-callback/fadada",
  FADADA_VERIFY_RETURN_URL: "https://app.subauto.keybox.cloud/portal/contracts"
};

test("validateProductionPreflight blocks real calls unless production gates are enabled", () => {
  const result = validateProductionPreflight({
    ...baseEnv,
    FADADA_ENABLED: "false",
    FADADA_PRODUCTION_SMOKE: "0",
    FADADA_TEST_SIGNER_REALNAME_PREP: "0"
  });

  assert.equal(result.ok, false);
  assert.match(result.blockers.join("\n"), /FADADA_ENABLED=true/);
  assert.match(result.blockers.join("\n"), /FADADA_PRODUCTION_SMOKE=1/);
  assert.match(result.blockers.join("\n"), /FADADA_TEST_SIGNER_REALNAME_PREP=1/);
});

test("validateProductionPreflight requires production host and controlled test person data", () => {
  const result = validateProductionPreflight({
    ...baseEnv,
    FADADA_BASE_URL: "https://testapi.fadada.com:8443/api/",
    FADADA_TEST_PERSON_ID_CARD_NO: "",
    FADADA_TEST_PERSON_MOBILE: "",
    FADADA_TEST_PERSON_NAME: ""
  });

  assert.equal(result.ok, false);
  assert.match(result.blockers.join("\n"), /production API URL/);
  assert.match(result.blockers.join("\n"), /FADADA_TEST_PERSON_NAME is required/);
  assert.match(result.blockers.join("\n"), /FADADA_TEST_PERSON_ID_CARD_NO is required/);
  assert.match(result.blockers.join("\n"), /FADADA_TEST_PERSON_MOBILE is required/);
});

test("buildPersonVerifyUrlRequest includes real-name fields and never includes the app secret", () => {
  const request = buildPersonVerifyUrlRequest({
    appId: "501040",
    appSecret: "secret-abcdef",
    baseUrl: "https://textapi.fadada.com/api2/",
    customerId: "CUST1234567890",
    idCardNo: "110101199001011234",
    mobile: "13800138000",
    name: "Test User",
    notifyUrl: baseEnv.FADADA_VERIFY_NOTIFY_URL,
    returnUrl: baseEnv.FADADA_VERIFY_RETURN_URL,
    timestamp: "20260626010203",
    version: "2.0"
  });

  assert.equal(request.url, "https://textapi.fadada.com/api2/get_person_verify_url.api");
  assert.equal(request.params.customer_id, "CUST1234567890");
  assert.equal(request.params.verified_way, "1");
  assert.equal(request.params.page_modify, "1");
  assert.equal(request.params.cert_flag, "1");
  assert.equal(request.params.customer_ident_type, "0");
  assert.equal(request.params.customer_name, "Test User");
  assert.equal(request.params.customer_ident_no, "110101199001011234");
  assert.equal(request.params.mobile, "13800138000");
  assert.match(request.params.msg_digest, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Object.values(request.params).includes("secret-abcdef"), false);
});

test("decodeFadadaUrl handles URL-encoded Base64 verification URLs", () => {
  const encoded = encodeURIComponent(Buffer.from("https://verify.example.test/path?a=1", "utf8").toString("base64"));

  assert.equal(decodeFadadaUrl(encoded), "https://verify.example.test/path?a=1");
});

test("runFadadaProductionTestSignerRealname registers customer and prepares masked verify URL only", async () => {
  const calls = [];
  const fullVerifyUrl = "https://verify.example.test/realname?token=super-secret";
  const result = await runFadadaProductionTestSignerRealname({
    env: baseEnv,
    envFileExists: true,
    mode: "prepare",
    now: () => new Date("2026-06-26T01:02:03.000Z"),
    transport: async (request) => {
      calls.push({
        body: request.body.toString("utf8"),
        headers: request.headers,
        url: request.url
      });
      if (request.url.endsWith("/account_register.api")) {
        return { bodyText: JSON.stringify({ code: 1, data: "CUSTOMER-1234567890", msg: "success" }), headers: {}, status: 200 };
      }
      if (request.url.endsWith("/get_person_verify_url.api")) {
        return {
          bodyText: JSON.stringify({
            code: 1,
            data: {
              transactionNo: "VERIFY-TX-1234567890",
              url: Buffer.from(fullVerifyUrl, "utf8").toString("base64")
            },
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
    "get_person_verify_url.api"
  ]);
  assert.equal(result.accountRegister.status, "success");
  assert.equal(result.personVerifyUrl.status, "success");
  assert.equal(result.verifyUrl.present, true);
  assert.notEqual(result.verifyUrl.masked, fullVerifyUrl);
  assert.equal(result.prepareState.customerId, "CUSTOMER-1234567890");
  assert.equal(result.prepareState.transactionNo, "VERIFY-TX-1234567890");
  assert.equal(result.prepareState.verifyUrl, fullVerifyUrl);
  assert.equal(JSON.stringify(result.sanitized).includes("super-secret"), false);
});

test("runFadadaProductionTestSignerRealname preflight mode never calls transport", async () => {
  const result = await runFadadaProductionTestSignerRealname({
    env: baseEnv,
    envFileExists: true,
    mode: "preflight",
    transport: async () => {
      throw new Error("transport should not be called");
    }
  });

  assert.equal(result.mode, "preflight");
  assert.equal(result.accountRegister.status, "skipped");
  assert.equal(result.personVerifyUrl.status, "skipped");
});

test("runFadadaProductionTestSignerRealname status mode reads transactionNo from latest state", async () => {
  const calls = [];
  const result = await runFadadaProductionTestSignerRealname({
    env: baseEnv,
    envFileExists: true,
    latestState: {
      customerId: "CUSTOMER-1234567890",
      transactionNo: "VERIFY-TX-1234567890"
    },
    mode: "status",
    now: () => new Date("2026-06-26T01:02:03.000Z"),
    transport: async (request) => {
      calls.push(request);
      return {
        bodyText: JSON.stringify({
          code: 1,
          data: {
            person: {
              status: "2"
            }
          },
          msg: "success"
        }),
        headers: {},
        status: 200
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname.endsWith("/find_personCertInfo.api"), true);
  assert.equal(calls[0].body.toString("utf8").includes("verified_serialno=VERIFY-TX-1234567890"), true);
  assert.equal(result.statusQuery.status, "success");
  assert.equal(result.statusQuery.realNameStatus, "2");
});

test("buildAccountRegisterRequest uses stable personal account registration params", () => {
  const request = buildAccountRegisterRequest({
    appId: "501040",
    appSecret: "secret-abcdef",
    baseUrl: "https://textapi.fadada.com/api2/",
    openId: "subauto-production-smoke-person-001",
    timestamp: "20260626010203",
    version: "2.0"
  });

  assert.equal(request.url, "https://textapi.fadada.com/api2/account_register.api");
  assert.equal(request.params.account_type, "1");
  assert.equal(request.params.open_id, "subauto-production-smoke-person-001");
});
