import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  SUBSCRIPTION_CLOSURE_ERROR_CODE,
  SubscriptionClosureRepository,
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
});

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
