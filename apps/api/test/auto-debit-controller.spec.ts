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
  });
});

function permissionFor(method: keyof AutoDebitController) {
  return Reflect.getMetadata(
    REQUIRED_PERMISSIONS_KEY,
    AutoDebitController.prototype[method]
  );
}
