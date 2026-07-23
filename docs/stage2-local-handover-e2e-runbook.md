# Stage 2 Local Handover E2E Runbook

## Scope

This runbook validates the local Stage 2 handover path after field evidence capture and Portal customer review are available. It is a local-first test harness only.

It does not generate Stage 2 PDF files, create contracts, start eSign, call Fadada, call SMS or WeChat providers, confirm delivery, start lease, or start billing.

## Local Harness

API test:

- `apps/api/test/stage2-handover-e2e.spec.ts`

The API harness uses synthetic in-memory data and mocked Prisma/storage/evidence collaborators. It covers:

- external field operator starts the handover work order;
- field facts are captured;
- required evidence files are attached with safe synthetic `fileId` records;
- no-visible-damage declaration is recorded;
- field evidence is submitted to customer review;
- Portal customer lists and opens the submitted review;
- Portal customer sees safe evidence preview/download links;
- Portal customer confirms no objection;
- Portal customer submits an objection on a fresh fixture;
- Admin acknowledges the objection, requests field resubmission, and sends the resubmitted evidence back to Portal review;
- unauthorized customer and field-session boundary checks;
- terminal and already-confirmed/objected state checks;
- no PDF/eSign/provider/delivery/lease/billing side effects.

Web test:

- `apps/web/test/stage2-handover-ui-flow.spec.ts`

The Web harness uses mocked `fetch` calls only. It covers:

- field submit API boundary and submitted/locked capture view;
- Portal list/detail/confirm API boundary;
- Portal evidence file viewing boundary;
- Portal objection API boundary;
- Admin Stage 2 handover review entry and objection action boundary;
- acknowledgement/object reason view-model behavior;
- source-level absence of PDF, eSign, delivery confirmation, payment, or billing controls;
- view-model serialization that excludes object storage, signing URL, token/cookie, identity, provider, and finance internals.

## Readiness Expectations

Before field submit:

- field readiness is blocked by incomplete field facts/evidence;
- Stage 2 PDF/eSign readiness is false.

After field submit:

- the work order is customer-reviewable;
- Portal review is visible only to the owning customer;
- Stage 2 PDF/eSign readiness is still false because the customer has not confirmed no objection.

After customer confirmation:

- the work order moves to customer-confirmed;
- Stage 2 PDF/eSign readiness is true;
- no PDF, eSign task, provider call, delivery confirmation, lease, or billing side effect is created.

After customer objection:

- the work order moves to customer-objected;
- Stage 2 PDF/eSign readiness remains false;
- the blocker requires Admin follow-up;
- no PDF, eSign task, provider call, delivery confirmation, lease, or billing side effect is created.

After Admin-requested field resubmission:

- the field operator can edit the objected task again;
- resubmission keeps the work order customer-objected and marks admin review `RESUBMITTED_PENDING_ADMIN`;
- Portal confirmation remains blocked until Admin sends the resubmitted evidence back to customer review;
- sending back creates the next review attempt and returns the work order to customer-reviewing.

## Local Commands

Focused API harness:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/stage2-handover-e2e.spec.ts
```

Focused Web harness:

```bash
pnpm --filter @subscription-saas/web exec vitest run test/stage2-handover-ui-flow.spec.ts
```

Full verification for this phase:

```bash
pnpm --filter @subscription-saas/api prisma:validate
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api exec vitest run test/stage2-handover-e2e.spec.ts test/portal-handover-review.spec.ts test/field-operator-auth.spec.ts test/handover-work-order.spec.ts test/delivery-evidence.spec.ts
pnpm --filter @subscription-saas/api exec vitest run test/portal-auth.spec.ts test/order-delivery.spec.ts test/esign.spec.ts test/order-contract.spec.ts
pnpm --filter @subscription-saas/api build
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web build
```

## Staging Smoke Boundary

Staging smoke should run only after a combined API/Web deployment. The deployed Web API base must point to the public H5/API domain used by that environment; staging validation must not rely on a local loopback API or port 3001.

The staging smoke should cover one controlled field evidence capture path and one Portal customer review path. It should still avoid Fadada, Stage 2 PDF/eSign, real SMS, WeChat, delivery confirmation, lease, and billing until those later phases are explicitly enabled.

## Open Items

- Stage 2 PDF renderer;
- Stage 2 provider mapping and eSign;
- Admin void/escalation handling beyond resubmission/send-back;
- audit timezone cleanup.
