CREATE SCHEMA stage1_invalid_order_retirement;

CREATE TABLE stage1_invalid_order_retirement.target_state (
  entity text PRIMARY KEY,
  status text NOT NULL,
  version integer NOT NULL DEFAULT 0,
  cancelled_at timestamptz,
  pause_reason text
);

CREATE TABLE stage1_invalid_order_retirement.retirement_audit (
  id bigserial PRIMARY KEY,
  data jsonb NOT NULL
);

GRANT USAGE ON SCHEMA stage1_invalid_order_retirement TO {{runtime_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA stage1_invalid_order_retirement TO {{runtime_role}};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA stage1_invalid_order_retirement TO {{runtime_role}};
