# WeChat Official Account Setup

This document records the WeChat service account menu plan for the customer H5 portal.

Stage 10H-A provided a dry-run menu payload. Stage 10H-B adds a guarded real apply path. Real menu creation is still disabled by default and requires an explicit environment switch.

## Required Platform Settings

- Service account is verified.
- Template message capability is enabled.
- Required templates have been added in the WeChat Official Account console.
- Web OAuth domain includes `app.subauto.keybox.cloud`.
- Menu links use the customer portal domain, not the admin domain:
  `https://app.subauto.keybox.cloud`.
- Do not commit AppSecret, access_token, full openid, or real template ID mappings.

## Recommended Menu

Menu 1: 订阅用车

- 浏览车辆: `https://app.subauto.keybox.cloud/portal/catalog`
- 我的申请: `https://app.subauto.keybox.cloud/portal/applications`

Menu 2: 我的服务

- 我的订单: `https://app.subauto.keybox.cloud/portal/orders`
- 我的账单: `https://app.subauto.keybox.cloud/portal/bills`
- 我的权益: `https://app.subauto.keybox.cloud/portal/entitlements`

Menu 3: 帮助

- 事故报案: `https://app.subauto.keybox.cloud/portal/service-cases/new?type=ACCIDENT_REPORT`
- 救援申请: `https://app.subauto.keybox.cloud/portal/service-cases/new?type=RESCUE_REQUEST`

## Dry Run

Generate the proposed menu payload without calling WeChat:

```powershell
pnpm wechat:menu:dry-run
```

Equivalent direct command:

```powershell
node scripts/wechat-menu.mjs --dry-run
```

Override the portal base URL if needed:

```powershell
node scripts/wechat-menu.mjs --dry-run --portal-base-url https://app.subauto.keybox.cloud
```

## Real Apply

Real menu creation requires both an apply command and the explicit environment switch:

```powershell
$env:WECHAT_MENU_APPLY="1"
pnpm wechat:menu:apply -- --env-file .env
```

The script calls:

```text
POST https://api.weixin.qq.com/cgi-bin/menu/create?access_token=ACCESS_TOKEN
```

Safety behavior:

- Defaults to dry-run.
- Prints the menu JSON before applying.
- Requires `WECHAT_MENU_APPLY=1`.
- Never prints access_token or AppSecret.
- Saves the masked apply result to `.tmp/stage10h-wechat-menu-apply-result.json` by default.
- WeChat client menu refresh can be delayed by client-side cache.

## Token and Template Smoke

Token-only smoke:

```powershell
$env:WECHAT_OA_SMOKE_MODE="token"
pnpm wechat:oa:smoke -- --env-file .env
```

Single-openid template smoke:

```powershell
$env:WECHAT_OA_SMOKE_MODE="template"
$env:WECHAT_OA_TEST_OPENID="<single_test_openid>"
$env:WECHAT_OA_TEMPLATE_TYPE="PAYMENT_PENDING"
pnpm wechat:oa:smoke -- --env-file .env
```

The smoke script blocks wildcard and multi-openid inputs by default. It never reads all customers for batch sending.

Optional local database setup for a controlled smoke customer:

```powershell
$env:WECHAT_OA_CREATE_TEST_CUSTOMER="1"
$env:WECHAT_OA_BIND_OPENID="1"
$env:WECHAT_OA_SYNC_TEMPLATE_ID="1"
```

These options create or update only the named smoke customer and store the selected template ID in `NotificationTemplate.providerTemplateId`. They do not write any secret to Git.

## Template ID Mapping

Set real values only in local, staging, or production environment variables:

```env
WECHAT_TEMPLATE_APPLICATION_PROGRESS=<real_template_id>
WECHAT_TEMPLATE_FINAL_PLAN_PENDING=<real_template_id>
WECHAT_TEMPLATE_CONTRACT_PENDING=<real_template_id>
WECHAT_TEMPLATE_PAYMENT_PENDING=<real_template_id>
WECHAT_TEMPLATE_HANDOVER_PENDING=<real_template_id>
WECHAT_TEMPLATE_SERVICE_CASE_UPDATE=<real_template_id>
```

Keep committed examples as `<CHANGE_ME>`.

The Stage 1 handover scene uses its own `订单待取车提醒` template. Its exact fields are
`character_string1` (订单号), `thing9` (车辆名称), `car_number5` (车牌号), and
`thing11` (客户名称). Never route `HANDOVER_ESIGN_PENDING` to the application-progress
template. Before enabling the Journey, run one controlled `HANDOVER_PENDING` smoke with an
explicit `WECHAT_OA_TEMPLATE_DATA_JSON` object and a single approved OpenID.
