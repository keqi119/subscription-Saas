# Stage 9D 主线验收冻结

本文档冻结当前 release 的主线验收范围。目标是避免继续扩展 Stage 8 增强功能导致发布主线不稳定。

## 1. 当前冻结主线

本 release 冻结以下主线：

- 客户 / 线索
- A/B 进件
- 审核
- 报价
- 订单
- 合同
- 初始账单 / 收款
- 交付
- 权益
- 月租
- 逾期催收
- 退车
- 损伤费
- 押金扣减 / 退款
- 车辆再入池
- 经营看板
- 资产经营分析
- 残值样本
- 残值曲线
- 单车残值预测
- 预测点采用
- 估值复核
- 销售价历史

验收入口以 `docs/manual-acceptance.md` 为准，场景数据以 `docs/scenario-seeds.md` 为准。

## 2. 已冻结的关键安全边界

以下边界在当前 release 中不得被破坏：

- 采用预测点不会更新车辆当前销售价。
- 发起估值复核不会更新车辆当前销售价。
- 只有估值复核审核通过才更新 `Vehicle.currentSalePriceAmount`。
- 只有估值复核审核通过才写入 `VehicleSalePriceHistory`。
- 估值复核拒绝 / 取消不写销售价历史。
- 残值敏感性 ROE 不改变主 ROE。
- scenario seed 不污染 baseline vehicle pool。
- scenario cleanup 只清理 `SCN9_` 前缀数据。
- 默认 seed 不生成复杂业务流程数据。
- 权限和菜单变更后必须重新登录刷新 JWT。

## 3. 延后范围

以下能力暂缓，不属于当前 release blocker：

- 8.5C 批量估值审批通过
- 真实 AI / ML 训练
- 自动爬虫
- 真实支付通道
- 电子签深度集成
- 短信 / 微信通知
- 批量自动调价
- 高级资金池 ROE
- 维修工单系统
- 多环境自动发布流水线
- 生产级监控告警看板

这些能力可以进入后续阶段规划，但不得阻塞当前主线发布冻结。

## 4. Release 阻断项

以下问题必须阻断 release：

- 主线 smoke 不通过。
- `pnpm release:check` 不通过。
- CI 不通过。
- migrate status 不正常。
- 默认 seed 污染复杂业务流程数据。
- scenario cleanup 误删 baseline 数据。
- 车辆销售价被预测流程自动覆盖。
- 销售价历史缺失。
- 权限菜单不一致。
- 核心发布文档缺失。
- 数据库备份不可用。
- 人工验收无法覆盖登录、进件、报价、订单、合同、账单、交付、退车、残值预测和估值复核。

## 5. Codex 后续开发边界

进入新功能开发前，必须确认 `docs/release-checklist.md` 已通过。

后续修改必须遵守：

- 任何修改 `Vehicle.currentSalePriceAmount` 的功能，必须说明触发条件、权限、审计日志和 `VehicleSalePriceHistory` 写入策略。
- 任何修改 seed 的功能，必须说明是否影响 baseline seed。
- 默认 seed 不得生成复杂验收业务数据。
- 任何新增 scenario seed 必须使用专用前缀、专用车辆并支持 cleanup。
- 任何修改权限矩阵的功能，必须同步更新 `docs/permission-matrix.md`。
- 任何修改主线验收路径的功能，必须同步更新 `docs/manual-acceptance.md`。
- 任何改动 migration 的功能，必须同步检查 `docs/deployment.md` 和 `docs/backup-restore.md`。

## 6. 当前可重复验收路径

开发 / 验收环境推荐路径：

```powershell
pnpm release:check
pnpm seed:scenario cleanup
pnpm seed:scenario mainline
pnpm seed:scenario residual
pnpm smoke:api
pnpm smoke:mainline
pnpm smoke:residual
```

生产环境不得执行 scenario seed。生产 release 应使用 `docs/release-checklist.md` 的发布顺序，并以数据库备份和 smoke 结果作为发布安全线。
