# Stage 10X-Q VehicleModel Enum Removal Re-review

## 1. Background

Stage 10X-Q re-checks whether the frozen `VehicleModel` Prisma enum can be removed after the master-data and snapshot work completed in Stages 10X-K through 10X-P.

Completed prerequisites:

- `VehicleModelDefinition` is the master data source for new model codes.
- `Vehicle`, `VehiclePackage`, `ProductPriceRule`, Portal catalog, Reports, Residual market, curves, forecasts, and valuation review all support `modelDefinitionId`.
- New Vehicle / Product / Residual write paths reject legacy-only model input.
- Quote / Order now have immutable model snapshots and additive string code snapshots.
- `VehicleModel` enum is frozen by `pnpm vehicle-model:enum-freeze` and by CI.
- Stage 10X-P defined `VehicleModel` as read-only legacy compatibility.

This stage is audit-only. It does not modify schema, data, or business behavior.

## 2. Current Read-only Mode Status

The system is now in frozen read-only legacy mode:

- New operational writes are `modelDefinitionId` first.
- Legacy `vehicleModel` is still stored because several schema fields are enum-typed.
- System-derived writes from `modelDefinitionId -> legacyVehicleModel` still exist for compatibility fields.
- Legacy enum values are still returned in responses, CSV exports, report filters, snapshots, seeds, fixtures, and audit history.
- New vehicle models must be created through `VehicleModelDefinition`; the enum freeze guard blocks enum expansion.

## 3. Remaining Dependency Inventory

| Category | Current dependency | Classification |
| --- | --- | --- |
| Schema hard dependencies | `enum VehicleModel`, `Vehicle.vehicleModel`, `VehiclePackage.vehicleModel`, `ProductPriceRule.vehicleModel`, `SubscriptionQuote.vehicleModel`, `SubscriptionOrder.vehicleModel`, snapshot enum fields | Blocker |
| Active write dependencies | User-facing legacy-only writes are rejected for Vehicle, Product config, and Residual inputs | Closed |
| System-derived writes | Vehicle / Product config still derive `vehicleModel` from `modelDefinitionId` because enum fields remain in schema | Required while schema fields remain |
| Quote / Order creation | Quote still stores `vehicleModel`; direct price-rule quote path still accepts `CreateQuoteDto.vehicleModel` to find `ProductPriceRule` | API / business contract dependency |
| Read-only fallback | Reports, Portal/Admin display, CSV, labels, and matching fallback use legacy model values | Compatibility dependency |
| Historical snapshot | Quote / Order retain original `vehicleModel`, `legacyVehicleModelSnapshot`, and `legacyVehicleModelCodeSnapshot` | Audit dependency |
| Frontend labels | `VEHICLE_MODEL_LABELS` and read-only compatibility displays remain | Fallback/display dependency |
| Seed / fixtures | Seeds and tests still use enum values, generally with `modelDefinitionId` where new writes require it | Fixture dependency |
| CI / scripts | enum freeze guard parses `enum VehicleModel`; backfill scripts map via `legacyVehicleModel` | Governance dependency |

## 4. Active Write Path Review

| Entry point | Legacy-only input accepted? | Current behavior |
| --- | --- | --- |
| Vehicle create | No | Requires `modelDefinitionId`; derives `vehicleModel` from `VehicleModelDefinition.legacyVehicleModel`. |
| Vehicle update model change | No | Requires `modelDefinitionId`; rejects legacy-only `vehicleModel`; rejects clearing `modelDefinitionId`. |
| VehiclePackage create/update | No | Requires `modelDefinitionId` for model changes; derives `vehicleModel`. |
| ProductPriceRule create/update | No | Requires `modelDefinitionId` for model changes; derives `vehicleModel`. |
| Residual sample create/import | No | Requires `modelDefinitionId`; row-level import errors for missing modelDefinitionId. |
| Residual curve create/generate | No | Requires `modelDefinitionId`. |
| Residual target-specific model run | No | Requires `targetModelDefinitionId`; full runs may omit target. |
| Quote create, subscription plan path | Indirect | Uses selected vehicle / plan and freezes snapshots; still writes enum `vehicleModel`. |
| Quote create, component package path | Indirect | Uses selected package and freezes snapshots; still writes enum `vehicleModel`. |
| Quote create, direct price-rule path | Yes, as API contract | Requires `vehicleModel` to find active `ProductPriceRule`; this is a remaining business/API dependency. |
| Order create | No independent model input | Freezes Quote snapshot and writes enum `vehicleModel` from Quote. |
| Seed / scenario seed | Not user-facing | Direct Prisma writes still include enum compatibility fields and should continue pairing them with modelDefinitionId for new records. |

Conclusion: user-facing legacy-only writes for Vehicle / Product / Residual are closed. The remaining active dependency is the Quote direct price-rule path, plus system-derived writes required by existing enum columns.

## 5. Schema Hard Dependency Matrix

| Model | Enum field remains? | modelDefinitionId / string snapshot? | Can remove enum now? | Risk | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `Vehicle` | `vehicleModel VehicleModel?` | `modelDefinitionId` exists | No | High | Keep frozen; later deprecate column after API/report contract migration. |
| `VehicleModelDefinition` | `legacyVehicleModel VehicleModel? @unique` | `modelCode` string exists | No | High | Keep while mapping legacy rows and freeze guard depend on it. |
| `VehiclePackage` | `vehicleModel VehicleModel` | `modelDefinitionId` exists | No | High | Keep until product matching and historical package reads no longer require enum. |
| `ProductPriceRule` | `vehicleModel VehicleModel` | `modelDefinitionId` exists | No | High | Needs unique constraint migration before enum removal. |
| `SubscriptionQuote` | `vehicleModel VehicleModel`, `legacyVehicleModelSnapshot VehicleModel?` | model snapshot + code snapshot exist | No | High | Keep until quote contract and historical snapshot deprecation complete. |
| `SubscriptionOrder` | `vehicleModel VehicleModel`, `legacyVehicleModelSnapshot VehicleModel?` | model snapshot + code snapshot exist | No | High | Keep until order contract and historical snapshot deprecation complete. |
| `VehicleMarketPriceObservation` | No `VehicleModel` enum field | `modelDefinitionId` exists; legacy brand/series/model strings remain | Not blocked by enum | Low | Keep residual legacy strings for fallback. |
| `VehicleResidualCurve` | No `VehicleModel` enum field | `modelDefinitionId` exists; legacy brand/series/model strings remain | Not blocked by enum | Low | Keep legacy strings until residual mapping review. |
| `VehicleResidualForecast` | No `VehicleModel` enum field | `modelDefinitionId` exists | Not blocked by enum | Low | No enum blocker. |
| `ResidualModelRun` | No `VehicleModel` enum field | `targetModelDefinitionId` exists | Not blocked by enum | Low | No enum blocker. |

## 6. Snapshot Dependency Review

Quote / Order now have enough string snapshot data to explain model code in future displays:

- `modelDefinitionIdSnapshot`
- `modelDisplayNameSnapshot`
- `legacyVehicleModelCodeSnapshot`

However, enum fields still remain:

- `SubscriptionQuote.vehicleModel`
- `SubscriptionQuote.legacyVehicleModelSnapshot`
- `SubscriptionOrder.vehicleModel`
- `SubscriptionOrder.legacyVehicleModelSnapshot`

The string code snapshot is sufficient for additive historical explanation, but it is not yet sufficient to delete enum fields because:

- API responses still expose enum fields for compatibility.
- Tests and report queries still assert enum fields.
- Existing schema still requires original `vehicleModel` on Quote / Order.
- Order creation copies Quote enum values.
- Historical audits may still compare original enum field and snapshot field.

Recommended next step is not deletion. First deprecate enum snapshot reads and prove all displays, reports, and exports can rely on string code snapshot plus display snapshot.

## 7. ProductPriceRule Unique Constraint Review

`ProductPriceRule` still has:

```prisma
@@unique([productVersionId, vehicleModel])
```

This is one of the strongest blockers to enum removal.

Current implications:

- New rules require `modelDefinitionId`, but the database uniqueness guarantee is still based on `vehicleModel`.
- Seed code and Prisma callers still use the generated `productVersionId_vehicleModel` unique selector.
- Quote direct price-rule lookup still calls `findActivePriceRule(productVersionId, vehicleModel)`.
- Removing enum before migrating this constraint would break uniqueness, seed upserts, tests, and direct price-rule quotes.

Recommended Stage 10X-R:

- Add or migrate to a `productVersionId + modelDefinitionId` uniqueness strategy.
- Keep a transition-safe guard for legacy rows.
- Update direct quote lookup to use `modelDefinitionId` or selected package/rule id first.
- Keep `vehicleModel` as read-only fallback until all historical rules are covered.

Risk: High, because uniqueness affects pricing correctness.

## 8. Reports / CSV / API Contract Review

Reports and exports intentionally keep compatibility reads:

- Report DTOs still accept `vehicleModel` filters as deprecated compatibility input.
- Vehicle runtime reports use `modelDefinitionId` first but retain legacy fallback.
- Order reports use snapshot-mode display for historical order model names, but still group and filter some rows by `vehicleModel`.
- CSV exports include model display columns and legacy model columns.
- API responses still include `vehicleModel` on Vehicle, Product config, Quote, Order, and report rows.
- Frontend uses `VEHICLE_MODEL_LABELS` for fallback and compatibility displays.

These are not active-write blockers, but they are API contract blockers. Removing the enum now would be a breaking change for existing clients, CSV consumers, tests, and compatibility filters.

## 9. Can VehicleModel Enum Be Removed Now?

No.

Immediate removal is not recommended.

Blockers:

1. Schema fields still directly use `VehicleModel`.
2. `VehicleModelDefinition.legacyVehicleModel` still maps master data to legacy enum values.
3. `ProductPriceRule` uniqueness still depends on `vehicleModel`.
4. Quote direct price-rule creation still accepts `vehicleModel` as a business/API contract.
5. Quote / Order original `vehicleModel` and enum snapshot fields remain.
6. Reports / CSV / API responses still expose and filter by `vehicleModel`.
7. Frontend fallback labels and read-only displays still rely on legacy model codes.
8. Seeds, fixtures, and tests still use enum values.
9. The freeze guard itself depends on parsing `enum VehicleModel`.

## 10. Final Recommendation

Continue long-term frozen read-only legacy mode for now.

Recommended posture:

- Keep `VehicleModel` frozen and do not add enum values.
- Keep new writes `modelDefinitionId` first.
- Keep system-derived enum writes only where schema requires legacy compatibility fields.
- Continue returning legacy fields until API and report deprecation windows are complete.
- Do not attempt enum removal until ProductPriceRule uniqueness, Quote/Order contracts, report filters, and legacy schema columns have dedicated migration plans.

This is the safest production state: new business flows are on master data, while legacy enum remains a stable compatibility layer.

## 11. Follow-up Stages

| Stage | Goal | Migration? | Risk | Acceptance criteria | Recommended soon? |
| --- | --- | --- | --- | --- | --- |
| 10X-R ProductPriceRule uniqueness migration | Move pricing uniqueness and lookup from `vehicleModel` to `modelDefinitionId` without breaking historical rules. | Yes | High | New uniqueness is enforced by modelDefinitionId; direct quote lookup no longer depends on enum; legacy rows still readable. | Yes, if enum removal remains a goal. |
| 10X-S Quote / Order enum snapshot read deprecation | Make displays, CSV, and API docs prefer string code/display snapshots and mark enum snapshots deprecated. | Maybe later | Medium | No display path requires `legacyVehicleModelSnapshot`; compatibility fields remain but are documented as deprecated. | Yes, low-disruption docs/API step first. |
| 10X-T Vehicle / Product legacy enum column deprecation | Stop treating `Vehicle.vehicleModel`, `VehiclePackage.vehicleModel`, and `ProductPriceRule.vehicleModel` as canonical data. | Yes, later | High | Runtime reads can use modelDefinitionId; enum columns are read-only compatibility and no longer used for correctness. | Not until 10X-R is complete. |
| 10X-U Report legacy filter deprecation plan | Deprecate `vehicleModel` filters and document migration to `modelDefinitionId` / snapshot display fields. | No initially | Medium | Reports still support old filters during a deprecation window; new docs and UI default to modelDefinitionId only. | Yes, as an API lifecycle plan. |
| 10X-V Final enum removal dry-run | Simulate replacing/removing enum fields and freeze guard after all blockers are cleared. | Dry-run first, then yes | High | Generated client, migrations, seeds, tests, reports, and CSV all pass without `VehicleModel`. | No, only after R-U. |

## 12. Manual Confirmation Items

- Confirm whether direct price-rule quote creation should remain supported or be replaced by package / modelDefinition driven quote creation.
- Confirm external API consumers and CSV consumers can tolerate a staged deprecation of `vehicleModel`.
- Confirm whether historical Quote / Order enum fields are legally/audit required or can eventually be replaced by string snapshots.
- Confirm ProductPriceRule uniqueness semantics for model definitions that share a legacy enum value or have no legacy enum mapping.
- Confirm target timeline for report legacy filter deprecation.

## 13. No-op Confirmation

Stage 10X-Q is documentation-only:

- No Prisma schema changes.
- No migration.
- No data writes.
- No business logic changes.
- No changes to Vehicle, Product, Portal, Reports, Residual, Quote, Order, ROE, depreciation, BaaS, payment, write-off, billing, contract, or service-case behavior.
