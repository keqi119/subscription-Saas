BEGIN;

CREATE UNIQUE INDEX "payment_order_provider_transaction_id_key"
ON "payment_order"("provider", "provider_transaction_id")
WHERE "provider_transaction_id" IS NOT NULL;

COMMIT;
