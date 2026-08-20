import {
  STAGE1C_PERMISSION_DEFINITIONS,
  STAGE1C_PLATFORM_OWNER,
  STAGE1C_REQUIRED_ROLE_CODES,
  classifyStage1cAccessBaseline,
  isStage1cAccessBaselineConverged,
  isStage1cAccessBaselineSafe
} from "./stage1c-access-baseline-core.mjs";

const APPLY_LOCK_KEY = "stage1c-access-baseline:apply";
const TRANSACTION_OPTIONS = {
  isolationLevel: "RepeatableRead",
  maxWait: 10_000,
  timeout: 120_000
};

export async function executeStage1cAccessBaseline({
  apply = applyStage1cAccessBaseline,
  classify = classifyStage1cAccessBaseline,
  generatedAt = new Date().toISOString(),
  loadSnapshot = loadStage1cAccessBaselineSnapshot,
  mode,
  prisma
}) {
  if (mode === "dry-run") {
    const classification = await prisma.$transaction(
      async (tx) => classify(await loadSnapshot(tx)),
      TRANSACTION_OPTIONS
    );
    return buildResult({ applied: null, classification, generatedAt, mode });
  }
  if (mode !== "apply") throw new Error("STAGE1C_ACCESS_BASELINE_MODE_INVALID");

  const outcome = await prisma.$transaction(async (tx) => {
    await lockStage1cAccessBaseline(tx);
    const before = await loadSnapshot(tx);
    const classification = classify(before);
    if (!isStage1cAccessBaselineSafe(classification)) {
      return { applied: blockedApplyResult(), classification };
    }

    const applied = await apply(tx, classification, { generatedAt });
    const after = await loadSnapshot(tx);
    const verification = classify(after);
    if (
      after.ownershipPeriodCount !== before.ownershipPeriodCount ||
      !isStage1cAccessBaselineConverged(verification)
    ) {
      throw new Error("STAGE1C_ACCESS_BASELINE_POST_VERIFICATION_FAILED");
    }
    return { applied, classification };
  }, TRANSACTION_OPTIONS);

  return buildResult({ ...outcome, generatedAt, mode });
}

export async function loadStage1cAccessBaselineSnapshot(db) {
  const permissionCodes = STAGE1C_PERMISSION_DEFINITIONS.map(({ code }) => code);
  const [roles, permissions, rolePermissionRows, assetOwners, ownershipPeriodCount] =
    await Promise.all([
      db.role.findMany({
        orderBy: { code: "asc" },
        select: { code: true, deletedAt: true, id: true, status: true },
        where: { code: { in: STAGE1C_REQUIRED_ROLE_CODES } }
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
        where: { code: { in: permissionCodes } }
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
          permission: { code: { in: permissionCodes } },
          role: { code: { in: STAGE1C_REQUIRED_ROLE_CODES } }
        }
      }),
      db.assetOwner.findMany({
        orderBy: { ownerNo: "asc" },
        select: {
          id: true,
          legalName: true,
          name: true,
          ownerNo: true,
          ownerType: true,
          registrationIdentifier: true,
          status: true
        },
        where: {
          OR: [
            { ownerNo: STAGE1C_PLATFORM_OWNER.ownerNo },
            { ownerType: STAGE1C_PLATFORM_OWNER.ownerType }
          ]
        }
      }),
      db.vehicleOwnershipPeriod.count()
    ]);

  return {
    assetOwners,
    ownershipPeriodCount,
    permissions,
    rolePermissions: rolePermissionRows.map((row) => ({
      deletedAt: row.deletedAt,
      id: row.id,
      permissionCode: row.permission.code,
      permissionId: row.permissionId,
      roleCode: row.role.code,
      roleId: row.roleId
    })),
    roles
  };
}

export async function applyStage1cAccessBaseline(tx, classification, { generatedAt }) {
  let permissionsChanged = 0;
  let grantsChanged = 0;
  let ownerChanged = 0;
  const changedAt = new Date(generatedAt);

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
      where: { code: { in: STAGE1C_REQUIRED_ROLE_CODES } }
    }),
    tx.permission.findMany({
      select: { code: true, id: true },
      where: { code: { in: STAGE1C_PERMISSION_DEFINITIONS.map(({ code }) => code) } }
    })
  ]);
  const roleIdByCode = new Map(roles.map(({ code, id }) => [code, id]));
  const permissionIdByCode = new Map(permissions.map(({ code, id }) => [code, id]));

  for (const grant of classification.rolePermissions) {
    if (grant.disposition === "UNCHANGED") continue;
    const roleId = roleIdByCode.get(grant.roleCode);
    const permissionId = permissionIdByCode.get(grant.permissionCode);
    if (roleId === undefined || permissionId === undefined) {
      throw new Error("STAGE1C_ACCESS_BASELINE_IDENTITY_RESOLUTION_FAILED");
    }
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

  let owner = await tx.assetOwner.findUnique({
    where: { ownerNo: STAGE1C_PLATFORM_OWNER.ownerNo }
  });
  if (classification.platformOwner.disposition === "CREATE") {
    owner = await tx.assetOwner.create({ data: STAGE1C_PLATFORM_OWNER });
    ownerChanged = 1;
  } else if (classification.platformOwner.disposition === "CONVERGE") {
    owner = await tx.assetOwner.update({
      data: { status: STAGE1C_PLATFORM_OWNER.status },
      where: { ownerNo: STAGE1C_PLATFORM_OWNER.ownerNo }
    });
    ownerChanged = 1;
  }

  const changed = permissionsChanged + grantsChanged + ownerChanged;
  let auditsCreated = 0;
  if (changed > 0) {
    await tx.auditLog.create({
      data: {
        action: "UPDATE",
        afterSnapshot: {
          grantsChanged,
          ownerChanged,
          ownerNo: STAGE1C_PLATFORM_OWNER.ownerNo,
          permissionCodes: STAGE1C_PERMISSION_DEFINITIONS.map(({ code }) => code),
          permissionsChanged
        },
        entityId: owner?.id,
        entityType: "stage1c_access_baseline",
        module: "system"
      }
    });
    auditsCreated = 1;
  }

  return { auditsCreated, grantsChanged, ownerChanged, permissionsChanged };
}

async function lockStage1cAccessBaseline(tx) {
  await tx.$executeRaw`LOCK TABLE "role", "permission", "role_permission", "asset_owner", "audit_log" IN SHARE ROW EXCLUSIVE MODE`;
  await tx.$executeRaw`LOCK TABLE "vehicle_ownership_period" IN SHARE MODE`;
  await tx.$queryRaw`SELECT TRUE AS locked FROM pg_advisory_xact_lock(hashtextextended(${APPLY_LOCK_KEY}, 0))`;
}

function blockedApplyResult() {
  return {
    auditsCreated: 0,
    blocked: true,
    grantsChanged: 0,
    ownerChanged: 0,
    permissionsChanged: 0
  };
}

function buildResult({ applied, classification, generatedAt, mode }) {
  const safeToApply = isStage1cAccessBaselineSafe(classification);
  return {
    exitCode: safeToApply ? 0 : 1,
    report: { applied, classification, generatedAt, mode, safeToApply }
  };
}
