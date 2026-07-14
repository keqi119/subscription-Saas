import { describe, expect, it } from "vitest";

import { toApplicationView, toCustomerView } from "../src/customer/customer.service";

describe("customer views", () => {
  it("serializes customer details without leaking bigint values", () => {
    const view = toCustomerView({
      applications: [],
      createdAt: new Date("2026-05-30T00:00:00.000Z"),
      customerNo: "CUS2026053000001",
      customerType: "PERSONAL",
      grade: null,
      id: "00000000-0000-4000-8000-000000000101",
      identity: null,
      mobile: "13800000000",
      name: "Test Customer",
      ownerUser: { id: "00000000-0000-4000-8000-000000000001", name: "Sales", username: "sa" },
      profile: {
        monthlyIncomeAmount: 1200000n
      },
      remark: null,
      riskScore: null,
      sourceChannel: "offline",
      status: "LEAD"
    } as unknown as Parameters<typeof toCustomerView>[0]);

    expect(view.profile?.monthlyIncomeAmount).toBe(1200000);
  });

  it("serializes application material groups for API responses", () => {
    const view = toApplicationView({
      actionLogs: [],
      applicationNo: "APP2026053000001",
      approvedAt: null,
      createdAt: new Date("2026-05-30T00:00:00.000Z"),
      customer: {
        customerNo: "CUS2026053000001",
        id: "00000000-0000-4000-8000-000000000101",
        identity: null,
        mobile: "13800000000",
        name: "Test Customer",
        ownerUserId: "00000000-0000-4000-8000-000000000001",
        profile: null,
        sourceChannel: "offline",
        status: "UNDER_REVIEW"
      },
      customerId: "00000000-0000-4000-8000-000000000101",
      id: "00000000-0000-4000-8000-000000000201",
      intendedModel: "ET5",
      intendedPeriodMonths: 12,
      materialGroups: [
        {
          createdAt: new Date("2026-05-30T00:00:00.000Z"),
          createdBy: null,
          deletedAt: null,
          files: [
            {
              applicationId: "00000000-0000-4000-8000-000000000201",
              createdAt: new Date("2026-05-30T00:00:00.000Z"),
              createdBy: null,
              deletedAt: null,
              deletedBy: null,
              deleter: null,
              deleteReason: null,
              file: {
                bucket: "application-materials",
                createdAt: new Date("2026-05-30T00:00:00.000Z"),
                id: "00000000-0000-4000-8000-000000000301",
                mimeType: "application/pdf",
                objectKey: "2026-05-30/file.pdf",
                originalName: "file.pdf",
                sizeBytes: 2048n,
                uploadedBy: "00000000-0000-4000-8000-000000000001"
              },
              fileId: "00000000-0000-4000-8000-000000000301",
              fileName: "file.pdf",
              id: "00000000-0000-4000-8000-000000000501",
              isDeleted: false,
              materialGroupId: "00000000-0000-4000-8000-000000000401",
              materialType: "BANK_FLOW",
              mimeType: "application/pdf",
              sizeBytes: 2048n,
              updatedAt: new Date("2026-05-30T00:00:00.000Z"),
              updatedBy: null,
              uploadedAt: new Date("2026-05-30T00:00:00.000Z"),
              uploadedBy: "00000000-0000-4000-8000-000000000001",
              uploader: {
                id: "00000000-0000-4000-8000-000000000001",
                name: "Sales",
                username: "sa"
              }
            }
          ],
          id: "00000000-0000-4000-8000-000000000401",
          materialName: "Bank Flow",
          materialType: "BANK_FLOW",
          required: false,
          reviewComment: null,
          reviewedAt: null,
          reviewedBy: null,
          reviewer: null,
          reviewStatus: "PENDING",
          updatedAt: new Date("2026-05-30T00:00:00.000Z"),
          updatedBy: null
        },
        {
          createdAt: new Date("2026-05-30T00:00:00.000Z"),
          createdBy: null,
          deletedAt: null,
          files: [],
          id: "00000000-0000-4000-8000-000000000402",
          materialName: "Credit Authorization",
          materialType: "CREDIT_AUTH",
          required: true,
          reviewComment: null,
          reviewedAt: null,
          reviewedBy: null,
          reviewer: null,
          reviewStatus: "PENDING",
          updatedAt: new Date("2026-05-30T00:00:00.000Z"),
          updatedBy: null
        }
      ],
      materials: [],
      rejectedReason: null,
      riskResults: [],
      salesUser: { id: "00000000-0000-4000-8000-000000000001", name: "Sales", username: "sa" },
      salesUserId: "00000000-0000-4000-8000-000000000001",
      status: "SUBMITTED",
      submittedAt: new Date("2026-05-30T00:00:00.000Z")
    } as unknown as Parameters<typeof toApplicationView>[0]);

    expect(view.materials[0]?.files[0]?.sizeBytes).toBe(2048);
    expect(view.materials.find((group) => group.materialType === "CREDIT_AUTH")?.required).toBe(false);
  });
});
