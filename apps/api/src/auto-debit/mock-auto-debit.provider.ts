import { createHash } from "node:crypto";

import {
  CreateMandateProviderInput,
  DebitProviderResult,
  DebitProviderStatus,
  MandateDebitProvider,
  MandateProviderResult,
  ProviderSnapshot,
  QueryDebitProviderInput,
  QueryMandateProviderInput,
  RevokeMandateProviderInput,
  SubmitDebitProviderInput,
  VerifyAutoDebitCallbackResult
} from "./auto-debit-provider";

type MockDebitResolution = Exclude<DebitProviderStatus, "PROCESSING">;

export class MockAutoDebitProvider implements MandateDebitProvider {
  async createMandate(
    input: CreateMandateProviderInput
  ): Promise<MandateProviderResult> {
    const providerMandateId = stableId("mock-mandate", input.mandateNo);
    const signedAt = new Date();
    const providerSnapshot: ProviderSnapshot = {
      effectiveAt: signedAt.toISOString(),
      kind: "mock-mandate",
      mandateNo: input.mandateNo,
      providerMandateId,
      signedAt: signedAt.toISOString(),
      status: "ACTIVE"
    };

    return {
      effectiveAt: signedAt,
      providerMandateId,
      providerSnapshot,
      signedAt,
      status: "ACTIVE"
    };
  }

  async queryMandate(
    input: QueryMandateProviderInput
  ): Promise<MandateProviderResult> {
    const snapshot = mandateSnapshot(input);
    return mandateResult(snapshot);
  }

  async revokeMandate(
    input: RevokeMandateProviderInput
  ): Promise<MandateProviderResult> {
    const current = mandateSnapshot(input);
    const revokedAt = new Date();
    const snapshot = {
      ...current,
      revokedAt: revokedAt.toISOString(),
      status: "REVOKED"
    };
    return {
      ...mandateResult(snapshot),
      providerSnapshot: snapshot,
      status: "REVOKED"
    };
  }

  async submitDebit(
    input: SubmitDebitProviderInput
  ): Promise<DebitProviderResult> {
    const providerTransactionId = stableId(
      "mock-transaction",
      input.providerOutTradeNo
    );
    const providerSnapshot: ProviderSnapshot = {
      amount: input.amount.toString(),
      currency: input.currency,
      kind: "mock-debit",
      providerMandateId: input.providerMandateId,
      providerOutTradeNo: input.providerOutTradeNo,
      providerTransactionId,
      status: "PROCESSING",
      subject: input.subject
    };

    return {
      confirmedAmount: 0n,
      providerOutTradeNo: input.providerOutTradeNo,
      providerSnapshot,
      providerTransactionId,
      status: "PROCESSING"
    };
  }

  async queryDebit(
    input: QueryDebitProviderInput
  ): Promise<DebitProviderResult> {
    const snapshot = debitSnapshot(input);
    const nextResult = snapshot.nextResult;
    const status = isMockResolution(nextResult) ? nextResult : "PROCESSING";
    const confirmedAmount =
      status === "SUCCEEDED" ? BigInt(snapshot.amount) : 0n;
    const resolvedAt = status === "PROCESSING" ? undefined : new Date();
    const providerSnapshot = {
      ...snapshot,
      ...(resolvedAt ? { resolvedAt: resolvedAt.toISOString() } : {}),
      status
    };

    return {
      confirmedAmount,
      providerOutTradeNo: snapshot.providerOutTradeNo,
      providerSnapshot,
      providerTransactionId: snapshot.providerTransactionId,
      resolvedAt,
      status
    };
  }

  withNextDebitResult(
    providerSnapshot: ProviderSnapshot,
    nextResult: MockDebitResolution
  ): ProviderSnapshot {
    const snapshot = debitSnapshot({
      providerOutTradeNo: stringField(
        providerSnapshot,
        "providerOutTradeNo",
        "MOCK_DEBIT_SNAPSHOT_INVALID"
      ),
      providerSnapshot,
      providerTransactionId: stringField(
        providerSnapshot,
        "providerTransactionId",
        "MOCK_DEBIT_SNAPSHOT_INVALID"
      )
    });
    return { ...snapshot, nextResult };
  }

  async verifyCallback(payload: unknown): Promise<VerifyAutoDebitCallbackResult> {
    if (!isRecord(payload)) {
      return { payload, verified: false };
    }
    const status = payload.status;
    return {
      payload,
      providerOutTradeNo:
        typeof payload.providerOutTradeNo === "string"
          ? payload.providerOutTradeNo
          : undefined,
      providerTransactionId:
        typeof payload.providerTransactionId === "string"
          ? payload.providerTransactionId
          : undefined,
      status: isDebitStatus(status) ? status : undefined,
      verified: payload.mockVerified === true && isDebitStatus(status)
    };
  }
}

function mandateSnapshot(input: QueryMandateProviderInput) {
  const snapshot = input.providerSnapshot;
  if (
    snapshot.kind !== "mock-mandate" ||
    snapshot.providerMandateId !== input.providerMandateId
  ) {
    throw new Error("MOCK_MANDATE_SNAPSHOT_INVALID");
  }
  return snapshot;
}

function mandateResult(snapshot: ProviderSnapshot): MandateProviderResult {
  const status = snapshot.status;
  if (!isMandateStatus(status)) {
    throw new Error("MOCK_MANDATE_SNAPSHOT_INVALID");
  }
  return {
    effectiveAt: optionalDate(snapshot.effectiveAt),
    expiresAt: optionalDate(snapshot.expiresAt),
    providerMandateId: stringField(
      snapshot,
      "providerMandateId",
      "MOCK_MANDATE_SNAPSHOT_INVALID"
    ),
    providerSnapshot: snapshot,
    signedAt: optionalDate(snapshot.signedAt),
    status
  };
}

function debitSnapshot(input: QueryDebitProviderInput) {
  const snapshot = input.providerSnapshot;
  if (
    snapshot.kind !== "mock-debit" ||
    snapshot.providerOutTradeNo !== input.providerOutTradeNo ||
    (input.providerTransactionId &&
      snapshot.providerTransactionId !== input.providerTransactionId)
  ) {
    throw new Error("MOCK_DEBIT_SNAPSHOT_INVALID");
  }
  return {
    ...snapshot,
    amount: stringField(snapshot, "amount", "MOCK_DEBIT_SNAPSHOT_INVALID"),
    nextResult: snapshot.nextResult,
    providerOutTradeNo: stringField(
      snapshot,
      "providerOutTradeNo",
      "MOCK_DEBIT_SNAPSHOT_INVALID"
    ),
    providerTransactionId: stringField(
      snapshot,
      "providerTransactionId",
      "MOCK_DEBIT_SNAPSHOT_INVALID"
    )
  };
}

function stableId(prefix: string, value: string) {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 24);
  return `${prefix}-${digest}`;
}

function stringField(
  value: ProviderSnapshot,
  field: string,
  errorCode: string
) {
  const result = value[field];
  if (typeof result !== "string") {
    throw new Error(errorCode);
  }
  return result;
}

function optionalDate(value: unknown) {
  return typeof value === "string" ? new Date(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMandateStatus(value: unknown): value is MandateProviderResult["status"] {
  return [
    "PENDING",
    "ACTIVE",
    "SUSPENDED",
    "REVOKED",
    "EXPIRED",
    "FAILED"
  ].includes(String(value));
}

function isMockResolution(value: unknown): value is MockDebitResolution {
  return [
    "SUCCEEDED",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
    "UNKNOWN"
  ].includes(String(value));
}

function isDebitStatus(value: unknown): value is DebitProviderStatus {
  return value === "PROCESSING" || isMockResolution(value);
}
