import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import test from "node:test";

import { openR3EngineAttachWithRequest } from "./r3-engine-attach.mjs";

const containerId = "a".repeat(64);
const headers = {
  upgrade: "tcp",
  connection: "Upgrade",
  "content-type": "application/vnd.docker.multiplexed-stream"
};
function frame(stream, text) {
  const body = Buffer.from(text);
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}
class FakeSocket extends Duplex {
  constructor() {
    super();
    this.sent = [];
  }
  _read() {}
  _write(chunk, _encoding, done) {
    this.sent.push(Buffer.from(chunk));
    done();
  }
}
function harness() {
  const socket = new FakeSocket();
  const request = new EventEmitter();
  request.end = () => {};
  request.destroy = () => {
    request.emit("close");
  };
  let options;
  const transport = openR3EngineAttachWithRequest({ containerId }, (actual) => {
    options = actual;
    return request;
  });
  return {
    socket,
    request,
    transport,
    get options() {
      return options;
    }
  };
}
function upgrade(fixture, head = Buffer.alloc(0)) {
  fixture.request.emit("upgrade", { statusCode: 101, headers }, fixture.socket, head);
}

test("fixed upgraded attach sends raw stdin and demultiplexes fragmented stdout/stderr", async () => {
  const fixture = harness();
  const { socket, transport } = fixture;
  let ready = false;
  transport.ready.then(() => {
    ready = true;
  });
  await Promise.resolve();
  assert.equal(ready, false);
  assert.deepEqual(fixture.options, {
    hostname: "127.0.0.1",
    port: 55440,
    method: "POST",
    path: `/v1.45/containers/${containerId}/attach?logs=0&stream=1&stdin=1&stdout=1&stderr=1`,
    headers: { Connection: "Upgrade", Upgrade: "tcp" },
    agent: false
  });
  const out = [];
  const err = [];
  transport.stdout.on("data", (chunk) => out.push(chunk));
  transport.stderr.on("data", (chunk) => err.push(chunk));
  transport.stdin.write("request\n");
  const first = frame(1, "answer\n");
  const second = frame(2, "warning\n");
  upgrade(fixture, first.subarray(0, 3));
  await transport.ready;
  assert.equal(ready, true);
  socket.push(first.subarray(3, 10));
  socket.push(Buffer.concat([first.subarray(10), second.subarray(0, 6)]));
  socket.push(second.subarray(6));
  transport.stdin.end();
  assert.equal(socket.destroyed, false);
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit("end");
  socket.destroy();
  const result = await transport.completed;
  assert.equal(Buffer.concat(out).toString(), "answer\n");
  assert.equal(Buffer.concat(err).toString(), "warning\n");
  assert.equal(Buffer.concat(socket.sent).toString(), "request\n");
  assert.equal(result.status, "STREAM_ENDED");
  assert.equal(result.frames, 2);
  assert.equal(result.receivedBytes, Buffer.byteLength("answer\nwarning\n"));
  assert.equal(result.socketClosed, true);
});

test("unknown stream, oversized frame, and final partial header/data reject", async () => {
  const oversized = Buffer.alloc(8);
  oversized[0] = 1;
  oversized.writeUInt32BE(2 * 1024 * 1024 + 1, 4);
  for (const wire of [
    frame(3, "bad"),
    oversized,
    frame(1, "part").subarray(0, 3),
    frame(1, "part").subarray(0, 10)
  ]) {
    const fixture = harness();
    upgrade(fixture);
    fixture.socket.push(wire);
    await new Promise((resolve) => setImmediate(resolve));
    fixture.socket.emit("end");
    fixture.socket.emit("close");
    await assert.rejects(fixture.transport.completed, { code: "R3_ENGINE_ATTACH_UNAVAILABLE" });
  }
});

test("abort and non-upgrade response close without treating HTTP 200 as a stream", async () => {
  const controller = new AbortController();
  const socket = new FakeSocket();
  const request = new EventEmitter();
  request.end = () => {};
  request.destroy = () => request.emit("close");
  const transport = openR3EngineAttachWithRequest(
    { containerId, signal: controller.signal },
    () => request
  );
  request.emit("upgrade", { statusCode: 101, headers }, socket, Buffer.alloc(0));
  await transport.ready;
  controller.abort();
  await assert.rejects(transport.completed, { code: "R3_ENGINE_ATTACH_UNAVAILABLE" });
  assert.equal(socket.destroyed, true);

  const earlyAbort = new AbortController();
  const earlyRequest = new EventEmitter();
  earlyRequest.end = () => {};
  earlyRequest.destroy = () => earlyRequest.emit("close");
  const waiting = openR3EngineAttachWithRequest(
    { containerId, signal: earlyAbort.signal },
    () => earlyRequest
  );
  earlyAbort.abort();
  await assert.rejects(waiting.ready, { code: "R3_ENGINE_ATTACH_UNAVAILABLE" });
  await assert.rejects(waiting.completed, { code: "R3_ENGINE_ATTACH_UNAVAILABLE" });

  const rejected = harness();
  rejected.request.emit("response", { statusCode: 200, resume() {}, destroy() {} });
  await assert.rejects(rejected.transport.ready, { code: "R3_ENGINE_ATTACH_UNAVAILABLE" });
  await assert.rejects(rejected.transport.completed, { code: "R3_ENGINE_ATTACH_UNAVAILABLE" });
});

test("retains a transport error as a private cause", async () => {
  const fixture = harness();
  const networkError = new Error("socket reset");
  fixture.request.emit("error", networkError);
  await assert.rejects(fixture.transport.completed, (error) => {
    assert.equal(error.code, "R3_ENGINE_ATTACH_UNAVAILABLE");
    assert.equal(error.cause, networkError);
    assert.equal(Object.keys(error).includes("cause"), false);
    return true;
  });
});
