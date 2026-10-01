// Docker appends Cmd ["node", "apps/api/dist/src/main.js"] after this fixed
// entrypoint. The first Cmd token is checked, then the actual image command is
// spawned with DATABASE_URL only in its child environment.
async function applicationBootstrap() {
  const [{ spawn }, { Buffer }, { TextDecoder }, { URL }, timers] = await Promise.all([
    import("node:child_process"),
    import("node:buffer"),
    import("node:util"),
    import("node:url"),
    import("node:timers")
  ]);
  const process = globalThis.process;
  const { setTimeout, clearTimeout } = timers;
  const failure = "R3_API_APPLICATION_BOOTSTRAP_FAILED";
  const limit = 16384;
  let pending = Buffer.alloc(0);
  let accepted = false;
  let failed = false;
  let child;

  function fail() {
    if (failed) return;
    failed = true;
    pending.fill(0);
    process.stderr.write(`${failure}\n`);
    if (child) {
      if (!child.kill("SIGKILL")) process.exit(1);
    } else {
      process.exit(1);
    }
  }

  function privateDatabaseUrl(value) {
    if (typeof value !== "string" || value.includes("#")) return false;
    try {
      const url = new URL(value);
      return (
        url.href === value &&
        url.protocol === "postgresql:" &&
        url.hostname === "postgres" &&
        url.port === "5432" &&
        url.username.length > 0 &&
        url.password.length > 0 &&
        /^\/[^/]+$/u.test(url.pathname) &&
        url.search === "?sslmode=require" &&
        decodeURIComponent(url.username).length > 0 &&
        decodeURIComponent(url.password).length > 0 &&
        decodeURIComponent(url.pathname.slice(1)).length > 0
      );
    } catch {
      return false;
    }
  }

  if (
    process.argv.length !== 3 ||
    process.argv[1] !== "node" ||
    process.argv[2] !== "apps/api/dist/src/main.js"
  ) {
    fail();
  }

  const timeout = setTimeout(fail, 15000);
  process.stdin.on("error", fail);
  process.stdin.on("end", () => {
    if (!accepted) fail();
  });
  process.stdin.on("data", (chunk) => {
    if (accepted || pending.length + chunk.length > limit) return fail();
    const newline = chunk.indexOf(10);
    if (newline === -1) {
      pending = Buffer.concat([pending, chunk]);
      return;
    }
    if (newline !== chunk.length - 1) return fail();
    pending = Buffer.concat([pending, chunk]);
    let input;
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, -1)));
    } catch {
      return fail();
    }
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !Object.hasOwn(input, "databaseUrl") ||
      !privateDatabaseUrl(input.databaseUrl)
    ) {
      return fail();
    }
    accepted = true;
    pending.fill(0);
    pending = Buffer.alloc(0);
    clearTimeout(timeout);
    try {
      child = spawn(process.execPath, ["apps/api/dist/src/main.js"], {
        env: { ...process.env, DATABASE_URL: input.databaseUrl },
        stdio: ["ignore", "inherit", "inherit"]
      });
      input.databaseUrl = undefined;
      input = undefined;
    } catch {
      return fail();
    }
    child.once("error", fail);
    const onTerm = () => child.kill("SIGTERM");
    const onInterrupt = () => child.kill("SIGINT");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInterrupt);
    child.once("exit", (code, signal) => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInterrupt);
      if (failed) process.exit(1);
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 1);
    });
  });
  process.stdin.resume();
}

export const API_APPLICATION_ENTRYPOINT = Object.freeze([
  "/usr/local/bin/node",
  "-e",
  `(${applicationBootstrap.toString()})().catch(() => { process.stderr.write("R3_API_APPLICATION_BOOTSTRAP_FAILED\\n"); process.exit(1); });`,
  "--"
]);
