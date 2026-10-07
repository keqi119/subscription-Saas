// Internal transport only. The native session performs authority and Engine checks.
import http from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { markR3FailureCause } from "./r3-failure-diagnostic.mjs";

const CODE = "R3_ENGINE_EXCHANGE_UNAVAILABLE";
const failure = (reason = null) => {
  const error = Object.assign(new Error(CODE), { code: CODE });
  return reason ? markR3FailureCause(error, reason) : error;
};

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
  const creationPost = connected && method === "POST" && pathname === "/stage1-r3/target-create";
  if (connected?.destroyed) throw failure(creationPost ? "R3_POST_PRE_CLOSED" : null);
  if (
    (body !== null && !Buffer.isBuffer(body)) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > (streamed ? 120000 : 300000) ||
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
  } catch {
    source?.destroy?.();
    throw failure();
  }
  if (connected?.destroyed) {
    source?.destroy?.();
    throw failure(creationPost ? "R3_POST_PRE_CLOSED" : null);
  }
  if (
    signal?.aborted ||
    (streamed &&
      (!source ||
        typeof source.pipe !== "function" ||
        typeof source.destroy !== "function" ||
        typeof source[Symbol.asyncIterator] !== "function"))
  ) {
    source?.destroy?.();
    throw failure();
  }
  const agent = new http.Agent({ keepAlive: false });
  if (connected) agent.createConnection = () => connected;
  let request,
    timer,
    upload,
    firstCause,
    responseDone = false;
  const remember = (reason) => (firstCause ??= failure(creationPost ? reason : null));
  let sent = 0;
  let onConnectedClose;
  const responseResult = new Promise((resolve, reject) => {
    onConnectedClose = () => {
      if (responseDone) return;
      const error = remember("R3_POST_REQUEST_ERROR");
      reject(error);
      request?.destroy(error);
    };
    connected?.once("close", onConnectedClose);
    connected?.once("error", onConnectedClose);
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
          const error = remember("R3_POST_RESPONSE_INCOMPLETE");
          reject(error);
          request.destroy(error);
          response.destroy();
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 1048576) request.destroy(remember("R3_POST_RESPONSE_INCOMPLETE"));
          else chunks.push(chunk);
        });
        response.once("error", () => reject(remember("R3_POST_RESPONSE_INCOMPLETE")));
        response.once("end", () => {
          if (!response.complete) return reject(remember("R3_POST_RESPONSE_INCOMPLETE"));
          responseDone = true;
          resolve({
            status: response.statusCode,
            headers: response.rawHeaders,
            body: Buffer.concat(chunks)
          });
        });
      }
    );
    request.once("error", () => reject(remember("R3_POST_REQUEST_ERROR")));
    request.once("close", () => {
      if (!responseDone) reject(remember("R3_POST_REQUEST_ERROR"));
    });
    timer = setTimeout(() => {
      const error = remember("R3_POST_TIMER");
      reject(error);
      request.destroy(error);
    }, timeout);
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
    const observed = firstCause;
    request?.destroy(failure());
    source?.destroy();
    await Promise.allSettled([responseResult, upload]);
    throw observed ?? failure();
  } finally {
    clearTimeout(timer);
    connected?.off("close", onConnectedClose);
    connected?.off("error", onConnectedClose);
    agent.destroy();
  }
}
