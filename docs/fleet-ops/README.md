\# Fleet Ops OS Planning Docs



This directory contains the architecture source, current review conclusion, and next-stage Codex construction specs for Fleet Ops OS.



\- source/plan\_design.md: Plan A architecture design

\- source/code\_review\_202607011626.md: Current code review conclusion

\- next-stage/dev\_spec.md: Development specification

\- next-stage/agents.md: Agent responsibilities and construction discipline

\- next-stage/codex\_tasks.md: Codex task backlog and prompts

\- docs/fleet-ops/next-stage/codex_workflow_rules.md: Codex branch, build, verify, recovery, and local commit governance rules

\- runbooks/staging-smoke.md: P1-H11 staging enablement and smoke runbook for the read-only Fleet Ops API/UI after P1-H10.1 or newer. Use it to enable `FLEET_OPS_API_ENABLED=true`, run the existing access sync command when an existing DB lacks Fleet Ops access, verify ADMIN / OP / GM access, and confirm Fleet Ops remains read-only.

\- runbooks/production-readiness.md: P1-H14 production readiness checklist for a later controlled production enablement decision after successful P1-H13 smoke evidence. Production enablement is not automatic; `FLEET_OPS_API_ENABLED` remains operator-controlled, and Fleet Ops remains read-only.

\- runbooks/production-go-no-go-record.md: P1-H15 production GO / NO-GO decision record to complete after the production readiness checklist. The record defaults to `PENDING`, does not enable production by itself, and keeps Fleet Ops read-only.

\- runbooks/production-image-alignment.md: P1-H18 production API/Web image alignment runbook to use before production access sync and feature flag enablement. It keeps `FLEET_OPS_API_ENABLED=false` during image rollout and separates image alignment from Fleet Ops enablement.

\- runbooks/production-enablement-record-20260705.md: P1-H22 production enablement record. It records the operator-completed production enablement outcome with conclusion `PASS_WITH_NOTES` and tracks follow-up P1-H23 vehicle selector/lookup work.
