import assert from "node:assert/strict";
import test from "node:test";

const core = await import("./stage1c-access-baseline-core.mjs").catch(() => ({}));

function requiredExport(name) {
  assert.equal(typeof core[name], "function", `${name} must be exported`);
  return core[name];
}

test("publishes the exact fourteen permission-only definitions including Task 6", () => {
  assert.deepEqual(
    core.STAGE1C_PERMISSION_DEFINITIONS.map(({ action, code, module, name }) => ({
      action,
      code,
      module,
      name
    })),
    [
      { action: "view", code: "asset_facts:view", module: "asset_facts", name: "查看车辆事实台账" },
      {
        action: "owner_manage",
        code: "asset_owner:manage",
        module: "asset_facts",
        name: "管理车辆权属期间"
      },
      {
        action: "period_manage",
        code: "vehicle_period:manage",
        module: "asset_facts",
        name: "修复车辆订阅期间"
      },
      {
        action: "view",
        code: "asset_operations:view",
        module: "asset_operations",
        name: "查看资产运营工单与限制"
      },
      {
        action: "work_order_manage",
        code: "asset_work_order:manage",
        module: "asset_operations",
        name: "管理资产运营工单"
      },
      {
        action: "restriction_manage",
        code: "vehicle_restriction:manage",
        module: "asset_operations",
        name: "管理车辆运营限制"
      },
      {
        action: "restriction_release",
        code: "vehicle_restriction:release",
        module: "asset_operations",
        name: "解除车辆运营限制"
      },
      {
        action: "restriction_approve_release",
        code: "vehicle_restriction:approve_release",
        module: "asset_operations",
        name: "审批高风险车辆运营限制解除"
      },
      {
        action: "view",
        code: "vehicle_cost_ledger:view",
        module: "vehicle_cost_ledger",
        name: "查看车辆成本台账"
      },
      {
        action: "confirm",
        code: "vehicle_cost_ledger:confirm",
        module: "vehicle_cost_ledger",
        name: "确认车辆成本台账"
      },
      {
        action: "reverse",
        code: "vehicle_cost_ledger:reverse",
        module: "vehicle_cost_ledger",
        name: "冲正车辆成本台账"
      },
      {
        action: "view",
        code: "business_exception:view",
        module: "business_exception",
        name: "查看业务例外审批"
      },
      {
        action: "request",
        code: "business_exception:request",
        module: "business_exception",
        name: "发起业务例外审批"
      },
      {
        action: "approve",
        code: "business_exception:approve",
        module: "business_exception",
        name: "审批业务例外"
      }
    ]
  );
});

test("plans the exact positive and negative Stage 1C role matrix without touching unrelated grants", () => {
  const classify = requiredExport("classifyStage1cAccessBaseline");
  const snapshot = baselineSnapshot();
  snapshot.rolePermissions.push(
    grant("SA", "asset_facts:view"),
    grant("RC", "asset_owner:manage"),
    grant("CS", "vehicle_period:manage"),
    grant("FI", "unrelated:keep")
  );

  const report = classify(snapshot);

  assert.deepEqual(report.blockers, []);
  assert.deepEqual(activeMatrixAfterPlan(snapshot, report), {
    ADMIN: [
      "asset_facts:view",
      "asset_operations:view",
      "asset_owner:manage",
      "asset_work_order:manage",
      "business_exception:approve",
      "business_exception:request",
      "business_exception:view",
      "vehicle_cost_ledger:confirm",
      "vehicle_cost_ledger:reverse",
      "vehicle_cost_ledger:view",
      "vehicle_period:manage",
      "vehicle_restriction:approve_release",
      "vehicle_restriction:manage",
      "vehicle_restriction:release"
    ],
    AS: [
      "asset_facts:view",
      "asset_operations:view",
      "asset_owner:manage",
      "asset_work_order:manage",
      "business_exception:request",
      "business_exception:view",
      "vehicle_cost_ledger:confirm",
      "vehicle_cost_ledger:view",
      "vehicle_period:manage",
      "vehicle_restriction:approve_release",
      "vehicle_restriction:manage",
      "vehicle_restriction:release"
    ],
    CS: [],
    FI: [
      "asset_facts:view",
      "asset_operations:view",
      "business_exception:request",
      "business_exception:view",
      "vehicle_cost_ledger:confirm",
      "vehicle_cost_ledger:reverse",
      "vehicle_cost_ledger:view"
    ],
    GM: [
      "asset_facts:view",
      "asset_operations:view",
      "business_exception:approve",
      "business_exception:view",
      "vehicle_cost_ledger:reverse",
      "vehicle_cost_ledger:view",
      "vehicle_restriction:approve_release"
    ],
    OP: [
      "asset_facts:view",
      "asset_operations:view",
      "asset_work_order:manage",
      "business_exception:request",
      "business_exception:view",
      "vehicle_cost_ledger:confirm",
      "vehicle_cost_ledger:view",
      "vehicle_period:manage",
      "vehicle_restriction:manage",
      "vehicle_restriction:release"
    ],
    RC: [
      "asset_operations:view",
      "business_exception:request",
      "business_exception:view",
      "vehicle_cost_ledger:view"
    ],
    SA: []
  });
  assert.equal(
    report.rolePermissions.find(
      ({ permissionCode, roleCode }) => roleCode === "FI" && permissionCode === "unrelated:keep"
    ),
    undefined
  );
});

test("revives only required Stage 1C permissions and grants while revoking only prohibited Stage 1C grants", () => {
  const classify = requiredExport("classifyStage1cAccessBaseline");
  const snapshot = baselineSnapshot();
  snapshot.permissions.find(({ code }) => code === "asset_facts:view").status = "INACTIVE";
  snapshot.permissions.find(({ code }) => code === "asset_facts:view").deletedAt = "2026-08-01";
  snapshot.rolePermissions.push(
    grant("ADMIN", "asset_facts:view", "2026-08-01"),
    grant("SA", "asset_facts:view"),
    grant("SA", "unrelated:keep")
  );

  const report = classify(snapshot);

  assert.equal(
    report.permissions.find(({ code }) => code === "asset_facts:view").disposition,
    "CONVERGE"
  );
  assert.equal(
    report.rolePermissions.find(
      ({ permissionCode, roleCode }) =>
        permissionCode === "asset_facts:view" && roleCode === "ADMIN"
    ).disposition,
    "REVIVE"
  );
  assert.equal(
    report.rolePermissions.find(
      ({ permissionCode, roleCode }) => permissionCode === "asset_facts:view" && roleCode === "SA"
    ).disposition,
    "REVOKE"
  );
  assert.equal(
    report.rolePermissions.some(({ permissionCode }) => permissionCode === "unrelated:keep"),
    false
  );
});

test("missing, inactive, and soft-deleted required roles are blockers before writes", () => {
  const classify = requiredExport("classifyStage1cAccessBaseline");

  for (const mutate of [
    (snapshot) =>
      snapshot.roles.splice(
        snapshot.roles.findIndex(({ code }) => code === "RC"),
        1
      ),
    (snapshot) => {
      snapshot.roles.find(({ code }) => code === "FI").status = "INACTIVE";
    },
    (snapshot) => {
      snapshot.roles.find(({ code }) => code === "GM").deletedAt = "2026-08-01";
    }
  ]) {
    const snapshot = baselineSnapshot();
    mutate(snapshot);
    const report = classify(snapshot);
    assert.equal(report.blockers.length, 1);
    assert.match(report.blockers[0].code, /^ROLE_(MISSING|INACTIVE)$/);
  }
});

test("permission identity drift is a blocker while lifecycle drift remains convergent", () => {
  const classify = requiredExport("classifyStage1cAccessBaseline");
  const identityDrift = baselineSnapshot();
  identityDrift.permissions.find(({ code }) => code === "asset_operations:view").module = "other";
  const blocked = classify(identityDrift);
  assert.deepEqual(blocked.blockers, [
    { code: "PERMISSION_IDENTITY_DRIFT", permissionCode: "asset_operations:view" }
  ]);

  const lifecycleDrift = baselineSnapshot();
  lifecycleDrift.permissions.find(({ code }) => code === "asset_operations:view").status =
    "INACTIVE";
  lifecycleDrift.permissions.find(({ code }) => code === "asset_operations:view").deletedAt =
    "2026-08-01";
  const convergent = classify(lifecycleDrift);
  assert.deepEqual(convergent.blockers, []);
  assert.equal(
    convergent.permissions.find(({ code }) => code === "asset_operations:view").disposition,
    "CONVERGE"
  );

  const task6IdentityDrift = baselineSnapshot();
  task6IdentityDrift.permissions.find(({ code }) => code === "business_exception:view").action =
    "approve";
  assert.deepEqual(classify(task6IdentityDrift).blockers, [
    { code: "PERMISSION_IDENTITY_DRIFT", permissionCode: "business_exception:view" }
  ]);
});

test("default classification preserves legacy PLATFORM owner create, converge, replay, and blockers", () => {
  const classify = requiredExport("classifyStage1cAccessBaseline");
  const missing = classify(baselineSnapshot());

  assert.deepEqual(missing.platformOwner, {
    disposition: "CREATE",
    name: "平台资产主体",
    ownerNo: "PLATFORM",
    ownerType: "PLATFORM",
    status: "ACTIVE"
  });
  assert.equal(missing.ownershipPeriodCount, 7);

  const inactiveSnapshot = baselineSnapshot();
  inactiveSnapshot.assetOwners.push({ ...platformOwner(), status: "INACTIVE" });
  assert.equal(classify(inactiveSnapshot).platformOwner.disposition, "CONVERGE");

  const replaySnapshot = baselineSnapshot();
  replaySnapshot.assetOwners.push(platformOwner());
  assert.equal(classify(replaySnapshot).platformOwner.disposition, "UNCHANGED");

  for (const owner of [
    { ...platformOwner(), name: "另一法律主体" },
    { ...platformOwner(), ownerType: "EXTERNAL_COMPANY" },
    { ...platformOwner(), ownerNo: "OTHER-PLATFORM" }
  ]) {
    const snapshot = baselineSnapshot();
    snapshot.assetOwners.push(owner);
    const report = classify(snapshot);
    assert.equal(report.platformOwner.disposition, "BLOCKED");
    assert.equal(report.blockers.length, 1);
    assert.match(report.blockers[0].code, /^PLATFORM_OWNER_(IDENTITY_DRIFT|COLLISION)$/);
  }
});

test("explicit permission-only classification never reads or reports ownership state", () => {
  const classify = requiredExport("classifyStage1cAccessBaseline");
  const snapshot = baselineSnapshot();
  Object.defineProperties(snapshot, {
    assetOwners: {
      get() {
        throw new Error("permission-only classification touched assetOwners");
      }
    },
    ownershipPeriodCount: {
      get() {
        throw new Error("permission-only classification touched ownershipPeriodCount");
      }
    }
  });

  const report = classify(snapshot, { permissionsOnly: true });

  assert.deepEqual(report.platformOwner, {
    disposition: "NOT_MANAGED"
  });
  assert.equal("ownershipPeriodCount" in report, false);
  assert.deepEqual(report.blockers, []);
});

function baselineSnapshot() {
  const roleCodes = ["ADMIN", "AS", "OP", "FI", "GM", "SA", "RC", "CS"];
  const permissions = [
    permission("asset_facts:view", "查看车辆事实台账", "view"),
    permission("asset_owner:manage", "管理车辆权属期间", "owner_manage"),
    permission("vehicle_period:manage", "修复车辆订阅期间", "period_manage"),
    permission("asset_operations:view", "查看资产运营工单与限制", "view", "asset_operations"),
    permission(
      "asset_work_order:manage",
      "管理资产运营工单",
      "work_order_manage",
      "asset_operations"
    ),
    permission(
      "vehicle_restriction:manage",
      "管理车辆运营限制",
      "restriction_manage",
      "asset_operations"
    ),
    permission(
      "vehicle_restriction:release",
      "解除车辆运营限制",
      "restriction_release",
      "asset_operations"
    ),
    permission(
      "vehicle_restriction:approve_release",
      "审批高风险车辆运营限制解除",
      "restriction_approve_release",
      "asset_operations"
    ),
    permission("vehicle_cost_ledger:view", "查看车辆成本台账", "view", "vehicle_cost_ledger"),
    permission("vehicle_cost_ledger:confirm", "确认车辆成本台账", "confirm", "vehicle_cost_ledger"),
    permission("vehicle_cost_ledger:reverse", "冲正车辆成本台账", "reverse", "vehicle_cost_ledger"),
    permission("business_exception:view", "查看业务例外审批", "view", "business_exception"),
    permission("business_exception:request", "发起业务例外审批", "request", "business_exception"),
    permission("business_exception:approve", "审批业务例外", "approve", "business_exception"),
    permission("unrelated:keep", "不相关权限", "keep", "other")
  ];
  return {
    assetOwners: [],
    ownershipPeriodCount: 7,
    permissions,
    rolePermissions: [],
    roles: roleCodes.map((code) => ({
      code,
      deletedAt: null,
      id: `role-${code}`,
      status: "ACTIVE"
    }))
  };
}

function permission(code, name, action, module = "asset_facts") {
  return {
    action,
    code,
    deletedAt: null,
    id: `permission-${code}`,
    module,
    name,
    status: "ACTIVE"
  };
}

function grant(roleCode, permissionCode, deletedAt = null) {
  return {
    deletedAt,
    id: `grant-${roleCode}-${permissionCode}`,
    permissionCode,
    permissionId: `permission-${permissionCode}`,
    roleCode,
    roleId: `role-${roleCode}`
  };
}

function platformOwner() {
  return {
    id: "owner-platform",
    legalName: null,
    name: "平台资产主体",
    ownerNo: "PLATFORM",
    ownerType: "PLATFORM",
    registrationIdentifier: null,
    status: "ACTIVE"
  };
}

function activeMatrixAfterPlan(snapshot, report) {
  const stageCodes = new Set(report.permissions.map(({ code }) => code));
  const active = new Set(
    snapshot.rolePermissions
      .filter(
        ({ deletedAt, permissionCode }) => deletedAt === null && stageCodes.has(permissionCode)
      )
      .map(({ permissionCode, roleCode }) => `${roleCode}:${permissionCode}`)
  );
  for (const row of report.rolePermissions) {
    const key = `${row.roleCode}:${row.permissionCode}`;
    if (row.disposition === "GRANT" || row.disposition === "REVIVE") active.add(key);
    if (row.disposition === "REVOKE") active.delete(key);
  }
  return Object.fromEntries(
    ["ADMIN", "AS", "CS", "FI", "GM", "OP", "RC", "SA"].map((roleCode) => [
      roleCode,
      [...active]
        .filter((key) => key.startsWith(`${roleCode}:`))
        .map((key) => key.slice(roleCode.length + 1))
        .sort()
    ])
  );
}
