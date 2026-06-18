# Stage 10G-A ServiceCase Portal Foundation

> Date: 2026-06-18  
> Branch: `feature/stage10-service-case-portal`  
> Scope: shared service-case foundation, accident report, rescue request, attachments, customer progress, and back-office handling.

## 1. Goal

Stage 10G-A adds the customer service entry after the Portal order, contract, payment, bill, deposit, and entitlement center is available.

This stage implements:

- Customer accident report.
- Customer rescue request.
- Shared `ServiceCase` work-order base.
- Private attachment upload and preview through API streaming.
- Customer-owned service-case list, detail, progress, and cancellation.
- Back-office service-case list, detail, acceptance, status update, notes, and close.

It does not connect insurers, roadside rescue vendors, dispatch systems, cost settlement, or notifications.

## 2. Existing Capability Check

Current code already had related but narrower models:

- `VehicleReturnDamage` records damage found during return acceptance.
- `CollectionCase` records overdue collection cases.
- `CustomerMaterial`, `ApplicationMaterialFile`, `FileObject`, and `StorageService` support private material uploads.

The code did not have a general accident report, rescue request, or customer service work-order model. Stage 10G-A therefore adds a new `ServiceCase` base instead of reusing return damage or collection cases.

## 3. Data Model

New models:

- `ServiceCase`
- `ServiceCaseAttachment`
- `ServiceCaseAction`

New enums:

- `ServiceCaseType`: `ACCIDENT_REPORT`, `RESCUE_REQUEST`, `CUSTOMER_SUPPORT`
- `ServiceCaseSource`: `CUSTOMER_PORTAL`, `BACK_OFFICE`
- `ServiceCaseStatus`: `SUBMITTED`, `ACCEPTED`, `IN_PROGRESS`, `WAITING_CUSTOMER`, `RESOLVED`, `CLOSED`, `CANCELLED`
- `ServiceCasePriority`: `LOW`, `NORMAL`, `HIGH`, `URGENT`
- `RescueType`: `TOWING`, `JUMP_START`, `TIRE_CHANGE`, `ACCIDENT_RESCUE`, `OTHER`
- `ServiceCaseAttachmentType`: `IMAGE`, `DOCUMENT`, `OTHER`
- `ServiceCaseActionType`: `SUBMIT`, `ACCEPT`, `UPDATE_STATUS`, `ADD_NOTE`, `UPLOAD_ATTACHMENT`, `RESOLVE`, `CLOSE`, `CANCEL`
- `ServiceCaseActorType`: `CUSTOMER`, `STAFF`, `SYSTEM`

Relations:

- `ServiceCase.customerId -> Customer`
- `ServiceCase.orderId -> SubscriptionOrder`
- `ServiceCase.vehicleId -> Vehicle`
- `ServiceCaseAttachment.serviceCaseId -> ServiceCase`
- `ServiceCaseAction.serviceCaseId -> ServiceCase`

Portal creation requires `orderId`, so the service case is tied to a known customer order and vehicle.

## 4. Portal APIs

Protected by `CustomerAuthGuard`:

- `POST /api/portal/service-cases`
- `GET /api/portal/service-cases`
- `GET /api/portal/service-cases/:id`
- `POST /api/portal/service-cases/:id/attachments`
- `GET /api/portal/service-cases/:id/attachments/:attachmentId/preview`
- `POST /api/portal/service-cases/:id/cancel`

Ownership rules:

- Customers can only create cases for their own orders.
- Customers can only list, view, upload to, preview, or cancel their own cases.
- Admin tokens do not satisfy `CustomerAuthGuard`.

## 5. Back-Office APIs

RBAC-protected APIs:

- `GET /api/service-cases` requires `service_case:view`
- `GET /api/service-cases/:id` requires `service_case:view`
- `POST /api/service-cases/:id/accept` requires `service_case:manage`
- `POST /api/service-cases/:id/status` requires `service_case:manage`
- `POST /api/service-cases/:id/actions` requires `service_case:manage`
- `POST /api/service-cases/:id/close` requires `service_case:manage`

Role seed:

- `ADMIN`: all permissions.
- `OP`: `service_case:view`, `service_case:manage`.
- `SA`: `service_case:view`.
- `GM`: `service_case:view`.

Menu:

- `订单中心 -> 服务工单`
- Route: `/service-cases`

After seed updates, operators must re-run `pnpm prisma:seed` and re-login to refresh JWT permissions.

## 6. Status Flow

Portal:

- Create: `SUBMITTED`
- Customer cancel allowed only from `SUBMITTED` or `ACCEPTED`
- Cancel result: `CANCELLED`

Back-office:

- `SUBMITTED -> ACCEPTED`
- `ACCEPTED -> IN_PROGRESS`
- `IN_PROGRESS -> WAITING_CUSTOMER`
- `WAITING_CUSTOMER -> IN_PROGRESS`
- `IN_PROGRESS -> RESOLVED`
- `RESOLVED -> CLOSED`
- Back-office close can also close an unfinished non-cancelled case with a close remark.

Every state operation writes a `ServiceCaseAction`.

## 7. Attachments / OSS

Stage 10G-A reuses `StorageService` and adds `putServiceCaseAttachment`.

Rules:

- Attachments are stored in private local/OSS storage.
- Portal responses return API preview URLs only.
- `bucket` and `objectKey` are not returned to customers.
- Preview/download streams through the API after ownership checks.
- First version blocks video uploads and supports images plus ordinary files.

## 8. H5 Pages

New customer pages:

- `/portal/service-cases`
- `/portal/service-cases/new?type=ACCIDENT_REPORT`
- `/portal/service-cases/new?type=RESCUE_REQUEST`
- `/portal/service-cases/[id]`

Portal home now links accident report and rescue request to the real creation pages.

## 9. Back-Office Page

New page:

- `/service-cases`

First version includes:

- List and filters.
- Detail drawer.
- Accept.
- Update status.
- Add handling note.
- Close.

## 10. Safety Boundary

This stage does not:

- Change order status.
- Change vehicle status.
- Generate damage fee bills.
- Generate rescue fee bills.
- Perform cost settlement.
- Integrate insurer or rescue provider APIs.
- Send WeChat or SMS notifications.

ServiceCase is a service-workflow record only. Downstream financial or supplier integration should be added in later stages through explicit review.

## 11. Next Stages

Recommended next step:

- Stage 10H: WeChat service account and notification center.

Possible later extensions:

- Stage 10G-B: dispatch, responsibility, fees, and close-out enhancements.
- Stage 10G-C: insurer and roadside rescue provider integrations.
