# Stage 10D-C2 Fadada Real-Name Verification Lifecycle

Stage 10D-C2 automates the real-name lifecycle for the formal `CustomerESignProviderAccount` binding introduced in Stage 10D-C1-A.

## Goal

Move `realNameStatus` from manual-only bookkeeping to a provider-driven lifecycle:

```text
CustomerESignProviderAccount
-> get_person_verify_url.api
-> Fadada real-name page
-> verify callback or status query
-> apply_cert.api
-> REGISTERED + VERIFIED binding usable by signing resolver
```

This stage does not open unrestricted production e-sign. It only prepares the lifecycle automation.

## Schema

No schema change is required.

Stage 10D-C1-A already added the fields needed for C2:

```text
realNameStatus
verificationSerialNo
verificationTransactionNo
verifiedAt
providerSnapshot
lastErrorCode
lastErrorMessage
```

No migration is added in C2, and no production migration is executed.

## Runtime Gates

Real-name provider calls are guarded by:

```env
FADADA_REALNAME_VERIFY_ENABLED=false
```

Default behavior is disabled. When disabled, the service refuses:

- `get_person_verify_url.api`;
- `find_personCertInfo.api`;
- `apply_cert.api`.

All C2 tests use mocked Fadada transport. No real Fadada request is made by default.

## Admin API

C2 extends the C1-A provider account API:

```text
POST /api/customers/:id/esign-provider-accounts/fadada/real-name-verification
POST /api/customers/:id/esign-provider-accounts/fadada/real-name-status/refresh
POST /api/customers/:id/esign-provider-accounts/fadada/apply-cert
```

Permissions:

```text
customer:manage
```

The verification start request accepts real-name fields as request input only:

```text
name
idCardNo
mobile
```

These values are passed to Fadada when the gate is enabled, but they are not stored in the binding table and are not returned in API responses.

## Verify URL Flow

`startFadadaPersonalRealNameVerification` requires:

```text
registrationStatus=REGISTERED
providerCustomerId present
realNameStatus != VERIFIED
FADADA_REALNAME_VERIFY_ENABLED=true
FADADA_VERIFY_NOTIFY_URL present
FADADA_VERIFY_RETURN_URL present
```

On success:

```text
realNameStatus=PENDING
verificationTransactionNo=<provider transactionNo>
verificationSerialNo=<provider transactionNo>
providerSnapshot=sanitized
```

The API returns only a masked verification URL:

```text
https://verify.example.test/...
```

The full provider URL is not stored or returned by this backend API.

## Verify Callback

C2 adds:

```text
POST /api/esign/callback/fadada/verify
```

The verify callback:

- verifies the Fadada digest before looking up the binding;
- finds the binding by `verificationTransactionNo` or `verificationSerialNo`;
- updates only `CustomerESignProviderAccount.realNameStatus`;
- is idempotent;
- never calls signing code;
- never queries or advances Contract / Order;
- never creates PaymentRecord / PaymentWriteOff;
- never mutates ReceivableBill.

Invalid digest behavior:

```text
handled=false
reason=UNVERIFIED
```

No business state is updated.

## Status Refresh

`refreshFadadaRealNameStatus` calls:

```text
find_personCertInfo.api
```

using the stored `verificationSerialNo`.

Provider result mapping:

```text
2 / verified / success -> VERIFIED
failed / rejected -> FAILED
expired -> EXPIRED
unknown -> PENDING
```

`VERIFIED` is terminal and is not downgraded by later callback/query results.

## apply_cert Flow

`applyFadadaPersonalCert` requires:

```text
registrationStatus=REGISTERED
providerCustomerId present
realNameStatus=VERIFIED
verificationSerialNo present
FADADA_REALNAME_VERIFY_ENABLED=true
```

It calls:

```text
apply_cert.api
```

with:

```text
customer_id=<providerCustomerId>
verified_serialno=<verificationSerialNo>
```

The provider response is sanitized before being stored in `providerSnapshot`.

## State Machine

Allowed automatic transitions:

```text
UNVERIFIED -> PENDING
PENDING -> VERIFIED
PENDING -> FAILED
PENDING -> EXPIRED
FAILED -> PENDING
FAILED -> VERIFIED
EXPIRED -> PENDING
```

Terminal rule:

```text
VERIFIED cannot be downgraded by callback or status query.
```

The existing C1-A manual status endpoint remains an admin override, not the normal lifecycle path.

## Security Boundary

C2 does not:

- upload contracts;
- generate or open sign URLs;
- call `uploaddocs.api`;
- call `extsign_validation.api`;
- call `extsign_auto.api`;
- call archive/download APIs;
- advance Contract / Order;
- create PaymentRecord;
- create PaymentWriteOff;
- mutate ReceivableBill;
- deploy production;
- execute production seed;
- execute production migration.

No ID card number, real name, mobile, full provider customer id, full verify URL, app secret, provider raw response, or PDF binary is committed.

## Next Stage

Stage 10D-C2-B should be a separately approved controlled real-name integration test:

```text
enable FADADA_REALNAME_VERIFY_ENABLED for a controlled tester only
generate verify URL
complete real-name page
receive callback or refresh status
apply_cert
confirm REGISTERED + VERIFIED binding
do not sign unless separately approved
```

Unrestricted production e-sign remains **No-Go** until the real-name integration test and operational controls pass.
