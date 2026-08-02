ALTER TABLE "order_mileage_review"
  DROP CONSTRAINT "order_mileage_review_confirmed_state";

ALTER TABLE "order_mileage_review"
  ADD CONSTRAINT "order_mileage_review_confirmed_state" CHECK (
    "status" <> 'CONFIRMED' OR
    (
      "reviewed_by" IS NOT NULL AND
      "reviewed_at" IS NOT NULL AND
      "allowance_km" IS NOT NULL AND
      "consumed_allowance_km" IS NOT NULL AND
      "over_mileage_km" IS NOT NULL AND
      "over_mileage_fee_amount" IS NOT NULL AND
      "over_mileage_amount" IS NOT NULL AND
      "mileage_reading_id" IS NOT NULL AND
      "entitlement_grant_id" IS NOT NULL AND
      (
        ("consumed_allowance_km" > 0 AND "entitlement_usage_id" IS NOT NULL) OR
        ("consumed_allowance_km" = 0 AND "entitlement_usage_id" IS NULL)
      ) AND
      "calculation_snapshot" IS NOT NULL AND
      (
        ("over_mileage_amount" > 0 AND "over_mileage_bill_id" IS NOT NULL) OR
        ("over_mileage_amount" = 0 AND "over_mileage_bill_id" IS NULL)
      )
    )
  );
