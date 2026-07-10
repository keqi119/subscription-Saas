# Fleet Ops Codex Workflow Governance Rules

## 1. Purpose

This document standardizes how Codex should prepare branches, execute Fleet Ops tasks, verify scope, and create local commits. It exists to shorten future prompts and prevent branch pollution, oversized commits, line-ending churn, accidental pushes, and schema or runtime drift.

These rules apply to Fleet Ops planning, build, verify, recovery, and local commit tasks.

## 2. Source-of-truth Documents And Precedence

Resolve the active checkout before reading repository documents:

```text
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
```

Codex must read these documents before branch prep, build, verify, or local commit work:

1. `docs/fleet-ops/source/plan_design.md`
2. `docs/fleet-ops/source/code_review_202607011626.md`
3. `docs/fleet-ops/next-stage/dev_spec.md`
4. `docs/fleet-ops/next-stage/agents.md`
5. `docs/fleet-ops/next-stage/codex_tasks.md`
6. `docs/fleet-ops/next-stage/codex_workflow_rules.md`
7. `docs/fleet-ops/next-stage/work_mode_handover.md`
8. `docs/fleet-ops/README.md`

If any required source-of-truth document is missing, stop and report the missing file before making changes.

The list above is required context, not a freshness ranking. Explicit task scope
and user approvals control allowed actions. Current code, tests, configuration,
and the newest dated completion or closeout record control current-state claims.
Active specifications control intended constraints. Older plans, reviews, and
task prompts remain historical evidence and must not override newer implemented
or completed state.

## 3. Required Work Phases

Every Codex task must declare one or more phases.

### BRANCH_PREP

Prepare the correct branch from the requested base. Confirm the working tree is clean before switching, rebasing, merging, or creating a branch.

### PLAN

Inspect source files and produce an engineering plan only. Do not write files, stage files, commit, push, or run implementation tasks.

### BUILD

Modify only approved files. Keep the implementation within the approved scope. Do not stage, commit, push, or broaden the task.

### VERIFY

Run focused checks required by the task. Inspect git diff scope, schema diffs, AppModule diffs, write-path scans, and focused tests. Do not fix failures in VERIFY mode unless explicitly asked.

### LOCAL_COMMIT

Create a local commit only after the working tree, staged diff, safety checks, and task-specific checks pass. Stage explicit files only.

### HUMAN_PUSH_PR_MERGE

Remote push, pull request creation, merge, and deployment are human-owned unless a task explicitly allows them. Fleet Ops Codex tasks default to no push.

## 4. Branch Policy Schema

Every build or commit task should include this policy block:

```text
NEW_BRANCH_REQUIRED: yes/no
BASE_BRANCH: origin/main or another explicit base
EXPECTED_BRANCH: feature/<name>
CONTINUE_EXISTING_BRANCH: yes/no
STACKED_PR_ALLOWED: yes/no
PUSH_ALLOWED: yes/no
```

Interpretation:

- `NEW_BRANCH_REQUIRED: yes` means create a new branch from the declared base and do not stack on an existing feature branch.
- `CONTINUE_EXISTING_BRANCH: yes` means stay on the expected branch after confirming it is clean and correct.
- `STACKED_PR_ALLOWED: no` means do not branch from another feature branch.
- `PUSH_ALLOWED: no` means never run `git push`.

## 5. Branch Preparation Protocol

For a new branch:

1. Read the source-of-truth docs.
2. Run `git fetch origin`.
3. Run `git branch --show-current`.
4. Run `git status --short --branch --untracked-files=all`.
5. Stop if the working tree is dirty.
6. Switch to the base branch.
7. Confirm local-only and remote-only commit ranges.
8. Fast-forward the base branch only when safe.
9. Confirm the base branch SHA matches the declared remote tracking branch.
10. Create the expected feature branch.

If remote fetch is unavailable, report it as a note or failure according to the task. Do not claim the branch is based on freshly fetched remote state unless fetch succeeded.

## 6. Continue-existing-branch Protocol

For an existing branch:

1. Confirm the current branch equals `EXPECTED_BRANCH`.
2. Confirm the working tree contains only expected changes.
3. Confirm there are no unrelated staged files.
4. Confirm the branch is not accidentally based on another feature branch unless `STACKED_PR_ALLOWED: yes`.
5. Stop before modifying files if the branch policy is violated.

## 7. Working Tree Safety Gate

Before BUILD, VERIFY, or LOCAL_COMMIT:

```text
git status --short --branch --untracked-files=all
git diff --name-status
git diff --stat
git diff --check
```

Stop if:

- unexpected files appear;
- unrelated source, schema, migration, runtime, or config files are modified;
- whitespace errors are reported;
- the diffstat suggests line-ending churn or broad formatting.

## 8. EOL / CRLF Protection

Fleet Ops tasks must avoid line-ending churn.

Recommended local protection:

```text
git config --local core.autocrlf false
git config --local core.filemode false
```

Before commit, compare:

```text
git diff --stat
git diff --ignore-space-at-eol --stat
```

If plain diffstat is much larger than ignore-EOL diffstat, stop and clean only approved files. Do not run repo-wide renormalization.

## 9. Approved File List Discipline

Every BUILD and LOCAL_COMMIT task must define an approved file list.

Rules:

- Modify only approved files.
- Stage only approved files.
- Do not stage directories.
- Do not use wildcard staging.
- Do not include optional files unless the task explicitly approves them and the diff is substantive.
- Stop if an unrelated file appears.

## 10. Forbidden Commands

Fleet Ops Codex tasks must not run these commands unless a task explicitly approves a narrower variant:

```text
git push
git push --force
git add .
git add -A
git commit -a
git reset --hard
git clean -fd
git checkout -- .
```

Also forbidden by default:

- broad formatters;
- repo-wide renormalization;
- schema generation or migration commands;
- production deploy commands;
- commands that mutate production data.

`git reset --hard`, `git clean -fd`, and destructive restore flows require an explicit recovery task and a backup first.

## 11. Local Commit Protocol

Before committing:

1. Confirm the current branch equals `EXPECTED_BRANCH`.
2. Confirm changed files are limited to the approved list.
3. Confirm schema, migration, AppModule, and unrelated source diffs are empty.
4. Confirm task-specific invariants or tests pass.
5. Stage explicit file paths only.
6. Run:

```text
git diff --cached --name-status
git diff --cached --stat
git diff --cached --check
```

7. Commit with the approved message.
8. Run post-commit status and `git show --stat --name-status --oneline HEAD`.
9. Do not push.

## 12. Human-only Remote Actions

Unless a task explicitly sets `PUSH_ALLOWED: yes`, Codex must not:

- push a branch;
- force push;
- create a pull request;
- merge a pull request;
- deploy;
- change remote branch protection.

The final report may include a manual push command for the user.

## 13. Recovery Playbooks

### Oversized Commit

1. Stop before pushing.
2. Save diagnostics outside the repo when possible.
3. Create a backup branch from the bad commit.
4. Reset the working branch to the intended base only after backup exists.
5. Restore approved files only from the backup.
6. Verify diff scope, EOL status, schema diffs, and focused tests.
7. Create a clean replacement commit.

### Wrong Branch

1. Stop work.
2. Do not commit.
3. Save `git status`, `git log`, and `git diff --stat`.
4. If changes are valid, create a backup branch or patch.
5. Move the changes to the expected branch only with explicit approval or task instructions.

### Dirty Worktree

1. Stop before branch switching or build work.
2. Report changed and untracked files.
3. Do not clean or restore unless the task is a recovery task.
4. If recovery is approved, preserve diagnostics before removing changes.

### EOL Churn

1. Compare plain diffstat with ignore-EOL diffstat.
2. Set repo-local EOL safety config.
3. Normalize only approved files to LF.
4. Re-run diffstat, ignore-EOL diffstat, and `git diff --check`.
5. Stop if churn remains.

### Failed Push

1. Do not retry blindly.
2. Confirm whether the push changed the remote.
3. Check local and remote branch divergence.
4. Preserve the local commit on a backup branch.
5. Never push to `main` unless explicitly approved by the user.

## 14. Required Final Report Format

Every BUILD, VERIFY, RECOVERY, or LOCAL_COMMIT task should report:

```text
1. Verdict: PASS / PASS_WITH_NOTES / FAIL
2. Branch:
   - current branch
   - base SHA
   - HEAD SHA
3. Files changed
4. Scope and safety:
   - docs-only/source-only status
   - schema diff status
   - migration diff status
   - AppModule diff status
   - write-path or runtime exposure status if relevant
5. Verification:
   - commands run
   - results
6. Commit:
   - commit SHA
   - commit message
   - diffstat
7. Manual next step
```

Reports must distinguish verified facts from assumptions or network notes.

## 15. Minimal Prompt Preamble Template

Future Fleet Ops tasks may use this compact preamble:

```text
Resolve the active checkout before reading or changing files:
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

Read and follow:
- docs/fleet-ops/source/plan_design.md
- docs/fleet-ops/source/code_review_202607011626.md
- docs/fleet-ops/next-stage/dev_spec.md
- docs/fleet-ops/next-stage/agents.md
- docs/fleet-ops/next-stage/codex_tasks.md
- docs/fleet-ops/next-stage/codex_workflow_rules.md
- docs/fleet-ops/next-stage/work_mode_handover.md
- docs/fleet-ops/README.md

Branch policy:
NEW_BRANCH_REQUIRED:
BASE_BRANCH:
EXPECTED_BRANCH:
CONTINUE_EXISTING_BRANCH:
STACKED_PR_ALLOWED:
PUSH_ALLOWED: no

Mode:
Approved files:
Verification commands:
Final report requirements:
```
