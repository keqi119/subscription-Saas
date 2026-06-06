import { MenuItemDefinition, PermissionCode } from "./auth";

export const SYSTEM_MENUS: MenuItemDefinition[] = [
  {
    code: "dashboard",
    icon: "dashboard",
    label: "首页驾驶舱",
    path: "/",
    permissionCode: PermissionCode.DASHBOARD_VIEW
  },
  {
    code: "customers",
    icon: "customer",
    label: "客户中心",
    path: "/customers",
    permissionCode: PermissionCode.CUSTOMER_VIEW
  },
  {
    code: "applications",
    icon: "application",
    label: "进件管理",
    path: "/applications",
    permissionCode: PermissionCode.APPLICATION_VIEW
  },
  {
    code: "risk",
    icon: "safety",
    label: "风控中心",
    path: "/risk",
    permissionCode: PermissionCode.RISK_VIEW,
    children: [
      {
        code: "risk.deposit_rules",
        icon: "money",
        label: "押金规则",
        path: "/risk/deposit-rules",
        permissionCode: PermissionCode.RISK_VIEW
      }
    ]
  },
  {
    code: "products",
    icon: "product",
    label: "产品中心",
    path: "/products",
    permissionCode: PermissionCode.PRODUCT_VIEW,
    children: [
      {
        code: "products.subscription",
        icon: "product",
        label: "订阅产品",
        path: "/products?tab=products",
        permissionCode: PermissionCode.PRODUCT_VIEW
      },
      {
        code: "products.versions",
        icon: "file",
        label: "产品版本",
        path: "/products?tab=versions",
        permissionCode: PermissionCode.PRODUCT_VERSION_VIEW
      },
      {
        code: "products.vehicle_packages",
        icon: "car",
        label: "车型包",
        path: "/products?tab=vehicle-packages",
        permissionCode: PermissionCode.VEHICLE_PACKAGE_VIEW
      },
      {
        code: "products.mileage_packages",
        icon: "dashboard",
        label: "里程包",
        path: "/products?tab=mileage-packages",
        permissionCode: PermissionCode.MILEAGE_PACKAGE_VIEW
      },
      {
        code: "products.energy_packages",
        icon: "money",
        label: "补能包",
        path: "/products?tab=energy-packages",
        permissionCode: PermissionCode.ENERGY_PACKAGE_VIEW
      },
      {
        code: "products.benefit_packages",
        icon: "safety",
        label: "权益包",
        path: "/products?tab=benefit-packages",
        permissionCode: PermissionCode.BENEFIT_PACKAGE_VIEW
      },
      {
        code: "products.subscription_plans",
        icon: "quote",
        label: "订阅套餐",
        path: "/products?tab=subscription-plans",
        permissionCode: PermissionCode.SUBSCRIPTION_PLAN_VIEW
      }
    ]
  },
  {
    code: "vehicles",
    icon: "car",
    label: "车辆资产",
    path: "/vehicles",
    permissionCode: PermissionCode.VEHICLE_VIEW
  },
  {
    code: "quotes",
    icon: "quote",
    label: "订阅报价",
    path: "/quotes",
    permissionCode: PermissionCode.QUOTE_VIEW
  },
  {
    code: "orders",
    icon: "order",
    label: "订单中心",
    path: "/orders",
    permissionCode: PermissionCode.ORDER_VIEW,
    children: [
      {
        code: "orders.subscription",
        icon: "order",
        label: "订阅订单",
        path: "/orders",
        permissionCode: PermissionCode.ORDER_VIEW
      },
      {
        code: "orders.review",
        icon: "audit",
        label: "旧版订单审核",
        path: "/orders/review",
        permissionCode: PermissionCode.ORDER_REVIEW
      },
      {
        code: "orders.contracts",
        icon: "contract",
        label: "合同管理",
        path: "/contracts",
        permissionCode: PermissionCode.CONTRACT_VIEW
      },
      {
        code: "orders.contract_templates",
        icon: "file",
        label: "合同模板",
        path: "/contract-versions",
        permissionCode: PermissionCode.CONTRACT_TEMPLATE_VIEW
      }
    ]
  },
  {
    code: "billing",
    icon: "money",
    label: "财务管理",
    path: "/billing",
    permissionCode: PermissionCode.BILLING_GENERATE,
    children: [
      {
        code: "billing.monthly_rent",
        icon: "money",
        label: "月租账单生成",
        path: "/billing/monthly-rent",
        permissionCode: PermissionCode.BILLING_GENERATE
      }
    ]
  },
  {
    code: "system",
    icon: "setting",
    label: "系统管理",
    path: "/system",
    permissionCode: PermissionCode.USER_VIEW,
    children: [
      {
        code: "system.users",
        icon: "team",
        label: "用户管理",
        path: "/system/users",
        permissionCode: PermissionCode.USER_VIEW
      },
      {
        code: "system.roles",
        icon: "safety",
        label: "角色管理",
        path: "/system/roles",
        permissionCode: PermissionCode.ROLE_VIEW
      },
      {
        code: "system.permissions",
        icon: "key",
        label: "权限管理",
        path: "/system/permissions",
        permissionCode: PermissionCode.PERMISSION_VIEW
      },
      {
        code: "system.audit_logs",
        icon: "audit",
        label: "操作日志",
        path: "/system/audit-logs",
        permissionCode: PermissionCode.AUDIT_LOG_VIEW
      }
    ]
  }
];
