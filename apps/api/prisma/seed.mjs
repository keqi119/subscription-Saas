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
  ["order:review", "审核订单", "order", "review"],
  ["order:confirm_final_plan", "确认最终方案", "order", "confirm_final_plan"],
  ["order:reject", "拒绝订单", "order", "reject"],
  ["order_change:view", "查看订单变更", "order", "change_view"],
  ["order_change:create", "创建订单变更", "order", "change_create"],
  ["order_change:approve", "审批订单变更", "order", "change_approve"],
  ["order_change:reject", "拒绝订单变更", "order", "change_reject"],
  ["order_change:execute", "执行订单变更", "order", "change_execute"],
  ["delivery:view", "查看车辆交付", "delivery", "view"],
  ["delivery:prepare", "准备车辆交付", "delivery", "prepare"],
  ["delivery:confirm", "确认车辆交付", "delivery", "confirm"],
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
  ["benefit_package:delete", "删除权益包", "product", "benefit_package_delete"],
  ["subscription_plan:view", "查看订阅套餐", "product", "subscription_plan_view"],
  ["subscription_plan:create", "新建订阅套餐", "product", "subscription_plan_create"],
  ["subscription_plan:update", "编辑订阅套餐", "product", "subscription_plan_update"],
  ["subscription_plan:activate", "启用订阅套餐", "product", "subscription_plan_activate"],
  ["subscription_plan:deactivate", "停用订阅套餐", "product", "subscription_plan_deactivate"],
  ["subscription_plan:delete", "删除订阅套餐", "product", "subscription_plan_delete"],
  ["vehicle:view", "查看车辆资产", "vehicle", "view"],
  ["vehicle:create", "新建车辆资产", "vehicle", "create"],
  ["vehicle:update", "编辑车辆资产", "vehicle", "update"],
  ["vehicle:delete", "删除车辆资产", "vehicle", "delete"],
  ["vehicle:update_status", "更新车辆状态", "vehicle", "update_status"],
  ["vehicle:initialize_sale_price", "初始化车辆销售价", "vehicle", "initialize_sale_price"],
  ["vehicle:review_sale_price", "复核车辆销售价", "vehicle", "review_sale_price"],
  ["vehicle:history_view", "查看车辆销售价历史", "vehicle", "history_view"],
  ["vehicle:manage", "管理车辆资产", "vehicle", "manage"]
);

const menuRows = [
  ["dashboard", "首页驾驶舱", "/", "dashboard", 10, "dashboard:view", null],
  ["customers", "客户中心", "/customers", "customer", 20, "customer:view", null],
  ["applications", "进件管理", "/applications", "application", 30, "application:view", null],
  ["risk", "风控中心", "/risk", "safety", 40, "risk:view", null],
  ["risk.deposit_rules", "押金规则", "/risk/deposit-rules", "money", 10, "risk:view", "risk"],
  ["products", "产品中心", "/products", "product", 50, "product:view", null],
  ["vehicles", "车辆资产", "/vehicles", "car", 55, "vehicle:view", null],
  ["quotes", "订阅报价", "/quotes", "quote", 60, "quote:view", null],
  ["orders", "订单中心", "/orders", "order", 70, "order:view", null],
  ["orders.subscription", "订阅订单", "/orders", "order", 10, "order:view", "orders"],
  ["orders.review", "旧版订单审核", "/orders/review", "audit", 15, "order:review", "orders"],
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
  ["products.benefit_packages", "权益包", "/products?tab=benefit-packages", "safety", 60, "benefit_package:view", "products"],
  ["products.subscription_plans", "订阅套餐", "/products?tab=subscription-plans", "quote", 70, "subscription_plan:view", "products"]
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

const demoVehicles = [
  {
    brand: "NIO",
    batteryCapacityKwh: 75,
    batteryUsageType: "BUYOUT",
    currentMileageKm: 3200,
    currentSalePriceAmount: 14800000,
    model: "ET5 75kWh",
    modelYear: 2026,
    plateNo: "沪AET5001",
    purchasePriceAmount: 15000000,
    series: "ET5",
    vehicleModel: "ET5",
    vehicleNo: "VEH-DEMO-ET5-001",
    vin: "TESTVINET50000001"
  },
  {
    brand: "NIO",
    batteryCapacityKwh: 100,
    batteryUsageType: "BUYOUT",
    currentMileageKm: 2100,
    currentSalePriceAmount: 20500000,
    model: "ET7 100kWh",
    modelYear: 2026,
    plateNo: "沪AET7001",
    purchasePriceAmount: 21000000,
    series: "ET7",
    vehicleModel: "ET7",
    vehicleNo: "VEH-DEMO-ET7-001",
    vin: "TESTVINET70000001"
  },
  {
    brand: "NIO",
    batteryCapacityKwh: 75,
    batteryUsageType: "BUYOUT",
    currentMileageKm: 2800,
    currentSalePriceAmount: 17600000,
    model: "ES6 75kWh",
    modelYear: 2026,
    plateNo: "沪AES6001",
    purchasePriceAmount: 18000000,
    series: "ES6",
    vehicleModel: "ES6",
    vehicleNo: "VEH-DEMO-ES6-001",
    vin: "TESTVINES60000001"
  }
];

const CUSTOMER_SELF_SERVICE_DEPOSIT_NOTICE =
  "当前选择为意向订阅方案，押金金额将根据您的资质审核结果最终确认。";

const autoReviewSeed = {
  applicationNo: "APP-AUTO-REVIEW-ET5-001",
  benefitPackageNo: "BPK-AUTO-ET5-WASH",
  benefitPackagePriceAmount: 30000,
  customerMobile: "13900000051",
  customerName: "A线自助下单测试客户",
  customerNo: "CUS-AUTO-REVIEW-001",
  energyPackageNo: "EPK-AUTO-ET5-POWER",
  energyPackagePriceAmount: 120000,
  mileagePackageNo: "MPK-AUTO-ET5-1500",
  mileagePackagePriceAmount: 80000,
  orderNo: "ORD-AUTO-REVIEW-ET5-001",
  planNo: "PLAN-AUTO-ET5-STANDARD",
  productNo: "PROD-AUTO-ET5",
  quoteNo: "QUO-AUTO-REVIEW-ET5-001",
  vehicleNo: "VEH-AUTO-REVIEW-ET5-001",
  vehiclePackageNo: "VPK-AUTO-ET5-STANDARD",
  versionNo: "2026-AUTO-REVIEW",
  vin: "TESTAUTOORDERET5001"
};

const selfServiceApplicationReviewSeed = {
  applicationNo: "APP-SELF-SERVICE-REVIEW-001",
  customerMobile: "13900000052",
  customerName: "A线自助进件测试客户",
  customerNo: "CUS-SELF-SERVICE-APP-001",
  plateNo: "沪A自助02",
  vehicleNo: "VEH-SELF-SERVICE-APP-ET5-001",
  vin: "TESTSELFAPPET5001"
};

const deliveryHandoverAcceptanceSeeds = [
  {
    applicationNo: "APP-DELIVERY-PREPARE-001",
    contractNo: "CON-DELIVERY-PREPARE-001",
    customerMobile: "13900000061",
    customerName: "交付验收测试客户A",
    customerNo: "CUS-DELIVERY-PREPARE-001",
    deliveryNo: null,
    deliveryScenario: "PREPARE",
    orderNo: "ORD-DELIVERY-PREPARE-001",
    plateNo: "沪A交付01",
    quoteNo: "QUO-DELIVERY-PREPARE-001",
    vehicleNo: "VEH-DELIVERY-PREPARE-001",
    vin: "TESTDELIVERYPREPARE001"
  },
  {
    applicationNo: "APP-DELIVERY-CONFIRM-001",
    contractNo: "CON-DELIVERY-CONFIRM-001",
    customerMobile: "13900000062",
    customerName: "交付验收测试客户B",
    customerNo: "CUS-DELIVERY-CONFIRM-001",
    deliveryNo: "DLV-DELIVERY-CONFIRM-001",
    deliveryScenario: "CONFIRM",
    orderNo: "ORD-DELIVERY-CONFIRM-001",
    plateNo: "沪A交付02",
    quoteNo: "QUO-DELIVERY-CONFIRM-001",
    vehicleNo: "VEH-DELIVERY-CONFIRM-001",
    vin: "TESTDELIVERYCONFIRM001"
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

const subscriptionPlanManagementPermissions = [
  "subscription_plan:view",
  "subscription_plan:create",
  "subscription_plan:update",
  "subscription_plan:activate",
  "subscription_plan:deactivate",
  "subscription_plan:delete"
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
  "benefit_package:delete",
  ...subscriptionPlanManagementPermissions
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
  "order:review",
  "order:confirm_final_plan",
  "order:reject",
  "order_change:view",
  "order_change:create",
  "delivery:view",
  "delivery:prepare",
  "delivery:confirm",
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
  "products.benefit_packages",
  "products.subscription_plans"
];

const productPackageViewPermissions = [
  "vehicle_package:view",
  "mileage_package:view",
  "energy_package:view",
  "benefit_package:view",
  "subscription_plan:view"
];

const vehicleViewPermissions = ["vehicle:view", "vehicle:history_view"];

const vehicleManagementPermissions = [
  ...vehicleViewPermissions,
  "vehicle:create",
  "vehicle:update",
  "vehicle:delete",
  "vehicle:update_status",
  "vehicle:initialize_sale_price",
  "vehicle:review_sale_price",
  "vehicle:manage"
];
const vehicleMenuCodes = ["vehicles"];

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
      ...vehicleViewPermissions,
      ...quoteManagementPermissions,
      "order:view",
      "order:create",
      "order_change:view",
      "order_change:create",
      "delivery:view",
      "contract:view"
    ],
    ["dashboard", "customers", "applications", ...productMenuCodes, ...vehicleMenuCodes, "quotes", "orders", "orders.subscription", "orders.contracts"]
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
      ...vehicleManagementPermissions,
      ...quoteManagementPermissions,
      ...orderManagementPermissions,
      "order_change:approve",
      "order_change:reject",
      "order_change:execute"
    ],
    ["dashboard", "customers", "applications", ...productMenuCodes, ...vehicleMenuCodes, "quotes", "orders", "orders.subscription", "orders.review", "orders.contracts", "orders.contract_templates"]
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
      ...vehicleViewPermissions,
      "quote:view",
      "order:view",
      "order:review",
      "order:reject",
      "order_change:view",
      "contract:view"
    ],
    ["dashboard", "customers", "applications", "risk", "risk.deposit_rules", ...productMenuCodes, ...vehicleMenuCodes, "quotes", "orders", "orders.subscription", "orders.review", "orders.contracts"]
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
        ...(roleCode === "AS" ? vehicleManagementPermissions : vehicleViewPermissions),
        "quote:view",
        "order:view",
        ...(roleCode === "AS" ? ["delivery:view", "delivery:prepare", "delivery:confirm"] : []),
        ...(roleCode === "AS" ? ["order:review", "order:reject"] : []),
        "order_change:view",
        "contract:view"
      ],
      ["dashboard", ...productMenuCodes, ...vehicleMenuCodes, "quotes", "orders", "orders.subscription", ...(roleCode === "AS" ? ["orders.review"] : []), "orders.contracts"]
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
      ...vehicleManagementPermissions,
      "quote:view",
      ...orderManagementPermissions
    ],
    ["dashboard", "customers", "applications", "risk", "risk.deposit_rules", ...productMenuCodes, ...vehicleMenuCodes, "quotes", "orders", "orders.subscription", "orders.review", "orders.contracts", "orders.contract_templates"]
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
  await seedDemoVehicles(adminUser.id);
  await seedCustomerSelfServiceReviewOrder(adminUser.id);
  await seedSelfServiceApplicationReviewScenario(adminUser.id);
  await seedDeliveryHandoverAcceptanceOrders(adminUser.id);

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

async function seedDemoVehicles(operatorId) {
  const effectiveFrom = new Date("2026-06-01T00:00:00.000Z");
  const reviewedAt = new Date("2026-06-02T00:00:00.000Z");
  const nextSalePriceReviewAt = new Date("2026-09-01T00:00:00.000Z");

  for (const vehicleSeed of demoVehicles) {
    const vehicle = await prisma.vehicle.upsert({
      create: {
        assetLocation: "上海验收车库",
        batteryCapacityKwh: vehicleSeed.batteryCapacityKwh,
        batteryUsageType: vehicleSeed.batteryUsageType,
        brand: vehicleSeed.brand,
        createdBy: operatorId,
        currentMileageKm: vehicleSeed.currentMileageKm,
        currentSalePriceAmount: BigInt(vehicleSeed.currentSalePriceAmount),
        currentSalePriceInitializedAt: reviewedAt,
        currentSalePriceReviewedAt: reviewedAt,
        model: vehicleSeed.model,
        modelYear: vehicleSeed.modelYear,
        nextSalePriceReviewAt,
        plateNo: vehicleSeed.plateNo,
        purchaseDate: new Date("2026-05-20T00:00:00.000Z"),
        purchasePriceAmount: BigInt(vehicleSeed.purchasePriceAmount),
        remark: "PR 人工验收测试车辆",
        salePriceStatus: "EFFECTIVE",
        series: vehicleSeed.series,
        status: "AVAILABLE",
        updatedBy: operatorId,
        vehicleModel: vehicleSeed.vehicleModel,
        vehicleNo: vehicleSeed.vehicleNo,
        vin: vehicleSeed.vin
      },
      update: {
        assetLocation: "上海验收车库",
        batteryCapacityKwh: vehicleSeed.batteryCapacityKwh,
        batteryUsageType: vehicleSeed.batteryUsageType,
        brand: vehicleSeed.brand,
        currentMileageKm: vehicleSeed.currentMileageKm,
        currentSalePriceAmount: BigInt(vehicleSeed.currentSalePriceAmount),
        currentSalePriceInitializedAt: reviewedAt,
        currentSalePriceReviewedAt: reviewedAt,
        deletedAt: null,
        model: vehicleSeed.model,
        modelYear: vehicleSeed.modelYear,
        nextSalePriceReviewAt,
        plateNo: vehicleSeed.plateNo,
        purchaseDate: new Date("2026-05-20T00:00:00.000Z"),
        purchasePriceAmount: BigInt(vehicleSeed.purchasePriceAmount),
        remark: "PR 人工验收测试车辆",
        salePriceReinitRequiredAt: null,
        salePriceStatus: "EFFECTIVE",
        series: vehicleSeed.series,
        status: "AVAILABLE",
        updatedBy: operatorId,
        vehicleModel: vehicleSeed.vehicleModel,
        vehicleNo: vehicleSeed.vehicleNo
      },
      where: { vin: vehicleSeed.vin }
    });

    const existingHistory = await prisma.vehicleSalePriceHistory.findFirst({
      where: {
        effectiveFrom,
        reviewType: "INITIAL_POOL",
        vehicleId: vehicle.id
      }
    });

    const historyData = {
      afterSalePriceAmount: BigInt(vehicleSeed.currentSalePriceAmount),
      beforeSalePriceAmount: null,
      createdBy: operatorId,
      effectiveFrom,
      reason: "PR 人工验收测试车辆初始化",
      remark: "seed demo vehicle",
      reviewQuarter: "2026Q2",
      reviewType: "INITIAL_POOL"
    };

    if (existingHistory) {
      await prisma.vehicleSalePriceHistory.update({
        data: historyData,
        where: { id: existingHistory.id }
      });
      continue;
    }

    await prisma.vehicleSalePriceHistory.create({
      data: {
        ...historyData,
        vehicleId: vehicle.id
      }
    });
  }
}

async function seedCustomerSelfServiceReviewOrder(operatorId) {
  const now = new Date("2026-06-05T00:00:00.000Z");
  const effectiveFrom = new Date("2026-06-01T00:00:00.000Z");
  const reviewedAt = new Date("2026-06-02T00:00:00.000Z");
  const nextSalePriceReviewAt = new Date("2026-09-01T00:00:00.000Z");
  const periodMonths = 12;
  const vehicleSalePriceAmount = 14800000;
  const vehiclePurchasePriceAmount = 15000000;
  const vehicleBaseFeeAmount = 520000;
  const vehiclePackageRate = "0.040000";
  const monthlyFeeRate = "0.035000";
  const vehicleBaseFeeCapAmount = 592000;
  const monthlyFeeAmount =
    vehicleBaseFeeAmount +
    autoReviewSeed.mileagePackagePriceAmount +
    autoReviewSeed.energyPackagePriceAmount +
    autoReviewSeed.benefitPackagePriceAmount;
  const mileageLimitKm = 1500;
  const overMileageFeeAmount = 120;
  const energyLimitKwh = 200;
  const energyLimitCount = 4;

  const product = await prisma.product.upsert({
    create: {
      createdBy: operatorId,
      description: "A 线自助下单人工验收专用订阅产品",
      name: "A线ET5自助订阅产品",
      productNo: autoReviewSeed.productNo,
      productType: "SUBSCRIPTION",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    update: {
      deletedAt: null,
      description: "A 线自助下单人工验收专用订阅产品",
      name: "A线ET5自助订阅产品",
      productType: "SUBSCRIPTION",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    where: { productNo: autoReviewSeed.productNo }
  });

  const productVersion = await prisma.productVersion.upsert({
    create: {
      approvedAt: reviewedAt,
      approvedBy: operatorId,
      createdBy: operatorId,
      effectiveFrom,
      productId: product.id,
      status: "ACTIVE",
      updatedBy: operatorId,
      versionNo: autoReviewSeed.versionNo
    },
    update: {
      approvedAt: reviewedAt,
      approvedBy: operatorId,
      deletedAt: null,
      effectiveFrom,
      effectiveTo: null,
      status: "ACTIVE",
      updatedBy: operatorId
    },
    where: {
      productId_versionNo: {
        productId: product.id,
        versionNo: autoReviewSeed.versionNo
      }
    }
  });

  await prisma.productPriceRule.upsert({
    create: {
      baseMileageKm: mileageLimitKm,
      createdBy: operatorId,
      energyLimitCount,
      energyLimitKwh,
      maxPeriodMonths: 36,
      minPeriodMonths: 12,
      monthlyFeeRate,
      overMileageFeeAmount: BigInt(overMileageFeeAmount),
      productVersionId: productVersion.id,
      status: "ACTIVE",
      updatedBy: operatorId,
      vehicleModel: "ET5"
    },
    update: {
      baseMileageKm: mileageLimitKm,
      deletedAt: null,
      energyLimitCount,
      energyLimitKwh,
      maxPeriodMonths: 36,
      minPeriodMonths: 12,
      monthlyFeeRate,
      overMileageFeeAmount: BigInt(overMileageFeeAmount),
      status: "ACTIVE",
      updatedBy: operatorId
    },
    where: {
      productVersionId_vehicleModel: {
        productVersionId: productVersion.id,
        vehicleModel: "ET5"
      }
    }
  });

  const vehiclePackage = await prisma.vehiclePackage.upsert({
    create: {
      brand: "NIO",
      configName: "ET5 标准验收配置",
      createdBy: operatorId,
      maxPeriodMonths: 36,
      maxPurchasePriceAmount: BigInt(18000000),
      minPeriodMonths: 12,
      minPurchasePriceAmount: BigInt(10000000),
      monthlyFeeRate: vehiclePackageRate,
      packageName: "A线ET5标准车型包",
      packageNo: autoReviewSeed.vehiclePackageNo,
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "A 线自助下单人工验收车型包",
      series: "ET5",
      status: "ACTIVE",
      updatedBy: operatorId,
      vehicleModel: "ET5",
      vehicleModelName: "ET5"
    },
    update: {
      brand: "NIO",
      configName: "ET5 标准验收配置",
      deletedAt: null,
      maxPeriodMonths: 36,
      maxPurchasePriceAmount: BigInt(18000000),
      minPeriodMonths: 12,
      minPurchasePriceAmount: BigInt(10000000),
      monthlyFeeRate: vehiclePackageRate,
      packageName: "A线ET5标准车型包",
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "A 线自助下单人工验收车型包",
      series: "ET5",
      status: "ACTIVE",
      updatedBy: operatorId,
      vehicleModel: "ET5",
      vehicleModelName: "ET5"
    },
    where: { packageNo: autoReviewSeed.vehiclePackageNo }
  });

  const mileagePackage = await prisma.mileagePackage.upsert({
    create: {
      createdBy: operatorId,
      monthlyMileageKm: mileageLimitKm,
      overMileageFeeAmount: BigInt(overMileageFeeAmount),
      packageName: "A线ET5 1500km里程包",
      packageNo: autoReviewSeed.mileagePackageNo,
      priceAmount: BigInt(autoReviewSeed.mileagePackagePriceAmount),
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "A 线自助下单人工验收里程包",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    update: {
      deletedAt: null,
      monthlyMileageKm: mileageLimitKm,
      overMileageFeeAmount: BigInt(overMileageFeeAmount),
      packageName: "A线ET5 1500km里程包",
      priceAmount: BigInt(autoReviewSeed.mileagePackagePriceAmount),
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "A 线自助下单人工验收里程包",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    where: { packageNo: autoReviewSeed.mileagePackageNo }
  });

  const energyPackage = await prisma.energyPackage.upsert({
    create: {
      createdBy: operatorId,
      monthlyEnergyCount: energyLimitCount,
      monthlyEnergyKwh: energyLimitKwh,
      packageName: "A线ET5补能包",
      packageNo: autoReviewSeed.energyPackageNo,
      priceAmount: BigInt(autoReviewSeed.energyPackagePriceAmount),
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "A 线自助下单人工验收补能包",
      serviceDescription: "每月 4 次补能服务",
      stationScope: "上海核心城区",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    update: {
      deletedAt: null,
      monthlyEnergyCount: energyLimitCount,
      monthlyEnergyKwh: energyLimitKwh,
      packageName: "A线ET5补能包",
      priceAmount: BigInt(autoReviewSeed.energyPackagePriceAmount),
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "A 线自助下单人工验收补能包",
      serviceDescription: "每月 4 次补能服务",
      stationScope: "上海核心城区",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    where: { packageNo: autoReviewSeed.energyPackageNo }
  });

  const benefitPackage = await prisma.benefitPackage.upsert({
    create: {
      benefitCount: 2,
      benefitType: "WASH_CAR",
      createdBy: operatorId,
      description: "每月 2 次洗车权益",
      packageName: "A线ET5权益包",
      packageNo: autoReviewSeed.benefitPackageNo,
      priceAmount: BigInt(autoReviewSeed.benefitPackagePriceAmount),
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "A 线自助下单人工验收权益包",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    update: {
      benefitCount: 2,
      benefitType: "WASH_CAR",
      deletedAt: null,
      description: "每月 2 次洗车权益",
      packageName: "A线ET5权益包",
      priceAmount: BigInt(autoReviewSeed.benefitPackagePriceAmount),
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "A 线自助下单人工验收权益包",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    where: { packageNo: autoReviewSeed.benefitPackageNo }
  });

  const subscriptionPlan = await prisma.subscriptionPlan.upsert({
    create: {
      baseMonthlyFeeAmount: BigInt(vehicleBaseFeeAmount),
      benefitPackageId: benefitPackage.id,
      createdBy: operatorId,
      effectiveFrom,
      energyPackageId: energyPackage.id,
      maxPeriodMonths: 36,
      mileagePackageId: mileagePackage.id,
      minPeriodMonths: 12,
      monthlyFeeCapRate: vehiclePackageRate,
      monthlyFeeMode: "FIXED_AMOUNT",
      monthlyFeeRate,
      planName: "A线ET5标准订阅套餐",
      planNo: autoReviewSeed.planNo,
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "A 线自助下单人工验收预设套餐",
      status: "ACTIVE",
      updatedBy: operatorId,
      vehiclePackageId: vehiclePackage.id
    },
    update: {
      baseMonthlyFeeAmount: BigInt(vehicleBaseFeeAmount),
      benefitPackageId: benefitPackage.id,
      deletedAt: null,
      effectiveFrom,
      effectiveTo: null,
      energyPackageId: energyPackage.id,
      maxPeriodMonths: 36,
      mileagePackageId: mileagePackage.id,
      minPeriodMonths: 12,
      monthlyFeeCapRate: vehiclePackageRate,
      monthlyFeeMode: "FIXED_AMOUNT",
      monthlyFeeRate,
      planName: "A线ET5标准订阅套餐",
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "A 线自助下单人工验收预设套餐",
      status: "ACTIVE",
      updatedBy: operatorId,
      vehiclePackageId: vehiclePackage.id
    },
    where: { planNo: autoReviewSeed.planNo }
  });

  const vehicle = await prisma.vehicle.upsert({
    create: {
      assetLocation: "上海验收车库",
      batteryCapacityKwh: 75,
      batteryUsageType: "BUYOUT",
      brand: "NIO",
      createdBy: operatorId,
      currentMileageKm: 1200,
      currentSalePriceAmount: BigInt(vehicleSalePriceAmount),
      currentSalePriceInitializedAt: reviewedAt,
      currentSalePriceReviewedAt: reviewedAt,
      model: "ET5 75kWh",
      modelYear: 2026,
      nextSalePriceReviewAt,
      plateNo: "沪A自助01",
      purchaseDate: new Date("2026-05-25T00:00:00.000Z"),
      purchasePriceAmount: BigInt(vehiclePurchasePriceAmount),
      remark: "A 线自助下单人工验收测试车辆",
      salePriceStatus: "EFFECTIVE",
      series: "ET5",
      status: "AVAILABLE",
      updatedBy: operatorId,
      vehicleModel: "ET5",
      vehicleNo: autoReviewSeed.vehicleNo,
      vin: autoReviewSeed.vin
    },
    update: {
      assetLocation: "上海验收车库",
      batteryCapacityKwh: 75,
      batteryUsageType: "BUYOUT",
      brand: "NIO",
      currentMileageKm: 1200,
      currentSalePriceAmount: BigInt(vehicleSalePriceAmount),
      currentSalePriceInitializedAt: reviewedAt,
      currentSalePriceReviewedAt: reviewedAt,
      deletedAt: null,
      model: "ET5 75kWh",
      modelYear: 2026,
      nextSalePriceReviewAt,
      plateNo: "沪A自助01",
      purchaseDate: new Date("2026-05-25T00:00:00.000Z"),
      purchasePriceAmount: BigInt(vehiclePurchasePriceAmount),
      remark: "A 线自助下单人工验收测试车辆",
      salePriceReinitRequiredAt: null,
      salePriceStatus: "EFFECTIVE",
      series: "ET5",
      status: "AVAILABLE",
      updatedBy: operatorId,
      vehicleModel: "ET5",
      vehicleNo: autoReviewSeed.vehicleNo
    },
    where: { vin: autoReviewSeed.vin }
  });

  await upsertInitialSalePriceHistory({
    effectiveFrom,
    operatorId,
    reason: "A 线自助下单验收车辆初始化",
    remark: "seed customer self-service review order",
    vehicleId: vehicle.id,
    vehicleSalePriceAmount
  });

  const customer = await prisma.customer.upsert({
    create: {
      createdBy: operatorId,
      customerNo: autoReviewSeed.customerNo,
      mobile: autoReviewSeed.customerMobile,
      name: autoReviewSeed.customerName,
      ownerUserId: operatorId,
      remark: "A 线自助下单人工验收客户",
      sourceChannel: "客户自助",
      status: "PENDING_APPLICATION",
      updatedBy: operatorId
    },
    update: {
      deletedAt: null,
      grade: null,
      mobile: autoReviewSeed.customerMobile,
      name: autoReviewSeed.customerName,
      ownerUserId: operatorId,
      remark: "A 线自助下单人工验收客户",
      sourceChannel: "客户自助",
      status: "PENDING_APPLICATION",
      updatedBy: operatorId
    },
    where: { customerNo: autoReviewSeed.customerNo }
  });

  const application = await prisma.application.upsert({
    create: {
      applicationNo: autoReviewSeed.applicationNo,
      createdBy: operatorId,
      customerId: customer.id,
      intendedModel: "ET5",
      intendedPeriodMonths: periodMonths,
      salesUserId: operatorId,
      status: "SUBMITTED",
      submittedAt: now,
      updatedBy: operatorId
    },
    update: {
      customerId: customer.id,
      deletedAt: null,
      intendedModel: "ET5",
      intendedPeriodMonths: periodMonths,
      rejectedReason: null,
      salesUserId: operatorId,
      status: "SUBMITTED",
      submittedAt: now,
      updatedBy: operatorId
    },
    where: { applicationNo: autoReviewSeed.applicationNo }
  });

  const existingActionLog = await prisma.applicationActionLog.findFirst({
    where: {
      actionType: "CREATE",
      applicationId: application.id,
      comment: "A 线自助下单 seed 自动生成进件"
    }
  });

  if (!existingActionLog) {
    await prisma.applicationActionLog.create({
      data: {
        actionType: "CREATE",
        applicationId: application.id,
        comment: "A 线自助下单 seed 自动生成进件",
        createdBy: operatorId,
        operatorId,
        operatorName: "系统管理员",
        toStatus: "SUBMITTED",
        updatedBy: operatorId
      }
    });
  }

  const vehicleSnapshot = {
    assetLocation: vehicle.assetLocation,
    batteryCapacityKwh: Number(vehicle.batteryCapacityKwh),
    batteryUsageType: vehicle.batteryUsageType,
    batteryUsageTypeLabel: "电池买断",
    brand: vehicle.brand,
    currentMileageKm: vehicle.currentMileageKm,
    currentSalePriceAmount: vehicleSalePriceAmount,
    plateNo: vehicle.plateNo,
    series: vehicle.series,
    status: "AVAILABLE",
    vehicleModel: "ET5",
    vehicleNo: vehicle.vehicleNo,
    vin: vehicle.vin
  };
  const packageSnapshot = {
    benefitPackage: toSeedPackageSnapshot(benefitPackage, {
      benefitCount: 2,
      benefitType: "WASH_CAR",
      description: "每月 2 次洗车权益",
      priceAmount: autoReviewSeed.benefitPackagePriceAmount
    }),
    energyPackage: toSeedPackageSnapshot(energyPackage, {
      monthlyEnergyCount: energyLimitCount,
      monthlyEnergyKwh: energyLimitKwh,
      priceAmount: autoReviewSeed.energyPackagePriceAmount
    }),
    mileagePackage: toSeedPackageSnapshot(mileagePackage, {
      monthlyMileageKm: mileageLimitKm,
      overMileageFeeAmount,
      priceAmount: autoReviewSeed.mileagePackagePriceAmount
    }),
    pricing: {
      benefitPackagePriceAmount: autoReviewSeed.benefitPackagePriceAmount,
      currentSalePriceAmount: vehicleSalePriceAmount,
      energyPackagePriceAmount: autoReviewSeed.energyPackagePriceAmount,
      fixedRate: null,
      mileagePackagePriceAmount: autoReviewSeed.mileagePackagePriceAmount,
      monthlyFeeAmount,
      vehicleBaseFeeAmount,
      vehicleBaseFeeCapAmount,
      vehicleBaseFeeMode: "FIXED_AMOUNT",
      vehicleBaseFeeModeLabel: "固定金额"
    },
    subscriptionPlan: {
      baseMonthlyFeeAmount: vehicleBaseFeeAmount,
      benefitPackageId: benefitPackage.id,
      effectiveFrom: "2026-06-01",
      effectiveTo: null,
      energyPackageId: energyPackage.id,
      id: subscriptionPlan.id,
      maxPeriodMonths: 36,
      mileagePackageId: mileagePackage.id,
      minPeriodMonths: 12,
      monthlyFeeCapRate: Number(vehiclePackageRate),
      monthlyFeeMode: "FIXED_AMOUNT",
      monthlyFeeModeLabel: "固定金额",
      monthlyFeeRate: Number(monthlyFeeRate),
      planName: "A线ET5标准订阅套餐",
      planNo: autoReviewSeed.planNo,
      productId: product.id,
      productVersionId: productVersion.id,
      status: "ACTIVE",
      vehiclePackageId: vehiclePackage.id
    },
    vehicleBaseFeeAmount,
    vehicleBaseFeeCapAmount,
    vehicleBaseFeeMode: "FIXED_AMOUNT",
    vehicleBaseFeeModeLabel: "固定金额",
    vehiclePackage: toSeedPackageSnapshot(vehiclePackage, {
      configName: "ET5 标准验收配置",
      maxPurchasePriceAmount: 18000000,
      minPurchasePriceAmount: 10000000,
      monthlyFeeRate: Number(vehiclePackageRate),
      vehicleModel: "ET5"
    })
  };
  const customerSelectedSnapshot = {
    customerId: customer.id,
    customerName: customer.name,
    depositDescription: CUSTOMER_SELF_SERVICE_DEPOSIT_NOTICE,
    depositStatus: "PENDING_CONFIRM",
    monthlyFeeAmount,
    periodMonths,
    selectedAt: now.toISOString(),
    subscriptionPlan: {
      planName: "A线ET5标准订阅套餐",
      planNo: autoReviewSeed.planNo
    },
    subscriptionPlanId: subscriptionPlan.id,
    vehicle: {
      plateNo: vehicle.plateNo,
      vehicleModel: "ET5",
      vehicleNo: vehicle.vehicleNo,
      vin: vehicle.vin
    },
    vehicleBaseFeeAmount,
    vehicleId: vehicle.id
  };
  const depositRuleSnapshot = {
    depositDescription: CUSTOMER_SELF_SERVICE_DEPOSIT_NOTICE,
    status: "PENDING_CONFIRM"
  };

  const quoteData = {
    applicationId: application.id,
    benefitPackageId: benefitPackage.id,
    benefitPackagePriceAmount: BigInt(autoReviewSeed.benefitPackagePriceAmount),
    customerId: customer.id,
    customerSelectedSnapshot,
    depositAmount: 0n,
    depositRuleSnapshot,
    energyLimitCount,
    energyLimitKwh,
    energyPackageId: energyPackage.id,
    energyPackagePriceAmount: BigInt(autoReviewSeed.energyPackagePriceAmount),
    mileageLimitKm,
    mileagePackageId: mileagePackage.id,
    mileagePackagePriceAmount: BigInt(autoReviewSeed.mileagePackagePriceAmount),
    monthlyFeeAmount: BigInt(monthlyFeeAmount),
    monthlyFeeCapAmount: BigInt(vehicleBaseFeeCapAmount),
    monthlyFeeRate,
    overMileageFeeAmount: BigInt(overMileageFeeAmount),
    packageSnapshot,
    periodMonths,
    productId: product.id,
    productVersionId: productVersion.id,
    riskResultId: null,
    status: "DRAFT",
    subscriptionPlanId: subscriptionPlan.id,
    updatedBy: operatorId,
    vehicleBaseFeeAmount: BigInt(vehicleBaseFeeAmount),
    vehicleBaseFeeCapAmount: BigInt(vehicleBaseFeeCapAmount),
    vehicleId: vehicle.id,
    vehicleModel: "ET5",
    vehiclePackageId: vehiclePackage.id,
    vehiclePurchasePriceAmount: BigInt(vehiclePurchasePriceAmount),
    vehicleSalePriceAmount: BigInt(vehicleSalePriceAmount),
    vehicleSnapshot
  };

  const quote = await prisma.subscriptionQuote.upsert({
    create: {
      ...quoteData,
      createdBy: operatorId,
      quoteNo: autoReviewSeed.quoteNo
    },
    update: {
      ...quoteData,
      cancelledAt: null,
      confirmedAt: null,
      confirmedBy: null,
      deletedAt: null
    },
    where: { quoteNo: autoReviewSeed.quoteNo }
  });

  const quoteSnapshot = {
    applicationId: application.id,
    customerId: customer.id,
    customerSelectedSnapshot,
    depositAmount: 0,
    depositDescription: CUSTOMER_SELF_SERVICE_DEPOSIT_NOTICE,
    depositRuleSnapshot,
    depositStatus: "PENDING_CONFIRM",
    finalDepositAmount: null,
    monthlyFeeAmount,
    packageSnapshot,
    periodMonths,
    productId: product.id,
    productVersionId: productVersion.id,
    quoteId: quote.id,
    quoteNo: quote.quoteNo,
    status: "DRAFT",
    subscriptionPlanId: subscriptionPlan.id,
    vehicleBaseFeeAmount,
    vehicleBaseFeeCapAmount,
    vehicleId: vehicle.id,
    vehicleModel: "ET5",
    vehicleSalePriceAmount,
    vehicleSnapshot
  };

  const orderData = {
    applicationId: application.id,
    businessType: "SUBSCRIPTION",
    creditReviewStatus: "PENDING",
    customerId: customer.id,
    customerConfirmedAt: null,
    customerSelectedSnapshot,
    depositAmount: 0n,
    depositStatus: "PENDING_CONFIRM",
    energyLimitCount,
    energyLimitKwh,
    finalDepositAmount: null,
    finalPlanConfirmedAt: null,
    finalPlanSnapshot: null,
    mileageLimitKm,
    monthlyFeeAmount: BigInt(monthlyFeeAmount),
    orderSource: "CUSTOMER_SELF_SERVICE",
    orderStatus: "PENDING_REVIEW",
    overMileageFeeAmount: BigInt(overMileageFeeAmount),
    periodMonths,
    productId: product.id,
    productReviewStatus: "PENDING",
    productVersionId: productVersion.id,
    quoteId: quote.id,
    quoteSnapshot,
    reviewComment: null,
    riskResultId: null,
    updatedBy: operatorId,
    vehicleId: vehicle.id,
    vehicleModel: "ET5",
    vehiclePurchasePriceAmount: BigInt(vehiclePurchasePriceAmount),
    vehicleReviewStatus: "PENDING"
  };

  await prisma.subscriptionOrder.upsert({
    create: {
      ...orderData,
      createdBy: operatorId,
      orderNo: autoReviewSeed.orderNo
    },
    update: {
      ...orderData,
      actualDeliveryAt: null,
      deletedAt: null,
      endDate: null,
      startDate: null
    },
    where: { orderNo: autoReviewSeed.orderNo }
  });

  await prisma.vehicle.update({
    data: {
      status: "REVIEW_RESERVED",
      updatedBy: operatorId
    },
    where: { id: vehicle.id }
  });
}

async function seedSelfServiceApplicationReviewScenario(operatorId) {
  const now = new Date("2026-06-05T01:00:00.000Z");
  const effectiveFrom = new Date("2026-06-01T00:00:00.000Z");
  const reviewedAt = new Date("2026-06-02T00:00:00.000Z");
  const nextSalePriceReviewAt = new Date("2026-09-01T00:00:00.000Z");
  const softReservationExpiresAt = new Date("2026-06-12T01:00:00.000Z");
  const periodMonths = 12;
  const vehicleSalePriceAmount = 14800000;
  const vehiclePurchasePriceAmount = 15000000;

  const subscriptionPlan = await prisma.subscriptionPlan.findUniqueOrThrow({
    include: {
      benefitPackage: true,
      energyPackage: true,
      mileagePackage: true,
      product: true,
      productVersion: true,
      vehiclePackage: true
    },
    where: { planNo: autoReviewSeed.planNo }
  });

  const vehicleBaseFeeAmount = Number(subscriptionPlan.baseMonthlyFeeAmount ?? 520000n);
  const vehicleBaseFeeCapAmount = Math.floor(
    vehicleSalePriceAmount * Number(subscriptionPlan.vehiclePackage.monthlyFeeRate)
  );
  const mileagePackagePriceAmount = Number(subscriptionPlan.mileagePackage.priceAmount);
  const energyPackagePriceAmount = Number(subscriptionPlan.energyPackage.priceAmount);
  const benefitPackagePriceAmount = Number(subscriptionPlan.benefitPackage?.priceAmount ?? 0n);
  const monthlyFeeAmount =
    vehicleBaseFeeAmount +
    mileagePackagePriceAmount +
    energyPackagePriceAmount +
    benefitPackagePriceAmount;

  const vehicle = await prisma.vehicle.upsert({
    create: {
      assetLocation: "上海验收车库",
      batteryCapacityKwh: 75,
      batteryUsageType: "BUYOUT",
      brand: "NIO",
      createdBy: operatorId,
      currentMileageKm: 900,
      currentSalePriceAmount: BigInt(vehicleSalePriceAmount),
      currentSalePriceInitializedAt: reviewedAt,
      currentSalePriceReviewedAt: reviewedAt,
      model: "ET5 75kWh",
      modelYear: 2026,
      nextSalePriceReviewAt,
      plateNo: selfServiceApplicationReviewSeed.plateNo,
      purchaseDate: new Date("2026-05-26T00:00:00.000Z"),
      purchasePriceAmount: BigInt(vehiclePurchasePriceAmount),
      remark: "A线自助进件人工验收测试车辆",
      salePriceStatus: "EFFECTIVE",
      series: "ET5",
      status: "REVIEW_RESERVED",
      updatedBy: operatorId,
      vehicleModel: "ET5",
      vehicleNo: selfServiceApplicationReviewSeed.vehicleNo,
      vin: selfServiceApplicationReviewSeed.vin
    },
    update: {
      assetLocation: "上海验收车库",
      batteryCapacityKwh: 75,
      batteryUsageType: "BUYOUT",
      brand: "NIO",
      currentMileageKm: 900,
      currentSalePriceAmount: BigInt(vehicleSalePriceAmount),
      currentSalePriceInitializedAt: reviewedAt,
      currentSalePriceReviewedAt: reviewedAt,
      deletedAt: null,
      model: "ET5 75kWh",
      modelYear: 2026,
      nextSalePriceReviewAt,
      plateNo: selfServiceApplicationReviewSeed.plateNo,
      purchaseDate: new Date("2026-05-26T00:00:00.000Z"),
      purchasePriceAmount: BigInt(vehiclePurchasePriceAmount),
      remark: "A线自助进件人工验收测试车辆",
      salePriceReinitRequiredAt: null,
      salePriceStatus: "EFFECTIVE",
      series: "ET5",
      status: "REVIEW_RESERVED",
      updatedBy: operatorId,
      vehicleModel: "ET5",
      vehicleNo: selfServiceApplicationReviewSeed.vehicleNo
    },
    where: { vin: selfServiceApplicationReviewSeed.vin }
  });

  await upsertInitialSalePriceHistory({
    effectiveFrom,
    operatorId,
    reason: "A线自助进件验收车辆初始化",
    remark: "seed self-service application review scenario",
    vehicleId: vehicle.id,
    vehicleSalePriceAmount
  });

  const customer = await prisma.customer.upsert({
    create: {
      createdBy: operatorId,
      customerNo: selfServiceApplicationReviewSeed.customerNo,
      mobile: selfServiceApplicationReviewSeed.customerMobile,
      name: selfServiceApplicationReviewSeed.customerName,
      ownerUserId: operatorId,
      remark: "A线自助进件人工验收客户",
      sourceChannel: "客户自助",
      status: "PENDING_APPLICATION",
      updatedBy: operatorId
    },
    update: {
      deletedAt: null,
      grade: null,
      mobile: selfServiceApplicationReviewSeed.customerMobile,
      name: selfServiceApplicationReviewSeed.customerName,
      ownerUserId: operatorId,
      remark: "A线自助进件人工验收客户",
      sourceChannel: "客户自助",
      status: "PENDING_APPLICATION",
      updatedBy: operatorId
    },
    where: { customerNo: selfServiceApplicationReviewSeed.customerNo }
  });

  const vehicleSnapshot = {
    assetLocation: vehicle.assetLocation,
    batteryCapacityKwh: Number(vehicle.batteryCapacityKwh),
    batteryUsageType: vehicle.batteryUsageType,
    batteryUsageTypeLabel: "电池买断",
    brand: vehicle.brand,
    currentMileageKm: vehicle.currentMileageKm,
    currentSalePriceAmount: vehicleSalePriceAmount,
    plateNo: vehicle.plateNo,
    series: vehicle.series,
    status: "REVIEW_RESERVED",
    vehicleModel: "ET5",
    vehicleNo: vehicle.vehicleNo,
    vin: vehicle.vin
  };
  const packageSnapshot = {
    benefitPackage: subscriptionPlan.benefitPackage
      ? toSeedPackageSnapshot(subscriptionPlan.benefitPackage, {
          priceAmount: benefitPackagePriceAmount
        })
      : null,
    energyPackage: toSeedPackageSnapshot(subscriptionPlan.energyPackage, {
      monthlyEnergyCount: subscriptionPlan.energyPackage.monthlyEnergyCount,
      monthlyEnergyKwh: subscriptionPlan.energyPackage.monthlyEnergyKwh,
      priceAmount: energyPackagePriceAmount
    }),
    mileagePackage: toSeedPackageSnapshot(subscriptionPlan.mileagePackage, {
      monthlyMileageKm: subscriptionPlan.mileagePackage.monthlyMileageKm,
      overMileageFeeAmount: Number(subscriptionPlan.mileagePackage.overMileageFeeAmount),
      priceAmount: mileagePackagePriceAmount
    }),
    pricing: {
      benefitPackagePriceAmount,
      currentSalePriceAmount: vehicleSalePriceAmount,
      energyPackagePriceAmount,
      fixedRate: null,
      mileagePackagePriceAmount,
      monthlyFeeAmount,
      vehicleBaseFeeAmount,
      vehicleBaseFeeCapAmount,
      vehicleBaseFeeMode: subscriptionPlan.monthlyFeeMode,
      vehicleBaseFeeModeLabel: "固定金额"
    },
    subscriptionPlan: {
      baseMonthlyFeeAmount: vehicleBaseFeeAmount,
      benefitPackageId: subscriptionPlan.benefitPackageId,
      effectiveFrom: subscriptionPlan.effectiveFrom.toISOString().slice(0, 10),
      effectiveTo: subscriptionPlan.effectiveTo?.toISOString().slice(0, 10) ?? null,
      energyPackageId: subscriptionPlan.energyPackageId,
      id: subscriptionPlan.id,
      maxPeriodMonths: subscriptionPlan.maxPeriodMonths,
      mileagePackageId: subscriptionPlan.mileagePackageId,
      minPeriodMonths: subscriptionPlan.minPeriodMonths,
      monthlyFeeCapRate: Number(subscriptionPlan.monthlyFeeCapRate),
      monthlyFeeMode: subscriptionPlan.monthlyFeeMode,
      monthlyFeeModeLabel: "固定金额",
      monthlyFeeRate: Number(subscriptionPlan.monthlyFeeRate),
      planName: subscriptionPlan.planName,
      planNo: subscriptionPlan.planNo,
      productId: subscriptionPlan.productId,
      productVersionId: subscriptionPlan.productVersionId,
      status: subscriptionPlan.status,
      vehiclePackageId: subscriptionPlan.vehiclePackageId
    },
    vehicleBaseFeeAmount,
    vehicleBaseFeeCapAmount,
    vehicleBaseFeeMode: subscriptionPlan.monthlyFeeMode,
    vehicleBaseFeeModeLabel: "固定金额",
    vehiclePackage: toSeedPackageSnapshot(subscriptionPlan.vehiclePackage, {
      configName: subscriptionPlan.vehiclePackage.configName,
      maxPurchasePriceAmount: Number(subscriptionPlan.vehiclePackage.maxPurchasePriceAmount),
      minPurchasePriceAmount: Number(subscriptionPlan.vehiclePackage.minPurchasePriceAmount),
      monthlyFeeRate: Number(subscriptionPlan.vehiclePackage.monthlyFeeRate),
      vehicleModel: "ET5"
    })
  };
  const intentSnapshot = {
    customerId: customer.id,
    customerName: customer.name,
    depositDescription: CUSTOMER_SELF_SERVICE_DEPOSIT_NOTICE,
    depositStatus: "PENDING_CONFIRM",
    monthlyFeeAmount,
    packageSnapshot,
    periodMonths,
    selectedAt: now.toISOString(),
    subscriptionPlanId: subscriptionPlan.id,
    vehicleBaseFeeAmount,
    vehicleId: vehicle.id,
    vehicleSnapshot
  };
  const customerSelectedSnapshot = intentSnapshot;

  const applicationData = {
    applicationSource: "SELF_SERVICE",
    approvedAt: null,
    creditReviewComment: null,
    creditReviewStatus: "PENDING",
    customerGrade: null,
    customerId: customer.id,
    customerSelectedSnapshot,
    depositRuleId: null,
    depositRuleSnapshot: {
      depositDescription: CUSTOMER_SELF_SERVICE_DEPOSIT_NOTICE,
      status: "PENDING_CONFIRM"
    },
    depositStatus: "PENDING_CONFIRM",
    finalDepositAmount: null,
    finalPeriodMonths: null,
    finalPlanConfirmedAt: null,
    finalPlanSnapshot: null,
    finalQuoteSnapshot: null,
    finalSubscriptionPlanId: null,
    finalVehicleBaseFeeAmount: null,
    finalVehicleId: null,
    intendedModel: "ET5",
    intendedPeriodMonths: periodMonths,
    intentPeriodMonths: periodMonths,
    intentSnapshot,
    intentSubscriptionPlanId: subscriptionPlan.id,
    intentVehicleBaseFeeAmount: BigInt(vehicleBaseFeeAmount),
    intentVehicleId: vehicle.id,
    materialReviewStatus: "PENDING",
    planConfirmStatus: "PENDING",
    productReviewStatus: "PENDING",
    rejectedReason: null,
    salesUserId: operatorId,
    softReservationExpiresAt,
    softReservedAt: now,
    softReservedVehicleId: vehicle.id,
    status: "SUBMITTED",
    submittedAt: now,
    updatedBy: operatorId,
    vehicleReviewStatus: "PENDING"
  };

  const application = await prisma.application.upsert({
    create: {
      ...applicationData,
      applicationNo: selfServiceApplicationReviewSeed.applicationNo,
      createdBy: operatorId
    },
    update: {
      ...applicationData,
      deletedAt: null
    },
    where: { applicationNo: selfServiceApplicationReviewSeed.applicationNo }
  });

  const existingActionLog = await prisma.applicationActionLog.findFirst({
    where: {
      actionType: "CREATE",
      applicationId: application.id,
      comment: "seed self-service application review scenario"
    }
  });

  if (!existingActionLog) {
    await prisma.applicationActionLog.create({
      data: {
        actionType: "CREATE",
        applicationId: application.id,
        comment: "seed self-service application review scenario",
        createdBy: operatorId,
        operatorId,
        operatorName: "系统管理员",
        toStatus: "SUBMITTED",
        updatedBy: operatorId
      }
    });
  }
}

async function seedDeliveryHandoverAcceptanceOrders(operatorId) {
  const now = new Date("2026-06-06T02:00:00.000Z");
  const effectiveFrom = new Date("2026-06-01T00:00:00.000Z");
  const reviewedAt = new Date("2026-06-02T00:00:00.000Z");
  const nextSalePriceReviewAt = new Date("2026-09-01T00:00:00.000Z");
  const insuranceStartDate = new Date("2026-01-01T00:00:00.000Z");
  const insuranceEndDate = new Date("2027-12-31T00:00:00.000Z");
  const scheduledAt = new Date("2026-06-10T02:00:00.000Z");
  const signedAt = new Date("2026-06-06T02:30:00.000Z");
  const periodMonths = 12;
  const vehicleSalePriceAmount = 14800000;
  const vehiclePurchasePriceAmount = 15000000;
  const depositAmount = 500000;

  const subscriptionPlan = await prisma.subscriptionPlan.findUniqueOrThrow({
    include: {
      benefitPackage: true,
      energyPackage: true,
      mileagePackage: true,
      product: true,
      productVersion: true,
      vehiclePackage: true
    },
    where: { planNo: autoReviewSeed.planNo }
  });

  const contractVersion = await prisma.contractVersion.upsert({
    create: {
      approvedAt: now,
      approvedBy: operatorId,
      businessType: "SUBSCRIPTION",
      contentTemplate: "Stage 6.1 delivery handover acceptance contract template",
      createdBy: operatorId,
      effectiveFrom,
      status: "ACTIVE",
      templateName: "Stage 6.1 Delivery Acceptance Contract",
      templateType: "SUBSCRIPTION_STANDARD",
      updatedBy: operatorId,
      versionNo: "V1"
    },
    update: {
      approvedAt: now,
      approvedBy: operatorId,
      businessType: "SUBSCRIPTION",
      contentTemplate: "Stage 6.1 delivery handover acceptance contract template",
      deletedAt: null,
      effectiveFrom,
      effectiveTo: null,
      status: "ACTIVE",
      templateType: "SUBSCRIPTION_STANDARD",
      updatedBy: operatorId
    },
    where: {
      templateName_versionNo: {
        templateName: "Stage 6.1 Delivery Acceptance Contract",
        versionNo: "V1"
      }
    }
  });

  const vehicleBaseFeeAmount = Number(subscriptionPlan.baseMonthlyFeeAmount ?? 520000n);
  const vehicleBaseFeeCapAmount = Math.floor(
    vehicleSalePriceAmount * Number(subscriptionPlan.vehiclePackage.monthlyFeeRate)
  );
  const mileagePackagePriceAmount = Number(subscriptionPlan.mileagePackage.priceAmount);
  const energyPackagePriceAmount = Number(subscriptionPlan.energyPackage.priceAmount);
  const benefitPackagePriceAmount = Number(subscriptionPlan.benefitPackage?.priceAmount ?? 0n);
  const monthlyFeeAmount =
    vehicleBaseFeeAmount +
    mileagePackagePriceAmount +
    energyPackagePriceAmount +
    benefitPackagePriceAmount;
  const mileageLimitKm = subscriptionPlan.mileagePackage.monthlyMileageKm;
  const overMileageFeeAmount = Number(subscriptionPlan.mileagePackage.overMileageFeeAmount);
  const energyLimitKwh = subscriptionPlan.energyPackage.monthlyEnergyKwh;
  const energyLimitCount = subscriptionPlan.energyPackage.monthlyEnergyCount;

  for (const seed of deliveryHandoverAcceptanceSeeds) {
    const vehicle = await prisma.vehicle.upsert({
      create: {
        assetLocation: "Stage 6.1 delivery acceptance pool",
        batteryCapacityKwh: 75,
        batteryUsageType: "BUYOUT",
        brand: "NIO",
        createdBy: operatorId,
        currentMileageKm: seed.deliveryScenario === "CONFIRM" ? 2800 : 1800,
        currentSalePriceAmount: BigInt(vehicleSalePriceAmount),
        currentSalePriceInitializedAt: reviewedAt,
        currentSalePriceReviewedAt: reviewedAt,
        insuranceEndDate,
        insuranceStartDate,
        model: "ET5 75kWh",
        modelYear: 2026,
        nextSalePriceReviewAt,
        plateNo: seed.plateNo,
        purchaseDate: new Date("2026-05-28T00:00:00.000Z"),
        purchasePriceAmount: BigInt(vehiclePurchasePriceAmount),
        remark: "Stage 6.1 delivery handover acceptance vehicle",
        salePriceStatus: "EFFECTIVE",
        series: "ET5",
        status: "RESERVED",
        updatedBy: operatorId,
        vehicleModel: "ET5",
        vehicleNo: seed.vehicleNo,
        vin: seed.vin
      },
      update: {
        assetLocation: "Stage 6.1 delivery acceptance pool",
        batteryCapacityKwh: 75,
        batteryUsageType: "BUYOUT",
        brand: "NIO",
        currentMileageKm: seed.deliveryScenario === "CONFIRM" ? 2800 : 1800,
        currentSalePriceAmount: BigInt(vehicleSalePriceAmount),
        currentSalePriceInitializedAt: reviewedAt,
        currentSalePriceReviewedAt: reviewedAt,
        deletedAt: null,
        insuranceEndDate,
        insuranceStartDate,
        model: "ET5 75kWh",
        modelYear: 2026,
        nextSalePriceReviewAt,
        plateNo: seed.plateNo,
        purchaseDate: new Date("2026-05-28T00:00:00.000Z"),
        purchasePriceAmount: BigInt(vehiclePurchasePriceAmount),
        remark: "Stage 6.1 delivery handover acceptance vehicle",
        salePriceReinitRequiredAt: null,
        salePriceStatus: "EFFECTIVE",
        series: "ET5",
        status: "RESERVED",
        updatedBy: operatorId,
        vehicleModel: "ET5",
        vehicleNo: seed.vehicleNo
      },
      where: { vin: seed.vin }
    });

    await upsertInitialSalePriceHistory({
      effectiveFrom,
      operatorId,
      reason: "Stage 6.1 delivery acceptance vehicle sale price initialization",
      remark: seed.orderNo,
      vehicleId: vehicle.id,
      vehicleSalePriceAmount
    });

    const customer = await prisma.customer.upsert({
      create: {
        createdBy: operatorId,
        customerNo: seed.customerNo,
        grade: "A",
        mobile: seed.customerMobile,
        name: seed.customerName,
        ownerUserId: operatorId,
        remark: "Stage 6.1 delivery handover acceptance customer",
        sourceChannel: "Stage 6.1 acceptance seed",
        status: "APPROVED",
        updatedBy: operatorId
      },
      update: {
        deletedAt: null,
        grade: "A",
        mobile: seed.customerMobile,
        name: seed.customerName,
        ownerUserId: operatorId,
        remark: "Stage 6.1 delivery handover acceptance customer",
        sourceChannel: "Stage 6.1 acceptance seed",
        status: "APPROVED",
        updatedBy: operatorId
      },
      where: { customerNo: seed.customerNo }
    });

    const vehicleSnapshot = {
      assetLocation: vehicle.assetLocation,
      batteryCapacityKwh: Number(vehicle.batteryCapacityKwh),
      batteryUsageType: vehicle.batteryUsageType,
      batteryUsageTypeLabel: "买断电池",
      brand: vehicle.brand,
      currentMileageKm: vehicle.currentMileageKm,
      currentSalePriceAmount: vehicleSalePriceAmount,
      insuranceEndDate: insuranceEndDate.toISOString().slice(0, 10),
      insuranceStartDate: insuranceStartDate.toISOString().slice(0, 10),
      model: vehicle.model,
      plateNo: vehicle.plateNo,
      purchasePriceAmount: vehiclePurchasePriceAmount,
      salePriceStatus: "EFFECTIVE",
      series: vehicle.series,
      status: "RESERVED",
      vehicleModel: "ET5",
      vehicleNo: vehicle.vehicleNo,
      vin: vehicle.vin
    };
    const packageSnapshot = {
      benefitPackage: subscriptionPlan.benefitPackage
        ? toSeedPackageSnapshot(subscriptionPlan.benefitPackage, {
            benefitCount: subscriptionPlan.benefitPackage.benefitCount,
            benefitType: subscriptionPlan.benefitPackage.benefitType,
            description: subscriptionPlan.benefitPackage.description,
            priceAmount: benefitPackagePriceAmount
          })
        : null,
      energyPackage: toSeedPackageSnapshot(subscriptionPlan.energyPackage, {
        monthlyEnergyCount: energyLimitCount,
        monthlyEnergyKwh: energyLimitKwh,
        priceAmount: energyPackagePriceAmount
      }),
      mileagePackage: toSeedPackageSnapshot(subscriptionPlan.mileagePackage, {
        monthlyMileageKm: mileageLimitKm,
        overMileageFeeAmount,
        priceAmount: mileagePackagePriceAmount
      }),
      pricing: {
        benefitPackagePriceAmount,
        currentSalePriceAmount: vehicleSalePriceAmount,
        defaultRate: 0.018,
        depositAmount,
        energyPackagePriceAmount,
        mileagePackagePriceAmount,
        monthlyFeeAmount,
        vehicleBaseFeeAmount,
        vehicleBaseFeeCapAmount,
        vehicleBaseFeeMode: subscriptionPlan.monthlyFeeMode,
        vehicleBaseFeeModeLabel: "固定金额"
      },
      subscriptionPlan: {
        baseMonthlyFeeAmount: vehicleBaseFeeAmount,
        benefitPackageId: subscriptionPlan.benefitPackageId,
        effectiveFrom: subscriptionPlan.effectiveFrom.toISOString().slice(0, 10),
        effectiveTo: subscriptionPlan.effectiveTo?.toISOString().slice(0, 10) ?? null,
        energyPackageId: subscriptionPlan.energyPackageId,
        id: subscriptionPlan.id,
        maxPeriodMonths: subscriptionPlan.maxPeriodMonths,
        mileagePackageId: subscriptionPlan.mileagePackageId,
        minPeriodMonths: subscriptionPlan.minPeriodMonths,
        monthlyFeeCapRate: Number(subscriptionPlan.monthlyFeeCapRate),
        monthlyFeeMode: subscriptionPlan.monthlyFeeMode,
        monthlyFeeModeLabel: "固定金额",
        monthlyFeeRate: Number(subscriptionPlan.monthlyFeeRate),
        planName: subscriptionPlan.planName,
        planNo: subscriptionPlan.planNo,
        productId: subscriptionPlan.productId,
        productVersionId: subscriptionPlan.productVersionId,
        status: subscriptionPlan.status,
        vehiclePackageId: subscriptionPlan.vehiclePackageId
      },
      vehicleBaseFeeAmount,
      vehicleBaseFeeCapAmount,
      vehicleBaseFeeMode: subscriptionPlan.monthlyFeeMode,
      vehicleBaseFeeModeLabel: "固定金额",
      vehiclePackage: toSeedPackageSnapshot(subscriptionPlan.vehiclePackage, {
        configName: subscriptionPlan.vehiclePackage.configName,
        maxPurchasePriceAmount: Number(subscriptionPlan.vehiclePackage.maxPurchasePriceAmount),
        minPurchasePriceAmount: Number(subscriptionPlan.vehiclePackage.minPurchasePriceAmount),
        monthlyFeeRate: Number(subscriptionPlan.vehiclePackage.monthlyFeeRate),
        vehicleModel: "ET5"
      })
    };
    const depositRuleSnapshot = {
      defaultRate: 0.018,
      depositAmount,
      grade: "A",
      status: "CONFIRMED"
    };
    const customerSelectedSnapshot = {
      customerId: customer.id,
      customerName: customer.name,
      depositAmount,
      depositRuleSnapshot,
      monthlyFeeAmount,
      packageSnapshot,
      periodMonths,
      selectedAt: now.toISOString(),
      subscriptionPlanId: subscriptionPlan.id,
      vehicleBaseFeeAmount,
      vehicleId: vehicle.id,
      vehicleSnapshot
    };

    const applicationData = {
      applicationSource: "SALES_ASSISTED",
      approvedAt: now,
      creditReviewComment: "Stage 6.1 delivery acceptance seed approved",
      creditReviewStatus: "APPROVED",
      customerGrade: "A",
      customerId: customer.id,
      customerSelectedSnapshot,
      depositRuleSnapshot,
      depositStatus: "CONFIRMED",
      finalDepositAmount: BigInt(depositAmount),
      finalPeriodMonths: periodMonths,
      finalPlanConfirmedAt: now,
      finalPlanSnapshot: customerSelectedSnapshot,
      finalSubscriptionPlanId: subscriptionPlan.id,
      finalVehicleBaseFeeAmount: BigInt(vehicleBaseFeeAmount),
      finalVehicleId: vehicle.id,
      intendedModel: "ET5",
      intendedPeriodMonths: periodMonths,
      intentPeriodMonths: periodMonths,
      intentSnapshot: customerSelectedSnapshot,
      intentSubscriptionPlanId: subscriptionPlan.id,
      intentVehicleBaseFeeAmount: BigInt(vehicleBaseFeeAmount),
      intentVehicleId: vehicle.id,
      materialReviewStatus: "APPROVED",
      planConfirmStatus: "CONFIRMED",
      productReviewStatus: "APPROVED",
      rejectedReason: null,
      salesUserId: operatorId,
      softReservationExpiresAt: null,
      softReservedAt: now,
      softReservedVehicleId: vehicle.id,
      status: "APPROVED",
      submittedAt: now,
      updatedBy: operatorId,
      vehicleReviewStatus: "APPROVED"
    };

    const application = await prisma.application.upsert({
      create: {
        ...applicationData,
        applicationNo: seed.applicationNo,
        createdBy: operatorId
      },
      update: {
        ...applicationData,
        deletedAt: null
      },
      where: { applicationNo: seed.applicationNo }
    });

    const quoteData = {
      applicationId: application.id,
      benefitPackageId: subscriptionPlan.benefitPackageId,
      benefitPackagePriceAmount: BigInt(benefitPackagePriceAmount),
      confirmedAt: now,
      confirmedBy: operatorId,
      customerId: customer.id,
      customerSelectedSnapshot,
      depositAmount: BigInt(depositAmount),
      depositRuleSnapshot,
      energyLimitCount,
      energyLimitKwh,
      energyPackageId: subscriptionPlan.energyPackageId,
      energyPackagePriceAmount: BigInt(energyPackagePriceAmount),
      mileageLimitKm,
      mileagePackageId: subscriptionPlan.mileagePackageId,
      mileagePackagePriceAmount: BigInt(mileagePackagePriceAmount),
      monthlyFeeAmount: BigInt(monthlyFeeAmount),
      monthlyFeeCapAmount: BigInt(vehicleBaseFeeCapAmount),
      monthlyFeeRate: subscriptionPlan.monthlyFeeRate,
      overMileageFeeAmount: BigInt(overMileageFeeAmount),
      packageSnapshot,
      periodMonths,
      productId: subscriptionPlan.productId,
      productVersionId: subscriptionPlan.productVersionId,
      riskResultId: null,
      status: "CONFIRMED",
      subscriptionPlanId: subscriptionPlan.id,
      updatedBy: operatorId,
      vehicleBaseFeeAmount: BigInt(vehicleBaseFeeAmount),
      vehicleBaseFeeCapAmount: BigInt(vehicleBaseFeeCapAmount),
      vehicleId: vehicle.id,
      vehicleModel: "ET5",
      vehiclePackageId: subscriptionPlan.vehiclePackageId,
      vehiclePurchasePriceAmount: BigInt(vehiclePurchasePriceAmount),
      vehicleSalePriceAmount: BigInt(vehicleSalePriceAmount),
      vehicleSnapshot
    };

    const quote = await prisma.subscriptionQuote.upsert({
      create: {
        ...quoteData,
        createdBy: operatorId,
        quoteNo: seed.quoteNo
      },
      update: {
        ...quoteData,
        cancelledAt: null,
        deletedAt: null,
        expiredAt: null
      },
      where: { quoteNo: seed.quoteNo }
    });

    const quoteSnapshot = {
      applicationId: application.id,
      customerId: customer.id,
      customerSelectedSnapshot,
      depositAmount,
      depositRuleSnapshot,
      depositStatus: "CONFIRMED",
      finalDepositAmount: depositAmount,
      monthlyFeeAmount,
      packageSnapshot,
      periodMonths,
      pricing: packageSnapshot.pricing,
      productId: subscriptionPlan.productId,
      productVersionId: subscriptionPlan.productVersionId,
      quoteId: quote.id,
      quoteNo: quote.quoteNo,
      status: "CONFIRMED",
      subscriptionPlanId: subscriptionPlan.id,
      vehicleBaseFeeAmount,
      vehicleBaseFeeCapAmount,
      vehicleId: vehicle.id,
      vehicleModel: "ET5",
      vehicleSalePriceAmount,
      vehicleSnapshot
    };

    const orderData = {
      actualDeliveryAt: null,
      applicationId: application.id,
      businessType: "SUBSCRIPTION",
      creditReviewStatus: "APPROVED",
      customerConfirmedAt: now,
      customerId: customer.id,
      customerSelectedSnapshot,
      depositAmount: BigInt(depositAmount),
      depositStatus: "CONFIRMED",
      energyLimitCount,
      energyLimitKwh,
      finalDepositAmount: BigInt(depositAmount),
      finalPlanConfirmedAt: now,
      finalPlanSnapshot: customerSelectedSnapshot,
      mileageLimitKm,
      monthlyFeeAmount: BigInt(monthlyFeeAmount),
      orderSource: "SALES_ASSISTED",
      orderStatus: seed.deliveryScenario === "CONFIRM" ? "PENDING_DELIVERY" : "PENDING_PAYMENT",
      overMileageFeeAmount: BigInt(overMileageFeeAmount),
      periodMonths,
      productId: subscriptionPlan.productId,
      productReviewStatus: "APPROVED",
      productVersionId: subscriptionPlan.productVersionId,
      quoteId: quote.id,
      quoteSnapshot,
      reviewComment: "Stage 6.1 delivery handover acceptance seed",
      riskResultId: null,
      updatedBy: operatorId,
      vehicleId: vehicle.id,
      vehicleModel: "ET5",
      vehiclePurchasePriceAmount: BigInt(vehiclePurchasePriceAmount),
      vehicleReviewStatus: "APPROVED"
    };

    const order = await prisma.subscriptionOrder.upsert({
      create: {
        ...orderData,
        createdBy: operatorId,
        orderNo: seed.orderNo
      },
      update: {
        ...orderData,
        deletedAt: null,
        endDate: null,
        startDate: null
      },
      where: { orderNo: seed.orderNo }
    });

    const contractSnapshot = {
      contractVersion: {
        templateName: contractVersion.templateName,
        versionNo: contractVersion.versionNo
      },
      customer: {
        customerNo: customer.customerNo,
        mobile: customer.mobile,
        name: customer.name
      },
      order: {
        monthlyFeeAmount,
        orderNo: order.orderNo,
        periodMonths,
        vehicleSnapshot
      },
      quoteSnapshot
    };
    const contract = await prisma.contract.upsert({
      create: {
        businessType: "SUBSCRIPTION",
        contractNo: seed.contractNo,
        contractSnapshot,
        contractTitle: "Stage 6.1 Delivery Acceptance Contract",
        contractVersionId: contractVersion.id,
        createdBy: operatorId,
        customerId: customer.id,
        orderId: order.id,
        signedAt,
        status: "SIGNED",
        updatedBy: operatorId
      },
      update: {
        businessType: "SUBSCRIPTION",
        contractSnapshot,
        contractTitle: "Stage 6.1 Delivery Acceptance Contract",
        contractVersionId: contractVersion.id,
        customerId: customer.id,
        deletedAt: null,
        orderId: order.id,
        signedAt,
        status: "SIGNED",
        updatedBy: operatorId
      },
      where: { contractNo: seed.contractNo }
    });

    await prisma.subscriptionOrder.update({
      data: {
        contractId: contract.id,
        orderStatus: orderData.orderStatus,
        updatedBy: operatorId
      },
      where: { id: order.id }
    });

    if (seed.deliveryScenario === "CONFIRM") {
      const readyChecklistSnapshot = {
        contractSignedConfirmed: true,
        customerIdentityConfirmed: true,
        depositReceivedConfirmed: true,
        firstMonthlyFeeReceivedConfirmed: true,
        handoverDocumentsConfirmed: true,
        insuranceValidConfirmed: true,
        vehiclePhotosConfirmed: true,
        vehiclePreparedConfirmed: true
      };

      await prisma.vehicleDelivery.upsert({
        create: {
          ...readyChecklistSnapshot,
          checklistSnapshot: readyChecklistSnapshot,
          createdBy: operatorId,
          customerId: customer.id,
          deliveredAt: null,
          deliveryLocation: "Stage 6.1 交付验收中心",
          deliveryNo: seed.deliveryNo,
          deliveryStatus: "READY",
          handoverMileageKm: null,
          orderId: order.id,
          remark: "可直接执行确认交付验收",
          scheduledAt,
          updatedBy: operatorId,
          vehicleId: vehicle.id
        },
        update: {
          ...readyChecklistSnapshot,
          checklistSnapshot: readyChecklistSnapshot,
          customerId: customer.id,
          deletedAt: null,
          deliveredAt: null,
          deliveryLocation: "Stage 6.1 交付验收中心",
          deliveryNo: seed.deliveryNo,
          deliveryStatus: "READY",
          handoverMileageKm: null,
          orderId: order.id,
          remark: "可直接执行确认交付验收",
          scheduledAt,
          updatedBy: operatorId,
          vehicleId: vehicle.id
        },
        where: { orderId: order.id }
      });
    }
  }
}

async function upsertInitialSalePriceHistory({
  effectiveFrom,
  operatorId,
  reason,
  remark,
  vehicleId,
  vehicleSalePriceAmount
}) {
  const existingHistory = await prisma.vehicleSalePriceHistory.findFirst({
    where: {
      effectiveFrom,
      reviewType: "INITIAL_POOL",
      vehicleId
    }
  });

  const historyData = {
    afterSalePriceAmount: BigInt(vehicleSalePriceAmount),
    beforeSalePriceAmount: null,
    createdBy: operatorId,
    effectiveFrom,
    reason,
    remark,
    reviewQuarter: "2026Q2",
    reviewType: "INITIAL_POOL"
  };

  if (existingHistory) {
    await prisma.vehicleSalePriceHistory.update({
      data: historyData,
      where: { id: existingHistory.id }
    });
    return;
  }

  await prisma.vehicleSalePriceHistory.create({
    data: {
      ...historyData,
      vehicleId
    }
  });
}

function toSeedPackageSnapshot(row, extra = {}) {
  return {
    id: row.id,
    packageName: row.packageName,
    packageNo: row.packageNo,
    productId: row.productId,
    productVersionId: row.productVersionId,
    status: row.status,
    ...extra
  };
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
