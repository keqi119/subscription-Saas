// Only selected by the fixed image entrypoint. The H1-owned attach conversation
// supplies the closed input and credential; there is no file or argv override.
import { runR3MigrationRunnerChannel } from "../../../scripts/release/r3-final-migration-channel.mjs";
import { openFinalMigrationRuntime } from "./final-migration-runtime.mjs";

export async function runFinalMigrationEntrypoint() {
  await runR3MigrationRunnerChannel({
    incoming: process.stdin,
    outgoing: process.stdout,
    signal: new AbortController().signal,
    openRuntime: openFinalMigrationRuntime
  });
  // The channel already emitted its complete finite transcript. The CLI must
  // not append a second result, a promotion flag, or a generic execution proof.
}
