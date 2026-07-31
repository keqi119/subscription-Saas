# Staging WeChat Payment and Mobile Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the staging Portal payment page readable on mobile and route WeChat OAuth through the newly authorized `staging-app.subauto.keybox.cloud` domain without changing production.

**Architecture:** Extract bill presentation into a responsive component that renders a desktop Ant Design table and mobile bill cards from one data source. Mirror the production OAuth callback topology by exposing one exact callback path on the staging Portal host and proxying only that path to the staging API; keep the existing HMAC state and Portal redirect safeguards unchanged.

**Tech Stack:** Next.js 16, React 19, Ant Design 6, CSS Modules, Vitest 4, NestJS 11, Nginx, Docker Compose, GHCR.

## Global Constraints

- Preserve production OAuth, Nginx, API, Web, merchant, and public-account configuration.
- Keep `PAYMENT_PROVIDER=wechat_pay`, `PAYMENT_MOCK_ENABLED=false`, `WECHAT_PAY_ENABLED=true`, and `WECHAT_OAUTH_MOCK_ENABLED=false` in staging.
- Do not call the JSAPI transaction endpoint during automated verification and do not create, pay, close, or delete a payment order.
- Keep the public verification file at `https://staging-app.subauto.keybox.cloud/MP_verify_HGc1Zvund91Pydr1.txt` byte-identical to the approved attachment.
- Use `staging-app.subauto.keybox.cloud` for the OAuth callback and `staging-api.subauto.keybox.cloud` for ordinary Portal API traffic.
- Preserve the existing untracked `.superpowers/`, `apps/api/tmp/`, `output/`, and `tmp/` paths.

---

## File Structure

- Create `apps/web/src/app/portal/payment-orders/[id]/payment-order-bill-details.tsx`: owns desktop and mobile bill rendering plus shared money/time formatting.
- Create `apps/web/src/app/portal/payment-orders/[id]/payment-order-bill-details.module.css`: owns responsive visibility and overflow-safe mobile card layout.
- Create `apps/web/test/payment-order-bill-details.spec.tsx`: server-renders the component and proves both views contain the complete bill data.
- Modify `apps/web/src/app/portal/payment-orders/[id]/page.tsx`: delegates bill rendering and shared formatting to the new component without changing payment behavior.
- Create `nginx/staging-app-wechat-oauth.example.conf`: exact staging-app OAuth callback proxy fragment for BT/Nginx.
- Modify `.env.staging.images.example`: documents the authorized staging-app OAuth callback URL.
- Modify `apps/web/test/deployment-ops-safety.spec.ts`: locks the callback host, upstream port, and production isolation into a regression test.

---

### Task 1: Responsive Portal bill details

**Files:**
- Create: `apps/web/test/payment-order-bill-details.spec.tsx`
- Create: `apps/web/src/app/portal/payment-orders/[id]/payment-order-bill-details.tsx`
- Create: `apps/web/src/app/portal/payment-orders/[id]/payment-order-bill-details.module.css`
- Modify: `apps/web/src/app/portal/payment-orders/[id]/page.tsx:1-20,202-235,242-272,311-319`

**Interfaces:**
- Consumes: `PortalPaymentOrderItem[]` from `paymentOrder.items`.
- Produces: `PaymentOrderBillDetails({ items }: { items: PortalPaymentOrderItem[] })`, `formatPortalMoney(amount?: number | null): string`, and `formatPortalTime(value?: string | null): string`.
- Preserves: `startPayment`, OAuth navigation, `WeixinJSBridge`, payment-status rules, and payment button placement.

- [ ] **Step 1: Write the failing responsive component test**

Create `apps/web/test/payment-order-bill-details.spec.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  formatPortalMoney,
  PaymentOrderBillDetails
} from "../src/app/portal/payment-orders/[id]/payment-order-bill-details";
import type { PortalPaymentOrderItem } from "../src/lib/portal-types";

const item: PortalPaymentOrderItem = {
  amount: 1,
  billId: "bill_first_month",
  billNo: "BIL20260731173757TDWH",
  billStatus: "PENDING",
  billType: "FIRST_MONTHLY_FEE",
  dueDate: "2026-08-01T01:37:00.000Z",
  id: "payment_item_1",
  orderNo: "ORD20260731173351SMF2",
  paidAmount: 0,
  remainingAmount: 1
};

describe("PaymentOrderBillDetails", () => {
  it("renders complete desktop and mobile bill views from the same item", () => {
    const html = renderToStaticMarkup(<PaymentOrderBillDetails items={[item]} />);

    expect(html).toContain('data-testid="payment-order-bills-desktop"');
    expect(html).toContain('data-testid="payment-order-bills-mobile"');
    for (const text of ["账单编号", "类型", "状态", "应付", "待付", "到期日"]) {
      expect(html).toContain(text);
    }
    expect(html.match(/BIL20260731173757TDWH/g)).toHaveLength(2);
    expect(html).toContain("首期月费");
    expect(html).toContain("待收款");
  });

  it("formats one cent without losing precision", () => {
    expect(formatPortalMoney(1)).toBe("0.01 元");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- payment-order-bill-details.spec.tsx
```

Expected: FAIL because `payment-order-bill-details` does not exist. The failure must be an import/module-not-found failure, not a syntax error in the fixture.

- [ ] **Step 3: Implement the responsive bill component**

Create `apps/web/src/app/portal/payment-orders/[id]/payment-order-bill-details.tsx` with this structure:

```tsx
"use client";

import { Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";

import {
  BILL_STATUS_LABELS,
  BILL_TYPE_LABELS,
  labelOf
} from "../../../../constants/labels";
import type { PortalPaymentOrderItem } from "../../../../lib/portal-types";
import styles from "./payment-order-bill-details.module.css";

const columns: ColumnsType<PortalPaymentOrderItem> = [
  { dataIndex: "billNo", title: "账单编号", width: 210 },
  {
    dataIndex: "billType",
    render: (value: string) => labelOf(BILL_TYPE_LABELS, value),
    title: "类型",
    width: 110
  },
  {
    dataIndex: "billStatus",
    render: (value: string) => labelOf(BILL_STATUS_LABELS, value),
    title: "状态",
    width: 100
  },
  { dataIndex: "amount", render: formatPortalMoney, title: "应付", width: 100 },
  { dataIndex: "remainingAmount", render: formatPortalMoney, title: "待付", width: 100 },
  { dataIndex: "dueDate", render: formatPortalTime, title: "到期日", width: 150 }
];

export function PaymentOrderBillDetails({ items }: { items: PortalPaymentOrderItem[] }) {
  return (
    <>
      <div className={styles.desktop} data-testid="payment-order-bills-desktop">
        <Table
          columns={columns}
          dataSource={items}
          pagination={false}
          rowKey="id"
          scroll={{ x: 770 }}
          size="small"
        />
      </div>
      <div className={styles.mobile} data-testid="payment-order-bills-mobile">
        {items.map((item) => (
          <article className={styles.card} key={item.id}>
            <BillRow label="账单编号" value={item.billNo} wrap />
            <BillRow label="类型" value={labelOf(BILL_TYPE_LABELS, item.billType)} />
            <BillRow label="状态" value={labelOf(BILL_STATUS_LABELS, item.billStatus)} />
            <BillRow label="应付" value={formatPortalMoney(item.amount)} />
            <BillRow label="待付" value={formatPortalMoney(item.remainingAmount)} />
            <BillRow label="到期日" value={formatPortalTime(item.dueDate)} />
          </article>
        ))}
      </div>
    </>
  );
}

function BillRow({ label, value, wrap = false }: { label: string; value: string; wrap?: boolean }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={wrap ? styles.wrappingValue : styles.value}>{value}</span>
    </div>
  );
}

export function formatPortalMoney(amount?: number | null) {
  return amount === null || amount === undefined
    ? "-"
    : `${(amount / 100).toLocaleString("zh-CN", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2
      })} 元`;
}

export function formatPortalTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}
```

Create `apps/web/src/app/portal/payment-orders/[id]/payment-order-bill-details.module.css`:

```css
.desktop {
  display: block;
  max-width: 100%;
  overflow: hidden;
}

.mobile {
  display: none;
}

.card {
  border: 1px solid #e5eaf2;
  border-radius: 8px;
  padding: 14px;
}

.row {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 12px;
  padding: 7px 0;
}

.row + .row {
  border-top: 1px solid #f0f2f5;
}

.label {
  color: #8c8c8c;
}

.value,
.wrappingValue {
  min-width: 0;
  text-align: right;
}

.wrappingValue {
  overflow-wrap: anywhere;
  word-break: break-word;
}

@media (max-width: 767px) {
  .desktop {
    display: none;
  }

  .mobile {
    display: grid;
    gap: 12px;
  }
}
```

- [ ] **Step 4: Integrate the component without changing payment behavior**

In `apps/web/src/app/portal/payment-orders/[id]/page.tsx`:

1. Remove `Table`, `ColumnsType`, `dayjs`, `BILL_STATUS_LABELS`, `BILL_TYPE_LABELS`, and `PortalPaymentOrderItem` imports.
2. Import:

```tsx
import {
  formatPortalMoney,
  formatPortalTime,
  PaymentOrderBillDetails
} from "./payment-order-bill-details";
```

3. Replace the table with:

```tsx
<PaymentOrderBillDetails items={paymentOrder.items} />
```

4. Replace summary calls to `formatMoney`/`formatTime` with `formatPortalMoney`/`formatPortalTime`.
5. Delete the old `columns`, `formatMoney`, and `formatTime` declarations. Do not edit `startPayment`, `invokeWeChatPay`, or payable-status logic.

- [ ] **Step 5: Run the test and verify GREEN**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- payment-order-bill-details.spec.tsx
```

Expected: `2 passed`, `0 failed`.

- [ ] **Step 6: Run focused Web validation**

Run:

```powershell
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web build
git diff --check
```

Expected: every command exits 0 and the diff contains no formatting-only rewrite of the payment page.

- [ ] **Step 7: Commit the mobile UI fix**

```powershell
git add -- 'apps/web/src/app/portal/payment-orders/[id]/page.tsx' 'apps/web/src/app/portal/payment-orders/[id]/payment-order-bill-details.tsx' 'apps/web/src/app/portal/payment-orders/[id]/payment-order-bill-details.module.css' 'apps/web/test/payment-order-bill-details.spec.tsx'
git commit -m "fix(portal): render payment bills as mobile cards"
```

---

### Task 2: Staging OAuth callback configuration contract

**Files:**
- Modify: `apps/web/test/deployment-ops-safety.spec.ts`
- Modify: `.env.staging.images.example`
- Create: `nginx/staging-app-wechat-oauth.example.conf`

**Interfaces:**
- External callback: `https://staging-app.subauto.keybox.cloud/api/portal/wechat/oauth/callback`.
- Internal upstream: `http://127.0.0.1:3101/api/portal/wechat/oauth/callback`.
- Production port `3001` and production host `app.subauto.keybox.cloud` must not appear in the staging fragment.

- [ ] **Step 1: Add failing deployment-safety assertions**

Add this test to `apps/web/test/deployment-ops-safety.spec.ts`:

```ts
it("routes staging WeChat OAuth through the authorized Portal domain", () => {
  const environment = read(".env.staging.images.example");
  const nginx = read("nginx/staging-app-wechat-oauth.example.conf");

  expect(environment).toContain(
    "WECHAT_PAY_OAUTH_REDIRECT_URI=https://staging-app.subauto.keybox.cloud/api/portal/wechat/oauth/callback"
  );
  expect(environment).not.toContain(
    "WECHAT_PAY_OAUTH_REDIRECT_URI=https://staging-api.subauto.keybox.cloud"
  );
  expect(nginx).toContain("location = /api/portal/wechat/oauth/callback");
  expect(nginx).toContain(
    "proxy_pass http://127.0.0.1:3101/api/portal/wechat/oauth/callback;"
  );
  expect(nginx).toContain("proxy_set_header Host staging-app.subauto.keybox.cloud;");
  expect(nginx).not.toContain("127.0.0.1:3001");
  expect(nginx).not.toContain("proxy_set_header Host app.subauto.keybox.cloud;");
});
```

- [ ] **Step 2: Run the test and verify RED**

```powershell
pnpm --filter @subscription-saas/web test -- deployment-ops-safety.spec.ts
```

Expected: FAIL because the env example still uses `staging-api` and the Nginx fragment does not exist.

- [ ] **Step 3: Add the staging-app callback fragment and env example**

Change `.env.staging.images.example` to:

```dotenv
WECHAT_PAY_OAUTH_REDIRECT_URI=https://staging-app.subauto.keybox.cloud/api/portal/wechat/oauth/callback
```

Create `nginx/staging-app-wechat-oauth.example.conf`:

```nginx
# Copy this fragment into the staging-app BT/Nginx server block extension directory.
location = /api/portal/wechat/oauth/callback {
    proxy_pass http://127.0.0.1:3101/api/portal/wechat/oauth/callback;
    proxy_http_version 1.1;
    proxy_set_header Host staging-app.subauto.keybox.cloud;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
}
```

- [ ] **Step 4: Run the test and verify GREEN**

```powershell
pnpm --filter @subscription-saas/web test -- deployment-ops-safety.spec.ts
```

Expected: all deployment safety tests pass.

- [ ] **Step 5: Commit the configuration contract**

```powershell
git add .env.staging.images.example nginx/staging-app-wechat-oauth.example.conf apps/web/test/deployment-ops-safety.spec.ts
git commit -m "chore(staging): route WeChat OAuth through portal host"
```

---

### Task 3: Full verification and image publication

**Files:**
- Verify only; no additional source files.

**Interfaces:**
- Produces matching API and Web image tags: `Staging-20260801-${releaseSha}`.
- Web bundle API base remains `https://staging-api.subauto.keybox.cloud/api`.

- [ ] **Step 1: Run all relevant tests and quality checks**

```powershell
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web build
pnpm --filter @subscription-saas/api test -- wechat-oauth.spec.ts wechat-pay-provider.spec.ts
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api build
git diff --check
git status --short
```

Expected: tests, lint, typecheck, and builds exit 0. Git status contains only the known untracked paths and no tracked modifications.

- [ ] **Step 2: Push both implementation commits**

```powershell
git push
git rev-parse HEAD
git rev-parse origin/fix/staging-contract-template-selection-20260731
```

Expected: both revisions are identical.

- [ ] **Step 3: Build and push matching images**

```powershell
$releaseSha = (git rev-parse --short=7 HEAD).Trim()
$releaseTag = "Staging-20260801-$releaseSha"
$apiImage = "ghcr.io/keqi119/subscription-api:$releaseTag"
$webImage = "ghcr.io/keqi119/subscription-web:$releaseTag"

docker build -f Dockerfile.api -t $apiImage .
docker push $apiImage
docker build -f Dockerfile.web `
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://staging-api.subauto.keybox.cloud/api `
  --build-arg NEXT_DEPLOYMENT_ID=$releaseTag `
  -t $webImage .
docker push $webImage
```

Expected: both pushes exit 0 and print immutable GHCR digests.

---

### Task 4: Deploy the staging callback and images

**Files:**
- Deploy local `nginx/staging-app-wechat-oauth.example.conf` to `/www/server/panel/vhost/nginx/extension/staging-app.subauto.keybox.cloud/wechat-oauth-callback.conf`.
- Modify remote `/opt/subscription-saas/.env.staging.images` with a timestamped backup.

**Interfaces:**
- Nginx exact path proxies only the OAuth callback to port `3101`.
- Staging API receives the callback while the browser remains on the authorized staging-app domain.

- [ ] **Step 1: Resolve and record exact deployment targets**

```powershell
$releaseSha = (git rev-parse --short=7 HEAD).Trim()
$releaseTag = "Staging-20260801-$releaseSha"
$sshKey = "D:\Projects\auto-subscription-platform\.codex-ssh\subscription-saas-aliyun2"
$server = "root@139.196.227.195"

ssh -i $sshKey -o BatchMode=yes $server "test -d /www/server/panel/vhost/nginx/extension/staging-app.subauto.keybox.cloud && test -f /opt/subscription-saas/.env.staging.images && test -f /opt/subscription-saas/docker-compose.staging.images.example.yml"
```

Expected: exit 0 before any remote write.

- [ ] **Step 2: Upload and validate the callback fragment**

```powershell
scp -i $sshKey -o BatchMode=yes nginx/staging-app-wechat-oauth.example.conf "${server}:/tmp/staging-app-wechat-oauth.conf.codex-upload"
ssh -i $sshKey -o BatchMode=yes $server "install -o root -g root -m 0644 /tmp/staging-app-wechat-oauth.conf.codex-upload /www/server/panel/vhost/nginx/extension/staging-app.subauto.keybox.cloud/wechat-oauth-callback.conf && nginx -t && systemctl reload nginx && rm -f -- /tmp/staging-app-wechat-oauth.conf.codex-upload"
```

Expected: `nginx -t` succeeds before reload. If it fails, remove only the newly installed `wechat-oauth-callback.conf`, rerun `nginx -t`, and stop deployment.

- [ ] **Step 3: Back up and update the staging environment**

Run a remote script that uses the already-computed `$releaseTag`:

```powershell
$remoteScript = @"
set -euo pipefail
cd /opt/subscription-saas
cp -a .env.staging.images .env.staging.images.bak-wechat-oauth-$releaseSha
sed -i 's#^API_IMAGE=.*#API_IMAGE=ghcr.io/keqi119/subscription-api:$releaseTag#' .env.staging.images
sed -i 's#^WEB_IMAGE=.*#WEB_IMAGE=ghcr.io/keqi119/subscription-web:$releaseTag#' .env.staging.images
sed -i 's#^WECHAT_PAY_OAUTH_REDIRECT_URI=.*#WECHAT_PAY_OAUTH_REDIRECT_URI=https://staging-app.subauto.keybox.cloud/api/portal/wechat/oauth/callback#' .env.staging.images
docker compose -p subauto-staging -f docker-compose.staging.images.example.yml --env-file .env.staging.images config -q
"@
$remoteScript | ssh -i $sshKey -o BatchMode=yes $server "bash -s"
```

Expected: Compose config exits 0. Do not print merchant credentials or certificate contents.

- [ ] **Step 4: Pull and recreate only staging API and Web**

```powershell
ssh -i $sshKey -o BatchMode=yes $server "cd /opt/subscription-saas && docker compose -p subauto-staging -f docker-compose.staging.images.example.yml --env-file .env.staging.images pull api web && docker compose -p subauto-staging -f docker-compose.staging.images.example.yml --env-file .env.staging.images up -d --no-deps --force-recreate api web"
```

Expected: `subauto-staging-api-1` and `subauto-staging-web-1` are recreated; production containers are untouched.

- [ ] **Step 5: Record rollback commands before acceptance**

```powershell
ssh -i $sshKey -o BatchMode=yes $server "cd /opt/subscription-saas && cp -a .env.staging.images.bak-wechat-oauth-$releaseSha .env.staging.images && rm -f -- /www/server/panel/vhost/nginx/extension/staging-app.subauto.keybox.cloud/wechat-oauth-callback.conf && nginx -t && systemctl reload nginx && docker compose -p subauto-staging -f docker-compose.staging.images.example.yml --env-file .env.staging.images up -d --no-deps --force-recreate api web"
```

Do not execute rollback unless deployment verification fails. This command removes only the route created in Step 2 and restores the exact staging env backup.

---

### Task 5: Fresh staging verification and handoff

**Files:**
- Verify only; no source edits.

**Interfaces:**
- Confirms the authorized OAuth callback, responsive UI build, real WeChat configuration, current payment state, and production isolation.

- [ ] **Step 1: Verify containers, images, and safe payment flags**

```powershell
ssh -i $sshKey -o BatchMode=yes $server "docker inspect --format '{{.State.Health.Status}}|{{.Config.Image}}' subauto-staging-api-1 subauto-staging-web-1"
ssh -i $sshKey -o BatchMode=yes $server "docker exec subauto-staging-api-1 printenv PAYMENT_PROVIDER PAYMENT_MOCK_ENABLED PAYMENT_DEFAULT_CHANNEL WECHAT_PAY_ENABLED WECHAT_OAUTH_MOCK_ENABLED WECHAT_PAY_OAUTH_REDIRECT_URI"
```

Expected:

- Both containers are `healthy` and use `Staging-20260801-${releaseSha}`.
- Values are `wechat_pay`, `false`, `WECHAT_JSAPI`, `true`, `false`, and the staging-app callback URL.

- [ ] **Step 2: Verify the public verification file and callback routing**

```powershell
$verificationUrl = "https://staging-app.subauto.keybox.cloud/MP_verify_HGc1Zvund91Pydr1.txt"
$verificationResponse = Invoke-WebRequest -Uri $verificationUrl -UseBasicParsing
$verificationBytes = $verificationResponse.RawContentStream.ToArray()
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$verificationHash = ([BitConverter]::ToString($sha256.ComputeHash($verificationBytes))).Replace("-", "").ToLowerInvariant()
if ($verificationHash -ne "67bd45fd3886541a2849c526e7c6afdfb2ea846b386eb6e44151a8ad73a48992") { throw "Verification file hash mismatch" }

$callbackResult = curl.exe -sS -w "`nHTTP_STATUS=%{http_code}" "https://staging-app.subauto.keybox.cloud/api/portal/wechat/oauth/callback"
$callbackResult
if ($callbackResult -notcontains "HTTP_STATUS=400") { throw "OAuth callback did not reach the staging API" }
if (($callbackResult -join "`n") -notmatch "WECHAT_OAUTH_CODE_OR_STATE_MISSING") { throw "OAuth callback returned the wrong error body" }
```

Expected: verification file returns 200 with the exact hash. Callback returns the staging API's 400 response containing `WECHAT_OAUTH_CODE_OR_STATE_MISSING`, not a Web 404.

- [ ] **Step 3: Run the signed read-only WeChat certificate probe**

Run the existing signed `GET /v3/certificates` probe inside `subauto-staging-api-1` with headers `Accept: application/json` and `Accept-Language: zh-CN`.

Expected: HTTP 200 and at least one certificate. The probe must not call any transaction endpoint.

- [ ] **Step 4: Verify payment data remained untouched**

Run against `subscription_saas_staging`:

```sql
SELECT po.payment_order_no,
       po.payment_status,
       po.payment_channel,
       po.amount,
       po.paid_amount
FROM payment_order po
JOIN subscription_order so ON so.id = po.order_id
WHERE so.application_id = '2d1c0221-3a87-47de-ba6a-ffe743e5e077'
  AND po.deleted_at IS NULL
ORDER BY po.created_at;

SELECT rb.bill_no,
       rb.bill_status,
       rb.amount,
       rb.paid_amount
FROM receivable_bill rb
JOIN subscription_order so ON so.id = rb.order_id
WHERE so.application_id = '2d1c0221-3a87-47de-ba6a-ffe743e5e077'
  AND rb.deleted_at IS NULL
ORDER BY rb.created_at;
```

Expected before user acceptance: payment order remains unpaid, bill remains unpaid, and `paid_amount` remains 0. Report actual state if it changed due to concurrent user action.

- [ ] **Step 5: Verify mobile layout at 375px**

Open the deployed payment-order page in an authenticated Portal session with viewport width 375px. Confirm:

- `data-testid="payment-order-bills-mobile"` is visible.
- `data-testid="payment-order-bills-desktop"` is hidden.
- `document.documentElement.scrollWidth <= document.documentElement.clientWidth`.
- Bill number, type, status, payable amount, remaining amount, and due date are readable without character-by-character column wrapping.

Reset the temporary viewport after the check. If no authenticated browser session is available, hand the URL back to the acceptance user and request one fresh 375px screenshot before claiming visual verification.

- [ ] **Step 6: Re-run completion gates and report handoff**

```powershell
pnpm --filter @subscription-saas/web test -- payment-order-bill-details.spec.tsx deployment-ops-safety.spec.ts
pnpm --filter @subscription-saas/api test -- wechat-oauth.spec.ts wechat-pay-provider.spec.ts
git diff --check
git status --short
git rev-parse HEAD
git rev-parse origin/fix/staging-contract-template-selection-20260731
```

Expected: all tests pass, tracked worktree is clean, and local/remote branch revisions match. Handoff must state that OAuth and UI are ready while the actual payment remains for the user to trigger in WeChat.
