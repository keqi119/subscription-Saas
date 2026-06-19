# Customer Portal Manual Acceptance

## Purpose

This checklist validates the customer journey before Portal release. It is designed for a controlled staging or production-like environment.

Stage 10H-B real WeChat template-message validation is pending WeChat platform review. Run notification center checks with in-app/mock notification records until Stage 10H-B-R2 resumes.

## 1. Guest Browses Vehicles

- Entry: `/portal/catalog`
- Prerequisite data: available vehicle and active subscription plan.
- Operation: open catalog, filter by brand/model/city, open vehicle detail.
- Expected result: catalog and detail load; customer sees only customer-facing vehicle and package fields.
- Not allowed: purchase price, internal residual/financing fields, full storage object paths, stack traces.

## 2. Customer Logs In

- Entry: `/portal/login`
- Prerequisite data: customer phone can receive or use dev/staging verification code.
- Operation: request code, check agreement checkbox, submit login.
- Expected result: `customer_access_token` session is set and customer enters `/portal`.
- Not allowed: login without agreeing to terms/privacy; raw error text; admin token substituting customer login.

## 3. Submit Application

- Entry: `/portal/catalog/[id]`
- Prerequisite data: selected vehicle and plan allow submission.
- Operation: fill self-service application fields and submit.
- Expected result: application is created under the current customer.
- Not allowed: choosing another customer, injecting customerId, or submitting unavailable vehicle/package.

## 4. Upload Materials

- Entry: `/portal/applications/[id]`
- Prerequisite data: application requires material groups.
- Operation: upload required documents/images.
- Expected result: files appear in material list and preview works through `/api/portal/applications/:id/materials/:materialId/preview`.
- Not allowed: previewing another customer's file; exposing OSS bucket/key/public URL.

## 5. Back Office Reviews

- Entry: admin application workbench.
- Prerequisite data: submitted customer application.
- Operation: complete material/product/credit/vehicle review.
- Expected result: Portal progress reflects review state.
- Not allowed: customer seeing internal review comments not intended for Portal.

## 6. Customer Views Progress

- Entry: `/portal/applications/[id]`
- Prerequisite data: reviewed or in-progress application.
- Operation: open detail and progress timeline.
- Expected result: steps, next action, and supplement hints are readable.
- Not allowed: `[object Object]`, `Internal Server Error`, or unrelated customer records.

## 7. Back Office Generates Final Plan

- Entry: admin application/final plan workflow.
- Prerequisite data: reviewed application.
- Operation: generate or update final plan.
- Expected result: Portal final plan becomes pending confirmation.
- Not allowed: Portal exposing internal pricing/cost fields beyond customer-facing final plan.

## 8. Customer Confirms Final Plan

- Entry: `/portal/applications/[id]`
- Prerequisite data: final plan pending confirmation.
- Operation: confirm or reject final plan.
- Expected result: status updates, action is audited, next step is clear.
- Not allowed: confirming another customer's plan or confirming after terminal state.

## 9. Back Office Generates Order And Contract

- Entry: admin order/contract workflow.
- Prerequisite data: confirmed final plan.
- Operation: generate order and contract.
- Expected result: Portal order and contract lists show the new records for that customer.
- Not allowed: customer seeing other customers' orders/contracts.

## 10. Customer Signs Contract

- Entry: `/portal/contracts/[id]`
- Prerequisite data: generated contract with pending mock e-sign task.
- Operation: start signing and complete mock sign when available.
- Expected result: sign task updates and contract status is visible.
- Not allowed: signing another customer's contract or exposing provider secrets.

## 11. Customer Pays

- Entry: `/portal/payment-orders/[id]` or payable bill action.
- Prerequisite data: payable bill/payment order.
- Operation: start payment using configured provider.
- Expected result: JSAPI payment path works in WeChat environment; mock path works where enabled.
- Not allowed: changing payment order ownership, bypassing payable amount, or exposing WeChat Pay certificates/keys.

## 12. Customer Checks Orders, Bills, Deposit, Entitlements

- Entry: `/portal/orders`, `/portal/bills`, `/portal/deposit`, `/portal/entitlements`
- Prerequisite data: active order with bills/deposit/entitlements.
- Operation: open list and detail pages.
- Expected result: records are scoped to current customer and amounts/statuses are readable.
- Not allowed: finance write-off internals, other customer records, internal collection notes.

## 13. Customer Submits Accident Report

- Entry: `/portal/service-cases/new?type=ACCIDENT_REPORT`
- Prerequisite data: customer has order/vehicle if linked case is needed.
- Operation: submit accident report with attachments as needed.
- Expected result: service case is created and visible in `/portal/service-cases`.
- Not allowed: uploading files to another case or changing staff-only status fields.

## 14. Customer Submits Rescue Request

- Entry: `/portal/service-cases/new?type=RESCUE_REQUEST`
- Prerequisite data: customer has contact/location information.
- Operation: submit rescue request.
- Expected result: rescue case is created and progress can be tracked.
- Not allowed: implying guaranteed arrival time or external vendor confirmation unless actually integrated.

## 15. Back Office Handles Service Case

- Entry: admin `/service-cases`
- Prerequisite data: submitted accident/rescue case.
- Operation: accept, update status, add note, close.
- Expected result: customer sees customer-safe timeline updates.
- Not allowed: exposing internal staff-only notes if not intended for Portal.

## 16. Customer Views Notifications

- Entry: `/portal/notifications`
- Prerequisite data: in-app notification records exist.
- Operation: open notification center, mark single/all as read, click notification URL.
- Expected result: only current customer's notifications appear; unread/read state works.
- Not allowed: customer A seeing customer B notification; full openid in UI.

## 17. WeChat Service Account Menu Targets

- Entry: service account menu dry-run/apply payload.
- Prerequisite data: menu approved.
- Operation: verify menu links:
  - `/portal/catalog`
  - `/portal/applications`
  - `/portal/orders`
  - `/portal/bills`
  - `/portal/entitlements`
  - `/portal/service-cases/new?type=ACCIDENT_REPORT`
  - `/portal/service-cases/new?type=RESCUE_REQUEST`
- Expected result: links open customer H5 and unauthenticated customers are led to login.
- Not allowed: admin domain or HTTP links.
