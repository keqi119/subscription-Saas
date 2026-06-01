# Database Schema Plan

Stage 1 creates the system foundation tables:

- `user`
- `role`
- `permission`
- `menu`
- `user_role`
- `role_permission`
- `role_menu`
- `audit_log`

Stage 2 adds customer intake tables:

- `customer`
- `customer_identity`
- `customer_profile`
- `customer_followup`
- `application`
- `application_material`
- `file_object`

Stage 3 adds risk approval and deposit rule tables:

- `risk_result`
- `deposit_rule`

Core business tables such as `product`, `subscription_quote`, `vehicle`, `bill`,
and `deposit_account` should be added in later staged migrations.

Migration:

- `apps/api/prisma/migrations/20260529130000_init_auth_rbac_audit/migration.sql`
- `apps/api/prisma/migrations/20260529182324_customer_application/migration.sql`
- `apps/api/prisma/migrations/20260530025454_risk_deposit_rules/migration.sql`

Seed:

- `pnpm prisma:seed`
- default admin username: `admin`
- default A/B/C deposit rules are seeded from `apps/api/prisma/seed.mjs`
