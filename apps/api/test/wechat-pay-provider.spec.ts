import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WeChatPayProvider } from "../src/payment/wechat-pay.provider";
import { WeChatPayCertificateStore } from "../src/payment/wechat-pay-certificate-store";
import {
  encryptWechatPayResourceForTest,
  signWechatPayMessage
} from "../src/payment/wechat-pay.crypto";

describe("WeChatPayProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a JSAPI payment request and returns frontend params", async () => {
    const fixture = createWechatFixture();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return new Response(JSON.stringify({ prepay_id: "wx_prepay_1" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new WeChatPayProvider(fixture.configService as never);

    const result = await provider.createPayment({
      amount: 100,
      notifyUrl: "https://api.example.com/api/payments/callback/wechat-pay",
      openId: "openid_customer",
      paymentOrderNo: "PYO202606170001",
      subject: "测试账单支付"
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as AnyRecord;

    expect(url).toBe("https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi");
    expect(body.appid).toBe("wx_test_app");
    expect(body.mchid).toBe("1900000001");
    expect(body.out_trade_no).toBe("PYO202606170001");
    expect(body.notify_url).toBe("https://api.example.com/api/payments/callback/wechat-pay");
    expect(body.amount.total).toBe(100);
    expect(body.payer.openid).toBe("openid_customer");
    expect((init?.headers as Record<string, string>).Authorization).toContain("WECHATPAY2-SHA256-RSA2048");
    expect((init?.headers as Record<string, string>)["Accept-Language"]).toBe("zh-CN");
    expect(result.providerTradeNo).toBe("PYO202606170001");
    expect(result.providerPrepayId).toBe("wx_prepay_1");
    expect(result.jsapiParams?.package).toBe("prepay_id=wx_prepay_1");
    expect(JSON.stringify(result.jsapiParams)).not.toContain(fixture.apiV3Key);

    fixture.cleanup();
  });

  it("closes an unpaid transaction through the authenticated API v3 endpoint", async () => {
    const fixture = createWechatFixture();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new WeChatPayProvider(fixture.configService as never);

    await expect(
      provider.closePayment({ providerTradeNo: "PYO202606170001" })
    ).resolves.toMatchObject({ providerTradeNo: "PYO202606170001" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/PYO202606170001/close"
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ mchid: "1900000001" });
    expect((init.headers as Record<string, string>).Authorization).toContain(
      "WECHATPAY2-SHA256-RSA2048"
    );

    fixture.cleanup();
  });

  it("does not report a provider close as successful when WeChat rejects it", async () => {
    const fixture = createWechatFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: "ORDERPAID" }), { status: 400 })
      )
    );
    const provider = new WeChatPayProvider(fixture.configService as never);

    await expect(
      provider.closePayment({ providerTradeNo: "PYO202606170001" })
    ).rejects.toMatchObject({ response: { code: "WECHAT_PAY_CLOSE_FAILED" } });

    fixture.cleanup();
  });

  it("treats a missing remote transaction as an idempotent close", async () => {
    const fixture = createWechatFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: "ORDER_NOT_EXIST" }), { status: 404 })
      )
    );
    const provider = new WeChatPayProvider(fixture.configService as never);

    await expect(
      provider.closePayment({ providerTradeNo: "PYO202606170001" })
    ).resolves.toMatchObject({ providerTradeNo: "PYO202606170001" });

    fixture.cleanup();
  });

  it("verifies and decrypts a SUCCESS callback", async () => {
    const fixture = createWechatFixture();
    const provider = new WeChatPayProvider(fixture.configService as never);
    const payload = fixture.createCallbackPayload({
      amount: { payer_total: 100, total: 100 },
      appid: "wx_test_app",
      mchid: "1900000001",
      out_trade_no: "PYO202606170001",
      success_time: "2026-06-17T10:00:00+08:00",
      trade_state: "SUCCESS",
      transaction_id: "4200000001202606170000000001"
    });
    const body = JSON.stringify(payload);
    const timestamp = "1710000000";
    const nonce = "callback_nonce";
    const signature = signWechatPayMessage(`${timestamp}\n${nonce}\n${body}\n`, fixture.privateKeyPem);

    const result = await provider.verifyCallback(payload, {
      "Wechatpay-Nonce": nonce,
      "Wechatpay-Serial": "platform_public_key_id",
      "Wechatpay-Signature": signature,
      "Wechatpay-Timestamp": timestamp
    }, Buffer.from(body));

    expect(result.verified).toBe(true);
    expect(result.eventType).toBe("SUCCESS");
    expect(result.providerTradeNo).toBe("PYO202606170001");
    expect(result.providerTransactionId).toBe("4200000001202606170000000001");
    expect(result.paidAmount).toBe(100);

    fixture.cleanup();
  });

  it("rejects callbacks with an invalid signature", async () => {
    const fixture = createWechatFixture();
    const provider = new WeChatPayProvider(fixture.configService as never);
    const payload = fixture.createCallbackPayload({
      amount: { payer_total: 100 },
      appid: "wx_test_app",
      mchid: "1900000001",
      out_trade_no: "PYO202606170001",
      trade_state: "SUCCESS"
    });

    const result = await provider.verifyCallback(payload, {
      "Wechatpay-Nonce": "callback_nonce",
      "Wechatpay-Serial": "platform_public_key_id",
      "Wechatpay-Signature": "bad-signature",
      "Wechatpay-Timestamp": "1710000000"
    }, Buffer.from(JSON.stringify(payload)));

    expect(result.verified).toBe(false);

    fixture.cleanup();
  });

  it("loads mapped platform certificates and verifies callbacks by serial", async () => {
    const fixture = createWechatFixture({ mappedPlatformCerts: true });
    const store = new WeChatPayCertificateStore(fixture.configService as never);
    const provider = new WeChatPayProvider(fixture.configService as never);

    expect(store.getMappedPlatformCertCount()).toBe(2);
    expect(store.getVerifierPem(fixture.oldPlatformSerial).pem).toContain("PUBLIC KEY");
    expect(store.getVerifierPem(fixture.newPlatformSerial).pem).toContain("PUBLIC KEY");

    for (const platform of [
      { privateKeyPem: fixture.oldPlatformPrivateKeyPem, serial: fixture.oldPlatformSerial },
      { privateKeyPem: fixture.newPlatformPrivateKeyPem, serial: fixture.newPlatformSerial }
    ]) {
      const payload = fixture.createCallbackPayload({
        amount: { payer_total: 100, total: 100 },
        appid: "wx_test_app",
        mchid: "1900000001",
        out_trade_no: "PYO202606170001",
        success_time: "2026-06-17T10:00:00+08:00",
        trade_state: "SUCCESS",
        transaction_id: `4200000001202606170000000001_${platform.serial}`
      });
      const body = JSON.stringify(payload);
      const timestamp = "1710000000";
      const nonce = "callback_nonce";
      const signature = signWechatPayMessage(`${timestamp}\n${nonce}\n${body}\n`, platform.privateKeyPem);

      const result = await provider.verifyCallback(payload, {
        "Wechatpay-Nonce": nonce,
        "Wechatpay-Serial": platform.serial,
        "Wechatpay-Signature": signature,
        "Wechatpay-Timestamp": timestamp
      }, Buffer.from(body));

      expect(result.verified).toBe(true);
      expect(result.providerTradeNo).toBe("PYO202606170001");
    }

    fixture.cleanup();
  });

  it("rejects mapped certificate callbacks when the serial is not configured", async () => {
    const fixture = createWechatFixture({ mappedPlatformCerts: true });
    const provider = new WeChatPayProvider(fixture.configService as never);
    const payload = fixture.createCallbackPayload({
      amount: { payer_total: 100, total: 100 },
      appid: "wx_test_app",
      mchid: "1900000001",
      out_trade_no: "PYO202606170001",
      trade_state: "SUCCESS"
    });
    const body = JSON.stringify(payload);
    const timestamp = "1710000000";
    const nonce = "callback_nonce";
    const signature = signWechatPayMessage(`${timestamp}\n${nonce}\n${body}\n`, fixture.oldPlatformPrivateKeyPem);

    const result = await provider.verifyCallback(payload, {
      "Wechatpay-Nonce": nonce,
      "Wechatpay-Serial": "unknown_platform_serial",
      "Wechatpay-Signature": signature,
      "Wechatpay-Timestamp": timestamp
    }, Buffer.from(body));

    expect(result.verified).toBe(false);
    expect(result.errorMessage).toBe("WECHATPAY_SERIAL_NOT_CONFIGURED");

    fixture.cleanup();
  });

  it("keeps the legacy single platform certificate fallback", async () => {
    const fixture = createWechatFixture({ legacyPlatformCert: true });
    const provider = new WeChatPayProvider(fixture.configService as never);
    const payload = fixture.createCallbackPayload({
      amount: { payer_total: 100, total: 100 },
      appid: "wx_test_app",
      mchid: "1900000001",
      out_trade_no: "PYO202606170001",
      success_time: "2026-06-17T10:00:00+08:00",
      trade_state: "SUCCESS",
      transaction_id: "4200000001202606170000000001"
    });
    const body = JSON.stringify(payload);
    const timestamp = "1710000000";
    const nonce = "callback_nonce";
    const signature = signWechatPayMessage(`${timestamp}\n${nonce}\n${body}\n`, fixture.privateKeyPem);

    const result = await provider.verifyCallback(payload, {
      "Wechatpay-Nonce": nonce,
      "Wechatpay-Serial": "legacy_platform_serial",
      "Wechatpay-Signature": signature,
      "Wechatpay-Timestamp": timestamp
    }, Buffer.from(body));

    expect(result.verified).toBe(true);

    fixture.cleanup();
  });
});

function createWechatFixture(options?: { legacyPlatformCert?: boolean; mappedPlatformCerts?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "wechat-pay-provider-"));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const privateKeyPath = join(dir, "apiclient_key.pem");
  const publicKeyPath = join(dir, "wechatpay_public_key.pem");
  const apiV3Key = "12345678901234567890123456789012";

  writeFileSync(privateKeyPath, privateKeyPem);
  writeFileSync(publicKeyPath, publicKeyPem);

  const values: Record<string, string> = {
    WECHAT_PAY_API_V3_KEY: apiV3Key,
    WECHAT_PAY_APP_ID: "wx_test_app",
    WECHAT_PAY_ENABLED: "true",
    WECHAT_PAY_MCH_ID: "1900000001",
    WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH: privateKeyPath,
    WECHAT_PAY_MERCHANT_SERIAL_NO: "serial_test",
    WECHAT_PAY_PUBLIC_KEY_ID: "platform_public_key_id",
    WECHAT_PAY_PUBLIC_KEY_PATH: publicKeyPath
  };

  let oldPlatformPrivateKeyPem = privateKeyPem;
  let newPlatformPrivateKeyPem = privateKeyPem;
  let oldPlatformSerial = "old_platform_serial";
  let newPlatformSerial = "new_platform_serial";

  if (options?.legacyPlatformCert) {
    delete values.WECHAT_PAY_PUBLIC_KEY_ID;
    delete values.WECHAT_PAY_PUBLIC_KEY_PATH;
    values.WECHAT_PAY_PLATFORM_CERT_PATH = publicKeyPath;
  }

  if (options?.mappedPlatformCerts) {
    const oldPlatform = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const newPlatform = generateKeyPairSync("rsa", { modulusLength: 2048 });
    oldPlatformPrivateKeyPem = oldPlatform.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    newPlatformPrivateKeyPem = newPlatform.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const oldPlatformPublicKeyPem = oldPlatform.publicKey.export({ format: "pem", type: "spki" }).toString();
    const newPlatformPublicKeyPem = newPlatform.publicKey.export({ format: "pem", type: "spki" }).toString();
    const oldPlatformPublicKeyPath = join(dir, "old_platform_cert.pem");
    const newPlatformPublicKeyPath = join(dir, "new_platform_cert.pem");
    oldPlatformSerial = "old_platform_serial";
    newPlatformSerial = "new_platform_serial";

    writeFileSync(oldPlatformPublicKeyPath, oldPlatformPublicKeyPem);
    writeFileSync(newPlatformPublicKeyPath, newPlatformPublicKeyPem);

    delete values.WECHAT_PAY_PUBLIC_KEY_ID;
    delete values.WECHAT_PAY_PUBLIC_KEY_PATH;
    values.WECHAT_PAY_PLATFORM_CERTS =
      `${oldPlatformSerial}:${oldPlatformPublicKeyPath},${newPlatformSerial}:${newPlatformPublicKeyPath}`;
  }

  return {
    apiV3Key,
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
    configService: {
      get: vi.fn((key: string) => values[key])
    },
    createCallbackPayload: (plain: AnyRecord) => ({
      id: "callback-id",
      create_time: "2026-06-17T10:00:00+08:00",
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      resource: {
        algorithm: "AEAD_AES_256_GCM",
        associated_data: "transaction",
        ciphertext: encryptWechatPayResourceForTest({
          apiV3Key,
          associatedData: "transaction",
          nonce: "resource1234",
          plaintext: JSON.stringify(plain)
        }),
        nonce: "resource1234"
      },
      summary: "payment success"
    }),
    newPlatformPrivateKeyPem,
    newPlatformSerial,
    oldPlatformPrivateKeyPem,
    oldPlatformSerial,
    privateKeyPem
  };
}

// The WeChat callback payload is intentionally provider-shaped and loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;
