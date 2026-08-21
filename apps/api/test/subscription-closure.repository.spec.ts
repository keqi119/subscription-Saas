import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  SUBSCRIPTION_CLOSURE_ERROR_CODE,
  SubscriptionClosureRepository,
  subscriptionClosureDocumentAuthorityRequirement,
  type SubscriptionClosureAuthorityLock
} from "../src/subscription-closure/subscription-closure.repository";

const SOURCE = {
  id: "A06E8EE8-3D7D-4AA1-B463-59A64F66F890",
  key: "  expiry:2026-08-21  ",
  type: "  SUBSCRIPTION_EXPIRY  "
} as const;

describe("SubscriptionClosureRepository transaction and lock protocol", () => {
  it("rejects root-like and non-READ-COMMITTED callers", async () => {
    const repository = new SubscriptionClosureRepository();

    await expectCode(
      repository.lockSourceOwnership(fakeTransaction({ secondTransactionId: "tx-2" }).tx, SOURCE),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.TRANSACTION_REQUIRED
    );
    await expectCode(
      repository.lockSourceOwnership(
        fakeTransaction({ isolationLevel: "serializable" }).tx,
        SOURCE
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.TRANSACTION_REQUIRED
    );
  });

  it("takes the source advisory lock on the canonical exact tuple", async () => {
    const database = fakeTransaction();

    await new SubscriptionClosureRepository().lockSourceOwnership(database.tx, SOURCE);

    expect(database.timeline).toEqual(["transaction-probe", "transaction-probe", "source-lock"]);
    expect(database.sourceTuple).toBe(
      '["SUBSCRIPTION_EXPIRY","a06e8ee8-3d7d-4aa1-b463-59a64f66f890","expiry:2026-08-21"]'
    );
  });

  it("issues exact one-use authority attestations from one ranked pass", async () => {
    const database = fakeTransaction();
    const repository = new SubscriptionClosureRepository();
    const attestations = await repository.prepareAuthorityInTransaction(
      database.tx,
      [
        {
          id: "A06E8EE8-3D7D-4AA1-B463-59A64F66F890",
          mode: "UPDATE",
          table: "subscription_order"
        }
      ],
      [
        {
          command: { orderId: UUIDS.order, source: SOURCE },
          key: "case-create",
          locks: [
            {
              id: "A06E8EE8-3D7D-4AA1-B463-59A64F66F890",
              mode: "UPDATE",
              table: "subscription_order"
            }
          ]
        },
        {
          command: { closureCaseId: UUIDS.closureCase, source: SOURCE },
          key: "manifest-create",
          locks: [
            {
              id: "A06E8EE8-3D7D-4AA1-B463-59A64F66F890",
              mode: "UPDATE",
              table: "subscription_order"
            }
          ]
        }
      ]
    );

    expect(database.authorityLocks).toHaveLength(1);
    await expect(
      repository.consumeAuthorityAttestationInTransaction(
        database.tx,
        attestations.get("case-create")!,
        {
          command: { orderId: UUIDS.order, source: SOURCE },
          key: "case-create",
          locks: [
            {
              id: "A06E8EE8-3D7D-4AA1-B463-59A64F66F890",
              mode: "UPDATE",
              table: "subscription_order"
            }
          ]
        }
      )
    ).resolves.toBeUndefined();
    await expectCode(
      repository.consumeAuthorityAttestationInTransaction(
        database.tx,
        attestations.get("case-create")!,
        {
          command: { orderId: UUIDS.order, source: SOURCE },
          key: "case-create",
          locks: [
            {
              id: "A06E8EE8-3D7D-4AA1-B463-59A64F66F890",
              mode: "UPDATE",
              table: "subscription_order"
            }
          ]
        }
      ),
      "SUBSCRIPTION_CLOSURE_CAPABILITY_INVALID"
    );
    await expectCode(
      repository.consumeAuthorityAttestationInTransaction(
        database.tx,
        attestations.get("manifest-create")!,
        {
          command: { closureCaseId: UUIDS.closureCase, source: SOURCE },
          key: "retargeted",
          locks: [
            {
              id: "A06E8EE8-3D7D-4AA1-B463-59A64F66F890",
              mode: "UPDATE",
              table: "subscription_order"
            }
          ]
        }
      ),
      "SUBSCRIPTION_CLOSURE_CAPABILITY_INVALID"
    );
    await expectCode(
      repository.consumeAuthorityAttestationInTransaction(
        database.tx,
        attestations.get("manifest-create")!,
        {
          command: { closureCaseId: UUIDS.closureCase, source: SOURCE },
          key: "manifest-create",
          locks: [
            {
              id: "A06E8EE8-3D7D-4AA1-B463-59A64F66F890",
              mode: "UPDATE",
              table: "subscription_order"
            }
          ]
        }
      ),
      "SUBSCRIPTION_CLOSURE_CAPABILITY_INVALID"
    );
  });

  it("consumes forged, foreign, wrong-transaction, command, id, and mode retargets fail closed", async () => {
    const database = fakeTransaction();
    const repository = new SubscriptionClosureRepository();
    const lock = {
      id: UUIDS.order,
      mode: "UPDATE" as const,
      table: "subscription_order" as const
    };
    const requirement = {
      command: { operation: "case", orderId: UUIDS.order, source: SOURCE },
      key: "case-create",
      locks: [lock]
    };
    const prepare = async () =>
      (await repository.prepareAuthorityInTransaction(database.tx, [lock], [requirement])).get(
        "case-create"
      )!;

    await expectCode(
      repository.consumeAuthorityAttestationInTransaction(
        database.tx,
        Object.freeze({}) as never,
        requirement
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID
    );
    await expectCode(
      repository.consumeAuthorityAttestationInTransaction(
        fakeTransaction().tx,
        await prepare(),
        requirement
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID
    );
    await expectCode(
      new SubscriptionClosureRepository().consumeAuthorityAttestationInTransaction(
        database.tx,
        await prepare(),
        requirement
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID
    );
    await expectCode(
      repository.consumeAuthorityAttestationInTransaction(database.tx, await prepare(), {
        ...requirement,
        command: { ...requirement.command, operation: "document" }
      }),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID
    );
    await expectCode(
      repository.consumeAuthorityAttestationInTransaction(database.tx, await prepare(), {
        ...requirement,
        locks: [{ ...lock, id: UUIDS.contract }]
      }),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID
    );
    await expectCode(
      repository.consumeAuthorityAttestationInTransaction(database.tx, await prepare(), {
        ...requirement,
        locks: [{ ...lock, mode: "SHARE" }]
      }),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID
    );
  });

  it("orders mixed NOWAIT locks by documented rank and canonical UUID", async () => {
    const database = fakeTransaction();
    const locks: readonly SubscriptionClosureAuthorityLock[] = [
      { id: "B06E8EE8-3D7D-4AA1-B463-59A64F66F890", mode: "SHARE", table: "user" },
      {
        id: "A06E8EE8-3D7D-4AA1-B463-59A64F66F890",
        mode: "SHARE",
        table: "vehicle"
      },
      {
        id: "C06E8EE8-3D7D-4AA1-B463-59A64F66F890",
        mode: "SHARE",
        table: "subscription_order"
      },
      {
        id: "A06E8EE8-3D7D-4AA1-B463-59A64F66F890",
        mode: "UPDATE",
        table: "subscription_closure_case"
      },
      {
        id: "C06E8EE8-3D7D-4AA1-B463-59A64F66F890",
        mode: "UPDATE",
        table: "subscription_order"
      }
    ];

    await new SubscriptionClosureRepository().lockAuthorityRows(database.tx, locks);

    expect(database.authorityLocks).toEqual([
      {
        id: "a06e8ee8-3d7d-4aa1-b463-59a64f66f890",
        mode: "UPDATE",
        table: "subscription_closure_case"
      },
      {
        id: "c06e8ee8-3d7d-4aa1-b463-59a64f66f890",
        mode: "UPDATE",
        table: "subscription_order"
      },
      {
        id: "a06e8ee8-3d7d-4aa1-b463-59a64f66f890",
        mode: "SHARE",
        table: "vehicle"
      },
      {
        id: "b06e8ee8-3d7d-4aa1-b463-59a64f66f890",
        mode: "SHARE",
        table: "user"
      }
    ]);
  });

  it("fails closed when a NOWAIT authority probe returns no row", async () => {
    const database = fakeTransaction({ emptyLock: "vehicle" });

    await expectCode(
      new SubscriptionClosureRepository().lockAuthorityRows(database.tx, [
        {
          id: "A06E8EE8-3D7D-4AA1-B463-59A64F66F890",
          mode: "SHARE",
          table: "vehicle"
        }
      ]),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_NOT_FOUND
    );
    expect(database.authorityLocks).toHaveLength(1);
  });

  it("locks every external document authority before the mutable current-family projection", async () => {
    const database = fakeDocumentTransaction();
    const repository = new SubscriptionClosureRepository();

    await expect(
      repository.appendDocumentRevision(database.tx, {
        actorId: UUIDS.actor,
        archivedAt: null,
        archivedBy: null,
        closureCaseId: UUIDS.closureCase,
        contractESignTaskId: UUIDS.esign,
        documentSnapshot: { kind: "return manifest" },
        documentType: "RETURN_MANIFEST",
        expectedCurrentRevisionId: UUIDS.predecessor,
        expectedVersion: 0,
        generatedAt: new Date("2026-08-21T03:00:00.000Z"),
        handoverWorkOrderId: UUIDS.handover,
        signedAt: null,
        signedBy: null,
        signedFileHash: null,
        signedFileId: null,
        source: SOURCE,
        sourceFileHash: "a".repeat(64),
        sourceFileId: UUIDS.file,
        stage: "GENERATED",
        vehicleReturnId: UUIDS.vehicleReturn
      })
    ).rejects.toMatchObject({
      response: { code: SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH }
    });

    expect(database.timeline).toEqual([
      "authority-lock:subscription_closure_case",
      "authority-lock:vehicle_return",
      "authority-lock:vehicle_handover_work_order",
      "current-document-projection",
      "authority-lock:subscription_closure_document_revision",
      "authority-lock:file_object",
      "authority-lock:contract_esign_task",
      "authority-lock:user"
    ]);
  });

  it("rejects a retargeted prepared-document attestation before document writes or replay", async () => {
    const database = fakeDocumentTransaction();
    const repository = new SubscriptionClosureRepository();
    const command = generatedDocumentCommand();
    const sourceCapability = await repository.prepareSourceInTransaction(database.tx, SOURCE);
    const wrongCommand = { ...command, expectedVersion: 1 };
    const wrongRequirement = subscriptionClosureDocumentAuthorityRequirement(wrongCommand);
    const proof = (
      await repository.prepareAuthorityInTransaction(database.tx, wrongRequirement.locks, [
        wrongRequirement
      ])
    ).get("manifest-create")!;

    await expectCode(
      repository.appendPreparedDocumentRevisionInTransaction(
        database.tx,
        command,
        sourceCapability,
        proof
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.CAPABILITY_INVALID
    );
    expect(database.receiptFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["signedFileId", UUIDS.file],
    ["signedFileHash", "b".repeat(64)],
    ["signedBy", UUIDS.actor],
    ["signedAt", new Date("2026-08-21T03:00:00.000Z")],
    ["archivedBy", UUIDS.actor],
    ["archivedAt", new Date("2026-08-21T03:00:00.000Z")]
  ] as const)(
    "rejects a partial document lifecycle group containing only %s",
    async (field, value) => {
      const command = { ...generatedDocumentCommand(), [field]: value };
      await expectCode(
        new SubscriptionClosureRepository().appendDocumentRevision(
          {} as Prisma.TransactionClient,
          command
        ),
        SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND
      );
    }
  );

  it.each([
    [
      "generatedAt",
      {
        ...generatedDocumentCommand(),
        generatedAt: new Date("2026-08-21T03:02:00.000Z")
      }
    ],
    [
      "signedAt",
      {
        ...generatedDocumentCommand(),
        generatedAt: new Date("2026-08-21T03:00:00.000Z"),
        signedAt: new Date("2026-08-21T03:02:00.000Z"),
        signedBy: UUIDS.actor,
        signedFileHash: "b".repeat(64),
        signedFileId: UUIDS.file,
        stage: "SIGNED" as const
      }
    ],
    [
      "archivedAt",
      {
        ...generatedDocumentCommand(),
        archivedAt: new Date("2026-08-21T03:02:00.000Z"),
        archivedBy: UUIDS.actor,
        generatedAt: new Date("2026-08-21T02:59:00.000Z"),
        signedAt: new Date("2026-08-21T03:00:00.000Z"),
        signedBy: UUIDS.actor,
        signedFileHash: "b".repeat(64),
        signedFileId: UUIDS.file,
        stage: "ARCHIVED" as const
      }
    ]
  ] as const)(
    "rejects future document lifecycle fact %s against the independent database clock",
    async (_field, command) => {
      const database = fakeDocumentTransaction({ currentDocumentRevisionId: null });
      await expectCode(
        new SubscriptionClosureRepository().appendDocumentRevision(database.tx, command),
        SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND
      );
      expect(database.receiptFindUnique).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "generatedAt -> signedAt",
      {
        ...generatedDocumentCommand(),
        generatedAt: new Date("2026-08-21T03:00:00.000Z"),
        signedAt: new Date("2026-08-21T02:59:00.000Z"),
        signedBy: UUIDS.actor,
        signedFileHash: "b".repeat(64),
        signedFileId: UUIDS.file,
        stage: "SIGNED" as const
      }
    ],
    [
      "signedAt -> archivedAt",
      {
        ...generatedDocumentCommand(),
        archivedAt: new Date("2026-08-21T02:59:00.000Z"),
        archivedBy: UUIDS.actor,
        generatedAt: new Date("2026-08-21T02:58:00.000Z"),
        signedAt: new Date("2026-08-21T03:00:00.000Z"),
        signedBy: UUIDS.actor,
        signedFileHash: "b".repeat(64),
        signedFileId: UUIDS.file,
        stage: "ARCHIVED" as const
      }
    ]
  ] as const)("rejects reversed document lifecycle adjacency %s", async (_edge, command) => {
    await expectCode(
      new SubscriptionClosureRepository().appendDocumentRevision(
        {} as Prisma.TransactionClient,
        command
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND
    );
  });

  it.each([
    ["finalizedBy", UUIDS.actor],
    ["finalizedAt", new Date("2026-08-21T03:00:00.000Z")],
    ["settledBy", UUIDS.actor],
    ["settledAt", new Date("2026-08-21T03:00:00.000Z")]
  ] as const)(
    "rejects a partial settlement lifecycle group containing only %s",
    async (field, value) => {
      const command = { ...proposedSettlementCommand(), [field]: value };
      await expectCode(
        new SubscriptionClosureRepository().appendSettlementRevision(
          {} as Prisma.TransactionClient,
          command
        ),
        SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND
      );
    }
  );
});

const UUIDS = {
  actor: "10000000-0000-4000-8000-000000000001",
  closureCase: "10000000-0000-4000-8000-000000000002",
  contract: "10000000-0000-4000-8000-000000000003",
  customer: "10000000-0000-4000-8000-000000000004",
  esign: "10000000-0000-4000-8000-000000000005",
  file: "10000000-0000-4000-8000-000000000006",
  handover: "10000000-0000-4000-8000-000000000007",
  order: "10000000-0000-4000-8000-000000000008",
  predecessor: "10000000-0000-4000-8000-000000000010",
  vehicleReturn: "10000000-0000-4000-8000-000000000009"
} as const;

function generatedDocumentCommand() {
  return {
    actorId: UUIDS.actor,
    archivedAt: null,
    archivedBy: null,
    closureCaseId: UUIDS.closureCase,
    contractESignTaskId: UUIDS.esign,
    documentSnapshot: { kind: "agreement" },
    documentType: "EARLY_TERMINATION_AGREEMENT" as const,
    expectedCurrentRevisionId: null,
    expectedVersion: 0,
    generatedAt: new Date("2026-08-21T03:00:00.000Z"),
    handoverWorkOrderId: null,
    signedAt: null,
    signedBy: null,
    signedFileHash: null,
    signedFileId: null,
    source: SOURCE,
    sourceFileHash: "a".repeat(64),
    sourceFileId: UUIDS.file,
    stage: "GENERATED" as const,
    vehicleReturnId: null
  };
}

function proposedSettlementCommand() {
  return {
    actorId: UUIDS.actor,
    amountDueCents: 0n,
    amountRefundableCents: 0n,
    billInputSnapshot: {},
    closureCaseId: UUIDS.closureCase,
    costTotalCents: 0n,
    depositAppliedCents: 0n,
    depositInputSnapshot: {},
    depositRefundCents: 0n,
    expectedCurrentRevisionId: null,
    expectedVersion: 0,
    finalizedAt: null,
    finalizedBy: null,
    ledgerInputSnapshot: {},
    paidTotalCents: 0n,
    receivableTotalCents: 0n,
    responsibilitySnapshot: {},
    resultSnapshot: {},
    settledAt: null,
    settledBy: null,
    settlementType: "FINAL" as const,
    source: SOURCE,
    stage: "PROPOSED" as const,
    waiverApprovalId: null,
    waiverTotalCents: 0n,
    writeOffApprovalId: null,
    writeOffTotalCents: 0n
  };
}

function fakeDocumentTransaction(options: { currentDocumentRevisionId?: string | null } = {}) {
  const timeline: string[] = [];
  const receiptFindUnique = vi.fn(async () => null);
  const tx = {
    subscriptionClosureCase: {
      async findUnique() {
        return {
          closureType: "NORMAL_COMPLETION",
          contractId: UUIDS.contract,
          currentSettlementRevisionId: null,
          customerId: UUIDS.customer,
          finalDisposition: "COMPLETE",
          id: UUIDS.closureCase,
          orderId: UUIDS.order,
          physicalControlMode: "VOLUNTARY_RETURN",
          returnHandoverWorkOrderId: UUIDS.handover,
          status: "PREPARING_RETURN",
          vehicleReturnId: UUIDS.vehicleReturn,
          version: 0
        };
      }
    },
    subscriptionClosureCommandReceipt: {
      findUnique: receiptFindUnique
    },
    contractESignTask: {
      async findUnique() {
        return null;
      }
    },
    async $queryRaw(query: Prisma.Sql) {
      const sql = query.strings.join("?");
      if (sql.includes("transaction_isolation")) {
        return [{ isolationLevel: "read committed", transactionId: "tx-1" }];
      }
      if (sql.includes("txid_current")) return [{ transactionId: "tx-1" }];
      if (sql.includes("pg_advisory_xact_lock")) return [{ locked: true }];
      if (sql.includes("clock_timestamp")) {
        if (sql.includes('AS "now"')) {
          return [{ now: new Date("2026-08-21T03:01:00.000Z") }];
        }
        return [
          {
            clockTimestamp: new Date("2026-08-21T03:01:00.000Z"),
            latestOccurredAt: new Date("2026-08-21T03:00:00.000Z")
          }
        ];
      }
      if (sql.includes("subscription_closure_current_document")) {
        timeline.push("current-document-projection");
        const documentRevisionId =
          options.currentDocumentRevisionId === undefined
            ? UUIDS.predecessor
            : options.currentDocumentRevisionId;
        return documentRevisionId ? [{ documentRevisionId }] : [];
      }
      const table = extractTable(sql);
      timeline.push(`authority-lock:${table}`);
      return [{ id: String(query.values.at(-1)) }];
    }
  } as unknown as Prisma.TransactionClient;
  return { receiptFindUnique, timeline, tx };
}

function fakeTransaction(
  options: {
    emptyLock?: SubscriptionClosureAuthorityLock["table"];
    isolationLevel?: string;
    secondTransactionId?: string;
  } = {}
) {
  const timeline: string[] = [];
  const authorityLocks: SubscriptionClosureAuthorityLock[] = [];
  let sourceTuple: string | undefined;
  const tx = {
    async $queryRaw(query: Prisma.Sql) {
      const sql = query.strings.join("?");
      if (sql.includes("transaction_isolation")) {
        timeline.push("transaction-probe");
        return [
          { isolationLevel: options.isolationLevel ?? "read committed", transactionId: "tx-1" }
        ];
      }
      if (sql.includes("txid_current")) {
        timeline.push("transaction-probe");
        return [{ transactionId: options.secondTransactionId ?? "tx-1" }];
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        timeline.push("source-lock");
        sourceTuple = String(query.values[0]);
        return [{ locked: true }];
      }
      const table = extractTable(sql);
      const mode = sql.includes("FOR UPDATE NOWAIT") ? "UPDATE" : "SHARE";
      const id = String(query.values.at(-1));
      const lock = { id, mode, table } as SubscriptionClosureAuthorityLock;
      authorityLocks.push(lock);
      timeline.push(`authority-lock:${table}:${id}:${mode}`);
      return table === options.emptyLock ? [] : [{ id }];
    }
  } as unknown as Prisma.TransactionClient;
  return {
    authorityLocks,
    get sourceTuple() {
      return sourceTuple;
    },
    timeline,
    tx
  };
}

function extractTable(sql: string): SubscriptionClosureAuthorityLock["table"] {
  const match = /FROM "([a-z_]+)"/.exec(sql);
  if (!match) throw new Error(`No authority table in ${sql}`);
  return match[1] as SubscriptionClosureAuthorityLock["table"];
}

async function expectCode(promise: Promise<unknown>, expected: string) {
  try {
    await promise;
    throw new Error(`Expected ${expected}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: expected });
  }
}
