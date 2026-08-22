export const STAGE1_P0_CLOSURE_REQUIRED_ROLE_CODES = Object.freeze([
  "ADMIN",
  "AS",
  "OP",
  "FI",
  "GM",
  "SA",
  "RC",
  "CS"
]);

export const STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS = Object.freeze([
  definition("subscription_closure:view", "subscription_closure", "view", "查看订阅闭环"),
  definition("subscription_closure:prepare", "subscription_closure", "prepare", "准备订阅闭环"),
  definition("subscription_closure:receive", "subscription_closure", "receive", "确认车辆物理接收"),
  definition("subscription_closure:inspect", "subscription_closure", "inspect", "执行退车检查"),
  definition(
    "subscription_closure:settle",
    "subscription_closure",
    "settle",
    "执行最终结算与库存释放"
  ),
  definition("subscription_recovery:assess", "subscription_recovery", "assess", "评估车辆追回"),
  definition("subscription_recovery:approve", "subscription_recovery", "approve", "审批车辆追回"),
  definition("subscription_recovery:execute", "subscription_recovery", "execute", "执行车辆追回"),
  definition(
    "subscription_early_termination:create",
    "subscription_early_termination",
    "create",
    "发起提前终止"
  ),
  definition(
    "subscription_early_termination:execute",
    "subscription_early_termination",
    "execute",
    "执行提前终止"
  )
]);

const ALL = STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS.map(({ code }) => code);
export const STAGE1_P0_CLOSURE_ROLE_PERMISSION_MATRIX = Object.freeze({
  ADMIN: Object.freeze([...ALL]),
  AS: Object.freeze([
    "subscription_closure:view",
    "subscription_closure:receive",
    "subscription_closure:inspect",
    "subscription_recovery:execute"
  ]),
  CS: Object.freeze([
    "subscription_closure:view",
    "subscription_closure:prepare",
    "subscription_early_termination:create"
  ]),
  FI: Object.freeze(["subscription_closure:view", "subscription_closure:settle"]),
  GM: Object.freeze(["subscription_closure:view", "subscription_recovery:approve"]),
  OP: Object.freeze([
    "subscription_closure:view",
    "subscription_closure:prepare",
    "subscription_closure:receive",
    "subscription_closure:inspect",
    "subscription_recovery:assess",
    "subscription_recovery:execute",
    "subscription_early_termination:create",
    "subscription_early_termination:execute"
  ]),
  RC: Object.freeze(["subscription_closure:view", "subscription_recovery:assess"]),
  SA: Object.freeze(["subscription_closure:view"])
});

export function classifyStage1P0ClosureAccess(snapshot) {
  const blockers = [];
  const roleByCode = new Map(snapshot.roles.map((row) => [row.code, row]));
  for (const roleCode of STAGE1_P0_CLOSURE_REQUIRED_ROLE_CODES) {
    const role = roleByCode.get(roleCode);
    if (!role) blockers.push({ code: "ROLE_MISSING", roleCode });
    else if (role.status !== "ACTIVE" || role.deletedAt !== null) {
      blockers.push({ code: "ROLE_INACTIVE", roleCode });
    }
  }
  const permissionByCode = new Map(snapshot.permissions.map((row) => [row.code, row]));
  const permissions = STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS.map((expected) => {
    const current = permissionByCode.get(expected.code);
    const identity =
      current && current.action === expected.action && current.module === expected.module;
    if (current && !identity)
      blockers.push({ code: "PERMISSION_IDENTITY_DRIFT", permissionCode: expected.code });
    return {
      ...expected,
      disposition: !current
        ? "CREATE"
        : !identity
          ? "BLOCKED"
          : current.name === expected.name &&
              current.status === "ACTIVE" &&
              current.deletedAt === null
            ? "UNCHANGED"
            : "CONVERGE"
    };
  });
  const grantByIdentity = new Map(
    snapshot.rolePermissions.map((row) => [`${row.roleCode}\u0000${row.permissionCode}`, row])
  );
  const rolePermissions = STAGE1_P0_CLOSURE_REQUIRED_ROLE_CODES.flatMap((roleCode) =>
    STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS.map(({ code: permissionCode }) => {
      const current = grantByIdentity.get(`${roleCode}\u0000${permissionCode}`);
      const expected = STAGE1_P0_CLOSURE_ROLE_PERMISSION_MATRIX[roleCode].includes(permissionCode);
      let disposition = "UNCHANGED";
      if (expected && !current) disposition = "GRANT";
      else if (expected && current.deletedAt !== null) disposition = "REVIVE";
      else if (!expected && current?.deletedAt === null) disposition = "REVOKE";
      return { disposition, expected, permissionCode, roleCode };
    })
  );
  return { blockers, permissions, rolePermissions };
}

export function isStage1P0ClosureAccessSafe(report) {
  return report.blockers.length === 0;
}

export function isStage1P0ClosureAccessConverged(report) {
  return (
    isStage1P0ClosureAccessSafe(report) &&
    report.permissions.every(({ disposition }) => disposition === "UNCHANGED") &&
    report.rolePermissions.every(({ disposition }) => disposition === "UNCHANGED")
  );
}

function definition(code, module, action, name) {
  return Object.freeze({ action, code, module, name });
}
