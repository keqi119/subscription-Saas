# Stage 10D-C2-B Fadada Real-Name Integration Test

Stage 10D-C2-B validates the real-name lifecycle integration boundary introduced by Stage 10D-C2.

This is a local mocked integration validation. It does not enable production real-name verification, does not call Fadada, and does not create or open a signing URL.

## Scope

Validated path:

```text
registered provider account
-> get_person_verify_url mocked
-> verify callback mocked
-> realNameStatus state machine
-> apply_cert mocked
-> REGISTERED + VERIFIED binding usable by Fadada signer resolver
```

Out of scope:

```text
production Fadada API call
production DB write
contract upload
sign URL generation
manual signing
Contract / Order advancement
PaymentRecord / PaymentWriteOff
ReceivableBill mutation
production deploy
```

## Real-Name Flow Validation

Result: passed.

The account service tests validate:

- `FADADA_REALNAME_VERIFY_ENABLED=false` blocks real-name provider calls;
- `get_person_verify_url` can move a registered binding to `PENDING`;
- request-only PII fields are not stored in the binding snapshot;
- the returned verification URL is masked;
- verified callbacks update `realNameStatus=VERIFIED`;
- duplicate verified callbacks are idempotent;
- invalid callback digest returns `handled=false` / `UNVERIFIED` and does not update account state;
- `find_personCertInfo` refresh can update the binding to `VERIFIED`;
- `apply_cert` is callable only after `VERIFIED` and stores a sanitized provider snapshot.

## State Machine Validation

Result: passed.

Covered transitions:

```text
UNVERIFIED -> PENDING
PENDING -> VERIFIED
PENDING -> FAILED
PENDING -> EXPIRED
VERIFIED -> VERIFIED
```

Terminal rule:

```text
VERIFIED cannot be downgraded by later failed or expired callbacks.
```

## Resolver And Signing Readiness

Result: passed.

The Fadada signer resolver path validates:

- `REGISTERED + VERIFIED` binding is queried before smoke override;
- the formal binding provider customer id is used when present;
- smoke override is used only in non-production when `FADADA_FULL_SIGNING_SMOKE=1` and the local customer matches the allowlisted test customer;
- with smoke disabled, missing or unverified binding fails before PDF artifact lookup, upload, or sign URL request.

This confirms signing readiness:

```text
realNameStatus=VERIFIED -> eligible for Fadada createSignTask resolver
realNameStatus!=VERIFIED -> rejected unless explicit smoke gate is enabled
```

## Callback Correctness

Result: passed.

The real-name verify callback:

- verifies digest before account lookup;
- finds account by verification transaction / serial number;
- updates only `CustomerESignProviderAccount`;
- does not call signing code;
- does not query or advance Contract / Order;
- does not create payment records;
- is idempotent.

## Safety Boundary

No real external or production side effects were performed:

```text
Fadada real API calls: no
uploadDocs: no
extsign_validation: no
extsign_auto: no
signUrl generated/opened: no
signing: no
Contract / Order advancement: no
PaymentRecord / PaymentWriteOff: no
ReceivableBill mutation: no
production DB write: no
production deploy: no
production migration / seed: no
```

No PII, app secret, full provider customer id, full verification URL, provider raw response, or PDF binary is recorded in this report.

## Gate Result

Stage 10D-C2-B result:

```text
Controlled real-name integration boundary: passed
Signing readiness with VERIFIED binding: passed
Smoke override still gated: yes
Production smoke fallback: hard rejected
Unrestricted production e-sign launch: No-Go
```

The next stage can be:

```text
Stage 10D-C2-C production readiness for real-name system
```

or, with separate approval:

```text
Controlled production real-name verification test for one tester
```
