export enum PermissionCode {
  DASHBOARD_VIEW = "dashboard:view",
  USER_VIEW = "user:view",
  USER_MANAGE = "user:manage",
  ROLE_VIEW = "role:view",
  ROLE_MANAGE = "role:manage",
  PERMISSION_VIEW = "permission:view",
  MENU_VIEW = "menu:view",
  AUDIT_LOG_VIEW = "audit_log:view",
  CUSTOMER_VIEW = "customer:view",
  CUSTOMER_MANAGE = "customer:manage",
  APPLICATION_VIEW = "application:view",
  APPLICATION_MANAGE = "application:manage",
  APPLICATION_SUBMIT = "application:submit",
  APPLICATION_MATERIAL_UPLOAD = "application:material_upload",
  APPLICATION_MATERIAL_DELETE = "application:material_delete",
  APPLICATION_REVIEW = "application:review",
  RISK_VIEW = "risk:view",
  RISK_MANAGE = "risk:manage",
  PRODUCT_VIEW = "product:view",
  PRODUCT_CREATE = "product:create",
  PRODUCT_UPDATE = "product:update",
  PRODUCT_ACTIVATE = "product:activate",
  PRODUCT_VERSION_VIEW = "product_version:view",
  PRODUCT_VERSION_CREATE = "product_version:create",
  PRODUCT_VERSION_UPDATE = "product_version:update",
  PRODUCT_VERSION_APPROVE = "product_version:approve",
  PRODUCT_VERSION_ACTIVATE = "product_version:activate",
  PRODUCT_PRICE_RULE_VIEW = "product_price_rule:view",
  PRODUCT_PRICE_RULE_CREATE = "product_price_rule:create",
  PRODUCT_PRICE_RULE_UPDATE = "product_price_rule:update",
  PRODUCT_PRICE_RULE_DELETE = "product_price_rule:delete",
  VEHICLE_PACKAGE_VIEW = "vehicle_package:view",
  VEHICLE_PACKAGE_CREATE = "vehicle_package:create",
  VEHICLE_PACKAGE_UPDATE = "vehicle_package:update",
  VEHICLE_PACKAGE_ACTIVATE = "vehicle_package:activate",
  VEHICLE_PACKAGE_DELETE = "vehicle_package:delete",
  MILEAGE_PACKAGE_VIEW = "mileage_package:view",
  MILEAGE_PACKAGE_CREATE = "mileage_package:create",
  MILEAGE_PACKAGE_UPDATE = "mileage_package:update",
  MILEAGE_PACKAGE_ACTIVATE = "mileage_package:activate",
  MILEAGE_PACKAGE_DELETE = "mileage_package:delete",
  ENERGY_PACKAGE_VIEW = "energy_package:view",
  ENERGY_PACKAGE_CREATE = "energy_package:create",
  ENERGY_PACKAGE_UPDATE = "energy_package:update",
  ENERGY_PACKAGE_ACTIVATE = "energy_package:activate",
  ENERGY_PACKAGE_DELETE = "energy_package:delete",
  BENEFIT_PACKAGE_VIEW = "benefit_package:view",
  BENEFIT_PACKAGE_CREATE = "benefit_package:create",
  BENEFIT_PACKAGE_UPDATE = "benefit_package:update",
  BENEFIT_PACKAGE_ACTIVATE = "benefit_package:activate",
  BENEFIT_PACKAGE_DELETE = "benefit_package:delete",
  SUBSCRIPTION_PLAN_VIEW = "subscription_plan:view",
  SUBSCRIPTION_PLAN_CREATE = "subscription_plan:create",
  SUBSCRIPTION_PLAN_UPDATE = "subscription_plan:update",
  SUBSCRIPTION_PLAN_ACTIVATE = "subscription_plan:activate",
  SUBSCRIPTION_PLAN_DEACTIVATE = "subscription_plan:deactivate",
  SUBSCRIPTION_PLAN_DELETE = "subscription_plan:delete",
  VEHICLE_VIEW = "vehicle:view",
  VEHICLE_CREATE = "vehicle:create",
  VEHICLE_UPDATE = "vehicle:update",
  VEHICLE_DELETE = "vehicle:delete",
  VEHICLE_UPDATE_STATUS = "vehicle:update_status",
  VEHICLE_INITIALIZE_SALE_PRICE = "vehicle:initialize_sale_price",
  VEHICLE_REVIEW_SALE_PRICE = "vehicle:review_sale_price",
  VEHICLE_HISTORY_VIEW = "vehicle:history_view",
  VEHICLE_MANAGE = "vehicle:manage",
  QUOTE_VIEW = "quote:view",
  QUOTE_CREATE = "quote:create",
  QUOTE_UPDATE = "quote:update",
  QUOTE_CONFIRM = "quote:confirm",
  QUOTE_CANCEL = "quote:cancel",
  ORDER_VIEW = "order:view",
  ORDER_CREATE = "order:create",
  ORDER_UPDATE = "order:update",
  ORDER_CANCEL = "order:cancel",
  ORDER_REVIEW = "order:review",
  ORDER_CONFIRM_FINAL_PLAN = "order:confirm_final_plan",
  ORDER_REJECT = "order:reject",
  ORDER_CHANGE_VIEW = "order_change:view",
  ORDER_CHANGE_CREATE = "order_change:create",
  ORDER_CHANGE_APPROVE = "order_change:approve",
  ORDER_CHANGE_REJECT = "order_change:reject",
  ORDER_CHANGE_EXECUTE = "order_change:execute",
  CONTRACT_VIEW = "contract:view",
  CONTRACT_GENERATE = "contract:generate",
  CONTRACT_SIGN = "contract:sign",
  CONTRACT_ARCHIVE = "contract:archive",
  CONTRACT_CANCEL = "contract:cancel",
  CONTRACT_TEMPLATE_VIEW = "contract_template:view",
  CONTRACT_TEMPLATE_CREATE = "contract_template:create",
  CONTRACT_TEMPLATE_UPDATE = "contract_template:update",
  CONTRACT_TEMPLATE_ACTIVATE = "contract_template:activate"
}

export interface AuthenticatedUser {
  id: string;
  username: string;
  name: string;
  roles: string[];
  permissions: string[];
}

export interface LoginResponse {
  user: AuthenticatedUser;
  menus: MenuItemDefinition[];
}

export interface MenuItemDefinition {
  code: string;
  label: string;
  path: string;
  icon?: string;
  permissionCode?: string;
  children?: MenuItemDefinition[];
}
