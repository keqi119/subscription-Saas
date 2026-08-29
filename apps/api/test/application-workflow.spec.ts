import { ApplicationStatus, MaterialStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import type { RequestUser } from "../src/auth/auth.types";
import {
  assertCanApproveApplication,
  assertCanReviewMaterialGroupStatus,
  assertCanSubmitApplication,
  assertDeleteMaterialFileInput,
  assertReviewMaterialInput,
  canAccessScopedApplication,
  canDeleteMaterialFile,
  canEditApplication,
  getAvailableApplicationActions,
  isApprovedMaterialStatus,
  isUploadableStatus
} from "../src/customer/customer.service";

const salesUser: RequestUser = {
  id: "00000000-0000-4000-8000-000000000001",
  menus: [],
  name: "销售",
  permissions: [
    "application:view",
    "application:manage",
    "application:submit",
    "application:material_upload",
    "application:material_delete"
  ],
  roles: ["SA"],
  username: "sa"
};

const riskUser: RequestUser = {
  id: "00000000-0000-4000-8000-000000000002",
  menus: [],
  name: "风控",
  permissions: [
    "application:view",
    "application:review",
    "application:material_upload",
    "application:material_delete"
  ],
  roles: ["RC"],
  username: "rc"
};

const terminalAdminUser: RequestUser = {
  id: "00000000-0000-4000-8000-000000000003",
  menus: [],
  name: "管理员",
  permissions: [
    "application:view",
    "application:review",
    "application:submit",
    "application:material_upload",
    "application:material_delete",
    "order:create",
    "quote:create"
  ],
  roles: ["ADMIN"],
  username: "admin"
};

describe("application workflow helpers", () => {
  it("validates material review statuses and comment requirements", () => {
    expect(() => assertReviewMaterialInput(MaterialStatus.APPROVED)).not.toThrow();
    expect(() =>
      assertReviewMaterialInput(MaterialStatus.NEED_MORE_INFO, "需补充银行流水")
    ).not.toThrow();
    expect(() => assertReviewMaterialInput(MaterialStatus.REJECTED, "资料不清晰")).not.toThrow();

    expect(() => assertReviewMaterialInput(MaterialStatus.NEED_MORE_INFO)).toThrow();
    expect(() => assertReviewMaterialInput(MaterialStatus.REJECTED)).toThrow();
    expect(() => assertReviewMaterialInput(MaterialStatus.PENDING, "备注")).toThrow();
  });

  it("models application submit and upload state gates", () => {
    expect(canEditApplication(ApplicationStatus.DRAFT)).toBe(true);
    expect(canEditApplication(ApplicationStatus.NEED_MORE_INFO)).toBe(true);
    expect(canEditApplication(ApplicationStatus.SUBMITTED)).toBe(false);

    expect(isUploadableStatus(ApplicationStatus.DRAFT)).toBe(true);
    expect(isUploadableStatus(ApplicationStatus.SUBMITTED)).toBe(true);
    expect(isUploadableStatus(ApplicationStatus.NEED_MORE_INFO)).toBe(true);
    expect(isUploadableStatus(ApplicationStatus.REJECTED)).toBe(false);
  });

  it("uses new material approval status while keeping VERIFIED compatible", () => {
    expect(isApprovedMaterialStatus(MaterialStatus.APPROVED)).toBe(true);
    expect(isApprovedMaterialStatus(MaterialStatus.VERIFIED)).toBe(true);
    expect(isApprovedMaterialStatus(MaterialStatus.NEED_MORE_INFO)).toBe(false);
    expect(isApprovedMaterialStatus(MaterialStatus.REJECTED)).toBe(false);
  });

  it("keeps approval actions away from sales while allowing risk review", () => {
    const submittedApplication = {
      salesUserId: salesUser.id,
      status: ApplicationStatus.SUBMITTED
    };

    expect(getAvailableApplicationActions(submittedApplication, salesUser)).not.toContain(
      "approve"
    );
    expect(getAvailableApplicationActions(submittedApplication, riskUser)).toEqual(
      expect.arrayContaining(["reviewMaterial", "approve", "needMoreInfo", "reject"])
    );
  });

  it("exposes no application mutations after a formal order exists", () => {
    const applicationWithOrder = {
      orders: [{ deletedAt: null }],
      planConfirmStatus: "CONFIRMED" as const,
      salesUserId: salesUser.id,
      status: ApplicationStatus.APPROVED
    };

    expect(getAvailableApplicationActions(applicationWithOrder, terminalAdminUser)).toEqual([]);
    expect(canDeleteMaterialFile(applicationWithOrder, terminalAdminUser)).toBe(false);
  });

  it("scopes sales users to their own applications", () => {
    expect(
      canAccessScopedApplication({ salesUserId: salesUser.id }, salesUser)
    ).toBe(true);
    expect(
      canAccessScopedApplication({ salesUserId: "00000000-0000-4000-8000-000000000999" }, salesUser)
    ).toBe(false);
    expect(
      canAccessScopedApplication({ salesUserId: "00000000-0000-4000-8000-000000000999" }, riskUser)
    ).toBe(true);
  });

  it("validates delete reasons and delete permissions by status", () => {
    expect(assertDeleteMaterialFileInput("duplicate upload")).toBe("duplicate upload");
    expect(() => assertDeleteMaterialFileInput(" ")).toThrow();

    expect(
      canDeleteMaterialFile(
        { salesUserId: salesUser.id, status: ApplicationStatus.DRAFT },
        salesUser
      )
    ).toBe(true);
    expect(
      canDeleteMaterialFile(
        { salesUserId: salesUser.id, status: ApplicationStatus.SUBMITTED },
        salesUser
      )
    ).toBe(false);
    expect(
      canDeleteMaterialFile(
        { salesUserId: salesUser.id, status: ApplicationStatus.SUBMITTED },
        riskUser
      )
    ).toBe(true);
  });

  it("keeps one material group with multiple effective files in view models", () => {
    const group = {
      files: [
        { isDeleted: false },
        { isDeleted: false }
      ],
      materialType: "ID_CARD",
      required: true
    };

    expect(() =>
      assertCanReviewMaterialGroupStatus(group as never, MaterialStatus.APPROVED)
    ).not.toThrow();
  });

  it("blocks approving a required material group without active files", () => {
    const group = {
      files: [{ isDeleted: true }],
      materialType: "ID_CARD",
      required: true
    };

    expect(() =>
      assertCanReviewMaterialGroupStatus(group as never, MaterialStatus.APPROVED)
    ).toThrow();
  });

  it("allows approving credit authorization as an optional material group without active files", () => {
    const group = {
      files: [],
      materialType: "CREDIT_AUTH",
      required: true
    };

    expect(() =>
      assertCanReviewMaterialGroupStatus(group as never, MaterialStatus.APPROVED)
    ).not.toThrow();
  });

  it("checks only ID card and driver license before submit and approve", () => {
    const baseApplication = {
      materialGroups: [
        materialGroup("ID_CARD", MaterialStatus.APPROVED, [false]),
        materialGroup("DRIVER_LICENSE", MaterialStatus.PENDING, [true])
      ]
    };

    expect(() => assertCanSubmitApplication(baseApplication as never)).toThrow(
      /Missing required materials/
    );

    const submittedApplication = {
      materialGroups: [
        materialGroup("ID_CARD", MaterialStatus.APPROVED, [false]),
        materialGroup("DRIVER_LICENSE", MaterialStatus.PENDING, [false])
      ]
    };

    expect(() => assertCanSubmitApplication(submittedApplication as never)).not.toThrow();
    expect(() => assertCanApproveApplication(submittedApplication as never)).toThrow(
      /Required materials are not approved/
    );

    const approvableApplication = {
      materialGroups: [
        materialGroup("ID_CARD", MaterialStatus.APPROVED, [false]),
        materialGroup("DRIVER_LICENSE", MaterialStatus.APPROVED, [false]),
        materialGroup("CREDIT_AUTH", MaterialStatus.PENDING, [false])
      ]
    };

    expect(() => assertCanSubmitApplication(approvableApplication as never)).not.toThrow();
    expect(() => assertCanApproveApplication(approvableApplication as never)).not.toThrow();
  });
});

function materialGroup(materialType: string, reviewStatus: MaterialStatus, deletedFlags: boolean[]) {
  return {
    files: deletedFlags.map((isDeleted) => ({ isDeleted })),
    materialType,
    reviewStatus
  };
}
