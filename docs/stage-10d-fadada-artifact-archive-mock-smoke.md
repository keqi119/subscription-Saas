# Stage 10D-B4-B Fadada Artifact Archive Mock Smoke

> Date: 2026-06-25
> Branch: `feature/stage10-fadada-artifact-archive-mock-smoke`
> Scope: mocked provider payload smoke for signed PDF archive, idempotency, admin/Portal stream guards, and no-side-effect checks.

## 1. Goal

Stage 10D-B4-B verifies the signed PDF archive chain with a controlled local fixture and mocked Fadada transport.

This smoke did not call real Fadada APIs, did not upload or download a real provider PDF, did not call real `contractFiling.api`, did not add a Prisma migration, and did not modify contract/order/payment business logic.

## 2. Sample Contract And Task

The smoke uses an in-memory test fixture from `apps/api/test/fadada-archive.spec.ts`.

| Field | Smoke value |
| --- | --- |
| Contract | present, masked test fixture |
| Contract status | `SIGNED` |
| E-sign task | present, masked test fixture |
| Provider | `FADADA` |
| Task status | `COMPLETED` |
| Provider contract id | present, masked |
| Provider transaction id | present, masked |
| Order status | `PENDING_PAYMENT` |
| Persistence | in-memory test fixture only; no dev/staging/production row created |

The fixture is explicitly test-only and contains no real customer name, ID number, phone number, VIN, license plate, policy number, or production contract terms.

## 3. Test PDF

The signed PDF payload is generated in memory.

| Check | Result |
| --- | --- |
| Content type | `application/pdf` |
| Magic bytes | `%PDF-` |
| Size | 48 bytes |
| Storage | mocked private `StorageService` |
| Git artifact | not committed |

## 4. Mock Provider Payload

Mocked Fadada client behavior:

| Method | Mock result |
| --- | --- |
| `querySignResult` | `resultCode=3000`, provider download URL present and masked |
| `queryContractStatus` | signed/completed status fixture available |
| `downloadSignedContract` | returns the in-memory PDF buffer |
| `createContractFiling` | returns accepted filing fixture |

No request was sent to `testapi.fadada.com`, and no full provider response or URL was written to the report.

## 5. Archive Result

Archive execution path:

1. Load completed Fadada `ContractESignTask`.
2. Query mocked sign result.
3. Download mocked signed PDF.
4. Validate PDF magic bytes.
5. Store through mocked private `StorageService`.
6. Update `signedDocumentObjectKey`.
7. Record sanitized archive snapshot.
8. Leave `evidenceObjectKey` unchanged.

Result:

| Check | Result |
| --- | --- |
| Archive service | passed |
| `signedDocumentObjectKey` | present |
| `evidenceObjectKey` | empty; independent evidence report API remains TODO |
| Provider URL redaction | passed; raw URL token not present in snapshot |
| Private storage object | present through mocked storage |

## 6. Idempotency

| Scenario | Result |
| --- | --- |
| Existing signed PDF + `force=false` | skipped with `SIGNED_PDF_ALREADY_ARCHIVED`; object key unchanged |
| Existing signed PDF + `force=true` | archived again; object key changed to a new private artifact reference |
| Evidence artifact | not generated or faked |

## 7. Admin Stream

Admin signed PDF preview was verified through `FadadaSignedArtifactService.getAdminSignedContractPreview`.

| Check | Result |
| --- | --- |
| Authorized admin preview | passed |
| Content type | `application/pdf` |
| PDF stream source | mocked private storage |
| Object key exposure | not exposed on preview DTO |
| Provider URL exposure | not exposed |

The live HTTP endpoint is implemented in B4 as `GET /api/esign-tasks/:id/signed-contract/preview`. B4-B did not start a live API server because this smoke is intentionally service-level and transport-mocked.

## 8. Portal Stream

Portal signed PDF preview was verified through `FadadaSignedArtifactService.getPortalSignedContractPreview`.

| Scenario | Result |
| --- | --- |
| Owning customer | passed |
| Other customer | 404-style `NotFoundException` |
| Missing cookie / unauthenticated request | covered by `CustomerAuthGuard` test; rejects unauthenticated portal requests |
| Object key exposure | not exposed on preview DTO |
| Provider URL exposure | not exposed |

No controlled customer browser cookie was used in this smoke. The live Portal endpoint remains `GET /api/portal/contracts/:id/signed-document/preview` and is guarded by `CustomerAuthGuard`.

## 9. State Unchanged Check

The archive service did not modify:

| Field | Result |
| --- | --- |
| `Contract.status` | unchanged |
| `Contract.signedAt` | unchanged |
| `SubscriptionOrder.orderStatus` | unchanged |
| E-sign task status | unchanged |

## 10. Finance Unchanged Check

The smoke fixture snapshots finance-adjacent records before and after archive.

| Area | Result |
| --- | --- |
| `PaymentOrder` count/status/amount | unchanged |
| `PaymentRecord` count/status/amount | unchanged |
| `PaymentWriteOff` count/amount | unchanged |
| `ReceivableBill` count/status/amount | unchanged |

The archive flow did not touch payment, billing, write-off, ROE, BaaS, or depreciation logic.

## 11. Verification

Targeted smoke command:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/fadada-archive.spec.ts test/portal-auth.spec.ts
```

Result:

```text
Test Files  2 passed (2)
Tests       27 passed (27)
```

Full release verification is recorded in the branch completion output.

## 12. Blockers

B4-B passed as a mocked archive smoke, but full real signing validation remains blocked by the B2-B sandbox gates:

- sandbox `FADADA_APP_ID` / `FADADA_APP_SECRET` not recorded as present;
- enterprise `customer_id` not recorded as present;
- customer `customer_id` flow not confirmed by real sandbox;
- `signature_id` / auto-seal strategy not confirmed;
- `uploaddocs.api` sandbox smoke not passed;
- `extsign_validation.api` sandbox smoke not passed;
- real notify/return URLs not confirmed for smoke.

## 13. Gate Decision

B4-B mock archive smoke: **passed**.

Code-side Fadada preparation now covers upload/sign URL prep, callback verification/idempotency, signed PDF archive, and mocked archive smoke.

Do not enter Stage 10D-B5 full real signing validation until the B2-B sandbox blockers are closed.

## 14. B2-B-R1 Upload/SignUrl Smoke Update

Stage 10D-B2-B-R1 is recorded in `docs/stage-10d-fadada-sandbox-upload-signurl-smoke.md`.

Current result: guarded smoke script added and executed in preflight mode only. No real Fadada call occurred because `FADADA_ENABLED=true` and `FADADA_SANDBOX_SMOKE=1` were not enabled in the local ignored env file.
