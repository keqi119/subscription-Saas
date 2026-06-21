# Stage 10L-A Vehicle Listing Product Page Foundation

## Goal

Stage 10L-A adds the minimum vehicle listing foundation needed for a richer customer-side vehicle product page.

The business posture is unchanged:

- Most vehicles are used vehicles.
- Each vehicle can have its own customer-facing condition summary.
- Customers still submit an application for review.
- Customers do not place an instant order from the catalog.
- Payment, contract, billing, entitlement, service-case, notification, and write-off flows are not changed by this stage.

## Used-Vehicle Display Policy

The customer-facing copy is intentionally framed as one-car-one-condition information instead of a full inspection report.

Stage 10L-A supports:

- Listing title, subtitle, selling points, and customer tags.
- Condition grade and short condition summary.
- Major accident, flood, fire, and structural-damage flags.
- Known-defect summary.
- Battery health percentage, check date, estimated range, and battery remarks.
- Fee description and application notice.
- Service highlights and FAQ snapshot.

Stage 10L-A does not claim to be a certified condition-report system.

## New Models

`VehicleListingProfile` stores the customer-facing listing profile for one vehicle.

Key fields:

- `listingStatus`
- `portalVisible`
- `displayName`
- `shortTitle`
- `subtitle`
- `sellingPoints`
- `customerTags`
- `conditionGrade`
- `conditionSummary`
- `batteryHealthPercent`
- `feeDescription`
- `applicationNotice`
- `faqSnapshot`

`VehicleListingMedia` stores private listing media metadata.

Key fields:

- `mediaCategory`
- `caption`
- `sortOrder`
- `isCover`
- `customerVisible`
- `bucket`
- `objectKey`

`VehicleListingPlan` optionally controls which active subscription plans are shown for a vehicle.

If no listing-plan configuration exists, the Portal catalog continues to fall back to the current active-plan matching behavior so beta traffic is not interrupted.

## Admin Configuration

Back-office vehicle detail now includes customer listing controls:

- Customer display profile.
- Listing media gallery.
- Display plan configuration.
- Customer preview link.

Publishing a listing profile sets `listingStatus=PUBLISHED`, `portalVisible=true`, and `publishedAt`.

Unpublishing sets `listingStatus=UNPUBLISHED`, `portalVisible=false`, and `unpublishedAt`.

This does not change the vehicle asset status or reserve the vehicle.

## Vehicle Gallery

Listing media is uploaded through the API and stored as private objects.

Object keys follow:

```text
vehicle-listings/{vehicleId}/{yyyy}/{uuid}-{filename}
```

Preview access streams through API routes. Customer responses never expose `bucket`, `objectKey`, or public OSS URLs.

The first version accepts image and ordinary document uploads and rejects video/audio uploads.

## Display Plans

The optional listing-plan configuration can:

- Select active subscription plans.
- Mark a plan as recommended.
- Control sort order.
- Override display monthly fee and display remarks.

Customer-side detail prefers configured visible plans. Without configuration, it falls back to existing active plans.

## Portal Catalog List

`GET /api/portal/catalog/vehicles` now returns richer safe listing fields when a published customer profile exists:

- `displayName`
- `shortTitle`
- `coverImageUrl`
- `customerTags`
- `sellingPoints`
- `conditionGrade`
- `conditionSummary`
- `batteryHealthPercent`
- `batteryHealthCheckedAt`
- `estimatedRangeKm`
- `hasMajorAccident`
- `hasFloodDamage`
- `hasFireDamage`
- `city`
- `mileageKm`
- `registrationDate`
- `monthlyFeeFromAmount`

Default behavior does not change the customer-visible vehicle set. `PORTAL_CATALOG_REQUIRE_PUBLISHED=true` can be used later to require a published listing profile.

## Portal Catalog Detail

`GET /api/portal/catalog/vehicles/:id` now includes:

- Gallery.
- Core highlights.
- One-car-one-condition summary.
- Battery and range information.
- Vehicle history summary.
- Subscription plans.
- Fee description.
- Application process.
- FAQ.
- Service highlights.

The customer action remains application submission.

## Sensitive Field Redaction

Portal catalog responses do not return:

- `purchasePriceAmount`
- `currentSalePriceAmount`
- Full VIN
- Full plate
- Financing, residual, cost, ROA, or ROE internals
- `bucket`
- `objectKey`
- OSS public URLs

Back-office APIs may return object metadata needed for administration, but customer APIs only return controlled preview URLs.

## Out Of Scope

Stage 10L-A intentionally does not include:

- Full `VehicleConditionReport`.
- Third-party inspection integration.
- 360 view.
- Video upload.
- AI image quality control.
- Publishing approval workflow.
- Changes to self-service application semantics.
- Direct order generation.
- Payment, write-off, WeChat Pay, contract, bill, entitlement, service-case, or notification main-flow changes.
- Production deployment.
- `prisma migrate reset`.
- `prisma db push`.

## Next Stage

Recommended next stage: Stage 10L-B, adding a formal vehicle condition-report model and customer report detail page.

Candidate models:

- `VehicleConditionReport`
- `VehicleConditionItem`
- Battery inspection details.
- Defect-location photos.
- Report publication state.
