import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Public certificates only. This simulates the external official CLI result;
// production still owns all native paths, readers, lifetimes and dispatch.
export async function tufCliFixture(options, { wrongIssuer = false, expired = false } = {}) {
  const fixtures = JSON.parse(
    await fs.readFile(new URL("./tuf-issuer-certificates.json", import.meta.url))
  );
  const roots = [];
  // The official CLI writes device state independently of its config/cache.
  if (options.env.XDG_STATE_HOME) {
    const state = path.join(options.env.XDG_STATE_HOME, "gh");
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(state, "device-id"), "fixture-device-state");
  }
  for (const [host, issuer] of [
    ["tuf-repo-cdn.sigstore.dev", "publicGood"],
    ["tuf-repo.github.com", "github"]
  ]) {
    const root = {
      mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
      certificateAuthorities: [
        { certChain: { certificates: [{ rawBytes: fixtures[wrongIssuer ? "github" : issuer] }] } }
      ]
    };
    const bytes = Buffer.from(JSON.stringify(root));
    roots.push(root);
    const dir = path.join(options.env.XDG_CACHE_HOME, "gh/.sigstore/root", host);
    await fs.mkdir(path.join(dir, "targets"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, "targets/trusted_root.json"), bytes);
    for (const role of ["root", "timestamp", "snapshot", "targets"]) {
      const signed = {
        _type: role,
        expires: new Date(Date.now() + (expired ? -1000 : 3600000)).toISOString(),
        version: 1
      };
      if (role === "targets")
        signed.targets = {
          "trusted_root.json": {
            length: bytes.length,
            hashes: { sha256: createHash("sha256").update(bytes).digest("hex") }
          }
        };
      await fs.writeFile(
        path.join(dir, `${role}.json`),
        JSON.stringify({ signed, signatures: [{ keyid: "fixture", sig: "fixture" }] })
      );
    }
  }
  return Buffer.from(roots.map(JSON.stringify).join("\n") + "\n");
}
