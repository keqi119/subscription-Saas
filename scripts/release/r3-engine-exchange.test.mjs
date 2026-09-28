import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough, Readable } from "node:stream";
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
  const result = await exchangeR3Engine("POST", "/exec", expected);
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
