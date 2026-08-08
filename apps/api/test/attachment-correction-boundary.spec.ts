import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ApplicationStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import type { RequestUser } from "../src/auth/auth.types";
import {
  assertDeleteMaterialFileInput,
  canDeleteMaterialFile
} from "../src/customer/customer.service";

describe("attachment correction boundaries", () => {
  it("keeps portal profile deletion as a soft-delete operation", () => {
    const method = methodSource(
      source("portal/portal-profile-material.service.ts"),
      "async deleteMaterial",
      "async previewMaterial"
    );

    expect(method).toContain("deletedAt: new Date()");
    expect(method).toContain("materialStatus: CustomerProfileMaterialStatus.ARCHIVED");
    expect(method).not.toContain("deleteObject");
  });

  it("keeps a dedicated vehicle listing media delete route", () => {
    const controller = source("vehicle/vehicle-listing.controller.ts");

    expect(controller).toMatch(
      /@Delete\("vehicles\/:id\/listing-media\/:mediaId"\)[\s\S]*?deleteMedia\(/
    );
    expect(controller).toContain("return this.vehicleListingService.deleteMedia(id, mediaId)");
  });

  it("keeps application material deletion permission- and reason-controlled", () => {
    const user: RequestUser = {
      id: "sales-1",
      menus: [],
      name: "销售",
      permissions: ["application:material_delete"],
      roles: ["SA"],
      username: "sales"
    };

    expect(
      canDeleteMaterialFile(
        { salesUserId: user.id, status: ApplicationStatus.DRAFT },
        user
      )
    ).toBe(true);
    expect(() => assertDeleteMaterialFileInput(" ")).toThrow();
    expect(assertDeleteMaterialFileInput("重复上传")).toBe("重复上传");
  });

  it("soft-deletes vehicle documents without deleting stored objects and guards bindings", () => {
    const method = methodSource(
      source("vehicle-insurance/vehicle-insurance.service.ts"),
      "async deleteDocument",
      "async previewDocument"
    );

    expect(method).toContain("await this.assertDocumentsNotBound([before.id])");
    expect(method).toContain("deletedAt");
    expect(method).toContain("documentStatus: VehicleDocumentStatus.ARCHIVED");
    expect(method).not.toContain("storageService.deleteObject");
  });
});

function source(relativePath: string) {
  return readFileSync(resolve(__dirname, `../src/${relativePath}`), "utf8");
}

function methodSource(contents: string, start: string, end: string) {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return contents.slice(startIndex, endIndex);
}
