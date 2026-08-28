CREATE UNIQUE INDEX "contract_esign_task_one_active_subscription_change_source_key"
ON "contract_esign_task"("contract_id", "source_type", "source_id")
WHERE "source_type" IN (
  'SUBSCRIPTION_EXTENSION',
  'VEHICLE_SWAP_SUPPLEMENT',
  'EARLY_TERMINATION_SUPPLEMENT',
  'MANAGED_OTHER_SUPPLEMENT'
)
  AND "source_id" IS NOT NULL
  AND "deleted_at" IS NULL
  AND "task_status" IN ('CREATED', 'WAITING_CUSTOMER', 'SIGNING', 'COMPLETED');
