# Stage 10M-A 客户申请体验与资料预检查

## 目标

Stage 10M-A 聚焦客户在提交 SELF_SERVICE Application 前后的资料体验：

1. 车辆列表页主按钮改为“查看详情”，避免客户在信息不足时从列表页直接提交。
2. 新增客户资料中心，客户可提前上传审核资料。
3. 车辆详情页点击“提交审核”前执行资料完整度预检查。
4. 资料缺失时强提示，但允许客户继续提交，稍后补充。
5. 申请详情页置顶提示缺失资料，并提供补资料入口。

本阶段不改变 A 线主语义：客户动作仍是“提交审核”，提交后仍生成 `SELF_SERVICE` Application，不直接生成订单、合同、账单或支付记录。

## 客户资料中心

新增客户级资料模型：

```text
CustomerProfileMaterial
```

资料中心只允许当前登录客户管理自己的资料，上传对象走 `StorageService` 私有存储，并通过 Portal API stream 预览。

对象 key：

```text
customer-profile-materials/{customerId}/{yyyy}/{uuid}-{filename}
```

客户侧不返回：

```text
bucket
objectKey
OSS public URL
```

## 必需资料清单

第一版硬编码四项最小审核资料：

```text
ID_CARD_FRONT = 身份证人像面
ID_CARD_BACK = 身份证国徽面
DRIVER_LICENSE_FRONT = 驾驶证主页
DRIVER_LICENSE_BACK = 驾驶证副页
```

可选资料：

```text
OTHER = 其他资料
```

资料完整度接口始终返回 `canSubmit=true`，缺失资料不阻断提交。

## Portal API

新增客户资料中心 API：

```text
GET /api/portal/profile/material-requirements
GET /api/portal/profile/materials
POST /api/portal/profile/materials
PATCH /api/portal/profile/materials/:id
DELETE /api/portal/profile/materials/:id
GET /api/portal/profile/materials/:id/preview
GET /api/portal/profile/material-completeness
```

新增申请预检查 API：

```text
POST /api/portal/self-service-applications/precheck
```

预检查只校验当前车辆 / 套餐可提交性和客户资料完整度，不锁车、不创建 Application。

## 提交审核前预检查

车辆详情页点击“提交审核”时：

1. 未登录则跳转 `/portal/login?redirect=当前详情页`。
2. 已登录则调用 precheck。
3. 资料完整时直接提交。
4. 资料缺失时弹窗展示缺失项。
5. 客户可选择“去补充资料”或“继续提交，稍后补充”。

## 申请提交增强

`POST /api/portal/self-service-applications` 保持原有申请语义，并新增：

```text
materialComplete
missingMaterials
profileMaterialsAvailable
```

如果客户资料中心已有资料，提交申请后系统会复用其 `bucket/objectKey` 元数据生成申请材料文件记录，不复制 OSS 文件本体。后台申请详情的材料区可直接看到这些资料，并标记来源为“客户资料中心”。

## 申请详情提示

`GET /api/portal/applications/:id` 返回资料完整度信息。Portal 申请详情页顶部在资料缺失时显示：

```text
审核资料待补充
为加快审核，请补充以下资料：...
[去补充资料]
```

补资料入口：

```text
/portal/materials?redirect=/portal/applications/{id}
```

## 后台审核可见性

后台申请详情继续使用原申请材料区展示资料。来自资料中心的文件会显示：

```text
客户资料中心
```

预览仍走后台 API stream，不暴露 OSS public URL。

## 不做事项

本阶段不做：

```text
OCR
实名核验
驾驶证真伪校验
第三方征信
强制阻断缺资料申请
Application 审核主流程修改
订单 / 合同 / 支付 / 账单 / 权益 / 工单主逻辑修改
微信支付 Provider 修改
短信 Provider 修改
通知主逻辑修改
beta gate 关闭
unrestricted launch
production deploy
```

## 后续

Stage 10M-B 建议进入车辆保险 / 权证 / 理赔基础，覆盖交强险、商业险、保单附件、到期提醒、客户查看行驶证 / 保单，以及事故报案关联理赔。
