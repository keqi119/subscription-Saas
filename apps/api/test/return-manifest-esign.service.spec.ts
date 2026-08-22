import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { MockESignProvider } from "../src/esign/mock-esign.provider";
import { ReturnManifestESignService } from "../src/esign/return-manifest-esign.service";

describe("ReturnManifestESignService production surface", () => {
  it("owns start, verified callback completion, and exact finalization", () => {
    expect(ReturnManifestESignService.prototype).toEqual(
      expect.objectContaining({
        finalize: expect.any(Function),
        handleVerifiedCallback: expect.any(Function),
        start: expect.any(Function)
      })
    );
  });

  it("uses the configured local provider for distinct unsigned and signed PDF bytes", async () => {
    const provider = new MockESignProvider(
      new ConfigService({ PORTAL_BASE_URL: "http://localhost:3000" })
    );
    const unsigned = Buffer.from("%PDF-1.7\nRETURN_MANIFEST_UNSIGNED\n", "utf8");
    const sha256 = createHash("sha256").update(unsigned).digest("hex");
    const taskId = randomUUID();
    const taskNo = `ESG-${randomUUID()}`;
    const customerSignerId = randomUUID();
    const started = await provider.createReturnManifestTask({
      callbackUrl: "http://localhost:4000/esign/callback/mock",
      contractId: randomUUID(),
      customer: {
        customerId: randomUUID(),
        name: "Local provider customer",
        phone: "13800000000",
        signerId: customerSignerId
      },
      documentName: "return-manifest-provider.pdf",
      providerSourcePdf: {
        buffer: unsigned,
        fileName: "return-manifest-provider.pdf",
        sha256
      },
      taskId,
      taskNo,
      transactionId: "0123456789abcdef0123456789abcdef"
    });
    await provider.verifyCallback({
      eventType: "RETURN_MANIFEST_CUSTOMER_SIGNED",
      providerTaskId: started.providerTaskId
    });
    const completed = await provider.completeReturnManifestTask({
      contractId: randomUUID(),
      customer: {
        providerCustomerId: started.customer.providerCustomerId,
        providerTransactionId: started.customer.providerTransactionId,
        signerId: customerSignerId
      },
      documentName: "return-manifest-provider.pdf",
      platform: {
        signerId: randomUUID(),
        transactionId: "fedcba9876543210fedcba9876543210"
      },
      providerEnvelopeId: started.providerEnvelopeId,
      providerTaskId: started.providerTaskId,
      providerSourcePdf: unsigned,
      taskId,
      taskNo
    });

    expect(completed.signedPdf.buffer).not.toEqual(unsigned);
    expect(completed.signedPdf.buffer.subarray(0, unsigned.length)).toEqual(unsigned);
    expect(completed.signedPdf.contentType).toBe("application/pdf");
    expect(completed.signedPdf.fileName).toBe("return-manifest-provider-signed.pdf");
  });
});
