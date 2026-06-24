# Stage 10X-K VehicleModel Enum Freeze Guard

## 1. 目标

Stage 10X-K 在不删除 `VehicleModel` enum、不修改业务模型、不新增 migration 的前提下，为车型主数据治理增加一道 CI / release 防线：

```text
VehicleModel enum 已冻结
新增车型必须通过 VehicleModelDefinition 后台主数据维护
release:check 和 CI 阻止 VehicleModel enum 新增、删除或改名
legacy enum 继续保留用于历史快照、兼容字段和 fallback
```

## 2. 为什么冻结 enum

Stage 10X-A 到 10X-J 已完成主流程的 `modelDefinitionId first` 改造。若后续新增车型仍通过 Prisma enum 扩张，会重新回到：

```text
新增车型 -> 改 schema enum -> migration -> 前端 options -> labels -> tests
```

冻结后，新增车型的标准路径是：

```text
新增车型 -> 后台车型代码主数据 VehicleModelDefinition
```

这样可以避免为运营新增车型反复引入 schema migration，也能让 Product、Vehicle、Residual、Portal、Reports 继续使用同一套车型主数据。

## 3. 冻结集合

`VehicleModel` enum 的冻结集合为：

```text
ET5
ET5T
ET7
ES6
EC6
ES8
ET9
ES9
```

检查允许 schema 中顺序不同，但集合必须完全一致。不允许新增值、删除值或改名。

## 4. 检查脚本

新增脚本：

```text
scripts/check-vehicle-model-enum-freeze.mjs
```

行为：

```text
读取 apps/api/prisma/schema.prisma
只解析 enum VehicleModel
忽略 // 与 /* */ 注释
忽略 enum attribute，例如 @@map
与冻结集合按 set 比较
输出 unexpected values / missing values / duplicate values
不连接数据库
不读取 secret
不修改任何文件
```

通过时输出：

```text
VehicleModel enum freeze check passed.
```

失败时提示：

```text
VehicleModel is frozen. Add new vehicle models through VehicleModelDefinition instead of Prisma enum.
```

## 5. Release / CI Gate

新增根命令：

```text
pnpm vehicle-model:enum-freeze
pnpm vehicle-model:enum-freeze:test
```

`pnpm release:check` 已接入：

```text
node --check scripts/check-vehicle-model-enum-freeze.mjs
pnpm vehicle-model:enum-freeze
pnpm vehicle-model:enum-freeze:test
```

GitHub CI 的 `quality-gate` job 已增加：

```text
pnpm vehicle-model:enum-freeze
```

CI 当前未直接调用 `pnpm release:check`，因此需要保留该独立 step。Docker image workflow 是手动镜像构建流程，本阶段不作为质量门禁修改。

## 6. Legacy 保留边界

本阶段不退场 enum：

```text
不删除 VehicleModel enum
不修改 Vehicle.vehicleModel 类型
不修改 VehicleModelDefinition schema
不新增 migration
不迁移历史数据
不改 Product / Portal / Reports / Residual 业务逻辑
```

`VehicleModel` 继续承担：

```text
历史 Quote / Order / Contract 快照解释
历史车辆 fallback
legacy vehicleModel 字段兼容
已有测试 fixture 兼容
```

## 7. 新车型规则

从 10X-K 起，新增车型不得修改 Prisma enum。标准做法是：

```text
进入后台 车辆资产 -> 车型代码
创建 VehicleModelDefinition
按需要配置 displayName / customerDisplayName / portalVisible / enabled
如该车型需要进入仍依赖 legacy enum 的流程，必须等待后续 enum 退场或快照治理阶段，而不是扩张 VehicleModel enum
```

## 8. 后续阶段

建议继续：

```text
Stage 10X-L: modelDefinitionId backfill dry-run / report
Stage 10X-M: enum removal feasibility review
```

10X-L 应只读扫描历史数据，输出 matched / unresolved / conflicts 统计，不写数据库。10X-M 再基于 backfill 质量和 Quote / Order snapshot 治理结果评估 enum 是否具备真正退场条件。
