# Stage 2 交接 PDF 模板启用修复设计

## 背景

Staging 订单 `ORD20260726073922TFHF` 已成功完成现场交接和客户确认。随后在
Admin 端生成 PDF 时返回：

`未找到生效中的车辆交接确认单模板。`

当前工单状态为 `CUSTOMER_CONFIRMED`，车辆交接记录状态为 `DRAFT`，二者均满足
生成源 PDF 的前置条件。Staging 数据库中存在已启用的标准订阅合同模板，但不存在
同时满足以下条件的合同版本：

- `businessType=SUBSCRIPTION`
- `templateType=DELIVERY_HANDOVER`
- `status=ACTIVE`
- 当前日期处于模板有效期内

后端创建合同版本的接口已经支持 `templateType`。但是 Admin 合同模板新增表单没有
展示或提交该字段，因此通过现有页面创建的所有模板都会使用后端默认值
`SUBSCRIPTION_STANDARD`。

## 方案决策

使用现有、具备审计能力的合同模板接口，在 staging 补齐缺失的交接确认单模板；
同时修复 Admin 页面，使操作人员可以明确选择目前支持的两种模板类型。

PDF 生成过程中不得隐式创建模板，也不新增会在所有环境中自动启用法律文书模板的
数据库迁移。

## Staging 恢复

通过已认证的 staging Admin API 创建以下合同版本：

- 模板名称：`车辆交接确认单`
- 版本号：`V1.0`
- 业务类型：`SUBSCRIPTION`
- 模板类型：`DELIVERY_HANDOVER`
- 生效日期：`2026-07-26`
- 失效日期：不设置
- 初始状态：`DRAFT`

创建后调用现有启用接口，使应用正常记录 `approvedBy`、`approvedAt`、
`updatedBy` 以及审计日志。

恢复操作必须具有幂等性：

- 先查询现有模板；
- 仅在完全相同的模板名称和版本号不存在时创建；
- 仅在目标模板尚未启用时执行启用操作；
- 如果存在无法安全判断的冲突模板，则停止处理，不进行变更。

恢复过程中禁止直接写入 staging 数据库。

## Admin 页面调整

合同模板新增抽屉将进行以下调整：

- 模板类型改为必填项；
- `SUBSCRIPTION_STANDARD` 显示为“标准订阅合同”；
- `DELIVERY_HANDOVER` 显示为“车辆交接确认单”；
- 默认选择 `SUBSCRIPTION_STANDARD`，保持原有标准合同创建流程不变；
- 创建请求中明确提交 `templateType`；
- 合同模板列表增加“模板类型”列。

API 契约不需要调整，因为 `CreateContractVersionDto` 已经能够校验并保存
`templateType`。

## 异常处理

当系统不存在有效的交接确认单模板时，PDF 生成接口继续保持失败关闭，不自动绕过
模板校验。这是合同版本治理和 Stage 2 电子签就绪校验所必需的约束。

出现以下情况时，staging 模板补齐操作必须停止，且不得产生部分变更：

- Admin 登录失败；
- 当前账号缺少合同模板创建或启用权限；
- 发现无法安全处理的同名或同版本冲突记录；
- 创建或启用接口返回非预期结果。

## 测试方案

围绕纯合同版本表单模型增加 Web 回归测试：

- 默认模板类型为 `SUBSCRIPTION_STANDARD`；
- 选择车辆交接确认单后，创建请求明确包含
  `templateType=DELIVERY_HANDOVER`；
- 两种模板类型的 Admin 显示文案符合设计。

验证范围包括：

- Web 完整测试；
- Web TypeScript 类型检查；
- Web 生产构建；
- 现有 API 合同版本持久化测试；
- 现有 Stage 2 PDF 模板查询和 PDF 生成测试。

## 部署后验收

合并并部署到 staging 后执行：

1. 确认交接确认单合同版本已经通过应用接口创建并启用，且当前日期有效。
2. 确认 staging API 和 Web 容器均为健康状态。
3. 通过已认证的 Admin API，为工单
   `a16d72dd-a2b6-44fb-a15e-d558db6fddd3` 生成 Stage 2 交接 PDF。
4. 确认源 PDF 文件已持久化并且可以下载。
5. 不启动 Stage 2 电子签，不调用法大大，不确认交付，不启动租赁，不创建账单。
6. 确认 production 镜像和容器均未发生变化。

## 回滚

代码发布以原 staging 不可变 Web 镜像作为回滚版本。

PDF 成功生成后不得删除新建模板，因为生成的合同记录会引用该模板。如果在尚未生成
任何 PDF 前需要撤销启用，应通过现有停用接口处理，以保留完整审计记录。
