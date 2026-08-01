ALTER TYPE "customer_verification_code_purpose"
  ADD VALUE IF NOT EXISTS 'FIELD_HANDOVER_ASSIGNED';

ALTER TYPE "vehicle_handover_workflow_job_type"
  ADD VALUE IF NOT EXISTS 'NOTIFY_FIELD_HANDOVER_ASSIGNED';
