BEGIN;

ALTER TABLE "subscription_journey_step"
ADD CONSTRAINT "subscription_journey_step_id_journey_id_key"
UNIQUE ("id", "journey_id");

ALTER TABLE "subscription_journey_job"
ADD CONSTRAINT "subscription_journey_job_identity_key"
UNIQUE ("id", "step_id", "journey_id");

ALTER TABLE "subscription_journey_job"
ADD CONSTRAINT "subscription_journey_job_step_journey_fkey"
FOREIGN KEY ("step_id", "journey_id")
REFERENCES "subscription_journey_step" ("id", "journey_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_journey_manual_task"
ADD CONSTRAINT "subscription_journey_manual_task_step_journey_fkey"
FOREIGN KEY ("step_id", "journey_id")
REFERENCES "subscription_journey_step" ("id", "journey_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_journey_exception"
ADD CONSTRAINT "subscription_journey_exception_step_journey_fkey"
FOREIGN KEY ("step_id", "journey_id")
REFERENCES "subscription_journey_step" ("id", "journey_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_journey_exception"
ADD CONSTRAINT "subscription_journey_exception_job_identity_fkey"
FOREIGN KEY ("job_id", "step_id", "journey_id")
REFERENCES "subscription_journey_job" ("id", "step_id", "journey_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
