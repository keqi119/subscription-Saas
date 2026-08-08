import fs from "node:fs";
import path from "node:path";

import { Form } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  normalizePolicyDeleteReason,
  PolicyDeleteDialogFields
} from "../src/app/vehicle-insurance-policies/policy-delete-dialog";

describe("vehicle insurance policy correction UI", () => {
  it("requires a specific 2 to 500 character delete reason", () => {
    const html = renderToStaticMarkup(
      <Form>
        <PolicyDeleteDialogFields />
      </Form>
    );

    expect(html).toContain("删除原因");
    expect(() => normalizePolicyDeleteReason(" ")).toThrow("2 到 500");
    expect(normalizePolicyDeleteReason("  重复录入  ")).toBe("重复录入");
    expect(() => normalizePolicyDeleteReason("原".repeat(501))).toThrow("2 到 500");
  });

  it("keeps erroneous deletion under a low-frequency more menu", () => {
    const source = readSource("page.tsx");

    expect(source).toContain("PolicyDeleteDialog");
    expect(source).toContain("删除错误记录");
    expect(source).toContain("Dropdown");
    expect(source).toContain("更多");
  });

  it("uses a policy-scoped attachment form with files and an optional remark only", () => {
    const source = readSource("policy-document-panel.tsx");

    expect(source).toContain("/vehicle-insurance-policies/${policyId}/documents");
    expect(source).toContain("multiple");
    expect(source).toContain("maxCount={20}");
    expect(source).toContain("备注");
    expect(source).not.toContain('label="材料类型"');
    expect(source).not.toContain('name="customerVisible"');
    expect(source).not.toContain('name="effectiveFrom"');
    expect(source).not.toContain('name="documentType"');
  });

  it("offers preview and guarded attachment deletion", () => {
    const source = readSource("policy-document-panel.tsx");

    expect(source).toContain("boundListingSections");
    expect(source).toContain("预览");
    expect(source).toContain("删除");
    expect(source).toContain("/vehicle-documents/${document.id}");
    expect(source).toContain("onChanged");
  });
});

function readSource(fileName: string) {
  return fs.readFileSync(
    path.resolve(__dirname, `../src/app/vehicle-insurance-policies/${fileName}`),
    "utf8"
  );
}
