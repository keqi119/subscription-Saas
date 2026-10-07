import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { clearTimeout, setTimeout } from "node:timers";
import test from "node:test";
import { exchangeR3Engine } from "./r3-engine-exchange.mjs";

async function endpoint(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(55440, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return server;
}

async function connectedSocket() {
  const socket = net.createConnection({ host: "127.0.0.1", port: 55440 });
  await once(socket, "connect");
  return socket;
}

async function rejectsPromptly(promise) {
  let timer;
  try {
    await assert.rejects(
      Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("exchange did not settle")), 500);
        })
      ]),
      { code: "R3_ENGINE_EXCHANGE_UNAVAILABLE" }
    );
  } finally {
    clearTimeout(timer);
  }
}

test("fixed Engine exchange streams exact bytes and closes the source", async (t) => {
  const expected = Buffer.from("authenticated snapshot archive bytes");
  let received;
  await endpoint(t, async (request, response) => {
    assert.equal(request.url, "/v1.45/containers/fixture/archive?path=%2Ftmp");
    assert.equal(request.headers["content-length"], String(expected.length));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = Buffer.concat(chunks);
    response.writeHead(200);
    response.end("accepted");
  });
  const source = Readable.from([expected.subarray(0, 7), expected.subarray(7)]);
  const result = await exchangeR3Engine(
    "PUT",
    "/v1.45/containers/fixture/archive?path=%2Ftmp",
    null,
    null,
    {
      contentType: "application/x-tar",
      bodySource: { contentLength: expected.length, open: async () => source }
    }
  );
  assert.deepEqual(received, expected);
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), "accepted");
  assert.equal(source.closed, true);
});

test("existing buffer requests still work and oversized responses are refused", async (t) => {
  const expected = Buffer.from('{"operation":"inspect"}');
  await endpoint(t, async (request, response) => {
    if (request.url === "/large") {
      response.end(Buffer.alloc(1048577));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), expected);
    response.writeHead(201);
    response.end("created");
  });
  // Image provisioning already uses a five-minute response window.
  const result = await exchangeR3Engine("POST", "/exec", expected, null, { timeout: 300000 });
  assert.equal(result.status, 201);
  assert.equal(result.body.toString(), "created");
  await assert.rejects(exchangeR3Engine("GET", "/large"), {
    code: "R3_ENGINE_EXCHANGE_UNAVAILABLE"
  });
});

test("an early Engine response refuses an incomplete upload and closes its source", async (t) => {
  await endpoint(t, (request, response) => {
    request.once("data", () => response.end("premature"));
  });
  const source = new PassThrough();
  source.write(Buffer.from("x"));
  await assert.rejects(
    exchangeR3Engine("PUT", "/archive", null, null, {
      bodySource: { contentLength: 100, open: async () => source }
    }),
    { code: "R3_ENGINE_EXCHANGE_UNAVAILABLE" }
  );
  assert.equal(source.closed, true);
});

test("truncated and oversized body sources cannot complete an Engine upload", async (t) => {
  await endpoint(t, (request, response) => {
    request.on("error", () => {});
    request.resume();
    request.on("end", () => response.end());
  });
  for (const bytes of [Buffer.from("abc"), Buffer.from("abcde")]) {
    const source = Readable.from([bytes]);
    await assert.rejects(
      exchangeR3Engine("PUT", "/archive", null, null, {
        bodySource: { contentLength: 4, open: async () => source }
      }),
      { code: "R3_ENGINE_EXCHANGE_UNAVAILABLE" }
    );
    assert.equal(source.closed, true);
  }
});

test("a preclosed connected socket rejects instead of leaving the exchange pending", async (t) => {
  await endpoint(t, () => {});
  const socket = await connectedSocket();
  socket.destroy();
  await once(socket, "close");
  await rejectsPromptly(
    exchangeR3Engine("POST", "/create", Buffer.from("{}"), socket, { timeout: 50 })
  );
});

test("peer close after request delivery rejects instead of leaving the exchange pending", async (t) => {
  await endpoint(t, (request) => {
    request.resume();
    request.once("end", () => request.socket.destroy());
  });
  const socket = await connectedSocket();
  await rejectsPromptly(
    exchangeR3Engine("POST", "/create", Buffer.from("{}"), socket, { timeout: 50 })
  );
});

test("a preclosed connected socket settles a streamed upload", async (t) => {
  await endpoint(t, () => {});
  const socket = await connectedSocket();
  socket.destroy();
  await once(socket, "close");
  const source = Readable.from([Buffer.from("data")]);
  let opened = 0;
  await rejectsPromptly(
    exchangeR3Engine("PUT", "/archive", null, socket, {
      timeout: 50,
      bodySource: {
        contentLength: 4,
        open: async () => {
          opened++;
          return source;
        }
      }
    })
  );
  assert.equal(opened, 0);
});

test("an unresponsive peer reaches the configured exchange timeout", async (t) => {
  await endpoint(t, (request) => request.resume());
  await rejectsPromptly(exchangeR3Engine("GET", "/slow", null, null, { timeout: 50 }));
});
