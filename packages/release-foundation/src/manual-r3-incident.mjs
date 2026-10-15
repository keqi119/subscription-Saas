import { createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { encodeManualJson } from "./manual-stage1-contracts.mjs";
import { sha256Bytes, sha256Canonical } from "./digest.mjs";

const CODE = "MANUAL_R3_INCIDENT_UNVERIFIED";
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (condition) => {
  if (!condition) fail();
};
const equal = (a, b) => encodeManualJson(a).equals(encodeManualJson(b));
const exact = (value, keys) =>
  need(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      equal(Object.keys(value).sort(), [...keys].sort())
  );
const digest = (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
const epoch = (value) => {
  const time = Date.parse(value);
  need(
    typeof value === "string" && Number.isFinite(time) && new Date(time).toISOString() === value
  );
  return time;
};
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

// The only approved exception. This registry is source controlled; a private
// record cannot nominate another operation, profile, approval or expiry.
export const APPROVED_R3_INCIDENT = freeze({
  proposalDigest: "sha256:b9cfd396cf5292ea6b0373577f5d2abac38dfa0947b9c8ae935c131a58772034",
  approvalDigest: "sha256:b2176111555f3b8c41f67ad70b859ed3bbc02a1161cefe7c238e19bd0621855a",
  profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
  ownerId: "keqi119",
  operationRef: "3b451859-631a-49d7-9059-d8051cb9e7d9",
  sessionId: "7c72f1eb-d1ff-41f4-8be7-6b06f4dc5745",
  openingDigest: "sha256:b6ecee93109b19d284fc6b5c6221d3e311034b1140507fa9b36e6f7da082a04c",
  requestDigest: "sha256:15028729d757ec0a27211b2e1e6a83f3474ced3abe2aa5c71d0a743a46738c7c",
  consumptionDigest: "sha256:adc83edd47ec41b15d8145419e74bc4d13c4671a0cc48a94d2d5815e4a268cff",
  executionDigest: "sha256:c6d70e8f7107781d93ec93bab0cb2f3d9d76e7e4f05aa13871c604317c1c699c",
  sessionDigest: "sha256:75f58fd2b85729b5da85c0cf087966747c947c5eef92eae772a33fb6e2e26978",
  lockDigest: "sha256:e7b0be262e0aaca5816bf3daf7a7cee65095f3fd3d8e0e69fd2d744cdb9f979f",
  lockNames: [
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json",
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json"
  ],
  github: {
    repository: "keqi119/subscription-Saas",
    runId: "37500711005",
    runAttempt: 1,
    jobId: "112398453639",
    status: "completed",
    conclusion: "failure",
    completedAt: "2026-10-06T17:18:11Z"
  },
  executeNotAfter: "2026-10-07T06:53:54.742Z"
});

export const APPROVED_R3_INCIDENT_0AF9C545 = freeze({
  proposalDigest: "sha256:fb7cc8b7ad1cf061df318652531a5951f71723f506c6dff88171d9171550b21e",
  approvalDigest: "sha256:d7134cd9149590d8c5bf489918e0763a576c1916b8d29845552455bc0da49a76",
  profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
  ownerId: "keqi119",
  operationRef: "0af9c545-8cbc-4d1a-9027-e840c39ce9fd",
  sessionId: "c8ba1430-b06a-401a-a047-dc0d131a88ac",
  openingDigest: "sha256:805e81d3662e0c7144a3d72dfa8ea7cd9c9eb908307ca7ca02e034da4fe96b13",
  requestDigest: "sha256:93933ebd31e5cb043d9f898b84979ded260f2281ca44f40819760944c349bc69",
  consumptionDigest: "sha256:a7ba9e8f521880b36ec38cef73eec2acf53df338b853ad14b5e1c14c834bc041",
  executionDigest: "sha256:ec58b4714b7919c0b33b09a080ab32eacdab471aac489af930f12c8c0f3dc450",
  sessionDigest: null,
  lockDigest: "sha256:98286db237d1a7cdda84d309e8206f8c1c9bc091284327686f746ae8f230e7e6",
  lockNames: [
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json",
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json"
  ],
  github: {
    repository: "keqi119/subscription-Saas",
    runId: "37545515835",
    runAttempt: 1,
    jobId: "112549922961",
    status: "completed",
    conclusion: "cancelled",
    completedAt: "2026-10-06T23:32:26Z"
  },
  executeNotAfter: "2026-10-07T06:53:54.742Z"
});

export const APPROVED_R3_INCIDENT_588DA0DC = freeze({
  proposalDigest: "sha256:e891c70738cebae883bb0032f9bd3c20c08c11542a6415ab69cbce0eed64f6d3",
  approvalDigest: "sha256:5944c7bc7c638135f718950a8001718c7cf5527441d92f4a7558ea8bc881e3c4",
  profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
  ownerId: "keqi119",
  operationRef: "588da0dc-713a-4832-ab04-96421ed50236",
  sessionId: "5a06703e-4dff-4872-be81-a92ef822ae5c",
  openingDigest: "sha256:e36ed588835f38d4b1e29d6e388c647fd96bc082f79c00f9925935ad20b95ce1",
  requestDigest: "sha256:86c7c77a360de111037a0e354d2714e55e3f09affe97597508e502ff9e9316a6",
  consumptionDigest: "sha256:cda4f6a4cd34c1d5225fc87fd8dad4f6043446e9729ff976810ab5c68982f345",
  executionDigest: "sha256:9b267d09687253c6081f3ad64a9a09c68e1a10cb9dd9a395e7a821d6c0c07834",
  sessionDigest: "sha256:64fd3913b34cd24602bb5d0a22c4245a166fa79108a1ef5293b2e57462107015",
  lockDigest: "sha256:0250e8ae3f07ae05e04e3fe03770140c279dc8ee7edd29d49b9e855033658018",
  lockNames: [
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json",
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json"
  ],
  github: {
    repository: "keqi119/subscription-Saas",
    runId: "37556016543",
    runAttempt: 1,
    jobId: "112583597083",
    status: "completed",
    conclusion: "failure",
    completedAt: "2026-10-07T01:30:12Z"
  },
  executeNotAfter: "2026-10-07T06:53:54.742Z"
});

export const APPROVED_R3_INCIDENT_79FEAA9A = freeze({
  proposalDigest: "sha256:c99ac9fadc0a296bd1392a886d4253140b2fef28edb1710aa90a6440bf4eb014",
  approvalDigest: "sha256:11510ebcdbc5b8df5e7c997e67942b3bec2ef61f2f38faf37be09089943d6a77",
  profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
  ownerId: "keqi119",
  operationRef: "79feaa9a-f5ba-4a48-a781-e406726e6580",
  sessionId: "bb0e1696-6bbf-46bf-9815-aeec696d68d6",
  openingDigest: "sha256:bad4969c36b9da1e14fcfe2d75ebd3fef2b20c0675ed15ecc8d971b0cd954e4a",
  requestDigest: "sha256:df666481bd711f507803511fa155799764d180b13c56e432aaa5de9ef9fc0f7d",
  consumptionDigest: "sha256:c9a657e24ae7e2276696d87cc48812c28b610c558c769074a6e56d7b0c704c76",
  executionDigest: "sha256:556f031351b8472d837a8cb1160b1644509019d58b4ab364c62ee6e47a2eb764",
  sessionDigest: "sha256:f90ffde7bbd78518de09a92e4b1970f41ba839fbf56141c63dad2cc23e04ede6",
  lockDigest: "sha256:5bb9b5a2a8695054d2379af1a1c099f0083ea8f3bc358bd4a7dac8f8570afe85",
  lockNames: [
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json",
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json"
  ],
  lockIdentities: {
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json": {
      dev: "64512",
      ino: "1519",
      uid: "0",
      gid: "0",
      mode: "33152",
      nlink: "1",
      size: "713"
    },
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json": {
      dev: "64512",
      ino: "1518",
      uid: "0",
      gid: "0",
      mode: "33152",
      nlink: "1",
      size: "713"
    }
  },
  github: {
    repository: "keqi119/subscription-Saas",
    runId: "37697010723",
    runAttempt: 1,
    jobId: "113052793748",
    status: "completed",
    conclusion: "cancelled",
    completedAt: "2026-10-07T23:01:13Z"
  },
  executeNotAfter: "2026-10-08T06:53:54.742Z"
});

// One consumed d789 sourceFresh failure. Its active lock inodes are deliberately
// not prefilled: the first signed intent must bind their freshly read identities.
export const APPROVED_R3_INCIDENT_EB5A1850 = freeze({
  proposalDigest: "sha256:e73900c42bc2e8a48d4504cb44fd9191f326d37b6039072865aa522de3b524b5",
  approvalDigest: "sha256:bedce8cb38cb1afea5a2e28e2beb159986be0ebfacd72cf413dcb7715bbbb927",
  profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
  ownerId: "keqi119",
  operationRef: "eb5a1850-8fb0-4bbd-a832-9e99be5d166a",
  sessionId: "717ac0f0-a136-4f87-ba89-fe5daef4cc97",
  openingDigest: "sha256:cfc065999451aade76cd4db9a78fd43b466d84323396bebf14ce1fb87a8e9562",
  allocationDigest: "sha256:1f73ad584b4e733e4bd8948669e1d7a85dc5f6095a0161632133970dfe921e53",
  requestDigest: "sha256:c706f208fbda84e45221c2d7e138a1db13e531d51d39e12a5ee0f98a7c75498f",
  authorizationDigest: "sha256:74e7bee865518540731d2261b0ee00a7a853b98ccf180a06b91b07a00dd85323",
  consumptionDigest: "sha256:a94c29bb2d97a50378ffce023b6e04a7bc2e26406153027871694baec08c979f",
  executionDigest: "sha256:b591f7bb7683a5604523c4c88317ca7a7eb05fd099a5adf348f10365f761ecda",
  sessionDigest: "sha256:3b8f051c896b9c5f9b1743640e4def006b2b5feb0822a921d71170b03ee38d98",
  consumptionSlotName:
    "49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541-bf9e9c70-4b4b-4f92-bf2b-c4986ae43adb.json",
  lockDigest: "sha256:36a008ab0032f5451eb87da7ba1949d2f69f1e86ea78d1e147f12957141e8a0e",
  lockNames: [
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json",
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json"
  ],
  lockScope: {
    targetPolicyDigest: "sha256:fb9707e26b2ad5e00d4cd61d88e6835b0aeb3210d01e9c6fbbfb9bc4a47cb8d5",
    creationSpecDigest: "sha256:33a1dcc7ab47197707bd63b4d9f6eeb23d55d5c0cce5154b330c580fee5cf93d",
    jobAdmissionDigest: "sha256:35720de5c29b8f4bdc5cbcb37d2e48a6da75ed309b50f0d6e413541f6580cc5c",
    buildProofDigest: "sha256:b379f56180284ae23738a78a074a61c1375dbac108d894b69e765f6321d890b6",
    sourceSha: "d789f752c477bd58294eb267d06e75da1a0b42f0",
    phase: "source",
    chain: "fresh"
  },
  github: {
    repository: "keqi119/subscription-Saas",
    runId: "38018148143",
    runAttempt: 1,
    jobId: "114113872845",
    status: "completed",
    conclusion: "failure",
    completedAt: "2026-10-10T03:03:30Z"
  },
  executeNotAfter: "2026-10-10T08:00:00.000Z"
});

// One consumed 4af sourceFresh failure. The signed intent must bind the two
// live lock identities freshly; no inode or UNKNOWN outcome is inferred here.
export const APPROVED_R3_INCIDENT_C820B449 = freeze({
  proposalDigest: "sha256:93a8bfb67e49a865766bc4dd5495b353311934dc360787d9807f2a2b8e82029b",
  approvalDigest: "sha256:0995fbed097e7fd702daa50d256e72100203a2afed30a7670c7bb0b5f7ba2acf",
  profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
  ownerId: "keqi119",
  operationRef: "c820b449-4356-4870-b8ca-7409ba01f507",
  sessionId: "2b82ee1d-1904-4d02-a0c8-bda3de9581fe",
  openingDigest: "sha256:b2a98d76c21f4311d015017ba0a204956b86a99e35e44d3a72548ed916b392e1",
  allocationDigest: "sha256:fcdd3fd5fb0c2720e0ad6d5701a07aa43fd27bff677a0800d8530c662dd343af",
  requestDigest: "sha256:168030ae8841b939cec9e4f83eb64a46fc2eedebaaf998975fc489baa705a5b1",
  authorizationDigest: "sha256:dd6b3c611d18681688562c4ea824128008c6d060b173b05d25af8aa054ddbe38",
  consumptionDigest: "sha256:21bb9fc34911c3a319fe5b660650f10fdea71823bec1edaf9833e100d195e02e",
  executionDigest: "sha256:1a71b243b3635fc10978a9040e4e348b0a3420889691cfd5d5eee79472bb9553",
  sessionDigest: "sha256:6dc6d161f49f2ae1752a7252305346f83018c5f332e995e74ffb24e3cbe7051d",
  consumptionSlotName:
    "49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541-eecb9b58-9cd6-4b4a-b2e5-f3ea7a81c676.json",
  lockDigest: "sha256:f9a0d6bd8832f7e9f4c0ca48dba89a22906ca4cbd7de3bb676c801434046881a",
  lockNames: [
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json",
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json"
  ],
  lockScope: {
    targetPolicyDigest: "sha256:fb9707e26b2ad5e00d4cd61d88e6835b0aeb3210d01e9c6fbbfb9bc4a47cb8d5",
    creationSpecDigest: "sha256:765c333996470265b10b03240e45d906b0e014736ac0bea1bf8501cc74dc0aad",
    jobAdmissionDigest: "sha256:1d6f2168af3bf2826f30362c6f829c0f47f4a6081974e9a8d5360e8f0631b706",
    buildProofDigest: "sha256:f04cc477d1ea6ce768679bbc5e7d5917937cf4c0cdf73c2a062671e361c52710",
    sourceSha: "4af1e8bd3c905add104bb130d888b7708273b87f",
    phase: "source",
    chain: "fresh"
  },
  github: {
    repository: "keqi119/subscription-Saas",
    runId: "38204226514",
    runAttempt: 1,
    jobId: "114665031289",
    status: "completed",
    conclusion: "failure",
    completedAt: "2026-10-12T04:50:52Z"
  },
  executeNotAfter: "2026-10-12T16:00:00.000Z"
});

// One consumed 8e sourceFresh failure. Its signed disposition preserves the
// original UNKNOWN and only retires the two approved local lock slots.
export const APPROVED_R3_INCIDENT_7E2DF1BA = freeze({
  proposalDigest: "sha256:6c73530a2c93028de4b9f1968787747ca167e5d5ecf3916eaa1193d23f8348e2",
  approvalDigest: "sha256:15a06b67c0a6607d5011efcc1a6f358d0c4583f7688ed6dbad7f62414447994a",
  profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
  ownerId: "keqi119",
  operationRef: "7e2df1ba-5b43-45a7-b167-78fa649d9cec",
  sessionId: "fde52291-32fa-405b-a4dc-dd7c35d70709",
  openingDigest: "sha256:304206362e3048781fb15b096afbb5af0db0fa1472e179cb9fcf0e4f9b5834d9",
  allocationDigest: "sha256:ff8186877b8f1fb6e5c8adaf67816bf6a4a7fe1b1e903718f8a2131c68de5665",
  requestDigest: "sha256:cd75d1077f388dbf5b76ef93222b74e222025e9cd0d94bfe08c0efe014c2030c",
  authorizationDigest: "sha256:4057738da889e2e8d5351c105662c69c8a9ad6880044d58bc2cf0670aded4b3b",
  consumptionDigest: "sha256:e330c5ab0bb36f5cd5784940d5d8445dedd40196c7075a3d3345def43759deb2",
  executionDigest: "sha256:b8e9da2cb02f3d19dfb16def43e755943e71dd011627bc44defda6fd72a52637",
  sessionDigest: "sha256:e1a4e22cae3f777a478cd26aaa740c3b723da8ce3434cba8e94ba4016378fa08",
  consumptionSlotName:
    "49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541-42102724-2ec1-48fa-9d65-a8ea2bea8fad.json",
  lockDigest: "sha256:f7885dbc5b45157a2ee48811fdb94bcfe1c595bedad55c5175a881107a02b2ab",
  lockNames: [
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json",
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json"
  ],
  lockScope: {
    targetPolicyDigest: "sha256:fb9707e26b2ad5e00d4cd61d88e6835b0aeb3210d01e9c6fbbfb9bc4a47cb8d5",
    creationSpecDigest: "sha256:15d222b72eaf84247f0e176d26a9665ea640713f91711cfe0ff662d8fed94925",
    jobAdmissionDigest: "sha256:66f55dd3e477d1556b0f66373c8d8d54ef018682c13f7b2b79a369e1e14504fa",
    buildProofDigest: "sha256:fb0f4e36bef00b37e00254333feba621d7bd309774cec803069f77e44a35b38c",
    sourceSha: "8e1743ad90705240dcaaeace45a9f130ecc3b565",
    phase: "source",
    chain: "fresh"
  },
  github: {
    repository: "keqi119/subscription-Saas",
    runId: "38339681721",
    runAttempt: 1,
    jobId: "115108883590",
    status: "completed",
    conclusion: "failure",
    completedAt: "2026-10-13T03:15:37Z"
  },
  executeNotAfter: "2026-10-13T16:00:00.000Z"
});

// One consumed 1c8 sourceFresh failure. The exception retains its UNKNOWN
// history and authorizes only the two exact local lock slots to be retired.
export const APPROVED_R3_INCIDENT_B7A1429C = freeze({
  proposalDigest: "sha256:d592edf98841b1fd2cb302e92be3133b12f7caaa240dc2dbd842b66aad41ccbd",
  approvalDigest: "sha256:4dbe7fd576cfb211f6f9536dbe55dcafd27052760eed8a538e46b1be7b06f4af",
  profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
  ownerId: "keqi119",
  operationRef: "b7a1429c-ede5-4036-9091-078b766204ac",
  sessionId: "ca76f470-9f09-4f79-ba19-dbeead5d088f",
  openingDigest: "sha256:62bb9e2539c5fd8fb435aba2ca1260ff32d8b490954d09e62a259d74ffe78d39",
  allocationDigest: "sha256:f349bce33210339e02e1a21df0dd8fad6046596c8ba72168c5103966e580b8bf",
  requestDigest: "sha256:96bc59027e4ade45b781814adf63604a36473fdedf5046223f427dff43f11b3e",
  authorizationDigest: "sha256:a56c9c9a80328d434ec42d9582fc504fcbb7ac18eda13e68606142f854eb9a60",
  consumptionDigest: "sha256:1986e0c0bcd7a74c4e0d256e20ceee56f57e97c56e49afb72aca6e48adf25ac1",
  executionDigest: "sha256:f0b7a01bc8d352c81ac38aec076515aff35fd4978548e2276d43bd99bce683fa",
  sessionDigest: "sha256:1b0496b3d1b5968f96ae150e8e31457e45d430920553f9b713edcb91b9718c88",
  consumptionSlotName:
    "49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541-be238807-b465-4cff-aa62-cff31c667cfc.json",
  lockDigest: "sha256:f845d72105d397ad029de66912e958887607807a323004bd16e1d173d271fd59",
  lockNames: [
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json",
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json"
  ],
  lockIdentities: {
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json": {
      dev: "64512",
      ino: "3788",
      uid: "0",
      gid: "0",
      mode: "33152",
      nlink: "1",
      size: "714"
    },
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json": {
      dev: "64512",
      ino: "3787",
      uid: "0",
      gid: "0",
      mode: "33152",
      nlink: "1",
      size: "714"
    }
  },
  lockScope: {
    targetPolicyDigest: "sha256:fb9707e26b2ad5e00d4cd61d88e6835b0aeb3210d01e9c6fbbfb9bc4a47cb8d5",
    creationSpecDigest: "sha256:fae0fffbdeb9d792181a705cf32ba264305928941e5b867c20635a4e6d656cb8",
    jobAdmissionDigest: "sha256:065afd61c7f2454be5eff3a3c27fc0eafdb13c3316972cbcec143fcc123ed569",
    buildProofDigest: "sha256:24191b964fff0a79c8b9a5553279b6230e6f78b29597d8bdb1950e7a0a8f0287",
    sourceSha: "1c8ecfdc52c46fa1c6ead634fe2c6eaa1b664825",
    phase: "source",
    chain: "fresh"
  },
  github: {
    repository: "keqi119/subscription-Saas",
    runId: "38554217161",
    runAttempt: 1,
    jobId: "115821181377",
    status: "completed",
    conclusion: "failure",
    completedAt: "2026-10-14T12:09:59Z"
  },
  executeNotAfter: "2026-10-15T04:00:00.000Z"
});

// The approved incident's original source is installed independently of later
// verifier releases. This binding grants no authority; the historical reader
// still authenticates every archived input, source file and CI attestation.
const APPROVED_R3_HISTORICAL_SOURCE = freeze({
  operationRef: "3b451859-631a-49d7-9059-d8051cb9e7d9",
  profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
  sourceSha: "127a9eb281a65b216b53e863ad9734ac4650399e",
  proofRawDigest: "sha256:08dbcfa5fba486e15e919745ce79c83145d0489faddba7325bd4bf5d6958ef16",
  materialRawDigest: "sha256:601d61606ace6e4566c6ed632d06880ff0f9d2f7ba8f19793aaa4bfb07c15aab",
  creationSpecDigest: "sha256:36ccc8274c9c5b3688581faf63a4346138b9fc9248eec2b715b34b559777de54",
  jobAdmissionDigest: "sha256:211fdcd1327da1dae8dc348d70dc35f445f4173a65a964705dc29a8536e5129e",
  sourceRoot: "/opt/stage1-r3-candidate-127a9eb"
});

const APPROVED_R3_HISTORICAL_SOURCE_0AF9C545 = freeze({
  operationRef: APPROVED_R3_INCIDENT_0AF9C545.operationRef,
  profileDigest: APPROVED_R3_INCIDENT_0AF9C545.profileDigest,
  sourceSha: "b16f5aebb6b8599eb807c65751018a4d4efe224b",
  proofRawDigest: "sha256:4541fd36e754bd2c86fbef8a30f69050c3c5e480c54cae2d94c7dc9d7e1d776a",
  materialRawDigest: "sha256:59f6f9e61a8676d3113b73f7e6bbf193f09d2822d4d533f38d5596e428ae028d",
  creationSpecDigest: "sha256:b67f92679b7af2130714a765bda0b92462e166e436058f033cd638e20fc213f7",
  jobAdmissionDigest: "sha256:89e88f63fb306e16634cd0952fe7c03a7e87004abfc2199fc2e79f1be60ba301",
  sourceRoot: "/opt/stage1-r3-candidate-b16f5ae"
});

const APPROVED_R3_HISTORICAL_SOURCE_588DA0DC = freeze({
  operationRef: APPROVED_R3_INCIDENT_588DA0DC.operationRef,
  profileDigest: APPROVED_R3_INCIDENT_588DA0DC.profileDigest,
  sourceSha: "8928a0ffa3c29609e0da99144de2415438c9d081",
  proofRawDigest: "sha256:db884e1a359b40e5085b72f90d77e428d52557b03613838904d4748a3f867c3f",
  materialRawDigest: "sha256:c845f7a0edf3a88685c77823f9fd2ab2135ee0083c54a117eaf8f44a134a7d4d",
  creationSpecDigest: "sha256:de38862595bf073531fc8ce6a987f1583dd45e4207f1ff5455dfb76ffd692555",
  jobAdmissionDigest: "sha256:49836924c8b071bd7f19bf09b6f15f88279c83d6f38214b6864029d7739eb6d4",
  sourceRoot: "/opt/stage1-r3-candidate-8928a0f"
});

const APPROVED_R3_HISTORICAL_SOURCE_79FEAA9A = freeze({
  operationRef: APPROVED_R3_INCIDENT_79FEAA9A.operationRef,
  profileDigest: APPROVED_R3_INCIDENT_79FEAA9A.profileDigest,
  sourceSha: "ba872d6cb2c0e054e5ab099a8218b7220a215301",
  proofRawDigest: "sha256:d2c9299bb48f07c2831766e4c57458e3913f12cf8000fc7e970ea3ab5615ffbd",
  materialRawDigest: "sha256:50fccc8485815b014de94e0cfbb6c225af3c011d91ba46c7c0678871c7a7e89e",
  creationSpecDigest: "sha256:b657a22b04bea481da2f0ec20d310e4fdc6c03712ba815a3015cf9f0a59d9a0f",
  jobAdmissionDigest: "sha256:07b2dcb0eb606d8f232bd282fca01bc9f68cefd5daf9c2e53db69d6fa0b77b84",
  sourceRoot: "/opt/stage1-r3-candidate-ba872d6"
});

const APPROVED_R3_HISTORICAL_SOURCE_EB5A1850 = freeze({
  operationRef: APPROVED_R3_INCIDENT_EB5A1850.operationRef,
  profileDigest: APPROVED_R3_INCIDENT_EB5A1850.profileDigest,
  sourceSha: "d789f752c477bd58294eb267d06e75da1a0b42f0",
  proofRawDigest: "sha256:b379f56180284ae23738a78a074a61c1375dbac108d894b69e765f6321d890b6",
  materialRawDigest: "sha256:de6208a039919f6d386b0abb620d5108701f901a7ffad4790a33d9ac55c29ed4",
  creationSpecDigest: APPROVED_R3_INCIDENT_EB5A1850.lockScope.creationSpecDigest,
  jobAdmissionDigest: APPROVED_R3_INCIDENT_EB5A1850.lockScope.jobAdmissionDigest,
  sourceRoot: "/opt/stage1-r3-candidate-d789f75"
});

const APPROVED_R3_HISTORICAL_SOURCE_C820B449 = freeze({
  operationRef: APPROVED_R3_INCIDENT_C820B449.operationRef,
  profileDigest: APPROVED_R3_INCIDENT_C820B449.profileDigest,
  sourceSha: APPROVED_R3_INCIDENT_C820B449.lockScope.sourceSha,
  proofRawDigest: "sha256:f04cc477d1ea6ce768679bbc5e7d5917937cf4c0cdf73c2a062671e361c52710",
  materialRawDigest: "sha256:6b5f78ee1b9975e7436451c9a2844eeb40f82190351f2b4a643dd5705c304d5b",
  creationSpecDigest: APPROVED_R3_INCIDENT_C820B449.lockScope.creationSpecDigest,
  jobAdmissionDigest: APPROVED_R3_INCIDENT_C820B449.lockScope.jobAdmissionDigest,
  sourceRoot: "/opt/stage1-r3-candidate-4af1e8b"
});

const APPROVED_R3_HISTORICAL_SOURCE_7E2DF1BA = freeze({
  operationRef: APPROVED_R3_INCIDENT_7E2DF1BA.operationRef,
  profileDigest: APPROVED_R3_INCIDENT_7E2DF1BA.profileDigest,
  sourceSha: APPROVED_R3_INCIDENT_7E2DF1BA.lockScope.sourceSha,
  proofRawDigest: "sha256:fb0f4e36bef00b37e00254333feba621d7bd309774cec803069f77e44a35b38c",
  materialRawDigest: "sha256:2cbc480b3accb81efb9abcf60a16e97166382de8ad570140c39b85fda762fb1a",
  creationSpecDigest: APPROVED_R3_INCIDENT_7E2DF1BA.lockScope.creationSpecDigest,
  jobAdmissionDigest: APPROVED_R3_INCIDENT_7E2DF1BA.lockScope.jobAdmissionDigest,
  sourceRoot: "/opt/stage1-r3-candidate-8e1743a"
});

const APPROVED_R3_HISTORICAL_SOURCE_B7A1429C = freeze({
  operationRef: APPROVED_R3_INCIDENT_B7A1429C.operationRef,
  profileDigest: APPROVED_R3_INCIDENT_B7A1429C.profileDigest,
  sourceSha: APPROVED_R3_INCIDENT_B7A1429C.lockScope.sourceSha,
  proofRawDigest: "sha256:24191b964fff0a79c8b9a5553279b6230e6f78b29597d8bdb1950e7a0a8f0287",
  materialRawDigest: "sha256:bfe57da0fe69bd47162e3281186dfa0c3b8c57bdca944b97cf558317b6934fd2",
  creationSpecDigest: APPROVED_R3_INCIDENT_B7A1429C.lockScope.creationSpecDigest,
  jobAdmissionDigest: APPROVED_R3_INCIDENT_B7A1429C.lockScope.jobAdmissionDigest,
  sourceRoot: "/opt/stage1-r3-candidate-1c8ecfd"
});

const HISTORICAL_DISCOVERY_VERSION = "r3-historical-entrypoints-literal.v1";
const APPROVED_R3_HISTORICAL_CATALOGS = freeze([
  [
    APPROVED_R3_HISTORICAL_SOURCE,
    "sha256:093bf133860d113e31c7ecd1e4c4f2ff17e9f2c0720f0b6a722b5f6e44f47c95"
  ],
  [
    APPROVED_R3_HISTORICAL_SOURCE_0AF9C545,
    "sha256:f74e7ad905e0c02764cb312708b88765f6cf304b204bd6b32edf2fb3ac67b7f8"
  ],
  [
    APPROVED_R3_HISTORICAL_SOURCE_588DA0DC,
    "sha256:f74e7ad905e0c02764cb312708b88765f6cf304b204bd6b32edf2fb3ac67b7f8"
  ],
  [
    APPROVED_R3_HISTORICAL_SOURCE_79FEAA9A,
    "sha256:eff52b42151eba49db32040e7003fec4aeb991e7e644545dba3492c94bad910e"
  ],
  [
    APPROVED_R3_HISTORICAL_SOURCE_EB5A1850,
    "sha256:b90945d2e8df4155f55432eb9f5a5f091ff990a6857918f1eefa409a3f702f6e"
  ],
  [
    APPROVED_R3_HISTORICAL_SOURCE_C820B449,
    "sha256:d2a8bdef9f1b7aa85334946d962d6476dafce3ca36472c248b6baf5a0317a7cd"
  ],
  [
    APPROVED_R3_HISTORICAL_SOURCE_7E2DF1BA,
    "sha256:606292d7c0294a8cbf2152382f5033f02417923d296eb4aafcf47fd4e9b10c74"
  ],
  [
    APPROVED_R3_HISTORICAL_SOURCE_B7A1429C,
    "sha256:0c5ba9cace38336b6ffb80c4d4d9e9de6a6ca71c91129f5a7a6a2205fca60280"
  ]
]);

export function approvedR3HistoricalContractCompatibility(input) {
  const sourceRoot = approvedR3HistoricalSourceBinding(input);
  if (!sourceRoot) return null;
  const selected = APPROVED_R3_HISTORICAL_CATALOGS.find(
    ([source]) => source.sourceRoot === sourceRoot
  );
  need(selected);
  return freeze({
    sourceRoot: selected[0].sourceRoot,
    sourceSha: selected[0].sourceSha,
    catalogRawDigest: selected[1],
    discoveryVersion: HISTORICAL_DISCOVERY_VERSION
  });
}

export function approvedR3HistoricalSourceBinding(input) {
  exact(input, [
    "operationRef",
    "profileDigest",
    "sourceSha",
    "proofRawDigest",
    "materialRawDigest",
    "creationSpecDigest",
    "jobAdmissionDigest"
  ]);
  for (const binding of [
    APPROVED_R3_HISTORICAL_SOURCE,
    APPROVED_R3_HISTORICAL_SOURCE_0AF9C545,
    APPROVED_R3_HISTORICAL_SOURCE_588DA0DC,
    APPROVED_R3_HISTORICAL_SOURCE_79FEAA9A,
    APPROVED_R3_HISTORICAL_SOURCE_EB5A1850,
    APPROVED_R3_HISTORICAL_SOURCE_C820B449,
    APPROVED_R3_HISTORICAL_SOURCE_7E2DF1BA,
    APPROVED_R3_HISTORICAL_SOURCE_B7A1429C
  ])
    if (Object.entries(input).every(([key, value]) => binding[key] === value))
      return binding.sourceRoot;
  return null;
}

export function r3IncidentFileIdentity(stat) {
  return Object.fromEntries(
    ["dev", "ino", "uid", "gid", "mode", "nlink", "size"].map((key) => [key, String(stat[key])])
  );
}

function locks(value, policy) {
  need(Array.isArray(value) && value.length === 2 && policy.lockNames.length === 2);
  for (const [index, lock] of value.entries()) {
    exact(lock, ["name", "digest", "identity"]);
    need(lock.name === policy.lockNames[index] && lock.digest === policy.lockDigest);
    exact(lock.identity, ["dev", "ino", "uid", "gid", "mode", "nlink", "size"]);
    if (policy.lockIdentities) need(equal(lock.identity, policy.lockIdentities[lock.name]));
    need(
      Object.values(lock.identity).every(
        (item) => typeof item === "string" && /^(?:0|[1-9][0-9]*)$/u.test(item)
      )
    );
    need(
      lock.identity.uid === "0" &&
        lock.identity.gid === "0" &&
        lock.identity.mode === "33152" &&
        lock.identity.nlink === "1" &&
        Number(lock.identity.size) > 0 &&
        Number(lock.identity.size) <= 8192
    );
  }
  need(
    value[0].identity.dev === value[1].identity.dev &&
      value[0].identity.ino !== value[1].identity.ino
  );
}

function signed(bytes, profile) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 32768);
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  exact(value, ["record", "signature"]);
  need(encodeManualJson(value).equals(bytes) && typeof value.signature === "string");
  const signature = Buffer.from(value.signature, "base64"),
    key = createPublicKey(profile.publicKeyPem);
  need(
    signature.length === 64 &&
      signature.toString("base64") === value.signature &&
      key.asymmetricKeyType === "ed25519"
  );
  need(
    verify(
      null,
      Buffer.concat([
        Buffer.from("subscription-saas/r3-incident/v1\n"),
        encodeManualJson(value.record)
      ]),
      key,
      signature
    )
  );
  return value.record;
}

// Pure signature/byte assessment only. The native history reader separately
// pins the approved registry, original graph, private paths and actual inodes.
export function assessR3IncidentIntent({ profile, policy, intentBytes, now }) {
  try {
    need(sha256Canonical(profile) === policy.profileDigest && profile.ownerId === policy.ownerId);
    need(digest(policy.approvalDigest) && digest(policy.proposalDigest));
    const intent = signed(intentBytes, profile);
    exact(intent, [
      "schemaVersion",
      "policyDigest",
      "decision",
      "createdAt",
      "remoteCreationKnown",
      "remoteCleanupVerified",
      "promotionEligible",
      "ownerProcessesAbsent",
      "job",
      "forwardShutdownDigest",
      "locks"
    ]);
    need(
      intent.schemaVersion === "manual-r3-incident-intent.v1" &&
        intent.policyDigest === sha256Canonical(policy) &&
        intent.decision === "OWNER_ACCEPTED_UNRESOLVED_FAILURE" &&
        intent.remoteCreationKnown === false &&
        intent.remoteCleanupVerified === false &&
        intent.promotionEligible === false &&
        intent.ownerProcessesAbsent === true &&
        equal(intent.job, policy.github) &&
        digest(intent.forwardShutdownDigest)
    );
    locks(intent.locks, policy);
    need(
      Date.parse(policy.github.completedAt) <= epoch(intent.createdAt) &&
        epoch(intent.createdAt) <= epoch(policy.executeNotAfter) &&
        epoch(intent.createdAt) <= epoch(now)
    );
    return freeze(intent);
  } catch {
    fail();
  }
}

// Pure transition planning; it confers no authority and performs no I/O.
export function planR3IncidentLockRetirement(intent, active, retired) {
  try {
    need(active.length === 2 && retired.length === 2 && intent.locks.length === 2);
    return intent.locks.flatMap((lock, index) => {
      need(Boolean(active[index]) !== Boolean(retired[index]));
      need(equal(lock, active[index] ?? retired[index]));
      return active[index] ? [lock.name] : [];
    });
  } catch {
    fail();
  }
}

export function assessR3IncidentRecords({
  profile,
  policy,
  intentBytes,
  dispositionBytes,
  retiredLocks,
  now
}) {
  try {
    const intent = assessR3IncidentIntent({ profile, policy, intentBytes, now }),
      disposition = signed(dispositionBytes, profile);
    exact(disposition, [
      "schemaVersion",
      "intentDigest",
      "status",
      "completedAt",
      "remoteCreationKnown",
      "remoteCleanupVerified",
      "promotionEligible",
      "ownerProcessesAbsent",
      "job",
      "forwardShutdownDigest",
      "locks"
    ]);
    need(
      disposition.schemaVersion === "manual-r3-incident-disposition.v1" &&
        disposition.intentDigest === sha256Bytes(intentBytes) &&
        disposition.status === "LOCAL_CHANNEL_SLOTS_RETIRED_WITH_OWNER_EXCEPTION"
    );
    for (const record of [intent, disposition]) {
      need(
        record.remoteCreationKnown === false &&
          record.remoteCleanupVerified === false &&
          record.promotionEligible === false &&
          record.ownerProcessesAbsent === true &&
          equal(record.job, policy.github) &&
          digest(record.forwardShutdownDigest)
      );
      locks(record.locks, policy);
    }
    need(
      Date.parse(policy.github.completedAt) <= epoch(intent.createdAt) &&
        epoch(intent.createdAt) <= epoch(disposition.completedAt) &&
        epoch(disposition.completedAt) <= epoch(policy.executeNotAfter) &&
        epoch(disposition.completedAt) <= epoch(now)
    );
    locks(retiredLocks, policy);
    need(equal(intent.locks, disposition.locks) && equal(disposition.locks, retiredLocks));
    return freeze({
      status: "OWNER_ACCEPTED_UNRESOLVED_FAILURE",
      remoteCleanupVerified: false,
      promotionEligible: false,
      intent,
      disposition
    });
  } catch {
    fail();
  }
}

const dispositions = new WeakMap();
export function matchesR3IncidentDisposition(receipt, consumed, execution) {
  const policy = receipt && dispositions.get(receipt);
  return Boolean(
    policy &&
    sha256Canonical(consumed) === policy.consumptionDigest &&
    sha256Canonical(execution) === policy.executionDigest
  );
}

export function assertR3IncidentSessionShape(policy, graph) {
  const opening = graph.get(policy.openingDigest)?.value;
  const execution = graph.get(policy.executionDigest)?.value;
  const sessionRecords = [...graph.entries()].filter(
    ([, item]) => item.value.kind === "session" && item.value.sessionId === policy.sessionId
  );
  const executions = [...graph.entries()].filter(
    ([, item]) => item.value.kind === "execution" && item.value.sessionId === policy.sessionId
  );
  need(opening?.kind === "session" && opening.status === "OPEN");
  need(execution?.kind === "execution" && execution.status === "INTERRUPTED_UNKNOWN");
  need(executions.length === 1 && executions[0][0] === policy.executionDigest);
  if (policy.sessionDigest === null) {
    need(sessionRecords.length === 1 && sessionRecords[0][0] === policy.openingDigest);
  } else {
    need(
      sessionRecords.length === 2 &&
        sessionRecords.some(([digest]) => digest === policy.openingDigest) &&
        sessionRecords.some(
          ([digest, item]) =>
            digest === policy.sessionDigest && item.value.status === "INTERRUPTED_UNKNOWN"
        )
    );
  }
}

// Only this native reader brands a disposition. Ordinary assessments, booleans,
// job completion and records supplied by a caller cannot enable the exception.
export async function readApprovedR3IncidentDisposition(
  environment,
  graph,
  openingDigest,
  consumptions
) {
  const opening = graph.get(openingDigest)?.value;
  const policies = [
    APPROVED_R3_INCIDENT,
    APPROVED_R3_INCIDENT_0AF9C545,
    APPROVED_R3_INCIDENT_588DA0DC,
    APPROVED_R3_INCIDENT_79FEAA9A,
    APPROVED_R3_INCIDENT_EB5A1850,
    APPROVED_R3_INCIDENT_C820B449,
    APPROVED_R3_INCIDENT_7E2DF1BA,
    APPROVED_R3_INCIDENT_B7A1429C
  ];
  const matched = policies.filter(
    (policy) =>
      opening?.sessionId === policy.sessionId ||
      consumptions.some((value) => value.operationId === policy.operationRef)
  );
  if (matched.length === 0) return null;
  try {
    need(matched.length === 1);
    const p = matched[0];
    const { profile, store, retainedLocks, stamp } = environment;
    need(
      sha256Canonical(profile) === p.profileDigest &&
        openingDigest === p.openingDigest &&
        consumptions.length === 1 &&
        sha256Canonical(consumptions[0]) === p.consumptionDigest
    );
    const originals = [
      [p.openingDigest, "journal"],
      [p.consumptionDigest, "journal"],
      [p.executionDigest, "journal"],
      [p.requestDigest, "archive"]
    ];
    if (p.sessionDigest !== null) originals.push([p.sessionDigest, "journal"]);
    if (
      p === APPROVED_R3_INCIDENT_EB5A1850 ||
      p === APPROVED_R3_INCIDENT_C820B449 ||
      p === APPROVED_R3_INCIDENT_7E2DF1BA ||
      p === APPROVED_R3_INCIDENT_B7A1429C
    ) {
      originals.push([p.allocationDigest, "archive"], [p.authorizationDigest, "archive"]);
      const consumptionBytes = graph.get(p.consumptionDigest)?.bytes;
      need(
        consumptionBytes &&
          (
            await store.read(
              path.join(profile.storage.journalRoot, "consumptions", p.consumptionSlotName)
            )
          ).equals(consumptionBytes)
      );
    }
    for (const [digest, role] of originals) {
      const item = graph.get(digest);
      need(
        item &&
          sha256Bytes(item.bytes) === digest &&
          encodeManualJson(item.value).equals(item.bytes)
      );
      need(
        (
          await store.read(
            path.join(profile.storage[`${role}Root`], "objects", `${digest.slice(7)}.json`)
          )
        ).equals(item.bytes)
      );
    }
    assertR3IncidentSessionShape(p, graph);
    need(retainedLocks.every(({ value }) => value.sessionId !== p.sessionId));
    const root = path.join(profile.storage.archiveRoot, "incidents", p.operationRef);
    await store.checkedPath(root);
    need(
      sha256Bytes(await store.read(path.join(root, "proposal.json"), true)) === p.proposalDigest &&
        sha256Bytes(await store.read(path.join(root, "approval.json"), true)) === p.approvalDigest
    );
    const intentBytes = await store.read(path.join(root, "intent.json"));
    const dispositionBytes = await store.read(path.join(root, "disposition.json"));
    const retiredLocks = [];
    for (const name of p.lockNames) {
      const file = path.join(root, "locks", name);
      const before = await store.checkedPath(file);
      const bytes = await store.read(file);
      const after = await store.checkedPath(file);
      need(
        equal(r3IncidentFileIdentity(before), r3IncidentFileIdentity(after)) &&
          sha256Bytes(bytes) === p.lockDigest &&
          (!p.lockIdentities || equal(r3IncidentFileIdentity(after), p.lockIdentities[name]))
      );
      retiredLocks.push({
        name,
        digest: sha256Bytes(bytes),
        identity: r3IncidentFileIdentity(after)
      });
      environment.capture.pinIdentity(file, r3IncidentFileIdentity(after));
    }
    const receipt = assessR3IncidentRecords({
      profile,
      policy: p,
      intentBytes,
      dispositionBytes,
      retiredLocks,
      now: stamp()
    });
    const { assessR3H1ForwardShutdown } =
      await import("../../../scripts/release/r3-h1-forward-lease.mjs");
    for (const [record, at] of [
      [receipt.intent, receipt.intent.createdAt],
      [receipt.disposition, receipt.disposition.completedAt]
    ]) {
      const bytes = await store.read(
        path.join(root, `forward-${record.forwardShutdownDigest.slice(7)}.json`)
      );
      need(sha256Bytes(bytes) === record.forwardShutdownDigest);
      assessR3H1ForwardShutdown({
        observationBytes: bytes,
        rawInputs: Object.fromEntries(
          ["key", "ss.stdout", "ss.stderr", "pgrep.stdout", "pgrep.stderr"].map((key) => [
            key,
            Buffer.alloc(0)
          ])
        ),
        now: at
      });
    }
    dispositions.set(receipt, p);
    return receipt;
  } catch {
    fail();
  }
}
