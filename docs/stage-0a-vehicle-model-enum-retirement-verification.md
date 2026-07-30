# 阶段0A：VehicleModel枚举退役验收记录

验收日期：2026-07-30  
验收结论：通过

## 1. 整合基线

- 本地主干基线：`afbc7cd030ae68ca8cf1d2e923a154de9fe56bbb`
- PR #223原始头部：`570b215c9ea662b075f57a966ac702671abbc9b1`
- 主干整合提交：`e7394cf`
- 验收前功能提交：`6031945`
- 本地整合分支：`stage0a/vehicle-model-enum-retirement-integration`

整合采用普通合并提交，没有强推或改写PR #223的既有提交。

## 2. 独立数据库验证

- 验证数据库：`subscription_saas_stage0a_verify`
- 共享测试数据库：未执行迁移、种子或数据修复
- 迁移数量：70
- 迁移状态：全部已应用，Schema为最新状态
- 关键迁移：`20260724170000_vehicle_model_enum_to_string`

数据库类型检查结果：

- PostgreSQL类型`vehicle_model`不存在。
- 下列8个阶段0A兼容列均为`character varying(64)`：
  - `vehicle_package.vehicle_model`
  - `product_price_rule.vehicle_model`
  - `vehicle.vehicle_model`
  - `vehicle_model_definition.legacy_vehicle_model`
  - `subscription_quote.vehicle_model`
  - `subscription_quote.legacy_vehicle_model_snapshot`
  - `subscription_order.vehicle_model`
  - `subscription_order.legacy_vehicle_model_snapshot`

## 3. 种子验证

Prisma 7在当前`prisma.config.ts`中没有配置`migrations.seed`，因此`prisma db seed`只返回警告且不会执行种子。验收改用仓库既有受控入口`apps/api/prisma/seed.mjs`，并保持`DATABASE_URL`显式指向阶段0A验证库。

- 第一次种子：通过
- 第二次种子：通过
- 幂等性：通过，没有重复车型定义或车型码冲突

## 4. 测试与质量门

聚焦验证：

- VehicleModel字符串Schema契约：5项通过
- 无枚举守卫：21项通过
- 车型解析、快照、定义及集成：53项通过
- 产品、Portal和报表：125项通过
- Web产品中心：9项通过
- `modelCode`不可修改：3项通过
- ProductPriceRule约束准备检查：5项通过
- ProductPriceRule约束退役检查：5项通过

完整质量门：

- API typecheck：通过
- API lint：通过
- API测试：151个文件、2007项通过
- API build：通过
- Web typecheck：通过
- Web lint：通过
- Web测试：36个文件、408项通过
- Web build：通过
- Prisma validate：通过
- Prisma generate：通过
- Prisma migrate status：70个迁移，全部最新
- `release:check`：通过

## 5. 验收中修正

全新数据库种子使用规范车型码`NIO_ET5`，但ProductPriceRule治理检查原先只接受旧别名`ET5`，造成发布门误报。已按测试驱动方式修正：

- `7cf3a00 fix(vehicle): accept canonical price rule model codes`
  - 约束准备检查同时接受`modelCode`和`legacyVehicleModel`。
  - 新增规范车型码与旧别名不同的回归测试。
- `6031945 fix(vehicle): align price rule decommission check`
  - 约束退役检查查询同步读取`modelCode`。

修正后两项数据库治理检查和完整`release:check`均通过。

## 6. 阶段0B剩余兼容范围

阶段0A按计划保留字符串型兼容字段和读取适配器，因此：

- `hardRemovalReady=false`
- `warningModeReady=true`
- 已登记外部兼容引用：12
- 阶段0B需要物理删除上述8个兼容列。
- 阶段0B需要将Quote/Order的`legacyVehicleModelCodeSnapshot`收敛为`modelCodeSnapshot`。
- 阶段0B需要删除DTO、服务、Portal、报表、CSV和治理登记中的旧字段契约。

## 7. 边界检查

- 未新增依赖，未修改锁文件。
- 相对最新`main`没有修改财务、账单、Lease或电子签业务代码。
- 未修改、删除或压缩历史迁移。
- 未运行`prisma db push`或`prisma migrate reset`。
- 未推送分支或更新GitHub PR。
