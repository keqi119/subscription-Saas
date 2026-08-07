export interface ActionAvailability {
  allowed: boolean;
  reason?: string;
}

export type PermissionCollection = ReadonlySet<string> | readonly string[] | null | undefined;

export interface PermissionGuardOptions {
  allowed?: boolean;
  disabledReason?: string;
  noPermissionReason?: string;
  permission?: string | readonly string[];
  permissions?: PermissionCollection;
}

export interface ApplicationActionState {
  applicationSource?: string | null;
  creditReviewStatus?: string | null;
  depositStatus?: string | null;
  finalSubscriptionPlanId?: string | null;
  finalVehicleId?: string | null;
  orders?: readonly unknown[] | null;
  planConfirmStatus?: string | null;
  productReviewStatus?: string | null;
  status?: string | null;
  materialReviewStatus?: string | null;
  vehicleReviewStatus?: string | null;
}

export interface OrderActionState {
  contract?: unknown | null;
  orderStatus?: string | null;
}

export interface OrderChangeActionState {
  executedAt?: string | null;
  status?: string | null;
}

export interface ContractActionState {
  status?: string | null;
}

export interface VehicleActionState {
  currentSalePriceAmount?: number | null;
  salePriceStatus?: string | null;
  status?: string | null;
}

export interface SubscriptionPlanActionState {
  benefitPackage?: { status?: string | null } | null;
  energyPackage?: { status?: string | null } | null;
  mileagePackage?: { status?: string | null } | null;
  status?: string | null;
  vehiclePackage?: { status?: string | null } | null;
}

export interface ProductVersionActionState {
  id: string;
  status?: string | null;
}

export interface ProductVersionPlanState {
  productVersionId?: string | null;
  status?: string | null;
}

export type SubscriptionChangeGuardAction =
  | "QUOTE"
  | "APPROVE_PRICE"
  | "WAIT_CUSTOMER"
  | "GENERATE_CONTRACT"
  | "START_ESIGN"
  | "WAIT_ARCHIVE"
  | "WAIT_EFFECTIVE"
  | "RETRY"
  | "MANUAL"
  | "DONE";

export type SubscriptionJourneyGuardAction =
  | "FINAL_PLAN_DECISION"
  | "FINAL_VEHICLE_ALLOCATION"
  | "DELIVERY_EVIDENCE_DECISION"
  | "RETRY"
  | "PAUSE"
  | "RESUME"
  | "CANCEL";

export type LegacyJourneyAction =
  | "CREATE_ORDER"
  | "GENERATE_INITIAL_BILLS"
  | "REGISTER_INITIAL_PAYMENT"
  | "SIGN_OR_ARCHIVE_CONTRACT"
  | "CONFIRM_DELIVERY"
  | "GENERATE_MONTHLY_RENT";

const SUBSCRIPTION_CHANGE_ACTION_PERMISSIONS: Partial<
  Record<SubscriptionChangeGuardAction, string>
> = {
  APPROVE_PRICE: "subscription_change:price_override_approve",
  GENERATE_CONTRACT: "contract:generate",
  MANUAL: "subscription_change:manual_takeover",
  QUOTE: "subscription_change:quote",
  RETRY: "subscription_change:execute",
  START_ESIGN: "subscription_change:esign_retry",
  WAIT_CUSTOMER: "subscription_change:submit"
};

const SUBSCRIPTION_JOURNEY_ACTION_PERMISSIONS: Record<
  SubscriptionJourneyGuardAction,
  string
> = {
  CANCEL: "subscription_journey:cancel",
  DELIVERY_EVIDENCE_DECISION: "subscription_journey:delivery_evidence_decide",
  FINAL_PLAN_DECISION: "subscription_journey:plan_decide",
  FINAL_VEHICLE_ALLOCATION: "subscription_journey:vehicle_allocate",
  PAUSE: "subscription_journey:recover",
  RESUME: "subscription_journey:recover",
  RETRY: "subscription_journey:recover"
};

const CONFLICTING_LEGACY_JOURNEY_ACTIONS = new Set<LegacyJourneyAction>([
  "CREATE_ORDER",
  "GENERATE_INITIAL_BILLS",
  "REGISTER_INITIAL_PAYMENT",
  "SIGN_OR_ARCHIVE_CONTRACT",
  "CONFIRM_DELIVERY"
]);

export function hasPermission(
  permissions: PermissionCollection,
  permission?: string | readonly string[]
) {
  if (!permission) {
    return true;
  }

  const requiredPermissions = Array.isArray(permission) ? permission : [permission];
  if (requiredPermissions.length === 0) {
    return true;
  }

  if (!permissions) {
    return false;
  }

  if (isPermissionArray(permissions)) {
    return requiredPermissions.every((item) => permissions.includes(item));
  }

  return requiredPermissions.every((item) => permissions.has(item));
}

function isPermissionArray(value: Exclude<PermissionCollection, null | undefined>): value is readonly string[] {
  return Array.isArray(value);
}

export function actionAvailability({
  allowed = true,
  disabledReason = "当前状态不允许操作",
  noPermissionReason = "无操作权限",
  permission,
  permissions
}: PermissionGuardOptions): ActionAvailability {
  if (!hasPermission(permissions, permission)) {
    return { allowed: false, reason: noPermissionReason };
  }

  if (!allowed) {
    return { allowed: false, reason: disabledReason };
  }

  return { allowed: true };
}

export function canRunSubscriptionChangeAction(
  action: SubscriptionChangeGuardAction,
  permissions: PermissionCollection
): ActionAvailability {
  const permission = SUBSCRIPTION_CHANGE_ACTION_PERMISSIONS[action];
  if (!permission) {
    return { allowed: false, reason: "当前步骤无需人工操作" };
  }
  if (!hasPermission(permissions, permission)) {
    return { allowed: false, reason: "无合同变更操作权限" };
  }
  return { allowed: true };
}

export function canRunSubscriptionJourneyAction(
  action: SubscriptionJourneyGuardAction,
  availableActions: readonly string[],
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, SUBSCRIPTION_JOURNEY_ACTION_PERMISSIONS[action])) {
    return { allowed: false, reason: "无订阅流程操作权限" };
  }
  if (!availableActions.includes(action)) {
    return { allowed: false, reason: "当前流程步骤不允许此操作" };
  }
  return { allowed: true };
}

export function shouldHideLegacyJourneyAction(
  journeyManaged: boolean,
  action: LegacyJourneyAction
) {
  return journeyManaged && CONFLICTING_LEGACY_JOURNEY_ACTIONS.has(action);
}

export function canGenerateApplicationQuote(
  application: ApplicationActionState | null | undefined,
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, "quote:create")) {
    return { allowed: false, reason: "无生成订阅报价权限" };
  }
  if (!application) {
    return { allowed: false, reason: "数据加载完成后才可操作" };
  }
  if (application.status === "REJECTED") {
    return { allowed: false, reason: "当前进件已拒绝，不能生成报价" };
  }
  if (application.status === "CANCELLED") {
    return { allowed: false, reason: "当前进件已取消，不能生成报价" };
  }
  if ((application.orders?.length ?? 0) > 0) {
    return { allowed: false, reason: "该进件已生成订单" };
  }
  if (application.applicationSource === "SELF_SERVICE") {
    return { allowed: false, reason: "客户自助进件请使用确认最终方案 / 生成正式订单流程" };
  }
  if (application.status === "APPROVED") {
    return { allowed: true };
  }
  if (application.materialReviewStatus !== "APPROVED") {
    return { allowed: false, reason: "请先完成资料审核" };
  }
  if (application.creditReviewStatus !== "APPROVED") {
    return { allowed: false, reason: "请先完成客户资质 / 授信审核" };
  }
  if (application.depositStatus !== "CONFIRMED") {
    return { allowed: false, reason: "请先确认押金" };
  }

  return { allowed: true };
}

export function canFinalizeApplicationPlan(
  application: ApplicationActionState | null | undefined,
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, "application:review")) {
    return { allowed: false, reason: "无进件审核权限" };
  }
  if (!application) {
    return { allowed: false, reason: "数据加载完成后才可操作" };
  }
  if (application.status === "REJECTED" || application.status === "CANCELLED") {
    return { allowed: false, reason: "当前进件状态不允许确认最终方案" };
  }
  if (application.materialReviewStatus !== "APPROVED") {
    return { allowed: false, reason: "请先完成资料审核" };
  }
  if (application.creditReviewStatus !== "APPROVED") {
    return { allowed: false, reason: "请先完成客户资质审核" };
  }
  if (application.depositStatus !== "CONFIRMED") {
    return { allowed: false, reason: "请先确认押金" };
  }
  if (application.planConfirmStatus === "CONFIRMED") {
    return { allowed: false, reason: "最终方案已确认" };
  }
  if ((application.orders?.length ?? 0) > 0) {
    return { allowed: false, reason: "该进件已生成订单" };
  }

  return { allowed: true };
}

export function canCreateOrderFromApplication(
  application: ApplicationActionState | null | undefined,
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, ["order:create", "quote:create"])) {
    return { allowed: false, reason: "无生成正式订单权限" };
  }
  if (!application) {
    return { allowed: false, reason: "数据加载完成后才可操作" };
  }
  if ((application.orders?.length ?? 0) > 0) {
    return { allowed: false, reason: "该进件已生成订单" };
  }
  if (application.status === "REJECTED" || application.status === "CANCELLED") {
    return { allowed: false, reason: "当前进件状态不允许生成订单" };
  }
  if (application.planConfirmStatus !== "CONFIRMED") {
    return { allowed: false, reason: "请先确认最终方案" };
  }

  return { allowed: true };
}

export function canGenerateContract(
  order: OrderActionState | null | undefined,
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, "contract:generate")) {
    return { allowed: false, reason: "无生成合同权限" };
  }
  if (!order) {
    return { allowed: false, reason: "数据加载完成后才可操作" };
  }
  if (order.contract) {
    return { allowed: false, reason: "该订单已有有效合同" };
  }
  if (order.orderStatus !== "PENDING_CONTRACT") {
    return { allowed: false, reason: "当前订单状态不允许生成合同" };
  }

  return { allowed: true };
}

export function canExecuteOrderChange(
  change: OrderChangeActionState | null | undefined,
  order: OrderActionState | null | undefined,
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, "order_change:execute")) {
    return { allowed: false, reason: "无执行变更权限" };
  }
  if (!change || !order) {
    return { allowed: false, reason: "数据加载完成后才可操作" };
  }
  if (change.executedAt) {
    return { allowed: false, reason: "该变更已执行" };
  }
  if (change.status !== "APPROVED") {
    return { allowed: false, reason: "当前变更状态不允许执行" };
  }
  if (order.orderStatus === "ACTIVE" || order.orderStatus === "LEASED") {
    return { allowed: false, reason: "当前订单已起租，暂不支持直接执行套餐变更，请走履约变更流程" };
  }

  return { allowed: true };
}

export function canSignContract(
  contract: ContractActionState | null | undefined,
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, "contract:sign")) {
    return { allowed: false, reason: "无签署合同权限" };
  }
  if (!contract) {
    return { allowed: false, reason: "数据加载完成后才可操作" };
  }
  if (contract.status !== "PENDING_SIGN" && contract.status !== "GENERATED" && contract.status !== "SIGNING") {
    return { allowed: false, reason: "当前合同状态不允许签署" };
  }

  return { allowed: true };
}

export function canArchiveContract(
  contract: ContractActionState | null | undefined,
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, "contract:archive")) {
    return { allowed: false, reason: "无归档合同权限" };
  }
  if (!contract) {
    return { allowed: false, reason: "数据加载完成后才可操作" };
  }
  if (contract.status !== "SIGNED") {
    return { allowed: false, reason: "请先完成合同签署" };
  }

  return { allowed: true };
}

export function canCancelContract(
  contract: ContractActionState | null | undefined,
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, "contract:cancel")) {
    return { allowed: false, reason: "无取消合同权限" };
  }
  if (!contract) {
    return { allowed: false, reason: "数据加载完成后才可操作" };
  }
  if (contract.status === "ARCHIVED") {
    return { allowed: false, reason: "已归档合同不能取消" };
  }
  if (contract.status === "CANCELLED") {
    return { allowed: false, reason: "合同已取消" };
  }

  return { allowed: true };
}

export function canInitializeVehicleSalePrice(
  vehicle: VehicleActionState | null | undefined,
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, "vehicle:initialize_sale_price")) {
    return { allowed: false, reason: "无初始化销售价权限" };
  }
  if (!vehicle) {
    return { allowed: false, reason: "数据加载完成后才可操作" };
  }
  if (vehicle.status === "LEASED" || vehicle.status === "SOLD") {
    return { allowed: false, reason: "当前车辆状态不允许初始化销售价" };
  }

  return { allowed: true };
}

export function canReviewVehicleSalePrice(
  vehicle: VehicleActionState | null | undefined,
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, "vehicle:review_sale_price")) {
    return { allowed: false, reason: "无车辆销售价复核权限" };
  }
  if (!vehicle) {
    return { allowed: false, reason: "数据加载完成后才可操作" };
  }
  if (!vehicle.currentSalePriceAmount) {
    return { allowed: false, reason: "当前车辆销售价尚未初始化" };
  }

  return { allowed: true };
}

export function canUpdateVehicleStatus(
  vehicle: VehicleActionState | null | undefined,
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, "vehicle:update_status")) {
    return { allowed: false, reason: "无更新车辆状态权限" };
  }
  if (!vehicle) {
    return { allowed: false, reason: "数据加载完成后才可操作" };
  }
  if (vehicle.status === "REVIEW_RESERVED" || vehicle.status === "RESERVED" || vehicle.status === "LEASED") {
    return { allowed: false, reason: "当前车辆已被占用，不能直接更新状态" };
  }

  return { allowed: true };
}

export function canActivateSubscriptionPlan(
  plan: SubscriptionPlanActionState | null | undefined,
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, "subscription_plan:activate")) {
    return { allowed: false, reason: "无启用订阅套餐权限" };
  }
  if (!plan) {
    return { allowed: false, reason: "数据加载完成后才可操作" };
  }
  if (plan.status === "ACTIVE") {
    return { allowed: false, reason: "当前套餐已启用" };
  }

  const requiredPackages = [plan.vehiclePackage, plan.mileagePackage, plan.energyPackage];
  if (requiredPackages.some((item) => item?.status !== "ACTIVE") || (plan.benefitPackage && plan.benefitPackage.status !== "ACTIVE")) {
    return { allowed: false, reason: "请先启用套餐关联的组件" };
  }

  return { allowed: true };
}

export function canActivateProductVersion(
  version: ProductVersionActionState | null | undefined,
  plans: readonly ProductVersionPlanState[],
  permissions: PermissionCollection
): ActionAvailability {
  if (!hasPermission(permissions, "product_version:activate")) {
    return { allowed: false, reason: "无启用产品版本权限" };
  }
  if (!version) {
    return { allowed: false, reason: "数据加载完成后才可操作" };
  }
  if (version.status === "ACTIVE") {
    return { allowed: false, reason: "当前产品版本已启用" };
  }
  if (!plans.some((plan) => plan.productVersionId === version.id && plan.status === "ACTIVE")) {
    return { allowed: false, reason: "请先配置并启用至少一个订阅套餐" };
  }

  return { allowed: true };
}
