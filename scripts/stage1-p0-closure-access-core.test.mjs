import assert from "node:assert/strict";
import test from "node:test";

import {
  STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS,
  STAGE1_P0_CLOSURE_ROLE_PERMISSION_MATRIX,
  classifyStage1P0ClosureAccess,
  isStage1P0ClosureAccessConverged
} from "./stage1-p0-closure-access-core.mjs";

test("freezes the exact ten permissions and least-privilege role matrix", () => {
  assert.deepEqual(
    STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS.map(({ code }) => code),
    [
      "subscription_closure:view",
      "subscription_closure:prepare",
      "subscription_closure:receive",
      "subscription_closure:inspect",
      "subscription_closure:settle",
      "subscription_recovery:assess",
      "subscription_recovery:approve",
      "subscription_recovery:execute",
      "subscription_early_termination:create",
      "subscription_early_termination:execute"
    ]
  );
  assert.deepEqual(STAGE1_P0_CLOSURE_ROLE_PERMISSION_MATRIX, {
    ADMIN: STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS.map(({ code }) => code),
    AS: [
      "subscription_closure:view",
      "subscription_closure:receive",
      "subscription_closure:inspect",
      "subscription_recovery:execute"
    ],
    CS: [
      "subscription_closure:view",
      "subscription_closure:prepare",
      "subscription_early_termination:create"
    ],
    FI: ["subscription_closure:view", "subscription_closure:settle"],
    GM: ["subscription_closure:view", "subscription_recovery:approve"],
    OP: [
      "subscription_closure:view",
      "subscription_closure:prepare",
      "subscription_closure:receive",
      "subscription_closure:inspect",
      "subscription_recovery:assess",
      "subscription_recovery:execute",
      "subscription_early_termination:create",
      "subscription_early_termination:execute"
    ],
    RC: ["subscription_closure:view", "subscription_recovery:assess"],
    SA: ["subscription_closure:view"]
  });
});

test("classifies create/grant, converged replay, and exact revocation without implicit grants", () => {
  const empty = snapshot();
  const first = classifyStage1P0ClosureAccess(empty);
  assert.equal(
    first.permissions.every(({ disposition }) => disposition === "CREATE"),
    true
  );
  assert.equal(
    first.rolePermissions.some(({ disposition }) => disposition === "GRANT"),
    true
  );

  const converged = snapshot({ converged: true });
  assert.equal(isStage1P0ClosureAccessConverged(classifyStage1P0ClosureAccess(converged)), true);

  const permission = STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS[1];
  converged.rolePermissions.push({
    deletedAt: null,
    id: "unexpected",
    permissionCode: permission.code,
    permissionId: `permission:${permission.code}`,
    roleCode: "SA",
    roleId: "role:SA"
  });
  const drift = classifyStage1P0ClosureAccess(converged);
  assert.equal(
    drift.rolePermissions.some(
      ({ disposition, permissionCode, roleCode }) =>
        disposition === "REVOKE" && permissionCode === permission.code && roleCode === "SA"
    ),
    true
  );
});

function snapshot({ converged = false } = {}) {
  const roleCodes = ["ADMIN", "AS", "OP", "FI", "GM", "SA", "RC", "CS"];
  const roles = roleCodes.map((code) => ({
    code,
    deletedAt: null,
    id: `role:${code}`,
    status: "ACTIVE"
  }));
  const permissions = converged
    ? STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS.map((item) => ({
        ...item,
        deletedAt: null,
        id: `permission:${item.code}`,
        status: "ACTIVE"
      }))
    : [];
  const rolePermissions = converged
    ? roleCodes.flatMap((roleCode) =>
        STAGE1_P0_CLOSURE_ROLE_PERMISSION_MATRIX[roleCode].map((permissionCode) => ({
          deletedAt: null,
          id: `${roleCode}:${permissionCode}`,
          permissionCode,
          permissionId: `permission:${permissionCode}`,
          roleCode,
          roleId: `role:${roleCode}`
        }))
      )
    : [];
  return { permissions, rolePermissions, roles };
}
