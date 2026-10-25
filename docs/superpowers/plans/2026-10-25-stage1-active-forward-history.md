# Stage1 Active Forward History Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this small change and an independent final review.

**Goal:** Verify old R3 incident history while the new session legitimately holds its two forward slots.

**Architecture:** Keep full capture and strict incident validation; give only live history verification a view excluding its exact privately held lock bytes.

**Tech Stack:** Node.js ESM, node:test.

**Spec:** `docs/superpowers/specs/2026-10-25-stage1-active-forward-history-design.md`

## Global Constraints

- Preserve all historical records, 39 target locks and UNKNOWN status.
- Never exclude an unknown, missing, or substituted lock by name alone.
- No business, schema, RAM, or online RC mutation in this repair segment.
- User standing authorization covers implementation and GitHub integration.

## Review Focus

Current-versus-historical scope, byte substitution, retained target preservation, full capture recheck, and standalone readers retaining the complete lock view.

## Task 1: Repair the live historical view

**Files:** `packages/release-foundation/src/manual-stage1-session.mjs`; `packages/release-foundation/test/manual-stage1-session.test.mjs`; `packages/release-foundation/test/manual-r3-created-target-incident.test.mjs`; root/package test scripts and `scripts/release-check.mjs`.

**Interface:** `verifyR3History` uses closure-owned `lockPath`, `observerLockPath`, and `lockBytes`; historical reader interfaces remain unchanged.

- [x] Extend the existing approved-failed-history session test to assert exact active-lock exclusion at the native reader boundary while the actual store still contains both current locks and an unrelated retained lock remains visible. Watch it fail against 453da778.
- [x] In the live caller only, require exactly one captured entry per current lock name and exact byte equality. Pass a shallow environment copy with only those two entries removed. Preserve the full capture.
- [ ] Cover changed/missing current locks and the strict created-target assessor's continued rejection of retired forward locks. Run the affected session and incident suites with module mocks enabled; run Prisma validation already required by the repository.
- [ ] Independently review, commit, push and merge after relevant CI passes. Freeze the completed repair segment and the existing remote evidence; only prepare a new candidate after the substantive fix is verified.

CI coverage: enable module mocks for the existing foundation suite; add the five-case `release:history:test` command to normal release checks. Remove the silent skip. PR/main CI does not need another full release-foundation run for this narrow regression.

## Preflight

The isolated worktree is detached at 453da778 with only seven pre-existing untracked PR-body files. Local migration status reports missing datasource.url; the deployed datasource configuration and two pending Stage1 migrations were previously established. This release-control-only repair changes no business code and does not reconfigure the database. Prisma validation passes. The local missing URL is not the RC failure.
