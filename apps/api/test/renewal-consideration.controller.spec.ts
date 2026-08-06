import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { RenewalConsiderationController } from "../src/subscription-change/renewal-consideration.controller";
import { SubscriptionChangeModule } from "../src/subscription-change/subscription-change.module";

describe("RenewalConsiderationController", () => {
  it("compiles the subscription change module with worker dependencies", async () => {
    process.env.CUSTOMER_JWT_SECRET ??= "subscription-change-module-test-secret";
    process.env.DATABASE_URL ??=
      "postgresql://test:test@127.0.0.1:5432/subscription_saas?schema=public";
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), SubscriptionChangeModule]
    }).compile();

    await moduleRef.close();
  });

  it("requires change-view permission for list and notification-manage for reminder retry", () => {
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, RenewalConsiderationController.prototype.list)
    ).toEqual([PermissionCode.SUBSCRIPTION_CHANGE_VIEW]);
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        RenewalConsiderationController.prototype.retryReminder
      )
    ).toEqual([PermissionCode.NOTIFICATION_MANAGE]);
  });
});
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
