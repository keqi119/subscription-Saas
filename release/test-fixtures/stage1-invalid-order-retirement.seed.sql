DELETE FROM stage1_invalid_order_retirement.retirement_audit;
DELETE FROM stage1_invalid_order_retirement.target_state;

INSERT INTO stage1_invalid_order_retirement.target_state (entity, status, version, pause_reason)
VALUES
  ('billing_schedule', 'PAUSED', 0, 'legacy-test-order'),
  ('lease', 'ACTIVE', 0, NULL),
  ('subscription_order', 'ACTIVE', 0, NULL),
  ('vehicle', 'LEASED', 0, NULL);
