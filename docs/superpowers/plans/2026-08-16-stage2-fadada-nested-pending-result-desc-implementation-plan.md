# Stage 2 法大大嵌套待签状态解析修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复法大大查询签署结果响应中顶层 `msg=success` 遮蔽嵌套 `data.result_desc=待签署` 的问题，使客户可继续进入原有 Stage 2 签署事务。

**Architecture:** 保留通用递归字段解析器及其他法大大接口的现有优先级，仅为 `querySignResult` 增加一个“先读 `data` 容器内业务描述、缺失时再回退通用解析”的局部读取路径。API 客户端继续返回原始 `resultCode=9999`、业务描述 `待签署` 和 `status=UNKNOWN`，由现有 Stage 2 供应商映射层按严格组合 `9999 + 待签署` 转换为 `SIGNING`；不扩大白名单、不重建签署任务、不改写数据库状态。

**Tech Stack:** TypeScript、Vitest、Fastify API、法大大 HTTP 客户端、pnpm workspace

## Global Constraints

- 仅修改法大大 `querySignResult` 的业务描述读取优先级，不改变通用 `scalarField` 的递归顺序。
- 仅精确接受 `result=9999` 且 `result_desc=待签署` 的现有 Stage 2 映射规则；冲突或不完整响应继续关闭式失败。
- 继续复用现有合同、签署任务、客户签署人和供应商交易号，不创建替代事务。
- 不记录或回传完整签署地址、供应商密钥、客户供应商编号或原始响应正文。
- 不修改 Prisma schema，不新增数据库迁移，不人工回填业务状态。
- 按 Inline Execution 由主 Agent 执行，不使用子代理。

---

### Task 1: 固化真实响应回归样本并局部修正查询解析

**Files:**
- Modify: `apps/api/test/fadada-api-client.spec.ts`
- Modify: `apps/api/src/esign/fadada/fadada-api.client.ts`

**Interfaces:**
- Consumes: `FadadaApiClient.querySignResult(input)` 及现有 `scalarField`、`nestedProviderRecords` 解析能力。
- Produces: `nestedDataStringField(raw, keys): string | undefined`，仅供查询签署结果时优先提取 `data.result_desc` / `data.resultDesc`；`querySignResult` 的公开返回类型不变。

- [ ] **Step 1: 写入真实响应形态的失败测试**

在 `apps/api/test/fadada-api-client.spec.ts` 的现有 `querySignResult` 测试附近增加：

```ts
it("prefers the nested sign result description over the top-level request message", async () => {
  const transport: FadadaTransport = vi.fn(async () => ({
    bodyText: JSON.stringify({
      code: 1,
      data: {
        download_url: "https://download.example.test/file.pdf?token=secret",
        endTime: "2026-08-16 18:31:01",
        result: "9999",
        result_desc: "待签署",
        view_url: "https://view.example.test/file.pdf?token=secret"
      },
      msg: "success"
    }),
    headers: { "content-type": "application/json" },
    status: 200
  }));
  const apiClient = new FadadaApiClient(
    fadadaConfig(),
    new FadadaHttpClient(fadadaConfig(), transport)
  );

  await expect(apiClient.querySignResult({
    contractId: "CON-1",
    customerId: "fadada-customer-1",
    transactionId: "TX1"
  })).resolves.toMatchObject({
    resultCode: "9999",
    resultDesc: "待签署",
    status: "UNKNOWN"
  });
});
```

测试中的地址只用于验证解析，不能写入日志或断言失败消息之外的业务响应。

- [ ] **Step 2: 运行单测并确认按预期失败**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/fadada-api-client.spec.ts --reporter=dot
```

Expected: 新测试失败，差异明确为 `resultDesc` 实际得到顶层 `"success"`，期望为嵌套 `"待签署"`；其他既有测试保持通过。

- [ ] **Step 3: 增加仅针对 `data` 容器的字符串读取辅助函数**

在 `apps/api/src/esign/fadada/fadada-api.client.ts` 的 `stringField` 附近增加：

```ts
function nestedDataStringField(raw: unknown, keys: string[]): string | undefined {
  const record = recordField(raw);
  if (!record) {
    return undefined;
  }
  for (const data of nestedProviderRecords(record.data, 0)) {
    const nested = scalarField(data, keys);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}
```

该函数只从顶层 `data` 对象或 JSON 对象字符串开始读取，避免改变其他接口依赖的“顶层优先”通用行为。

- [ ] **Step 4: 在 `querySignResult` 中优先使用嵌套业务描述**

先计算局部业务描述：

```ts
const resultDesc =
  nestedDataStringField(raw, ["result_desc", "resultDesc"]) ??
  stringField(raw, ["result_desc", "resultDesc", "message", "msg"]);
```

再在返回对象中使用 `resultDesc`：

```ts
return {
  // 其他既有字段保持不变
  resultCode,
  resultDesc,
  status: mapQuerySignResultStatus(raw, resultCode),
  // 其他既有字段保持不变
};
```

不得修改 `providerMsg`、`scalarField`、`mapQuerySignResultStatus` 或其他法大大接口。

- [ ] **Step 5: 运行客户端解析和 Stage 2 严格映射测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/fadada-api-client.spec.ts test/stage2-esign-provider-mapping.spec.ts --reporter=dot
```

Expected: 两个文件全部通过；客户端样本返回 `resultDesc=待签署`，现有映射测试继续证明只有精确 `9999 + 待签署` 才映射为 `SIGNING`。

- [ ] **Step 6: 提交聚焦修复**

```powershell
git add apps/api/test/fadada-api-client.spec.ts apps/api/src/esign/fadada/fadada-api.client.ts
git commit -m "fix(esign): prefer nested fadada sign result description"
```

### Task 2: Stage 2 链路回归与交付检查

**Files:**
- Verify: `apps/api/src/esign/fadada/fadada-api.client.ts`
- Verify: `apps/api/test/fadada-api-client.spec.ts`
- Verify: `apps/api/test/stage2-esign-provider-mapping.spec.ts`
- Verify: `apps/api/test/stage2-handover-esign-lifecycle.spec.ts`
- Verify: `apps/api/test/stage2-handover-provider-reconciliation.spec.ts`
- Verify: `apps/api/test/portal-handover-review.spec.ts`

**Interfaces:**
- Consumes: Task 1 修正后的 `querySignResult` 返回值和既有 Stage 2 供应商映射规则。
- Produces: 可安全进入 PR/部署阶段的本地验证证据；无新的生产接口或数据结构。

- [ ] **Step 1: 运行 Stage 2 相关回归测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/fadada-api-client.spec.ts test/stage2-esign-provider-mapping.spec.ts test/stage2-handover-esign-lifecycle.spec.ts test/stage2-handover-provider-reconciliation.spec.ts test/portal-handover-review.spec.ts --reporter=dot
```

Expected: 全部通过，且没有创建新合同、新签署任务或替代供应商交易号的测试行为。

- [ ] **Step 2: 运行 API 静态检查与生产构建**

Run:

```powershell
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api build
```

Expected: 三条命令均以退出码 0 完成。

- [ ] **Step 3: 检查改动范围和空白错误**

Run:

```powershell
git diff --check origin/main...HEAD
git status --short
git diff --stat origin/main...HEAD
```

Expected: 无空白错误；相对 `origin/main` 仅包含已确认的设计文档、实施计划、API 客户端局部修复和对应测试，不包含迁移、环境配置或用户工作区文件。

- [ ] **Step 4: 记录发布后人工验收口径**

发布后继续使用原订单 `ORD20260814085019DMGZ` 和原 Stage 2 签署事务验证：

1. Portal 点击“继续签署”时，系统识别法大大原交易为“待签署”；
2. 返回同一签署事务的新入口，不创建替代合同或签署任务；
3. 60 秒服务端间隔限制继续生效；
4. 未签署退出后可再次进入，完成签署后继续推进平台盖章和归档；
5. Portal 与 Admin 不显示原始响应、完整签署地址或供应商敏感标识。

本步骤只定义验收口径；没有明确发布授权前，不推送、不创建 PR、不部署或修改 Staging 数据。
