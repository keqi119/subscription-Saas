# Stage 2 交接 PDF 模板启用修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 Admin 合同模板类型能力，通过受审计的应用接口启用 staging 车辆交接确认单模板，并恢复订单 `ORD20260726073922TFHF` 的 Stage 2 PDF 生成。

**Architecture:** 继续复用现有 `ContractVersion` 作为模板版本、生效期、启用审批和审计载体；实际 PDF 内容仍由专用渲染器生成。Web 端用一个纯表单模型统一模板类型选项和创建请求，staging 数据通过现有 Admin API 幂等补齐，不使用直接 SQL 写入。

**Tech Stack:** Next.js App Router、React、Ant Design、TypeScript、Vitest、NestJS、Prisma、Docker Compose、GitHub Actions。

## Global Constraints

- 交接 PDF 版式与内容渲染逻辑保持不变。
- `SUBSCRIPTION_STANDARD` 显示为“标准订阅合同”。
- `DELIVERY_HANDOVER` 显示为“车辆交接确认单”。
- 新增表单默认类型为 `SUBSCRIPTION_STANDARD`。
- staging 模板恢复必须通过 Admin API 创建和启用，以保留审批字段与审计日志。
- 禁止直接写入 staging 数据库。
- 禁止调用法大大、启动 Stage 2 电子签、确认交付、启动租赁或创建账单。
- 禁止修改或重建 production 容器。
- 保留现有未跟踪的 `output/`、`tmp/`，不得纳入提交。

---

### Task 1: 合同模板类型表单模型和 Admin 页面

**Files:**
- Create: `apps/web/src/lib/contract-version-form.ts`
- Create: `apps/web/test/contract-version-form.spec.ts`
- Modify: `apps/web/src/app/contract-versions/page.tsx`

**Interfaces:**
- Produces: `ContractTemplateType`
- Produces: `CONTRACT_TEMPLATE_TYPE_OPTIONS`
- Produces: `DEFAULT_CONTRACT_TEMPLATE_TYPE`
- Produces: `labelContractTemplateType(value: string): string`
- Produces: `buildContractVersionCreatePayload(input): ContractVersionCreatePayload`
- Consumes: Existing `apiFetch("/contract-versions", { method: "POST" })`

- [ ] **Step 1: 编写失败测试**

在 `apps/web/test/contract-version-form.spec.ts` 创建以下行为测试：

```ts
import { describe, expect, it } from "vitest";

import {
  buildContractVersionCreatePayload,
  CONTRACT_TEMPLATE_TYPE_OPTIONS,
  DEFAULT_CONTRACT_TEMPLATE_TYPE,
  labelContractTemplateType
} from "../src/lib/contract-version-form";

describe("contract version form", () => {
  it("defaults new versions to the standard subscription template type", () => {
    expect(DEFAULT_CONTRACT_TEMPLATE_TYPE).toBe("SUBSCRIPTION_STANDARD");
  });

  it("includes the selected delivery handover type in the create payload", () => {
    expect(buildContractVersionCreatePayload({
      contentTemplate: "车辆交接确认单",
      effectiveFrom: "2026-07-26",
      effectiveTo: undefined,
      templateName: "车辆交接确认单",
      templateType: "DELIVERY_HANDOVER",
      versionNo: "V1.0"
    })).toEqual({
      businessType: "SUBSCRIPTION",
      contentTemplate: "车辆交接确认单",
      effectiveFrom: "2026-07-26",
      effectiveTo: undefined,
      templateName: "车辆交接确认单",
      templateType: "DELIVERY_HANDOVER",
      versionNo: "V1.0"
    });
  });

  it("exposes stable Admin labels for both supported template types", () => {
    expect(CONTRACT_TEMPLATE_TYPE_OPTIONS).toEqual([
      { label: "标准订阅合同", value: "SUBSCRIPTION_STANDARD" },
      { label: "车辆交接确认单", value: "DELIVERY_HANDOVER" }
    ]);
    expect(labelContractTemplateType("DELIVERY_HANDOVER")).toBe("车辆交接确认单");
    expect(labelContractTemplateType("UNKNOWN")).toBe("UNKNOWN");
  });
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```bash
pnpm --filter @subscription-saas/web exec vitest run test/contract-version-form.spec.ts
```

Expected: FAIL，原因是 `src/lib/contract-version-form` 尚不存在。

- [ ] **Step 3: 实现最小纯表单模型**

在 `apps/web/src/lib/contract-version-form.ts` 实现：

```ts
export type ContractTemplateType =
  | "DELIVERY_HANDOVER"
  | "SUBSCRIPTION_STANDARD";

export const DEFAULT_CONTRACT_TEMPLATE_TYPE: ContractTemplateType =
  "SUBSCRIPTION_STANDARD";

export const CONTRACT_TEMPLATE_TYPE_OPTIONS = [
  { label: "标准订阅合同", value: "SUBSCRIPTION_STANDARD" },
  { label: "车辆交接确认单", value: "DELIVERY_HANDOVER" }
] as const satisfies ReadonlyArray<{
  label: string;
  value: ContractTemplateType;
}>;

export interface ContractVersionCreatePayload {
  businessType: "SUBSCRIPTION";
  contentTemplate: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  templateName: string;
  templateType: ContractTemplateType;
  versionNo: string;
}

export function buildContractVersionCreatePayload(
  input: Omit<ContractVersionCreatePayload, "businessType">
): ContractVersionCreatePayload {
  return { businessType: "SUBSCRIPTION", ...input };
}

export function labelContractTemplateType(value: string) {
  return CONTRACT_TEMPLATE_TYPE_OPTIONS.find(
    (option) => option.value === value
  )?.label ?? value;
}
```

- [ ] **Step 4: 运行聚焦测试并确认通过**

Run:

```bash
pnpm --filter @subscription-saas/web exec vitest run test/contract-version-form.spec.ts
```

Expected: 3 tests PASS。

- [ ] **Step 5: 接入 Admin 合同模板页面**

修改 `apps/web/src/app/contract-versions/page.tsx`：

```ts
import {
  buildContractVersionCreatePayload,
  CONTRACT_TEMPLATE_TYPE_OPTIONS,
  DEFAULT_CONTRACT_TEMPLATE_TYPE,
  labelContractTemplateType,
  type ContractTemplateType
} from "../../lib/contract-version-form";
```

将 `Select` 加入 Ant Design 导入；为列表行和表单值增加
`templateType: ContractTemplateType`。保存时改为：

```ts
body: JSON.stringify(buildContractVersionCreatePayload({
  contentTemplate: values.contentTemplate,
  effectiveFrom: values.effectiveFrom?.format("YYYY-MM-DD"),
  effectiveTo: values.effectiveTo?.format("YYYY-MM-DD"),
  templateName: values.templateName,
  templateType: values.templateType,
  versionNo: values.versionNo
}))
```

在表格中增加：

```ts
{
  dataIndex: "templateType",
  render: (value: string) => labelContractTemplateType(value),
  title: "模板类型",
  width: 150
}
```

在表单上设置：

```tsx
<Form
  form={form}
  initialValues={{ templateType: DEFAULT_CONTRACT_TEMPLATE_TYPE }}
  layout="vertical"
>
```

并增加必填选择器：

```tsx
<Form.Item
  label="模板类型"
  name="templateType"
  rules={[{ required: true, message: "请选择模板类型" }]}
>
  <Select options={CONTRACT_TEMPLATE_TYPE_OPTIONS.map((option) => ({ ...option }))} />
</Form.Item>
```

- [ ] **Step 6: 运行 Web 完整验证**

Run:

```bash
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web build
git diff --check
```

Expected: 全部 PASS；如 Next.js 构建改写 `apps/web/next-env.d.ts`，只还原该构建副作用。

- [ ] **Step 7: 提交代码**

```bash
git add -- apps/web/src/lib/contract-version-form.ts apps/web/test/contract-version-form.spec.ts apps/web/src/app/contract-versions/page.tsx
git commit -m "fix(web): support handover contract templates"
```

### Task 2: 幂等补齐 staging 交接确认单模板

**Files:**
- No repository file changes.

**Interfaces:**
- Consumes: `POST /api/auth/login`
- Consumes: `GET /api/contract-versions`
- Consumes: `POST /api/contract-versions`
- Consumes: `POST /api/contract-versions/:id/activate`
- Produces: Active, currently effective `DELIVERY_HANDOVER` contract version

- [ ] **Step 1: 只读确认恢复前状态**

通过 staging Admin API 查询合同版本，确认不存在当前有效的
`DELIVERY_HANDOVER` 模板。不得输出登录 Cookie 或密码。

- [ ] **Step 2: 使用应用接口执行幂等恢复**

在 staging API 容器中运行一次性 Node 脚本，凭据仅从容器环境变量
`SMOKE_ADMIN_USERNAME`、`SMOKE_ADMIN_PASSWORD` 读取。脚本必须：

```js
const desired = {
  businessType: "SUBSCRIPTION",
  contentTemplate: "车辆交接确认单",
  effectiveFrom: "2026-07-26",
  templateName: "车辆交接确认单",
  templateType: "DELIVERY_HANDOVER",
  versionNo: "V1.0"
};
```

执行顺序：

1. 登录并仅在内存中保留 Cookie。
2. 查询 `/contract-versions`。
3. 按 `templateName + versionNo` 查找目标记录。
4. 不存在时以 `DRAFT` 创建。
5. 如果同名版本的类型不是 `DELIVERY_HANDOVER`，立即失败。
6. 目标记录不是 `ACTIVE` 时调用启用接口。
7. 只输出模板 ID、类型、状态和有效期，不输出 Cookie 或其他敏感值。

Expected: 模板为 `ACTIVE`，且应用写入审批字段和审计日志。

- [ ] **Step 3: 只读验证数据库结果和审计结果**

允许使用只读 SQL 核对：

- 目标模板只有一条；
- `template_type=DELIVERY_HANDOVER`；
- `status=ACTIVE`；
- `approved_by`、`approved_at` 非空；
- 存在对应 `contract_version` CREATE/UPDATE 审计记录。

### Task 3: 评审、PR、staging Web 部署和订单 PDF 验证

**Files:**
- No additional source files unless review finds an issue.

**Interfaces:**
- Consumes: GitHub CI and `docker-images.yml`
- Consumes: staging image compose deployment
- Produces: Merged fix, deployed Web image, generated source PDF artifact

- [ ] **Step 1: 完成整分支复审**

审查 `origin/main..HEAD`，重点确认：

- 标准合同模板创建行为保持兼容；
- 交接模板类型明确进入请求；
- UI 文案和列表展示正确；
- 不包含 `output/`、`tmp/`；
- 没有 API、PDF 渲染器、法大大、交付、租赁或账单变更。

- [ ] **Step 2: 推送并创建 PR**

```bash
git push -u origin fix/handover-pdf-template-activation
```

创建 PR，说明根因、staging 配置恢复方式和验证结果；等待 `quality-gate`
通过后使用仓库现有 merge commit 策略合并。

- [ ] **Step 3: 构建 staging 镜像**

读取合并提交短 SHA 后触发：

```bash
MERGE_SHA_SHORT="$(git rev-parse --short=7 origin/main)"
gh workflow run docker-images.yml --ref main \
  -f registry=ghcr.io \
  -f namespace=keqi119 \
  -f imageTag="Staging-20260726-${MERGE_SHA_SHORT}" \
  -f apiBaseUrl=https://staging-api.subauto.keybox.cloud/api \
  -f environment=staging
```

Expected: API/Web 镜像构建成功，Web 包内 API 地址校验通过。

- [ ] **Step 4: 仅部署 staging Web**

保留当前 staging API 镜像
`ghcr.io/keqi119/subscription-api:Staging-20260726-97d2f15`。更新
`.env.staging.images` 中的 `WEB_IMAGE`，仅重建 staging `web` 服务。

部署必须：

- 先备份 staging 镜像配置；
- 在健康检查失败时自动恢复旧 Web 镜像；
- 验证 staging API/Web 均为 `healthy`；
- 验证 production API/Web 镜像未变化。

- [ ] **Step 5: 通过 Admin API 生成当前订单 PDF**

使用 staging Admin API：

```text
POST /api/handover-work-orders/a16d72dd-a2b6-44fb-a15e-d558db6fddd3/pdf
```

Expected response:

```json
{
  "status": "GENERATED",
  "workOrderId": "a16d72dd-a2b6-44fb-a15e-d558db6fddd3"
}
```

只记录安全字段：`status`、`workOrderId`、`artifactId`、`fileName`、
`fileSize`、`documentNo`。不得输出 Cookie、对象存储键或内部路径。

- [ ] **Step 6: 验证 PDF 可下载且没有后续副作用**

通过相同 Admin 会话下载：

```text
GET /api/handover-work-orders/a16d72dd-a2b6-44fb-a15e-d558db6fddd3/pdf/download
```

验证：

- HTTP 200；
- MIME 为 `application/pdf`；
- 文件头为 `%PDF-`；
- 文件大小与生成响应一致；
- `VehicleDeliveryHandover.status=SOURCE_GENERATED`；
- 未创建 Stage 2 eSign task；
- 未调用法大大；
- 未确认交付；
- 未启动租赁；
- 未创建账单；
- production 未变化。
