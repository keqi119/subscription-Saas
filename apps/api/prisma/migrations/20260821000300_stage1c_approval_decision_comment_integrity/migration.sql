BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."business_exception_approval"
    WHERE (
      "status" IN ('APPROVED', 'REJECTED')
      AND ("decision_comment" IS NULL OR btrim("decision_comment") = '')
    ) OR (
      "status" = 'EXPIRED'
      AND "decision" = 'APPROVED'
      AND ("decision_comment" IS NULL OR btrim("decision_comment") = '')
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'business_exception_approval_status_shape_chk',
      MESSAGE = 'business_exception_approval contains terminal decisions without a nonblank decision comment';
  END IF;
END;
$$;

ALTER TABLE "public"."business_exception_approval"
  DROP CONSTRAINT "business_exception_approval_status_shape_chk";

ALTER TABLE "public"."business_exception_approval"
  ADD CONSTRAINT "business_exception_approval_status_shape_chk" CHECK (
    ("status" = 'PENDING' AND "decision" IS NULL AND "decision_comment" IS NULL AND "decided_by" IS NULL AND "decided_at" IS NULL AND "expiry_reason" IS NULL AND "expired_by" IS NULL AND "expired_at" IS NULL)
    OR ("status" = 'APPROVED' AND "decision" = 'APPROVED' AND "decision_comment" IS NOT NULL AND btrim("decision_comment") <> '' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "expiry_reason" IS NULL AND "expired_by" IS NULL AND "expired_at" IS NULL)
    OR ("status" = 'REJECTED' AND "decision" = 'REJECTED' AND "decision_comment" IS NOT NULL AND btrim("decision_comment") <> '' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "expiry_reason" IS NULL AND "expired_by" IS NULL AND "expired_at" IS NULL)
    OR ("status" = 'EXPIRED' AND "expiry_reason" IS NOT NULL AND "expired_by" IS NOT NULL AND "expired_at" IS NOT NULL AND (
      ("decision" IS NULL AND "decision_comment" IS NULL AND "decided_by" IS NULL AND "decided_at" IS NULL)
      OR ("decision" = 'APPROVED' AND "decision_comment" IS NOT NULL AND btrim("decision_comment") <> '' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
    ))
  );

COMMIT;
