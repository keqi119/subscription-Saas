# AGENTS.md

## Project

This repository implements a China mainland EV subscription operation platform.

The business includes:
- customer onboarding
- risk approval
- deposit rules
- vehicle subscription orders
- contracts
- vehicle preparation and delivery
- billing and payment write-off
- deposit pool management
- overdue collection
- customer benefits
- ROA/ROE reports

## Instructions

1. Always read DEV_SPEC.md before modifying business logic.
2. Do not remove existing features unless explicitly requested.
3. Implement features incrementally.
4. Use TypeScript strictly if the stack is TypeScript.
5. All money fields are stored in cents.
6. All important status values must be enums.
7. All critical operations must write audit logs.
8. Do not hardcode business constants if they belong in configuration tables.
9. Write tests for status transitions and financial calculations.
10. After changes, run lint, typecheck, and tests.

## Business Rules

- Monthly subscription fee must not exceed 3.5% of vehicle purchase price unless product settings explicitly change.
- Customers are graded A/B/C.
- Deposit amount and default rate are configured by customer grade.
- Delivery requires signed contract, received deposit, received first monthly fee, valid insurance, and prepared vehicle.
- Deposit deduction must generate a transaction record.
- Order and vehicle status transitions must be auditable.

## Expected Output

When completing a task:
- summarize changed files
- summarize business behavior added
- provide how to test
- list known limitations
