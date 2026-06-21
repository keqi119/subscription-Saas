# Stage 10L-B Vehicle Condition Report Foundation

## Goal

Stage 10L-B adds a formal customer-visible vehicle condition report foundation on top of the Stage 10L-A listing profile and gallery.

The customer flow remains unchanged:

- Customers review vehicle information before submitting an application.
- The Portal action is still `提交审核`.
- The system does not create an order, contract, bill, or payment record from the report page.

## Report Policy

The report represents the vehicle condition at the inspection time. Customer-facing copy must avoid implying that the condition can never change after inspection.

The Portal report page includes the disclaimer:

```text
检测信息仅反映检测时点车辆状况，车辆实际状况可能随使用发生变化；最终以交付验收和合同约定为准。
```

## New Models

`VehicleConditionReport` stores one formal condition report for a vehicle.

Key fields:

- `reportNo`
- `reportStatus`
- `customerVisible`
- `inspectionDate`
- `inspectorName`
- `inspectorOrg`
- `odometerKm`
- `overallGrade`
- accident/flood/fire/structural flags
- section summaries
- battery health, cycle count, check date, estimated range, warranty date
- safety conclusion
- repair suggestion
- customer summary

`VehicleConditionReportItem` stores report items.

Key fields:

- `area`
- `itemType`
- `severity`
- `result`
- `partName`
- `title`
- `description`
- `affectsSafety`
- `repairRequired`
- `customerVisible`
- `mediaIds`
- `sortOrder`

`mediaIds` stores `VehicleListingMedia.id` values in the first version. Items can only reference media from the same vehicle that is not deleted and is customer-visible.

## Battery Inspection

The first version supports:

- SOH / health percentage.
- Cycle count.
- Battery check date.
- Estimated range.
- Warranty-until date.
- Battery remarks.

It does not integrate with battery diagnostic hardware or third-party inspection APIs.

## Defect Photos

Defect photos reuse the Stage 10L-A `VehicleListingMedia` gallery. This avoids a second upload path and keeps previews behind the existing API stream route.

Portal report responses map media IDs to:

```text
/api/portal/catalog/vehicles/:id/media/:mediaId/preview
```

Portal report responses never expose `bucket`, `objectKey`, or OSS public URLs.

## Back Office

Back-office vehicle detail now has a `车况报告` section in the customer listing area.

Supported actions:

- List reports.
- Create a draft report.
- Edit report basics, accident flags, battery inspection, section summaries, safety conclusion, and repair suggestion.
- Add, edit, and soft-delete report items.
- Link report items to current vehicle listing media.
- Publish a report.
- Archive a report.

Publishing a report sets `reportStatus=PUBLISHED`, `customerVisible=true`, and `publishedAt`. When a new report is published, old published reports for the same vehicle are archived.

Archiving a report sets `reportStatus=ARCHIVED`, `customerVisible=false`, and `archivedAt`.

## Portal

`GET /api/portal/catalog/vehicles/:id` now reads the latest published customer-visible condition report when present.

If a formal report exists, it overrides the 10L-A listing profile condition and battery summary. If no formal report exists, the Portal continues to use the listing profile fallback.

`GET /api/portal/catalog/vehicles/:id/condition-report` returns the latest published customer-visible report and customer-visible items.

The H5 route `/portal/catalog/[id]/condition-report` displays:

- Report header.
- Accident checks.
- Battery inspection.
- Grouped report items.
- Defect photos.
- Safety conclusion.
- Repair suggestion.
- Return to vehicle detail / submit-review entry.

## Redaction

Portal report APIs do not return:

- `purchasePriceAmount`
- `currentSalePriceAmount`
- Full VIN
- Full plate
- Internal cost
- Financing
- Residual forecast internals
- ROE
- `bucket`
- `objectKey`
- `createdBy`
- `updatedBy`
- `deletedAt`

## Out Of Scope

Stage 10L-B does not include:

- Third-party inspection API integration.
- AI inspection.
- Video inspection.
- 360 view.
- Repair work-order automation.
- Automatic vehicle asset status changes.
- Automatic bill generation.
- Order, contract, payment, write-off, bill, entitlement, service-case, or notification main-flow changes.
- WeChat Pay provider changes.
- SMS or notification main-flow changes.
- Production deployment.
- `prisma migrate reset`.
- `prisma db push`.

## Next Stage

Recommended next options:

- Stage 10L-C: vehicle product-page experience polish, comparison, and operation recommendations.
- Stage 10L-B-R1: manual acceptance and sample data completion for real beta vehicles.
