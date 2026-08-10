import { describe, expect, it } from "vitest";

import {
  planPortalBucketPage,
  sortByPortalListOrder
} from "../src/common/portal-list-ordering";

describe("portal list ordering", () => {
  it("sorts priority, deadline, updatedAt, createdAt, then id", () => {
    const rows = [
      key("processing", 1, null, "2026-08-10T03:00:00Z"),
      key("late-action", 0, "2026-08-12T00:00:00Z", "2026-08-10T04:00:00Z"),
      key("early-action", 0, "2026-08-11T00:00:00Z", "2026-08-10T02:00:00Z"),
      key("history", 2, null, "2026-08-10T05:00:00Z")
    ];

    expect(sortByPortalListOrder(rows, (row) => row).map((row) => row.id)).toEqual([
      "early-action",
      "late-action",
      "processing",
      "history"
    ]);
  });

  it("puts a dated row before an undated row inside the same priority", () => {
    const rows = [
      key("undated", 0, null, "2026-08-10T05:00:00Z"),
      key("dated", 0, "2026-08-11T00:00:00Z", "2026-08-10T01:00:00Z")
    ];
    expect(sortByPortalListOrder(rows, (row) => row).map((row) => row.id)).toEqual([
      "dated",
      "undated"
    ]);
  });

  it("plans one page across multiple ordered buckets", () => {
    expect(
      planPortalBucketPage(
        [
          { bucket: "ACTION" as const, count: 3 },
          { bucket: "PROCESSING" as const, count: 4 },
          { bucket: "HISTORY" as const, count: 5 }
        ],
        2,
        5
      )
    ).toEqual([
      { bucket: "ACTION", skip: 2, take: 1 },
      { bucket: "PROCESSING", skip: 0, take: 4 }
    ]);
  });

  it("returns no slices for an offset beyond the total", () => {
    expect(planPortalBucketPage([{ bucket: "A", count: 2 }], 3, 10)).toEqual([]);
  });
});

function key(
  id: string,
  priority: number,
  deadlineAt: string | null,
  updatedAt: string
) {
  return {
    createdAt: new Date("2026-08-01T00:00:00Z"),
    deadlineAt: deadlineAt ? new Date(deadlineAt) : null,
    id,
    priority,
    updatedAt: new Date(updatedAt)
  };
}
