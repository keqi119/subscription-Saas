import {
  ESignDocumentType,
  ESignSigningStage,
  ESignSlotId,
  Prisma,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("return-manifest e-sign durable schema", () => {
  it("owns a typed signing stage, signer slots, durable job, and semantic callback key", () => {
    expect(Object.values(ESignDocumentType)).toContain("RETURN_MANIFEST");
    expect(Object.values(ESignSigningStage)).toContain("STAGE6_RETURN_MANIFEST");
    expect(Object.values(ESignSlotId)).toEqual(
      expect.arrayContaining(["RETURN_MANIFEST_CUSTOMER", "RETURN_MANIFEST_PLATFORM"])
    );
    expect(Object.values(SubscriptionAutomationJobType)).toContain("CLOSURE_RETURN_MANIFEST_ESIGN");
    const callback = Prisma.dmmf.datamodel.models.find(
      ({ name }) => name === "ContractESignCallbackLog"
    );
    expect(callback?.fields.some(({ name }) => name === "operationKey")).toBe(true);
  });

  it("uses one forward-only migration without inferred data repair", () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260822030000_stage1_p0_return_manifest_esign_durability/migration.sql"
      ),
      "utf8"
    );
    expect(sql).toContain("'RETURN_MANIFEST'");
    expect(sql).toContain("'STAGE6_RETURN_MANIFEST'");
    expect(sql).toContain("'CLOSURE_RETURN_MANIFEST_ESIGN'");
    expect(sql).toContain('ADD COLUMN "operation_key"');
    expect(sql).toContain("contract_esign_callback_log_provider_operation_key_key");
    expect(sql).not.toMatch(/\bUPDATE\s+/i);
  });
});
