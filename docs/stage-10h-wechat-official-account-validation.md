# Stage 10H-B WeChat Official Account Validation

## Scope

Stage 10H-B validates real WeChat Official Account token retrieval, single-openid template messages, notification records/events, and customer portal menu configuration.

This stage must not change WeChat Pay certificate rotation, payment posting, write-off, receivable bill, or any payment callback logic.

## Safety Rules

- No mass messaging.
- No marketing push.
- No wildcard openid.
- Template smoke accepts exactly one openid.
- Menu apply requires `WECHAT_MENU_APPLY=1`.
- AppSecret, access_token, full openid, and full template ID values must not be committed or printed.
- Real validation results must be masked.

## Required Environment

Real values are supplied only through local/server environment variables:

```env
WECHAT_OFFICIAL_ACCOUNT_APP_ID=<CHANGE_ME>
WECHAT_OFFICIAL_ACCOUNT_APP_SECRET=<CHANGE_ME>
WECHAT_TEMPLATE_APPLICATION_PROGRESS=<CHANGE_ME>
WECHAT_TEMPLATE_FINAL_PLAN_PENDING=<CHANGE_ME>
WECHAT_TEMPLATE_CONTRACT_PENDING=<CHANGE_ME>
WECHAT_TEMPLATE_PAYMENT_PENDING=<CHANGE_ME>
WECHAT_TEMPLATE_SERVICE_CASE_UPDATE=<CHANGE_ME>
WECHAT_OA_TEST_OPENID=<CHANGE_ME>
PORTAL_BASE_URL=https://app.subauto.keybox.cloud
```

Masked reporting format:

```text
AppID: wx****abcd
AppSecret: present, masked
openid: oxxx****yyyy
templateId: abcd****wxyz
```

## Scripts

Token smoke:

```powershell
$env:WECHAT_OA_SMOKE_MODE="token"
pnpm wechat:oa:smoke -- --env-file .env
```

Single template smoke:

```powershell
$env:WECHAT_OA_SMOKE_MODE="template"
$env:WECHAT_OA_TEST_OPENID="<single_test_openid>"
$env:WECHAT_OA_TEMPLATE_TYPE="PAYMENT_PENDING"
$env:WECHAT_OA_BIND_OPENID="1"
$env:WECHAT_OA_SYNC_TEMPLATE_ID="1"
pnpm wechat:oa:smoke -- --env-file .env
```

Menu dry-run:

```powershell
pnpm wechat:menu:dry-run
```

Menu apply:

```powershell
$env:WECHAT_MENU_APPLY="1"
pnpm wechat:menu:apply -- --env-file .env
```

## Recommended Template Smoke Coverage

Preferred:

- `FINAL_PLAN_PENDING`
- `PAYMENT_PENDING`
- `SERVICE_CASE_UPDATE`

Minimum if template availability is limited:

- `PAYMENT_PENDING`
- `SERVICE_CASE_UPDATE`

## Menu Dry-Run Result

The menu script builds this customer-facing menu:

- 订阅用车
  - 浏览车辆: `/portal/catalog`
  - 我的申请: `/portal/applications`
- 我的服务
  - 我的订单: `/portal/orders`
  - 我的账单: `/portal/bills`
  - 我的权益: `/portal/entitlements`
- 帮助
  - 事故报案: `/portal/service-cases/new?type=ACCIDENT_REPORT`
  - 救援申请: `/portal/service-cases/new?type=RESCUE_REQUEST`

## Validation Log

| Item | Result |
| --- | --- |
| Local env readiness | `WECHAT_OFFICIAL_ACCOUNT_APP_ID`, `WECHAT_OFFICIAL_ACCOUNT_APP_SECRET`, template IDs, and `WECHAT_OA_TEST_OPENID` were not present in the local `.env` used by the agent |
| Connected to real WeChat service account | Not executed in this code-only handoff |
| Real access_token fetched | Pending real env |
| access_token printed or committed | No |
| Real template message sent | Pending real env |
| Send object count | 0 in this run |
| Mass send | No |
| providerMessageId/msgid persistence | Code supports string and numeric `msgid` |
| Menu dry-run | Passed locally with `pnpm wechat:menu:dry-run`; no WeChat API call |
| Menu apply | Guarded by `WECHAT_MENU_APPLY=1`; not executed in this run |
| Portal public URL check | Attempted from the agent environment; blocked by network/approval timeout, pending operator verification |
| Portal notification center | Existing Stage 10H-A API/UI, pending manual H5 validation |
| Back-office notification center | Existing Stage 10H-A API/UI, pending manual validation |
| Secret leakage | No committed secret values |

## Expected Database Checks After Real Smoke

After template smoke, verify:

```text
NotificationEvent.eventStatus = PROCESSED
NotificationRecord.channel = WECHAT_OFFICIAL_ACCOUNT
NotificationRecord.notificationStatus = SENT or FAILED
NotificationRecord.providerMessageId is populated when WeChat returns msgid
NotificationRecord.providerResponse does not contain access_token
NotificationRecord.recipientOpenId is masked in back-office responses
```

If the real send fails, `NotificationRecord.notificationStatus` must be `FAILED`, with `errorMessage` containing the WeChat errcode summary. The business workflow must continue.

## Portal Link Checklist

Verify these URLs in the WeChat client before declaring Stage 10H-B complete:

- `https://app.subauto.keybox.cloud/portal/catalog`
- `https://app.subauto.keybox.cloud/portal/applications`
- `https://app.subauto.keybox.cloud/portal/orders`
- `https://app.subauto.keybox.cloud/portal/bills`
- `https://app.subauto.keybox.cloud/portal/entitlements`
- `https://app.subauto.keybox.cloud/portal/service-cases/new?type=ACCIDENT_REPORT`
- `https://app.subauto.keybox.cloud/portal/service-cases/new?type=RESCUE_REQUEST`

## Completion Decision

Stage 10H-B cannot be declared passed from this repository-only run because no real service account AppSecret, test openid, or template IDs were provided to the agent, and no real WeChat API call was executed.

Current product decision:

- Stage 10H-A is complete.
- Stage 10H-B safety validation foundation is complete.
- Stage 10H-B real service-account template-message validation is Pending.
- Blocking reason: WeChat Official Account normal template-message capability is still under platform review.
- Stage 10I Customer Portal Release Hardening may proceed while waiting for the WeChat review.
- After the WeChat review passes, resume Stage 10H-B-R2 for token smoke, single-openid template send, click-through validation, and optional menu apply.

It can be declared passed after a controlled operator run records:

- Real access_token success, masked.
- At least two successful single-openid template sends, preferably three.
- Saved WeChat `msgid` in `NotificationRecord.providerMessageId`.
- Manual receipt in the test WeChat account.
- Template click-through to the expected Portal H5 URL.
- Menu dry-run approved.
- Menu apply success if and only if `WECHAT_MENU_APPLY=1` was explicitly set.
