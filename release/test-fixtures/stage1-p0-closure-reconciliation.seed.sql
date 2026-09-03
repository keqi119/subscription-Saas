INSERT INTO public."role" (id, code, name, status, updated_at, deleted_at)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'ADMIN', 'ADMIN', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('10000000-0000-4000-8000-000000000002', 'AS', 'AS', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('10000000-0000-4000-8000-000000000003', 'CS', 'CS', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('10000000-0000-4000-8000-000000000004', 'FI', 'FI', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('10000000-0000-4000-8000-000000000005', 'GM', 'GM', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('10000000-0000-4000-8000-000000000006', 'OP', 'OP', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('10000000-0000-4000-8000-000000000007', 'RC', 'RC', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('10000000-0000-4000-8000-000000000008', 'SA', 'SA', 'ACTIVE', CURRENT_TIMESTAMP, NULL)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  status = EXCLUDED.status,
  updated_at = EXCLUDED.updated_at,
  deleted_at = NULL;

INSERT INTO public.permission (id, code, name, module, action, status, updated_at, deleted_at)
VALUES
  ('20000000-0000-4000-8000-000000000001', 'subscription_closure:view', 'subscription_closure:view', 'subscription_closure', 'view', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('20000000-0000-4000-8000-000000000002', 'subscription_closure:prepare', 'subscription_closure:prepare', 'subscription_closure', 'prepare', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('20000000-0000-4000-8000-000000000003', 'subscription_closure:receive', 'subscription_closure:receive', 'subscription_closure', 'receive', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('20000000-0000-4000-8000-000000000004', 'subscription_closure:inspect', 'subscription_closure:inspect', 'subscription_closure', 'inspect', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('20000000-0000-4000-8000-000000000005', 'subscription_closure:settle', 'subscription_closure:settle', 'subscription_closure', 'settle', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('20000000-0000-4000-8000-000000000006', 'subscription_recovery:assess', 'subscription_recovery:assess', 'subscription_recovery', 'assess', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('20000000-0000-4000-8000-000000000007', 'subscription_recovery:approve', 'subscription_recovery:approve', 'subscription_recovery', 'approve', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('20000000-0000-4000-8000-000000000008', 'subscription_recovery:execute', 'subscription_recovery:execute', 'subscription_recovery', 'execute', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('20000000-0000-4000-8000-000000000009', 'subscription_early_termination:create', 'subscription_early_termination:create', 'subscription_early_termination', 'create', 'ACTIVE', CURRENT_TIMESTAMP, NULL),
  ('20000000-0000-4000-8000-000000000010', 'subscription_early_termination:execute', 'subscription_early_termination:execute', 'subscription_early_termination', 'execute', 'ACTIVE', CURRENT_TIMESTAMP, NULL)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  module = EXCLUDED.module,
  action = EXCLUDED.action,
  status = EXCLUDED.status,
  updated_at = EXCLUDED.updated_at,
  deleted_at = NULL;

DELETE FROM public.role_permission grant_row
USING public."role" role_row, public.permission permission_row
WHERE grant_row.role_id = role_row.id
  AND grant_row.permission_id = permission_row.id
  AND role_row.code IN ('ADMIN', 'AS', 'CS', 'FI', 'GM', 'OP', 'RC', 'SA')
  AND permission_row.code IN (
    'subscription_closure:view',
    'subscription_closure:prepare',
    'subscription_closure:receive',
    'subscription_closure:inspect',
    'subscription_closure:settle',
    'subscription_recovery:assess',
    'subscription_recovery:approve',
    'subscription_recovery:execute',
    'subscription_early_termination:create',
    'subscription_early_termination:execute'
  );

WITH expected_grant(role_code, permission_code) AS (
  VALUES
    ('ADMIN', 'subscription_closure:view'),
    ('ADMIN', 'subscription_closure:prepare'),
    ('ADMIN', 'subscription_closure:receive'),
    ('ADMIN', 'subscription_closure:inspect'),
    ('ADMIN', 'subscription_closure:settle'),
    ('ADMIN', 'subscription_recovery:assess'),
    ('ADMIN', 'subscription_recovery:approve'),
    ('ADMIN', 'subscription_recovery:execute'),
    ('ADMIN', 'subscription_early_termination:create'),
    ('ADMIN', 'subscription_early_termination:execute'),
    ('AS', 'subscription_closure:view'),
    ('AS', 'subscription_closure:receive'),
    ('AS', 'subscription_closure:inspect'),
    ('AS', 'subscription_recovery:execute'),
    ('CS', 'subscription_closure:view'),
    ('CS', 'subscription_closure:prepare'),
    ('CS', 'subscription_early_termination:create'),
    ('FI', 'subscription_closure:view'),
    ('FI', 'subscription_closure:settle'),
    ('GM', 'subscription_closure:view'),
    ('GM', 'subscription_recovery:approve'),
    ('OP', 'subscription_closure:view'),
    ('OP', 'subscription_closure:prepare'),
    ('OP', 'subscription_closure:receive'),
    ('OP', 'subscription_closure:inspect'),
    ('OP', 'subscription_recovery:assess'),
    ('OP', 'subscription_recovery:execute'),
    ('OP', 'subscription_early_termination:create'),
    ('OP', 'subscription_early_termination:execute'),
    ('RC', 'subscription_closure:view'),
    ('RC', 'subscription_recovery:assess'),
    ('SA', 'subscription_closure:view')
)
INSERT INTO public.role_permission (id, role_id, permission_id, deleted_at)
SELECT gen_random_uuid(), role_row.id, permission_row.id, NULL
FROM expected_grant expected
JOIN public."role" role_row ON role_row.code::text = expected.role_code
JOIN public.permission permission_row ON permission_row.code = expected.permission_code;
