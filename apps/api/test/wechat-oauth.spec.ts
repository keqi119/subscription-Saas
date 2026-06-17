import { describe, expect, it, vi } from "vitest";

import { WeChatOAuthService } from "../src/wechat/wechat-oauth.service";

describe("WeChatOAuthService", () => {
  it("generates an snsapi_base URL and binds openid from a mock callback", async () => {
    const prisma = {
      customerAccount: {
        findFirst: vi.fn(async () => ({ wechatOpenId: "mock_openid_customer" })),
        update: vi.fn(async ({ data }: AnyRecord) => data)
      }
    };
    const configService = {
      get: vi.fn((key: string) => {
        const values: Record<string, string> = {
          CUSTOMER_JWT_SECRET: "customer-jwt-secret",
          PORTAL_BASE_URL: "https://app.example.com",
          WECHAT_OAUTH_MOCK_ENABLED: "true",
          WECHAT_PAY_APP_ID: "wx_test_app",
          WECHAT_PAY_APP_SECRET: "secret_should_not_be_logged",
          WECHAT_PAY_OAUTH_REDIRECT_URI: "https://api.example.com/api/portal/wechat/oauth/callback"
        };
        return values[key];
      })
    };
    const service = new WeChatOAuthService(configService as never, prisma as never);
    const currentCustomer = {
      accountStatus: "ACTIVE",
      customerAccountId: "account_a",
      customerId: "customer_a",
      phone: "13800000000"
    } as never;

    const oauth = await service.createOAuthUrl(currentCustomer, "/portal/payment-orders/payment_order_1");
    const url = new URL(oauth.authUrl.replace("#wechat_redirect", ""));
    const state = url.searchParams.get("state");

    expect(url.origin).toBe("https://open.weixin.qq.com");
    expect(url.searchParams.get("appid")).toBe("wx_test_app");
    expect(url.searchParams.get("scope")).toBe("snsapi_base");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.com/api/portal/wechat/oauth/callback");
    expect(state).toBeTruthy();

    const callback = await service.handleCallback("mock_openid_customer", state ?? undefined);

    expect(callback.redirectUrl).toBe("https://app.example.com/portal/payment-orders/payment_order_1");
    expect(prisma.customerAccount.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ wechatOpenId: "mock_openid_customer" }),
      where: { id: "account_a" }
    }));
    await expect(service.getBinding(currentCustomer)).resolves.toEqual({
      bound: true,
      wechatOpenIdMasked: "mock****omer"
    });
  });
});

// The fake Prisma service accepts loosely-shaped query/data objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;
