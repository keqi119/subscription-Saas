# Stage 10X-A VehicleModel enum 漂移收口

## 目标

Stage 10X-A 用于把已经手工加入数据库的车型代码正式纳入代码库，消除数据库 enum、Prisma schema、前端下拉和测试之间的不一致风险。

本阶段新增并收口以下 `VehicleModel` 值：

- `ET5T`
- `EC6`
- `ES8`
- `ET9`
- `ES9`

原有 `ET5`、`ET7`、`ES6` 保持不变。

## 当前问题

当前车型代码仍由 Prisma enum 和前端硬编码 options 管理：

- `apps/api/prisma/schema.prisma` 中的 `VehicleModel`
- 车辆、报表、资产收益、产品车型包页面中的车型下拉
- Prisma Client 生成的 `VehicleModel` 类型

在人工录入 ROE 样例车辆前，数据库已经手工新增了 `ET5T`、`EC6`、`ES8`、`ET9`、`ES9`。如果 schema 和 migration 不收口，后续 `prisma generate`、车辆编辑、报表筛选、seed、测试和部署都会出现漂移风险。

## 本阶段实现

1. `VehicleModel` enum 正式包含 `ET5T`、`EC6`、`ES8`、`ET9`、`ES9`。
2. 新增幂等 migration，使用 `ALTER TYPE ... ADD VALUE IF NOT EXISTS`，兼容数据库已手工存在这些值的场景。
3. 前端车辆页、综合报表、资产收益报表和产品车型包下拉补齐新车型。
4. 新增 `VEHICLE_MODEL_LABELS`，车型下拉统一从标签表取显示文本。
5. 增加测试，确认 Prisma Client 暴露新增 enum 值，车辆创建 / 编辑 DTO 能接受新增车型代码。

## 不做范围

本阶段不做车型代码主数据化，不新增 `VehicleModelDefinition`，不把 `Vehicle.model` 从 enum 改成 string，也不迁移历史车辆到新模型。

本阶段不修改车辆商品主逻辑，不修改 ROE、折旧、BaaS、支付、核销、账单、合同、工单等主流程。

## 后续

Stage 10X-B 建议做车型代码主数据化影响审计，明确 enum 到后台主数据的迁移路径。

Stage 10X-C 再新增后台车型代码主数据模块，让车型代码可以通过后台维护，而不是每次新增车型都修改 Prisma enum。
