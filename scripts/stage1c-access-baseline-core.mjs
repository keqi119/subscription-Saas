export const STAGE1C_REQUIRED_ROLE_CODES = Object.freeze([
  "ADMIN",
  "AS",
  "OP",
  "FI",
  "GM",
  "SA",
  "RC",
  "CS"
]);

export const STAGE1C_PERMISSION_DEFINITIONS = Object.freeze([
  Object.freeze({
    action: "view",
    code: "asset_facts:view",
    module: "asset_facts",
    name: "查看车辆事实台账"
  }),
  Object.freeze({
    action: "owner_manage",
    code: "asset_owner:manage",
    module: "asset_facts",
    name: "管理车辆权属期间"
  }),
  Object.freeze({
    action: "period_manage",
    code: "vehicle_period:manage",
    module: "asset_facts",
    name: "修复车辆订阅期间"
  }),
  Object.freeze({
    action: "view",
    code: "asset_operations:view",
    module: "asset_operations",
    name: "查看资产运营工单与限制"
  }),
  Object.freeze({
    action: "work_order_manage",
    code: "asset_work_order:manage",
    module: "asset_operations",
    name: "管理资产运营工单"
  }),
  Object.freeze({
    action: "restriction_manage",
    code: "vehicle_restriction:manage",
    module: "asset_operations",
    name: "管理车辆运营限制"
  }),
  Object.freeze({
    action: "restriction_release",
    code: "vehicle_restriction:release",
    module: "asset_operations",
    name: "解除车辆运营限制"
  }),
  Object.freeze({
    action: "restriction_approve_release",
    code: "vehicle_restriction:approve_release",
    module: "asset_operations",
    name: "审批高风险车辆运营限制解除"
  })
]);

export const STAGE1C_ROLE_PERMISSION_MATRIX = Object.freeze({
  ADMIN: Object.freeze([
    "asset_facts:view",
    "asset_owner:manage",
    "vehicle_period:manage",
    "asset_operations:view",
    "asset_work_order:manage",
    "vehicle_restriction:manage",
    "vehicle_restriction:release",
    "vehicle_restriction:approve_release"
  ]),
  AS: Object.freeze([
    "asset_facts:view",
    "asset_owner:manage",
    "vehicle_period:manage",
    "asset_operations:view",
    "asset_work_order:manage",
    "vehicle_restriction:manage",
    "vehicle_restriction:release",
    "vehicle_restriction:approve_release"
  ]),
  CS: Object.freeze([]),
  FI: Object.freeze(["asset_facts:view", "asset_operations:view"]),
  GM: Object.freeze([
    "asset_facts:view",
    "asset_operations:view",
    "vehicle_restriction:approve_release"
  ]),
  OP: Object.freeze([
    "asset_facts:view",
    "vehicle_period:manage",
    "asset_operations:view",
    "asset_work_order:manage",
    "vehicle_restriction:manage",
    "vehicle_restriction:release"
  ]),
  RC: Object.freeze(["asset_operations:view"]),
  SA: Object.freeze([])
});

export const STAGE1C_PLATFORM_OWNER = Object.freeze({
  name: "平台资产主体",
  ownerNo: "PLATFORM",
  ownerType: "PLATFORM",
  status: "ACTIVE"
});

export function classifyStage1cAccessBaseline(snapshot) {
  const blockers = classifyRoleBlockers(snapshot.roles);
  const permissionsByCode = new Map(snapshot.permissions.map((row) => [row.code, row]));
  const grantsByIdentity = new Map(
    snapshot.rolePermissions.map((row) => [grantIdentity(row.roleCode, row.permissionCode), row])
  );
  const permissions = STAGE1C_PERMISSION_DEFINITIONS.map((definition) => {
    const current = permissionsByCode.get(definition.code);
    if (current !== undefined && !permissionIdentityMatches(current, definition)) {
      blockers.push({ code: "PERMISSION_IDENTITY_DRIFT", permissionCode: definition.code });
    }
    return {
      ...definition,
      disposition:
        current === undefined
          ? "CREATE"
          : !permissionIdentityMatches(current, definition)
            ? "BLOCKED"
            : permissionMatches(current, definition)
              ? "UNCHANGED"
              : "CONVERGE"
    };
  });
  const rolePermissions = STAGE1C_REQUIRED_ROLE_CODES.flatMap((roleCode) =>
    STAGE1C_PERMISSION_DEFINITIONS.map(({ code: permissionCode }) => {
      const current = grantsByIdentity.get(grantIdentity(roleCode, permissionCode));
      const expected = STAGE1C_ROLE_PERMISSION_MATRIX[roleCode].includes(permissionCode);
      let disposition = "UNCHANGED";
      if (expected && current === undefined) disposition = "GRANT";
      if (expected && current?.deletedAt != null) disposition = "REVIVE";
      if (!expected && current?.deletedAt == null && current !== undefined) disposition = "REVOKE";
      return { disposition, expected, permissionCode, roleCode };
    })
  );
  const platformOwner = classifyPlatformOwner(snapshot.assetOwners, blockers);

  return {
    blockers,
    ownershipPeriodCount: snapshot.ownershipPeriodCount,
    permissions,
    platformOwner,
    rolePermissions
  };
}

export function isStage1cAccessBaselineSafe(report) {
  return report.blockers.length === 0;
}

export function isStage1cAccessBaselineConverged(report) {
  return (
    isStage1cAccessBaselineSafe(report) &&
    report.permissions.every(({ disposition }) => disposition === "UNCHANGED") &&
    report.rolePermissions.every(({ disposition }) => disposition === "UNCHANGED") &&
    report.platformOwner.disposition === "UNCHANGED"
  );
}

function classifyRoleBlockers(roles) {
  const rolesByCode = new Map(roles.map((role) => [role.code, role]));
  return STAGE1C_REQUIRED_ROLE_CODES.flatMap((roleCode) => {
    const role = rolesByCode.get(roleCode);
    if (role === undefined) return [{ code: "ROLE_MISSING", roleCode }];
    if (role.status !== "ACTIVE" || role.deletedAt !== null) {
      return [{ code: "ROLE_INACTIVE", roleCode }];
    }
    return [];
  });
}

function classifyPlatformOwner(assetOwners, blockers) {
  const canonical = assetOwners.find(({ ownerNo }) => ownerNo === STAGE1C_PLATFORM_OWNER.ownerNo);
  const otherActivePlatformOwners = assetOwners.filter(
    ({ ownerNo, ownerType, status }) =>
      ownerNo !== STAGE1C_PLATFORM_OWNER.ownerNo &&
      ownerType === STAGE1C_PLATFORM_OWNER.ownerType &&
      status === "ACTIVE"
  );

  if (canonical !== undefined && !ownerIdentityMatches(canonical)) {
    blockers.push({ code: "PLATFORM_OWNER_IDENTITY_DRIFT", ownerNo: canonical.ownerNo });
  }
  if (otherActivePlatformOwners.length > 0) {
    blockers.push({
      code: "PLATFORM_OWNER_COLLISION",
      ownerNos: otherActivePlatformOwners.map(({ ownerNo }) => ownerNo).sort()
    });
  }

  let disposition = "UNCHANGED";
  if (canonical === undefined) disposition = "CREATE";
  if (canonical !== undefined && ownerIdentityMatches(canonical) && canonical.status !== "ACTIVE") {
    disposition = "CONVERGE";
  }
  if (blockers.some(({ code }) => code.startsWith("PLATFORM_OWNER_"))) disposition = "BLOCKED";

  return { ...STAGE1C_PLATFORM_OWNER, disposition };
}

function permissionMatches(current, definition) {
  return (
    permissionIdentityMatches(current, definition) &&
    current.deletedAt === null &&
    current.status === "ACTIVE"
  );
}

function permissionIdentityMatches(current, definition) {
  return (
    current.action === definition.action &&
    current.module === definition.module &&
    current.name === definition.name
  );
}

function ownerIdentityMatches(current) {
  return (
    current.name === STAGE1C_PLATFORM_OWNER.name &&
    current.ownerType === STAGE1C_PLATFORM_OWNER.ownerType
  );
}

function grantIdentity(roleCode, permissionCode) {
  return `${roleCode}\u0000${permissionCode}`;
}
