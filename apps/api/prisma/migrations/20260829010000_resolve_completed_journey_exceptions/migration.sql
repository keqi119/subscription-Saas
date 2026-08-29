UPDATE "subscription_journey_exception" AS exception
SET
  "status" = 'RESOLVED',
  "resolved_at" = COALESCE(exception."resolved_at", clock_timestamp()),
  "resolution_notes" = COALESCE(
    exception."resolution_notes",
    'Automatically resolved during terminal journey/step consistency repair.'
  ),
  "updated_at" = clock_timestamp()
FROM
  "subscription_journey" AS journey,
  "subscription_journey_step" AS step
WHERE journey."id" = exception."journey_id"
  AND step."id" = exception."step_id"
  AND step."journey_id" = exception."journey_id"
  AND (
    step."status" IN ('COMPLETED', 'SKIPPED', 'CANCELLED')
    OR journey."status" IN ('COMPLETED', 'CANCELLED')
  )
  AND exception."status" IN ('OPEN', 'ACKNOWLEDGED');
