// Internal STS observation. No credential is returned or written to an artifact.
import { createRequire } from "node:module";
import { URL } from "node:url";

const requireApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const CODE = "SNAPSHOT_STS_IDENTITY_INVALID";
const requireThat = (value) => {
  if (!value) throw new Error(CODE);
};

export async function readSnapshotStsIdentity(credential, now, createClient) {
  try {
    const live = () => {
      const date = now();
      requireThat(
        date instanceof Date &&
          Number.isFinite(date.getTime()) &&
          date.getTime() < credential.expiresAt
      );
    };
    live();
    requireThat(
      /^acs:ram::1457643390906675:assumed-role\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(
        credential.arn
      )
    );
    const OpenApi = requireApi("@alicloud/openapi-client");
    const Util = createRequire(requireApi.resolve("@alicloud/openapi-client"))(
      "@alicloud/tea-util"
    );
    const config = new OpenApi.Config({
      accessKeyId: credential.accessKeyId,
      accessKeySecret: credential.accessKeySecret,
      securityToken: credential.stsToken,
      endpoint: "sts.aliyuncs.com",
      protocol: "HTTPS",
      signatureAlgorithm: "v2"
    });
    const client = createClient ? createClient(config) : new OpenApi.default(config);
    const result = await client.callApi(
      new OpenApi.Params({
        action: "GetCallerIdentity",
        version: "2015-04-01",
        protocol: "HTTPS",
        pathname: "/",
        method: "POST",
        authType: "AK",
        bodyType: "json",
        reqBodyType: "formData",
        style: "RPC"
      }),
      new OpenApi.OpenApiRequest({ query: {} }),
      new Util.RuntimeOptions({
        autoretry: false,
        maxAttempts: 1,
        connectTimeout: 10000,
        readTimeout: 30000
      })
    );
    live();
    const body = result?.body;
    requireThat(
      result?.statusCode === 200 &&
        body?.AccountId === "1457643390906675" &&
        body.Arn === credential.arn &&
        body.IdentityType === "AssumedRoleUser" &&
        typeof body.RequestId === "string" &&
        /^[A-Za-z0-9-]{1,256}$/.test(body.RequestId)
    );
    return Object.freeze({
      AccountId: body.AccountId,
      Arn: body.Arn,
      IdentityType: body.IdentityType,
      RequestId: body.RequestId
    });
  } catch {
    throw Object.assign(new Error(CODE), { code: CODE });
  }
}
