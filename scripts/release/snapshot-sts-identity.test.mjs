import assert from "node:assert/strict";
import test from "node:test";
import { readSnapshotStsIdentity } from "./snapshot-sts-identity.mjs";

const arn = "acs:ram::1457643390906675:assumed-role/snapshot-publisher/session";
const time = Date.parse("2026-10-06T00:00:00.000Z");
const credential = {
  arn,
  accessKeyId: "STS.fixture",
  accessKeySecret: "fixture-secret",
  stsToken: "fixture-token",
  expiresAt: time + 60000
};

test("observes caller identity using only the supplied STS and returns public API fields", async () => {
  const result = await readSnapshotStsIdentity(
    credential,
    () => new Date(time),
    (config) => {
      assert.equal(config.endpoint, "sts.aliyuncs.com");
      assert.equal(config.securityToken, credential.stsToken);
      return {
        callApi: async (params, request, runtime) => {
          assert.equal(params.action, "GetCallerIdentity");
          assert.equal(params.method, "POST");
          assert.deepEqual(request.query, {});
          assert.equal(runtime.autoretry, false);
          assert.equal(runtime.maxAttempts, 1);
          return {
            statusCode: 200,
            body: {
              AccountId: "1457643390906675",
              Arn: arn,
              IdentityType: "AssumedRoleUser",
              RequestId: "actual-request",
              ignored: "must-not-escape"
            }
          };
        }
      };
    }
  );
  assert.deepEqual(result, {
    AccountId: "1457643390906675",
    Arn: arn,
    IdentityType: "AssumedRoleUser",
    RequestId: "actual-request"
  });
  assert.ok(Object.isFrozen(result));
});

test("rejects a different actual principal and hides vendor error details", async () => {
  for (const callApi of [
    async () => ({
      statusCode: 200,
      body: {
        AccountId: "1457643390906675",
        Arn: arn + "-wrong",
        IdentityType: "AssumedRoleUser",
        RequestId: "request"
      }
    }),
    async () => {
      throw new Error("SECRET_VENDOR_DETAIL");
    }
  ]) {
    await assert.rejects(
      readSnapshotStsIdentity(
        credential,
        () => new Date(time),
        () => ({ callApi })
      ),
      (error) => {
        assert.equal(error.code, "SNAPSHOT_STS_IDENTITY_INVALID");
        assert.doesNotMatch(String(error), /SECRET_VENDOR_DETAIL/);
        return true;
      }
    );
  }
});
