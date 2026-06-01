import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { config } from "dotenv";

config({ path: "../../.env" });
config({ path: ".env" });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for seeding.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl))
});

const roleRows = [
  ["SA", "销售顾问", "获客、客户进件与报价跟进"],
  ["OP", "运营管理", "产品、订单、合同与权益运营"],
  ["RC", "风控专员", "客户评级、资料审核与风险审批"],
  ["FI", "财务专员", "收款、核销、押金与财务报表"],
  ["AS", "资产运营", "车辆采购、整备、交付与回收"],
  ["CS", "客服运营", "客户回访、续订与服务运营"],
  ["GM", "总经理 / 运营总监", "特殊审批与重大风险决策"],
  ["ADMIN", "系统管理员", "用户、角色、权限与系统配置"]
];

const permissionRows = [
  ["dashboard:view", "查看首页驾驶舱", "dashboard", "view"],
  ["user:view", "查看用户", "system", "view"],
  ["user:manage", "管理用户", "system", "manage"],
  ["role:view", "查看角色", "system", "view"],
  ["role:manage", "管理角色", "system", "manage"],
  ["permission:view", "查看权限", "system", "view"],
  ["menu:view", "查看菜单", "system", "view"],
  ["audit_log:view", "查看操作日志", "system", "view"],
  ["customer:view", "查看客户", "customer", "view"],
  ["customer:manage", "管理客户", "customer", "manage"],
  ["application:view", "查看进件", "application", "view"],
  ["application:manage", "管理进件", "application", "manage"],
  ["application:submit", "提交进件", "application", "submit"],
  ["application:material_upload", "上传进件资料", "application", "material_upload"],
  ["application:material_delete", "删除进件资料", "application", "material_delete"],
  ["application:review", "审核进件", "application", "review"],
  ["risk:view", "查看风控", "risk", "view"],
  ["risk:manage", "管理押金规则", "risk", "manage"],
  ["product:view", "查看产品", "product", "view"],
  ["product:create", "新建产品", "product", "create"],
  ["product:update", "编辑产品", "product", "update"],
  ["product:activate", "启用产品", "product", "activate"],
  ["product_version:view", "查看产品版本", "product", "version_view"],
  ["product_version:create", "新建产品版本", "product", "version_create"],
  ["product_version:update", "编辑产品版本", "product", "version_update"],
  ["product_version:approve", "审批产品版本", "product", "version_approve"],
  ["product_version:activate", "激活产品版本", "product", "version_activate"],
  ["product_price_rule:view", "查看价格规则", "product", "price_rule_view"],
  ["product_price_rule:create", "新建价格规则", "product", "price_rule_create"],
  ["product_price_rule:update", "编辑价格规则", "product", "price_rule_update"],
  ["product_price_rule:delete", "删除价格规则", "product", "price_rule_delete"],
  ["quote:view", "查看报价", "quote", "view"],
  ["quote:create", "新建报价", "quote", "create"],
  ["quote:update", "编辑报价", "quote", "update"],
  ["quote:confirm", "确认报价", "quote", "confirm"],
  ["quote:cancel", "取消报价", "quote", "cancel"],
  ["order:view", "查看订单", "order", "view"],
  ["order:create", "创建订单", "order", "create"],
  ["order:update", "编辑订单", "order", "update"],
  ["order:cancel", "取消订单", "order", "cancel"],
  ["order_change:view", "查看订单变更", "order", "change_view"],
  ["order_change:create", "创建订单变更", "order", "change_create"],
  ["order_change:approve", "审批订单变更", "order", "change_approve"],
  ["order_change:reject", "拒绝订单变更", "order", "change_reject"],
  ["contract:view", "查看合同", "contract", "view"],
  ["contract:generate", "生成合同", "contract", "generate"],
  ["contract:sign", "签署合同", "contract", "sign"],
  ["contract:archive", "归档合同", "contract", "archive"],
  ["contract:cancel", "取消合同", "contract", "cancel"],
  ["contract_template:view", "查看合同模板", "contract", "template_view"],
  ["contract_template:create", "新建合同模板", "contract", "template_create"],
  ["contract_template:update", "编辑合同模板", "contract", "template_update"],
  ["contract_template:activate", "启用合同模板", "contract", "template_activate"]
];

permissionRows.push(
  ["vehicle_package:view", "查看车型包", "product", "vehicle_package_view"],
  ["vehicle_package:create", "新建车型包", "product", "vehicle_package_create"],
  ["vehicle_package:update", "编辑车型包", "product", "vehicle_package_update"],
  ["vehicle_package:activate", "启用车型包", "product", "vehicle_package_activate"],
  ["vehicle_package:delete", "删除车型包", "product", "vehicle_package_delete"],
  ["mileage_package:view", "查看里程包", "product", "mileage_package_view"],
  ["mileage_package:create", "新建里程包", "product", "mileage_package_create"],
  ["mileage_package:update", "编辑里程包", "product", "mileage_package_update"],
  ["mileage_package:activate", "启用里程包", "product", "mileage_package_activate"],
  ["mileage_package:delete", "删除里程包", "product", "mileage_package_delete"],
  ["energy_package:view", "查看补能包", "product", "energy_package_view"],
  ["energy_package:create", "新建补能包", "product", "energy_package_create"],
  ["energy_package:update", "编辑补能包", "product", "energy_package_update"],
  ["energy_package:activate", "启用补能包", "product", "energy_package_activate"],
  ["energy_package:delete", "删除补能包", "product", "energy_package_delete"],
  ["benefit_package:view", "查看权益包", "product", "benefit_package_view"],
  ["benefit_package:create", "新建权益包", "product", "benefit_package_create"],
  ["benefit_package:update", "编辑权益包", "product", "benefit_package_update"],
  ["benefit_package:activate", "启用权益包", "product", "benefit_package_activate"],
  ["benefit_package:delete", "删除权益包", "product", "benefit_package_delete"]
);

const menuRows = [
  ["dashboard", "首页驾驶舱", "/", "dashboard", 10, "dashboard:view", null],
  ["customers", "客户中心", "/customers", "customer", 20, "customer:view", null],
  ["applications", "进件管理", "/applications", "application", 30, "application:view", null],
  ["risk", "风控中心", "/risk", "safety", 40, "risk:view", null],
  ["risk.deposit_rules", "押金规则", "/risk/deposit-rules", "money", 10, "risk:view", "risk"],
  ["products", "产品中心", "/products", "product", 50, "product:view", null],
  ["quotes", "订阅报价", "/quotes", "quote", 60, "quote:view", null],
  ["orders", "订单中心", "/orders", "order", 70, "order:view", null],
  ["orders.subscription", "订阅订单", "/orders", "order", 10, "order:view", "orders"],
  ["orders.contracts", "合同管理", "/contracts", "contract", 20, "contract:view", "orders"],
  ["orders.contract_templates", "合同模板", "/contract-versions", "file", 30, "contract_template:view", "orders"],
  ["system", "系统管理", "/system", "setting", 90, "user:view", null],
  ["system.users", "用户管理", "/system/users", "team", 10, "user:view", "system"],
  ["system.roles", "角色管理", "/system/roles", "safety", 20, "role:view", "system"],
  ["system.permissions", "权限管理", "/system/permissions", "key", 30, "permission:view", "system"],
  ["system.audit_logs", "操作日志", "/system/audit-logs", "audit", 40, "audit_log:view", "system"]
];

menuRows.push(
  ["products.subscription", "订阅产品", "/products?tab=products", "product", 10, "product:view", "products"],
  ["products.versions", "产品版本", "/products?tab=versions", "file", 20, "product_version:view", "products"],
  ["products.vehicle_packages", "车型包", "/products?tab=vehicle-packages", "car", 30, "vehicle_package:view", "products"],
  ["products.mileage_packages", "里程包", "/products?tab=mileage-packages", "dashboard", 40, "mileage_package:view", "products"],
  ["products.energy_packages", "补能包", "/products?tab=energy-packages", "money", 50, "energy_package:view", "products"],
  ["products.benefit_packages", "权益包", "/products?tab=benefit-packages", "safety", 60, "benefit_package:view", "products"]
);

const defaultDepositRules = [
  {
    customerRatio: "0.550000",
    defaultRate: "0.018000",
    depositAmount: 500000,
    grade: "A"
  },
  {
    customerRatio: "0.350000",
    defaultRate: "0.028000",
    depositAmount: 1000000,
    grade: "B"
  },
  {
    customerRatio: "0.100000",
    defaultRate: "0.045000",
    depositAmount: 2000000,
    grade: "C"
  }
];

const productManagementPermissions = [
  "product:view",
  "product:create",
  "product:update",
  "product:activate",
  "product_version:view",
  "product_version:create",
  "product_version:update",
  "product_version:approve",
  "product_version:activate",
  "product_price_rule:view",
  "product_price_rule:create",
  "product_price_rule:update",
  "product_price_rule:delete"
];

productManagementPermissions.push(
  "vehicle_package:view",
  "vehicle_package:create",
  "vehicle_package:update",
  "vehicle_package:activate",
  "vehicle_package:delete",
  "mileage_package:view",
  "mileage_package:create",
  "mileage_package:update",
  "mileage_package:activate",
  "mileage_package:delete",
  "energy_package:view",
  "energy_package:create",
  "energy_package:update",
  "energy_package:activate",
  "energy_package:delete",
  "benefit_package:view",
  "benefit_package:create",
  "benefit_package:update",
  "benefit_package:activate",
  "benefit_package:delete"
);

const quoteManagementPermissions = [
  "quote:view",
  "quote:create",
  "quote:update",
  "quote:confirm",
  "quote:cancel"
];

const orderManagementPermissions = [
  "order:view",
  "order:create",
  "order:update",
  "order:cancel",
  "order_change:view",
  "order_change:create",
  "order_change:approve",
  "order_change:reject",
  "contract:view",
  "contract:generate",
  "contract:sign",
  "contract:archive",
  "contract:cancel",
  "contract_template:view",
  "contract_template:create",
  "contract_template:update",
  "contract_template:activate"
];

const productMenuCodes = [
  "products",
  "products.subscription",
  "products.versions",
  "products.vehicle_packages",
  "products.mileage_packages",
  "products.energy_packages",
  "products.benefit_packages"
];

const productPackageViewPermissions = [
  "vehicle_package:view",
  "mileage_package:view",
  "energy_package:view",
  "benefit_package:view"
];

async function main() {
  for (const [code, name, description] of roleRows) {
    await prisma.role.upsert({
      create: { code, name, description },
      update: { name, description, status: "ACTIVE" },
      where: { code }
    });
  }

  for (const [code, name, module, action] of permissionRows) {
    await prisma.permission.upsert({
      create: { action, code, module, name },
      update: { action, module, name, status: "ACTIVE" },
      where: { code }
    });
  }

  const menuIdByCode = new Map();

  for (const [code, name, path, icon, sortOrder, permissionCode] of menuRows.filter(
    (row) => !row[6]
  )) {
    const menu = await prisma.menu.upsert({
      create: { code, icon, name, path, permissionCode, sortOrder },
      update: { icon, name, path, permissionCode, sortOrder, status: "ACTIVE" },
      where: { code }
    });
    menuIdByCode.set(code, menu.id);
  }

  for (const [code, name, path, icon, sortOrder, permissionCode, parentCode] of menuRows.filter(
    (row) => row[6]
  )) {
    const parentId = menuIdByCode.get(parentCode);
    const menu = await prisma.menu.upsert({
      create: { code, icon, name, parentId, path, permissionCode, sortOrder },
      update: { icon, name, parentId, path, permissionCode, sortOrder, status: "ACTIVE" },
      where: { code }
    });
    menuIdByCode.set(code, menu.id);
  }

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: "ADMIN" } });
  const allPermissions = await prisma.permission.findMany();
  const allMenus = await prisma.menu.findMany();

  await prisma.rolePermission.createMany({
    data: allPermissions.map((permission) => ({
      permissionId: permission.id,
      roleId: adminRole.id
    })),
    skipDuplicates: true
  });

  await prisma.roleMenu.createMany({
    data: allMenus.map((menu) => ({
      menuId: menu.id,
      roleId: adminRole.id
    })),
    skipDuplicates: true
  });

  await assignRoleAccess(
    "SA",
    [
      "dashboard:view",
      "customer:view",
      "customer:manage",
      "application:view",
      "application:manage",
      "application:submit",
      "application:material_upload",
      "application:material_delete",
      "product:view",
      "product_version:view",
      "product_price_rule:view",
      ...productPackageViewPermissions,
      ...quoteManagementPermissions,
      "order:view",
      "order:create",
      "order_change:view",
      "order_change:create",
      "contract:view"
    ],
    ["dashboard", "customers", "applications", ...productMenuCodes, "quotes", "orders", "orders.subscription", "orders.contracts"]
  );

  await assignRoleAccess(
    "OP",
    [
      "dashboard:view",
      "customer:view",
      "application:view",
      "application:submit",
      "application:material_upload",
      "application:material_delete",
      ...productManagementPermissions,
      ...quoteManagementPermissions,
      ...orderManagementPermissions
    ],
    ["dashboard", "customers", "applications", ...productMenuCodes, "quotes", "orders", "orders.subscription", "orders.contracts", "orders.contract_templates"]
  );

  await assignRoleAccess(
    "RC",
    [
      "dashboard:view",
      "customer:view",
      "application:view",
      "application:material_upload",
      "application:material_delete",
      "application:review",
      "risk:view",
      "risk:manage",
      "product:view",
      "product_version:view",
      "product_version:approve",
      "product_price_rule:view",
      ...productPackageViewPermissions,
      "quote:view",
      "order:view",
      "order_change:view",
      "order_change:approve",
      "order_change:reject",
      "contract:view"
    ],
    ["dashboard", "customers", "applications", "risk", "risk.deposit_rules", ...productMenuCodes, "quotes", "orders", "orders.subscription", "orders.contracts"]
  );

  for (const roleCode of ["FI", "AS"]) {
    await assignRoleAccess(
      roleCode,
      [
        "dashboard:view",
        "product:view",
        "product_version:view",
        "product_price_rule:view",
        ...productPackageViewPermissions,
        "quote:view",
        "order:view",
        "order_change:view",
        "order_change:approve",
        "order_change:reject",
        "contract:view"
      ],
      ["dashboard", ...productMenuCodes, "quotes", "orders", "orders.subscription", "orders.contracts"]
    );
  }

  await assignRoleAccess(
    "GM",
    [
      "dashboard:view",
      "customer:view",
      "application:view",
      "application:review",
      "risk:view",
      "risk:manage",
      ...productManagementPermissions,
      "quote:view",
      ...orderManagementPermissions
    ],
    ["dashboard", "customers", "applications", "risk", "risk.deposit_rules", ...productMenuCodes, "quotes", "orders", "orders.subscription", "orders.contracts", "orders.contract_templates"]
  );

  const passwordHash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD ?? "Admin@123456", 12);
  const adminUser = await prisma.user.upsert({
    create: {
      email: "admin@example.com",
      name: "系统管理员",
      passwordHash,
      username: "admin"
    },
    update: {
      name: "系统管理员",
      status: "ACTIVE"
    },
    where: { username: "admin" }
  });

  await prisma.userRole.upsert({
    create: {
      roleId: adminRole.id,
      userId: adminUser.id
    },
    update: {},
    where: {
      userId_roleId: {
        roleId: adminRole.id,
        userId: adminUser.id
      }
    }
  });

  await seedDefaultDepositRules(adminUser.id);

  await prisma.auditLog.create({
    data: {
      action: "CREATE",
      afterSnapshot: { username: "admin", roles: ["ADMIN"] },
      entityId: adminUser.id,
      entityType: "user",
      module: "system"
    }
  });
}

async function assignRoleAccess(roleCode, permissionCodes, menuCodes) {
  const role = await prisma.role.findUnique({ where: { code: roleCode } });

  if (!role) {
    return;
  }

  const permissions = await prisma.permission.findMany({
    where: { code: { in: permissionCodes } }
  });
  const menus = await prisma.menu.findMany({
    where: { code: { in: menuCodes } }
  });

  await prisma.rolePermission.createMany({
    data: permissions.map((permission) => ({
      permissionId: permission.id,
      roleId: role.id
    })),
    skipDuplicates: true
  });

  await prisma.roleMenu.createMany({
    data: menus.map((menu) => ({
      menuId: menu.id,
      roleId: role.id
    })),
    skipDuplicates: true
  });
}

async function seedDefaultDepositRules(operatorId) {
  const effectiveFrom = new Date("2026-01-01T00:00:00.000Z");

  for (const rule of defaultDepositRules) {
    const existing = await prisma.depositRule.findFirst({
      where: {
        deletedAt: null,
        effectiveFrom,
        grade: rule.grade
      }
    });

    if (existing) {
      await prisma.depositRule.update({
        data: {
          customerRatio: rule.customerRatio,
          defaultRate: rule.defaultRate,
          depositAmount: rule.depositAmount,
          status: "ACTIVE",
          updatedBy: operatorId
        },
        where: { id: existing.id }
      });
      continue;
    }

    await prisma.depositRule.create({
      data: {
        createdBy: operatorId,
        customerRatio: rule.customerRatio,
        defaultRate: rule.defaultRate,
        depositAmount: rule.depositAmount,
        effectiveFrom,
        grade: rule.grade,
        updatedBy: operatorId
      }
    });
  }
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}
