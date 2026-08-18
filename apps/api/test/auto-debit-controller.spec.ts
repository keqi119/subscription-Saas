import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { AutoDebitController } from "../src/auto-debit/auto-debit.controller";

describe("AutoDebitController permissions", () => {
  it("exposes historical mandates and attempts as view-only operations", () => {
    for (const handler of ["listMandates", "listAttempts"] as const) {
      expect(permissionFor(handler)).toEqual([PermissionCode.AUTO_DEBIT_VIEW]);
    }
  });
});

function permissionFor(method: keyof AutoDebitController) {
  return Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, AutoDebitController.prototype[method]);
}
