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
- Operation: open catalog from `/portal/catalog`, confirm card CTA is `查看详情`, open detail, choose plan/period, and click `提交审核`.
- Expected result: precheck runs before application creation. If required profile materials are missing, customer sees a strong missing-material warning and can choose either `/portal/materials` or `继续提交，稍后补充`.
- Expected result after continue-submit: application is created under the current customer.
- Not allowed: choosing another customer, injecting customerId, or submitting unavailable vehicle/package.

## 4. Customer Profile Materials

- Entry: `/portal/materials`
- Prerequisite data: logged-in customer session.
- Operation: upload/replace/preview/archive 身份证人像面、身份证国徽面、驾驶证主页、驾驶证副页.
- Expected result: completeness shows completed/missing required items; previews use `/api/portal/profile/materials/:id/preview`.
- Not allowed: previewing another customer's profile materials; exposing OSS bucket/key/public URL; blocking application submission solely because profile materials are incomplete.

## 5. Upload Application Materials

- Entry: `/portal/applications/[id]`
- Prerequisite data: application requires material groups.
- Operation: upload required documents/images.
- Expected result: files appear in material list and preview works through `/api/portal/applications/:id/materials/:materialId/preview`.
- Not allowed: previewing another customer's file; exposing OSS bucket/key/public URL.

## 6. Back Office Reviews

- Entry: admin application workbench.
- Prerequisite data: submitted customer application.
- Operation: confirm customer profile materials reused into the application material table are visible and marked `客户资料中心`; complete material/product/credit/vehicle review.
- Expected result: Portal progress reflects review state.
- Not allowed: customer seeing internal review comments not intended for Portal.

## 7. Customer Views Progress

- Entry: `/portal/applications/[id]`
- Prerequisite data: reviewed or in-progress application.
- Operation: open detail and progress timeline.
- Expected result: steps, next action, and supplement hints are readable.
- Not allowed: `[object Object]`, `Internal Server Error`, or unrelated customer records.

## 8. Back Office Generates Final Plan

- Entry: admin application/final plan workflow.
- Prerequisite data: reviewed application.
- Operation: generate or update final plan.
- Expected result: Portal final plan becomes pending confirmation.
- Not allowed: Portal exposing internal pricing/cost fields beyond customer-facing final plan.

## 9. Customer Confirms Final Plan

- Entry: `/portal/applications/[id]`
- Prerequisite data: final plan pending confirmation.
- Operation: confirm or reject final plan.
- Expected result: status updates, action is audited, next step is clear.
- Not allowed: confirming another customer's plan or confirming after terminal state.

## 10. Back Office Generates Order And Contract

- Entry: admin order/contract workflow.
- Prerequisite data: confirmed final plan.
- Operation: generate order and contract.
- Expected result: Portal order and contract lists show the new records for that customer.
- Not allowed: customer seeing other customers' orders/contracts.

## 11. Customer Signs Contract

- Entry: `/portal/contracts/[id]`
- Prerequisite data: generated contract with pending mock e-sign task.
- Operation: start signing and complete mock sign when available.
- Expected result: sign task updates and contract status is visible.
- Not allowed: signing another customer's contract or exposing provider secrets.

## 12. Customer Pays

- Entry: `/portal/payment-orders/[id]` or payable bill action.
- Prerequisite data: payable bill/payment order.
- Operation: start payment using configured provider.
- Expected result: JSAPI payment path works in WeChat environment; mock path works where enabled.
- Not allowed: changing payment order ownership, bypassing payable amount, or exposing WeChat Pay certificates/keys.

## 13. Customer Checks Orders, Bills, Deposit, Entitlements

- Entry: `/portal/orders`, `/portal/bills`, `/portal/deposit`, `/portal/entitlements`
- Prerequisite data: active order with bills/deposit/entitlements.
- Operation: open list and detail pages.
- Expected result: records are scoped to current customer and amounts/statuses are readable.
- Not allowed: finance write-off internals, other customer records, internal collection notes.

## 14. Customer Views Order Vehicle Documents

- Entry: `/portal/orders/[id]`
- Prerequisite data: current customer's order vehicle has `customerVisible=true` vehicle documents such as vehicle license, compulsory policy, or commercial policy.
- Operation: open order detail and preview vehicle documents.
- Expected result: only current customer's order vehicle documents are listed; preview streams through Portal API.
- Not allowed: hidden documents, another customer's vehicle documents, `bucket`, `objectKey`, or OSS public URLs.

## 15. Customer Submits Accident Report

- Entry: `/portal/service-cases/new?type=ACCIDENT_REPORT`
- Prerequisite data: customer has order/vehicle if linked case is needed.
- Operation: submit accident report with attachments as needed.
- Expected result: service case is created and visible in `/portal/service-cases`.
- Not allowed: uploading files to another case or changing staff-only status fields.

## 16. Back Office Links Accident Case To Insurance Claim

- Entry: admin `/service-cases`
- Prerequisite data: submitted accident service case and optional vehicle insurance policy.
- Operation: create an insurance claim, set insurer claim number/status/amounts, and reopen the customer service-case detail.
- Expected result: back office sees the claim record and the customer sees a read-only claim summary.
- Not allowed: automatic bill generation, vehicle status changes, order status changes, or insurer API calls.

## 17. Customer Submits Rescue Request

- Entry: `/portal/service-cases/new?type=RESCUE_REQUEST`
- Prerequisite data: customer has contact/location information.
- Operation: submit rescue request.
- Expected result: rescue case is created and progress can be tracked.
- Not allowed: implying guaranteed arrival time or external vendor confirmation unless actually integrated.

## 18. Back Office Handles Service Case

- Entry: admin `/service-cases`
- Prerequisite data: submitted accident/rescue case.
- Operation: accept, update status, add note, close.
- Expected result: customer sees customer-safe timeline updates.
- Not allowed: exposing internal staff-only notes if not intended for Portal.

## 19. Back Office Maintains Insurance Policies And Vehicle Documents

- Entry: admin `/vehicle-insurance-policies` and vehicle detail.
- Prerequisite data: vehicle exists.
- Operation: create compulsory traffic and commercial policies with different effective dates, add coverage rows, upload policy/vehicle documents, set customer visibility, preview files, and archive old policies.
- Expected result: policies and documents are saved, previews stream through API, and expiring-within filters work.
- Not allowed: exposing OSS public URLs, automatically changing vehicle state, or generating charges.

## 20. Customer Views Notifications

- Entry: `/portal/notifications`
- Prerequisite data: in-app notification records exist.
- Operation: open notification center, mark single/all as read, click notification URL.
- Expected result: only current customer's notifications appear; unread/read state works.
- Not allowed: customer A seeing customer B notification; full openid in UI.

## 21. WeChat Service Account Menu Targets

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
