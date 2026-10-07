import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers";
import {
  withR3ConnectedWindow,
  connectedChildTimeout,
  connectedChildSignal,
  settledR3ExecFile,
  checkR3ConnectedWindow,
  connectedPostTimeout
} from "./r3-connected-window.mjs";

test("one connected window bounds all child calls and cannot restart when nested", async (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  await withR3ConnectedWindow(socket, async () => {
    assert.equal(connectedChildTimeout(120000), 90000);
    now += 70000;
    await withR3ConnectedWindow(socket, async () => {
      assert.equal(connectedChildTimeout(120000), 20000);
    });
    now += 20000;
    assert.throws(() => checkR3ConnectedWindow(), { code: "R3_CONNECTED_WINDOW_EXHAUSTED" });
  });
});

test("aborted execFile callback cannot settle before child close", async (t) => {
  let close;
  t.mock.method(childProcess, "execFile", (_file, _args, _options, callback) => {
    const child = new EventEmitter();
    child.kill = () => true;
    Promise.resolve().then(() => callback(new Error("aborted"), Buffer.alloc(0), Buffer.alloc(0)));
    close = () => child.emit("close", null, "SIGTERM");
    return child;
  });
  let settled = false;
  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  const result = withR3ConnectedWindow(socket, () =>
    settledR3ExecFile("dummy", [], { timeout: 1000 }).then((value) => {
      settled = true;
      return value;
    })
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  close();
  assert.ok((await result).error);
  assert.equal(settled, true);
});

test("a closed socket stops before consume and an in-flight consume settles before stopping", async () => {
  const closed = Object.assign(new EventEmitter(), { destroyed: true });
  let consumed = 0;
  await assert.rejects(
    withR3ConnectedWindow(closed, async () => consumed++),
    { code: "R3_CONNECTED_SOCKET_CLOSED" }
  );
  assert.equal(consumed, 0);

  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  let complete;
  const operation = withR3ConnectedWindow(socket, async () => {
    assert.equal(connectedChildSignal().aborted, false);
    consumed++;
    await new Promise((resolve) => {
      complete = resolve;
    });
    checkR3ConnectedWindow();
  });
  socket.destroyed = true;
  socket.emit("close");
  complete();
  await assert.rejects(operation, { code: "R3_CONNECTED_SOCKET_CLOSED" });
  assert.equal(consumed, 1);
});

test("POST has fifteen seconds and ends before the hosted idle limit", async (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  await withR3ConnectedWindow(Object.assign(new EventEmitter(), { destroyed: false }), async () => {
    assert.equal(connectedPostTimeout(), 15000);
    now += 88000;
    assert.equal(connectedPostTimeout(), 15000);
    now += 2000;
    assert.throws(() => connectedPostTimeout(), { code: "R3_CONNECTED_WINDOW_EXHAUSTED" });
  });
});
