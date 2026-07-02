import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";

config({ path: "../../.env" });
config({ path: ".env" });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Fleet Ops access sync.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl))
});

const fleetOpsPermission = {
  action: "read",
  code: "fleet_ops:read",
  description: "查看车队运营只读看板与车辆运营快照",
  module: "fleet_ops",
  name: "车队运营查看"
};

const fleetOpsMenu = {
  code: "vehicles.fleet_ops",
  icon: "dashboard",
  name: "车队运营",
  path: "/fleet-ops",
  permissionCode: "fleet_ops:read",
  sortOrder: 45
};

const targetRoleCodes = ["ADMIN", "OP", "GM"];

try {
  await syncFleetOpsAccess();
} finally {
  await prisma.$disconnect();
}

async function syncFleetOpsAccess() {
  const permission = await prisma.permission.upsert({
    create: fleetOpsPermission,
    update: {
      action: fleetOpsPermission.action,
      deletedAt: null,
      description: fleetOpsPermission.description,
      module: fleetOpsPermission.module,
      name: fleetOpsPermission.name,
      status: "ACTIVE"
    },
    where: { code: fleetOpsPermission.code }
  });

  const parentMenu = await prisma.menu.findUnique({
    where: { code: "vehicles" }
  });

  if (!parentMenu) {
    console.warn("Warning: vehicles menu group was not found; vehicles.fleet_ops will be synced without a parent menu.");
  }

  const menu = await prisma.menu.upsert({
    create: {
      ...fleetOpsMenu,
      parentId: parentMenu?.id ?? null
    },
    update: {
      deletedAt: null,
      icon: fleetOpsMenu.icon,
      name: fleetOpsMenu.name,
      parentId: parentMenu?.id ?? null,
      path: fleetOpsMenu.path,
      permissionCode: fleetOpsMenu.permissionCode,
      sortOrder: fleetOpsMenu.sortOrder,
      status: "ACTIVE"
    },
    where: { code: fleetOpsMenu.code }
  });

  const roles = await prisma.role.findMany({
    where: { code: { in: targetRoleCodes } }
  });
  const foundRoleCodes = new Set(roles.map((role) => role.code));
  const missingRoleCodes = targetRoleCodes.filter((roleCode) => !foundRoleCodes.has(roleCode));

  if (missingRoleCodes.length > 0) {
    console.warn(`Warning: skipped missing roles: ${missingRoleCodes.join(", ")}`);
  }

  for (const role of roles) {
    await prisma.rolePermission.upsert({
      create: {
        permissionId: permission.id,
        roleId: role.id
      },
      update: {
        deletedAt: null
      },
      where: {
        roleId_permissionId: {
          permissionId: permission.id,
          roleId: role.id
        }
      }
    });

    await prisma.roleMenu.upsert({
      create: {
        menuId: menu.id,
        roleId: role.id
      },
      update: {
        deletedAt: null
      },
      where: {
        roleId_menuId: {
          menuId: menu.id,
          roleId: role.id
        }
      }
    });
  }

  console.log("Fleet Ops access sync completed:");
  console.log(`- permission: ${fleetOpsPermission.code}`);
  console.log(`- menu: ${fleetOpsMenu.code} / ${fleetOpsMenu.path}`);
  console.log(`- roles: ${roles.map((role) => role.code).join(", ") || "none"}`);
}

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}
