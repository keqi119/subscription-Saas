import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { AutoDebitController } from "../src/auto-debit/auto-debit.controller";

describe("AutoDebitController permissions", () => {
  it("separates read and manage operations", () => {
    expect(permissionFor("listMandates")).toEqual([
      PermissionCode.AUTO_DEBIT_VIEW
    ]);
    expect(permissionFor("syncMandate")).toEqual([
      PermissionCode.AUTO_DEBIT_MANAGE
    ]);
    expect(permissionFor("revokeMandate")).toEqual([
      PermissionCode.AUTO_DEBIT_MANAGE
    ]);
    expect(permissionFor("listAttempts")).toEqual([
      PermissionCode.AUTO_DEBIT_VIEW
    ]);
    for (const handler of [
      "queryAttempt",
      "requestManualDebit",
      "cancelJob",
      "setMockNextResult"
    ] as const) {
      expect(permissionFor(handler)).toEqual([
        PermissionCode.AUTO_DEBIT_EXECUTE
      ]);
    }
  });
});

function permissionFor(method: keyof AutoDebitController) {
  return Reflect.getMetadata(
    REQUIRED_PERMISSIONS_KEY,
    AutoDebitController.prototype[method]
  );
}
