import assert from "node:assert/strict";
import test from "node:test";

import {
  validateProductionImageGoldenPathConfig,
  validateStage1GoldenPathPreflight
} from "./stage1-golden-path-production-preflight.mjs";

test("accepts a complete controlled production acceptance configuration", () => {
  const result = validateStage1GoldenPathPreflight(validEnv());

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.match(result.summary.identifiers.application, /^appl.*5678$/);
  assert.equal(result.summary.sensitive.FADADA_APP_SECRET, "configured");
  assert.equal(result.summary.sensitive.STAGE1_ACCEPTANCE_PAYER_OPENID, "configured");
});

test("blocks disabled Journey runtime, worker, and empty allowlists independently", () => {
  expectBlocker({ SUBSCRIPTION_JOURNEY_ENABLED: "false" }, "JOURNEY_DISABLED");
  expectBlocker({ SUBSCRIPTION_JOURNEY_WORKER_ENABLED: "false" }, "WORKER_DISABLED");
  expectBlocker(
    {
      SUBSCRIPTION_JOURNEY_ALLOWLIST_APPLICATION_IDS: "",
      SUBSCRIPTION_JOURNEY_ALLOWLIST_CUSTOMER_IDS: ""
    },
    "ALLOWLIST_EMPTY"
  );
});

test("blocks non-production or incomplete Fadada configuration independently", () => {
  expectBlocker({ ESIGN_PROVIDER: "mock" }, "ESIGN_PROVIDER_INVALID");
  expectBlocker({ FADADA_ENV: "sandbox" }, "FADADA_ENV_INVALID");
  expectBlocker(
    { FADADA_BASE_URL: "https://testapi.fadada.com:8443/api/" },
    "FADADA_BASE_URL_INVALID"
  );
  expectBlocker({ FADADA_SIGN_NOTIFY_URL: "" }, "FADADA_CALLBACK_URL_MISSING");
  expectBlocker({ FADADA_SIGN_RETURN_URL: "" }, "FADADA_RETURN_URL_MISSING");
  expectBlocker({ FADADA_TEST_CUSTOMER_ID: "" }, "FADADA_SIGNER_ID_MISSING");
  expectBlocker({ FADADA_TEST_LOCAL_CUSTOMER_ID: "" }, "TEST_CUSTOMER_ID_MISSING");
  expectBlocker(
    { STAGE1_ACCEPTANCE_CONTRACT_TEMPLATE_ID: "" },
    "CONTRACT_TEMPLATE_ID_MISSING"
  );
});

test("blocks incomplete production JSAPI payment and payer authorization", () => {
  expectBlocker({ WECHAT_PAY_ENABLED: "false" }, "WECHAT_PAY_DISABLED");
  expectBlocker({ PAYMENT_DEFAULT_CHANNEL: "MOCK" }, "WECHAT_TRADE_TYPE_INVALID");
  expectBlocker({ WECHAT_PAY_DEFAULT_CHANNEL: "NATIVE" }, "WECHAT_TRADE_TYPE_INVALID");
  expectBlocker(
    { WECHAT_PAY_NOTIFY_URL: "http://localhost:3001/api/payments/callback/wechat-pay" },
    "WECHAT_NOTIFY_URL_INVALID"
  );
  expectBlocker({ STAGE1_ACCEPTANCE_PAYER_OPENID: "" }, "PAYER_OPENID_MISSING");
});

test("requires official-account notifications and keeps delegated debit disabled", () => {
  expectBlocker({ NOTIFICATION_PROVIDER: "mock" }, "NOTIFICATION_PROVIDER_INVALID");
  expectBlocker({ NOTIFICATION_WECHAT_ENABLED: "false" }, "WECHAT_NOTIFICATION_DISABLED");
  expectBlocker({ AUTO_DEBIT_ENABLED: "true" }, "AUTO_DEBIT_MUST_BE_DISABLED");
});

test("requires dedicated non-operational acceptance assets and controlled limits", () => {
  expectBlocker({ STAGE1_ACCEPTANCE_TEST_VEHICLE_ID: "" }, "TEST_VEHICLE_ID_MISSING");
  expectBlocker({ STAGE1_ACCEPTANCE_TEST_APPLICATION_ID: "" }, "TEST_APPLICATION_ID_MISSING");
  expectBlocker(
    { STAGE1_ACCEPTANCE_TEST_VEHICLE_CONFIRMED_NON_OPERATIONAL: "false" },
    "TEST_VEHICLE_NOT_CONFIRMED_NON_OPERATIONAL"
  );
  expectBlocker({ STAGE1_ACCEPTANCE_MAX_PAYMENT_FEN: "0" }, "PAYMENT_LIMIT_INVALID");
  expectBlocker({ STAGE1_ACCEPTANCE_MAX_REFUND_FEN: "" }, "REFUND_LIMIT_INVALID");
  expectBlocker(
    {
      STAGE1_ACCEPTANCE_MAX_PAYMENT_FEN: "100",
      STAGE1_ACCEPTANCE_MAX_REFUND_FEN: "101"
    },
    "REFUND_LIMIT_EXCEEDS_PAYMENT"
  );
});

test("never returns raw secrets, keys, certificates, passwords, tokens, or OpenIDs", () => {
  const env = validEnv();
  Object.assign(env, {
    FADADA_APP_SECRET: "secret-value-must-never-appear",
    JWT_SECRET: "jwt-value-must-never-appear",
    POSTGRES_PASSWORD: "password-value-must-never-appear",
    WECHAT_PAY_API_V3_KEY: "key-value-must-never-appear",
    WECHAT_PAY_MERCHANT_CERT_PATH: "/private/cert-value-must-never-appear.pem",
    STAGE1_ACCEPTANCE_PAYER_OPENID: "openid-value-must-never-appear",
    ACCESS_TOKEN: "token-value-must-never-appear"
  });

  const output = JSON.stringify(validateStage1GoldenPathPreflight(env));

  for (const raw of Object.values(env)) {
    if (/secret|password|key-value|cert-value|openid-value|token-value/i.test(raw)) {
      assert.equal(output.includes(raw), false, raw);
    }
  }
});

test("production-image guard allows disabled rollout defaults", () => {
  assert.deepEqual(
    validateProductionImageGoldenPathConfig({
      AUTO_DEBIT_ENABLED: "false",
      ESIGN_PROVIDER: "fadada",
      FADADA_ENV: "production",
      NOTIFICATION_PROVIDER: "wechat_official_account",
      SUBSCRIPTION_JOURNEY_ALLOWLIST_APPLICATION_IDS: "",
      SUBSCRIPTION_JOURNEY_ALLOWLIST_CUSTOMER_IDS: "",
      SUBSCRIPTION_JOURNEY_ENABLED: "false",
      SUBSCRIPTION_JOURNEY_WORKER_ENABLED: "false"
    }),
    []
  );
});

test("production-image guard rejects unsafe enabled rollout defaults", () => {
  const blockers = validateProductionImageGoldenPathConfig({
    AUTO_DEBIT_ENABLED: "true",
    ESIGN_PROVIDER: "mock",
    FADADA_ENV: "sandbox",
    NOTIFICATION_PROVIDER: "mock",
    SUBSCRIPTION_JOURNEY_ALLOWLIST_APPLICATION_IDS: "",
    SUBSCRIPTION_JOURNEY_ALLOWLIST_CUSTOMER_IDS: "",
    SUBSCRIPTION_JOURNEY_ENABLED: "true",
    SUBSCRIPTION_JOURNEY_WORKER_ENABLED: "true"
  });

  assert.deepEqual(
    blockers.map(({ code }) => code).sort(),
    [
      "AUTO_DEBIT_MUST_BE_DISABLED",
      "ENABLED_ALLOWLIST_EMPTY",
      "ENABLED_ESIGN_PROVIDER_UNSAFE",
      "ENABLED_FADADA_ENV_UNSAFE",
      "ENABLED_NOTIFICATION_PROVIDER_UNSAFE"
    ].sort()
  );
});

function expectBlocker(overrides, code) {
  const result = validateStage1GoldenPathPreflight({ ...validEnv(), ...overrides });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === code), result.blockers);
}

function validEnv() {
  return {
    API_BASE_URL: "https://api.subauto.keybox.cloud/api",
    AUTO_DEBIT_ENABLED: "false",
    ESIGN_PROVIDER: "fadada",
    FADADA_APP_ID: "configured-app-id",
    FADADA_APP_SECRET: "configured-app-secret",
    FADADA_BASE_URL: "https://textapi.fadada.com/api2/",
    FADADA_ENV: "production",
    FADADA_SIGN_NOTIFY_URL: "https://api.subauto.keybox.cloud/api/esign/callback/fadada",
    FADADA_SIGN_RETURN_URL: "https://app.subauto.keybox.cloud/portal/contracts",
    FADADA_TEST_CUSTOMER_ID: "fadada-signer-12345678",
    FADADA_TEST_LOCAL_CUSTOMER_ID: "customer-12345678",
    NOTIFICATION_PROVIDER: "wechat_official_account",
    NOTIFICATION_WECHAT_ENABLED: "true",
    PAYMENT_DEFAULT_CHANNEL: "WECHAT_JSAPI",
    STAGE1_ACCEPTANCE_CONTRACT_TEMPLATE_ID: "template-12345678",
    STAGE1_ACCEPTANCE_MAX_PAYMENT_FEN: "100",
    STAGE1_ACCEPTANCE_MAX_REFUND_FEN: "100",
    STAGE1_ACCEPTANCE_PAYER_OPENID: "payer-openid-12345678",
    STAGE1_ACCEPTANCE_TEST_APPLICATION_ID: "application-12345678",
    STAGE1_ACCEPTANCE_TEST_VEHICLE_CONFIRMED_NON_OPERATIONAL: "true",
    STAGE1_ACCEPTANCE_TEST_VEHICLE_ID: "vehicle-12345678",
    SUBSCRIPTION_JOURNEY_ALLOWLIST_APPLICATION_IDS: "application-12345678",
    SUBSCRIPTION_JOURNEY_ALLOWLIST_CUSTOMER_IDS: "customer-12345678",
    SUBSCRIPTION_JOURNEY_ENABLED: "true",
    SUBSCRIPTION_JOURNEY_WORKER_ENABLED: "true",
    WECHAT_PAY_DEFAULT_CHANNEL: "WECHAT_JSAPI",
    WECHAT_PAY_ENABLED: "true",
    WECHAT_PAY_NOTIFY_URL: "https://api.subauto.keybox.cloud/api/payments/callback/wechat-pay",
    WECHAT_OFFICIAL_ACCOUNT_APP_ID: "configured-official-account-app-id",
    WECHAT_OFFICIAL_ACCOUNT_APP_SECRET: "configured-official-account-secret",
    WECHAT_PAY_API_V3_KEY: "configured-api-v3-key",
    WECHAT_PAY_APP_ID: "configured-wechat-pay-app-id",
    WECHAT_PAY_MCH_ID: "configured-merchant-id",
    WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH: "/run/secrets/wechat-pay-private-key.pem",
    WECHAT_PAY_MERCHANT_SERIAL_NO: "configured-merchant-serial",
    WECHAT_PAY_PLATFORM_CERT_PATH: "/run/secrets/wechat-pay-platform-cert.pem",
    WECHAT_TEMPLATE_APPLICATION_PROGRESS: "configured-application-template",
    WECHAT_TEMPLATE_CONTRACT_PENDING: "configured-contract-template",
    WECHAT_TEMPLATE_FINAL_PLAN_PENDING: "configured-plan-template",
    WECHAT_TEMPLATE_PAYMENT_PENDING: "configured-payment-template"
  };
}
