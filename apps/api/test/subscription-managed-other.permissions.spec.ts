import { PermissionCode } from "@subscription-saas/shared";
import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { SubscriptionChangeController } from "../src/subscription-change/subscription-change.controller";
import { SubscriptionManagedOtherService } from "../src/subscription-change/subscription-managed-other.service";
import { describe, expect, it, vi } from "vitest";

describe("managed-other permissions", () => {
  it.each([
    ["approve", PermissionCode.SUBSCRIPTION_CHANGE_APPROVE],
    ["execute", PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE]
  ] as const)("rejects %s before opening a transaction", async (method, requiredPermission) => {
    const transaction = vi.fn();
    const service = new SubscriptionManagedOtherService(
      { $transaction: transaction } as never,
      {} as never,
      { enabled: true, now: () => new Date(), quoteValidityHours: 72 } as never
    );
    const actor = {
      id: "operator-1",
      menus: [],
      name: "Operator",
      permissions: [],
      roles: [],
      username: "operator"
    };
    const input =
      method === "approve"
        ? {
            approvalReason: "reviewed",
            approvalReference: "APR-1",
            idempotencyKey: "managed-permission-1",
            version: 0
          }
        : {
            executionNote: "execute",
            idempotencyKey: "managed-permission-1",
            version: 0
          };

    await expect(
      service[method]("change-1", input as never, actor as never, {})
    ).rejects.toMatchObject({
      code: "SUBSCRIPTION_CHANGE_PERMISSION_DENIED"
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(requiredPermission).toBeTruthy();
  });

  it("protects the managed approval and execution controller endpoints", () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        SubscriptionChangeController.prototype.approveManagedOther
      )
    ).toEqual([PermissionCode.SUBSCRIPTION_CHANGE_APPROVE]);
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        SubscriptionChangeController.prototype.executeManagedOther
      )
    ).toEqual([PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE]);
  });
});
