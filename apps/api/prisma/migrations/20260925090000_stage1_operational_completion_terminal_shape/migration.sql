-- Operational completion and financial settlement are independent axes.
-- Preserve the legacy settled terminal shape without inventing settled_at for
-- a finalized case whose outstanding receivables remain under governed ownership.
ALTER TABLE "subscription_closure_case"
  DROP CONSTRAINT "subscription_closure_case_terminal_shape_chk",
  ADD CONSTRAINT "subscription_closure_case_terminal_shape_chk" CHECK (
    (
      "status" = 'COMPLETED'
      AND "final_disposition" = 'COMPLETE'
      AND ("settled_at" IS NOT NULL OR "operational_completed_at" IS NOT NULL)
      AND "closed_at" IS NOT NULL
    )
    OR (
      "status" = 'TERMINATED'
      AND "final_disposition" = 'TERMINATE'
      AND ("settled_at" IS NOT NULL OR "operational_completed_at" IS NOT NULL)
      AND "closed_at" IS NOT NULL
    )
    OR ("status" IN ('REJECTED', 'CANCELLED') AND "closed_at" IS NOT NULL)
    OR ("status" NOT IN ('COMPLETED', 'TERMINATED', 'REJECTED', 'CANCELLED') AND "closed_at" IS NULL)
  );
