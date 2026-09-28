# R3 managed containerd observation

This implements the already approved R3 encrypted-storage requirement in
`docs/superpowers/specs/2026-09-28-stage1-r3-target-policy-slice.zh-CN.md`.
It adds no business feature, cloud service, KMS or release approval step.

## Work

- [x] Read the managed child PID, parent/start identity, actual executable,
      generated configuration, encrypted data/state directories and owned Unix
      listener. Retain bounded nonsecret originals and stable observation facts.
- [x] Require that observation before returning hosted Engine facts. Reobserve
      and compare its identity before each PG relay connection; reject drift.
      Keep the original UNKNOWN and workspace when an observation fails.
- [x] Run only the observer tests and existing hosted control tests affected by
      this change. Verify contracts, syntax and formatting, then record exact
      results and the remaining destination/workflow work.

## Implementation boundary

The observer takes only `mountPath` and the actually spawned `dockerdPid`.
It derives the Moby managed paths, checks `/proc` and filesystem readback, and
returns `{facts,rawInputs}`; it cannot create resources or grant authority.
The hosted controller passes its own PID/workspace and compares stable facts
again during relay admission. It carries the original bytes in the existing
result envelope rather than introducing a public schema or evidence service.

The expected layout follows Moby v26.1.3's
[managed daemon](https://github.com/moby/moby/blob/v26.1.3/libcontainerd/supervisor/remote_daemon.go)
and [Linux socket defaults](https://github.com/moby/moby/blob/v26.1.3/libcontainerd/supervisor/remote_daemon_linux.go).
Reading only daemon.json is insufficient: Docker can adopt a system containerd,
and the managed supervisor can restart its child. The observation must identify
the running child and actual listener, not infer them from intended paths.

## Preflight

Base: clean `21208d1ad2dea87f16b9ffd4e28fe7d33d37e4fa`.
Migration command failed with `The datasource.url property is required in your
Prisma config file when using prisma migrate status.` (`a41058`; inner pnpm
exit 1, PowerShell finally masked the shell exit). URL/dotenv disabled, no DB
connection. Prisma validation passed (`2ccd03`, exit 0). No business code changes.

## Remaining release work

This observation alone is not destination admission or creation success.
Hosted producer/import, same-session result/custody/consumer/cleanup, lifecycle
execution, the final candidate and actual R2/R3/R4 acceptance remain required.
The existing OSS renewal/1 GiB roundtrip is already recorded; do not repeat it.

## Verification record

- Control regression first failed on the absent containerd facts (`18d76f`,
  0/1, 2,007.68535 ms); original `r3-containerd-control-red01.log` is retained.
- Observer agent recorded missing-module RED and three focused Linux passes
  (`879b79`, 169.09551 ms). The combined final root run (`82fec6`) passed
  10/10, 0 skip, 2,877.09633 ms; log `r3-containerd-control-green01.log`.
  Copy `/root/.cache/r3-containerd-HSmRIy`, 263 source paths bound by
  `20260928-034703-080383656-copy.sha256`. Native sockets and child processes
  are real; managed runtime, filesystem topology and PG facts are fixtures.
- Contract verification and syntax/diff checks passed (`d2d47f`): 215 files,
  83 schemas, 128 migrations, 13 commands; repository digest
  `sha256:791d9fb940c99eb95429226bb11ffe0a1ef1df5435093b492439a94a09e1153b`.
- Read-only H1 check found no `/var/run/docker/containerd/containerd.toml`
  (`40102f`). No service or database was started or changed for this check.
- The parser permits the empty default GRPC TCP/TLS fields defined by
  [containerd 1.7 config](https://github.com/containerd/containerd/blob/v1.7.18/services/server/config/config.go),
  while refusing external overrides. It is deliberately a limited parser for
  Moby's generated configuration, not general TOML support.
- The bounded independent review found one evidence omission: the observed
  PID's matching fd paths and readlink values had not been retained. These are
  now included as `socketOwners`, without collecting unrelated descriptors.
  Review accepted the correction and found no further blocker in this scope.
- After that correction, the final combined run (`r3-containerd-control-green02.log`)
  passed 10/10, 0 skip, 3,328.36227 ms, naturally exiting 0. Copy
  `/root/.cache/r3-containerd-j6qjAh`, manifest
  `20260928-035054-250246697-copy.sha256`, 263 paths. Final contracts passed
  (`5ccf9e`) with the same counts and repository digest
  `sha256:84bc06048dba26dcf38a4dc22290e673ae03422d832451d9a2802d3e48c5a886`.
  Discovery passed 99 candidates / 39 manifested / 60 excepted / 0 unclassified
  (`dcfdf3`), without a new database suite or exception. No long R2 tests rerun.
