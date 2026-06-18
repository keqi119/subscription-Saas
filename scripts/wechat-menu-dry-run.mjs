#!/usr/bin/env node
import { runMenuCli } from "./wechat-menu.mjs";

if (process.argv.slice(2).includes("--apply")) {
  console.error("scripts/wechat-menu-dry-run.mjs does not support --apply. Use pnpm wechat:menu:apply with WECHAT_MENU_APPLY=1.");
  process.exit(1);
}

runMenuCli(["--dry-run", ...process.argv.slice(2)]).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
