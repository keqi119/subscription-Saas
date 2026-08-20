import { ConflictException } from "@nestjs/common";
import { Prisma, type VehicleCostLedgerEntry } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ASSET_ACCOUNTING_ERROR_CODE,
  AssetAccountingRepository,
  businessExceptionSubjectLockIdentity,
  type AppendCostEntryCommand,
  type DecideExceptionApprovalCommand,
  type ExpireExceptionApprovalCommand,
  type RequestExceptionApprovalCommand,
  type RequireCurrentApprovedExceptionCommand,
  type ReverseCostEntryCommand
} from "../src/asset-accounting/asset-accounting.repository";

const NOW = new Date("2026-08-20T10:00:00.000Z");
const OCCURRED_ON = new Date("2026-08-19T00:00:00.000Z");

describe("AssetAccountingRepository", () => {
  it("rejects root-like and non-READ-COMMITTED clients", async () => {
    const repository = new AssetAccountingRepository();
    const rootLike = fakeTransaction({ secondTransactionId: "tx-2" });
    const serializable = fakeTransaction({ isolationLevel: "serializable" });

    await expectCode(
      repository.appendCostEntry(rootLike.tx, appendCommand(rootLike.ids, "root")),
      ASSET_ACCOUNTING_ERROR_CODE.TRANSACTION_REQUIRED
    );
    await expectCode(
      repository.appendCostEntry(serializable.tx, appendCommand(serializable.ids, "serializable")),
      ASSET_ACCOUNTING_ERROR_CODE.TRANSACTION_REQUIRED
    );
  });

  it("orders transaction probes, source ownership, receipt lookup, and authority locks", async () => {
    const database = fakeTransaction();

    await new AssetAccountingRepository().appendCostEntry(
      database.tx,
      appendCommand(database.ids, "operation-timeline")
    );

    expect(database.operationTimeline.slice(0, 4)).toEqual([
      "transaction-probe",
      "transaction-probe",
      "source-lock",
      "receipt-lookup"
    ]);
    expect(database.operationTimeline.indexOf("receipt-lookup")).toBeLessThan(
      database.operationTimeline.findIndex((operation) => operation.startsWith("authority-lock:"))
    );
  });

  it("orders reverse probes, source ownership, receipt, original, and stable authority locks", async () => {
    const database = fakeTransaction();
    const repository = new AssetAccountingRepository();
    const original = await repository.appendCostEntry(
      database.tx,
      appendCommand(database.ids, "reverse-operation-timeline-original")
    );
    database.operationTimeline.length = 0;

    await repository.reverseCostEntry(
      database.tx,
      reverseCommand(database.ids, original.outcome.id, "reverse-operation-timeline")
    );

    expect(database.operationTimeline).toEqual([
      "transaction-probe",
      "transaction-probe",
      "source-lock",
      "receipt-lookup",
      `original-lock:${original.outcome.id}`,
      `authority-lock:asset_work_order:${database.ids.workOrderId}`,
      `authority-lock:user:${database.ids.actorId}`
    ]);
  });

  it("locks the exact source tuple, replays the stored outcome, and rejects payload or command drift", async () => {
    const repository = new AssetAccountingRepository();
    const database = fakeTransaction();
    const command = appendCommand(database.ids, "exact-replay");

    const first = await repository.appendCostEntry(database.tx, command);
    const persisted = database.entries.get(first.outcome.id);
    if (!persisted) throw new Error("missing persisted entry fixture");
    database.entries.set(first.outcome.id, { ...persisted, accountingPeriod: "2099-12" });
    database.authorities.vehicle.delete(database.ids.vehicleId);
    const replay = await repository.appendCostEntry(database.tx, command);

    expect(first.wrote).toBe(true);
    expect(replay).toEqual({ outcome: first.outcome, wrote: false });
    expect(replay.outcome.accountingPeriod).toBe("2026-08");
    expect(database.sourceLockKeys).toEqual([
      JSON.stringify([command.source.type, command.source.id, command.source.key]),
      JSON.stringify([command.source.type, command.source.id, command.source.key])
    ]);
    expect(database.lockedAuthorities).toEqual(
      [...database.lockedAuthorities].sort((left, right) => {
        const leftKey = `${left.table}:${left.id}`;
        const rightKey = `${right.table}:${right.id}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
    );
    await expectCode(
      repository.appendCostEntry(database.tx, { ...command, amountCents: 200n }),
      ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT
    );
    await expectCode(
      repository.appendCostEntry(database.tx, {
        ...command,
        reason: "a different confirmation reason"
      }),
      ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT
    );
    await expectCode(
      repository.reverseCostEntry(database.tx, {
        actorId: command.actorId,
        confirmedAt: command.confirmedAt,
        originalEntryId: first.outcome.id,
        reason: "cross-command ownership must be rejected",
        source: command.source
      }),
      ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT
    );
  });

  it("rejects missing, non-live, and cross-ID-drifted authorities", async () => {
    const cases: Array<{
      arrange: (database: FakeDatabase) => void;
      code: string;
      name: string;
    }> = [
      {
        arrange: (database) => database.authorities.vehicle.delete(database.ids.vehicleId),
        code: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND,
        name: "missing vehicle"
      },
      {
        arrange: (database) => {
          const vehicle = database.authorities.vehicle.get(database.ids.vehicleId)!;
          database.authorities.vehicle.set(database.ids.vehicleId, {
            ...vehicle,
            deletedAt: NOW
          });
        },
        code: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_LIVE,
        name: "deleted vehicle"
      },
      {
        arrange: (database) => {
          const order = database.authorities.subscriptionOrder.get(database.ids.orderId)!;
          database.authorities.subscriptionOrder.set(database.ids.orderId, {
            ...order,
            vehicleId: randomUUID()
          });
        },
        code: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_MISMATCH,
        name: "order vehicle mismatch"
      },
      {
        arrange: (database) => {
          const contract = database.authorities.contract.get(database.ids.contractId)!;
          database.authorities.contract.set(database.ids.contractId, {
            ...contract,
            orderId: randomUUID()
          });
        },
        code: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_MISMATCH,
        name: "contract order mismatch"
      },
      {
        arrange: (database) => {
          const workOrder = database.authorities.assetWorkOrder.get(database.ids.workOrderId)!;
          database.authorities.assetWorkOrder.set(database.ids.workOrderId, {
            ...workOrder,
            customerId: randomUUID()
          });
        },
        code: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_MISMATCH,
        name: "work-order customer mismatch"
      },
      {
        arrange: (database) => {
          const evidence = database.authorities.assetWorkOrderEvidence.get(
            database.ids.evidenceId
          )!;
          database.authorities.assetWorkOrderEvidence.set(database.ids.evidenceId, {
            ...evidence,
            supersededById: randomUUID()
          });
        },
        code: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_LIVE,
        name: "superseded evidence"
      },
      {
        arrange: (database) => {
          const owner = database.authorities.assetOwner.get(database.ids.assetOwnerId)!;
          database.authorities.assetOwner.set(database.ids.assetOwnerId, {
            ...owner,
            status: "INACTIVE"
          });
        },
        code: ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_LIVE,
        name: "inactive owner"
      }
    ];

    for (const testCase of cases) {
      const database = fakeTransaction();
      testCase.arrange(database);
      await expectCode(
        new AssetAccountingRepository().appendCostEntry(
          database.tx,
          appendCommand(database.ids, testCase.name)
        ),
        testCase.code
      );
    }
  });

  it("pins missing and non-live validation for every supplied authority kind", async () => {
    const missingCases: Array<[string, (database: FakeDatabase) => void]> = [
      ["actor", (database) => database.authorities.user.delete(database.ids.actorId)],
      ["vehicle", (database) => database.authorities.vehicle.delete(database.ids.vehicleId)],
      ["order", (database) => database.authorities.subscriptionOrder.delete(database.ids.orderId)],
      ["contract", (database) => database.authorities.contract.delete(database.ids.contractId)],
      ["customer", (database) => database.authorities.customer.delete(database.ids.customerId)],
      ["owner", (database) => database.authorities.assetOwner.delete(database.ids.assetOwnerId)],
      [
        "work order",
        (database) => database.authorities.assetWorkOrder.delete(database.ids.workOrderId)
      ],
      [
        "evidence",
        (database) => database.authorities.assetWorkOrderEvidence.delete(database.ids.evidenceId)
      ]
    ];
    for (const [name, arrange] of missingCases) {
      const database = fakeTransaction();
      arrange(database);
      await expectCode(
        new AssetAccountingRepository().appendCostEntry(
          database.tx,
          appendCommand(database.ids, `missing-${name}`)
        ),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND
      );
    }

    const nonLiveCases: Array<[string, (database: FakeDatabase) => void]> = [
      [
        "actor",
        (database) =>
          updateAuthority(database.authorities.user, database.ids.actorId, {
            status: "INACTIVE"
          })
      ],
      [
        "vehicle",
        (database) =>
          updateAuthority(database.authorities.vehicle, database.ids.vehicleId, {
            deletedAt: NOW
          })
      ],
      [
        "order",
        (database) =>
          updateAuthority(database.authorities.subscriptionOrder, database.ids.orderId, {
            deletedAt: NOW
          })
      ],
      [
        "contract",
        (database) =>
          updateAuthority(database.authorities.contract, database.ids.contractId, {
            deletedAt: NOW
          })
      ],
      [
        "customer",
        (database) =>
          updateAuthority(database.authorities.customer, database.ids.customerId, {
            deletedAt: NOW
          })
      ],
      [
        "owner",
        (database) =>
          updateAuthority(database.authorities.assetOwner, database.ids.assetOwnerId, {
            status: "INACTIVE"
          })
      ],
      [
        "work order",
        (database) =>
          updateAuthority(database.authorities.assetWorkOrder, database.ids.workOrderId, {
            status: "CANCELLED"
          })
      ],
      [
        "removed evidence",
        (database) =>
          updateAuthority(database.authorities.assetWorkOrderEvidence, database.ids.evidenceId, {
            action: "REMOVE"
          })
      ],
      [
        "superseded evidence",
        (database) =>
          updateAuthority(database.authorities.assetWorkOrderEvidence, database.ids.evidenceId, {
            supersededById: randomUUID()
          })
      ]
    ];
    for (const [name, arrange] of nonLiveCases) {
      const database = fakeTransaction();
      arrange(database);
      await expectCode(
        new AssetAccountingRepository().appendCostEntry(
          database.tx,
          appendCommand(database.ids, `non-live-${name}`)
        ),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_LIVE
      );
    }
  });

  it("pins every supplied cross-ID relationship and accepts effective SUPERSEDE evidence", async () => {
    const mismatchCases: Array<[string, (database: FakeDatabase) => void]> = [
      [
        "order vehicle",
        (database) =>
          updateAuthority(database.authorities.subscriptionOrder, database.ids.orderId, {
            vehicleId: randomUUID()
          })
      ],
      [
        "order customer",
        (database) =>
          updateAuthority(database.authorities.subscriptionOrder, database.ids.orderId, {
            customerId: randomUUID()
          })
      ],
      [
        "contract order",
        (database) =>
          updateAuthority(database.authorities.contract, database.ids.contractId, {
            orderId: randomUUID()
          })
      ],
      [
        "contract customer",
        (database) =>
          updateAuthority(database.authorities.contract, database.ids.contractId, {
            customerId: randomUUID()
          })
      ],
      ...(["vehicleId", "orderId", "contractId", "customerId", "assetOwnerId"] as const).map(
        (field) =>
          [
            `work-order ${field}`,
            (database: FakeDatabase) =>
              updateAuthority(database.authorities.assetWorkOrder, database.ids.workOrderId, {
                [field]: randomUUID()
              })
          ] as [string, (database: FakeDatabase) => void]
      ),
      [
        "evidence work order",
        (database) =>
          updateAuthority(database.authorities.assetWorkOrderEvidence, database.ids.evidenceId, {
            workOrderId: randomUUID()
          })
      ]
    ];
    for (const [name, arrange] of mismatchCases) {
      const database = fakeTransaction();
      arrange(database);
      await expectCode(
        new AssetAccountingRepository().appendCostEntry(
          database.tx,
          appendCommand(database.ids, `mismatch-${name}`)
        ),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_MISMATCH
      );
    }

    const database = fakeTransaction();
    updateAuthority(database.authorities.assetWorkOrderEvidence, database.ids.evidenceId, {
      action: "SUPERSEDE",
      supersededById: null
    });
    await expect(
      new AssetAccountingRepository().appendCostEntry(
        database.tx,
        appendCommand(database.ids, "effective-supercede")
      )
    ).resolves.toMatchObject({ wrote: true });
  });

  it("pins fallback responsible-customer and responsible-owner authority branches", async () => {
    for (const partyType of ["CUSTOMER", "ASSET_OWNER"] as const) {
      const missing = fakeTransaction();
      const missingId = randomUUID();
      await expectCode(
        new AssetAccountingRepository().appendCostEntry(missing.tx, {
          ...appendCommand(missing.ids, `missing-responsible-${partyType}`),
          ...(partyType === "CUSTOMER"
            ? { customerId: null }
            : { assetOwnerId: null, assetOwnerSnapshot: null }),
          responsiblePartyId: missingId,
          responsiblePartyType: partyType
        }),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND
      );

      const nonLive = fakeTransaction();
      const nonLiveId = randomUUID();
      const store =
        partyType === "CUSTOMER" ? nonLive.authorities.customer : nonLive.authorities.assetOwner;
      store.set(
        nonLiveId,
        partyType === "CUSTOMER"
          ? { deletedAt: NOW, id: nonLiveId }
          : { id: nonLiveId, status: "INACTIVE" }
      );
      await expectCode(
        new AssetAccountingRepository().appendCostEntry(nonLive.tx, {
          ...appendCommand(nonLive.ids, `non-live-responsible-${partyType}`),
          ...(partyType === "CUSTOMER"
            ? { customerId: null }
            : { assetOwnerId: null, assetOwnerSnapshot: null }),
          responsiblePartyId: nonLiveId,
          responsiblePartyType: partyType
        }),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_LIVE
      );

      const mismatched = fakeTransaction();
      await expectCode(
        new AssetAccountingRepository().appendCostEntry(mismatched.tx, {
          ...appendCommand(mismatched.ids, `mismatched-responsible-${partyType}`),
          responsiblePartyId: randomUUID(),
          responsiblePartyType: partyType
        }),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_MISMATCH
      );
    }
  });

  it("does not infer omitted owner, order, contract, customer, work-order, or evidence identities", async () => {
    const repository = new AssetAccountingRepository();
    const database = fakeTransaction();
    const command: AppendCostEntryCommand = {
      ...appendCommand(database.ids, "no-inference"),
      assetOwnerId: null,
      assetOwnerSnapshot: null,
      contractId: null,
      customerId: null,
      evidenceId: null,
      evidenceSnapshot: null,
      orderId: null,
      responsiblePartyId: null,
      workOrderId: null
    };

    const result = await repository.appendCostEntry(database.tx, command);

    expect(result.outcome).toMatchObject({
      assetOwnerId: null,
      contractId: null,
      customerId: null,
      evidenceId: null,
      orderId: null,
      workOrderId: null
    });
    expect(database.lockedAuthorities.map(({ table }) => table)).toEqual(["user", "vehicle"]);
  });

  it("locks and validates a contract authoritative order without storing an omitted order id", async () => {
    const repository = new AssetAccountingRepository();
    const matching = fakeTransaction();
    const command: AppendCostEntryCommand = {
      ...appendCommand(matching.ids, "contract-without-order"),
      orderId: null
    };

    const created = await repository.appendCostEntry(matching.tx, command);

    expect(created.outcome.orderId).toBeNull();
    expect(matching.entries.get(created.outcome.id)?.orderId).toBeNull();
    expect(matching.lockedAuthorities).toContainEqual({
      id: matching.ids.orderId,
      table: "subscription_order"
    });

    const mismatched = fakeTransaction();
    updateAuthority(mismatched.authorities.subscriptionOrder, mismatched.ids.orderId, {
      vehicleId: randomUUID()
    });
    await expectCode(
      repository.appendCostEntry(mismatched.tx, {
        ...appendCommand(mismatched.ids, "contract-without-order-mismatch"),
        orderId: null
      }),
      ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_MISMATCH
    );
  });

  it("creates one equal-and-opposite immutable reversal and exactly replays it", async () => {
    const repository = new AssetAccountingRepository();
    const database = fakeTransaction();
    const original = await repository.appendCostEntry(
      database.tx,
      appendCommand(database.ids, "original")
    );
    const command = reverseCommand(database.ids, original.outcome.id, "reverse");

    const reversed = await repository.reverseCostEntry(database.tx, command);
    const replay = await repository.reverseCostEntry(database.tx, command);

    expect(reversed.wrote).toBe(true);
    expect(replay).toEqual({ outcome: reversed.outcome, wrote: false });
    expect(reversed.outcome).toMatchObject({
      actionType: original.outcome.actionType,
      accountingPeriod: original.outcome.accountingPeriod,
      amountCents: -original.outcome.amountCents,
      assetOwnerId: original.outcome.assetOwnerId,
      assetOwnerSnapshot: original.outcome.assetOwnerSnapshot,
      contractId: original.outcome.contractId,
      costCategory: original.outcome.costCategory,
      customerId: original.outcome.customerId,
      entryKind: "REVERSAL",
      evidenceId: original.outcome.evidenceId,
      evidenceSnapshot: original.outcome.evidenceSnapshot,
      occurredOn: original.outcome.occurredOn,
      orderId: original.outcome.orderId,
      responsiblePartyId: original.outcome.responsiblePartyId,
      responsiblePartyType: original.outcome.responsiblePartyType,
      responsibilitySnapshot: original.outcome.responsibilitySnapshot,
      reversalOfEntryId: original.outcome.id,
      vehicleId: original.outcome.vehicleId,
      workOrderId: original.outcome.workOrderId
    });
    expect(database.lockedOriginalIds).toContain(original.outcome.id);
    await expectCode(
      repository.reverseCostEntry(database.tx, {
        ...command,
        reason: "a different reversal reason"
      }),
      ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT
    );
  });

  it("rejects blank cost business reasons before writing a fact or receipt", async () => {
    const repository = new AssetAccountingRepository();
    const appendDatabase = fakeTransaction();
    await expectCode(
      repository.appendCostEntry(appendDatabase.tx, {
        ...appendCommand(appendDatabase.ids, "blank-append-reason"),
        reason: " "
      }),
      ASSET_ACCOUNTING_ERROR_CODE.INVALID_COST_COMMAND
    );
    expect(appendDatabase.entries.size).toBe(0);
    expect(appendDatabase.receipts.size).toBe(0);

    const reverseDatabase = fakeTransaction();
    const original = await repository.appendCostEntry(
      reverseDatabase.tx,
      appendCommand(reverseDatabase.ids, "blank-reverse-original")
    );
    await expectCode(
      repository.reverseCostEntry(reverseDatabase.tx, {
        ...reverseCommand(reverseDatabase.ids, original.outcome.id, "blank-reverse-reason"),
        reason: ""
      }),
      ASSET_ACCOUNTING_ERROR_CODE.INVALID_COST_COMMAND
    );
    expect(reverseDatabase.entries.size).toBe(1);
    expect(reverseDatabase.receipts.size).toBe(1);
  });

  it("reverses frozen historical dimensions while validating only the live actor", async () => {
    const repository = new AssetAccountingRepository();
    const database = fakeTransaction();
    const original = await repository.appendCostEntry(
      database.tx,
      appendCommand(database.ids, "historical-original")
    );
    database.lockedAuthorities.length = 0;
    updateAuthority(database.authorities.subscriptionOrder, database.ids.orderId, {
      vehicleId: randomUUID()
    });
    updateAuthority(database.authorities.assetWorkOrderEvidence, database.ids.evidenceId, {
      supersededById: randomUUID()
    });
    updateAuthority(database.authorities.assetOwner, database.ids.assetOwnerId, {
      status: "INACTIVE"
    });
    updateAuthority(database.authorities.assetWorkOrder, database.ids.workOrderId, {
      status: "CANCELLED",
      vehicleId: randomUUID()
    });
    updateAuthority(database.authorities.vehicle, database.ids.vehicleId, { deletedAt: NOW });
    updateAuthority(database.authorities.customer, database.ids.customerId, { deletedAt: NOW });

    const reversal = await repository.reverseCostEntry(
      database.tx,
      reverseCommand(database.ids, original.outcome.id, "historical-reversal")
    );

    expect(reversal.outcome).toMatchObject({
      accountingPeriod: original.outcome.accountingPeriod,
      evidenceId: original.outcome.evidenceId,
      occurredOn: original.outcome.occurredOn,
      orderId: original.outcome.orderId,
      vehicleId: original.outcome.vehicleId,
      workOrderId: original.outcome.workOrderId
    });
    expect(database.lockedAuthorities).toEqual([
      { id: database.ids.workOrderId, table: "asset_work_order" },
      { id: database.ids.actorId, table: "user" }
    ]);

    for (const actorState of [
      null,
      { deletedAt: NOW, status: "ACTIVE" },
      { deletedAt: null, status: "INACTIVE" }
    ]) {
      const actorDatabase = fakeTransaction();
      const actorOriginal = await repository.appendCostEntry(
        actorDatabase.tx,
        appendCommand(actorDatabase.ids, `actor-original-${String(actorState)}`)
      );
      if (actorState === null) actorDatabase.authorities.user.delete(actorDatabase.ids.actorId);
      else
        actorDatabase.authorities.user.set(actorDatabase.ids.actorId, {
          id: actorDatabase.ids.actorId,
          ...actorState
        });
      await expectCode(
        repository.reverseCostEntry(
          actorDatabase.tx,
          reverseCommand(
            actorDatabase.ids,
            actorOriginal.outcome.id,
            `actor-reverse-${String(actorState)}`
          )
        ),
        actorState === null
          ? ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND
          : ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_LIVE
      );
    }
  });

  it("rejects reverse replay when the same source drifts to another original", async () => {
    const repository = new AssetAccountingRepository();
    const database = fakeTransaction();
    const first = await repository.appendCostEntry(
      database.tx,
      appendCommand(database.ids, "reverse-drift-first")
    );
    const second = await repository.appendCostEntry(
      database.tx,
      appendCommand(database.ids, "reverse-drift-second")
    );
    const command = reverseCommand(database.ids, first.outcome.id, "reverse-drift-source");
    await repository.reverseCostEntry(database.tx, command);

    await expectCode(
      repository.reverseCostEntry(database.tx, {
        ...command,
        originalEntryId: second.outcome.id
      }),
      ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT
    );
  });

  it("returns identical traceable public projections without receipt internals", async () => {
    const repository = new AssetAccountingRepository();
    const database = fakeTransaction();
    const created = await repository.appendCostEntry(
      database.tx,
      appendCommand(database.ids, "read-projections")
    );

    await expect(repository.getCostEntry(database.tx, created.outcome.id)).resolves.toEqual(
      created.outcome
    );
    await expect(
      repository.listVehicleEntries(database.tx, database.ids.vehicleId)
    ).resolves.toEqual([created.outcome]);
    await expect(repository.listOrderEntries(database.tx, database.ids.orderId)).resolves.toEqual([
      created.outcome
    ]);
    await expect(
      repository.listWorkOrderEntries(database.tx, database.ids.workOrderId)
    ).resolves.toEqual([created.outcome]);
    expect(created.outcome).toMatchObject({
      confirmedAt: NOW,
      confirmedBy: database.ids.actorId,
      sourceId: created.outcome.sourceId,
      sourceKey: "read-projections",
      sourceType: "ASSET_WORK_ORDER"
    });
    for (const internal of [
      "createdAt",
      "payloadHash",
      "payloadSnapshot",
      "receiptId",
      "outcomeSnapshot"
    ]) {
      expect(created.outcome).not.toHaveProperty(internal);
    }
  });

  it("rejects a second reversal, reverse-of-reversal, and missing original", async () => {
    const repository = new AssetAccountingRepository();
    const database = fakeTransaction();
    const original = await repository.appendCostEntry(
      database.tx,
      appendCommand(database.ids, "reverse-guards-original")
    );
    const reversal = await repository.reverseCostEntry(
      database.tx,
      reverseCommand(database.ids, original.outcome.id, "reverse-guards-first")
    );

    await expectCode(
      repository.reverseCostEntry(
        database.tx,
        reverseCommand(database.ids, original.outcome.id, "reverse-guards-second")
      ),
      ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_ALREADY_EXISTS
    );
    await expectCode(
      repository.reverseCostEntry(
        database.tx,
        reverseCommand(database.ids, reversal.outcome.id, "reverse-a-reversal")
      ),
      ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_INVALID
    );
    await expectCode(
      repository.reverseCostEntry(
        database.tx,
        reverseCommand(database.ids, randomUUID(), "missing")
      ),
      ASSET_ACCOUNTING_ERROR_CODE.COST_ENTRY_NOT_FOUND
    );
  });

  it.each([
    ["vehicle_cost_ledger_entry_reversal_of_entry_id_key", "23505", "REVERSAL_ALREADY_EXISTS"],
    ["vehicle_cost_ledger_entry_reverse_of_reversal_chk", "23514", "REVERSAL_INVALID"],
    ["vehicle_cost_ledger_entry_reversal_amount_chk", "23514", "REVERSAL_INVALID"],
    ["vehicle_cost_ledger_entry_reversal_reference_chk", "23514", "REVERSAL_INVALID"],
    ["vehicle_cost_ledger_entry_kind_amount_shape_chk", "23514", "INVALID_COST_COMMAND"],
    ["vehicle_cost_ledger_entry_accounting_period_chk", "23514", "INVALID_COST_COMMAND"],
    ["vehicle_cost_ledger_entry_source_key_not_blank_chk", "23514", "INVALID_COST_COMMAND"],
    ["vehicle_cost_ledger_entry_vehicle_id_fkey", "23503", "AUTHORITY_NOT_FOUND"],
    ["vehicle_cost_ledger_entry_confirmed_by_fkey", "23503", "AUTHORITY_NOT_FOUND"],
    ["asset_accounting_command_receipt_source_key", "23505", "SOURCE_CONFLICT"],
    ["asset_accounting_command_receipt_payload_hash_chk", "23514", "WRITE_CONFLICT"],
    ["asset_accounting_command_receipt_source_key_not_blank_chk", "23514", "INVALID_COST_COMMAND"],
    ["asset_accounting_command_receipt_target_shape_chk", "23514", "WRITE_CONFLICT"]
  ] as const)("normalizes named database constraint %s", async (constraint, code, expected) => {
    const repository = new AssetAccountingRepository();
    const database = fakeTransaction();
    if (constraint.startsWith("asset_accounting_command_receipt_")) {
      database.nextReceiptCreateError = databaseError(code, constraint);
    } else {
      database.nextEntryCreateError = databaseError(code, constraint);
    }

    await expectCode(
      repository.appendCostEntry(database.tx, appendCommand(database.ids, constraint)),
      ASSET_ACCOUNTING_ERROR_CODE[expected]
    );
  });

  it.each([
    ["23514", "reversal amount must be the exact opposite of the original", "REVERSAL_INVALID"],
    [
      "23514",
      "reversal must preserve the original accounting and authority references",
      "REVERSAL_INVALID"
    ],
    ["23514", "a reversal cannot target another reversal", "REVERSAL_INVALID"],
    [
      "23514",
      'new row violates check constraint "vehicle_cost_ledger_entry_kind_amount_shape_chk"',
      "INVALID_COST_COMMAND"
    ]
  ] as const)(
    "normalizes Prisma adapter SQLSTATE %s with stable message %s",
    async (code, message, expected) => {
      const repository = new AssetAccountingRepository();
      const database = fakeTransaction();
      database.nextEntryCreateError = databaseMessageError(code, message);

      await expectCode(
        repository.appendCostEntry(database.tx, appendCommand(database.ids, message)),
        ASSET_ACCOUNTING_ERROR_CODE[expected]
      );
    }
  );

  it("preserves unknown error shapes and classifies P2002 only from its exact target", async () => {
    const repository = new AssetAccountingRepository();
    const ordinary = new Error(
      "diagnostic mentions vehicle_cost_ledger_entry_reversal_amount_chk but is not PostgreSQL"
    );
    const ordinaryDatabase = fakeTransaction();
    ordinaryDatabase.nextEntryCreateError = ordinary;
    await expect(
      repository.appendCostEntry(
        ordinaryDatabase.tx,
        appendCommand(ordinaryDatabase.ids, "ordinary-error")
      )
    ).rejects.toBe(ordinary);

    const rollback = Object.assign(new Error("transaction closed"), {
      code: "P2028",
      meta: {
        driverAdapterError: {
          cause: {
            constraint: "vehicle_cost_ledger_entry_reversal_amount_chk",
            message: "reversal amount must be the exact opposite of the original",
            originalCode: "55P03"
          }
        }
      }
    });
    const rollbackDatabase = fakeTransaction();
    rollbackDatabase.nextEntryCreateError = rollback;
    await expect(
      repository.appendCostEntry(
        rollbackDatabase.tx,
        appendCommand(rollbackDatabase.ids, "rollback-error")
      )
    ).rejects.toBe(rollback);

    const directSqlStateDatabase = fakeTransaction();
    directSqlStateDatabase.nextEntryCreateError = Object.assign(new Error("lock unavailable"), {
      code: "55P03"
    });
    await expectCode(
      repository.appendCostEntry(
        directSqlStateDatabase.tx,
        appendCommand(directSqlStateDatabase.ids, "direct-sqlstate")
      ),
      ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_BUSY
    );

    const incompatibleDatabase = fakeTransaction();
    incompatibleDatabase.nextEntryCreateError = databaseError(
      "55P03",
      "vehicle_cost_ledger_entry_reversal_amount_chk"
    );
    await expectCode(
      repository.appendCostEntry(
        incompatibleDatabase.tx,
        appendCommand(incompatibleDatabase.ids, "incompatible-code-constraint")
      ),
      ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_BUSY
    );

    const p2002Database = fakeTransaction();
    p2002Database.nextEntryCreateError = Object.assign(
      new Error("message mentions sourceKey outside the target"),
      { code: "P2002", meta: { target: ["unrelated_field"] } }
    );
    await expectCode(
      repository.appendCostEntry(
        p2002Database.tx,
        appendCommand(p2002Database.ids, "unrelated-p2002")
      ),
      ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT
    );

    const sourceDatabase = fakeTransaction();
    sourceDatabase.nextEntryCreateError = Object.assign(new Error("unique violation"), {
      code: "P2002",
      meta: { target: ["sourceType", "sourceId", "sourceKey"] }
    });
    await expectCode(
      repository.appendCostEntry(
        sourceDatabase.tx,
        appendCommand(sourceDatabase.ids, "source-p2002")
      ),
      ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT
    );

    const objectTargetDatabase = fakeTransaction();
    objectTargetDatabase.nextEntryCreateError = Object.assign(new Error("invalid target shape"), {
      code: "P2002",
      meta: { target: { fields: ["sourceType", "sourceId", "sourceKey"] } }
    });
    await expectCode(
      repository.appendCostEntry(
        objectTargetDatabase.tx,
        appendCommand(objectTargetDatabase.ids, "object-target-p2002")
      ),
      ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT
    );
  });

  it.each([
    [
      ["reversal_of_entry_id"],
      'duplicate key value violates unique constraint "vehicle_cost_ledger_entry_reversal_of_entry_id_key"',
      "REVERSAL_ALREADY_EXISTS"
    ],
    [
      ["source_key", "source_type", "source_id"],
      'duplicate key value violates unique constraint "asset_accounting_command_receipt_source_key"',
      "SOURCE_CONFLICT"
    ]
  ] as const)(
    "normalizes Prisma 7 P2002 adapter fields %j with exact message %s as %s",
    async (fields, message, expected) => {
      const repository = new AssetAccountingRepository();
      const database = fakeTransaction();
      database.nextEntryCreateError = p2002AdapterError(fields, message);

      await expectCode(
        repository.appendCostEntry(database.tx, appendCommand(database.ids, `adapter-${expected}`)),
        ASSET_ACCOUNTING_ERROR_CODE[expected]
      );
    }
  );

  it.each([
    [
      "source target versus reversal adapter",
      ["sourceType", "sourceId", "sourceKey"],
      ["reversal_of_entry_id"],
      'duplicate key value violates unique constraint "vehicle_cost_ledger_entry_reversal_of_entry_id_key"',
      "23505",
      "UniqueConstraintViolation"
    ],
    [
      "source target versus wrong adapter SQLSTATE",
      ["sourceType", "sourceId", "sourceKey"],
      ["source_type", "source_id", "source_key"],
      'duplicate key value violates unique constraint "asset_accounting_command_receipt_source_key"',
      "23514",
      "UniqueConstraintViolation"
    ],
    [
      "reversal target versus wrong adapter kind",
      ["reversalOfEntryId"],
      ["reversal_of_entry_id"],
      'duplicate key value violates unique constraint "vehicle_cost_ledger_entry_reversal_of_entry_id_key"',
      "23505",
      "CheckConstraintViolation"
    ]
  ] as const)(
    "fails closed for contradictory P2002 %s",
    async (_name, target, fields, message, originalCode, kind) => {
      const repository = new AssetAccountingRepository();
      const database = fakeTransaction();
      database.nextEntryCreateError = p2002AdapterError(
        fields,
        message,
        originalCode,
        kind,
        target
      );

      await expectCode(
        repository.appendCostEntry(
          database.tx,
          appendCommand(database.ids, `adapter-channel-conflict-${originalCode}-${kind}`)
        ),
        ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT
      );
    }
  );

  it.each([
    [
      "asset_accounting_command_receipt_source_key",
      'duplicate key value violates unique constraint "vehicle_cost_ledger_entry_reversal_of_entry_id_key"'
    ],
    [
      "vehicle_cost_ledger_entry_reversal_of_entry_id_key",
      'duplicate key value violates unique constraint "asset_accounting_command_receipt_source_key"'
    ]
  ] as const)(
    "fails closed when P2002 constraint %s contradicts its exact server message",
    async (constraint, message) => {
      const repository = new AssetAccountingRepository();
      const database = fakeTransaction();
      database.nextEntryCreateError = p2002NamedConstraintError(constraint, message);

      await expectCode(
        repository.appendCostEntry(
          database.tx,
          appendCommand(database.ids, `adapter-name-message-conflict-${constraint}`)
        ),
        ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT
      );
    }
  );

  it.each([
    ["vehicle_cost_ledger_entry_reversal_of_entry_id_key", "REVERSAL_ALREADY_EXISTS"],
    ["asset_accounting_command_receipt_source_key", "SOURCE_CONFLICT"]
  ] as const)(
    "normalizes Prisma P2002 exact adapter constraint %s as %s",
    async (constraint, expected) => {
      const repository = new AssetAccountingRepository();
      const database = fakeTransaction();
      database.nextEntryCreateError = p2002NamedConstraintError(constraint);

      await expectCode(
        repository.appendCostEntry(
          database.tx,
          appendCommand(database.ids, `adapter-constraint-${expected}`)
        ),
        ASSET_ACCOUNTING_ERROR_CODE[expected]
      );
    }
  );

  it.each([
    [
      ["source_type", "source_id"],
      "duplicate source tuple mentioning asset_accounting_command_receipt_source_key",
      "23505",
      "UniqueConstraintViolation"
    ],
    [
      ["unrelated_field"],
      "diagnostic mentions vehicle_cost_ledger_entry_reversal_of_entry_id_key",
      "23505",
      "UniqueConstraintViolation"
    ],
    [
      ["reversal_of_entry_id"],
      'duplicate key value violates unique constraint "vehicle_cost_ledger_entry_reversal_of_entry_id_key"',
      "23514",
      "UniqueConstraintViolation"
    ],
    [
      ["reversal_of_entry_id"],
      'duplicate key value violates unique constraint "vehicle_cost_ledger_entry_reversal_of_entry_id_key"',
      "23505",
      "CheckConstraintViolation"
    ],
    [
      ["reversal_of_entry_id"],
      'duplicate key value violates unique constraint "asset_accounting_command_receipt_source_key"',
      "23505",
      "UniqueConstraintViolation"
    ],
    [
      ["source_type", "source_id", "source_key"],
      'duplicate key value violates unique constraint "unrelated_unique_key"',
      "23505",
      "UniqueConstraintViolation"
    ]
  ] as const)(
    "keeps incompatible Prisma P2002 adapter evidence generic for fields %j, message %s, SQLSTATE %s, kind %s",
    async (fields, message, originalCode, kind) => {
      const repository = new AssetAccountingRepository();
      const database = fakeTransaction();
      database.nextEntryCreateError = p2002AdapterError(fields, message, originalCode, kind);

      await expectCode(
        repository.appendCostEntry(
          database.tx,
          appendCommand(
            database.ids,
            `adapter-negative-${originalCode}-${kind}-${fields.join("-")}`
          )
        ),
        ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT
      );
    }
  );

  describe("snapshot-bound business exception approvals", () => {
    it("gets and filters approval projections with the exact stable newest-first order", async () => {
      const database = fakeTransaction();
      const repository = new AssetAccountingRepository();
      const first = await repository.requestExceptionApproval(
        database.tx,
        requestApprovalCommand(database.ids, "approval-read-first")
      );
      const second = await repository.requestExceptionApproval(database.tx, {
        ...requestApprovalCommand(database.ids, "approval-read-second"),
        subject: { ...approvalSubject(database.ids), subjectField: "secondaryField" }
      });
      const tie = new Date("2026-08-20T12:00:00.000Z");
      for (const approvalId of [first.outcome.id, second.outcome.id]) {
        const row = database.approvals.get(approvalId)!;
        row.requestedAt = tie;
        row.createdAt = tie;
      }

      await expect(repository.getExceptionApproval(database.tx, first.outcome.id)).resolves.toEqual(
        { ...first.outcome, requestedAt: tie }
      );
      await expect(
        repository.getExceptionApproval(database.tx, "00000000-0000-4000-8000-000000000099")
      ).resolves.toBeNull();

      const approvals = await repository.listExceptionApprovals(database.tx, {
        status: "PENDING",
        subjectId: database.ids.vehicleId,
        subjectType: "VEHICLE"
      });

      expect(database.lastApprovalFindManyArgs).toEqual({
        orderBy: [{ requestedAt: "desc" }, { createdAt: "desc" }, { id: "asc" }],
        where: {
          status: "PENDING",
          subjectId: database.ids.vehicleId,
          subjectType: "VEHICLE"
        }
      });
      expect(approvals.map(({ id }) => id)).toEqual(
        [first.outcome.id, second.outcome.id].sort((left, right) => left.localeCompare(right))
      );
    });

    it("rejects root-like approval commands and exports the exact reusable subject lock identity", async () => {
      const database = fakeTransaction({ secondTransactionId: "tx-2" });
      const command = requestApprovalCommand(database.ids, "approval-root");

      expect(businessExceptionSubjectLockIdentity(command.subject)).toBe(
        JSON.stringify([
          "business-exception-subject",
          command.subject.subjectType,
          command.subject.subjectId,
          command.subject.subjectField
        ])
      );
      expect(
        businessExceptionSubjectLockIdentity({
          ...command.subject,
          subjectId: command.subject.subjectId.toUpperCase()
        })
      ).toBe(businessExceptionSubjectLockIdentity(command.subject));
      await expectCode(
        new AssetAccountingRepository().requestExceptionApproval(database.tx, command),
        ASSET_ACCOUNTING_ERROR_CODE.TRANSACTION_REQUIRED
      );
    });

    it("exports only a source-first subject-lock composition for owning-domain resolvers", async () => {
      const repository = new AssetAccountingRepository();
      const database = fakeTransaction();
      const command = requestApprovalCommand(database.ids, "owning-domain-scope");

      await repository.lockBusinessExceptionSourceAndSubject(
        database.tx,
        { ...command.source, id: command.source.id.toUpperCase() },
        { ...command.subject, subjectId: command.subject.subjectId.toUpperCase() }
      );

      expect(database.operationTimeline).toEqual([
        "transaction-probe",
        "transaction-probe",
        "source-lock",
        "subject-lock"
      ]);
      expect(database.sourceLockKeys).toEqual([
        JSON.stringify([command.source.type, command.source.id, command.source.key])
      ]);
      expect(database.subjectLockKeys).toEqual([
        businessExceptionSubjectLockIdentity(command.subject)
      ]);
    });

    it("canonicalizes every approval UUID identity before locks, payloads, comparisons, and row lookup", async () => {
      const repository = new AssetAccountingRepository();
      const database = fakeTransaction();
      const request = await repository.requestExceptionApproval(database.tx, {
        ...requestApprovalCommand(database.ids, "canonical-request"),
        requestedBy: database.ids.actorId.toUpperCase(),
        source: {
          id: database.ids.sourceId.toUpperCase(),
          key: "canonical-request",
          type: "HANDOVER_FIXTURE"
        },
        subject: {
          ...approvalSubject(database.ids),
          subjectId: database.ids.vehicleId.toUpperCase()
        }
      });

      expect(request.outcome).toMatchObject({
        requestSourceId: database.ids.sourceId,
        requestedBy: database.ids.actorId,
        subjectId: database.ids.vehicleId
      });
      const decided = await repository.decideExceptionApproval(database.tx, {
        ...decideApprovalCommand(
          database.ids,
          request.outcome.id.toUpperCase(),
          "canonical-decision"
        ),
        decidedBy: database.ids.deciderId.toUpperCase(),
        source: {
          id: database.ids.sourceId.toUpperCase(),
          key: "canonical-decision",
          type: "HANDOVER_FIXTURE"
        },
        subject: {
          ...approvalSubject(database.ids),
          subjectId: database.ids.vehicleId.toUpperCase()
        }
      });
      expect(decided.outcome).toMatchObject({
        decidedBy: database.ids.deciderId,
        id: request.outcome.id,
        subjectId: database.ids.vehicleId
      });
      const expired = await repository.expireExceptionApproval(database.tx, {
        ...expireApprovalCommand(
          database.ids,
          request.outcome.id.toUpperCase(),
          decided.outcome.version,
          "canonical-expiry"
        ),
        expiredBy: database.ids.deciderId.toUpperCase(),
        source: {
          id: database.ids.sourceId.toUpperCase(),
          key: "canonical-expiry",
          type: "HANDOVER_FIXTURE"
        },
        subject: {
          ...approvalSubject(database.ids),
          subjectId: database.ids.vehicleId.toUpperCase()
        }
      });
      expect(expired.outcome).toMatchObject({
        expiredBy: database.ids.deciderId,
        id: request.outcome.id,
        subjectId: database.ids.vehicleId
      });
    });

    it("forbids semantic UUID self-approval across case spellings without a decision receipt", async () => {
      const repository = new AssetAccountingRepository();
      const database = fakeTransaction();
      const request = await repository.requestExceptionApproval(
        database.tx,
        requestApprovalCommand(database.ids, "case-self-request")
      );

      await expectCode(
        repository.decideExceptionApproval(database.tx, {
          ...decideApprovalCommand(database.ids, request.outcome.id, "case-self-decision"),
          decidedBy: database.ids.actorId.toUpperCase()
        }),
        ASSET_ACCOUNTING_ERROR_CODE.SELF_APPROVAL_FORBIDDEN
      );
      expect(
        [...database.receipts.values()].filter(
          (receipt) => receipt.commandType === "EXCEPTION_DECIDE"
        )
      ).toHaveLength(0);
    });

    it("takes source then subject ownership, stores an internally hashed request, and exactly replays it", async () => {
      const repository = new AssetAccountingRepository();
      const database = fakeTransaction();
      const command = requestApprovalCommand(database.ids, "approval-request-replay");

      const created = await repository.requestExceptionApproval(database.tx, command);
      database.operationTimeline.length = 0;
      database.approvals.set(created.outcome.id, {
        ...database.approvals.get(created.outcome.id)!,
        requestReason: "mutated outside repository"
      });
      database.authorities.user.delete(database.ids.actorId);
      const replay = await repository.requestExceptionApproval(database.tx, command);

      expect(created.wrote).toBe(true);
      expect(created.outcome).toMatchObject({
        requestReason: "registration evidence is pending",
        requestSourceId: command.source.id,
        requestSourceKey: command.source.key,
        requestSourceType: command.source.type,
        status: "PENDING",
        subjectSnapshot: { factRevision: 1, state: "PENDING" },
        version: 0
      });
      expect(created.outcome.subjectSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
      expect(replay).toEqual({ outcome: created.outcome, wrote: false });
      await expectCode(
        repository.requestExceptionApproval(database.tx, {
          ...command,
          requestReason: "changed request reason"
        }),
        ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT
      );
      expect(database.operationTimeline).toEqual([
        "transaction-probe",
        "transaction-probe",
        "source-lock",
        "receipt-lookup",
        "transaction-probe",
        "transaction-probe",
        "source-lock",
        "receipt-lookup"
      ]);
      expect(database.receipts.size).toBe(1);
    });

    it("orders request and decision locks and rejects a second live request for the same subject field snapshot", async () => {
      const repository = new AssetAccountingRepository();
      const database = fakeTransaction();
      const firstCommand = requestApprovalCommand(database.ids, "approval-lock-order");
      const first = await repository.requestExceptionApproval(database.tx, firstCommand);

      expect(database.operationTimeline.slice(0, 6)).toEqual([
        "transaction-probe",
        "transaction-probe",
        "source-lock",
        "receipt-lookup",
        "subject-lock",
        `authority-lock:user:${database.ids.actorId}`
      ]);
      database.operationTimeline.length = 0;
      await expectCode(
        repository.requestExceptionApproval(database.tx, {
          ...firstCommand,
          exceptionType: "SETTLEMENT_WAIVER",
          source: {
            id: randomUUID(),
            key: "approval-lock-order-duplicate",
            type: "SETTLEMENT"
          }
        }),
        ASSET_ACCOUNTING_ERROR_CODE.APPROVAL_ALREADY_LIVE
      );
      expect(database.operationTimeline).toContain(`approval-lock:${first.outcome.id}`);
      expect(database.approvals.size).toBe(1);

      database.operationTimeline.length = 0;
      await repository.decideExceptionApproval(
        database.tx,
        decideApprovalCommand(database.ids, first.outcome.id, "approval-decision-order")
      );
      expect(database.operationTimeline).toEqual([
        "transaction-probe",
        "transaction-probe",
        "source-lock",
        "receipt-lookup",
        "subject-lock",
        `approval-lock:${first.outcome.id}`,
        `authority-lock:user:${database.ids.deciderId}`
      ]);
    });

    it("enforces exact decision replay, current snapshot, expected version, subject, and requester/decider separation", async () => {
      const repository = new AssetAccountingRepository();

      const self = fakeTransaction();
      const selfRequest = await repository.requestExceptionApproval(
        self.tx,
        requestApprovalCommand(self.ids, "self-request")
      );
      await expectCode(
        repository.decideExceptionApproval(self.tx, {
          ...decideApprovalCommand(self.ids, selfRequest.outcome.id, "self-decision"),
          decidedBy: self.ids.actorId
        }),
        ASSET_ACCOUNTING_ERROR_CODE.SELF_APPROVAL_FORBIDDEN
      );

      for (const [name, patch, code] of [
        ["version", { expectedVersion: 1 }, "APPROVAL_VERSION_CONFLICT"],
        [
          "subject",
          { subject: { ...approvalSubject(self.ids), subjectField: "other" } },
          "APPROVAL_SUBJECT_MISMATCH"
        ],
        [
          "snapshot",
          { authoritySnapshot: { factRevision: 2, state: "PENDING" } },
          "APPROVAL_SNAPSHOT_MISMATCH"
        ]
      ] as const) {
        const database = fakeTransaction();
        const request = await repository.requestExceptionApproval(
          database.tx,
          requestApprovalCommand(database.ids, `${name}-request`)
        );
        await expectCode(
          repository.decideExceptionApproval(database.tx, {
            ...decideApprovalCommand(database.ids, request.outcome.id, `${name}-decision`),
            ...patch
          }),
          ASSET_ACCOUNTING_ERROR_CODE[code]
        );
      }

      const database = fakeTransaction();
      const request = await repository.requestExceptionApproval(
        database.tx,
        requestApprovalCommand(database.ids, "decision-replay-request")
      );
      const command = decideApprovalCommand(database.ids, request.outcome.id, "decision-replay");
      const decided = await repository.decideExceptionApproval(database.tx, command);
      const replay = await repository.decideExceptionApproval(database.tx, command);
      expect(decided).toMatchObject({
        outcome: { decision: "APPROVED", status: "APPROVED", version: 1 },
        wrote: true
      });
      expect(replay).toEqual({ outcome: decided.outcome, wrote: false });
      for (const drift of [
        { decision: "REJECTED" as const },
        { decisionComment: "changed decision comment" },
        { authoritySnapshot: { factRevision: 2, state: "PENDING" } }
      ]) {
        await expectCode(
          repository.decideExceptionApproval(database.tx, { ...command, ...drift }),
          ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT
        );
      }
    });

    it("supports PENDING decisions and PENDING/APPROVED expiry but rejects terminal transitions", async () => {
      const repository = new AssetAccountingRepository();

      const rejectedDatabase = fakeTransaction();
      const rejectedRequest = await repository.requestExceptionApproval(
        rejectedDatabase.tx,
        requestApprovalCommand(rejectedDatabase.ids, "reject-request")
      );
      const rejected = await repository.decideExceptionApproval(rejectedDatabase.tx, {
        ...decideApprovalCommand(rejectedDatabase.ids, rejectedRequest.outcome.id, "reject"),
        decision: "REJECTED",
        decisionComment: "insufficient evidence"
      });
      expect(rejected.outcome).toMatchObject({ decision: "REJECTED", status: "REJECTED" });
      await expectCode(
        repository.expireExceptionApproval(
          rejectedDatabase.tx,
          expireApprovalCommand(rejectedDatabase.ids, rejected.outcome.id, 1, "expire-rejected")
        ),
        ASSET_ACCOUNTING_ERROR_CODE.APPROVAL_STATUS_CONFLICT
      );

      for (const status of ["PENDING", "APPROVED"] as const) {
        const database = fakeTransaction();
        const request = await repository.requestExceptionApproval(
          database.tx,
          requestApprovalCommand(database.ids, `${status}-expire-request`)
        );
        const current =
          status === "APPROVED"
            ? await repository.decideExceptionApproval(
                database.tx,
                decideApprovalCommand(database.ids, request.outcome.id, `${status}-approve`)
              )
            : request;
        const command = expireApprovalCommand(
          database.ids,
          request.outcome.id,
          current.outcome.version,
          `${status}-expire`
        );
        const expired = await repository.expireExceptionApproval(database.tx, command);
        const replay = await repository.expireExceptionApproval(database.tx, command);
        expect(expired).toMatchObject({
          outcome: { status: "EXPIRED", version: current.outcome.version + 1 },
          wrote: true
        });
        expect(replay).toEqual({ outcome: expired.outcome, wrote: false });
        await expectCode(
          repository.expireExceptionApproval(database.tx, {
            ...command,
            expiryReason: "drifted reason"
          }),
          ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT
        );
        await expectCode(
          repository.expireExceptionApproval(database.tx, {
            ...command,
            authoritySnapshot: { factRevision: 3, state: "CHANGED_AGAIN" }
          }),
          ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT
        );
      }
    });

    it("commits stale APPROVED expiry and returns false without throwing, while a current snapshot returns true", async () => {
      const repository = new AssetAccountingRepository();

      const currentDatabase = fakeTransaction();
      const currentRequest = await repository.requestExceptionApproval(
        currentDatabase.tx,
        requestApprovalCommand(currentDatabase.ids, "current-request")
      );
      const currentApproval = await repository.decideExceptionApproval(
        currentDatabase.tx,
        decideApprovalCommand(currentDatabase.ids, currentRequest.outcome.id, "current-approve")
      );
      const current = await repository.requireCurrentApprovedException(
        currentDatabase.tx,
        requireCurrentCommand(
          currentDatabase.ids,
          currentApproval.outcome.id,
          currentApproval.outcome.version,
          "current-check",
          { factRevision: 1, state: "PENDING" }
        )
      );
      expect(current).toEqual({ approval: currentApproval.outcome, valid: true });

      const staleDatabase = fakeTransaction();
      const staleRequest = await repository.requestExceptionApproval(
        staleDatabase.tx,
        requestApprovalCommand(staleDatabase.ids, "stale-request")
      );
      const staleApproval = await repository.decideExceptionApproval(
        staleDatabase.tx,
        decideApprovalCommand(staleDatabase.ids, staleRequest.outcome.id, "stale-approve")
      );
      const command = requireCurrentCommand(
        staleDatabase.ids,
        staleApproval.outcome.id,
        staleApproval.outcome.version,
        "stale-check",
        { factRevision: 2, state: "CHANGED" }
      );
      const stale = await repository.requireCurrentApprovedException(staleDatabase.tx, command);
      const replay = await repository.requireCurrentApprovedException(staleDatabase.tx, command);

      expect(stale).toMatchObject({
        expiredApproval: { status: "EXPIRED", version: 2 },
        valid: false
      });
      expect(replay).toEqual(stale);
      expect(staleDatabase.approvals.get(staleApproval.outcome.id)).toMatchObject({
        expiryReason: "authoritative snapshot changed",
        status: "EXPIRED",
        version: 2
      });
      expect(
        [...staleDatabase.receipts.values()].filter(
          (receipt) => receipt.commandType === "EXCEPTION_EXPIRE"
        )
      ).toHaveLength(1);
    });

    it("keeps the receipt namespace global across approval command kinds", async () => {
      const repository = new AssetAccountingRepository();
      const database = fakeTransaction();
      const requestCommand = requestApprovalCommand(database.ids, "global-approval-source");
      const request = await repository.requestExceptionApproval(database.tx, requestCommand);

      await expectCode(
        repository.decideExceptionApproval(database.tx, {
          ...decideApprovalCommand(database.ids, request.outcome.id, "unused"),
          source: requestCommand.source
        }),
        ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT
      );
    });

    it("normalizes only unanimous live-approval P2002 target evidence", async () => {
      const liveConstraint = "business_exception_approval_live_subject_field_snapshot_key";
      const liveMessage = `duplicate key value violates unique constraint "${liveConstraint}"`;
      const positiveErrors = [
        Object.assign(new Error("direct live constraint"), {
          code: "P2002",
          meta: { target: [liveConstraint] }
        }),
        Object.assign(new Error("direct live camel fields"), {
          code: "P2002",
          meta: {
            target: ["subjectType", "subjectId", "subjectField", "subjectSnapshotHash"]
          }
        }),
        Object.assign(new Error("direct live snake fields"), {
          code: "P2002",
          meta: {
            target: ["subject_type", "subject_id", "subject_field", "subject_snapshot_hash"]
          }
        }),
        p2002AdapterError(
          ["subjectType", "subjectId", "subjectField", "subjectSnapshotHash"],
          liveMessage
        ),
        p2002AdapterError(
          ["subject_type", "subject_id", "subject_field", "subject_snapshot_hash"],
          liveMessage
        ),
        p2002NamedConstraintError(liveConstraint)
      ];

      for (const [index, error] of positiveErrors.entries()) {
        const repository = new AssetAccountingRepository();
        const database = fakeTransaction();
        database.nextApprovalCreateError = error;
        await expectCode(
          repository.requestExceptionApproval(
            database.tx,
            requestApprovalCommand(database.ids, `live-p2002-positive-${index}`)
          ),
          ASSET_ACCOUNTING_ERROR_CODE.APPROVAL_ALREADY_LIVE
        );
      }

      const contradictoryErrors = [
        p2002AdapterError(
          ["subject_type", "subject_id", "subject_field", "subject_snapshot_hash"],
          'duplicate key value violates unique constraint "asset_accounting_command_receipt_source_key"'
        ),
        p2002AdapterError(
          ["source_type", "source_id", "source_key"],
          'duplicate key value violates unique constraint "asset_accounting_command_receipt_source_key"',
          "23505",
          "UniqueConstraintViolation",
          ["subjectType", "subjectId", "subjectField", "subjectSnapshotHash"]
        ),
        p2002NamedConstraintError(
          liveConstraint,
          'duplicate key value violates unique constraint "asset_accounting_command_receipt_source_key"'
        )
      ];

      for (const [index, error] of contradictoryErrors.entries()) {
        const repository = new AssetAccountingRepository();
        const database = fakeTransaction();
        database.nextApprovalCreateError = error;
        await expectCode(
          repository.requestExceptionApproval(
            database.tx,
            requestApprovalCommand(database.ids, `live-p2002-negative-${index}`)
          ),
          ASSET_ACCOUNTING_ERROR_CODE.WRITE_CONFLICT
        );
      }
    });
  });
});

type AuthorityRecord = Record<string, unknown> & { id: string };
type AuthorityStore = {
  assetOwner: Map<string, AuthorityRecord>;
  assetWorkOrder: Map<string, AuthorityRecord>;
  assetWorkOrderEvidence: Map<string, AuthorityRecord>;
  contract: Map<string, AuthorityRecord>;
  customer: Map<string, AuthorityRecord>;
  subscriptionOrder: Map<string, AuthorityRecord>;
  user: Map<string, AuthorityRecord>;
  vehicle: Map<string, AuthorityRecord>;
};
type FixtureIds = ReturnType<typeof fixtureIds>;
type FakeDatabase = ReturnType<typeof fakeTransaction>;

function fakeTransaction(options: { isolationLevel?: string; secondTransactionId?: string } = {}) {
  const ids = fixtureIds();
  const authorities: AuthorityStore = {
    assetOwner: new Map([[ids.assetOwnerId, { id: ids.assetOwnerId, status: "ACTIVE" }]]),
    assetWorkOrder: new Map([
      [
        ids.workOrderId,
        {
          assetOwnerId: ids.assetOwnerId,
          contractId: ids.contractId,
          customerId: ids.customerId,
          id: ids.workOrderId,
          orderId: ids.orderId,
          status: "PENDING_COST_CONFIRMATION",
          vehicleId: ids.vehicleId
        }
      ]
    ]),
    assetWorkOrderEvidence: new Map([
      [
        ids.evidenceId,
        {
          action: "ATTACH",
          id: ids.evidenceId,
          supersededById: null,
          workOrderId: ids.workOrderId
        }
      ]
    ]),
    contract: new Map([
      [
        ids.contractId,
        {
          customerId: ids.customerId,
          deletedAt: null,
          id: ids.contractId,
          orderId: ids.orderId
        }
      ]
    ]),
    customer: new Map([[ids.customerId, { deletedAt: null, id: ids.customerId }]]),
    subscriptionOrder: new Map([
      [
        ids.orderId,
        {
          contractId: ids.contractId,
          customerId: ids.customerId,
          deletedAt: null,
          id: ids.orderId,
          vehicleId: ids.vehicleId
        }
      ]
    ]),
    user: new Map([
      [ids.actorId, { deletedAt: null, id: ids.actorId, status: "ACTIVE" }],
      [ids.deciderId, { deletedAt: null, id: ids.deciderId, status: "ACTIVE" }]
    ]),
    vehicle: new Map([[ids.vehicleId, { deletedAt: null, id: ids.vehicleId }]])
  };
  const entries = new Map<string, VehicleCostLedgerEntry>();
  const approvals = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, Record<string, unknown>>();
  const sourceLockKeys: string[] = [];
  const subjectLockKeys: string[] = [];
  const operationTimeline: string[] = [];
  const lockedAuthorities: Array<{ id: string; table: string }> = [];
  const lockedOriginalIds: string[] = [];
  const database = {
    authorities,
    approvals,
    entries,
    ids,
    lockedAuthorities,
    lockedOriginalIds,
    nextEntryCreateError: undefined as unknown,
    nextApprovalCreateError: undefined as unknown,
    lastApprovalFindManyArgs: undefined as unknown,
    nextReceiptCreateError: undefined as unknown,
    operationTimeline,
    receipts,
    sourceLockKeys,
    subjectLockKeys,
    tx: undefined as unknown as Prisma.TransactionClient
  };
  let probeCount = 0;

  const tx = {
    $queryRaw: async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes("current_setting('transaction_isolation')")) {
        probeCount += 1;
        operationTimeline.push("transaction-probe");
        return [
          {
            isolationLevel: options.isolationLevel ?? "read committed",
            transactionId: "tx-1"
          }
        ];
      }
      if (text.includes("txid_current()")) {
        probeCount += 1;
        operationTimeline.push("transaction-probe");
        return [{ transactionId: options.secondTransactionId ?? "tx-1" }];
      }
      const values = sqlValues(query);
      if (text.includes("pg_advisory_xact_lock")) {
        const identity = String(values[0]);
        if (identity.includes("business-exception-subject")) {
          subjectLockKeys.push(identity);
          operationTimeline.push("subject-lock");
        } else {
          sourceLockKeys.push(identity);
          operationTimeline.push("source-lock");
        }
        return [{ locked: true }];
      }
      const table = /FROM "([a-z_]+)"/.exec(text)?.[1];
      if (table) {
        if (table === "business_exception_approval") {
          const approval = text.includes('"subject_snapshot_hash"')
            ? [...approvals.values()].find(
                (candidate) =>
                  candidate.subjectType === values[0] &&
                  candidate.subjectId === values[1] &&
                  candidate.subjectField === values[2] &&
                  candidate.subjectSnapshotHash === values[3] &&
                  ["PENDING", "APPROVED"].includes(String(candidate.status))
              )
            : approvals.get(String(values[0]));
          if (approval) operationTimeline.push(`approval-lock:${String(approval.id)}`);
          return approval ? [{ id: approval.id }] : [];
        }
        const id = String(values[0]);
        if (table === "vehicle_cost_ledger_entry") {
          lockedOriginalIds.push(id);
          operationTimeline.push(`original-lock:${id}`);
        } else {
          lockedAuthorities.push({ id, table });
          operationTimeline.push(`authority-lock:${table}:${id}`);
        }
      }
      return [{ id: values[0] }];
    },
    assetAccountingCommandReceipt: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (database.nextReceiptCreateError) {
          const error = database.nextReceiptCreateError;
          database.nextReceiptCreateError = undefined;
          throw error;
        }
        const key = receiptKey(data.sourceType, data.sourceId, data.sourceKey);
        if (receipts.has(key)) {
          throw databaseError("23505", "asset_accounting_command_receipt_source_key");
        }
        const row = { ...data, createdAt: NOW, id: String(data.id ?? randomUUID()) };
        receipts.set(key, row);
        return row;
      },
      findUnique: async ({ where }: { where: Record<string, Record<string, unknown>> }) => {
        operationTimeline.push("receipt-lookup");
        const source = where.sourceType_sourceId_sourceKey;
        if (!source) throw new Error("missing source receipt identity");
        return (
          receipts.get(receiptKey(source.sourceType, source.sourceId, source.sourceKey)) ?? null
        );
      }
    },
    businessExceptionApproval: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (database.nextApprovalCreateError) {
          const error = database.nextApprovalCreateError;
          database.nextApprovalCreateError = undefined;
          throw error;
        }
        const row = { ...data, createdAt: NOW, id: String(data.id ?? randomUUID()) };
        approvals.set(String(row.id), row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => approvals.get(where.id) ?? null,
      findMany: async (args: {
        orderBy: Array<Record<string, "asc" | "desc">>;
        where: Record<string, unknown>;
      }) => {
        database.lastApprovalFindManyArgs = structuredClone(args);
        return [...approvals.values()]
          .filter((row) => Object.entries(args.where).every(([key, value]) => row[key] === value))
          .sort((left, right) => {
            for (const order of args.orderBy) {
              const [key, direction] = Object.entries(order)[0]!;
              const leftValue = left[key];
              const rightValue = right[key];
              const comparison =
                leftValue instanceof Date && rightValue instanceof Date
                  ? leftValue.getTime() - rightValue.getTime()
                  : String(leftValue).localeCompare(String(rightValue));
              if (comparison !== 0) return direction === "asc" ? comparison : -comparison;
            }
            return 0;
          });
      },
      update: async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const current = approvals.get(where.id);
        if (!current) throw new Error("missing approval fixture");
        const version = data.version;
        const next = {
          ...current,
          ...data,
          version:
            isIncrement(version) && typeof current.version === "number"
              ? current.version + version.increment
              : version
        };
        approvals.set(where.id, next);
        return next;
      }
    },
    assetOwner: delegate(authorities.assetOwner),
    assetWorkOrder: delegate(authorities.assetWorkOrder),
    assetWorkOrderEvidence: delegate(authorities.assetWorkOrderEvidence),
    contract: delegate(authorities.contract),
    customer: delegate(authorities.customer),
    subscriptionOrder: delegate(authorities.subscriptionOrder),
    user: delegate(authorities.user),
    vehicle: delegate(authorities.vehicle),
    vehicleCostLedgerEntry: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (database.nextEntryCreateError) {
          const error = database.nextEntryCreateError;
          database.nextEntryCreateError = undefined;
          throw error;
        }
        if (
          data.reversalOfEntryId &&
          [...entries.values()].some((entry) => entry.reversalOfEntryId === data.reversalOfEntryId)
        ) {
          throw databaseError("23505", "vehicle_cost_ledger_entry_reversal_of_entry_id_key");
        }
        const row = {
          ...data,
          assetOwnerSnapshot:
            data.assetOwnerSnapshot === Prisma.JsonNull ? null : data.assetOwnerSnapshot,
          createdAt: NOW,
          evidenceSnapshot:
            data.evidenceSnapshot === Prisma.JsonNull ? null : data.evidenceSnapshot,
          id: String(data.id ?? randomUUID())
        } as VehicleCostLedgerEntry;
        entries.set(row.id, row);
        return row;
      },
      findMany: async () => [...entries.values()],
      findUnique: async ({ where }: { where: { id: string } }) => entries.get(where.id) ?? null
    }
  };
  database.tx = tx as unknown as Prisma.TransactionClient;
  void probeCount;
  return database;
}

function delegate(store: Map<string, AuthorityRecord>) {
  return {
    findUnique: async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null
  };
}

function updateAuthority(
  store: Map<string, AuthorityRecord>,
  id: string,
  patch: Record<string, unknown>
) {
  const current = store.get(id);
  if (!current) throw new Error(`Missing authority fixture ${id}`);
  store.set(id, { ...current, ...patch });
}

function appendCommand(
  ids: FixtureIds,
  key: string
): AppendCostEntryCommand & { readonly reason: string } {
  return {
    actionType: "ACTUAL_COST",
    accountingPeriod: "2026-08",
    actorId: ids.actorId,
    amountCents: 100n,
    assetOwnerId: ids.assetOwnerId,
    assetOwnerSnapshot: { ownerNo: "AO-001" },
    confirmedAt: NOW,
    contractId: ids.contractId,
    costCategory: "REPAIR",
    customerId: ids.customerId,
    evidenceId: ids.evidenceId,
    evidenceSnapshot: { sha256: "a".repeat(64) },
    occurredOn: OCCURRED_ON,
    orderId: ids.orderId,
    responsiblePartyId: ids.customerId,
    responsiblePartyType: "CUSTOMER",
    reason: "confirmed against the inspected supplier invoice",
    responsibilitySnapshot: { basis: "inspection" },
    source: { id: ids.sourceId, key, type: "ASSET_WORK_ORDER" },
    vehicleId: ids.vehicleId,
    workOrderId: ids.workOrderId
  };
}

function reverseCommand(
  ids: FixtureIds,
  originalEntryId: string,
  key: string
): ReverseCostEntryCommand & { readonly reason: string } {
  return {
    actorId: ids.actorId,
    confirmedAt: new Date("2026-08-20T11:00:00.000Z"),
    originalEntryId,
    reason: "correcting the confirmed cost with a full reversal",
    source: { id: ids.sourceId, key, type: "ASSET_WORK_ORDER" }
  };
}

function fixtureIds() {
  return {
    actorId: randomUUID(),
    assetOwnerId: randomUUID(),
    contractId: randomUUID(),
    customerId: randomUUID(),
    deciderId: randomUUID(),
    evidenceId: randomUUID(),
    orderId: randomUUID(),
    sourceId: randomUUID(),
    vehicleId: randomUUID(),
    workOrderId: randomUUID()
  };
}

function approvalSubject(ids: FixtureIds) {
  return {
    subjectField: "fixtureApprovalField",
    subjectId: ids.vehicleId,
    subjectType: "VEHICLE" as const
  };
}

function requestApprovalCommand(ids: FixtureIds, key: string): RequestExceptionApprovalCommand {
  return {
    authoritySnapshot: { factRevision: 1, state: "PENDING" },
    exceptionType: "HANDOVER_EVIDENCE_EXCEPTION",
    requestEvidenceSnapshot: { evidenceRevision: 1 },
    requestReason: "registration evidence is pending",
    requestedAt: NOW,
    requestedBy: ids.actorId,
    source: { id: ids.sourceId, key, type: "HANDOVER_FIXTURE" },
    subject: approvalSubject(ids)
  };
}

function decideApprovalCommand(
  ids: FixtureIds,
  approvalId: string,
  key: string
): DecideExceptionApprovalCommand {
  return {
    approvalId,
    authoritySnapshot: { factRevision: 1, state: "PENDING" },
    decidedAt: new Date("2026-08-20T10:10:00.000Z"),
    decidedBy: ids.deciderId,
    decision: "APPROVED",
    decisionComment: "reviewed fixture evidence",
    exceptionType: "HANDOVER_EVIDENCE_EXCEPTION",
    expectedVersion: 0,
    source: { id: ids.sourceId, key, type: "HANDOVER_FIXTURE" },
    subject: approvalSubject(ids)
  };
}

function expireApprovalCommand(
  ids: FixtureIds,
  approvalId: string,
  expectedVersion: number,
  key: string
): ExpireExceptionApprovalCommand & {
  readonly authoritySnapshot: { readonly factRevision: number; readonly state: string };
} {
  return {
    approvalId,
    authoritySnapshot: { factRevision: 2, state: "CHANGED" },
    exceptionType: "HANDOVER_EVIDENCE_EXCEPTION",
    expectedVersion,
    expiredAt: new Date("2026-08-20T10:20:00.000Z"),
    expiredBy: ids.deciderId,
    expiryReason: "authoritative snapshot changed",
    source: { id: ids.sourceId, key, type: "HANDOVER_FIXTURE" },
    subject: approvalSubject(ids)
  };
}

function requireCurrentCommand(
  ids: FixtureIds,
  approvalId: string,
  expectedVersion: number,
  key: string,
  authoritySnapshot: RequireCurrentApprovedExceptionCommand["authoritySnapshot"]
): RequireCurrentApprovedExceptionCommand {
  return {
    ...expireApprovalCommand(ids, approvalId, expectedVersion, key),
    authoritySnapshot
  };
}

function isIncrement(value: unknown): value is { increment: number } {
  return (
    value !== null &&
    typeof value === "object" &&
    "increment" in value &&
    typeof value.increment === "number"
  );
}

function receiptKey(type: unknown, id: unknown, key: unknown) {
  return `${String(type)}:${String(id)}:${String(key)}`;
}

function sqlText(query: unknown) {
  if (!query || typeof query !== "object" || !("strings" in query)) return "";
  return (query.strings as readonly string[]).join("?");
}

function sqlValues(query: unknown): readonly unknown[] {
  if (!query || typeof query !== "object" || !("values" in query)) return [];
  return query.values as readonly unknown[];
}

function databaseError(code: string, constraint: string) {
  return {
    code: "P2010",
    meta: {
      driverAdapterError: {
        cause: { constraint, originalCode: code }
      }
    }
  };
}

function databaseMessageError(code: string, message: string) {
  return {
    code: "P2010",
    message,
    meta: {
      driverAdapterError: {
        cause: { message, originalCode: code }
      }
    }
  };
}

function p2002AdapterError(
  fields: readonly string[],
  originalMessage: string,
  originalCode = "23505",
  kind = "UniqueConstraintViolation",
  target?: readonly string[]
) {
  return Object.assign(new Error(originalMessage), {
    code: "P2002",
    meta: {
      ...(target ? { target: [...target] } : {}),
      driverAdapterError: {
        cause: {
          constraint: { fields: [...fields] },
          kind,
          originalCode,
          originalMessage
        }
      }
    }
  });
}

function p2002NamedConstraintError(constraint: string, originalMessage = "unique violation") {
  return Object.assign(new Error(originalMessage), {
    code: "P2002",
    meta: {
      driverAdapterError: {
        cause: {
          constraint,
          kind: "UniqueConstraintViolation",
          originalCode: "23505",
          originalMessage
        }
      }
    }
  });
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected conflict ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    const response = (error as ConflictException).getResponse();
    expect(response).toMatchObject({ code });
  }
}
