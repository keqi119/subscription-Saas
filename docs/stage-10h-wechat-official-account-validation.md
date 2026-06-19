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

## R2 Validation Attempt - 2026-06-19

Stage 10H-B-R2 was resumed after the WeChat normal template-message review was reported as approved and after Stage 10I plus the NotificationModule DI fix had been merged to `main`.

R2 local/server env handling:

- `.env.wechat-official-account.local` is ignored by Git through `.gitignore` rule `.env.*`.
- The file contains real AppID/AppSecret entries and the `PAYMENT_PENDING` / `SERVICE_CASE_UPDATE` template ID entries.
- `WECHAT_TEMPLATE_FINAL_PLAN_PENDING`, `WECHAT_TEMPLATE_CONTRACT_PENDING`, and `WECHAT_TEMPLATE_APPLICATION_PROGRESS` are intentionally not supplied in this run.
- `WECHAT_OA_TEST_OPENID` was updated to one single non-wildcard value and was used for one controlled `PAYMENT_PENDING` template smoke.
- No AppSecret, access_token, full openid, or full template ID was printed or committed.

R2 openid lookup:

- The requested payment-test phone `18616570212` matched two `Customer` rows in the current database.
- Neither matched customer had an associated `CustomerAccount`.
- No active `CustomerAccount.wechatOpenId` values were present in the current database.
- The agent therefore could not safely derive a real `WECHAT_OA_TEST_OPENID` value from the database; the test openid was later supplied through the ignored local env file.

R2 token smoke:

- Initial result: WeChat returned `WECHAT_ACCESS_TOKEN_FAILED:40164`.
- The WeChat errmsg identified the calling IP as not whitelisted.
- After the IP whitelist was updated, command `pnpm wechat:oa:smoke -- --mode token --env-file .env.wechat-official-account.local` passed.
- No access_token was printed.

R2 template smoke:

- Command: `pnpm wechat:oa:smoke -- --mode template --template-type PAYMENT_PENDING --env-file .env.wechat-official-account.local --env-file .env`
- Safety env used for this smoke only: `WECHAT_OA_CREATE_TEST_CUSTOMER=1`, `WECHAT_OA_BIND_OPENID=1`, `WECHAT_OA_SYNC_TEMPLATE_ID=1`.
- Send object count: 1.
- Mass send: No.
- Result: WeChat returned `WECHAT_TEMPLATE_SEND_FAILED:40003`.
- WeChat errmsg summary: `invalid openid`.
- `NotificationRecord.notificationStatus = FAILED`.
- `NotificationEvent.eventStatus = PROCESSED` with `lastError = WECHAT_TEMPLATE_SEND_FAILED:40003`.
- `NotificationRecord.providerMessageId` was not recorded because WeChat did not return `msgid`.
- Provider response did not contain access_token.
- The failed record URL was `https://app.subauto.keybox.cloud/portal/orders`.

R2 menu validation:

- `pnpm wechat:menu:dry-run` passed and printed the customer-facing menu JSON only.
- Menu dry-run did not call the WeChat API.
- Menu apply was not executed.

R2 gate decision:

- Stage 10H-B real validation gate is still open.
- Blocking reasons:
  - The supplied single test openid was rejected by WeChat with `40003 invalid openid`.
  - No successful WeChat `msgid` has been returned or saved.
- Required next operator action:
  - Bind or provide one real openid that belongs to the same `WECHAT_OFFICIAL_ACCOUNT_APP_ID` service account and a user who follows that service account.
  - Re-run single-openid `PAYMENT_PENDING` or `SERVICE_CASE_UPDATE` template smoke.

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
