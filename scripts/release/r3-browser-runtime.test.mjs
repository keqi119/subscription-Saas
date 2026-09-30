import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

test("browser channel binds replies and never sends initialization before recheck", async () => {
  const { createR3BrowserChannel } = await import("./r3-browser-runtime.mjs");
  const attached = { stdin: new PassThrough(), stdout: new PassThrough() };
  let checked = false;
  const sent = [];
  attached.stdin.on("data", (bytes) => {
    assert.equal(checked, true);
    const value = JSON.parse(bytes);
    sent.push(value);
    queueMicrotask(() =>
      attached.stdout.write(`${JSON.stringify({ id: value.id, result: { ready: true } })}\n`)
    );
  });
  const channel = createR3BrowserChannel({
    attached,
    signal: new AbortController().signal,
    recheck: async () => {
      checked = true;
    }
  });
  assert.deepEqual(await channel.call("init", { privateMaterial: "synthetic" }), { ready: true });
  assert.equal(sent.length, 1);
  channel.close();
  await assert.rejects(channel.call("browser", {}), { code: "R3_BROWSER_RUNTIME_FAILED" });
});

test("browser channel rejects mismatched replies and aborted work", async () => {
  const { createR3BrowserChannel } = await import("./r3-browser-runtime.mjs");
  const attached = { stdin: new PassThrough(), stdout: new PassThrough() };
  attached.stdin.on("data", () =>
    queueMicrotask(() => attached.stdout.write('{"id":99,"result":{}}\n'))
  );
  const controller = new AbortController();
  const channel = createR3BrowserChannel({
    attached,
    signal: controller.signal,
    recheck: async () => {}
  });
  await assert.rejects(channel.call("init", {}), { code: "R3_BROWSER_RUNTIME_FAILED" });
  channel.close();
  controller.abort();
  assert.throws(
    () => createR3BrowserChannel({ attached, signal: controller.signal, recheck: async () => {} }),
    { code: "R3_BROWSER_RUNTIME_FAILED" }
  );
});
