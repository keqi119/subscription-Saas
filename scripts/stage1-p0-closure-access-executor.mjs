import {
  STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS,
  STAGE1_P0_CLOSURE_REQUIRED_ROLE_CODES,
  classifyStage1P0ClosureAccess,
  isStage1P0ClosureAccessConverged,
  isStage1P0ClosureAccessSafe
} from "./stage1-p0-closure-access-core.mjs";

const LOCK_KEY = "stage1-p0-closure-access";
const OPTIONS = { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 120_000 };

export async function executeStage1P0ClosureAccess({
  mode,
  prisma,
  generatedAt = new Date().toISOString()
}) {
  if (mode === "dry-run") {
    const classification = await prisma.$transaction(
      async (tx) => classifyStage1P0ClosureAccess(await loadStage1P0ClosureAccessSnapshot(tx)),
      OPTIONS
    );
    return result(mode, generatedAt, classification, null);
  }
  if (mode === "apply") {
    return prisma.$transaction(async (tx) => {
      await lock(tx);
      const classification = classifyStage1P0ClosureAccess(
        await loadStage1P0ClosureAccessSnapshot(tx)
      );
      if (!isStage1P0ClosureAccessSafe(classification))
        return result(mode, generatedAt, classification, blocked());
      const applied = await applyStage1P0ClosureAccess(tx, classification, generatedAt);
      const verification = classifyStage1P0ClosureAccess(
        await loadStage1P0ClosureAccessSnapshot(tx)
      );
      if (!isStage1P0ClosureAccessConverged(verification))
        throw new Error("STAGE1_P0_CLOSURE_ACCESS_POST_VERIFY_FAILED");
      return result(mode, generatedAt, classification, applied);
    }, OPTIONS);
  }
  if (mode === "cleanup") {
    return prisma.$transaction(async (tx) => {
      await lock(tx);
      const classification = classifyStage1P0ClosureAccess(
        await loadStage1P0ClosureAccessSnapshot(tx)
      );
      if (!isStage1P0ClosureAccessSafe(classification))
        return result(mode, generatedAt, classification, blocked());
      const cleaned = await cleanupStage1P0ClosureAccess(tx, generatedAt);
      const snapshot = await loadStage1P0ClosureAccessSnapshot(tx);
      if (snapshot.permissions.length !== 0 || snapshot.rolePermissions.length !== 0) {
        throw new Error("STAGE1_P0_CLOSURE_ACCESS_CLEANUP_VERIFY_FAILED");
      }
      return result(mode, generatedAt, classification, cleaned);
    }, OPTIONS);
  }
  throw new Error("STAGE1_P0_CLOSURE_ACCESS_MODE_INVALID");
}

export async function loadStage1P0ClosureAccessSnapshot(db) {
  const codes = STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS.map(({ code }) => code);
  const [roles, permissions, grants] = await Promise.all([
    db.role.findMany({
      orderBy: { code: "asc" },
      select: { code: true, deletedAt: true, id: true, status: true },
      where: { code: { in: STAGE1_P0_CLOSURE_REQUIRED_ROLE_CODES } }
    }),
    db.permission.findMany({
      orderBy: { code: "asc" },
      select: {
        action: true,
        code: true,
        deletedAt: true,
        id: true,
        module: true,
        name: true,
        status: true
      },
      where: { code: { in: codes } }
    }),
    db.rolePermission.findMany({
      orderBy: [{ role: { code: "asc" } }, { permission: { code: "asc" } }],
      select: {
        deletedAt: true,
        id: true,
        permission: { select: { code: true } },
        permissionId: true,
        role: { select: { code: true } },
        roleId: true
      },
      where: {
        permission: { code: { in: codes } },
        role: { code: { in: STAGE1_P0_CLOSURE_REQUIRED_ROLE_CODES } }
      }
    })
  ]);
  return {
    permissions,
    rolePermissions: grants.map((row) => ({
      ...row,
      permissionCode: row.permission.code,
      roleCode: row.role.code
    })),
    roles
  };
}

export async function applyStage1P0ClosureAccess(tx, classification, generatedAt) {
  const changedAt = new Date(generatedAt);
  let permissionsChanged = 0;
  let grantsChanged = 0;
  for (const permission of classification.permissions) {
    if (permission.disposition === "UNCHANGED") continue;
    const { action, code, module, name } = permission;
    await tx.permission.upsert({
      create: { action, code, module, name },
      update: { action, deletedAt: null, module, name, status: "ACTIVE" },
      where: { code }
    });
    permissionsChanged += 1;
  }
  const [roles, permissions] = await Promise.all([
    tx.role.findMany({
      select: { code: true, id: true },
      where: { code: { in: STAGE1_P0_CLOSURE_REQUIRED_ROLE_CODES } }
    }),
    tx.permission.findMany({
      select: { code: true, id: true },
      where: { code: { in: STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS.map(({ code }) => code) } }
    })
  ]);
  const roleIds = new Map(roles.map(({ code, id }) => [code, id]));
  const permissionIds = new Map(permissions.map(({ code, id }) => [code, id]));
  for (const grant of classification.rolePermissions) {
    if (grant.disposition === "UNCHANGED") continue;
    const roleId = roleIds.get(grant.roleCode);
    const permissionId = permissionIds.get(grant.permissionCode);
    if (!roleId || !permissionId)
      throw new Error("STAGE1_P0_CLOSURE_ACCESS_IDENTITY_RESOLUTION_FAILED");
    if (grant.disposition === "REVOKE") {
      await tx.rolePermission.updateMany({
        data: { deletedAt: changedAt },
        where: { deletedAt: null, permissionId, roleId }
      });
    } else {
      await tx.rolePermission.upsert({
        create: { permissionId, roleId },
        update: { deletedAt: null },
        where: { roleId_permissionId: { permissionId, roleId } }
      });
    }
    grantsChanged += 1;
  }
  const changed = permissionsChanged + grantsChanged;
  if (changed > 0) await audit(tx, generatedAt, "APPLY", { grantsChanged, permissionsChanged });
  return { auditsCreated: changed > 0 ? 1 : 0, grantsChanged, permissionsChanged };
}

export async function cleanupStage1P0ClosureAccess(tx, generatedAt) {
  const codes = STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS.map(({ code }) => code);
  const permissions = await tx.permission.findMany({
    select: { id: true },
    where: { code: { in: codes } }
  });
  const permissionIds = permissions.map(({ id }) => id);
  const grants = permissionIds.length
    ? await tx.rolePermission.deleteMany({ where: { permissionId: { in: permissionIds } } })
    : { count: 0 };
  const removed = await tx.permission.deleteMany({ where: { code: { in: codes } } });
  if (grants.count + removed.count > 0)
    await audit(tx, generatedAt, "CLEANUP", {
      grantsChanged: grants.count,
      permissionsChanged: removed.count
    });
  return {
    auditsCreated: grants.count + removed.count > 0 ? 1 : 0,
    grantsChanged: grants.count,
    permissionsChanged: removed.count
  };
}

async function lock(tx) {
  await tx.$executeRaw`LOCK TABLE "role", "permission", "role_permission", "audit_log" IN SHARE ROW EXCLUSIVE MODE`;
  await tx.$queryRaw`SELECT TRUE AS locked FROM pg_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0))`;
}

async function audit(tx, generatedAt, operation, detail) {
  await tx.auditLog.create({
    data: {
      action: "UPDATE",
      afterSnapshot: {
        ...detail,
        operation,
        permissionCodes: STAGE1_P0_CLOSURE_PERMISSION_DEFINITIONS.map(({ code }) => code)
      },
      createdAt: new Date(generatedAt),
      entityType: "stage1_p0_closure_access",
      module: "system"
    }
  });
}

function blocked() {
  return { auditsCreated: 0, blocked: true, grantsChanged: 0, permissionsChanged: 0 };
}
function result(mode, generatedAt, classification, applied) {
  const safeToApply = isStage1P0ClosureAccessSafe(classification);
  return {
    exitCode: safeToApply ? 0 : 1,
    report: { applied, classification, generatedAt, mode, safeToApply }
  };
}
