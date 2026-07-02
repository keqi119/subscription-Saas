# 权限矩阵

本文档用于 Stage 9B Production Readiness Hardening，基于以下文件做代码级事实核查：

- `packages/shared/src/auth.ts`
- `packages/shared/src/menus.ts`
- `apps/api/prisma/seed.mjs`
- 后端 `RequirePermissions` / `RequireAnyPermissions` 使用情况

## 1. 角色列表

| 角色 | 中文名称 | 主要职责 |
| --- | --- | --- |
| `ADMIN` | 系统管理员 | 用户、角色、权限、菜单、系统配置和全量权限 |
| `SA` | 销售顾问 | 获客、客户进件、报价跟进、合同查看 |
| `OP` | 运营管理 | 产品、车辆、报价、订单、合同、权益、报表和运营处理 |
| `RC` | 风控专员 | 资料审核、风险审批、客户评级和押金规则 |
| `FI` | 财务专员 | 账单、收款、核销、保证金、融资、收益权、财务报表 |
| `AS` | 资产运营 | 车辆台账、销售价、交付、退车、残值、估值复核 |
| `CS` | 客服运营 | 客户回访、续订与服务运营，当前矩阵需后续补充 |
| `GM` | 总经理 / 运营总监 | 特殊审批、重大风险决策、管理层查看 |

## 2. 权限域列表

核心权限域来自 `PermissionCode`：

| 权限域 | 示例权限 |
| --- | --- |
| dashboard | `dashboard:view` |
| system | `user:view`、`user:manage`、`role:view`、`role:manage`、`permission:view`、`menu:view`、`audit_log:view` |
| customer | `customer:view`、`customer:manage` |
| application | `application:view`、`application:manage`、`application:submit`、`application:review`、`application:material_upload`、`application:material_delete` |
| risk | `risk:view`、`risk:manage` |
| product | `product:*`、`product_version:*`、`product_price_rule:*` |
| package | `vehicle_package:*`、`mileage_package:*`、`energy_package:*`、`benefit_package:*` |
| subscription_plan | `subscription_plan:view/create/update/activate/deactivate/delete` |
| quote | `quote:view/create/update/confirm/cancel` |
| order | `order:view/create/update/cancel/review/confirm_final_plan/reject` |
| order_change | `order_change:view/create/approve/reject/execute` |
| contract | `contract:view/generate/sign/archive/cancel`、`contract_template:*` |
| vehicle | `vehicle:view/create/update/delete/update_status/initialize_sale_price/review_sale_price/history_view/manage` |
| fleet_ops | `fleet_ops:read` |
| delivery | `delivery:view/prepare/confirm` |
| return | `vehicle_return:view/prepare/confirm/damage_record` |
| billing | `billing:view/generate` |
| payment | `payment:view/create/write_off` |
| deposit | `deposit_ledger:view/deduct/refund` |
| collection | `collection:view/refresh_overdue/action_create/close` |
| entitlement | `entitlement:view/generate/adjust/consume` |
| report | `report:view`、`report:finance`、`report:asset` |
| capital_structure | `capital_structure:view/manage` |
| financing | `financing:view/manage` |
| revenue_right | `revenue_right:view/manage` |
| revenue_share | `revenue_share:view/manage` |
| vehicle_asset_pool | `vehicle_asset_pool:view/manage` |
| residual_market | `residual_market:view/manage/import` |
| residual_curve | `residual_curve:view/generate/manage` |
| residual_forecast | `residual_forecast:view/generate/manage` |
| residual_model_run | `residual_model_run:view/manage` |
| vehicle_valuation_review | `vehicle_valuation_review:view/create/approve` |

## 3. 角色主要权限

### ADMIN

`ADMIN` 通过 seed 获得全部权限和全部菜单。

### SA

主要权限：

- 客户查看和管理；
- 进件查看、管理、提交、资料上传/删除；
- 产品、产品版本、旧价格规则、套餐组件查看；
- 车辆查看、销售价历史查看；
- 报价查看、创建、更新、确认、取消；
- 订单查看、创建；
- 订单变更查看、创建；
- 权益查看；
- 账单查看；
- 交付/退车查看；
- 合同查看。

主要菜单：

- 首页驾驶舱；
- 客户中心；
- 进件管理；
- 产品中心；
- 车辆资产；
- 订阅报价；
- 订单中心；
- 订阅订单；
- 合同管理。

### OP

主要权限：

- 客户和进件基础查看/提交/资料维护；
- 产品、套餐和订阅套餐管理；
- 车辆管理；
- 车辆估值复核查看、创建、审核；
- 报价管理；
- 订单、合同、交付、退车和订单变更管理；
- 权益发放、调整、消耗；
- 经营报表和资产报表；
- 资本结构、融资、车辆资产池、收益权、分润查看；
- 市场残值样本导入、残值曲线生成、单车残值预测生成、模型运行记录查看；
- 保证金查看/扣减和催收动作。

主要菜单：

- 客户、进件、产品、车辆、报价、订单、合同；
- 经营看板和资产经营分析；
- 财务管理下的催收、融资工具、收益权；
- 车辆资产池、市场残值样本、估值复核。

### FI

主要权限：

- 产品和车辆查看；
- 车辆估值复核查看；
- 资本结构、融资工具、车辆资产池、收益权、分润规则管理；
- 报价和订单查看；
- 账单生成、收款登记、核销、保证金扣减/退款；
- 催收管理；
- 财务报表和资产报表；
- 退车查看、订单变更查看、合同查看。

主要菜单：

- 产品、车辆、报价、订单、合同；
- 经营总览、资产经营分析；
- 财务管理、月租账单、逾期催收、融资工具、收益权管理；
- 车辆资产池、市场残值样本、估值复核。

### AS

主要权限：

- 产品和套餐查看；
- 车辆管理；
- 车辆估值复核查看和创建；
- 资本结构、融资、收益权、分润查看；
- 车辆资产池管理；
- 市场残值样本、残值曲线、单车残值预测、模型运行记录管理；
- 报价和订单查看；
- 资产报表；
- 交付准备和确认；
- 退车准备、确认和损伤记录；
- 订单审核/拒绝；
- 订单变更查看；
- 合同查看。

主要菜单：

- 产品、车辆、车辆资产池、市场残值样本、估值复核；
- 订阅报价；
- 订单中心、旧版订单审核、合同管理；
- 资产经营分析；
- 融资工具、收益权管理。

### GM

主要权限：

- 客户、进件、风控；
- 产品和车辆管理；
- 车辆估值复核审核；
- 资本结构、融资、车辆资产池、收益权、分润查看；
- 残值样本、曲线、预测和模型运行记录查看；
- 报价查看；
- 订单、合同和权益管理；
- 账单、收款、保证金查看；
- 催收查看；
- 全部报表查看。

主要菜单：

- 客户、进件、风控、产品、车辆、报价、订单、合同；
- 经营总览和资产经营分析；
- 融资工具、车辆资产池、市场残值样本、估值复核、收益权、催收。

## 4. 菜单权限

菜单由 `packages/shared/src/menus.ts` 和 seed 中 `menuRows` 对齐。关键入口：

| 菜单 | 路径 | 权限 |
| --- | --- | --- |
| 首页驾驶舱 | `/` | `dashboard:view` |
| 客户中心 | `/customers` | `customer:view` |
| 进件管理 | `/applications` | `application:view` |
| 风控中心 | `/risk` | `risk:view` |
| 押金规则 | `/risk/deposit-rules` | `risk:view` |
| 产品中心 | `/products` | `product:view` |
| 订阅套餐 | `/products?tab=subscription-plans` | `subscription_plan:view` |
| 车辆资产台账 | `/vehicles` | `vehicle:view` |
| 车队运营 | `/fleet-ops` | `fleet_ops:read` |
| 车辆资产池 | `/vehicle-asset-pools` | `vehicle_asset_pool:view` |
| 市场残值样本 | `/residual-market` | `residual_market:view` |
| 估值复核 | `/vehicle-valuation-reviews` | `vehicle_valuation_review:view` |
| 订阅报价 | `/quotes` | `quote:view` |
| 订阅订单 | `/orders` | `order:view` |
| 旧版订单审核 | `/orders/review` | `order:review` |
| 合同管理 | `/contracts` | `contract:view` |
| 合同模板 | `/contract-versions` | `contract_template:view` |
| 经营总览 | `/reports` | `report:view` |
| 资产经营分析 | `/reports/asset-profitability` | `report:asset` |
| 月租账单生成 | `/billing/monthly-rent` | `billing:generate` |
| 逾期催收 | `/billing/collections` | `collection:view` |
| 融资工具 | `/financing-instruments` | `financing:view` |
| 收益权管理 | `/revenue-rights` | `revenue_right:view` |
| 用户管理 | `/system/users` | `user:view` |
| 角色管理 | `/system/roles` | `role:view` |
| 权限管理 | `/system/permissions` | `permission:view` |
| 操作日志 | `/system/audit-logs` | `audit_log:view` |

## 5. Seed 和重新登录

权限和菜单来自 `pnpm prisma:seed`。

执行 seed 后：

```powershell
pnpm prisma:seed
```

如果权限或菜单发生变化，用户必须退出并重新登录，以刷新 `/api/auth/me` 返回的权限和菜单。

## 6. Requires Codex Verification

以下事项需要在 Stage 9C 或发布前用代码/API/browser 再验证：

- 每个角色实际登录后的菜单是否与本矩阵一致；
- 前端按钮隐藏/置灰是否与后端 guard 一致；
- `SA` 创建报价时是否能读取可用车辆和启用订阅套餐；
- `FI` 是否不能执行车辆估值复核审核通过；
- `AS` 是否只能创建/取消估值复核，不能审核通过；
- `GM` 是否能审核估值复核但不具备系统管理写权限；
- 报表 CSV 导出权限是否与查看权限一致；
- seed 后重新登录是否刷新权限。

## 7. Fleet Ops Controlled Menu Permission

P1-H10 provisions the read-only Fleet Ops admin menu for the existing `/fleet-ops` route.

- Permission code: `fleet_ops:read`.
- Chinese label: 车队运营查看.
- Menu label: 车队运营.
- Route: `/fleet-ops`.
- Required API flag: `FLEET_OPS_API_ENABLED`.
- ADMIN receives access through the existing all-permissions/all-menus seed convention.
- OP and GM receive explicit internal/admin read access because they already receive comparable vehicle, operations, and management visibility.
- SA, RC, FI, AS, CS, customer-like, and public roles are not granted Fleet Ops access in this provisioning pass.
- No `fleet_ops:write`, `fleet_ops:execute`, `fleet_ops:admin`, `fleet_ops:allocate`, `fleet_ops:collect`, or `fleet_ops:action` permission exists.
- The menu is read-only and must not expose execution, mutation, customer portal, or public Fleet Ops entry points.

## 8. Fleet Ops Existing DB Access Sync

P1-H10.1 adds a narrow idempotent repair command for existing local or staging databases that were seeded before `fleet_ops:read` and `/fleet-ops` existed.

Run this command after deploying or checking out the P1-H10/P1-H10.1 baseline when an existing admin still lacks Fleet Ops access:

```powershell
pnpm --filter @subscription-saas/api prisma:sync:fleet-ops-access
```

The command syncs only:

- Permission: `fleet_ops:read` / 车队运营查看.
- Menu: `vehicles.fleet_ops` / 车队运营 / `/fleet-ops`.
- Roles: `ADMIN`, `OP`, `GM`.

It does not run the full seed, does not add migrations, does not grant Fleet Ops write/execute/admin/action permissions, and does not grant customer/public portal access.

After running it, users must log out and log in again so `/auth/me` reloads DB-backed role permissions and menus. Verify `/auth/me` includes `fleet_ops:read`, `/auth/me` menus include `/fleet-ops`, and the sidebar shows 车队运营. If `FLEET_OPS_API_ENABLED` is off, the page may still show the expected API disabled state.
