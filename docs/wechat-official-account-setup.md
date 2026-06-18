# WeChat Official Account Setup

This document records the first-version WeChat service account menu plan for the customer H5 portal.

Stage 10H-A only provides a dry-run menu JSON. It does not call the WeChat API or create the menu automatically.

## Required Platform Settings

- JS interface secure domain: `app.subauto.keybox.cloud`
- Web OAuth domain: `app.subauto.keybox.cloud`
- Portal base URL: `https://app.subauto.keybox.cloud`
- API callback base URL: `https://api.subauto.keybox.cloud/api`

If the service account AppID/AppSecret is the same one used for WeChat Pay JSAPI openid binding, production can reuse the existing values through environment variables. Do not commit the AppSecret or access token.

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
node scripts/wechat-menu-dry-run.mjs
```

Override the portal base URL if needed:

```powershell
$env:PORTAL_BASE_URL="https://app.subauto.keybox.cloud"; node scripts/wechat-menu-dry-run.mjs
```

## Stage 10H-B Notes

Real menu creation should call:

```text
POST https://api.weixin.qq.com/cgi-bin/menu/create?access_token=ACCESS_TOKEN
```

Stage 10H-B must first verify:

- The real access token can be obtained.
- The service account menu quota and monthly update limits are acceptable.
- H5 links open correctly in the WeChat client.
- Customer login and openid binding work from each menu entry.
