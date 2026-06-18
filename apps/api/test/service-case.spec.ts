import { BadRequestException } from "@nestjs/common";
import { ServiceCaseStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { createServiceCaseHarness, requestContext } from "./portal-service-case.spec";

describe("service case back office", () => {
  it("lists and gets service cases for back-office users", async () => {
    const harness = createServiceCaseHarness();
    harness.addCase({ customerId: "customer-a", id: "case-a", orderId: "order-a" });
    harness.addCase({ customerId: "customer-b", id: "case-b", orderId: "order-b" });

    const list = await harness.service.listAdminServiceCases({});
    const detail = await harness.service.getAdminServiceCase("case-b");

    expect(list.total).toBe(2);
    expect(detail).toMatchObject({
      customer: { name: "李四" },
      id: "case-b",
      order: { orderNo: "ORD-B" }
    });
  });

  it("accepts service cases and assigns them to staff", async () => {
    const harness = createServiceCaseHarness();
    harness.addCase({ id: "case-a", orderId: "order-a" });

    const result = await harness.service.acceptServiceCase(
      "case-a",
      { remark: "已联系客户" },
      adminUser(),
      requestContext()
    );

    expect(result.caseStatus).toBe(ServiceCaseStatus.ACCEPTED);
    expect(result.actions.at(-1)).toMatchObject({
      actionType: "ACCEPT",
      actorType: "STAFF",
      remark: "已联系客户"
    });
  });

  it("updates status only along the configured service-case flow", async () => {
    const harness = createServiceCaseHarness();
    harness.addCase({ caseStatus: ServiceCaseStatus.ACCEPTED, id: "case-a", orderId: "order-a" });

    const progress = await harness.service.updateServiceCaseStatus(
      "case-a",
      { remark: "救援处理中", toStatus: ServiceCaseStatus.IN_PROGRESS },
      adminUser(),
      requestContext()
    );

    expect(progress.caseStatus).toBe(ServiceCaseStatus.IN_PROGRESS);
    await expect(
      harness.service.updateServiceCaseStatus(
        "case-a",
        { toStatus: ServiceCaseStatus.SUBMITTED },
        adminUser(),
        requestContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("adds handling notes and closes service cases", async () => {
    const harness = createServiceCaseHarness();
    harness.addCase({ caseStatus: ServiceCaseStatus.IN_PROGRESS, id: "case-a", orderId: "order-a" });

    const noted = await harness.service.addServiceCaseAction(
      "case-a",
      { remark: "已联系救援师傅" },
      adminUser(),
      requestContext()
    );
    const closed = await harness.service.closeServiceCase(
      "case-a",
      { closeRemark: "客户确认处理完成" },
      adminUser(),
      requestContext()
    );

    expect(noted.actions.at(-1)).toMatchObject({ actionType: "ADD_NOTE" });
    expect(closed.caseStatus).toBe(ServiceCaseStatus.CLOSED);
    expect(closed.actions.at(-1)).toMatchObject({ actionType: "CLOSE" });
  });
});

function adminUser() {
  return {
    id: "00000000-0000-4000-8000-000000000099",
    menus: [],
    name: "运营",
    permissions: ["service_case:view", "service_case:manage"],
    roles: ["OP"],
    username: "op"
  };
}
