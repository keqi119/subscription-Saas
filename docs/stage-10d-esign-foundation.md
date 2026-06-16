# Stage 10D-A Electronic Signature Foundation

> Date: 2026-06-16  
> Branch: `feature/stage10-esign-foundation`  
> Scope: e-sign task models, provider abstraction, mock provider, portal contract signing loop.

## 1. Goal

Stage 10D-A adds the electronic signature foundation after customer final-plan confirmation and back-office contract generation.

This stage intentionally does not connect a real provider. It introduces the task boundary, signer records, callback log, provider interface, and Mock provider so the customer portal can complete a test signing loop.

## 2. Existing Contract Baseline

Current contract capability is implemented in `apps/api/src/order`.

Existing behavior:

- `Contract` has `GENERATED`, `SIGNING`, `SIGNED`, `ARCHIVED`, `TERMINATED`, and `CANCELLED`.
- `ContractVersion` stores active templates and template content.
- Back office can generate, manually sign, archive, and cancel contracts.
- `generateContract` creates a `Contract` and moves the order to `PENDING_SIGN`.
- Existing manual `signContract` moves `Contract.status` to `SIGNED` and order status to `PENDING_PAYMENT`.
- There was no provider abstraction, signing task, signer record, callback log, or Portal contract API before this stage.

Stage 10D-A keeps the existing contract state enum unchanged.

## 3. Data Model

New models:

- `ContractESignTask`
- `ContractESignSigner`
- `ContractESignCallbackLog`

New enums:

- `ESignProviderType`: `MOCK`, `FADADA`, `ESIGN`, `TENCENT_ESIGN`, `OTHER`
- `ESignTaskStatus`: `CREATED`, `WAITING_CUSTOMER`, `SIGNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `EXPIRED`
- `ESignSignerType`: `CUSTOMER`, `PLATFORM`
- `ESignSignerStatus`: `PENDING`, `SIGNING`, `SIGNED`, `REJECTED`, `EXPIRED`

Migration:

- `20260616190000_contract_esign_tasks`

## 4. Provider Boundary

New module:

- `apps/api/src/esign`

Provider interface supports:

- `createSignTask`
- `getSignerUrl`
- `verifyCallback`

Current provider:

- `MockESignProvider`

The provider is selected by `ESIGN_PROVIDER`. Stage 10D-A only wires `mock`; real providers are reserved for Stage 10D-B.

## 5. Mock Provider

Mock behavior:

- Creates provider task id as `mock_<taskNo>`.
- Generates a Portal mock signing URL.
- Does not call external APIs.
- Allows `POST /api/portal/esign-tasks/:taskId/mock-sign` only when:
  - `ESIGN_PROVIDER=mock`
  - `ESIGN_MOCK_ENABLED=true`

Production examples keep mock disabled by default.

## 6. Back-Office APIs

New APIs:

- `POST /api/contracts/:id/esign-tasks`
- `GET /api/contracts/:id/esign-tasks`
- `GET /api/esign-tasks/:id`
- `POST /api/esign/callback/:provider`

Permissions:

- Start task: `contract:sign`
- Query task: `contract:view`
- Callback endpoint is public, records every callback log, verifies through provider, and handles idempotently.

Task creation rules:

- Contract must exist and be the current contract of its order.
- Contract status must be `GENERATED` or `SIGNING`.
- Existing active/completed e-sign task is returned instead of creating a duplicate.
- Starting e-sign moves `Contract.status` from `GENERATED` to `SIGNING`.

## 7. Portal APIs

New protected Portal APIs:

- `GET /api/portal/contracts`
- `GET /api/portal/contracts/:id`
- `POST /api/portal/contracts/:id/signing/start`
- `POST /api/portal/esign-tasks/:taskId/mock-sign`

Guard:

- `CustomerAuthGuard`

Ownership:

- All contract and task reads/writes are filtered by `currentCustomer.customerId`.
- Admin tokens cannot satisfy customer portal auth.
- Portal DTOs do not return contract template internals, purchase price, full VIN, full plate, cost, residual, or financing fields.

## 8. H5 Pages

New Portal routes:

- `/portal/contracts`
- `/portal/contracts/[id]`
- `/portal/contracts/[id]/sign`

The mock signing page clearly states that it is only for testing and that real provider integration will redirect to a third-party signing page.

## 9. Completion Effects

Mock signing and completed callbacks:

- Mark customer signer as `SIGNED`.
- Mark e-sign task as `COMPLETED`.
- Write callback log.
- Update `Contract.status = SIGNED`.
- Write `Contract.signedAt`.
- Move current order from `PENDING_SIGN` to `PENDING_PAYMENT`.

This mirrors the existing manual signing outcome without changing order creation or quote logic.

## 10. Not In Scope

This stage does not implement:

- Real FaDaDa / e签宝 / 上上签 / Tencent eSign provider.
- Real-name authentication or face verification.
- Real third-party callback signature rules.
- Payment or billing.
- Contract PDF rendering/evidence archive.
- Automatic order creation.
- Production deployment.

## 11. Next Stage

If a provider is selected, continue to Stage 10D-B for the real provider adapter.

If the business wants the payment foundation first, continue to Stage 10E-A for payment order and WeChat Pay provider abstraction.
