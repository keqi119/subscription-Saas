// Internal transport only. The native session performs authority and Engine checks.
import http from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const CODE = "R3_ENGINE_EXCHANGE_UNAVAILABLE";
const failure = () => Object.assign(new Error(CODE), { code: CODE });

export async function exchangeR3Engine(
  method,
  pathname,
  body = null,
  connected = null,
  options = {}
) {
  const contentType = options.contentType ?? "application/json";
  const timeout = options.timeout ?? 5000;
  const signal = options.signal;
  const streamLength = options.bodySource?.contentLength;
  const open = options.bodySource?.open;
  const streamed = options.bodySource !== undefined;
  if (
    (body !== null && !Buffer.isBuffer(body)) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 120000 ||
    signal?.aborted ||
    (streamed &&
      (body !== null ||
        !Number.isSafeInteger(streamLength) ||
        streamLength < 1 ||
        streamLength > 1073743872 ||
        typeof open !== "function"))
  )
    throw failure();
  let source;
  try {
    source = streamed ? await open() : null;
    if (
      signal?.aborted ||
      (streamed &&
        (!source ||
          typeof source.pipe !== "function" ||
          typeof source.destroy !== "function" ||
          typeof source[Symbol.asyncIterator] !== "function"))
    )
      throw failure();
  } catch {
    source?.destroy?.();
    throw failure();
  }
  const agent = new http.Agent({ keepAlive: false });
  if (connected) agent.createConnection = () => connected;
  let request, timer, upload;
  let sent = 0;
  const responseResult = new Promise((resolve, reject) => {
    request = http.request(
      {
        hostname: "127.0.0.1",
        port: 55440,
        method,
        path: pathname,
        agent,
        signal,
        headers: {
          Connection: "close",
          ...(body || streamed
            ? {
                "Content-Type": contentType,
                "Content-Length": String(streamed ? streamLength : body.length)
              }
            : {})
        }
      },
      (response) => {
        // A server response cannot stand in for a body that was never sent.
        if (streamed && sent !== streamLength) {
          reject(failure());
          request.destroy(failure());
          response.destroy();
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 1048576) request.destroy(failure());
          else chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () => {
          if (!response.complete) return reject(failure());
          resolve({
            status: response.statusCode,
            headers: response.rawHeaders,
            body: Buffer.concat(chunks)
          });
        });
      }
    );
    request.once("error", reject);
    timer = setTimeout(() => request.destroy(failure()), timeout);
  });
  try {
    if (streamed) {
      const counter = new Transform({
        decodeStrings: false,
        transform(chunk, _encoding, done) {
          if (!Buffer.isBuffer(chunk) || sent + chunk.length > streamLength) return done(failure());
          sent += chunk.length;
          done(null, chunk);
        },
        flush(done) {
          done(sent === streamLength ? null : failure());
        }
      });
      upload = pipeline(source, counter, request, ...(signal ? [{ signal }] : []));
    } else {
      request.end(body);
      upload = Promise.resolve();
    }
    const [response] = await Promise.all([responseResult, upload]);
    return response;
  } catch {
    request?.destroy(failure());
    source?.destroy();
    await Promise.allSettled([responseResult, upload]);
    throw failure();
  } finally {
    clearTimeout(timer);
    agent.destroy();
  }
}
