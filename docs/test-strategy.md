# Test Strategy

Stage 0 validation:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm prisma:validate`

Stage 1 validation adds tests for:

- RBAC permission checks
- authenticated user role/permission/menu projection
- API user view sanitization
- shared menu permission code centralization

Stage 2 and 3 validation adds tests for:

- customer/application API response serialization
- application material bigint serialization
- deposit rule date range overlap behavior
- risk result and deposit rule decimal/bigint serialization

Manual verification should cover:

- seed admin login
- role menu visibility
- permission denial returning 403
- audit logs written on login and system mutations

Later stages should focus on state transitions and financial calculations.
