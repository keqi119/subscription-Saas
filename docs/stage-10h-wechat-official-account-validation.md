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
- `WECHAT_OA_TEST_OPENID` was updated to one single non-wildcard value from the production customer account for `CUS20260618025459A7JV` / `186****0212`.
- No AppSecret, access_token, full openid, or full template ID was printed or committed.

R2 openid lookup:

- The local tunnel database did not contain the production Portal customer/order that the user was testing.
- The production API container database contained customer `CUS20260618025459A7JV` with an active account for `186****0212`.
- That account had a bound `CustomerAccount.wechatOpenId`.
- The full openid was copied directly into the ignored local env file without printing it; report output only used masked form `oOJh****-RKs`.
- A 0.01 CNY production test bill was created on order `ORD-WX-PAY-TEST-20260618110103` as `BIL20260619152147Y2MW` to support the WeChat JSAPI/openid validation flow.

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
- Initial attempts failed safely:
  - `40003 invalid openid` for an earlier non-matching test openid.
  - `47003` template data validation errors until the real template field set was supplied.
- Final result: WeChat returned success for `PAYMENT_PENDING`.
- `NotificationRecord.notificationStatus = SENT`.
- `NotificationEvent.eventStatus = PROCESSED` with `lastError = null`.
- `NotificationRecord.providerMessageId` was populated from WeChat `msgid` and is reported only in masked form `4568****9000`.
- Provider response had `errcode = 0`, `errmsg = ok`, and did not contain access_token.
- The successful record URL was `https://app.subauto.keybox.cloud/portal/orders`.

R2 menu validation:

- `pnpm wechat:menu:dry-run` passed and printed the customer-facing menu JSON only.
- Menu dry-run did not call the WeChat API.
- Menu apply was not executed.

R2 gate decision:

- Real access_token, single-openid template send, WeChat `msgid` persistence, and menu dry-run have passed.
- Stage 10H-B should not be declared fully passed until the operator confirms the test WeChat client received the message and clicking it opens the expected Portal H5 URL.
- Menu apply was not executed and remains gated by explicit manual confirmation plus `WECHAT_MENU_APPLY=1`.

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

Stage 10H-B is partially validated by R2 real API calls, but cannot be declared fully passed until WeChat-client receipt and click-through are manually confirmed.

Current product decision:

- Stage 10H-A is complete.
- Stage 10H-B safety validation foundation is complete.
- Stage 10H-B real service-account token smoke is complete.
- Stage 10H-B real single-openid `PAYMENT_PENDING` template send is complete.
- Stage 10H-B real WeChat `msgid` persistence is complete.
- Stage 10H-B menu dry-run is complete.
- Stage 10H-B WeChat-client receipt and click-through validation are pending operator confirmation.
- Stage 10H-B menu apply is not executed and remains pending explicit manual confirmation.

It can be declared passed after a controlled operator run records:

- Real access_token success, masked.
- At least one successful single-openid template send.
- Saved WeChat `msgid` in `NotificationRecord.providerMessageId`.
- Manual receipt in the test WeChat account.
- Template click-through to the expected Portal H5 URL.
- Menu dry-run approved.
- Menu apply success if and only if `WECHAT_MENU_APPLY=1` was explicitly set.
