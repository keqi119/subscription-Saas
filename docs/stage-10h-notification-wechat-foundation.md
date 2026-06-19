# Stage 10H-A Notification Center and WeChat Foundation

## Goal

Stage 10H-A adds the notification foundation for the customer portal. It introduces a unified notification model, in-app messages, provider abstraction, a mock provider, and the base WeChat Official Account provider structure.

This stage does not send real WeChat template messages by default.

## Data Model

New models:

- `NotificationTemplate`: channel, template type, provider template ID, content, variables, status.
- `NotificationRecord`: customer-facing or provider-facing send record, recipient, status, payload, provider response, read time.
- `NotificationEvent`: outbox-style business event with aggregate reference, attempts, status, and processing metadata.

New enums cover channels, template types, notification types, send status, event types, and event status.

## Provider Abstraction

`NotificationProvider` exposes one send method:

```ts
send(input): Promise<SendNotificationResult>
```

The service can create in-app records and provider-backed records without coupling business services to a concrete provider.

## Mock Provider

`MockNotificationProvider` does not call external APIs. It records a mock provider response and returns success unless tests explicitly send `forceFail`.

Recommended defaults:

```env
NOTIFICATION_PROVIDER=mock
NOTIFICATION_WECHAT_ENABLED=false
```

## WeChat Official Account Provider

`WeChatOfficialAccountProvider` implements:

- Service account `access_token` retrieval.
- In-memory token cache.
- Template message send method.
- One retry when token-expired errors are returned.

It only calls WeChat when:

```env
NOTIFICATION_PROVIDER=wechat_official_account
NOTIFICATION_WECHAT_ENABLED=true
```

The provider supports dedicated service-account env vars and can fall back to existing WeChat Pay AppID/AppSecret values when explicitly configured that way.

## Event Integration

Stage 10H-A hooks the first core business events:

- `APPLICATION_SUBMITTED`
- `FINAL_PLAN_READY`
- `CONTRACT_PENDING`
- `PAYMENT_PENDING`
- `SERVICE_CASE_SUBMITTED`
- `SERVICE_CASE_UPDATED`
- `RESCUE_UPDATED`

Notification errors are caught and logged. They must not roll back the primary business operation.

## Portal

New Portal APIs:

- `GET /api/portal/notifications`
- `GET /api/portal/notifications/:id`
- `POST /api/portal/notifications/:id/read`
- `POST /api/portal/notifications/read-all`

New H5 route:

- `/portal/notifications`

Customers can view their own in-app messages, see unread count, mark messages as read, and follow the notification URL.

## Back Office

New back-office APIs:

- `GET /api/notifications/templates`
- `GET /api/notifications/records`
- `GET /api/notifications/events`

New route:

- `/notifications`

The first version is read-only and shows templates, send records, and event records.

## Permissions

New permissions:

- `notification:view`
- `notification:manage`

The back-office menu entry is added under the order center as `通知中心`.

After seed changes, re-run `pnpm prisma:seed` and sign in again to refresh JWT permissions and menus.

## WeChat Menu

Menu guidance is documented in:

- `docs/wechat-official-account-setup.md`

Dry-run script:

```powershell
pnpm wechat:menu:dry-run
```

The dry-run command only prints JSON and does not call WeChat. Stage 10H-B adds the guarded apply command:

```powershell
$env:WECHAT_MENU_APPLY="1"
pnpm wechat:menu:apply -- --env-file .env
```

Real apply remains disabled unless `WECHAT_MENU_APPLY=1` is present.

## Stage 10H-B Handoff

Stage 10H-B validation tooling is documented in:

- `docs/stage-10h-wechat-official-account-validation.md`

New controlled scripts:

- `pnpm wechat:oa:smoke`: token-only or single-openid template-message smoke.
- `pnpm wechat:menu:dry-run`: print the proposed customer service-account menu.
- `pnpm wechat:menu:apply`: apply the menu only when `WECHAT_MENU_APPLY=1`.

The smoke tooling masks AppID/openid/template IDs, never prints access_token or AppSecret, and blocks wildcard or multi-openid sends.

R2 validation note on 2026-06-19:

- WeChat normal template-message capability was reported approved.
- Initial token smoke from the current calling source returned WeChat `40164`; after the Official Account IP whitelist was updated, token smoke passed without printing access_token.
- The requested payment-test phone did not have a safely matched `CustomerAccount.wechatOpenId` in the current database, so a single test openid was supplied through ignored local env.
- One controlled `PAYMENT_PENDING` template smoke was attempted and failed safely with WeChat `40003 invalid openid`.
- Stage 10H-B remains pending until one followed test user openid belonging to the same service-account AppID is supplied and a template smoke returns WeChat `msgid`.

## Not In Scope

- Real WeChat template message sending in production.
- WeChat mass messaging.
- SMS, email, mini-program subscribe messages.
- Marketing messages, coupons, complex orchestration.
- Production deployment.

## Next Stage

Stage 10H-B should perform a controlled real WeChat Official Account template-message and menu integration:

- Configure real template IDs.
- Enable real provider in a controlled environment.
- Verify customers with openid receive messages.
- Verify H5 jump links.
- Add retry or scheduled outbox processing if needed.
