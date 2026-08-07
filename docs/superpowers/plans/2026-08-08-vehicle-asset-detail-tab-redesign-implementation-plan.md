# Vehicle Asset Detail Tab Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Admin 车辆资产详情从超大浮层改造成独立 URL 的六页签工作区，并交付八类内部权证、多文件支付凭证及配置单/检测报告原件复用能力。

**Architecture:** 先以增量 Prisma migration 建立车辆文档批次和商品原件绑定，再在现有 `vehicle-insurance`、`vehicle-listing`、`portal-catalog` 服务上增加窄接口。Web 侧使用与订单工作区一致的 URL 驱动导航模型，把 6000 行车辆页面按领域拆成独立组件，最后切换列表入口并删除旧详情浮层。现有车辆、销售价、保险、BaaS、商品发布、估值、折旧、资本和分润领域规则保持为权威来源。

**Tech Stack:** Next.js 16、React 19、Ant Design 6、NestJS 11、Prisma 7、PostgreSQL、Vitest 4、TypeScript 6、pnpm 11、私有对象存储。

## Global Constraints

- 批准设计：`docs/superpowers/specs/2026-08-08-vehicle-asset-detail-tab-redesign-design.zh-CN.md`。
- 执行方式遵循用户已确认偏好：主 agent 使用 Inline Execution，不使用子代理。
- 一级页签固定为车辆概览、权证资料、保险与电池、商品展示、估值与折旧、资本与分润。
- `/vehicles` 只保留“车辆列表”和“待销售价复核”；销售价历史只在单车详情展示。
- 八类权证全部强制 `customerVisible=false`；保险保单附件继续使用现有可见性规则。
- 商品原件只允许 `VEHICLE_CONFIGURATION_SHEET` 和 `VEHICLE_INSPECTION_REPORT` 的 JPEG/PNG/WebP；PDF 只在 Admin 内部使用。
- 原件绑定保存精确 `documentId`，不复制对象；上传新版本不自动改绑；被引用文件解除绑定前不可归档或删除。
- 车辆采购支付凭证支持同批多个文件和后续追加；单批最多 20 个文件。
- 不新增采购审批、付款、保险理赔、BaaS、估值、折旧、融资、分润或正式结算流程。
- 使用增量 migration，不修改历史 migration，不运行 `prisma migrate reset`。
- 每个行为改动执行 RED → GREEN → REFACTOR，并在任务边界独立提交。
- 每个任务开始先运行 `git status --short --branch`、`pnpm prisma:migrate:status`、`pnpm prisma:validate`；存在非本任务重叠改动或待执行 migration 时先停止并核对。
- 保留工作区内既有 `.superpowers/`、`apps/api/tmp/`、`output/`、`tmp/` 等未跟踪内容，不纳入功能提交。
- Staging 验收车辆固定使用 `VEH20260731152647G5GV`；微信模板审批不阻塞本功能独立验收，但最终 Golden Path 合并验收仍等待模板可用。

## File Responsibility Map

### API persistence and contracts

- `apps/api/prisma/schema.prisma`: 新文档类型、文档批次、商品原件绑定及关系。
- `apps/api/prisma/migrations/20260808010000_vehicle_document_workspace/migration.sql`: 只增量创建枚举值、表、索引、外键和历史批次回填。
- `apps/api/src/vehicle-insurance/vehicle-document-policy.ts`: 内部权证类型、追加型类型、文件数量和可见性规则。
- `apps/api/src/vehicle-insurance/*`: 权证批次上传、列表、归档和引用保护。
- `apps/api/src/vehicle/vehicle-listing.service.ts`: Admin 商品原件绑定的校验和维护。
- `apps/api/src/portal/portal-catalog.service.ts`: Portal 商品原件投影、访问控制和流式预览。

### Web workspace

- `apps/web/src/lib/admin-vehicle-workspace.ts`: 一级/二级导航、URL、权限和动作纯函数。
- `apps/web/src/components/vehicle-workspace/vehicle-workspace-types.ts`: 车辆工作区共享响应类型。
- `apps/web/src/components/vehicle-workspace/vehicle-workspace.tsx`: 六个一级页签的布局壳。
- `apps/web/src/components/vehicle-workspace/vehicle-workspace-header.tsx`: 共享车辆摘要头。
- `apps/web/src/components/vehicle-workspace/vehicle-detail-actions.tsx`: 编辑、状态和销售价动作及模态框。
- `apps/web/src/components/vehicle-workspace/vehicle-*-tab.tsx`: 每个一级页签自己的数据、表单和错误边界。
- `apps/web/src/app/vehicles/[id]/page.tsx`: 只负责路由、车辆摘要加载、URL 状态和页签组合。
- `apps/web/src/app/vehicles/page.tsx`: 只负责列表、待复核队列、新增车辆和详情导航。
- `apps/web/src/app/portal/catalog/[id]/page.tsx`: 客户商品页的配置单/检测报告原件长图展示。

### Tests

- API：schema、vehicle-insurance、vehicle-listing、portal-catalog focused Vitest suites。
- Web：纯导航/视图模型测试和现有约定使用的源码结构测试。
- Final gate：Prisma validate/generate、API/Web lint/typecheck/test/build，加 Staging 手工验收。

## Specification Coverage Matrix

| Approved requirement | Implementation tasks |
| --- | --- |
| 独立详情 URL、一级/二级导航、权限回退、返回列表状态 | Tasks 5、6、12、13 |
| 六个一级页签及已确认二级分类 | Tasks 6–12 |
| 八类内部权证、其他材料兼容、完整度 | Tasks 1、2、7 |
| 合同/车主信息/支付凭证多文件批次与追加 | Tasks 1、2、7 |
| 配置单/检测报告精确原件绑定、显式预览确认、引用保护 | Tasks 1、3、7、9 |
| Portal 受控长图、车况唯一优先级、失效隔离 | Tasks 4、14 |
| 保险/BaaS、估值/折旧、资本/分润规则不变 | Tasks 8、10、11 |
| 首屏轻量、页签懒加载/会话缓存、并发请求隔离、局部重试 | Tasks 6、9–12、14 |
| 列表仅保留车辆与待复核，历史归单车，操作列仅详情 | Task 13 |
| 自动化回归、同提交镜像、Staging 验收、Golden Path 暂缓边界 | Task 15 |

---

### Task 1: Document batch and listing source binding schema

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260808010000_vehicle_document_workspace/migration.sql`
- Modify: `apps/web/src/constants/labels.ts`
- Create: `apps/api/test/vehicle-document-workspace-schema.spec.ts`

**Interfaces:**

- Consumes: existing `Vehicle`, `VehicleDocument`, `VehicleDocumentType`, and PostgreSQL enum/migration conventions.
- Produces: `VehicleDocumentBatch`, `VehicleListingSourceBinding`, `VehicleListingSourceSection`, seven additional `VehicleDocumentType` values, and `VehicleDocument.batchId`.

- [x] **Step 1: Write the failing schema contract test**

Create `apps/api/test/vehicle-document-workspace-schema.spec.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("vehicle document workspace schema", () => {
  const schema = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
  const labels = fs.readFileSync(path.resolve(__dirname, "../../web/src/constants/labels.ts"), "utf8");
  const migration = fs.readFileSync(
    path.resolve(__dirname, "../prisma/migrations/20260808010000_vehicle_document_workspace/migration.sql"),
    "utf8"
  );

  it.each([
    "VEHICLE_REGISTRATION_CERTIFICATE",
    "VEHICLE_INSPECTION_REPORT",
    "VEHICLE_PURCHASE_AGREEMENT",
    "MOTOR_VEHICLE_INVOICE",
    "OWNER_IDENTITY_DOCUMENT",
    "VEHICLE_CONFIGURATION_SHEET",
    "PURCHASE_PAYMENT_VOUCHER"
  ])("defines and labels %s", (value) => {
    expect(schema).toContain(value);
    expect(migration).toContain(`'${value}'`);
    expect(labels).toContain(value);
  });

  it("defines document batches and exact listing source bindings", () => {
    expect(schema).toMatch(/model VehicleDocumentBatch[\s\S]*versionNo\s+Int/);
    expect(schema).toMatch(/model VehicleListingSourceBinding[\s\S]*documentId\s+String/);
    expect(schema).toContain("@@unique([vehicleId, documentType, versionNo])");
    expect(schema).toContain("@@unique([vehicleId, section])");
    expect(migration).toContain('CREATE TABLE "vehicle_document_batch"');
    expect(migration).toContain('CREATE TABLE "vehicle_listing_source_binding"');
  });
});
```

- [x] **Step 2: Run the schema test and confirm RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-document-workspace-schema.spec.ts
```

Expected: FAIL because the migration, models, enums, and labels do not exist.

- [x] **Step 3: Add the Prisma models and relations**

Add the seven missing values to `VehicleDocumentType`, add:

```prisma
enum VehicleListingSourceSection {
  CONFIGURATION_SHEET
  CONDITION_REPORT

  @@map("vehicle_listing_source_section")
}

model VehicleDocumentBatch {
  id           String              @id @default(uuid()) @db.Uuid
  vehicleId    String              @map("vehicle_id") @db.Uuid
  vehicle      Vehicle             @relation(fields: [vehicleId], references: [id])
  documentType VehicleDocumentType @map("document_type")
  versionNo    Int                 @map("version_no")
  createdAt    DateTime            @default(now()) @map("created_at") @db.Timestamptz(6)
  uploadedBy   String?             @map("uploaded_by") @db.Uuid
  documents    VehicleDocument[]

  @@unique([vehicleId, documentType, versionNo])
  @@index([vehicleId, createdAt])
  @@map("vehicle_document_batch")
}

model VehicleListingSourceBinding {
  id         String                      @id @default(uuid()) @db.Uuid
  vehicleId  String                      @map("vehicle_id") @db.Uuid
  vehicle    Vehicle                     @relation(fields: [vehicleId], references: [id])
  section    VehicleListingSourceSection
  documentId String                      @map("document_id") @db.Uuid
  document   VehicleDocument             @relation(fields: [documentId], references: [id], onDelete: Restrict)
  createdAt  DateTime                    @default(now()) @map("created_at") @db.Timestamptz(6)
  createdBy  String?                     @map("created_by") @db.Uuid
  updatedAt  DateTime                    @updatedAt @map("updated_at") @db.Timestamptz(6)
  updatedBy  String?                     @map("updated_by") @db.Uuid

  @@unique([vehicleId, section])
  @@index([documentId])
  @@map("vehicle_listing_source_binding")
}
```

Add nullable `batchId` and relations on `VehicleDocument`, and matching collection relations on `Vehicle`.

- [x] **Step 4: Write the incremental migration and legacy backfill**

The migration must add enum values with `IF NOT EXISTS`, create the two tables and backfill every legacy file as a one-file batch whose batch UUID equals the legacy document UUID:

```sql
ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'VEHICLE_REGISTRATION_CERTIFICATE';
ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'VEHICLE_INSPECTION_REPORT';
ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'VEHICLE_PURCHASE_AGREEMENT';
ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'MOTOR_VEHICLE_INVOICE';
ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'OWNER_IDENTITY_DOCUMENT';
ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'VEHICLE_CONFIGURATION_SHEET';
ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'PURCHASE_PAYMENT_VOUCHER';

WITH ranked AS (
  SELECT id, vehicle_id, document_type, created_at, uploaded_by,
         ROW_NUMBER() OVER (PARTITION BY vehicle_id, document_type ORDER BY created_at, id)::INTEGER AS version_no
  FROM "vehicle_document"
  WHERE deleted_at IS NULL
)
INSERT INTO "vehicle_document_batch" (id, vehicle_id, document_type, version_no, created_at, uploaded_by)
SELECT id, vehicle_id, document_type, version_no, created_at, uploaded_by
FROM ranked;

UPDATE "vehicle_document"
SET "batch_id" = id
WHERE "batch_id" IS NULL AND "deleted_at" IS NULL;
```

Add guarded foreign keys and indexes after the backfill. Do not alter deleted legacy rows beyond leaving `batch_id` nullable.

- [x] **Step 5: Add exact Chinese labels**

Extend `VEHICLE_DOCUMENT_TYPE_LABELS` with:

```ts
MOTOR_VEHICLE_INVOICE: "机动车发票",
OWNER_IDENTITY_DOCUMENT: "车主信息",
PURCHASE_PAYMENT_VOUCHER: "车辆采购支付凭证",
VEHICLE_CONFIGURATION_SHEET: "车辆配置单",
VEHICLE_INSPECTION_REPORT: "车辆检测报告",
VEHICLE_PURCHASE_AGREEMENT: "车辆购买合同及附属协议",
VEHICLE_REGISTRATION_CERTIFICATE: "机动车登记证"
```

- [x] **Step 6: Validate schema and confirm GREEN**

Run:

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-document-workspace-schema.spec.ts
```

Expected: Prisma validates/generates and the focused test PASSes.

- [x] **Step 7: Commit the persistence boundary**

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260808010000_vehicle_document_workspace/migration.sql apps/web/src/constants/labels.ts apps/api/test/vehicle-document-workspace-schema.spec.ts
git commit -m "feat: add vehicle document workspace schema"
```

### Task 2: Multi-file vehicle document batch API

**Files:**

- Create: `apps/api/src/vehicle-insurance/vehicle-document-policy.ts`
- Modify: `apps/api/src/vehicle-insurance/dto/vehicle-insurance.dto.ts`
- Modify: `apps/api/src/vehicle-insurance/vehicle-insurance.controller.ts`
- Modify: `apps/api/src/vehicle-insurance/vehicle-insurance.service.ts`
- Modify: `apps/api/test/vehicle-insurance.spec.ts`

**Interfaces:**

- Consumes: Task 1 `VehicleDocumentBatch` and new document types; existing `StorageService.putVehicleDocument/deleteObject`.
- Produces:

```ts
export const INTERNAL_RIGHTS_DOCUMENT_TYPES: ReadonlySet<VehicleDocumentType>;
export const MAX_VEHICLE_DOCUMENT_BATCH_FILES = 20;

export interface VehicleDocumentBatchView {
  id: string;
  vehicleId: string;
  documentType: VehicleDocumentType;
  versionNo: number;
  createdAt: Date;
  items: VehicleDocumentView[];
}

listDocumentBatches(vehicleId: string): Promise<VehicleDocumentBatchView[]>;
uploadDocumentBatch(vehicleId: string, dto: UploadVehicleDocumentBatchDto, files: UploadedVehicleDocumentFile[] | undefined, user: RequestUser): Promise<VehicleDocumentBatchView>;
archiveDocumentBatch(batchId: string): Promise<VehicleDocumentBatchView>;
```

- [x] **Step 1: Write failing policy and batch tests**

Extend `vehicle-insurance.spec.ts` with tests that prove internal visibility, two-file upload, additive payment vouchers, and cleanup:

```ts
it("rejects customer-visible internal rights documents", async () => {
  const { service, user } = createHarness();
  await expect(
    service.uploadDocumentBatch(
      "vehicle-1",
      { customerVisible: true, documentType: VehicleDocumentType.VEHICLE_LICENSE },
      [uploadFile("license.jpg", "image/jpeg")],
      user
    )
  ).rejects.toBeInstanceOf(BadRequestException);
});

it("stores multiple purchase payment receipts in one versioned batch", async () => {
  const { prisma, service, user } = createHarness();
  const result = await service.uploadDocumentBatch(
    "vehicle-1",
    { documentType: VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER },
    [uploadFile("receipt-1.pdf", "application/pdf"), uploadFile("receipt-2.jpg", "image/jpeg")],
    user
  );
  expect(result.items).toHaveLength(2);
  expect(result.versionNo).toBe(1);
  expect(prisma.vehicleDocument.create).toHaveBeenCalledTimes(2);
});

it.each([
  VehicleDocumentType.VEHICLE_PURCHASE_AGREEMENT,
  VehicleDocumentType.OWNER_IDENTITY_DOCUMENT,
  VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER
])("accepts multiple files for %s", async (documentType) => {
  const { service, user } = createHarness();
  const result = await service.uploadDocumentBatch(
    "vehicle-1",
    { documentType },
    [uploadFile("part-1.pdf", "application/pdf"), uploadFile("part-2.jpg", "image/jpeg")],
    user
  );
  expect(result.items).toHaveLength(2);
});

it("deletes already stored objects when a later file upload fails", async () => {
  const { service, storageService, user } = createHarness();
  storageService.putVehicleDocument
    .mockResolvedValueOnce(storedDocument("receipt-1.pdf"))
    .mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(
    service.uploadDocumentBatch(
      "vehicle-1",
      { documentType: VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER },
      [uploadFile("receipt-1.pdf", "application/pdf"), uploadFile("receipt-2.pdf", "application/pdf")],
      user
    )
  ).rejects.toThrow("storage unavailable");
  expect(storageService.deleteObject).toHaveBeenCalledTimes(1);
});
```

Change the existing positive `customerVisible=true` test to use `COMMERCIAL_INSURANCE_POLICY`, proving insurance documents keep the old behavior.

- [x] **Step 2: Run the focused test and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-insurance.spec.ts
```

Expected: FAIL because policy helpers and batch methods do not exist.

- [x] **Step 3: Implement deterministic document policy helpers**

Create `vehicle-document-policy.ts`:

```ts
export const INTERNAL_RIGHTS_DOCUMENT_TYPES = new Set<VehicleDocumentType>([
  VehicleDocumentType.VEHICLE_REGISTRATION_CERTIFICATE,
  VehicleDocumentType.VEHICLE_LICENSE,
  VehicleDocumentType.VEHICLE_INSPECTION_REPORT,
  VehicleDocumentType.VEHICLE_PURCHASE_AGREEMENT,
  VehicleDocumentType.MOTOR_VEHICLE_INVOICE,
  VehicleDocumentType.OWNER_IDENTITY_DOCUMENT,
  VehicleDocumentType.VEHICLE_CONFIGURATION_SHEET,
  VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER
]);

export const ADDITIVE_DOCUMENT_TYPES = new Set<VehicleDocumentType>([
  VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER
]);

export function assertVehicleDocumentVisibility(type: VehicleDocumentType, customerVisible?: boolean) {
  if (INTERNAL_RIGHTS_DOCUMENT_TYPES.has(type) && customerVisible) {
    throw new BadRequestException("internal vehicle rights documents cannot be customer visible");
  }
}
```

- [x] **Step 4: Add batch DTO and controller routes**

Add `UploadVehicleDocumentBatchDto` with the same metadata as `UploadVehicleDocumentDto`. Expose:

```ts
@Get("vehicles/:id/document-batches")
@RequirePermissions(PermissionCode.VEHICLE_DOCUMENT_VIEW)
listDocumentBatches(@Param("id") id: string) { ... }

@Post("vehicles/:id/document-batches")
@RequirePermissions(PermissionCode.VEHICLE_DOCUMENT_MANAGE)
@UseInterceptors(AnyFilesInterceptor())
uploadDocumentBatch(...) { ... }

@Post("vehicle-document-batches/:batchId/archive")
@RequirePermissions(PermissionCode.VEHICLE_DOCUMENT_MANAGE)
archiveDocumentBatch(@Param("batchId") batchId: string) { ... }
```

- [x] **Step 5: Implement atomic multi-file upload and version retry**

Validate all files before storage, reject zero or more than 20 files, upload all objects, then create one batch plus N document rows in a transaction. Assign `max(versionNo)+1`; retry a Prisma `P2002` batch-version collision up to three times. On storage or database failure call `deleteObject(bucket, objectKey)` for every newly stored object with `Promise.allSettled`, record cleanup failures through the existing logger without exposing storage identifiers, then rethrow the original error.

For all eight rights types, persist `customerVisible=false` even when the field is omitted or explicitly false; reject true with 400. The returned view must omit bucket/objectKey and include existing Admin preview URLs. `uploadDocument` must call the same visibility assertion and normalization so the legacy endpoint cannot publish internal rights documents. `archiveDocumentBatch` must soft-archive its active item rows in one transaction and must not delete stored objects; existing individual-file update/delete paths remain soft operations.

- [x] **Step 6: Run focused tests, lint, and typecheck**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-insurance.spec.ts
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api typecheck
```

Expected: focused tests, lint, and typecheck PASS.

- [x] **Step 7: Commit the batch API**

```powershell
git add apps/api/src/vehicle-insurance apps/api/test/vehicle-insurance.spec.ts
git commit -m "feat: add multi-file vehicle document batches"
```

### Task 3: Admin listing source bindings and archive protection

**Files:**

- Modify: `apps/api/src/vehicle/dto/vehicle-listing.dto.ts`
- Modify: `apps/api/src/vehicle/vehicle-listing.controller.ts`
- Modify: `apps/api/src/vehicle/vehicle-listing.service.ts`
- Modify: `apps/api/src/vehicle-insurance/vehicle-insurance.service.ts`
- Modify: `apps/api/test/vehicle-listing.spec.ts`
- Modify: `apps/api/test/vehicle-insurance.spec.ts`

**Interfaces:**

- Consumes: Task 1 binding model; Task 2 document batch/list/archive service.
- Produces:

```ts
export interface VehicleListingSourceBindingView {
  id: string;
  vehicleId: string;
  section: VehicleListingSourceSection;
  document: {
    id: string;
    documentType: VehicleDocumentType;
    fileName: string;
    mimeType: string | null;
    versionNo: number | null;
    previewUrl: string;
  };
}

listSourceBindings(vehicleId: string): Promise<VehicleListingSourceBindingView[]>;
putSourceBinding(vehicleId: string, section: VehicleListingSourceSection, documentId: string, user: RequestUser): Promise<VehicleListingSourceBindingView>;
deleteSourceBinding(vehicleId: string, section: VehicleListingSourceSection): Promise<void>;
```

- [x] **Step 1: Write failing binding validation tests**

Add to `vehicle-listing.spec.ts`:

```ts
it("binds an exact configuration sheet image from the same vehicle", async () => {
  const { prisma, service, user } = createHarness();
  prisma.vehicleDocument.findFirst.mockResolvedValueOnce(
    sourceDocument({ documentType: VehicleDocumentType.VEHICLE_CONFIGURATION_SHEET })
  );
  const result = await service.putSourceBinding(
    "vehicle-1",
    VehicleListingSourceSection.CONFIGURATION_SHEET,
    "document-1",
    user
  );
  expect(result.document.id).toBe("document-1");
  expect(prisma.vehicleListingSourceBinding.upsert).toHaveBeenCalledWith(
    expect.objectContaining({ where: { vehicleId_section: { vehicleId: "vehicle-1", section: "CONFIGURATION_SHEET" } } })
  );
});

it.each([
  ["application/pdf", VehicleDocumentType.VEHICLE_CONFIGURATION_SHEET],
  ["image/jpeg", VehicleDocumentType.MOTOR_VEHICLE_INVOICE]
])("rejects an incompatible source document", async (mimeType, documentType) => {
  const { prisma, service, user } = createHarness();
  prisma.vehicleDocument.findFirst.mockResolvedValueOnce(sourceDocument({ mimeType, documentType }));
  await expect(
    service.putSourceBinding("vehicle-1", VehicleListingSourceSection.CONFIGURATION_SHEET, "document-1", user)
  ).rejects.toBeInstanceOf(BadRequestException);
});
```

Add to `vehicle-insurance.spec.ts` a test that `deleteDocument` and `archiveDocumentBatch` reject with `ConflictException` when `vehicleListingSourceBinding.findFirst` returns a binding.

- [x] **Step 2: Run tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-listing.spec.ts test/vehicle-insurance.spec.ts
```

Expected: FAIL because binding APIs and archive protection do not exist.

- [x] **Step 3: Add DTO and exact section-to-type mapping**

Add `PutVehicleListingSourceBindingDto` with `@IsUUID()` `documentId`. In the service define:

```ts
const SOURCE_DOCUMENT_TYPE_BY_SECTION = {
  [VehicleListingSourceSection.CONFIGURATION_SHEET]: VehicleDocumentType.VEHICLE_CONFIGURATION_SHEET,
  [VehicleListingSourceSection.CONDITION_REPORT]: VehicleDocumentType.VEHICLE_INSPECTION_REPORT
} satisfies Record<VehicleListingSourceSection, VehicleDocumentType>;

const PRODUCT_SOURCE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
```

- [x] **Step 4: Implement Admin binding methods and routes**

Expose `GET /vehicles/:id/listing-source-bindings` under `PermissionCode.VEHICLE_VIEW` and `PUT/DELETE /vehicles/:id/listing-source-bindings/:section` under `PermissionCode.VEHICLE_MANAGE`, matching the existing listing routes. `putSourceBinding` must query a non-deleted, `ACTIVE` document belonging to the same vehicle; validate exact type and MIME before upserting `(vehicleId, section)` so a rejected request cannot disturb the previous binding. The view must expose only document metadata and `/api/vehicle-documents/:id/preview`.

- [x] **Step 5: Protect every archive/delete path**

Before soft-deleting a document or archiving a batch, query bindings for all affected document IDs. Throw:

```ts
throw new ConflictException({
  code: "VEHICLE_DOCUMENT_SOURCE_BOUND",
  message: "该原件正在商品展示中使用，请先解除绑定"
});
```

Apply the check to the new batch archive and legacy `PATCH/DELETE /vehicle-documents/:id` paths so callers cannot bypass protection.

- [x] **Step 6: Run focused tests and typecheck**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-listing.spec.ts test/vehicle-insurance.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: binding and conflict tests PASS; typecheck PASSes.

- [x] **Step 7: Commit source binding administration**

```powershell
git add apps/api/src/vehicle apps/api/src/vehicle-insurance/vehicle-insurance.service.ts apps/api/test/vehicle-listing.spec.ts apps/api/test/vehicle-insurance.spec.ts
git commit -m "feat: bind listing sections to vehicle documents"
```

### Task 4: Portal source document projection and controlled preview

**Files:**

- Modify: `apps/api/src/portal/portal-catalog.controller.ts`
- Modify: `apps/api/src/portal/portal-catalog.service.ts`
- Modify: `apps/api/test/portal-catalog.spec.ts`

**Interfaces:**

- Consumes: Task 3 exact source bindings and existing `StorageService.getVehicleDocumentStream`.
- Produces:

```ts
export interface PortalCatalogSourceDocument {
  section: "CONFIGURATION_SHEET" | "CONDITION_REPORT";
  title: string;
  previewUrl: string;
}

sourceDocuments: {
  configurationSheet: PortalCatalogSourceDocument | null;
  conditionReport: PortalCatalogSourceDocument | null;
};
conditionDisplayMode: "SOURCE_DOCUMENT" | "STRUCTURED_REPORT" | "NONE";

export interface PortalSourceDocumentPreview {
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
  stream: DownloadObjectResult["stream"];
}

previewSourceDocument(vehicleId: string, section: VehicleListingSourceSection): Promise<PortalSourceDocumentPreview>;
```

- [x] **Step 1: Write failing Portal security and precedence tests**

Extend `portal-catalog.spec.ts`:

```ts
it("projects bound source images without private storage fields", async () => {
  const vehicle = createVehicle({ sourceBindings: [configurationBinding(), conditionBinding()] });
  const { service } = createHarness({ vehicle });
  const detail = await service.getVehicle("vehicle-1");
  expect(detail.sourceDocuments.configurationSheet?.previewUrl).toBe(
    "/api/portal/catalog/vehicles/vehicle-1/source-documents/CONFIGURATION_SHEET/preview"
  );
  expect(detail.conditionDisplayMode).toBe("SOURCE_DOCUMENT");
  expect(JSON.stringify(detail.sourceDocuments)).not.toContain("private-bucket");
});

it("falls back to the published structured report without a valid condition binding", async () => {
  const { service } = createHarness({ vehicle: createVehicle({ sourceBindings: [] }) });
  const detail = await service.getVehicle("vehicle-1");
  expect(detail.conditionDisplayMode).toBe("STRUCTURED_REPORT");
});

it("fails closed when a source preview is not bound to a published visible listing", async () => {
  const { service } = createHarness({ vehicle: createVehicle({ portalVisible: false }) });
  await expect(
    service.previewSourceDocument("vehicle-1", VehicleListingSourceSection.CONDITION_REPORT)
  ).rejects.toBeInstanceOf(NotFoundException);
});
```

- [x] **Step 2: Run Portal tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-catalog.spec.ts
```

Expected: FAIL because source projection, display mode, and preview method do not exist.

- [x] **Step 3: Extend the Portal vehicle query and projection**

Include non-deleted binding documents in the existing catalog vehicle query. A source is valid only when the binding section/type match, document status is `ACTIVE`, MIME is an allowed image, and storage fields exist. Return controlled URLs only. Set `conditionDisplayMode` to `SOURCE_DOCUMENT` when a valid condition binding exists; otherwise use `STRUCTURED_REPORT` only when the existing published structured report is available, else `NONE`.

- [x] **Step 4: Add controlled streaming endpoint**

Add:

```ts
@Get("vehicles/:id/source-documents/:section/preview")
async previewSourceDocument(
  @Param("id") id: string,
  @Param("section", new ParseEnumPipe(VehicleListingSourceSection, {
    exceptionFactory: () => new NotFoundException()
  })) section: VehicleListingSourceSection,
  @Res({ passthrough: true }) response: Response
) { ... }
```

The service must repeat publication, Portal visibility, vehicle ownership, type, status, MIME, and binding checks on every request before streaming the private object. Use `NotFoundException` for every unauthorized/missing combination to avoid existence disclosure.

- [x] **Step 5: Run focused and regression tests**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-catalog.spec.ts test/vehicle-listing.spec.ts test/vehicle-insurance.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: all focused tests and typecheck PASS.

- [x] **Step 6: Commit the Portal source boundary**

```powershell
git add apps/api/src/portal/portal-catalog.controller.ts apps/api/src/portal/portal-catalog.service.ts apps/api/test/portal-catalog.spec.ts
git commit -m "feat: expose controlled vehicle source documents"
```

### Task 5: URL-driven workspace navigation and permission model

**Files:**

- Create: `apps/web/src/lib/admin-vehicle-workspace.ts`
- Create: `apps/web/test/admin-vehicle-workspace.spec.ts`

**Interfaces:**

- Consumes: current Admin permission strings and Next.js search parameters.
- Produces:

```ts
export const VEHICLE_WORKSPACE_TAB_KEYS = [
  "overview",
  "documents",
  "insurance-battery",
  "listing",
  "valuation",
  "capital"
] as const;

export const VEHICLE_LISTING_SECTION_KEYS = [
  "overview",
  "copy",
  "source-media",
  "plans",
  "condition-report"
] as const;

export const VEHICLE_VALUATION_SECTION_KEYS = [
  "overview",
  "residual",
  "reviews",
  "sale-price-history",
  "depreciation"
] as const;

export const VEHICLE_CAPITAL_SECTION_KEYS = [
  "overview",
  "events",
  "allocations",
  "revenue-rules",
  "revenue-preview"
] as const;

export function parseVehicleWorkspaceLocation(
  searchParams: URLSearchParams,
  visibleTabs: readonly VehicleWorkspaceTabKey[]
): VehicleWorkspaceLocation;

export function buildVehicleWorkspaceHref(input: {
  vehicleId: string;
  tab: VehicleWorkspaceTabKey;
  section?: string;
}): string;
```

- [ ] **Step 1: Write failing navigation and permission tests**

Create `admin-vehicle-workspace.spec.ts` with table-driven tests:

```ts
it("builds a stable vehicle workspace URL", () => {
  expect(buildVehicleWorkspaceHref({
    vehicleId: "vehicle/1",
    tab: "listing",
    section: "source-media"
  })).toBe("/vehicles/vehicle%2F1?tab=listing&section=source-media");
});

it("normalizes unknown or unauthorized state to the first visible tab", () => {
  const visibleTabs = ["overview", "documents"] as const;
  expect(parseVehicleWorkspaceLocation(
    new URLSearchParams("tab=capital&section=unknown"),
    visibleTabs
  )).toEqual({ tab: "overview" });
});

it("keeps a valid secondary section only for its owning tab", () => {
  expect(parseVehicleWorkspaceLocation(
    new URLSearchParams("tab=valuation&section=sale-price-history"),
    VEHICLE_WORKSPACE_TAB_KEYS
  )).toEqual({ tab: "valuation", section: "sale-price-history" });
});
```

Add permission fixtures proving that a user sees only tabs for which the current permission map grants view access; `overview` still requires vehicle read permission and is not a blanket fallback for an unauthorized vehicle.

- [ ] **Step 2: Run the web test and confirm RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/admin-vehicle-workspace.spec.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure navigation model**

Implement typed tab/section constants, `is*Key` guards, permission-to-visible-tab mapping, parsing, and URL building. Unknown query values must be discarded. When a valid tab has no valid `section`, select that tab's documented default section without emitting redundant query state. Preserve no unrelated query parameters.

- [ ] **Step 4: Run tests and typecheck**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/admin-vehicle-workspace.spec.ts
pnpm --filter @subscription-saas/web typecheck
```

Expected: navigation tests and typecheck PASS.

- [ ] **Step 5: Commit the navigation model**

```powershell
git add apps/web/src/lib/admin-vehicle-workspace.ts apps/web/test/admin-vehicle-workspace.spec.ts
git commit -m "feat: define vehicle workspace navigation"
```

### Task 6: Shared vehicle workspace shell, header, and overview tab

**Files:**

- Create: `apps/web/src/components/vehicle-workspace/vehicle-workspace-types.ts`
- Create: `apps/web/src/components/vehicle-workspace/vehicle-workspace.tsx`
- Create: `apps/web/src/components/vehicle-workspace/vehicle-workspace-header.tsx`
- Create: `apps/web/src/components/vehicle-workspace/vehicle-overview-tab.tsx`
- Create: `apps/web/test/vehicle-workspace-shell.spec.tsx`

**Interfaces:**

```ts
export interface VehicleInsuranceCoverageSummary {
  covered: boolean;
  evaluatedAt: string;
  compulsoryTraffic: { covered: boolean; effectiveFrom: string | null; effectiveTo: string | null };
  commercial: { covered: boolean; effectiveFrom: string | null; effectiveTo: string | null };
}

export interface VehicleWorkspaceVehicle {
  id: string;
  vehicleNo: string;
  vin: string | null;
  plateNo: string | null;
  brand: string;
  series: string | null;
  model: string | null;
  modelDisplayName: string | null;
  modelYear: number | null;
  status: string;
  acquisitionMode: string | null;
  currentMileageKm: number;
  currentSalePriceAmount: number | null;
  salePriceStatus: string;
  nextSalePriceReviewAt: string | null;
  insuranceCoverage: VehicleInsuranceCoverageSummary;
  batteryCapacityKwh: number | null;
  batteryUsageType: string | null;
  registrationDate: string | null;
  latestRegistrationDate: string | null;
  purchaseDate: string | null;
  assetLocation: string | null;
  updatedAt: string;
}

export interface VehicleWorkspaceTabProps {
  vehicle: VehicleWorkspaceVehicle;
  permissions: ReadonlySet<string>;
  onVehicleChanged: () => Promise<void>;
}
```

- [ ] **Step 1: Write failing render tests**

Use `renderToStaticMarkup` in `vehicle-workspace-shell.spec.tsx` to verify:

```ts
it("renders the vehicle identity and only visible primary tabs", () => {
  const html = renderToStaticMarkup(
    <VehicleWorkspace
      vehicle={vehicleFixture}
      activeTab="overview"
      visibleTabs={["overview", "documents"]}
      onTabChange={() => undefined}
    >
      <VehicleOverviewTab {...tabProps} />
    </VehicleWorkspace>
  );
  expect(html).toContain("VEH20260731152647G5GV");
  expect(html).toContain("车辆概览");
  expect(html).toContain("权证资料");
  expect(html).not.toContain("资本与分润");
});
```

Also assert that the overview contains current status/mileage/insurance coverage/next price review, identity and registration fields, battery basics, current order/lease/listing links, recent status or mileage events, and shortcuts to the other permitted tabs. It must contain no rights-document upload, insurance policy form, listing source binding, valuation action, or revenue-share action.

- [ ] **Step 2: Run the shell test and confirm RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-workspace-shell.spec.tsx
```

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement shared responsive shell and header**

Build an Ant Design page shell with breadcrumb/back-to-list link, vehicle number/VIN/license/status, brand/series/model, current sale price and price status in a sticky summary header, a right-side action slot, and the six primary tab labels supplied by Task 5. On narrow screens, keep the tab bar horizontally scrollable and render the header fields in a single-column layout. Do not fetch domain data in the shell.

- [ ] **Step 4: Implement the overview tab**

Render read-only `Descriptions`/cards for the base information and lightweight projections already returned by the current vehicle detail API. Include shortcut links built by Task 5. Keep vehicle editing in the header action slot; do not duplicate edit forms in the overview or fetch the heavy insurance/listing/valuation/capital detail endpoints.

- [ ] **Step 5: Run tests, lint, and typecheck**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/admin-vehicle-workspace.spec.ts test/vehicle-workspace-shell.spec.tsx
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
```

Expected: focused tests, lint, and typecheck PASS.

- [ ] **Step 6: Commit the shared workspace UI**

```powershell
git add apps/web/src/components/vehicle-workspace apps/web/test/vehicle-workspace-shell.spec.tsx
git commit -m "feat: add vehicle workspace shell"
```

### Task 7: Rights documents tab with batch upload and binding awareness

**Files:**

- Create: `apps/web/src/lib/vehicle-document-workspace.ts`
- Create: `apps/web/src/components/vehicle-workspace/vehicle-documents-tab.tsx`
- Create: `apps/web/test/vehicle-document-workspace.spec.ts`

**Interfaces:**

```ts
export const RIGHTS_DOCUMENT_TYPES = [
  "VEHICLE_REGISTRATION_CERTIFICATE",
  "VEHICLE_LICENSE",
  "VEHICLE_INSPECTION_REPORT",
  "VEHICLE_PURCHASE_AGREEMENT",
  "MOTOR_VEHICLE_INVOICE",
  "OWNER_IDENTITY_DOCUMENT",
  "VEHICLE_CONFIGURATION_SHEET",
  "PURCHASE_PAYMENT_VOUCHER"
] as const;

export function getRightsDocumentCompleteness(
  batches: readonly VehicleDocumentBatchView[]
): { completed: number; total: 8; missingTypes: RightsDocumentType[] };
```

- [ ] **Step 1: Write failing rights-document model tests**

Test the exact eight-type order, grouping by document type and version, zero visibility switches, and completeness semantics:

```ts
it("counts a multi-file payment batch as one completed category", () => {
  const result = getRightsDocumentCompleteness([
    batchFixture("PURCHASE_PAYMENT_VOUCHER", ["receipt-1", "receipt-2"])
  ]);
  expect(result.completed).toBe(1);
  expect(result.total).toBe(8);
});

it.each(["VEHICLE_PURCHASE_AGREEMENT", "OWNER_IDENTITY_DOCUMENT", "PURCHASE_PAYMENT_VOUCHER"])(
  "allows a multi-file %s batch",
  (documentType) => expect(getDocumentBatchFileLimit(documentType)).toBe(20)
);

it("marks only configuration and inspection images as reusable", () => {
  expect(isProductReusableDocument(imageDoc("VEHICLE_CONFIGURATION_SHEET"))).toBe(true);
  expect(isProductReusableDocument(pdfDoc("VEHICLE_CONFIGURATION_SHEET"))).toBe(false);
  expect(isProductReusableDocument(imageDoc("MOTOR_VEHICLE_INVOICE"))).toBe(false);
});
```

- [ ] **Step 2: Run the test and confirm RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-document-workspace.spec.ts
```

Expected: FAIL because the document workspace model does not exist.

- [ ] **Step 3: Implement the pure document view model**

Implement rights-type metadata, grouping, file counts, completeness based only on non-deleted `ACTIVE` files, reusable-source badges, multi-file eligibility, and batch/file archive eligibility. Keep all eight types internal; do not expose or accept a `customerVisible` property in the view model. Preserve `INSPECTION_CERTIFICATE`, `VEHICLE_AUTHORIZATION`, and `OTHER` as a separate “其他内部材料” group that is excluded from the 8-category completeness score.

- [ ] **Step 4: Implement the rights documents tab**

The tab must:

- fetch `GET /api/vehicles/:vehicleId/document-batches` and `GET /api/vehicles/:vehicleId/listing-source-bindings`;
- show eight category cards/rows with completeness and latest-version summary;
- open one category drawer containing version history, file previews/downloads, uploader, and archive action;
- send every upload as one `multipart/form-data` request with repeated `files` fields; allow up to 20 files per batch, explicitly support multi-file purchase agreements, owner identity documents, and payment vouchers, and show additive history for payment vouchers;
- show “商品配置单已引用” or “商品车况报告已引用” on the exact bound file, and list legacy “其他内部材料” separately without counting them in completeness;
- keep referenced archives disabled in the UI and still surface the API's `409` message if state changed concurrently;
- never render a customer visibility toggle.

- [ ] **Step 5: Run focused tests and quality checks**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-document-workspace.spec.ts test/vehicle-workspace-shell.spec.tsx
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
```

Expected: tests, lint, and typecheck PASS.

- [ ] **Step 6: Commit the rights documents tab**

```powershell
git add apps/web/src/lib/vehicle-document-workspace.ts apps/web/src/components/vehicle-workspace/vehicle-documents-tab.tsx apps/web/test/vehicle-document-workspace.spec.ts
git commit -m "feat: add vehicle rights documents tab"
```

### Task 8: Insurance and battery tab

**Files:**

- Create: `apps/web/src/components/vehicle-workspace/vehicle-insurance-battery-tab.tsx`
- Create: `apps/web/test/vehicle-insurance-battery-workspace.spec.ts`
- Modify: `apps/web/src/app/vehicles/page.tsx` (only export/reuse existing response types or helpers if required; do not remove the legacy modal yet)

**Interfaces:**

- Consumes: existing vehicle insurance policy/document APIs, existing battery/BaaS fields, current permissions, and `VehicleWorkspaceTabProps`.
- Produces one primary page without secondary navigation.

- [ ] **Step 1: Write a failing source contract test**

Create `vehicle-insurance-battery-workspace.spec.ts` to read the new component source and assert that it references the current policy/document, latest valid condition-report, and BaaS endpoints; renders compulsory/commercial policy sections; conditionally renders the BaaS block; and does not contain any of the eight rights-document type values. Insurance policy attachments may retain their existing `客户可见` control because they are outside the rights-document boundary.

- [ ] **Step 2: Run the test and confirm RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-insurance-battery-workspace.spec.ts
```

Expected: FAIL because the tab component does not exist.

- [ ] **Step 3: Extract insurance behavior into the new tab**

Move/recompose the current policy summary, policy edit/create forms, policy attachment upload/preview, expiry state, and insurance history into the new component. Retain existing insurance attachment visibility behavior; this task must not convert insurance documents into rights batches.

- [ ] **Step 4: Add the conditional battery/BaaS section**

Render battery capacity/usage mode plus health, inspection date, cycle count, estimated range, and warranty expiry from the latest valid condition report—do not create a second battery-health copy. Show current provider/contract/monthly fee/billing cycle/payment day/next payment/unpaid cost only when usage mode is `BAAS`. For a battery-owned vehicle display “不需要 BaaS 服务”. Do not add a new battery workflow or API; complex insurance and BaaS maintenance continues to link to the existing dedicated pages.

- [ ] **Step 5: Run focused web checks**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-insurance-battery-workspace.spec.ts test/vehicle-workspace-shell.spec.tsx
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
```

Expected: focused tests, lint, and typecheck PASS.

- [ ] **Step 6: Commit the insurance and battery tab**

```powershell
git add apps/web/src/components/vehicle-workspace/vehicle-insurance-battery-tab.tsx apps/web/test/vehicle-insurance-battery-workspace.spec.ts apps/web/src/app/vehicles/page.tsx
git commit -m "feat: add vehicle insurance and battery tab"
```

### Task 9: Product listing tab and exact source-media binding UI

**Files:**

- Create: `apps/web/src/lib/vehicle-listing-workspace.ts`
- Create: `apps/web/src/components/vehicle-workspace/vehicle-listing-tab.tsx`
- Create: `apps/web/test/vehicle-listing-workspace.spec.ts`

**Interfaces:**

```ts
export interface VehicleListingReadiness {
  listingComplete: boolean;
  warnings: string[];
  sourceBindings: {
    configurationSheet: VehicleListingSourceBindingView | null;
    conditionReport: VehicleListingSourceBindingView | null;
  };
}

export function getVehicleListingReadiness(input: VehicleListingWorkspaceInput): VehicleListingReadiness;
```

- [ ] **Step 1: Write failing section and readiness tests**

Test the five secondary sections, source-binding labels, and non-blocking warnings:

```ts
it("warns but does not reject publication when optional source images are absent", () => {
  const readiness = getVehicleListingReadiness(validListingWithoutSources);
  expect(readiness.listingComplete).toBe(true);
  expect(readiness.warnings).toContain("未引用车辆配置单原件");
  expect(readiness.warnings).toContain("未引用车辆检测报告原件");
});

it("presents an exact bound document version", () => {
  expect(getSourceBindingPresentation(bindingFixture({ versionNo: 2 }))).toMatchObject({
    versionLabel: "V2",
    autoUpdates: false
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-listing-workspace.spec.ts
```

Expected: FAIL because the listing workspace model does not exist.

- [ ] **Step 3: Implement the listing view model**

Implement secondary-section metadata, current listing completeness checks, optional source warnings, exact-version presentation, and eligible document filtering. A source choice is eligible only when section, rights type, active state, and JPEG/PNG/WebP MIME match.

- [ ] **Step 4: Implement the product listing tab**

Compose the existing listing overview, customer-facing copy, subscription plans, publishing controls, and structured condition report into these secondary sections:

1. `overview` — listing status/readiness and Portal preview;
2. `copy` — title, description, selling points, and existing media fields;
3. `source-media` — bind/unbind exact configuration-sheet and inspection-report image files;
4. `plans` — existing subscription plan configuration;
5. `condition-report` — existing structured report editor and source/fallback explanation.

The source-media section must call `PUT/DELETE /api/vehicles/:vehicleId/listing-source-bindings/:section`, display document version/file name/upload time, and explicitly state “上传新版本不会自动切换当前商品引用”. Before changing an existing binding, open the candidate's controlled Admin preview and require explicit confirmation naming the current and target versions. A failed bind must retain and redisplay the previous binding. The condition section must show which of `SOURCE_DOCUMENT`, `STRUCTURED_REPORT`, or `NONE` the Portal will render, never both source image and structured report. Load the listing domain once on first tab activation, share the cached result across all five secondary sections, and invalidate only affected listing projections after a mutation.

- [ ] **Step 5: Run focused tests and web quality checks**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-listing-workspace.spec.ts test/vehicle-document-workspace.spec.ts
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
```

Expected: focused tests, lint, and typecheck PASS.

- [ ] **Step 6: Commit the product listing tab**

```powershell
git add apps/web/src/lib/vehicle-listing-workspace.ts apps/web/src/components/vehicle-workspace/vehicle-listing-tab.tsx apps/web/test/vehicle-listing-workspace.spec.ts
git commit -m "feat: add vehicle product listing tab"
```

### Task 10: Valuation and depreciation tab

**Files:**

- Create: `apps/web/src/lib/vehicle-valuation-workspace.ts`
- Create: `apps/web/src/components/vehicle-workspace/vehicle-valuation-tab.tsx`
- Create: `apps/web/test/vehicle-valuation-workspace.spec.ts`

**Interfaces:**

```ts
export const VEHICLE_VALUATION_SECTIONS = [
  { key: "overview", label: "估值总览" },
  { key: "residual", label: "残值预测" },
  { key: "reviews", label: "估值复核" },
  { key: "sale-price-history", label: "销售价历史" },
  { key: "depreciation", label: "折旧管理" }
] as const;

export function getValuationActions(input: {
  permissions: ReadonlySet<string>;
  vehicleStatus: string;
  latestForecast: VehicleResidualForecastView | null;
}): VehicleValuationActionState;
```

- [ ] **Step 1: Write failing valuation navigation and action tests**

Test the exact five secondary sections, permission-based action availability, and the rule that sales-price history belongs only to one vehicle:

```ts
it("never exposes a cross-vehicle sale-price history section", () => {
  expect(VEHICLE_VALUATION_SECTIONS.map(({ key }) => key)).toEqual([
    "overview", "residual", "reviews", "sale-price-history", "depreciation"
  ]);
  expect(getSalePriceHistoryHref("vehicle-1")).toBe(
    "/vehicles/vehicle-1?tab=valuation&section=sale-price-history"
  );
});
```

- [ ] **Step 2: Run the test and confirm RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-valuation-workspace.spec.ts
```

Expected: FAIL because the valuation workspace model does not exist.

- [ ] **Step 3: Implement the pure valuation view model**

Move labels, secondary navigation, forecast/review status presentation, amount/date formatting inputs, action permissions, and single-vehicle history link creation out of the legacy page. Keep API response types explicit; do not use `any` to bridge old and new components.

- [ ] **Step 4: Implement the valuation tab**

Extract/recompose the current capabilities without changing workflow or endpoints:

- `overview`: current sale price, next review, latest residual forecast, current book value, and trend comparison;
- `residual`: latest forecast, forecast history, generate preview/confirm, detail, adopt point, and void;
- `reviews`: valuation review list/detail, create from a forecast point, and cancel;
- `sale-price-history`: `GET /api/vehicles/:id/sale-price-history`, initialize price, and price review actions where permissions/status permit;
- `depreciation`: current depreciation strategy summary, schedule/confirmed counts, existing asset cost/depreciation profile read/edit/preview, and the existing dedicated management entry.

Load the valuation/depreciation domain once when the primary tab is first activated and share that cached result across its five secondary sections. Refresh only the affected projection after a mutation, plus the shared vehicle header when current price/status changed. Preserve the existing rules: a residual forecast or adopted value does not directly overwrite the current sale price, and only an approved valuation review may write sale-price history.

- [ ] **Step 5: Run valuation and regression checks**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-valuation-workspace.spec.ts test/admin-vehicle-workspace.spec.ts
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
```

Expected: focused tests, lint, and typecheck PASS.

- [ ] **Step 6: Commit the valuation tab**

```powershell
git add apps/web/src/lib/vehicle-valuation-workspace.ts apps/web/src/components/vehicle-workspace/vehicle-valuation-tab.tsx apps/web/test/vehicle-valuation-workspace.spec.ts
git commit -m "feat: add vehicle valuation workspace"
```

### Task 11: Capital and revenue-share tab

**Files:**

- Create: `apps/web/src/lib/vehicle-capital-workspace.ts`
- Create: `apps/web/src/components/vehicle-workspace/vehicle-capital-tab.tsx`
- Create: `apps/web/test/vehicle-capital-workspace.spec.ts`

**Interfaces:**

```ts
export const VEHICLE_CAPITAL_SECTIONS = [
  { key: "overview", label: "资本总览" },
  { key: "events", label: "资本事件" },
  { key: "allocations", label: "融资分摊" },
  { key: "revenue-rules", label: "分润规则" },
  { key: "revenue-preview", label: "分润试算" }
] as const;

export function capitalEventFieldVisibility(
  eventType: VehicleCapitalEventType
): VehicleCapitalEventFieldVisibility;
```

- [ ] **Step 1: Write failing capital boundary tests**

Test the exact five secondary sections and the existing event-type field rules. Add a source contract assertion that missing financing allocations are not converted to zero values, and that the revenue preview section contains the explicit boundary copy “仅试算，不生成结算单或付款记录”.

- [ ] **Step 2: Run the test and confirm RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-capital-workspace.spec.ts
```

Expected: FAIL because the capital workspace modules do not exist.

- [ ] **Step 3: Implement the pure capital view model**

Extract the current capital-event field visibility, form normalization, labels, totals, and permission-derived action states. Keep financing instruments and allocation identifiers typed exactly as returned by the existing API.

- [ ] **Step 4: Implement the capital and revenue-share tab**

Recompose current behavior into:

- `overview`: `GET /api/vehicles/:id/capital-structure`, purchase/acquisition/equity/debt/coverage totals, interest estimate, ROE readiness, and missing-data reasons;
- `events`: list/create/edit/cancel through the existing capital-event endpoints;
- `allocations`: financing instruments, principal allocations, ratios, effective dates, and “待补录资本事件” state from the existing capital-structure response;
- `revenue-rules`: list/create/deactivate rules through existing revenue-share endpoints;
- `revenue-preview`: date-range preview through the existing revenue-share preview endpoint.

Load the capital/revenue domain once on first primary-tab activation and share it across all five secondary sections. The preview remains read-only. Do not create settlement, payment, approval, financing, or fund-transfer records, and do not silently synthesize capital events from financing allocations. After a successful capital-event mutation, refresh structure and events; after a rule mutation, refresh rules and the currently displayed preview only when its input range is still valid.

- [ ] **Step 5: Run focused web checks**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-capital-workspace.spec.ts test/admin-vehicle-workspace.spec.ts
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
```

Expected: focused tests, lint, and typecheck PASS.

- [ ] **Step 6: Commit the capital workspace**

```powershell
git add apps/web/src/lib/vehicle-capital-workspace.ts apps/web/src/components/vehicle-workspace/vehicle-capital-tab.tsx apps/web/test/vehicle-capital-workspace.spec.ts
git commit -m "feat: add vehicle capital workspace"
```

### Task 12: Independent vehicle detail route and single-vehicle actions

**Files:**

- Create: `apps/web/src/components/vehicle-workspace/vehicle-detail-actions.tsx`
- Create: `apps/web/src/components/vehicle-workspace/vehicle-workspace-content.tsx`
- Create: `apps/web/src/app/vehicles/[id]/page.tsx`
- Create: `apps/web/test/admin-vehicle-detail-page.spec.ts`

**Interfaces:**

- Consumes: `GET/PATCH /api/vehicles/:id`, current status/price action endpoints, Tasks 5–11 components, and current Admin auth/permission hooks.
- Produces stable route `/vehicles/:id?tab=:tab&section=:section` with reload-safe state.

- [ ] **Step 1: Write the failing route composition test**

Create `admin-vehicle-detail-page.spec.ts` using the repository's source-contract convention. Assert that the route:

- loads `/vehicles/${vehicleId}` rather than filtering the full fleet list;
- reads and normalizes `tab`/`section` with `parseVehicleWorkspaceLocation`;
- writes primary/secondary navigation with `router.replace(buildVehicleWorkspaceHref(...))` so the vehicle summary is not reloaded;
- imports all six primary tab components and `VehicleDetailActions`;
- lazily mounts each permitted primary tab on first activation and retains it for the current page session;
- renders an explicit loading state, `403`/permission state, and missing-vehicle state;
- contains no cross-vehicle table or `vehicles/sale-price-reviews/due` request.

- [ ] **Step 2: Run the route test and confirm RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/admin-vehicle-detail-page.spec.ts
```

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Extract single-vehicle header actions**

Create `VehicleDetailActions` for the existing edit, status change, initialize sales price, and review sales price behavior. Receive the current vehicle and callbacks as props. Do not fetch list data or own page navigation. Preserve current permissions, confirmation prompts, validation, and API payloads.

- [ ] **Step 4: Compose the independent detail page**

Implement a client route that:

1. decodes `params.id` and fetches only that vehicle;
2. derives visible tabs from current permissions;
3. parses the URL into a normalized location and canonicalizes invalid state with `router.replace`;
4. renders the shared shell/header/actions and lazily mounts only the active tab on first access, then retains visited tabs so their domain cache survives secondary navigation;
5. updates the query string with client-side `router.replace` on primary/secondary navigation without losing the vehicle identifier or reloading the shared summary;
6. refreshes shared vehicle data through one stable callback after child mutations;
7. returns to `/vehicles` through breadcrumb/back action and preserves browser Back behavior.

Implement the lazy/retained behavior in `vehicle-workspace-content.tsx`: unvisited inactive tabs do not mount or request data; visited tabs remain mounted but hidden, and each primary tab owns one cached domain load shared by its secondary sections. Use `AbortController` or a monotonically increasing request token when vehicle/tab requests can overlap so stale responses cannot overwrite current state. Wrap each retained tab in an independent error/retry boundary so a failed domain request does not blank the header, navigation, or another tab.

- [ ] **Step 5: Run the detail composition suite**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/admin-vehicle-workspace.spec.ts test/admin-vehicle-detail-page.spec.ts test/vehicle-workspace-shell.spec.tsx test/vehicle-document-workspace.spec.ts test/vehicle-insurance-battery-workspace.spec.ts test/vehicle-listing-workspace.spec.ts test/vehicle-valuation-workspace.spec.ts test/vehicle-capital-workspace.spec.ts
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
```

Expected: all workspace tests, lint, and typecheck PASS.

- [ ] **Step 6: Commit the detail route**

```powershell
git add apps/web/src/app/vehicles/[id]/page.tsx apps/web/src/components/vehicle-workspace/vehicle-detail-actions.tsx apps/web/src/components/vehicle-workspace/vehicle-workspace-content.tsx apps/web/test/admin-vehicle-detail-page.spec.ts
git commit -m "feat: add independent vehicle detail route"
```

### Task 13: Reduce the vehicle ledger page to list and due-review entry points

**Files:**

- Modify: `apps/web/src/app/vehicles/page.tsx`
- Modify: `apps/web/test/admin-vehicle-workspace.spec.ts`
- Modify: `apps/web/test/admin-vehicle-detail-page.spec.ts`

**Interfaces:**

- Consumes: Task 5 URL builder and Task 12 detail route.
- Produces: vehicle ledger with only `车辆列表` and `待销售价格复核`, plus row/detail navigation.

- [ ] **Step 1: Add failing source-boundary tests for the slim list page**

Extend the tests to assert:

```ts
expect(vehiclePageSource).toContain('buildVehicleWorkspaceHref');
expect(vehiclePageSource).toContain('vehicles/sale-price-reviews/due');
expect(vehiclePageSource).not.toContain('key: "sale-price-history"');
expect(vehiclePageSource).not.toContain('detailOpen');
expect(vehiclePageSource).not.toContain('detailVehicle');
expect(vehiclePageSource).not.toContain('VehicleResidualForecast');
expect(vehiclePageSource).not.toContain('RevenueShareRule');
```

Add a pure navigation assertion that a due-review action targets `?tab=valuation&section=sale-price-history` for the selected vehicle. Add a list-state round-trip test proving that filters, page, and page size are serialized to `/vehicles?...` and restored after browser Back.

- [ ] **Step 2: Run the affected tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/admin-vehicle-workspace.spec.ts test/admin-vehicle-detail-page.spec.ts
```

Expected: FAIL because the legacy page still owns the modal workspace and global sales-price history.

- [ ] **Step 3: Replace modal opening with route navigation**

Use `router.push(buildVehicleWorkspaceHref(...))` for the row and “详情” action. Row navigation defaults to `overview`; due-review navigation goes directly to `valuation/sale-price-history`. Stop propagation on the row-local detail link/button so it does not trigger duplicate navigation. Preserve browser modifier behavior where an actual link can be used.

- [ ] **Step 4: Remove the legacy detail/modal ownership**

Delete from `vehicles/page.tsx`:

- detail vehicle modal/drawer state and all six domain panels/forms;
- cross-vehicle sales-price history tab, request, filters, and table;
- residual/valuation/capital/listing/insurance/document handlers now owned by detail tabs;
- duplicated domain types, formatters, and modal components moved in Tasks 6–11.

Retain only fleet list filters/table/pagination, due sales-price review queue, create-vehicle flow, and navigation. The action column must contain only “详情”. Synchronize active list tab, filters, page, and page size to the list URL with `router.replace` so browser Back from a vehicle restores the exact ledger view without an extra API/schema change. Do not change list API/filter payloads or the due-review API.

- [ ] **Step 5: Run the complete workspace test set**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/admin-vehicle-workspace.spec.ts test/admin-vehicle-detail-page.spec.ts test/vehicle-workspace-shell.spec.tsx test/vehicle-document-workspace.spec.ts test/vehicle-insurance-battery-workspace.spec.ts test/vehicle-listing-workspace.spec.ts test/vehicle-valuation-workspace.spec.ts test/vehicle-capital-workspace.spec.ts
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
```

Expected: all workspace tests, lint, and typecheck PASS; no deleted legacy symbol remains.

- [ ] **Step 6: Commit the ledger cleanup**

```powershell
git add apps/web/src/app/vehicles/page.tsx apps/web/test/admin-vehicle-workspace.spec.ts apps/web/test/admin-vehicle-detail-page.spec.ts
git commit -m "refactor: route vehicle ledger to detail workspace"
```

### Task 14: Portal long-image reuse for configuration and condition sections

**Files:**

- Modify: `apps/web/src/lib/portal-types.ts`
- Create: `apps/web/src/components/portal/portal-source-document-image.tsx`
- Modify: `apps/web/src/app/portal/catalog/[id]/page.tsx`
- Create: `apps/web/test/portal-vehicle-source-documents.spec.tsx`

**Interfaces:**

```ts
export interface PortalCatalogSourceDocument {
  section: "CONFIGURATION_SHEET" | "CONDITION_REPORT";
  title: string;
  previewUrl: string;
}

export interface PortalCatalogVehicleDetail {
  // existing fields remain unchanged
  sourceDocuments: {
    configurationSheet: PortalCatalogSourceDocument | null;
    conditionReport: PortalCatalogSourceDocument | null;
  };
  conditionDisplayMode: "SOURCE_DOCUMENT" | "STRUCTURED_REPORT" | "NONE";
}
```

- [ ] **Step 1: Write failing rendering and precedence tests**

Use `renderToStaticMarkup` for the source-image component and a source contract for the page:

```ts
it("renders a controlled long image with no storage key", () => {
  const html = renderToStaticMarkup(
    <PortalSourceDocumentImage
      document={{
        section: "CONFIGURATION_SHEET",
        title: "车辆配置单",
        previewUrl: "/api/portal/catalog/vehicles/v1/source-documents/CONFIGURATION_SHEET/preview"
      }}
    />
  );
  expect(html).toContain("车辆配置单");
  expect(html).toContain("source-documents/CONFIGURATION_SHEET/preview");
  expect(html).not.toContain("storageKey");
});
```

Assert that the catalog page branches on `conditionDisplayMode`, never renders the source condition image and structured condition-report link in the same branch, and does not render PDFs in an image element.

- [ ] **Step 2: Run the Portal web test and confirm RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-vehicle-source-documents.spec.tsx
```

Expected: FAIL because the response types and source-image component do not exist.

- [ ] **Step 3: Extend Portal response types and implement the image component**

Add the Task 4 projection to `portal-types.ts`. Implement a responsive, lazy-loaded long-image panel using the existing same-origin API URL helper and current Portal image/preview conventions. The panel must preserve aspect ratio, provide meaningful alt text and loading/error states, and offer image preview without exposing a private storage bucket/key. If the controlled image request fails, hide only that panel, emit a sanitized warning through the existing client logging convention, and keep the rest of the catalog page usable.

- [ ] **Step 4: Render configuration and condition source documents**

In the vehicle catalog detail page:

- render `sourceDocuments.configurationSheet` in the configuration section when present; keep existing structured vehicle attributes around it;
- when `conditionDisplayMode === "SOURCE_DOCUMENT"`, render only the bound inspection-report image;
- when `conditionDisplayMode === "STRUCTURED_REPORT"`, render only the current structured-report summary/link;
- when `conditionDisplayMode === "NONE"`, render the existing neutral empty state;
- do not add an Admin-only download link or expose other rights documents.

- [ ] **Step 5: Run Portal API/Web and full web checks**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-catalog.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/portal-vehicle-source-documents.spec.tsx
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web build
```

Expected: Portal tests, lint, typecheck, and production web build PASS.

- [ ] **Step 6: Commit the Portal long-image rendering**

```powershell
git add apps/web/src/lib/portal-types.ts apps/web/src/components/portal/portal-source-document-image.tsx apps/web/src/app/portal/catalog/[id]/page.tsx apps/web/test/portal-vehicle-source-documents.spec.tsx
git commit -m "feat: reuse vehicle source images in portal catalog"
```

### Task 15: Full regression, documentation, deployment handoff, and staged acceptance

**Files:**

- Create: `docs/superpowers/plans/2026-08-08-vehicle-asset-detail-tab-redesign-acceptance.md`
- Modify only if a verified regression requires it: files already named in Tasks 1–14

**Interfaces:**

- Consumes: all Tasks 1–14, staging Admin/Portal accounts, private object storage, and vehicle `VEH20260731152647G5GV`.
- Produces: reproducible quality-gate evidence, deployment checklist, and acceptance result. This task does not include the pending WeChat template notification acceptance.

- [ ] **Step 1: Create the acceptance record before running gates**

Create the acceptance document with sections for commit SHA, migration status, automated commands/results, staging image tags, test vehicle, six-tab checks, rights-document checks, source-binding checks, permission checks, Portal checks, known deferred items, and rollback notes. Mark every check `未执行`; do not pre-fill success.

- [ ] **Step 2: Run database/schema preflight without destructive reset**

```powershell
git status --short --branch
pnpm prisma:migrate:status
pnpm prisma:validate
pnpm prisma:generate
```

Expected: clean task scope, no unexpected pending migration before the new migration, schema validation/generation PASS. Do not run `prisma migrate reset`. Apply the new migration only to the intended local/test database after confirming its connection target:

```powershell
pnpm prisma:migrate:deploy
pnpm prisma:migrate:status
```

Expected: `20260808010000_vehicle_document_workspace` applied once and database schema up to date.

- [ ] **Step 3: Run focused API/Web suites**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-document-workspace-schema.spec.ts test/vehicle-insurance.spec.ts test/vehicle-listing.spec.ts test/portal-catalog.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/admin-vehicle-workspace.spec.ts test/admin-vehicle-detail-page.spec.ts test/vehicle-workspace-shell.spec.tsx test/vehicle-document-workspace.spec.ts test/vehicle-insurance-battery-workspace.spec.ts test/vehicle-listing-workspace.spec.ts test/vehicle-valuation-workspace.spec.ts test/vehicle-capital-workspace.spec.ts test/portal-vehicle-source-documents.spec.tsx
```

Expected: all focused suites PASS. Record command output summaries in the acceptance document.

- [ ] **Step 4: Run repository quality gates and production builds**

```powershell
pnpm quality:gate
pnpm build
git diff --check
git status --short --branch
```

Expected: lint, Prisma validation/generation/status, API/Web typecheck, full API/Web tests, all package builds, and whitespace check PASS. Only intentional documentation changes may remain before the evidence commit.

- [ ] **Step 5: Commit verified documentation/evidence**

```powershell
git add docs/superpowers/plans/2026-08-08-vehicle-asset-detail-tab-redesign-acceptance.md
git commit -m "docs: record vehicle workspace verification"
```

- [ ] **Step 6: Deploy migration and matching API/Web images through the existing staging release process**

Before deployment, record the current staging API/Web image tags and database backup/restore reference. Deploy the database migration first, then matching API and Web images built from the same commit. Confirm `/health`, Admin login, and Portal catalog load before functional testing. If migration or health checks fail, stop and roll back application images; use the documented database restore procedure rather than ad-hoc destructive SQL.

- [ ] **Step 7: Execute the Admin staging acceptance matrix**

Using vehicle `VEH20260731152647G5GV`, record evidence for:

1. `/vehicles` shows only `车辆列表` and `待销售价格复核`; row/detail click opens `/vehicles/:id`;
2. all six permitted primary tabs load; refresh and browser Back preserve URL state; unauthorized tabs normalize without leaking content;
3. overview edits/status/price actions and due-review entry behave as before;
4. each of the eight rights categories uploads/previews/downloads; all remain internal with no customer-visible control;
5. one `PURCHASE_PAYMENT_VOUCHER` upload accepts at least two bank receipts, and a later upload creates an additive version batch;
6. configuration-sheet and inspection-report JPEG/PNG/WebP files can be bound exactly; PDF and wrong-type bindings are rejected;
7. uploading a newer eligible file does not change the current binding; referenced archive returns/displays `409` until unbound;
8. insurance/BaaS, listing/plans, residual/reviews/depreciation/sale-price history, and capital/events/revenue-share preview retain existing behavior;
9. revenue-share preview creates no settlement or payment record.

- [ ] **Step 8: Execute the Portal staging acceptance matrix**

Publish/preview the vehicle listing and verify:

1. the bound configuration-sheet long image loads in its product section through the controlled Portal URL;
2. the bound inspection-report long image replaces, rather than duplicates, the structured condition report;
3. after unbinding the inspection source, a published structured report becomes the fallback; with neither source, the neutral empty state appears;
4. direct preview URL requests for unpublished/hidden vehicles, unbound sections, wrong vehicle IDs, and invalid sections return non-disclosing `404` behavior;
5. the Portal response/DOM contains no private bucket, object key, or other rights-document metadata.

- [ ] **Step 9: Close or classify acceptance results**

Update every acceptance item with `通过`, `失败`, or `暂缓`, include evidence links/timestamps and defect references, then commit the result:

```powershell
git add docs/superpowers/plans/2026-08-08-vehicle-asset-detail-tab-redesign-acceptance.md
git commit -m "docs: record staging vehicle workspace acceptance"
```

This feature may be accepted independently when its matrix passes. Keep the Stage 1 combined Golden Path marked deferred until WeChat template `Ws_SDUYiCIWD8p8XCiMjWndSxgp9Ga5IGt_MYBEUaqo` is approved and available; do not treat that external review as a defect in this vehicle workspace.
