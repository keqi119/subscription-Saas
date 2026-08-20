import assert from "node:assert/strict";
import test from "node:test";

const core = await import("./stage1c-access-baseline-core.mjs").catch(() => ({}));

function requiredExport(name) {
  assert.equal(typeof core[name], "function", `${name} must be exported`);
  return core[name];
}

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
    ADMIN: ["asset_facts:view", "asset_owner:manage", "vehicle_period:manage"],
    AS: ["asset_facts:view", "asset_owner:manage", "vehicle_period:manage"],
    CS: [],
    FI: ["asset_facts:view"],
    GM: ["asset_facts:view"],
    OP: ["asset_facts:view", "vehicle_period:manage"],
    RC: [],
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

test("creates one stable platform owner and exact replay is unchanged without ownership-period planning", () => {
  const classify = requiredExport("classifyStage1cAccessBaseline");
  const first = classify(baselineSnapshot());

  assert.deepEqual(first.platformOwner, {
    disposition: "CREATE",
    name: "平台资产主体",
    ownerNo: "PLATFORM",
    ownerType: "PLATFORM",
    status: "ACTIVE"
  });
  assert.equal("ownershipPeriods" in first, false);

  const replaySnapshot = baselineSnapshot();
  replaySnapshot.assetOwners.push(platformOwner());
  const replay = classify(replaySnapshot);
  assert.equal(replay.platformOwner.disposition, "UNCHANGED");
  assert.deepEqual(replay.blockers, []);
});

test("refuses owner-number material identity/type drift and another active platform owner", () => {
  const classify = requiredExport("classifyStage1cAccessBaseline");
  const cases = [
    { ...platformOwner(), name: "另一法律主体" },
    { ...platformOwner(), ownerType: "EXTERNAL_COMPANY" },
    { ...platformOwner(), ownerNo: "OTHER-PLATFORM" }
  ];

  for (const owner of cases) {
    const snapshot = baselineSnapshot();
    snapshot.assetOwners.push(owner);
    const report = classify(snapshot);
    assert.equal(report.blockers.length, 1);
    assert.match(report.blockers[0].code, /^PLATFORM_OWNER_(IDENTITY_DRIFT|COLLISION)$/);
  }
});

function baselineSnapshot() {
  const roleCodes = ["ADMIN", "AS", "OP", "FI", "GM", "SA", "RC", "CS"];
  const permissions = [
    permission("asset_facts:view", "查看车辆事实台账", "view"),
    permission("asset_owner:manage", "管理车辆权属期间", "owner_manage"),
    permission("vehicle_period:manage", "修复车辆订阅期间", "period_manage"),
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
  const stageCodes = new Set(["asset_facts:view", "asset_owner:manage", "vehicle_period:manage"]);
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
