CREATE UNIQUE INDEX "contract_esign_task_one_active_per_contract_key"
ON "contract_esign_task"("contract_id")
WHERE "deleted_at" IS NULL
  AND "task_status" IN ('CREATED', 'WAITING_CUSTOMER', 'SIGNING', 'COMPLETED');
