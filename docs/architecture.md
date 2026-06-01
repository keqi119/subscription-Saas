# Architecture

The first implementation stage initializes a TypeScript monorepo for the back-office
platform described in `DEV_SPEC.md`.

## Decisions

- Package manager: pnpm workspace.
- Web app: Next.js App Router with Ant Design.
- API app: independent NestJS service.
- Database: PostgreSQL with Prisma migrations.
- Authentication target: account/password + JWT Cookie + RBAC in the next stage.
- File storage target: local disk first, object storage later.
- Deployment target: Alibaba Cloud ECS.

## Stage Boundaries

Stage 0 only creates the engineering skeleton. It intentionally does not add business
tables, login flows, customer modules, vehicle modules, billing, or reports.

Stage 1 adds users, roles, permissions, menus, JWT Cookie login, RBAC guards, and
audit logs. Business modules remain out of scope until later stages.

Stage 2 adds customer center and application intake: customers, identity/profile
metadata, followups, application drafts, material uploads, submission, and basic
review state transitions. Risk scoring rules, deposits, vehicle assignment, billing,
and contracts remain out of scope.

Stage 3 adds risk management: A/B/C deposit rules, default-rate configuration,
overlap validation for active rule date ranges, and risk results generated from
application approval. Product quotes will read the approved risk result and matched
deposit rule in a later stage.
