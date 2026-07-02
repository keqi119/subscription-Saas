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

const userRows = [
  ["admin", "系统管理员", "admin@example.com", "ADMIN"],
  ["sa", "销售顾问", "sa@example.com", "SA"],
  ["op", "运营管理", "op@example.com", "OP"],
  ["rc", "风控专员", "rc@example.com", "RC"],
  ["fi", "财务专员", "fi@example.com", "FI"],
  ["as", "资产运营", "as@example.com", "AS"],
  ["cs", "客服运营", "cs@example.com", "CS"],
  ["gm", "运营总监", "gm@example.com", "GM"]
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
  ["service_case:view", "查看服务工单", "service_case", "view"],
  ["service_case:manage", "处理服务工单", "service_case", "manage"],
  ["delivery:view", "查看车辆交付", "delivery", "view"],
  ["delivery:prepare", "准备车辆交付", "delivery", "prepare"],
  ["delivery:confirm", "确认车辆交付", "delivery", "confirm"],
  ["vehicle_return:view", "查看退车验收", "vehicle_return", "view"],
  ["vehicle_return:prepare", "准备退车验收", "vehicle_return", "prepare"],
  ["vehicle_return:confirm", "确认退车验收", "vehicle_return", "confirm"],
  ["vehicle_return:damage_record", "记录退车损伤", "vehicle_return", "damage_record"],
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
  ["notification:view", "查看通知中心", "notification", "view"],
  ["notification:manage", "管理通知中心", "notification", "manage"]
);

permissionRows.push(
  ["billing:view", "查看应收账单", "billing", "view"],
  ["billing:generate", "生成应收账单", "billing", "generate"],
  ["payment:view", "查看收款记录", "payment", "view"],
  ["payment:create", "登记收款", "payment", "create"],
  ["payment:write_off", "收款核销", "payment", "write_off"],
  ["deposit_ledger:view", "查看保证金台账", "deposit_ledger", "view"],
  ["deposit_ledger:deduct", "保证金扣减", "deposit_ledger", "deduct"],
  ["deposit_ledger:refund", "保证金退款", "deposit_ledger", "refund"]
);

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
  ["vehicle:manage", "管理车辆资产", "vehicle", "manage"],
  ["fleet_ops:read", "车队运营查看", "fleet_ops", "read"],
  ["vehicle_model:view", "查看车型代码", "vehicle_model", "view"],
  ["vehicle_model:manage", "管理车型代码", "vehicle_model", "manage"],
  ["vehicle_insurance:view", "查看车辆保单", "vehicle_insurance", "view"],
  ["vehicle_insurance:manage", "管理车辆保单", "vehicle_insurance", "manage"],
  ["vehicle_document:view", "查看车辆权证材料", "vehicle_document", "view"],
  ["vehicle_document:manage", "管理车辆权证材料", "vehicle_document", "manage"],
  ["vehicle_baas:view", "查看BaaS合同", "vehicle_baas", "view"],
  ["vehicle_baas:manage", "管理BaaS合同", "vehicle_baas", "manage"],
  ["insurance_claim:view", "查看保险理赔", "insurance_claim", "view"],
  ["insurance_claim:manage", "管理保险理赔", "insurance_claim", "manage"],
  ["vehicle_valuation_review:view", "查看车辆估值复核", "vehicle_valuation_review", "view"],
  ["vehicle_valuation_review:create", "发起车辆估值复核", "vehicle_valuation_review", "create"],
  ["vehicle_valuation_review:approve", "审核车辆估值复核", "vehicle_valuation_review", "approve"],
  ["capital_structure:view", "查看车辆资本结构", "capital_structure", "view"],
  ["capital_structure:manage", "管理车辆资本结构", "capital_structure", "manage"],
  ["financing:view", "查看融资工具", "financing", "view"],
  ["financing:manage", "管理融资工具", "financing", "manage"],
  ["vehicle_asset_pool:view", "查看车辆资产池", "vehicle_asset_pool", "view"],
  ["vehicle_asset_pool:manage", "管理车辆资产池", "vehicle_asset_pool", "manage"],
  ["revenue_right:view", "查看收益权归属", "revenue_right", "view"],
  ["revenue_right:manage", "管理收益权归属", "revenue_right", "manage"],
  ["revenue_share:view", "查看托管分润规则", "revenue_share", "view"],
  ["revenue_share:manage", "管理托管分润规则", "revenue_share", "manage"],
  ["residual_market:view", "查看市场残值样本", "residual_market", "view"],
  ["residual_market:manage", "管理市场残值样本", "residual_market", "manage"],
  ["residual_market:import", "导入市场残值样本", "residual_market", "import"]
);

permissionRows.push(
  ["residual_curve:view", "查看残值曲线", "residual_curve", "view"],
  ["residual_curve:generate", "生成残值曲线", "residual_curve", "generate"],
  ["residual_curve:manage", "管理残值曲线", "residual_curve", "manage"]
);

permissionRows.push(
  ["residual_forecast:view", "查看单车残值预测", "residual_forecast", "view"],
  ["residual_forecast:generate", "生成单车残值预测", "residual_forecast", "generate"],
  ["residual_forecast:manage", "管理单车残值预测", "residual_forecast", "manage"]
);

permissionRows.push(
  ["residual_model_run:view", "查看残值模型运行记录", "residual_model_run", "view"],
  ["residual_model_run:manage", "管理残值模型运行记录", "residual_model_run", "manage"]
);

permissionRows.push(
  ["collection:view", "查看催收案件", "collection", "view"],
  ["collection:refresh_overdue", "刷新逾期账单", "collection", "refresh_overdue"],
  ["collection:action_create", "新增催收动作", "collection", "action_create"],
  ["collection:close", "关闭催收案件", "collection", "close"]
);

permissionRows.push(
  ["entitlement:view", "查看订单权益", "entitlement", "view"],
  ["entitlement:generate", "生成订单权益", "entitlement", "generate"],
  ["entitlement:adjust", "调整订单权益", "entitlement", "adjust"],
  ["entitlement:consume", "消耗订单权益", "entitlement", "consume"]
);

permissionRows.push(
  ["report:view", "查看经营报表", "report", "view"],
  ["report:finance", "查看财务报表", "report", "finance"],
  ["report:asset", "查看资产报表", "report", "asset"]
);

permissionRows.push(
  ["vehicle_depreciation:view", "查看车辆折旧", "vehicle_depreciation", "view"],
  ["vehicle_depreciation:manage", "管理车辆折旧", "vehicle_depreciation", "manage"]
);

const menuRows = [
  ["dashboard", "首页驾驶舱", "/", "dashboard", 10, "dashboard:view", null],
  ["customers", "客户中心", "/customers", "customer", 20, "customer:view", null],
  ["applications", "进件管理", "/applications", "application", 30, "application:view", null],
  ["risk", "风控中心", "/risk", "safety", 40, "risk:view", null],
  ["risk.deposit_rules", "押金规则", "/risk/deposit-rules", "money", 10, "risk:view", "risk"],
  ["products", "产品中心", "/products", "product", 50, "product:view", null],
  ["vehicles", "车辆资产", "/vehicles", "car", 55, "vehicle:view", null],
  ["vehicles.assets", "车辆资产台账", "/vehicles", "car", 10, "vehicle:view", "vehicles"],
  ["vehicles.model_definitions", "车型代码", "/vehicle-model-definitions", "car", 15, "vehicle_model:view", "vehicles"],
  ["vehicles.asset_pools", "车辆资产池", "/vehicle-asset-pools", "car", 20, "vehicle_asset_pool:view", "vehicles"],
  ["vehicles.insurance_policies", "保单管理", "/vehicle-insurance-policies", "file", 25, "vehicle_insurance:view", "vehicles"],
  ["vehicles.baas_contracts", "BaaS合同", "/vehicle-baas-contracts", "file", 28, "vehicle_baas:view", "vehicles"],
  ["vehicles.residual_market", "市场残值样本", "/residual-market", "car", 30, "residual_market:view", "vehicles"],
  ["vehicles.valuation_reviews", "估值复核", "/vehicle-valuation-reviews", "audit", 40, "vehicle_valuation_review:view", "vehicles"],
  ["vehicles.fleet_ops", "车队运营", "/fleet-ops", "dashboard", 45, "fleet_ops:read", "vehicles"],
  ["quotes", "订阅报价", "/quotes", "quote", 60, "quote:view", null],
  ["orders", "订单中心", "/orders", "order", 70, "order:view", null],
  ["orders.subscription", "订阅订单", "/orders", "order", 10, "order:view", "orders"],
  ["orders.review", "旧版订单审核", "/orders/review", "audit", 15, "order:review", "orders"],
  ["orders.contracts", "合同管理", "/contracts", "contract", 20, "contract:view", "orders"],
  ["orders.contract_templates", "合同模板", "/contract-versions", "file", 30, "contract_template:view", "orders"],
  ["orders.service_cases", "服务工单", "/service-cases", "audit", 40, "service_case:view", "orders"],
  ["reports", "经营看板", "/reports", "dashboard", 75, null, null],
  ["reports.overview", "经营总览", "/reports", "dashboard", 10, "report:view", "reports"],
  ["reports.asset_profitability", "资产经营分析", "/reports/asset-profitability", "car", 20, "report:asset", "reports"],
  ["billing", "财务管理", "/billing", "money", 80, "billing:view", null],
  ["billing.monthly_rent", "月租账单生成", "/billing/monthly-rent", "money", 10, "billing:generate", "billing"],
  ["billing.collections", "逾期催收", "/billing/collections", "audit", 20, "collection:view", "billing"],
  ["billing.financing_instruments", "融资工具", "/financing-instruments", "money", 30, "financing:view", "billing"],
  ["billing.revenue_rights", "收益权管理", "/revenue-rights", "file", 40, "revenue_right:view", "billing"],
  ["system", "系统管理", "/system", "setting", 90, "user:view", null],
  ["system.users", "用户管理", "/system/users", "team", 10, "user:view", "system"],
  ["system.roles", "角色管理", "/system/roles", "safety", 20, "role:view", "system"],
  ["system.permissions", "权限管理", "/system/permissions", "key", 30, "permission:view", "system"],
  ["system.audit_logs", "操作日志", "/system/audit-logs", "audit", 40, "audit_log:view", "system"]
];

menuRows.push(
  ["orders.notifications", "通知中心", "/notifications", "message", 50, "notification:view", "orders"],
  ["products.subscription", "订阅产品", "/products?tab=products", "product", 10, "product:view", "products"],
  ["products.versions", "产品版本", "/products?tab=versions", "file", 20, "product_version:view", "products"],
  ["products.vehicle_packages", "车型包", "/products?tab=vehicle-packages", "car", 30, "vehicle_package:view", "products"],
  ["products.mileage_packages", "里程包", "/products?tab=mileage-packages", "dashboard", 40, "mileage_package:view", "products"],
  ["products.energy_packages", "补能包", "/products?tab=energy-packages", "money", 50, "energy_package:view", "products"],
  ["products.benefit_packages", "权益包", "/products?tab=benefit-packages", "safety", 60, "benefit_package:view", "products"],
  ["products.subscription_plans", "订阅套餐", "/products?tab=subscription-plans", "quote", 70, "subscription_plan:view", "products"]
);

menuRows.push(
  ["vehicles.depreciation_policies", "折旧管理", "/vehicle-depreciation-policies", "money", 29, "vehicle_depreciation:view", "vehicles"]
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

const vehicleModelDefinitionSeedRows = [
  ["ET5", "ET5", "NIO", "ET", "ET5", "ET5", "ET5", 10],
  ["ET5T", "ET5T", "NIO", "ET", "ET5T", "ET5T", "ET5T", 20],
  ["ET7", "ET7", "NIO", "ET", "ET7", "ET7", "ET7", 30],
  ["EC6", "EC6", "NIO", "EC", "EC6", "EC6", "EC6", 40],
  ["ES6", "ES6", "NIO", "ES", "ES6", "ES6", "ES6", 50],
  ["ES8", "ES8", "NIO", "ES", "ES8", "ES8", "ES8", 60],
  ["ET9", "ET9", "NIO", "ET", "ET9", "ET9", "ET9", 70],
  ["ES9", "ES9", "NIO", "ES", "ES9", "ES9", "ES9", 80]
];

const baselineSubscriptionSeed = {
  benefitPackageNo: "BPK-AUTO-ET5-WASH",
  benefitPackagePriceAmount: 30000,
  energyPackageNo: "EPK-AUTO-ET5-POWER",
  energyPackagePriceAmount: 120000,
  mileagePackageNo: "MPK-AUTO-ET5-1500",
  mileagePackagePriceAmount: 80000,
  planNo: "PLAN-AUTO-ET5-STANDARD",
  productNo: "PROD-AUTO-ET5",
  vehiclePackageNo: "VPK-AUTO-ET5-STANDARD",
  versionNo: "2026-AUTO-REVIEW"
};

const baselineCustomerLeads = [
  {
    customerNo: "CUS-SEED-LEAD-A-001",
    customerType: "PERSONAL",
    grade: "A",
    mobile: "13900000011",
    name: "李晨",
    remark: "默认 seed A 级个人 lead",
    sourceChannel: "默认 seed"
  },
  {
    customerNo: "CUS-SEED-LEAD-B-001",
    customerType: "PERSONAL",
    grade: "B",
    mobile: "13900000012",
    name: "周雨",
    remark: "默认 seed B 级个人 lead",
    sourceChannel: "默认 seed"
  },
  {
    customerNo: "CUS-SEED-LEAD-C-001",
    customerType: "PERSONAL",
    grade: "C",
    mobile: "13900000013",
    name: "王宁",
    remark: "默认 seed C 级个人 lead",
    sourceChannel: "默认 seed"
  },
  {
    customerNo: "CUS-SEED-LEAD-COMPANY-001",
    customerType: "COMPANY",
    grade: "A",
    mobile: "13900000014",
    name: "上海澄明科技有限公司",
    remark: "默认 seed 企业 lead",
    sourceChannel: "默认 seed"
  }
];

const oldDefaultFlowSeedData = {
  applicationNos: [
    "APP-AUTO-REVIEW-ET5-001",
    "APP-SELF-SERVICE-REVIEW-001",
    "APP-DELIVERY-PREPARE-001",
    "APP-DELIVERY-CONFIRM-001"
  ],
  contractNos: ["CON-DELIVERY-PREPARE-001", "CON-DELIVERY-CONFIRM-001"],
  contractVersions: [{ templateName: "Stage 6.1 Delivery Acceptance Contract", versionNo: "V1" }],
  customerNos: [
    "CUS-AUTO-REVIEW-001",
    "CUS-SELF-SERVICE-APP-001",
    "CUS-DELIVERY-PREPARE-001",
    "CUS-DELIVERY-CONFIRM-001"
  ],
  deliveryNos: ["DLV-DELIVERY-CONFIRM-001"],
  orderNos: [
    "ORD-AUTO-REVIEW-ET5-001",
    "ORD-DELIVERY-PREPARE-001",
    "ORD-DELIVERY-CONFIRM-001"
  ],
  quoteNos: [
    "QUO-AUTO-REVIEW-ET5-001",
    "QUO-DELIVERY-PREPARE-001",
    "QUO-DELIVERY-CONFIRM-001"
  ],
  vehicleVins: [
    "TESTAUTOORDERET5001",
    "TESTSELFAPPET5001",
    "TESTDELIVERYPREPARE001",
    "TESTDELIVERYCONFIRM001"
  ]
};

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
  "vehicle_return:view",
  "vehicle_return:prepare",
  "vehicle_return:confirm",
  "vehicle_return:damage_record",
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

const financeManagementPermissions = [
  "billing:view",
  "billing:generate",
  "payment:view",
  "payment:create",
  "payment:write_off",
  "deposit_ledger:view",
  "deposit_ledger:deduct",
  "deposit_ledger:refund"
];

const financeViewPermissions = ["billing:view", "payment:view", "deposit_ledger:view"];

const collectionManagementPermissions = [
  "collection:view",
  "collection:refresh_overdue",
  "collection:action_create",
  "collection:close"
];

const collectionActionPermissions = ["collection:view", "collection:action_create"];

const serviceCaseViewPermissions = ["service_case:view"];

const serviceCaseManagePermissions = ["service_case:view", "service_case:manage"];

const notificationViewPermissions = ["notification:view"];

const notificationManagePermissions = ["notification:view", "notification:manage"];

const entitlementViewPermissions = ["entitlement:view"];

const entitlementGeneratePermissions = ["entitlement:view", "entitlement:generate"];

const entitlementOperationPermissions = ["entitlement:view", "entitlement:generate", "entitlement:adjust", "entitlement:consume"];

const reportViewPermissions = ["report:view"];

const reportFinancePermissions = ["report:view", "report:finance"];

const reportAssetPermissions = ["report:asset"];

const reportAllPermissions = ["report:view", "report:finance", "report:asset"];

const reportOverviewMenuCodes = ["reports", "reports.overview"];

const reportAssetMenuCodes = ["reports", "reports.asset_profitability"];

const financeMenuCodes = ["billing", "billing.monthly_rent", "billing.collections"];

const collectionMenuCodes = ["billing", "billing.collections"];

const serviceCaseMenuCodes = ["orders", "orders.service_cases"];

const notificationMenuCodes = ["orders", "orders.notifications"];

const financingMenuCodes = ["billing.financing_instruments"];

const revenueRightMenuCodes = ["billing.revenue_rights"];

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
const vehicleInsuranceViewPermissions = ["vehicle_insurance:view"];
const vehicleInsuranceManagementPermissions = ["vehicle_insurance:view", "vehicle_insurance:manage"];
const vehicleDocumentViewPermissions = ["vehicle_document:view"];
const vehicleDocumentManagementPermissions = ["vehicle_document:view", "vehicle_document:manage"];
const vehicleBaasViewPermissions = ["vehicle_baas:view"];
const vehicleBaasManagementPermissions = ["vehicle_baas:view", "vehicle_baas:manage"];
const vehicleDepreciationViewPermissions = ["vehicle_depreciation:view"];
const vehicleDepreciationManagementPermissions = ["vehicle_depreciation:view", "vehicle_depreciation:manage"];
const vehicleModelViewPermissions = ["vehicle_model:view"];
const vehicleModelManagementPermissions = ["vehicle_model:view", "vehicle_model:manage"];
const insuranceClaimViewPermissions = ["insurance_claim:view"];
const insuranceClaimManagementPermissions = ["insurance_claim:view", "insurance_claim:manage"];
const vehicleValuationReviewViewPermissions = ["vehicle_valuation_review:view"];
const vehicleValuationReviewCreatePermissions = [
  "vehicle_valuation_review:view",
  "vehicle_valuation_review:create"
];
const vehicleValuationReviewApprovePermissions = [
  "vehicle_valuation_review:view",
  "vehicle_valuation_review:approve"
];
const vehicleValuationReviewManagementPermissions = [
  "vehicle_valuation_review:view",
  "vehicle_valuation_review:create",
  "vehicle_valuation_review:approve"
];
const fleetOpsReadPermissions = ["fleet_ops:read"];
const vehicleMenuCodes = ["vehicles", "vehicles.assets"];
const vehicleModelMenuCodes = ["vehicles.model_definitions"];
const vehicleAssetPoolMenuCodes = ["vehicles.asset_pools"];
const vehicleInsuranceMenuCodes = ["vehicles.insurance_policies"];
const vehicleBaasMenuCodes = ["vehicles.baas_contracts"];
const vehicleDepreciationMenuCodes = ["vehicles.depreciation_policies"];
const residualMarketMenuCodes = ["vehicles.residual_market"];
const vehicleValuationReviewMenuCodes = ["vehicles.valuation_reviews"];
const fleetOpsMenuCodes = ["vehicles.fleet_ops"];

const capitalStructureViewPermissions = ["capital_structure:view"];

const capitalStructureManagementPermissions = [
  "capital_structure:view",
  "capital_structure:manage"
];

const financingViewPermissions = ["financing:view"];

const financingManagementPermissions = ["financing:view", "financing:manage"];

const vehicleAssetPoolViewPermissions = ["vehicle_asset_pool:view"];

const vehicleAssetPoolManagementPermissions = ["vehicle_asset_pool:view", "vehicle_asset_pool:manage"];

const revenueRightViewPermissions = ["revenue_right:view"];

const revenueRightManagementPermissions = ["revenue_right:view", "revenue_right:manage"];

const revenueShareViewPermissions = ["revenue_share:view"];

const revenueShareManagementPermissions = ["revenue_share:view", "revenue_share:manage"];

const residualMarketViewPermissions = ["residual_market:view"];

const residualMarketImportPermissions = ["residual_market:view", "residual_market:import"];

const residualMarketManagementPermissions = [
  "residual_market:view",
  "residual_market:manage",
  "residual_market:import"
];

const residualCurveViewPermissions = ["residual_curve:view"];

const residualCurveGeneratePermissions = ["residual_curve:view", "residual_curve:generate"];

const residualCurveManagementPermissions = [
  "residual_curve:view",
  "residual_curve:generate",
  "residual_curve:manage"
];

const residualForecastViewPermissions = ["residual_forecast:view"];

const residualForecastGeneratePermissions = ["residual_forecast:view", "residual_forecast:generate"];

const residualForecastManagementPermissions = [
  "residual_forecast:view",
  "residual_forecast:generate",
  "residual_forecast:manage"
];

const residualModelRunViewPermissions = ["residual_model_run:view"];

const residualModelRunManagementPermissions = [
  "residual_model_run:view",
  "residual_model_run:manage"
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
      ...vehicleViewPermissions,
      ...vehicleInsuranceViewPermissions,
      ...vehicleDocumentViewPermissions,
      ...vehicleModelViewPermissions,
      ...vehicleBaasViewPermissions,
      ...vehicleDepreciationViewPermissions,
      ...insuranceClaimViewPermissions,
      ...quoteManagementPermissions,
      "order:view",
      "order:create",
      "order_change:view",
      "order_change:create",
      ...serviceCaseViewPermissions,
      ...notificationViewPermissions,
      ...entitlementViewPermissions,
      "billing:view",
      "delivery:view",
      "vehicle_return:view",
      "contract:view"
    ],
    [
      "dashboard",
      "customers",
      "applications",
      ...productMenuCodes,
      ...vehicleMenuCodes,
      ...vehicleModelMenuCodes,
      ...vehicleInsuranceMenuCodes,
      ...vehicleBaasMenuCodes,
      ...vehicleDepreciationMenuCodes,
      "quotes",
      "orders",
      "orders.subscription",
      "orders.contracts",
      ...serviceCaseMenuCodes,
      ...notificationMenuCodes
    ]
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
      ...vehicleInsuranceManagementPermissions,
      ...vehicleDocumentManagementPermissions,
      ...vehicleModelManagementPermissions,
      ...vehicleBaasManagementPermissions,
      ...vehicleDepreciationManagementPermissions,
      ...insuranceClaimManagementPermissions,
      ...vehicleValuationReviewManagementPermissions,
      ...fleetOpsReadPermissions,
      ...quoteManagementPermissions,
      ...orderManagementPermissions,
      ...entitlementOperationPermissions,
      ...reportViewPermissions,
      ...reportAssetPermissions,
      ...capitalStructureViewPermissions,
      ...financingViewPermissions,
      ...vehicleAssetPoolViewPermissions,
      ...revenueRightViewPermissions,
      ...revenueShareViewPermissions,
      ...residualMarketImportPermissions,
      ...residualCurveGeneratePermissions,
      ...residualForecastGeneratePermissions,
      ...residualModelRunViewPermissions,
      "billing:view",
      "deposit_ledger:view",
      "deposit_ledger:deduct",
      ...collectionActionPermissions,
      ...serviceCaseManagePermissions,
      ...notificationManagePermissions,
      "order_change:approve",
      "order_change:reject",
      "order_change:execute"
    ],
    [
      "dashboard",
      "customers",
      "applications",
      ...productMenuCodes,
      ...vehicleMenuCodes,
      ...vehicleModelMenuCodes,
      ...vehicleInsuranceMenuCodes,
      ...vehicleBaasMenuCodes,
      ...vehicleDepreciationMenuCodes,
      "quotes",
      "orders",
      "orders.subscription",
      "orders.review",
      "orders.contracts",
      "orders.contract_templates",
      ...serviceCaseMenuCodes,
      ...notificationMenuCodes,
      ...reportOverviewMenuCodes,
      ...reportAssetMenuCodes,
      ...financingMenuCodes,
      ...vehicleAssetPoolMenuCodes,
      ...residualMarketMenuCodes,
      ...vehicleValuationReviewMenuCodes,
      ...fleetOpsMenuCodes,
      ...revenueRightMenuCodes,
      ...collectionMenuCodes
    ]
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
        ...(roleCode === "FI" ? vehicleModelManagementPermissions : []),
        ...(roleCode === "FI" ? vehicleBaasManagementPermissions : vehicleBaasViewPermissions),
        ...(roleCode === "FI" ? vehicleDepreciationManagementPermissions : []),
        ...(roleCode === "AS"
          ? vehicleValuationReviewCreatePermissions
          : vehicleValuationReviewViewPermissions),
        ...(roleCode === "FI" ? capitalStructureManagementPermissions : capitalStructureViewPermissions),
        ...(roleCode === "FI" ? financingManagementPermissions : financingViewPermissions),
        ...(roleCode === "FI" || roleCode === "AS"
          ? vehicleAssetPoolManagementPermissions
          : vehicleAssetPoolViewPermissions),
        ...(roleCode === "FI" ? revenueRightManagementPermissions : revenueRightViewPermissions),
        ...(roleCode === "FI" ? revenueShareManagementPermissions : revenueShareViewPermissions),
        ...(roleCode === "AS" ? residualMarketManagementPermissions : residualMarketViewPermissions),
        ...(roleCode === "AS" ? residualCurveManagementPermissions : residualCurveViewPermissions),
        ...(roleCode === "AS" ? residualForecastManagementPermissions : residualForecastViewPermissions),
        ...(roleCode === "AS" ? residualModelRunManagementPermissions : residualModelRunViewPermissions),
        "quote:view",
        "order:view",
        ...(roleCode === "FI" ? financeManagementPermissions : []),
        ...(roleCode === "FI" ? collectionManagementPermissions : []),
        ...(roleCode === "FI" ? [...reportFinancePermissions, ...reportAssetPermissions] : reportAssetPermissions),
        ...(roleCode === "AS" ? ["delivery:view", "delivery:prepare", "delivery:confirm"] : []),
        "vehicle_return:view",
        ...(roleCode === "AS"
          ? ["vehicle_return:prepare", "vehicle_return:confirm", "vehicle_return:damage_record"]
          : []),
        ...(roleCode === "AS" ? ["order:review", "order:reject"] : []),
        "order_change:view",
        "contract:view"
      ],
      [
        "dashboard",
        ...productMenuCodes,
        ...vehicleMenuCodes,
        ...(roleCode === "FI" ? vehicleModelMenuCodes : []),
        ...vehicleBaasMenuCodes,
        ...(roleCode === "FI" ? vehicleDepreciationMenuCodes : []),
        "quotes",
        "orders",
        "orders.subscription",
        ...(roleCode === "AS" ? ["orders.review"] : []),
        "orders.contracts",
        ...(roleCode === "FI" ? [...reportOverviewMenuCodes, ...reportAssetMenuCodes, ...financeMenuCodes] : []),
        ...financingMenuCodes,
        ...vehicleAssetPoolMenuCodes,
        ...residualMarketMenuCodes,
        ...vehicleValuationReviewMenuCodes,
        ...revenueRightMenuCodes,
        ...(roleCode === "AS" ? reportAssetMenuCodes : [])
      ]
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
      ...vehicleInsuranceViewPermissions,
      ...vehicleDocumentViewPermissions,
      ...vehicleModelViewPermissions,
      ...vehicleBaasViewPermissions,
      ...vehicleDepreciationViewPermissions,
      ...insuranceClaimViewPermissions,
      ...vehicleValuationReviewApprovePermissions,
      ...fleetOpsReadPermissions,
      ...capitalStructureViewPermissions,
      ...financingViewPermissions,
      ...vehicleAssetPoolViewPermissions,
      ...revenueRightViewPermissions,
      ...revenueShareViewPermissions,
      ...residualMarketViewPermissions,
      ...residualCurveViewPermissions,
      ...residualForecastViewPermissions,
      ...residualModelRunViewPermissions,
      "quote:view",
      ...orderManagementPermissions,
      ...financeViewPermissions,
      ...entitlementViewPermissions,
      ...serviceCaseViewPermissions,
      ...notificationViewPermissions,
      "collection:view",
      ...reportAllPermissions
    ],
    [
      "dashboard",
      "customers",
      "applications",
      "risk",
      "risk.deposit_rules",
      ...productMenuCodes,
      ...vehicleMenuCodes,
      ...vehicleModelMenuCodes,
      ...vehicleInsuranceMenuCodes,
      ...vehicleBaasMenuCodes,
      ...vehicleDepreciationMenuCodes,
      "quotes",
      "orders",
      "orders.subscription",
      "orders.review",
      "orders.contracts",
      "orders.contract_templates",
      ...serviceCaseMenuCodes,
      ...notificationMenuCodes,
      ...reportOverviewMenuCodes,
      ...reportAssetMenuCodes,
      ...financingMenuCodes,
      ...vehicleAssetPoolMenuCodes,
      ...residualMarketMenuCodes,
      ...vehicleValuationReviewMenuCodes,
      ...fleetOpsMenuCodes,
      ...revenueRightMenuCodes,
      ...collectionMenuCodes
    ]
  );

  const adminUser = await seedDefaultUsers();

  await seedVehicleModelDefinitions(adminUser.id);
  await cleanupDefaultSeedFlowData();
  await seedDefaultDepositRules(adminUser.id);
  await seedBaselineSubscriptionCatalog(adminUser.id);
  await seedBaselineCustomerLeads(adminUser.id);
  await seedDemoVehicles(adminUser.id);
  await seedNotificationTemplates(adminUser.id);

  const existingSeedAudit = await prisma.auditLog.findFirst({
    where: {
      action: "CREATE",
      entityId: adminUser.id,
      entityType: "user",
      module: "system"
    }
  });

  if (!existingSeedAudit) {
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
}

async function seedNotificationTemplates(adminUserId) {
  const rows = [
    ["APPLICATION_SUBMITTED_IN_APP", "IN_APP", "APPLICATION_PROGRESS", "申请已提交", "您的订阅申请已提交，平台将尽快审核。"],
    ["APPLICATION_SUBMITTED_WECHAT", "WECHAT_OFFICIAL_ACCOUNT", "APPLICATION_PROGRESS", "申请已提交", "您的订阅申请已提交，点击查看进度。"],
    ["FINAL_PLAN_READY_IN_APP", "IN_APP", "FINAL_PLAN_PENDING", "最终方案待确认", "平台已生成最终方案，请及时确认。"],
    ["FINAL_PLAN_READY_WECHAT", "WECHAT_OFFICIAL_ACCOUNT", "FINAL_PLAN_PENDING", "最终方案待确认", "平台已生成最终方案，点击确认。"],
    ["CONTRACT_PENDING_IN_APP", "IN_APP", "CONTRACT_PENDING", "合同待签署", "您的合同已生成，请完成电子签署。"],
    ["CONTRACT_PENDING_WECHAT", "WECHAT_OFFICIAL_ACCOUNT", "CONTRACT_PENDING", "合同待签署", "您的合同已生成，点击签署。"],
    ["PAYMENT_PENDING_IN_APP", "IN_APP", "PAYMENT_PENDING", "订单待支付", "合同已签署，请完成账单支付。"],
    ["PAYMENT_PENDING_WECHAT", "WECHAT_OFFICIAL_ACCOUNT", "PAYMENT_PENDING", "订单待支付", "合同已签署，点击支付。"],
    ["SERVICE_CASE_UPDATE_IN_APP", "IN_APP", "SERVICE_CASE_UPDATE", "服务工单更新", "您的服务工单有新的处理进度。"],
    ["SERVICE_CASE_UPDATE_WECHAT", "WECHAT_OFFICIAL_ACCOUNT", "SERVICE_CASE_UPDATE", "服务工单更新", "您的服务工单有新的处理进度，点击查看。"]
  ];

  for (const [templateCode, channel, templateType, title, content] of rows) {
    await prisma.notificationTemplate.upsert({
      create: {
        channel,
        content,
        createdBy: adminUserId,
        templateCode,
        templateStatus: "ACTIVE",
        templateType,
        title,
        updatedBy: adminUserId,
        variables: {
          aggregateNo: "业务编号",
          status: "当前状态",
          time: "时间"
        }
      },
      update: {
        channel,
        content,
        templateStatus: "ACTIVE",
        templateType,
        title,
        updatedBy: adminUserId,
        variables: {
          aggregateNo: "业务编号",
          status: "当前状态",
          time: "时间"
        }
      },
      where: { templateCode }
    });
  }
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

async function seedDefaultUsers() {
  const passwordHash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD ?? "Admin@123456", 12);
  let adminUser = null;

  for (const [username, name, email, roleCode] of userRows) {
    const user = await prisma.user.upsert({
      create: {
        email,
        name,
        passwordHash,
        username
      },
      update: {
        deletedAt: null,
        email,
        name,
        status: "ACTIVE"
      },
      where: { username }
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });

    await prisma.userRole.upsert({
      create: {
        roleId: role.id,
        userId: user.id
      },
      update: {},
      where: {
        userId_roleId: {
          roleId: role.id,
          userId: user.id
        }
      }
    });

    if (username === "admin") {
      adminUser = user;
    }
  }

  if (!adminUser) {
    throw new Error("Admin seed user was not created.");
  }

  return adminUser;
}

async function cleanupDefaultSeedFlowData() {
  const oldFlowCustomers = await prisma.customer.findMany({
    select: { id: true },
    where: { customerNo: { in: oldDefaultFlowSeedData.customerNos } }
  });
  const oldFlowCustomerIds = oldFlowCustomers.map((customer) => customer.id);
  const oldFlowVehicles = await prisma.vehicle.findMany({
    select: { id: true },
    where: { vin: { in: oldDefaultFlowSeedData.vehicleVins } }
  });
  const oldFlowVehicleIds = oldFlowVehicles.map((vehicle) => vehicle.id);
  const baselineVehicles = await prisma.vehicle.findMany({
    select: { id: true },
    where: { vin: { in: demoVehicles.map((vehicle) => vehicle.vin) } }
  });
  const cleanupVehicleIds = [...oldFlowVehicleIds, ...baselineVehicles.map((vehicle) => vehicle.id)];

  const applications = await prisma.application.findMany({
    select: { id: true },
    where: {
      OR: [
        { applicationNo: { in: oldDefaultFlowSeedData.applicationNos } },
        ...(oldFlowCustomerIds.length > 0 ? [{ customerId: { in: oldFlowCustomerIds } }] : []),
        ...(cleanupVehicleIds.length > 0
          ? [
              { finalVehicleId: { in: cleanupVehicleIds } },
              { intentVehicleId: { in: cleanupVehicleIds } },
              { softReservedVehicleId: { in: cleanupVehicleIds } }
            ]
          : [])
      ]
    }
  });
  const applicationIds = applications.map((application) => application.id);

  const quotes = await prisma.subscriptionQuote.findMany({
    select: { id: true },
    where: {
      OR: [
        { quoteNo: { in: oldDefaultFlowSeedData.quoteNos } },
        ...(applicationIds.length > 0 ? [{ applicationId: { in: applicationIds } }] : []),
        ...(oldFlowCustomerIds.length > 0 ? [{ customerId: { in: oldFlowCustomerIds } }] : []),
        ...(cleanupVehicleIds.length > 0 ? [{ vehicleId: { in: cleanupVehicleIds } }] : [])
      ]
    }
  });
  const quoteIds = quotes.map((quote) => quote.id);

  const orders = await prisma.subscriptionOrder.findMany({
    select: { id: true, quoteId: true },
    where: {
      OR: [
        { orderNo: { in: oldDefaultFlowSeedData.orderNos } },
        ...(applicationIds.length > 0 ? [{ applicationId: { in: applicationIds } }] : []),
        ...(quoteIds.length > 0 ? [{ quoteId: { in: quoteIds } }] : []),
        ...(oldFlowCustomerIds.length > 0 ? [{ customerId: { in: oldFlowCustomerIds } }] : []),
        ...(cleanupVehicleIds.length > 0 ? [{ vehicleId: { in: cleanupVehicleIds } }] : [])
      ]
    }
  });
  const orderIds = orders.map((order) => order.id);
  const orderQuoteIds = orders.map((order) => order.quoteId);
  const allQuoteIds = [...new Set([...quoteIds, ...orderQuoteIds])];

  if (orderIds.length > 0) {
    await prisma.orderEntitlementUsage.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderEntitlementGrant.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderEntitlementAccount.deleteMany({ where: { orderId: { in: orderIds } } });

    await prisma.collectionAction.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.collectionCaseBill.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.collectionCase.deleteMany({ where: { orderId: { in: orderIds } } });

    await prisma.depositLedger.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.paymentWriteOff.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.paymentRecord.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.receivableBill.deleteMany({ where: { orderId: { in: orderIds } } });

    await prisma.vehicleReturnDamage.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.vehicleReturn.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.vehicleDelivery.deleteMany({ where: { orderId: { in: orderIds } } });

    await prisma.orderChange.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.subscriptionOrder.updateMany({
      data: { contractId: null },
      where: { id: { in: orderIds } }
    });
    await prisma.contract.deleteMany({
      where: {
        OR: [
          { orderId: { in: orderIds } },
          { contractNo: { in: oldDefaultFlowSeedData.contractNos } },
          ...(oldFlowCustomerIds.length > 0 ? [{ customerId: { in: oldFlowCustomerIds } }] : [])
        ]
      }
    });
    await prisma.subscriptionOrder.deleteMany({ where: { id: { in: orderIds } } });
  }

  await prisma.vehicleDelivery.deleteMany({
    where: {
      OR: [
        { deliveryNo: { in: oldDefaultFlowSeedData.deliveryNos } },
        ...(oldFlowCustomerIds.length > 0 ? [{ customerId: { in: oldFlowCustomerIds } }] : []),
        ...(cleanupVehicleIds.length > 0 ? [{ vehicleId: { in: cleanupVehicleIds } }] : [])
      ]
    }
  });
  await prisma.vehicleReturnDamage.deleteMany({
    where: cleanupVehicleIds.length > 0 ? { vehicleId: { in: cleanupVehicleIds } } : { id: { in: [] } }
  });
  if (oldFlowCustomerIds.length > 0 || cleanupVehicleIds.length > 0) {
    await prisma.vehicleReturn.deleteMany({
      where: {
        OR: [
          ...(oldFlowCustomerIds.length > 0 ? [{ customerId: { in: oldFlowCustomerIds } }] : []),
          ...(cleanupVehicleIds.length > 0 ? [{ vehicleId: { in: cleanupVehicleIds } }] : [])
        ]
      }
    });
  }
  await prisma.contract.deleteMany({
    where: {
      OR: [
        { contractNo: { in: oldDefaultFlowSeedData.contractNos } },
        ...(oldFlowCustomerIds.length > 0 ? [{ customerId: { in: oldFlowCustomerIds } }] : [])
      ]
    }
  });
  await prisma.contractVersion.deleteMany({
    where: {
      OR: oldDefaultFlowSeedData.contractVersions.map((contractVersion) => ({
        templateName: contractVersion.templateName,
        versionNo: contractVersion.versionNo
      }))
    }
  });

  await prisma.subscriptionQuote.deleteMany({
    where: {
      OR: [
        { quoteNo: { in: oldDefaultFlowSeedData.quoteNos } },
        ...(allQuoteIds.length > 0 ? [{ id: { in: allQuoteIds } }] : []),
        ...(applicationIds.length > 0 ? [{ applicationId: { in: applicationIds } }] : []),
        ...(oldFlowCustomerIds.length > 0 ? [{ customerId: { in: oldFlowCustomerIds } }] : []),
        ...(cleanupVehicleIds.length > 0 ? [{ vehicleId: { in: cleanupVehicleIds } }] : [])
      ]
    }
  });

  if (applicationIds.length > 0) {
    await prisma.riskResult.deleteMany({ where: { applicationId: { in: applicationIds } } });
    await prisma.applicationActionLog.deleteMany({ where: { applicationId: { in: applicationIds } } });
    await prisma.applicationMaterialFile.deleteMany({ where: { applicationId: { in: applicationIds } } });
    await prisma.applicationMaterialGroup.deleteMany({ where: { applicationId: { in: applicationIds } } });
    await prisma.applicationMaterial.deleteMany({ where: { applicationId: { in: applicationIds } } });
    await prisma.application.deleteMany({ where: { id: { in: applicationIds } } });
  }

  if (oldFlowVehicleIds.length > 0) {
    await prisma.vehicleSalePriceHistory.deleteMany({ where: { vehicleId: { in: oldFlowVehicleIds } } });
    await prisma.vehicle.deleteMany({ where: { id: { in: oldFlowVehicleIds } } });
  }

  if (oldFlowCustomerIds.length > 0) {
    await prisma.customerFollowup.deleteMany({ where: { customerId: { in: oldFlowCustomerIds } } });
    await prisma.customerIdentity.deleteMany({ where: { customerId: { in: oldFlowCustomerIds } } });
    await prisma.customerProfile.deleteMany({ where: { customerId: { in: oldFlowCustomerIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: oldFlowCustomerIds } } });
  }
}

async function seedVehicleModelDefinitions(operatorId) {
  for (const [
    modelCode,
    legacyVehicleModel,
    brand,
    series,
    modelName,
    displayName,
    customerDisplayName,
    sortOrder
  ] of vehicleModelDefinitionSeedRows) {
    await prisma.vehicleModelDefinition.upsert({
      create: {
        brand,
        createdBy: operatorId,
        customerDisplayName,
        displayName,
        enabled: true,
        legacyVehicleModel,
        modelCode,
        modelName,
        portalVisible: false,
        series,
        snapshot: {
          source: "SEED",
          stage: "10X-C"
        },
        sortOrder,
        updatedBy: operatorId
      },
      update: {
        brand,
        customerDisplayName,
        displayName,
        legacyVehicleModel,
        modelName,
        series,
        snapshot: {
          source: "SEED",
          stage: "10X-C"
        },
        sortOrder,
        updatedBy: operatorId
      },
      where: { modelCode }
    });
  }
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
  const insuranceStartDate = new Date("2026-01-01T00:00:00.000Z");
  const insuranceEndDate = new Date("2027-12-31T00:00:00.000Z");
  const reviewedAt = new Date("2026-06-02T00:00:00.000Z");
  const nextSalePriceReviewAt = new Date("2026-09-01T00:00:00.000Z");
  const legacyVehicleModels = [...new Set(demoVehicles.map((vehicle) => vehicle.vehicleModel))];
  const modelDefinitions = await prisma.vehicleModelDefinition.findMany({
    select: {
      id: true,
      legacyVehicleModel: true
    },
    where: {
      deletedAt: null,
      enabled: true,
      legacyVehicleModel: { in: legacyVehicleModels }
    }
  });
  const modelDefinitionByLegacy = new Map(
    modelDefinitions.map((definition) => [definition.legacyVehicleModel, definition])
  );

  for (const vehicleSeed of demoVehicles) {
    const modelDefinition = modelDefinitionByLegacy.get(vehicleSeed.vehicleModel);
    if (!modelDefinition) {
      throw new Error(`VehicleModelDefinition is required for demo vehicle model ${vehicleSeed.vehicleModel}.`);
    }

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
        insuranceEndDate,
        insuranceStartDate,
        model: vehicleSeed.model,
        modelDefinition: { connect: { id: modelDefinition.id } },
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
        insuranceEndDate,
        insuranceStartDate,
        model: vehicleSeed.model,
        modelDefinition: { connect: { id: modelDefinition.id } },
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

async function seedBaselineCustomerLeads(operatorId) {
  for (const lead of baselineCustomerLeads) {
    await prisma.customer.upsert({
      create: {
        createdBy: operatorId,
        customerNo: lead.customerNo,
        customerType: lead.customerType,
        grade: lead.grade,
        mobile: lead.mobile,
        name: lead.name,
        ownerUserId: operatorId,
        remark: lead.remark,
        sourceChannel: lead.sourceChannel,
        status: "LEAD",
        updatedBy: operatorId
      },
      update: {
        customerType: lead.customerType,
        deletedAt: null,
        grade: lead.grade,
        mobile: lead.mobile,
        name: lead.name,
        ownerUserId: operatorId,
        remark: lead.remark,
        sourceChannel: lead.sourceChannel,
        status: "LEAD",
        updatedBy: operatorId
      },
      where: { customerNo: lead.customerNo }
    });
  }
}

async function seedBaselineSubscriptionCatalog(operatorId) {
  const effectiveFrom = new Date("2026-06-01T00:00:00.000Z");
  const reviewedAt = new Date("2026-06-02T00:00:00.000Z");
  const vehicleBaseFeeAmount = 520000;
  const vehiclePackageRate = "0.040000";
  const monthlyFeeRate = "0.035000";
  const mileageLimitKm = 1500;
  const overMileageFeeAmount = 120;
  const energyLimitKwh = 200;
  const energyLimitCount = 4;
  const et5ModelDefinition = await prisma.vehicleModelDefinition.findFirst({
    select: { id: true },
    where: {
      deletedAt: null,
      enabled: true,
      legacyVehicleModel: "ET5"
    }
  });
  if (!et5ModelDefinition) {
    throw new Error("VehicleModelDefinition is required for baseline ET5 product configuration.");
  }

  const product = await prisma.product.upsert({
    create: {
      createdBy: operatorId,
      description: "默认 ET5 订阅产品",
      name: "A线ET5自助订阅产品",
      productNo: baselineSubscriptionSeed.productNo,
      productType: "SUBSCRIPTION",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    update: {
      deletedAt: null,
      description: "默认 ET5 订阅产品",
      name: "A线ET5自助订阅产品",
      productType: "SUBSCRIPTION",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    where: { productNo: baselineSubscriptionSeed.productNo }
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
      versionNo: baselineSubscriptionSeed.versionNo
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
        versionNo: baselineSubscriptionSeed.versionNo
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
      modelDefinitionId: et5ModelDefinition.id,
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
      modelDefinitionId: et5ModelDefinition.id,
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
      configName: "ET5 标准配置",
      createdBy: operatorId,
      maxPeriodMonths: 36,
      maxPurchasePriceAmount: BigInt(18000000),
      minPeriodMonths: 12,
      minPurchasePriceAmount: BigInt(10000000),
      modelDefinitionId: et5ModelDefinition.id,
      monthlyFeeRate: vehiclePackageRate,
      packageName: "A线ET5标准车型包",
      packageNo: baselineSubscriptionSeed.vehiclePackageNo,
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "默认 seed 车型包",
      series: "ET5",
      status: "ACTIVE",
      updatedBy: operatorId,
      vehicleModel: "ET5",
      vehicleModelName: "ET5"
    },
    update: {
      brand: "NIO",
      configName: "ET5 标准配置",
      deletedAt: null,
      maxPeriodMonths: 36,
      maxPurchasePriceAmount: BigInt(18000000),
      minPeriodMonths: 12,
      minPurchasePriceAmount: BigInt(10000000),
      modelDefinitionId: et5ModelDefinition.id,
      monthlyFeeRate: vehiclePackageRate,
      packageName: "A线ET5标准车型包",
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "默认 seed 车型包",
      series: "ET5",
      status: "ACTIVE",
      updatedBy: operatorId,
      vehicleModel: "ET5",
      vehicleModelName: "ET5"
    },
    where: { packageNo: baselineSubscriptionSeed.vehiclePackageNo }
  });

  const mileagePackage = await prisma.mileagePackage.upsert({
    create: {
      createdBy: operatorId,
      monthlyMileageKm: mileageLimitKm,
      overMileageFeeAmount: BigInt(overMileageFeeAmount),
      packageName: "A线ET5 1500km里程包",
      packageNo: baselineSubscriptionSeed.mileagePackageNo,
      priceAmount: BigInt(baselineSubscriptionSeed.mileagePackagePriceAmount),
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "默认 seed 里程包",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    update: {
      deletedAt: null,
      monthlyMileageKm: mileageLimitKm,
      overMileageFeeAmount: BigInt(overMileageFeeAmount),
      packageName: "A线ET5 1500km里程包",
      priceAmount: BigInt(baselineSubscriptionSeed.mileagePackagePriceAmount),
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "默认 seed 里程包",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    where: { packageNo: baselineSubscriptionSeed.mileagePackageNo }
  });

  const energyPackage = await prisma.energyPackage.upsert({
    create: {
      createdBy: operatorId,
      monthlyEnergyCount: energyLimitCount,
      monthlyEnergyKwh: energyLimitKwh,
      packageName: "A线ET5补能包",
      packageNo: baselineSubscriptionSeed.energyPackageNo,
      priceAmount: BigInt(baselineSubscriptionSeed.energyPackagePriceAmount),
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "默认 seed 补能包",
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
      priceAmount: BigInt(baselineSubscriptionSeed.energyPackagePriceAmount),
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "默认 seed 补能包",
      serviceDescription: "每月 4 次补能服务",
      stationScope: "上海核心城区",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    where: { packageNo: baselineSubscriptionSeed.energyPackageNo }
  });

  const benefitPackage = await prisma.benefitPackage.upsert({
    create: {
      benefitCount: 2,
      benefitType: "WASH_CAR",
      createdBy: operatorId,
      description: "每月 2 次洗车权益",
      packageName: "A线ET5权益包",
      packageNo: baselineSubscriptionSeed.benefitPackageNo,
      priceAmount: BigInt(baselineSubscriptionSeed.benefitPackagePriceAmount),
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "默认 seed 权益包",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    update: {
      benefitCount: 2,
      benefitType: "WASH_CAR",
      deletedAt: null,
      description: "每月 2 次洗车权益",
      packageName: "A线ET5权益包",
      priceAmount: BigInt(baselineSubscriptionSeed.benefitPackagePriceAmount),
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "默认 seed 权益包",
      status: "ACTIVE",
      updatedBy: operatorId
    },
    where: { packageNo: baselineSubscriptionSeed.benefitPackageNo }
  });

  await prisma.subscriptionPlan.upsert({
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
      planNo: baselineSubscriptionSeed.planNo,
      productId: product.id,
      productVersionId: productVersion.id,
      remark: "默认 seed 订阅套餐",
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
      remark: "默认 seed 订阅套餐",
      status: "ACTIVE",
      updatedBy: operatorId,
      vehiclePackageId: vehiclePackage.id
    },
    where: { planNo: baselineSubscriptionSeed.planNo }
  });
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
