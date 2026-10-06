// Private source readers shared by the manual launcher and result verifier.
// These readers preserve original bytes and never open a session or observe a live target.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import {
  encodeManualJson,
  sha256Bytes,
  sha256Canonical,
  computeManualClusterFingerprint,
  computeMigrationCatalog,
  computeRepositoryContract,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && "value" in descriptor;
    })
  );
}

function sameIdentity(left, right, contents = true) {
  return [
    "dev",
    "ino",
    "mode",
    "uid",
    "gid",
    "nlink",
    ...(contents ? ["size", "mtimeNs", "ctimeNs"] : [])
  ].every((key) => left[key] === right[key]);
}
function samePublicDirectory(left, right) {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    ["dev", "ino", "mode", "uid", "gid"].every((key) => left[key] === right[key])
  );
}
async function observedPath(file) {
  const chain = [];
  let current = path.parse(file).root;
  for (const segment of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink() || (await fs.realpath(current)) !== current)
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    chain.push({ path: current, stat });
  }
  return chain;
}
async function readPinned(handle, expected, limit = 1048576) {
  const before = await handle.stat({ bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size > BigInt(limit) ||
    (expected && !sameIdentity(before, expected))
  )
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  const bytes = Buffer.alloc(Number(before.size) + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (BigInt(offset) !== before.size || !sameIdentity(before, await handle.stat({ bigint: true })))
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  return { bytes: Buffer.from(bytes.subarray(0, offset)), stat: before };
}
async function nativeText(
  file,
  args,
  environment = { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" }
) {
  return new Promise((resolve, reject) =>
    childProcess.execFile(
      file,
      args,
      {
        shell: false,
        windowsHide: true,
        encoding: "buffer",
        timeout: 5000,
        maxBuffer: 8192,
        env: environment
      },
      (error, stdout, stderr) => {
        if (
          error ||
          !Buffer.isBuffer(stdout) ||
          !Buffer.isBuffer(stderr) ||
          stdout.length > 8192 ||
          stderr.length > 8192
        ) {
          reject(
            Object.assign(new Error("MANUAL_OPERATION_INPUT_UNAVAILABLE"), {
              code: "MANUAL_OPERATION_INPUT_UNAVAILABLE"
            })
          );
        } else {
          try {
            resolve(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
          } catch {
            reject(
              Object.assign(new Error("MANUAL_OPERATION_INPUT_UNAVAILABLE"), {
                code: "MANUAL_OPERATION_INPUT_UNAVAILABLE"
              })
            );
          }
        }
      }
    )
  );
}
async function ownerOnly(file, principal, stat) {
  if (process.platform === "linux") {
    if (
      principal.platform !== "posix" ||
      stat.uid !== BigInt(principal.uid) ||
      (stat.mode & 0o077n) !== 0n
    )
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    return;
  }
  if (process.platform !== "win32" || principal.platform !== "win32")
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  const system = "C:\\Windows\\System32\\";
  await nativeText(system + "icacls.exe", [file]);
  const literal = `'${file.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath ${literal}; [Console]::WriteLine($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value); foreach($e in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { [Console]::WriteLine($e.IdentityReference.Value+'|'+$e.AccessControlType+'|'+[int]$e.FileSystemRights) }; [Console]::WriteLine('attributes|'+[int][System.IO.File]::GetAttributes(${literal}))`;
  const lines = (
    await nativeText(system + "WindowsPowerShell\\v1.0\\powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script
    ])
  )
    .trim()
    .split(/\r?\n/u);
  const owner = lines.shift(),
    attributes = lines.pop()?.match(/^attributes\|([0-9]+)$/u);
  const entries = lines.map((line) =>
    line.match(/^(S-1-[0-9]+(?:-[0-9]+)+)\|(Allow|Deny)\|([0-9]+)$/u)
  );
  if (
    owner !== principal.sid ||
    !attributes ||
    !Number.isSafeInteger(Number(attributes[1])) ||
    (Number(attributes[1]) & 1024) !== 0 ||
    entries.length === 0 ||
    !entries.every(
      (entry) =>
        entry &&
        entry[1] === principal.sid &&
        entry[2] === "Allow" &&
        Number.isSafeInteger(Number(entry[3]))
    ) ||
    !entries.some((entry) => (Number(entry[3]) & 2032127) === 2032127)
  )
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
}
async function checkedPrivatePath(file, { principal, privateRoot, directory = false }) {
  const before = await observedPath(file);
  for (const entry of before)
    if (entry.path === privateRoot || entry.path.startsWith(privateRoot + path.sep))
      await ownerOnly(entry.path, principal, entry.stat);
  const after = await observedPath(file);
  if (
    after.length !== before.length ||
    !after.every((entry, index) =>
      entry.path === privateRoot || entry.path.startsWith(privateRoot + path.sep)
        ? sameIdentity(entry.stat, before[index].stat)
        : samePublicDirectory(entry.stat, before[index].stat)
    ) ||
    (directory
      ? !after.at(-1).stat.isDirectory()
      : !after.at(-1).stat.isFile() || after.at(-1).stat.nlink !== 1n)
  )
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  return after;
}
function h3Sql(queryId, context) {
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const acl = (column) =>
    `CASE WHEN ${column} IS NULL THEN NULL ELSE (SELECT coalesce(jsonb_agg(jsonb_build_array(a.grantor::text,a.grantee::text,a.privilege_type,a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type), '[]'::jsonb) FROM aclexplode(${column}) a) END`;
  const roles =
    "(SELECT coalesce(jsonb_agg(jsonb_build_array(oid::text,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit) ORDER BY oid),'[]'::jsonb) FROM pg_roles)";
  const memberships =
    "(SELECT coalesce(jsonb_agg(jsonb_build_array(roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option) ORDER BY roleid,member,grantor),'[]'::jsonb) FROM pg_auth_members)";
  const table =
    "(SELECT jsonb_build_object('oid',c.oid::text,'schema',n.nspname,'name',c.relname,'owner',jsonb_build_object('name',r.rolname,'oid',r.oid::text)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND c.relname='_prisma_migrations' AND c.relkind='r')";
  const userSchemas = "n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname<>'information_schema'";
  const privileges = (values, call, option = false) =>
    `(SELECT coalesce(jsonb_agg(p ORDER BY ord),'[]'::jsonb) FROM unnest(ARRAY[${values.map(quote).join(",")}]) WITH ORDINALITY AS p(p,ord) WHERE ${call.replaceAll("$P", option ? "p || ' WITH GRANT OPTION'" : "p")})`;
  const effective = (values, call) =>
    privileges(values, call) + "," + privileges(values, call, true);
  const tablePrivileges = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "MAINTAIN"
  ];
  const sequencePrivileges = ["USAGE", "SELECT", "UPDATE"];
  const data = {
    roles: `jsonb_build_object('roles',${roles},'memberships',${memberships},'migrationTable',${table})`,
    sessions:
      "jsonb_build_object('sessions',(SELECT coalesce(jsonb_agg(jsonb_build_array(pid,datid::text,usesysid::text,usename) ORDER BY pid),'[]'::jsonb) FROM pg_stat_activity))",
    migrations: `jsonb_build_object('table',${table},'rows',(SELECT coalesce(jsonb_agg(jsonb_build_array(id,migration_name,checksum,to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),CASE WHEN finished_at IS NULL THEN NULL ELSE to_char(finished_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') END,CASE WHEN rolled_back_at IS NULL THEN NULL ELSE to_char(rolled_back_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') END,applied_steps_count) ORDER BY started_at,migration_name,id),'[]'::jsonb) FROM public._prisma_migrations))`,
    privileges: `jsonb_build_object('roles',${roles},'memberships',${memberships},'database',(SELECT jsonb_build_array(d.oid::text,d.datname,d.datdba::text,${acl("d.datacl")},${effective(["CONNECT", "CREATE", "TEMPORARY"], "has_database_privilege(current_user,d.oid,$P)")}) FROM pg_database d WHERE d.datname=current_database()),'schemas',(SELECT coalesce(jsonb_agg(jsonb_build_array(n.oid::text,n.nspname,n.nspowner::text,${acl("n.nspacl")},${effective(["USAGE", "CREATE"], "has_schema_privilege(current_user,n.oid,$P)")}) ORDER BY n.oid),'[]'::jsonb) FROM pg_namespace n WHERE ${userSchemas}),'relations',(SELECT coalesce(jsonb_agg(jsonb_build_array(c.oid::text,c.relnamespace::text,c.relname,c.relkind,c.relowner::text,${acl("c.relacl")},CASE WHEN c.relkind='S' THEN ${privileges(sequencePrivileges, "has_sequence_privilege(current_user,c.oid,$P)")} WHEN c.relkind IN ('r','p','v','m','f') THEN ${privileges(tablePrivileges, "has_table_privilege(current_user,c.oid,$P)")} ELSE '[]'::jsonb END,CASE WHEN c.relkind='S' THEN ${privileges(sequencePrivileges, "has_sequence_privilege(current_user,c.oid,$P)", true)} WHEN c.relkind IN ('r','p','v','m','f') THEN ${privileges(tablePrivileges, "has_table_privilege(current_user,c.oid,$P)", true)} ELSE '[]'::jsonb END) ORDER BY c.oid),'[]'::jsonb) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userSchemas}),'columns',(SELECT coalesce(jsonb_agg(jsonb_build_array(a.attrelid::text,a.attnum,a.attname,${acl("a.attacl")},CASE WHEN c.relkind IN ('r','p','v','m','f') THEN ${privileges(["SELECT", "INSERT", "UPDATE", "REFERENCES"], "has_column_privilege(current_user,c.oid,a.attnum,$P)")} ELSE '[]'::jsonb END,CASE WHEN c.relkind IN ('r','p','v','m','f') THEN ${privileges(["SELECT", "INSERT", "UPDATE", "REFERENCES"], "has_column_privilege(current_user,c.oid,a.attnum,$P)", true)} ELSE '[]'::jsonb END) ORDER BY a.attrelid,a.attnum),'[]'::jsonb) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userSchemas} AND a.attnum>0 AND NOT a.attisdropped),'controlFunction',(SELECT jsonb_build_array(p.oid::text,'pg_catalog.pg_control_system()',p.proowner::text,${acl("p.proacl")},has_function_privilege(current_user,p.oid,'EXECUTE'),has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION')) FROM pg_proc p WHERE p.oid='pg_catalog.pg_control_system()'::regprocedure),'defaultAcls',(SELECT coalesce(jsonb_agg(jsonb_build_array(d.defaclrole::text,d.defaclnamespace::text,d.defaclobjtype,${acl("d.defaclacl")}) ORDER BY d.defaclrole,d.defaclnamespace,d.defaclobjtype),'[]'::jsonb) FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE d.defaclnamespace=0 OR ${userSchemas}))`
  };
  const identity =
    "jsonb_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'serverAddress',host(inet_server_addr()),'serverPort',inet_server_port(),'databaseName',current_database(),'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'sessionUser',session_user,'currentUser',current_user,'roleOid',(SELECT oid::text FROM pg_roles WHERE rolname=current_user),'tls',coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),false))";
  if (data[queryId])
    return `BEGIN READ ONLY;\nSET LOCAL search_path = pg_catalog;\nSELECT jsonb_build_object('observedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'identity',${identity},'data',${data[queryId]});\nCOMMIT;\n`;
  const expected = { ...context.readback.cluster };
  const role = context.readback.roles.provision;
  const actualIdentity = {
    systemIdentifier: expected.systemIdentifier,
    serverAddress: expected.serverAddress,
    serverPort: expected.serverPort,
    databaseName: context.fixed.operation.targetIntent.databaseName,
    databaseOid: context.readback.databaseOid,
    sessionUser: role.name,
    currentUser: role.name,
    roleOid: role.oid,
    tls: true
  };
  const roleIdentifier = (value) => '"' + value.replaceAll('"', '""') + '"';
  const checkTable = `IF ${table} IS DISTINCT FROM ${quote(JSON.stringify(context.table))}::jsonb THEN RAISE EXCEPTION 'H3_TABLE_MISMATCH'; END IF;`;
  const revokeMembers = context.provisionMemberships ?? [];
  const revocations = revokeMembers
    .map(
      (member) =>
        `REVOKE ${roleIdentifier(member.name)} FROM ${roleIdentifier(role.name)} RESTRICT;`
    )
    .join("\n");
  const membershipCheck = `DO $h3$ BEGIN IF (SELECT coalesce(jsonb_agg(roleid::text ORDER BY roleid),'[]'::jsonb) FROM pg_auth_members WHERE member=${role.oid}::oid) IS DISTINCT FROM ${quote(JSON.stringify(revokeMembers.map((member) => member.oid)))}::jsonb THEN RAISE EXCEPTION 'H3_MEMBERSHIP_MISMATCH'; END IF; END $h3$;`;
  const action =
    queryId === "grant"
      ? `GRANT SELECT ON TABLE public._prisma_migrations TO ${roleIdentifier(context.readback.roles.verify.name)}, ${roleIdentifier(context.readback.roles.observer.name)};`
      : `${membershipCheck}\n${revocations}\nALTER ROLE ${roleIdentifier(role.name)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`;
  return `BEGIN;\nSET LOCAL search_path = pg_catalog;\nDO $h3$ BEGIN IF ${identity} IS DISTINCT FROM ${quote(JSON.stringify(actualIdentity))}::jsonb THEN RAISE EXCEPTION 'H3_IDENTITY_MISMATCH'; END IF; ${checkTable} END $h3$;\n${action}\nCOMMIT;\n`;
}

const h3Oid = (value) => typeof value === "string" && /^[1-9][0-9]*$/u.test(value);
const h3Text = (value) => typeof value === "string" && value.length > 0 && value.length <= 256;
const h3Instant = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
    ? Date.parse(value)
    : NaN;
const h3Same = (left, right) => sha256Canonical(left) === sha256Canonical(right);
function h3Require(value) {
  if (!value) fail("MANUAL_H3_BINDING_INVALID");
}
function h3Role(value) {
  h3Require(exact(value, ["name", "oid"]) && h3Text(value.name) && h3Oid(value.oid));
}
function h3Rows(value, widths, order) {
  h3Require(Array.isArray(value));
  let last = null;
  for (const row of value) {
    h3Require(
      Array.isArray(row) &&
        row.length === widths.length &&
        widths.every((check, i) => check(row[i]))
    );
    const key = order(row);
    if (last !== null) {
      let compared = 0;
      for (let i = 0; i < key.length; i++) {
        compared = key[i] < last[i] ? -1 : key[i] > last[i] ? 1 : 0;
        if (compared) break;
      }
      h3Require(compared > 0);
    }
    last = key;
  }
}
function h3RoleRows(data, expectedRoles) {
  const bool = (value) => typeof value === "boolean";
  h3Rows(data.roles, [h3Oid, h3Text, bool, bool, bool, bool, bool, bool, bool], (row) => [
    BigInt(row[0])
  ]);
  h3Require(new Set(data.roles.map((row) => row[1])).size === data.roles.length);
  const known = new Map(data.roles.map((row) => [row[0], row]));
  h3Rows(data.memberships, [h3Oid, h3Oid, h3Oid, bool, bool, bool], (row) =>
    row.slice(0, 3).map(BigInt)
  );
  for (const row of data.memberships) h3Require(row.slice(0, 3).every((oid) => known.has(oid)));
  for (const role of Object.values(expectedRoles))
    h3Require(known.get(role.oid)?.[1] === role.name);
  return known;
}
function h3Table(value, expected = null) {
  h3Require(
    exact(value, ["oid", "schema", "name", "owner"]) &&
      h3Oid(value.oid) &&
      value.schema === "public" &&
      value.name === "_prisma_migrations"
  );
  h3Role(value.owner);
  if (expected) h3Require(h3Same(value, expected));
}
async function h3Sources(fixed, profile, principal, context) {
  const opened = new Map(),
    rawRoot = path.join(profile.storage.archiveRoot, "raw");
  const raw = async (ref) => {
    h3Require(
      exact(ref, ["digest", "bytes"]) &&
        /^sha256:[0-9a-f]{64}$/u.test(ref.digest) &&
        Number.isSafeInteger(ref.bytes) &&
        ref.bytes >= 0 &&
        ref.bytes <= 1048576
    );
    const file = path.join(rawRoot, ref.digest.slice(7) + ".bin");
    let item;
    try {
      item = await capturePrivateInput(file, {
        principal,
        privateRoot: profile.storage.archiveRoot
      });
    } catch (cause) {
      if (cause.code === "ENOENT") fail("MANUAL_H3_B_INPUT_REQUIRED");
      throw cause;
    }
    try {
      h3Require(item.bytes.length === ref.bytes && sha256Bytes(item.bytes) === ref.digest);
      await item.recheck();
      const chain = await checkedPrivatePath(file, {
          principal,
          privateRoot: profile.storage.archiveRoot
        }),
        stat = chain.at(-1).stat,
        previous = opened.get(ref.digest);
      h3Require(
        !previous ||
          (sameIdentity(previous.stat, stat) &&
            previous.bytes.equals(item.bytes) &&
            chain.length === previous.chain.length &&
            chain
              .slice(0, -1)
              .every(
                (entry, index) =>
                  entry.path === previous.chain[index].path &&
                  (entry.path === profile.storage.archiveRoot ||
                  entry.path.startsWith(profile.storage.archiveRoot + path.sep)
                    ? sameIdentity(entry.stat, previous.chain[index].stat, false)
                    : samePublicDirectory(entry.stat, previous.chain[index].stat))
              ))
      );
      if (!previous) opened.set(ref.digest, { ref, stat, chain, bytes: Buffer.from(item.bytes) });
      return Buffer.from(item.bytes);
    } finally {
      await item.close();
    }
  };
  const json = async (ref) => canonicalH3(await raw(ref));
  const capture = async (ref, queryId, kind) => {
    const value = await json(ref),
      role = context.readback.roles[kind];
    h3Require(
      exact(value, [
        "recordVersion",
        "queryId",
        "operationRef",
        "indexDigest",
        "runId",
        "profileDigest",
        "connection",
        "sql",
        "argv",
        "stdout",
        "stderr",
        "preparedAt",
        "spawnedAt",
        "closedAt",
        "recordedAt",
        "pid",
        "parentPid",
        "exitCode",
        "signal",
        "stdoutEnded",
        "stderrEnded"
      ]) &&
        value.recordVersion === "manual-h3-sql-capture.v1" &&
        value.queryId === queryId &&
        ["roles", "privileges", "migrations", "sessions", "grant", "revoke"].includes(queryId)
    );
    h3Require(
      ["operationRef", "runId", "profileDigest"].every(
        (key) => value[key] === fixed.operation[key]
      ) && value.indexDigest === fixed.indexDigest
    );
    h3Require(
      exact(value.connection, ["endpoint", "databaseName", "role"]) &&
        value.connection.endpoint === context.readback.endpoint &&
        value.connection.databaseName === fixed.operation.targetIntent.databaseName &&
        h3Same(value.connection.role, role)
    );
    h3Require(
      Number.isSafeInteger(value.pid) &&
        value.pid > 0 &&
        Number.isSafeInteger(value.parentPid) &&
        value.parentPid > 0 &&
        value.exitCode === 0 &&
        value.signal === null &&
        value.stdoutEnded === true &&
        value.stderrEnded === true
    );
    h3Require(
      h3Instant(value.preparedAt) <= h3Instant(value.spawnedAt) &&
        h3Instant(value.spawnedAt) <= h3Instant(value.closedAt) &&
        h3Instant(value.closedAt) <= h3Instant(value.recordedAt) &&
        h3Instant(value.recordedAt) <= Date.now()
    );
    const sql = await raw(value.sql),
      argv = await json(value.argv),
      output = await raw(value.stdout),
      error = await raw(value.stderr);
    const sqlText = h3Sql(queryId, context);
    h3Require(sql.equals(Buffer.from(sqlText)) && error.length === 0);
    const endpoint = /^(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/u.exec(context.readback.endpoint);
    h3Require(endpoint);
    h3Require(
      h3Same(argv, {
        command: "psql",
        args: [
          "-X",
          "--no-password",
          "-v",
          "ON_ERROR_STOP=1",
          "-A",
          "-t",
          "-q",
          "--host",
          endpoint[1] === "[::1]" ? "::1" : endpoint[1],
          "--port",
          endpoint[2],
          "--dbname",
          fixed.operation.targetIntent.databaseName,
          "--username",
          role.name,
          "--command",
          sqlText
        ]
      })
    );
    if (["grant", "revoke"].includes(queryId)) return { value };
    let native;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(output);
      h3Require(text.endsWith("\n") && !text.slice(0, -1).includes("\n") && !text.includes("\r"));
      native = JSON.parse(text.slice(0, -1));
    } catch {
      fail("MANUAL_H3_FORMAT_INVALID");
    }
    h3Require(
      exact(native, ["observedAt", "identity", "data"]) &&
        h3Instant(value.spawnedAt) <= h3Instant(native.observedAt) &&
        h3Instant(native.observedAt) <= h3Instant(value.closedAt)
    );
    h3Require(
      h3Same(native.identity, {
        systemIdentifier: context.readback.cluster.systemIdentifier,
        serverAddress: context.readback.cluster.serverAddress,
        serverPort: context.readback.cluster.serverPort,
        databaseName: fixed.operation.targetIntent.databaseName,
        databaseOid: context.readback.databaseOid,
        sessionUser: role.name,
        currentUser: role.name,
        roleOid: role.oid,
        tls: true
      })
    );
    const data = native.data;
    if (queryId === "roles") {
      h3Require(exact(data, ["roles", "memberships", "migrationTable"]));
      h3RoleRows(data, context.readback.roles);
      if (data.migrationTable !== null) h3Table(data.migrationTable, context.table ?? null);
    } else if (queryId === "sessions") {
      h3Require(exact(data, ["sessions"]));
      h3Rows(
        data.sessions,
        [
          (x) => Number.isSafeInteger(x) && x > 0,
          (x) => x === null || h3Oid(x),
          (x) => x === null || h3Oid(x),
          (x) => x === null || h3Text(x)
        ],
        (row) => [row[0]]
      );
      h3Require(
        data.sessions.every((row) => (row[2] === null) === (row[3] === null)) &&
          data.sessions.some(
            (row) =>
              row[1] === context.readback.databaseOid && row[2] === role.oid && row[3] === role.name
          )
      );
    } else if (queryId === "migrations") {
      h3Require(exact(data, ["table", "rows"]));
      h3Table(data.table, context.table);
      h3Rows(
        data.rows,
        [
          h3Text,
          h3Text,
          (x) => typeof x === "string" && /^[0-9a-f]{64}$/u.test(x),
          (x) => Number.isFinite(h3Instant(x)),
          (x) => x === null || Number.isFinite(h3Instant(x)),
          (x) => x === null || Number.isFinite(h3Instant(x)),
          (x) => Number.isSafeInteger(x) && x >= 0
        ],
        (row) => [row[3], row[1], row[0]]
      );
    } else {
      h3Require(
        exact(data, [
          "roles",
          "memberships",
          "database",
          "schemas",
          "relations",
          "columns",
          "controlFunction",
          "defaultAcls"
        ])
      );
      h3RoleRows(data, context.readback.roles);
    }
    return { value, native };
  };
  return {
    raw,
    json,
    capture,
    recheck: async () => {
      const items = [...opened.values()];
      for (let offset = 0; offset < items.length; offset += 8) {
        const settled = await Promise.allSettled(
            items.slice(offset, offset + 8).map((item) => raw(item.ref))
          ),
          failed = settled.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
      }
    },
    close: async () => {}
  };
}

function canonicalH3(bytes) {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!encodeManualJson(value).equals(bytes)) fail("MANUAL_H3_FORMAT_INVALID");
    return value;
  } catch {
    fail("MANUAL_H3_FORMAT_INVALID");
  }
}

async function capturePrivateInput(file, options, limit = 1048576) {
  const chain = await checkedPrivatePath(file, options);
  const handle = await fs.open(file, "r");
  try {
    const captured = await readPinned(handle, chain.at(-1).stat, limit);
    const sameChain = (observed) =>
      observed.length === chain.length &&
      observed.every(
        (entry, index) =>
          entry.path === chain[index].path &&
          (entry.path !== options.privateRoot &&
          !entry.path.startsWith(options.privateRoot + path.sep)
            ? samePublicDirectory(entry.stat, chain[index].stat)
            : sameIdentity(entry.stat, chain[index].stat))
      );
    const recheck = async () => {
      const after = await checkedPrivatePath(file, options);
      if (
        !sameChain(after) ||
        !(await readPinned(handle, captured.stat, limit)).bytes.equals(captured.bytes)
      )
        fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
      const independent = await fs.open(file, "r");
      try {
        if (!(await readPinned(independent, captured.stat, limit)).bytes.equals(captured.bytes))
          fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
      } finally {
        await independent.close();
      }
      const final = await checkedPrivatePath(file, options);
      if (!sameChain(final)) fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    };
    return { bytes: captured.bytes, recheck, close: () => handle.close() };
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

async function pinPrivateInput(file, options, limit = 1048576) {
  const item = await capturePrivateInput(file, options, limit);
  try {
    await item.recheck();
    return item;
  } catch (cause) {
    await item.close();
    throw cause;
  }
}

async function readCanonicalPrivateInput(file, options) {
  const item = await capturePrivateInput(file, options);
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(item.bytes));
    if (!encodeManualJson(value).equals(item.bytes)) fail("MANUAL_STORAGE_UNVERIFIED");
    await item.recheck();
    return { value, bytes: Buffer.from(item.bytes) };
  } finally {
    await item.close();
  }
}

function validateH3Inputs(approval, readback, approvalBytes, fixed, profile) {
  const common = [
    "operationRef",
    "indexDigest",
    "runId",
    "profileDigest",
    "targetIntent",
    "ownerId",
    "promotionEligible"
  ];
  if (
    !exact(approval, [
      "recordVersion",
      ...common,
      "approvedAt",
      "creationSpec",
      "operationSheet"
    ]) ||
    !exact(readback, [
      "recordVersion",
      ...common,
      "approval",
      "databaseContainerName",
      "endpoint",
      "databaseOid",
      "cluster",
      "resourceObservedAt",
      "sqlObservedAt",
      "readbackAt",
      "readbackReport",
      "roles",
      "roleReadback"
    ]) ||
    !exact(approval.creationSpec, [
      "databaseContainerName",
      "dataVolumeName",
      "postgresImageDigest",
      "marker",
      "endpoint",
      "serverPort",
      "roles"
    ]) ||
    !exact(readback.approval, ["digest", "bytes"])
  )
    fail("MANUAL_H3_FORMAT_INVALID");
  const text = (value, limit = 256) =>
    typeof value === "string" && value.length > 0 && value.length <= limit;
  const instant = (value) =>
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
      ? Date.parse(value)
      : NaN;
  const approvedAt = instant(approval.approvedAt),
    resourceAt = instant(readback.resourceObservedAt),
    sqlAt = instant(readback.sqlObservedAt),
    readbackAt = instant(readback.readbackAt);
  const target = profile.allowedTargets.find(
    (entry) =>
      entry.endpointPolicyId === fixed.operation.targetIntent.endpointPolicyId &&
      entry.databaseName === fixed.operation.targetIntent.databaseName
  );
  const spec = approval.creationSpec;
  if (
    approval.recordVersion !== "manual-h3-a-approval.v2" ||
    readback.recordVersion !== "manual-h3-a-readback.v2" ||
    ![approval, readback].every(
      (record) =>
        record.operationRef === fixed.operation.operationRef &&
        record.indexDigest === fixed.indexDigest &&
        record.runId === fixed.operation.runId &&
        record.profileDigest === fixed.operation.profileDigest &&
        sha256Canonical(record.targetIntent) === sha256Canonical(fixed.operation.targetIntent) &&
        record.ownerId === profile.ownerId &&
        record.promotionEligible === false
    ) ||
    !target ||
    spec.endpoint !== target.endpoint ||
    readback.endpoint !== spec.endpoint ||
    readback.databaseContainerName !== spec.databaseContainerName ||
    ![spec.databaseContainerName, spec.dataVolumeName, spec.marker].every((value) => text(value)) ||
    !/^sha256:[0-9a-f]{64}$/u.test(spec.postgresImageDigest) ||
    !Number.isInteger(spec.serverPort) ||
    spec.serverPort < 1 ||
    spec.serverPort > 65535 ||
    !text(approval.operationSheet, 1048576) ||
    !text(readback.readbackReport, 1048576) ||
    typeof readback.databaseOid !== "string" ||
    !/^[1-9][0-9]*$/u.test(readback.databaseOid) ||
    readback.approval.digest !== sha256Bytes(approvalBytes) ||
    readback.approval.bytes !== approvalBytes.length ||
    !(
      approvedAt <= resourceAt &&
      approvedAt <= sqlAt &&
      resourceAt <= readbackAt &&
      sqlAt <= readbackAt &&
      readbackAt <= Date.now()
    ) ||
    !readback.cluster ||
    ["dataVolumeName", "postgresImageDigest", "marker", "serverPort"].some(
      (key) => readback.cluster[key] !== spec[key]
    )
  )
    fail("MANUAL_H3_BINDING_INVALID");
  h3Require(
    exact(spec.roles, ["provision", "migrate", "verify", "observer"]) &&
      exact(readback.roles, ["provision", "migrate", "verify", "observer"])
  );
  for (const kind of ["provision", "migrate", "verify", "observer"]) {
    h3Role(readback.roles[kind]);
    h3Require(
      h3Text(spec.roles[kind]) &&
        readback.roles[kind].name === spec.roles[kind] &&
        (kind === "provision" || spec.roles[kind] === target.roles[kind])
    );
  }
  h3Require(
    new Set(Object.values(spec.roles)).size === 4 &&
      new Set(Object.values(readback.roles).map((role) => role.oid)).size === 4
  );
  h3Require(readback.roles.provision.oid !== "10");
  // Reuse R1's only closed physical cluster validator/hash; H3 supplies no actual SQL facts.
  computeManualClusterFingerprint(readback.cluster);
}

function sourceValue(value) {
  const copy = JSON.parse(encodeManualJson(value));
  const freeze = (item) => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(copy);
}

async function openManualH3AInputs(input) {
  if (!exact(input, ["fixed", "profile", "principal"])) fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  const operation = Object.getOwnPropertyDescriptor(input.fixed, "operation"),
    indexDigest = Object.getOwnPropertyDescriptor(input.fixed, "indexDigest");
  if (!operation || !("value" in operation) || !indexDigest || !("value" in indexDigest))
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  // Fix inert caller facts before the first await; returned buffers are separate copies.
  const fixed = sourceValue({ operation: operation.value, indexDigest: indexDigest.value }),
    profile = sourceValue(input.profile),
    principal = sourceValue(input.principal);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      fixed.operation.operationRef
    ) ||
    !path.isAbsolute(profile.storage.archiveRoot) ||
    path.resolve(profile.storage.archiveRoot) !== profile.storage.archiveRoot
  )
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  const opened = [],
    copies = [];
  let nativeSources,
    closed = false;
  const recheck = async () => {
    if (closed) fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    for (const item of opened) await item.recheck();
    await nativeSources.recheck();
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    const settled = await Promise.allSettled([
      ...(nativeSources ? [nativeSources.close()] : []),
      ...opened.map((item) => item.close())
    ]);
    for (const item of opened) item.bytes.fill(0);
    for (const copy of copies) copy.fill(0);
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  };
  try {
    const root = path.join(
      profile.storage.archiveRoot,
      "inputs",
      "operations",
      fixed.operation.operationRef
    );
    const values = [];
    for (const name of ["h3-a-approval.json", "h3-a-readback.json"]) {
      const item = await pinPrivateInput(path.join(root, name), {
        principal,
        privateRoot: profile.storage.archiveRoot
      });
      opened.push(item);
      values.push(canonicalH3(item.bytes));
    }
    validateH3Inputs(values[0], values[1], opened[0].bytes, fixed, profile);
    nativeSources = await h3Sources(fixed, profile, principal, {
      approval: values[0],
      readback: values[1],
      fixed
    });
    const roleReadback = await nativeSources.capture(values[1].roleReadback, "roles", "observer");
    h3Require(
      roleReadback.native.observedAt === values[1].sqlObservedAt &&
        h3Instant(values[0].approvedAt) <= h3Instant(roleReadback.value.preparedAt) &&
        h3Instant(roleReadback.value.recordedAt) <= h3Instant(values[1].readbackAt)
    );
    const indexInput = await pinPrivateInput(path.join(root, "index.json"), {
      principal,
      privateRoot: profile.storage.archiveRoot
    });
    opened.push(indexInput);
    if (!indexInput.bytes.equals(encodeManualJson(fixed.operation)))
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    for (const item of opened) await item.recheck();
    const readback = values[1];
    const targetContext = {
      contextVersion: "manual-h3-target-context.v1",
      operationRef: fixed.operation.operationRef,
      indexDigest: fixed.indexDigest,
      runId: fixed.operation.runId,
      profileDigest: fixed.operation.profileDigest,
      targetIntent: fixed.operation.targetIntent,
      databaseOid: readback.databaseOid,
      cluster: readback.cluster,
      h3Approval: { digest: sha256Bytes(opened[0].bytes), bytes: opened[0].bytes.length },
      h3Readback: { digest: sha256Bytes(opened[1].bytes), bytes: opened[1].bytes.length }
    };
    copies.push(...opened.slice(0, 2).map((item) => Buffer.from(item.bytes)));
    return Object.freeze({
      bytes: Object.freeze(copies),
      refs: sourceValue({
        approval: targetContext.h3Approval,
        readback: targetContext.h3Readback,
        roleReadback: readback.roleReadback
      }),
      context: sourceValue({ approval: values[0], readback, targetContext }),
      recheck,
      close
    });
  } catch (cause) {
    await close();
    throw cause;
  }
}

function h3Acl(value) {
  if (value === null) return true;
  const oid0 = (x) => x === "0" || h3Oid(x);
  h3Rows(value, [h3Oid, oid0, h3Text, (x) => typeof x === "boolean"], (row) => [
    BigInt(row[0]),
    BigInt(row[1]),
    row[2]
  ]);
  return true;
}
function h3Privileges(value, order) {
  return (
    Array.isArray(value) &&
    value.every(
      (item, index) =>
        order.includes(item) &&
        (index === 0 || order.indexOf(value[index - 1]) < order.indexOf(item))
    )
  );
}
function h3Permission(capture, kind, context, after, selectReadback) {
  const data = capture.native.data,
    identity = context.readback.roles[kind],
    known = h3RoleRows(data, context.readback.roles),
    role = known.get(identity.oid);
  h3Require(
    role[2] === true &&
      role.slice(3, 8).every((value) => value === false) &&
      !data.memberships.some((row) => row[1] === identity.oid)
  );
  const oid0 = (x) => x === "0" || h3Oid(x),
    bool = (x) => typeof x === "boolean";
  const perms = (order) => (value) => h3Privileges(value, order);
  const dbPerms = ["CONNECT", "CREATE", "TEMPORARY"],
    schemaPerms = ["USAGE", "CREATE"],
    tablePerms = [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
      "MAINTAIN"
    ],
    seqPerms = ["USAGE", "SELECT", "UPDATE"],
    colPerms = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];
  h3Rows([data.database], [h3Oid, h3Text, h3Oid, h3Acl, perms(dbPerms), perms(dbPerms)], (row) => [
    BigInt(row[0])
  ]);
  h3Require(
    data.database[0] === context.readback.databaseOid &&
      data.database[1] === context.fixed.operation.targetIntent.databaseName &&
      data.database[2] !== identity.oid &&
      h3Same(data.database[4], ["CONNECT"]) &&
      data.database[5].length === 0
  );
  h3Rows(
    data.schemas,
    [h3Oid, h3Text, h3Oid, h3Acl, perms(schemaPerms), perms(schemaPerms)],
    (row) => [BigInt(row[0])]
  );
  h3Require(
    new Set(data.schemas.map((row) => row[1])).size === data.schemas.length &&
      data.schemas.every(
        (row) =>
          !row[1].startsWith("pg_") &&
          row[1] !== "information_schema" &&
          row[2] !== identity.oid &&
          row[5].length === 0 &&
          h3Same(row[4], row[1] === "public" ? ["USAGE"] : [])
      )
  );
  const publicSchema = data.schemas.find((row) => row[1] === "public");
  h3Require(publicSchema);
  const schemas = new Map(data.schemas.map((row) => [row[0], row]));
  h3Rows(
    data.relations,
    [
      h3Oid,
      h3Oid,
      h3Text,
      (x) => ["r", "p", "v", "m", "f", "S", "i", "I", "t", "c"].includes(x),
      h3Oid,
      h3Acl,
      Array.isArray,
      Array.isArray
    ],
    (row) => [BigInt(row[0])]
  );
  const relations = new Map(data.relations.map((row) => [row[0], row]));
  h3Require(
    new Set(data.relations.map((row) => row[1] + "/" + row[2])).size === data.relations.length
  );
  for (const row of data.relations) {
    const order =
      row[3] === "S" ? seqPerms : ["r", "p", "v", "m", "f"].includes(row[3]) ? tablePerms : [];
    h3Require(
      schemas.has(row[1]) &&
        row[4] !== identity.oid &&
        h3Privileges(row[6], order) &&
        h3Privileges(row[7], order) &&
        row[7].length === 0
    );
    const migration = row[0] === context.table.oid;
    if (migration) {
      h3Require(
        row[1] === publicSchema[0] &&
          row[2] === "_prisma_migrations" &&
          row[3] === "r" &&
          row[4] === context.table.owner.oid &&
          h3Same(row[6], after ? ["SELECT"] : [])
      );
      h3Require(
        row[5] === null ||
          row[5].every(
            (acl) =>
              acl[1] === context.table.owner.oid ||
              (after &&
                [context.readback.roles.verify.oid, context.readback.roles.observer.oid].includes(
                  acl[1]
                ) &&
                acl[2] === "SELECT" &&
                acl[3] === false)
          )
      );
    } else h3Require(row[2] !== "_prisma_migrations" && row[6].length === 0);
  }
  h3Require(relations.has(context.table.oid));
  h3Rows(
    data.columns,
    [
      h3Oid,
      (x) => Number.isSafeInteger(x) && x > 0,
      h3Text,
      h3Acl,
      perms(colPerms),
      perms(colPerms)
    ],
    (row) => [BigInt(row[0]), row[1]]
  );
  for (const row of data.columns) {
    const relation = relations.get(row[0]);
    h3Require(relation && row[5].length === 0);
    if (row[0] === context.table.oid)
      h3Require(
        (row[3] === null || row[3].length === 0) && h3Same(row[4], after ? ["SELECT"] : [])
      );
    else h3Require(row[4].length === 0);
  }
  h3Require(data.columns.some((row) => row[0] === context.table.oid));
  h3Rows(
    [data.controlFunction],
    [h3Oid, (x) => x === "pg_catalog.pg_control_system()", h3Oid, h3Acl, bool, bool],
    (row) => [BigInt(row[0])]
  );
  h3Require(
    data.controlFunction[2] !== identity.oid &&
      data.controlFunction[4] === true &&
      data.controlFunction[5] === false
  );
  h3Rows(
    data.defaultAcls,
    [h3Oid, oid0, (x) => ["r", "S", "f", "T", "n"].includes(x), h3Acl],
    (row) => [BigInt(row[0]), BigInt(row[1]), row[2]]
  );
  h3Require(
    data.defaultAcls.every(
      (row) =>
        row[0] !== identity.oid &&
        (row[1] === "0" || schemas.has(row[1])) &&
        (row[3] === null || row[3].every((acl) => !["0", identity.oid].includes(acl[1])))
    )
  );
  return {
    kind,
    identity,
    tls: true,
    superuser: false,
    createdb: false,
    createrole: false,
    replication: false,
    bypassrls: false,
    memberships: [],
    ownedSchemas: [],
    ownedRelations: [],
    databasePrivileges: { connect: true, create: false, temporary: false },
    publicSchemaPrivileges: { usage: true, create: false },
    migrationTablePrivileges: {
      select: after,
      insert: false,
      update: false,
      delete: false,
      truncate: false,
      references: false,
      trigger: false,
      maintain: false,
      grantOptions: [],
      columnPrivileges: []
    },
    pgControlSystem: {
      functionOid: data.controlFunction[0],
      signature: "pg_catalog.pg_control_system()",
      execute: true
    },
    otherUserRelationPrivileges: [],
    privilegeInventory: capture.value.stdout,
    selectReadback
  };
}

async function openManualH3BInputs(input) {
  if (
    !exact(input, [
      "fixed",
      "profile",
      "principal",
      "h3InputBytes",
      "targetContext",
      "migration"
    ]) ||
    !exact(input.migration, [
      "branch",
      "request",
      "execution",
      "process",
      "postObservation",
      "migration"
    ]) ||
    !Array.isArray(input.h3InputBytes) ||
    input.h3InputBytes.length !== 2 ||
    !input.h3InputBytes.every((bytes) => Buffer.isBuffer(bytes) && bytes.length <= 1048576)
  )
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  const operation = Object.getOwnPropertyDescriptor(input.fixed, "operation"),
    indexDigest = Object.getOwnPropertyDescriptor(input.fixed, "indexDigest");
  if (!operation || !("value" in operation) || !indexDigest || !("value" in indexDigest))
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  // Only inert, independently assessed history crosses this private boundary.
  // Copy it before the first await; this reader never establishes that assessment.
  const facts = {
      ...sourceValue({
        fixed: { operation: operation.value, indexDigest: indexDigest.value },
        profile: input.profile,
        principal: input.principal,
        targetContext: input.targetContext
      }),
      h3InputBytes: input.h3InputBytes.map((bytes) => Buffer.from(bytes))
    },
    migration = sourceValue(input.migration);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  if (
    !uuid.test(facts.fixed.operation.operationRef) ||
    !uuid.test(migration.request.attemptId) ||
    !path.isAbsolute(facts.profile.storage.archiveRoot) ||
    path.resolve(facts.profile.storage.archiveRoot) !== facts.profile.storage.archiveRoot
  )
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  const root = path.join(
      facts.profile.storage.archiveRoot,
      "inputs",
      "operations",
      facts.fixed.operation.operationRef
    ),
    opened = [],
    values = [];
  let sources,
    finalSnapshot,
    closed = false;
  const copies = [];
  const close = async () => {
    if (closed) return;
    closed = true;
    const settled = await Promise.allSettled([
      ...(sources ? [sources.close()] : []),
      ...opened.map((item) => item.close())
    ]);
    for (const item of opened) item.bytes.fill(0);
    for (const copy of [...copies, ...facts.h3InputBytes]) copy.fill(0);
    finalSnapshot?.bytes.fill(0);
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  };
  try {
    for (const name of ["h3-b-approval.json", "h3-b-readback.json"]) {
      let item;
      try {
        item = await pinPrivateInput(path.join(root, name), {
          principal: facts.principal,
          privateRoot: facts.profile.storage.archiveRoot
        });
      } catch (cause) {
        if (cause.code === "MANUAL_OPERATION_INPUT_UNAVAILABLE" || cause.code === "ENOENT")
          fail("MANUAL_H3_B_INPUT_REQUIRED");
        throw cause;
      }
      opened.push(item);
      const value = canonicalH3(item.bytes);
      values.push(value);
      if (
        value.operationRef !== facts.fixed.operation.operationRef ||
        value.indexDigest !== facts.fixed.indexDigest ||
        value.runId !== facts.fixed.operation.runId ||
        value.profileDigest !== facts.fixed.operation.profileDigest ||
        value.ownerId !== facts.profile.ownerId ||
        value.promotionEligible !== false ||
        sha256Canonical(value.targetIntent) !==
          sha256Canonical(facts.fixed.operation.targetIntent) ||
        sha256Canonical(value.migration) !== sha256Canonical(migration.migration)
      )
        fail("MANUAL_H3_BINDING_INVALID");
      await item.recheck();
    }
    const [approval, readback] = values,
      [h3AApproval, h3AReadback] = facts.h3InputBytes.map(canonicalH3);
    const common = [
      "operationRef",
      "indexDigest",
      "runId",
      "profileDigest",
      "targetIntent",
      "ownerId",
      "promotionEligible"
    ];
    h3Require(
      exact(approval, [
        "recordVersion",
        ...common,
        "h3AApproval",
        "h3AReadback",
        "approvedAt",
        "expiresAt",
        "branch",
        "migration",
        "preApprovalEvidence",
        "investigationApprovalRef",
        "target",
        "migrationTable",
        "roles",
        "grant",
        "operationSheet"
      ])
    );
    h3Require(
      exact(readback, [
        "recordVersion",
        ...common,
        "approval",
        "migration",
        "target",
        "migrationTable",
        "writerQuiescence",
        "before",
        "grantStartedAt",
        "grantCompletedAt",
        "grantEvidence",
        "after",
        "provisionExit",
        "readbackAt",
        "readbackReport"
      ])
    );
    h3Require(
      approval.recordVersion === "manual-h3-b-approval.v1" &&
        readback.recordVersion === "manual-h3-b-readback.v1" &&
        approval.branch === migration.branch
    );
    h3Require(
      typeof approval.operationSheet === "string" &&
        approval.operationSheet.length > 0 &&
        typeof readback.readbackReport === "string" &&
        readback.readbackReport.length > 0
    );
    h3Require(
      h3Same(approval.h3AApproval, facts.targetContext.h3Approval) &&
        h3Same(approval.h3AReadback, facts.targetContext.h3Readback)
    );
    h3Require(
      h3Same(readback.approval, {
        digest: sha256Bytes(opened[0].bytes),
        bytes: opened[0].bytes.length
      })
    );
    const target = {
      cluster: facts.targetContext.cluster,
      databaseName: facts.fixed.operation.targetIntent.databaseName,
      databaseOid: facts.targetContext.databaseOid
    };
    h3Require(
      h3Same(approval.target, target) &&
        h3Same(readback.target, target) &&
        h3Same(approval.roles, h3AReadback.roles)
    );
    h3Table(approval.migrationTable);
    h3Require(
      h3Same(approval.migrationTable.owner, approval.roles.migrate) &&
        h3Same(readback.migrationTable, approval.migrationTable)
    );
    h3Require(
      h3Same(approval.grant, {
        privileges: ["SELECT"],
        grantees: ["verify", "observer"],
        grantOption: false
      })
    );
    h3Require(
      migration.branch === "normal-success"
        ? approval.investigationApprovalRef === null
        : h3Text(approval.investigationApprovalRef)
    );
    const time = () =>
      h3Require(
        h3Instant(approval.approvedAt) < h3Instant(approval.expiresAt) &&
          h3Instant(approval.expiresAt) <= h3Instant(facts.profile.expiresAt) &&
          h3Instant(approval.approvedAt) <= Date.now() &&
          Date.now() <= h3Instant(approval.expiresAt) &&
          h3Instant(readback.readbackAt) <= Date.now() &&
          h3Instant(readback.readbackAt) <= h3Instant(approval.expiresAt)
      );
    time();
    const context = {
      approval: h3AApproval,
      readback: h3AReadback,
      fixed: facts.fixed,
      table: approval.migrationTable
    };
    sources = await h3Sources(facts.fixed, facts.profile, facts.principal, context);
    h3Require(
      (await sources.raw(approval.h3AApproval)).equals(facts.h3InputBytes[0]) &&
        (await sources.raw(approval.h3AReadback)).equals(facts.h3InputBytes[1]) &&
        (await sources.raw(readback.approval)).equals(opened[0].bytes)
    );
    const pre = await sources.json(approval.preApprovalEvidence);
    h3Require(exact(pre, ["roles", "table", "writerProcess", "writerSessions"]));
    const preRoles = await sources.capture(pre.roles, "roles", "observer"),
      preTable = await sources.capture(pre.table, "roles", "observer"),
      preSessions = await sources.capture(pre.writerSessions, "sessions", "observer");
    const knownRoles = h3RoleRows(preRoles.native.data, approval.roles);
    context.provisionMemberships = preRoles.native.data.memberships
      .filter((row) => row[1] === approval.roles.provision.oid)
      .map((row) => ({ oid: row[0], name: knownRoles.get(row[0])[1] }))
      .sort((left, right) => (BigInt(left.oid) < BigInt(right.oid) ? -1 : 1));
    h3Table(preRoles.native.data.migrationTable, approval.migrationTable);
    h3Table(preTable.native.data.migrationTable, approval.migrationTable);
    const processRef = {
      digest: migration.migration.processEvidenceDigest,
      bytes: encodeManualJson(migration.process).length
    };
    h3Require(
      h3Same(pre.writerProcess, processRef) &&
        (await sources.raw(pre.writerProcess)).equals(encodeManualJson(migration.process)) &&
        migration.process.closedAt !== null
    );
    for (const capture of [preRoles, preTable, preSessions])
      h3Require(
        h3Instant(migration.process.closedAt) <= h3Instant(capture.native.observedAt) &&
          h3Instant(capture.value.recordedAt) <= h3Instant(approval.approvedAt)
      );
    const writerCount = (capture) =>
      capture.native.data.sessions.filter(
        (row) => row[1] === target.databaseOid && row[2] === approval.roles.migrate.oid
      ).length;
    h3Require(writerCount(preSessions) === 0);
    const quiescence = readback.writerQuiescence;
    h3Require(
      exact(quiescence, [
        "observedAt",
        "containerId",
        "containerState",
        "processEvidence",
        "databaseSessions",
        "sessionReadback"
      ]) &&
        quiescence.containerId === migration.request.containerId &&
        quiescence.containerState === "exited" &&
        quiescence.databaseSessions === 0 &&
        h3Same(quiescence.processEvidence, processRef)
    );
    h3Require(
      (await sources.raw(quiescence.processEvidence)).equals(encodeManualJson(migration.process))
    );
    h3Require(
      migration.execution.processEvidenceDigest === migration.migration.processEvidenceDigest
    );
    const finalFile = path.join(
        root,
        "runner-launch",
        migration.request.attemptId,
        "final-inspect.stdout"
      ),
      final = await pinPrivateInput(finalFile, {
        principal: facts.principal,
        privateRoot: facts.profile.storage.archiveRoot
      });
    try {
      let inspected;
      try {
        inspected = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(final.bytes));
      } catch {
        fail("MANUAL_H3_FORMAT_INVALID");
      }
      h3Require(
        inspected.id === migration.request.containerId &&
          inspected.running === false &&
          inspected.paused === false &&
          inspected.restarting === false &&
          inspected.dead === false
      );
      await sources.raw({ digest: sha256Bytes(final.bytes), bytes: final.bytes.length });
      await final.recheck();
      finalSnapshot = {
        bytes: Buffer.from(final.bytes),
        chain: await checkedPrivatePath(finalFile, {
          principal: facts.principal,
          privateRoot: facts.profile.storage.archiveRoot
        })
      };
    } finally {
      await final.close();
    }
    const runnerLaunchRoot = path.dirname(path.dirname(finalFile));
    const finalRecheck = async () => {
      const item = await pinPrivateInput(finalFile, {
        principal: facts.principal,
        privateRoot: facts.profile.storage.archiveRoot
      });
      try {
        await item.recheck();
        const chain = await checkedPrivatePath(finalFile, {
          principal: facts.principal,
          privateRoot: facts.profile.storage.archiveRoot
        });
        h3Require(
          item.bytes.equals(finalSnapshot.bytes) &&
            chain.length === finalSnapshot.chain.length &&
            chain.every(
              (entry, index) =>
                entry.path === finalSnapshot.chain[index].path &&
                (entry.path === runnerLaunchRoot
                  ? samePublicDirectory(entry.stat, finalSnapshot.chain[index].stat)
                  : entry.path === facts.profile.storage.archiveRoot ||
                      entry.path.startsWith(facts.profile.storage.archiveRoot + path.sep)
                    ? sameIdentity(
                        entry.stat,
                        finalSnapshot.chain[index].stat,
                        index === chain.length - 1
                      )
                    : samePublicDirectory(entry.stat, finalSnapshot.chain[index].stat))
            )
        );
      } finally {
        await item.close();
      }
    };
    const stoppedSessions = await sources.capture(
      quiescence.sessionReadback,
      "sessions",
      "observer"
    );
    h3Require(
      writerCount(stoppedSessions) === 0 &&
        quiescence.observedAt === stoppedSessions.native.observedAt &&
        h3Instant(migration.process.closedAt) <= h3Instant(stoppedSessions.native.observedAt)
    );
    const permissions = async (value, after) => {
      h3Require(
        exact(value, ["observedAt", "source", "roles"]) &&
          Array.isArray(value.roles) &&
          value.roles.length === 2
      );
      const refs = await sources.json(value.source);
      h3Require(exact(refs, ["verify", "observer"]));
      const captures = [];
      for (const [index, kind] of ["verify", "observer"].entries()) {
        const capture = await sources.capture(refs[kind], "privileges", kind),
          declared = value.roles[index];
        let selectReadback = null;
        if (after) {
          selectReadback = declared.selectReadback;
          const selected = await sources.capture(selectReadback, "migrations", kind);
          captures.push(selected);
          if (migration.branch === "normal-success") {
            h3Require(
              migration.postObservation?.catalog.migrationTableOid === approval.migrationTable.oid
            );
            const rows = migration.postObservation.catalog.migrationRows.map((row) => {
              h3Require(
                typeof row.checksum === "string" && /^sha256:[0-9a-f]{64}$/u.test(row.checksum)
              );
              return [
                row.id,
                row.migrationName,
                row.checksum.slice(7),
                row.startedAt,
                row.finishedAt,
                row.rolledBackAt,
                row.appliedStepsCount
              ];
            });
            h3Require(h3Same(selected.native.data.rows, rows));
          }
        }
        h3Require(h3Same(declared, h3Permission(capture, kind, context, after, selectReadback)));
        captures.push(capture);
      }
      h3Require(
        h3Instant(value.observedAt) ===
          Math.max(...captures.map((capture) => h3Instant(capture.native.observedAt)))
      );
      return captures;
    };
    const before = await permissions(readback.before, false),
      after = await permissions(readback.after, true),
      grant = await sources.capture(readback.grantEvidence, "grant", "provision");
    const exit = readback.provisionExit;
    h3Require(
      exact(exit, [
        "identity",
        "revokedAt",
        "canLogin",
        "superuser",
        "createdb",
        "createrole",
        "replication",
        "bypassrls",
        "memberships",
        "process",
        "observedAt",
        "activeSessions",
        "credentialState",
        "roleReadback",
        "sessionReadback",
        "processReadback",
        "credentialStateReadback"
      ])
    );
    h3Require(
      h3Same(exit.identity, approval.roles.provision) &&
        ["canLogin", "superuser", "createdb", "createrole", "replication", "bypassrls"].every(
          (key) => exit[key] === false
        ) &&
        h3Same(exit.memberships, []) &&
        exit.activeSessions === 0
    );
    const host = await sources.json(exit.processReadback);
    h3Require(
      exact(host, ["process", "grant", "revoke"]) &&
        h3Same(host.process, exit.process) &&
        h3Same(host.grant, readback.grantEvidence)
    );
    const parent = host.process;
    h3Require(
      exact(parent, ["pid", "startedAt", "closedAt", "exitCode", "signal"]) &&
        Number.isSafeInteger(parent.pid) &&
        parent.pid > 0 &&
        parent.exitCode === 0 &&
        parent.signal === null
    );
    const revoke = await sources.capture(host.revoke, "revoke", "provision"),
      exitRoles = await sources.capture(exit.roleReadback, "roles", "observer"),
      exitSessions = await sources.capture(exit.sessionReadback, "sessions", "observer");
    const role = h3RoleRows(exitRoles.native.data, approval.roles).get(
      approval.roles.provision.oid
    );
    h3Require(
      role.slice(2, 8).every((value) => value === false) &&
        !exitRoles.native.data.memberships.some((row) => row[1] === role[0]) &&
        exitSessions.native.data.sessions.filter((row) => row[2] === role[0]).length === 0
    );
    const status = await sources.json(exit.credentialStateReadback);
    h3Require(
      exact(status, ["observedAt", "operationRef", "state", "stat"]) &&
        status.operationRef === facts.fixed.operation.operationRef &&
        status.state === exit.credentialState &&
        ["SEALED_RETAINED", "REMOVED"].includes(status.state)
    );
    h3Require(
      status.state === "REMOVED"
        ? status.stat === null
        : exact(status.stat, ["uid", "gid", "mode", "nlink", "dev", "ino"]) &&
            Object.values(status.stat).every(
              (value) => typeof value === "string" && /^[0-9]+$/u.test(value)
            ) &&
            status.stat.nlink === "1"
    );
    const chain = [
      approval.approvedAt,
      readback.before.observedAt,
      readback.grantStartedAt,
      readback.grantCompletedAt,
      readback.after.observedAt,
      exit.revokedAt,
      parent.closedAt,
      exit.observedAt,
      readback.readbackAt
    ].map(h3Instant);
    h3Require(
      chain.every((at, index) => Number.isFinite(at) && (index === 0 || chain[index - 1] <= at)) &&
        h3Instant(approval.approvedAt) <= h3Instant(parent.startedAt) &&
        h3Instant(parent.startedAt) <= h3Instant(readback.grantStartedAt)
    );
    h3Require(
      readback.grantStartedAt === grant.value.spawnedAt &&
        readback.grantCompletedAt === grant.value.closedAt &&
        exit.revokedAt === revoke.value.closedAt
    );
    for (const capture of before)
      h3Require(
        h3Instant(approval.approvedAt) <= h3Instant(capture.value.preparedAt) &&
          h3Instant(capture.value.closedAt) <= h3Instant(grant.value.spawnedAt)
      );
    for (const capture of after)
      h3Require(
        h3Instant(grant.value.closedAt) <= h3Instant(capture.value.spawnedAt) &&
          h3Instant(capture.value.closedAt) <= h3Instant(revoke.value.spawnedAt)
      );
    for (const capture of [grant, revoke])
      h3Require(
        capture.value.parentPid === parent.pid &&
          h3Instant(parent.startedAt) <= h3Instant(capture.value.preparedAt) &&
          h3Instant(capture.value.closedAt) <= h3Instant(parent.closedAt)
      );
    for (const capture of [exitRoles, exitSessions])
      h3Require(
        h3Instant(parent.closedAt) <= h3Instant(capture.value.spawnedAt) &&
          h3Instant(capture.native.observedAt) <= h3Instant(exit.observedAt)
      );
    h3Require(
      h3Instant(parent.closedAt) <= h3Instant(status.observedAt) &&
        h3Instant(status.observedAt) <= h3Instant(exit.observedAt)
    );
    for (const capture of [
      preRoles,
      preTable,
      preSessions,
      stoppedSessions,
      ...before,
      ...after,
      grant,
      revoke,
      exitRoles,
      exitSessions
    ])
      h3Require(h3Instant(capture.value.recordedAt) <= h3Instant(readback.readbackAt));
    const recheck = async () => {
      if (closed) fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
      time();
      for (const item of opened) await item.recheck();
      await finalRecheck();
      await sources.recheck();
    };
    const refs = sourceValue({
      approval: { digest: sha256Bytes(opened[0].bytes), bytes: opened[0].bytes.length },
      readback: { digest: sha256Bytes(opened[1].bytes), bytes: opened[1].bytes.length }
    });
    const recheckArchived = async () => {
      if (closed) fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
      for (const [index, ref] of [refs.approval, refs.readback].entries())
        h3Require((await sources.raw(ref)).equals(opened[index].bytes));
    };
    copies.push(...opened.map((item) => Buffer.from(item.bytes)));
    return Object.freeze({
      bytes: Object.freeze(copies),
      refs,
      context: sourceValue({ approval, readback, credentialState: status }),
      recheck,
      recheckArchived,
      close
    });
  } catch (cause) {
    await close();
    throw cause;
  }
}

const expectedLimit = 1048576;
const expectedBucket = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const expectedAccount = "1457643390906675";
const expectedPgDigest = "sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const expectedSchemaPath = "apps/api/prisma/schema.prisma",
  expectedConfigPath = "apps/api/prisma.config.ts";
const expectedPrisma = "/app/apps/release-runner/node_modules/.bin/prisma";
const expectedRole = "expected_schema_owner",
  expectedDatabase = "expected_schema_reference";
const expectedProcessKeys = [
  "tool",
  "argv",
  "stdout",
  "stderr",
  "pid",
  "preparedAt",
  "spawnedAt",
  "closedAt",
  "exitCode",
  "signal"
];
const expectedCreationTools = [
  "container-create",
  "container-inspect",
  "image-inspect",
  "node-version",
  "psql-version",
  "initdb",
  "pg-start",
  "database-create",
  "identity-before"
];
const expectedReadbackTools = [
  "identity-after",
  "migration-readback",
  "pg-stop",
  "container-exit-inspect",
  "container-stop",
  "container-remove"
];
const expectedPrismaTools = ["prisma-version", "prisma-deploy", "prisma-diff", "prisma-script"];
const expectedBucketTools = [
  "GetBucketAcl",
  "GetBucketWorm",
  "GetBucketVersioning",
  "GetBucketEncryption",
  "GetBucketPolicyStatus",
  "GetBucketPublicAccessBlock"
];
const expectedHeaderKeys = [
  "date",
  "x-oss-request-id",
  "content-length",
  "last-modified",
  "etag",
  "x-oss-server-side-encryption",
  "content-type"
];
function expectedRequire(value, code = "MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID") {
  if (!value) fail(code);
}
function expectedDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}
function expectedTime(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function expectedOrder(times) {
  return times.every(expectedTime) && times.every((v, i) => i === 0 || times[i - 1] <= v);
}
function expectedString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= expectedLimit;
}
function expectedText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID");
  }
}
function expectedJson(bytes, canonical = false) {
  expectedRequire(
    Buffer.isBuffer(bytes) && bytes.length <= expectedLimit,
    "MANUAL_EXPECTED_SCHEMA_RAW_INVALID"
  );
  let value;
  try {
    value = JSON.parse(expectedText(bytes));
  } catch {
    fail("MANUAL_EXPECTED_SCHEMA_JSON_INVALID");
  }
  // encodeManualJson rejects invalid Unicode, undefined values and unsafe data.
  const encoded = encodeManualJson(value);
  expectedRequire(
    encoded.length <= expectedLimit && (!canonical || encoded.equals(bytes)),
    "MANUAL_EXPECTED_SCHEMA_JSON_INVALID"
  );
  return value;
}
function expectedEqual(a, b) {
  return encodeManualJson(a).equals(encodeManualJson(b));
}
function expectedRawRef(ref) {
  expectedRequire(
    exact(ref, ["digest", "bytes"]) &&
      expectedDigest(ref.digest) &&
      Number.isSafeInteger(ref.bytes) &&
      ref.bytes >= 0 &&
      ref.bytes <= expectedLimit,
    "MANUAL_EXPECTED_SCHEMA_RAW_INVALID"
  );
  return ref;
}
function expectedPrismaArgv(tool) {
  const args = {
    "prisma-version": ["--version"],
    "prisma-deploy": [
      "migrate",
      "deploy",
      "--schema",
      "/app/" + expectedSchemaPath,
      "--config",
      "/app/" + expectedConfigPath
    ],
    "prisma-diff": [
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      "/app/" + expectedSchemaPath,
      "--exit-code",
      "--config",
      "/app/" + expectedConfigPath
    ],
    "prisma-script": [
      "migrate",
      "diff",
      "--from-empty",
      "--to-config-datasource",
      "--script",
      "--config",
      "/app/" + expectedConfigPath
    ]
  };
  return [expectedPrisma, ...args[tool]];
}
const expectedContainerFormat =
  '{"id":{{json .Id}},"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},"user":{{json .Config.User}},"network":{{json .HostConfig.NetworkMode}},"binds":{{json .HostConfig.Binds}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"source":{{json $m.Source}},"destination":{{json $m.Destination}}}{{end}}],"tmpfs":{{json .HostConfig.Tmpfs}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"status":{{json .State.Status}},"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}}}';
const expectedImageFormat =
  '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}},"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}';
const expectedIdentitySql = `SELECT json_build_object(
 'databaseName', current_database(),
 'databaseOid', (SELECT oid::text FROM pg_database WHERE datname=current_database()),
 'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
 'serverVersion', current_setting('server_version'),
 'schemaOwner', (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='public'),
 'ownerInventory', (SELECT coalesce(json_agg(i ORDER BY i."objectClass",i."objectName"),'[]'::json) FROM (
   SELECT 'schema'::text AS "objectClass", nspname::text AS "objectName", nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname='public'
   UNION ALL SELECT CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'relation' END,c.relname::text,c.relowner::regrole::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')
 ) i),
 'extensions', (SELECT coalesce(json_agg(extname ORDER BY extname),'[]'::json) FROM pg_extension),
 'listenAddresses', current_setting('listen_addresses'),
 'socketDirectory', current_setting('unix_socket_directories'),
 'dataDirectory', current_setting('data_directory'),
 'configuredPort', current_setting('port')::integer)::text`;
const expectedMigrationsSql = `SELECT coalesce(json_agg(m ORDER BY m.name),'[]'::json)::text FROM (
 SELECT migration_name::text AS name,checksum::text AS checksum,finished_at IS NOT NULL AS finished,
 rolled_back_at IS NOT NULL AS "rolledBack",applied_steps_count AS "appliedSteps" FROM public._prisma_migrations
) m`;

async function expectedCheckoutPin(relative) {
  const file = path.join(repoRoot, ...relative.split("/")),
    chain = await observedPath(file),
    handle = await fs.open(file, "r");
  try {
    const captured = await readPinned(handle, chain.at(-1).stat);
    const recheck = async () => {
      const current = await observedPath(file);
      expectedRequire(
        current.length === chain.length &&
          current.every(
            (v, i) =>
              v.path === chain[i].path &&
              (i === current.length - 1 ||
              v.path === repoRoot ||
              v.path.startsWith(repoRoot + path.sep)
                ? sameIdentity(v.stat, chain[i].stat)
                : samePublicDirectory(v.stat, chain[i].stat))
          ),
        "MANUAL_OPERATION_INPUT_UNAVAILABLE"
      );
      expectedRequire(
        (await readPinned(handle, captured.stat)).bytes.equals(captured.bytes),
        "MANUAL_OPERATION_INPUT_UNAVAILABLE"
      );
      const independent = await fs.open(file, "r");
      try {
        expectedRequire(
          (await readPinned(independent, captured.stat)).bytes.equals(captured.bytes),
          "MANUAL_OPERATION_INPUT_UNAVAILABLE"
        );
      } finally {
        await independent.close();
      }
    };
    await recheck();
    return { bytes: captured.bytes, recheck, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
function expectedProvenanceShape(p, facts, proof) {
  expectedRequire(
    exact(p, [
      "recordVersion",
      "buildProofDigest",
      "proofRaw",
      "sourceSha",
      "ci",
      "sourceSchema",
      "config",
      "lockfile",
      "migrationCatalogDigest",
      "toolchain",
      "expectedScript",
      "references",
      "generatedAt",
      "promotionEligible"
    ])
  );
  const runMatch =
    /^https:\/\/github\.com\/keqi119\/subscription-Saas\/actions\/runs\/([1-9][0-9]*)$/u.exec(
      proof.provenance.ciRunRef
    );
  expectedRequire(runMatch && Number.isSafeInteger(Number(runMatch[1])));
  expectedRequire(
    p.recordVersion === "manual-expected-schema-provenance.v1" &&
      p.buildProofDigest === facts.build.buildProofDigest &&
      expectedEqual(expectedRawRef(p.proofRaw), {
        digest: facts.build.proofRawDigest,
        bytes: facts.fixed.proofBytes.length
      }) &&
      p.sourceSha === proof.identity.sourceSha &&
      /^[0-9a-f]{40}$/u.test(p.sourceSha) &&
      p.migrationCatalogDigest === proof.identity.migrationCatalogDigest &&
      expectedTime(p.generatedAt) &&
      Date.parse(p.generatedAt) <= Date.now() &&
      p.promotionEligible === false
  );
  expectedRequire(
    exact(p.ci, [
      "repository",
      "workflowPath",
      "sourceRef",
      "runId",
      "runAttempt",
      "runnerClass"
    ]) &&
      expectedEqual(p.ci, {
        repository: "keqi119/subscription-Saas",
        workflowPath: ".github/workflows/docker-images.yml",
        sourceRef: "refs/heads/main",
        runId: runMatch[1],
        runAttempt: 1,
        runnerClass: "github-hosted"
      })
  );
  for (const [key, location] of [
    ["sourceSchema", expectedSchemaPath],
    ["config", expectedConfigPath],
    ["lockfile", "pnpm-lock.yaml"]
  ]) {
    expectedRequire(exact(p[key], ["path", "raw"]) && p[key].path === location);
    expectedRawRef(p[key].raw);
  }
  expectedRequire(
    exact(p.toolchain, [
      "runnerImageDigest",
      "postgresImageDigest",
      "nodeVersion",
      "postgresqlVersion",
      "prismaVersion",
      "prismaVersionRaw"
    ]) &&
      p.toolchain.runnerImageDigest === proof.identity.images.runner.imageDigest &&
      p.toolchain.postgresImageDigest === expectedPgDigest &&
      proof.provenance.baseImages.some(
        (v) => v.name === "postgres:17.11-bookworm" && v.resolvedDigest === expectedPgDigest
      ) &&
      /^v22\.\d+\.\d+$/u.test(p.toolchain.nodeVersion) &&
      /^17\.11(?: \([^()]+\))?$/u.test(p.toolchain.postgresqlVersion) &&
      expectedString(p.toolchain.prismaVersion) &&
      /^prisma\s*:\s*7\.8\.0\s*$/mu.test(p.toolchain.prismaVersion) &&
      p.toolchain.prismaVersion.includes("\n")
  );
  expectedRawRef(p.toolchain.prismaVersionRaw);
  expectedRawRef(p.expectedScript);
  expectedRequire(
    p.expectedScript.bytes > 0 && Array.isArray(p.references) && p.references.length === 2
  );
  return runMatch[1];
}
async function expectedReference(reference, p, raw, proof, target, catalog, extensions) {
  expectedRequire(
    exact(reference, [
      "referenceRunId",
      "identity",
      "createdAt",
      "readbackAt",
      "creationEvidence",
      "readbackEvidence",
      "migrationCatalog",
      "migrationHead",
      "migrationOwner",
      "allowedExtensions",
      "calls"
    ]) && uuid.test(reference.referenceRunId)
  );
  const r = reference,
    c = r.identity?.cluster;
  expectedRequire(
    exact(r.identity, ["cluster", "databaseName", "databaseOid"]) &&
      exact(c, [
        "systemIdentifier",
        "databaseContainerId",
        "runnerImageDigest",
        "postgresImageDigest",
        "dataDirectory",
        "socketDirectory",
        "listenAddresses",
        "configuredPort"
      ])
  );
  expectedRequire(typeof c.dataDirectory === "string");
  const root = path.posix.dirname(c.dataDirectory);
  expectedRequire(
    /^[1-9][0-9]*$/u.test(c.systemIdentifier) &&
      BigInt(c.systemIdentifier) <= 18446744073709551615n &&
      /^[0-9a-f]{64}$/u.test(c.databaseContainerId) &&
      /^[1-9][0-9]*$/u.test(r.identity.databaseOid) &&
      r.identity.databaseName === expectedDatabase &&
      c.runnerImageDigest === p.toolchain.runnerImageDigest &&
      c.postgresImageDigest === p.toolchain.postgresImageDigest &&
      /^\/tmp\/manual-schema-reference-[a-zA-Z0-9_-]+$/u.test(root) &&
      c.dataDirectory === root + "/data" &&
      c.socketDirectory === root + "/socket" &&
      c.listenAddresses === "" &&
      c.configuredPort === 5432 &&
      !(
        c.systemIdentifier === target.cluster.systemIdentifier &&
        r.identity.databaseOid === target.databaseOid
      ) &&
      expectedOrder([r.createdAt, r.readbackAt, p.generatedAt])
  );
  const creation = expectedJson(await raw(r.creationEvidence), true),
    readback = expectedJson(await raw(r.readbackEvidence), true);
  for (const [v, version, tools] of [
    [creation, "manual-expected-reference-creation.v1", expectedCreationTools],
    [readback, "manual-expected-reference-readback.v1", expectedReadbackTools]
  ])
    expectedRequire(
      exact(v, ["recordVersion", "referenceRunId", "calls"]) &&
        v.recordVersion === version &&
        v.referenceRunId === r.referenceRunId &&
        Array.isArray(v.calls) &&
        v.calls.length === tools.length
    );
  expectedRequire(Array.isArray(r.calls) && r.calls.length === 4);
  const captured = new Map();
  for (const [calls, tools] of [
    [creation.calls, expectedCreationTools],
    [r.calls, expectedPrismaTools],
    [readback.calls, expectedReadbackTools]
  ]) {
    let previous;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      expectedRequire(
        exact(call, expectedProcessKeys) &&
          call.tool === tools[i] &&
          Number.isSafeInteger(call.pid) &&
          call.pid > 0 &&
          call.exitCode === 0 &&
          call.signal === null &&
          expectedOrder([
            ...(previous ? [previous] : []),
            call.preparedAt,
            call.spawnedAt,
            call.closedAt,
            p.generatedAt
          ]),
        "MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID"
      );
      previous = call.closedAt;
      const argv = expectedJson(await raw(call.argv), true),
        stdout = await raw(call.stdout),
        stderr = await raw(call.stderr);
      expectedRequire(
        Array.isArray(argv) && argv.length > 0 && argv.every((v) => typeof v === "string"),
        "MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID"
      );
      expectedText(stdout);
      expectedText(stderr);
      captured.set(call.tool, { call, argv, stdout });
      if (tools === expectedPrismaTools)
        expectedRequire(
          expectedEqual(argv, expectedPrismaArgv(call.tool)) &&
            expectedOrder([
              r.createdAt,
              call.preparedAt,
              call.spawnedAt,
              call.closedAt,
              r.readbackAt
            ]),
          "MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID"
        );
    }
  }
  const get = (tool) => captured.get(tool),
    dockerPrefix = get("container-create").argv.slice(0, 5),
    dockerCommand =
      process.platform === "win32"
        ? "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"
        : "/usr/bin/docker";
  expectedRequire(
    dockerPrefix[0] === dockerCommand &&
      dockerPrefix[1] === "--host" &&
      dockerPrefix[2] ===
        (process.platform === "win32"
          ? "npipe:////./pipe/docker_engine"
          : "unix:///var/run/docker.sock") &&
      dockerPrefix[3] === "--config" &&
      /^\/tmp\/manual-schema-handoff-[a-zA-Z0-9_-]+\/docker-config$/u.test(dockerPrefix[4]),
    "MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID"
  );
  const imageRef = `${proof.identity.images.runner.registry}@${c.runnerImageDigest}`,
    id = c.databaseContainerId;
  const checkArgv = (tool, argv) =>
    expectedRequire(expectedEqual(get(tool).argv, argv), "MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID");
  checkArgv("container-create", [
    ...dockerPrefix,
    "create",
    "--pull=never",
    "--network=none",
    "--user=postgres",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,nosuid,nodev,size=16m,mode=1777",
    "--interactive",
    "--entrypoint",
    "/usr/local/bin/node",
    imageRef,
    "/app/scripts/release/manual-expected-schema-producer.mjs",
    "--reference"
  ]);
  expectedRequire(expectedText(get("container-create").stdout).trim() === id);
  const container = expectedJson(get("container-inspect").stdout),
    exited = expectedJson(get("container-exit-inspect").stdout),
    image = expectedJson(get("image-inspect").stdout);
  const containerKeys = [
    "id",
    "imageId",
    "imageRef",
    "user",
    "network",
    "binds",
    "mounts",
    "tmpfs",
    "readonly",
    "status",
    "running",
    "exitCode"
  ];
  for (const [v, state] of [
    [container, "created"],
    [exited, "exited"]
  ])
    expectedRequire(
      exact(v, containerKeys) &&
        v.id === id &&
        expectedDigest(v.imageId) &&
        v.imageRef === imageRef &&
        v.user === "postgres" &&
        v.network === "none" &&
        v.readonly === true &&
        (v.binds === null || expectedEqual(v.binds, [])) &&
        Array.isArray(v.mounts) &&
        v.mounts.length <= 2 &&
        v.mounts.every(
          (m) =>
            exact(m, ["type", "source", "destination"]) &&
            m.type === "tmpfs" &&
            m.source === "" &&
            ["/tmp", "/var/lib/postgresql/data"].includes(m.destination)
        ) &&
        expectedEqual(v.tmpfs, {
          "/tmp": "rw,nosuid,nodev,size=512m,mode=1777",
          "/var/lib/postgresql/data": "rw,nosuid,nodev,size=16m,mode=1777"
        }) &&
        v.status === state &&
        v.running === false &&
        v.exitCode === 0
    );
  expectedRequire(
    container.imageId === exited.imageId &&
      exact(image, ["id", "repoDigests", "sourceRevision"]) &&
      image.id === container.imageId &&
      image.sourceRevision === p.sourceSha &&
      Array.isArray(image.repoDigests) &&
      image.repoDigests.every(expectedString) &&
      image.repoDigests.includes(imageRef)
  );
  checkArgv("container-inspect", [
    ...dockerPrefix,
    "container",
    "inspect",
    "--format",
    expectedContainerFormat,
    id
  ]);
  checkArgv("container-exit-inspect", [
    ...dockerPrefix,
    "container",
    "inspect",
    "--format",
    expectedContainerFormat,
    id
  ]);
  checkArgv("image-inspect", [
    ...dockerPrefix,
    "image",
    "inspect",
    "--format",
    expectedImageFormat,
    image.id
  ]);
  checkArgv("container-stop", [...dockerPrefix, "stop", "--time", "10", id]);
  checkArgv("container-remove", [...dockerPrefix, "rm", "--force", "--volumes", id]);
  expectedRequire(expectedText(get("container-remove").stdout).trim() === id);
  checkArgv("node-version", ["/usr/local/bin/node", "--version"]);
  const pg = "/usr/lib/postgresql/17/bin/",
    data = c.dataDirectory,
    socket = c.socketDirectory;
  checkArgv("psql-version", [pg + "psql", "--version"]);
  checkArgv("initdb", [
    pg + "initdb",
    "--pgdata",
    data,
    "--username",
    expectedRole,
    "--encoding=UTF8",
    "--locale=C.UTF-8",
    "--auth-local=trust",
    "--auth-host=reject"
  ]);
  checkArgv("pg-start", [
    pg + "pg_ctl",
    "--pgdata",
    data,
    "--log",
    root + "/server.log",
    "--wait",
    "--timeout=30",
    "--options",
    `-c listen_addresses='' -c unix_socket_directories=${socket} -c unix_socket_permissions=0700 -c port=5432`,
    "start"
  ]);
  checkArgv("pg-stop", [
    pg + "pg_ctl",
    "--pgdata",
    data,
    "--wait",
    "--timeout=30",
    "--mode=immediate",
    "stop"
  ]);
  const psql = [
    pg + "psql",
    "--no-psqlrc",
    "--no-password",
    "--host",
    socket,
    "--port",
    "5432",
    "--username",
    expectedRole,
    "--dbname",
    expectedDatabase,
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--command"
  ];
  checkArgv("database-create", [
    ...psql.map((v) => (v === expectedDatabase ? "postgres" : v)),
    `CREATE DATABASE ${expectedDatabase} OWNER ${expectedRole}`
  ]);
  for (const tool of ["identity-before", "identity-after"])
    checkArgv(tool, [...psql, expectedIdentitySql]);
  checkArgv("migration-readback", [...psql, expectedMigrationsSql]);
  const before = expectedJson(get("identity-before").stdout),
    after = expectedJson(get("identity-after").stdout);
  for (const db of [before, after])
    expectedRequire(
      exact(db, [
        "databaseName",
        "databaseOid",
        "systemIdentifier",
        "serverVersion",
        "schemaOwner",
        "ownerInventory",
        "extensions",
        "listenAddresses",
        "socketDirectory",
        "dataDirectory",
        "configuredPort"
      ]) &&
        db.databaseName === r.identity.databaseName &&
        db.databaseOid === r.identity.databaseOid &&
        db.systemIdentifier === c.systemIdentifier &&
        db.serverVersion === p.toolchain.postgresqlVersion &&
        [expectedRole, "pg_database_owner"].includes(db.schemaOwner) &&
        db.listenAddresses === "" &&
        db.socketDirectory === socket &&
        db.dataDirectory === data &&
        db.configuredPort === 5432 &&
        Array.isArray(db.ownerInventory) &&
        db.ownerInventory.length > 0 &&
        db.ownerInventory.every(
          (v) =>
            exact(v, ["objectClass", "objectName", "owner"]) &&
            ["schema", "relation", "sequence"].includes(v.objectClass) &&
            expectedString(v.objectName) &&
            [expectedRole, "pg_database_owner"].includes(v.owner)
        ) &&
        Array.isArray(db.extensions) &&
        db.extensions.every(expectedString)
    );
  expectedRequire(
    r.migrationOwner === expectedRole &&
      after.ownerInventory.filter(
        (v) =>
          v.objectClass === "relation" &&
          v.objectName === "_prisma_migrations" &&
          v.owner === expectedRole
      ).length === 1 &&
      expectedEqual(after.extensions, extensions) &&
      expectedEqual(r.allowedExtensions, extensions)
  );
  const rows = expectedJson(get("migration-readback").stdout);
  expectedRequire(
    Array.isArray(rows) &&
      rows.length === catalog.entries.length &&
      rows.every(
        (v, i) =>
          exact(v, ["name", "checksum", "finished", "rolledBack", "appliedSteps"]) &&
          v.name === catalog.entries[i].path.split("/").at(-2) &&
          v.checksum === catalog.entries[i].sha256.slice(7) &&
          v.finished === true &&
          v.rolledBack === false &&
          Number.isSafeInteger(v.appliedSteps) &&
          v.appliedSteps >= 1
      )
  );
  const catalogIdentity = {
    catalogVersion: "migration-catalog.v1",
    entries: catalog.entries.map((v) => ({ order: v.order, path: v.path, sha256: v.sha256 }))
  };
  expectedRequire(
    (await raw(r.migrationCatalog)).equals(encodeManualJson(catalogIdentity)) &&
      r.migrationCatalog.digest === p.migrationCatalogDigest &&
      r.migrationHead === rows.at(-1)?.name
  );
  expectedRequire(
    expectedText(get("node-version").stdout).trim() === p.toolchain.nodeVersion &&
      /^psql \(PostgreSQL\) 17\.11(?: \([^()]+\))?$/u.test(
        expectedText(get("psql-version").stdout).trim()
      ) &&
      expectedEqual(get("prisma-version").call.stdout, p.toolchain.prismaVersionRaw) &&
      expectedText(get("prisma-version").stdout).trim() === p.toolchain.prismaVersion &&
      expectedEqual(get("prisma-script").call.stdout, p.expectedScript) &&
      expectedText(get("prisma-diff").stdout).trim() === ""
  );
  expectedRequire(
    r.createdAt === get("database-create").call.closedAt &&
      r.readbackAt === get("migration-readback").call.closedAt &&
      expectedOrder([get("image-inspect").call.closedAt, get("node-version").call.preparedAt]) &&
      expectedOrder([
        get("identity-before").call.closedAt,
        get("prisma-version").call.preparedAt
      ]) &&
      expectedOrder([get("prisma-script").call.closedAt, get("identity-after").call.preparedAt]) &&
      expectedOrder([get("pg-stop").call.closedAt, get("container-exit-inspect").call.preparedAt])
  );
  return {
    ownerInventory: after.ownerInventory,
    stable: {
      migrationCatalog: r.migrationCatalog,
      migrationHead: r.migrationHead,
      migrationOwner: r.migrationOwner,
      allowedExtensions: r.allowedExtensions
    }
  };
}

// Parse captured OSS XML only: no client, credentials or network. Shared with
// the snapshot declaration reader; callers retain their own semantic checks.
export async function readCapturedOssXml(body, root) {
  const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url)),
    ossRequire = createRequire(apiRequire.resolve("ali-oss")),
    xml = ossRequire("xml2js");
  const source = expectedText(body);
  expectedRequire(!/<!DOCTYPE|<!ENTITY/iu.test(source));
  let parsed;
  try {
    parsed = await xml.parseStringPromise(source, {
      explicitRoot: true,
      explicitArray: false,
      strict: true
    });
  } catch {
    fail("MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID");
  }
  expectedRequire(exact(parsed, [root]));
  let value = parsed[root];
  if (value && typeof value === "object" && value.$ !== undefined) {
    expectedRequire(
      exact(value.$, ["xmlns"]) && value.$.xmlns === "http://doc.oss-cn-hangzhou.aliyuncs.com"
    );
    value = { ...value };
    delete value.$;
  }
  return value;
}

async function expectedOssImport(imported, p, facts, subjects, raw) {
  expectedRequire(
    exact(imported, [
      "recordVersion",
      "buildProofDigest",
      "proofRawDigest",
      "profileDigest",
      "ownerId",
      "importApprovalRef",
      "importedAt",
      "readbackAt",
      "objects",
      "promotionEligible"
    ]) &&
      imported.recordVersion === "manual-expected-schema-import.v1" &&
      imported.buildProofDigest === facts.build.buildProofDigest &&
      imported.proofRawDigest === facts.build.proofRawDigest &&
      imported.profileDigest === facts.fixed.operation.profileDigest &&
      imported.ownerId === facts.profile.ownerId &&
      expectedString(imported.importApprovalRef) &&
      expectedOrder([imported.importedAt, imported.readbackAt]) &&
      Date.parse(imported.readbackAt) <= Date.now() &&
      imported.promotionEligible === false &&
      Array.isArray(imported.objects) &&
      imported.objects.length === subjects.size
  );
  const reader = `acs:ram::${expectedAccount}:role/subscription-saas-stage1-evidence-audit-reader/stage1-reader-${p.ci.runId}-attempt-1`,
    writer = `acs:ram::${expectedAccount}:role/subscription-saas-stage1-evidence-writer/stage1-writer-${p.ci.runId}-attempt-1`;
  const httpTime = (v) =>
    typeof v === "string" &&
    Number.isFinite(Date.parse(v)) &&
    new Date(Date.parse(v)).toUTCString() === v;
  const xmlBody = readCapturedOssXml;
  const aclBody = async (body) => {
    const v = await xmlBody(body, "AccessControlPolicy");
    expectedRequire(
      exact(v, ["Owner", "AccessControlList"]) &&
        exact(v.Owner, ["ID", "DisplayName"]) &&
        v.Owner.ID === expectedAccount &&
        typeof v.Owner.DisplayName === "string" &&
        exact(v.AccessControlList, ["Grant"]) &&
        v.AccessControlList.Grant === "private"
    );
  };
  let previousDigest = "";
  for (const object of imported.objects) {
    expectedRequire(
      exact(object, [
        "subject",
        "storeRef",
        "writerIdentity",
        "auditReaderIdentity",
        "storedAt",
        "retainUntil",
        "readbackAt",
        "getEvidence",
        "headEvidence",
        "aclEvidence"
      ])
    );
    const subject = expectedRawRef(object.subject),
      bytes = subjects.get(subject.digest);
    expectedRequire(
      bytes &&
        bytes.length === subject.bytes &&
        subject.digest > previousDigest &&
        object.writerIdentity === writer &&
        object.auditReaderIdentity === "audit-reader" &&
        expectedOrder([
          object.storedAt,
          object.readbackAt,
          imported.importedAt,
          imported.readbackAt
        ]) &&
        expectedTime(object.retainUntil)
    );
    previousDigest = subject.digest;
    const key = `evidence/github-${p.ci.runId}-attempt-1/${subject.digest.slice(7)}.json`;
    expectedRequire(object.storeRef === `oss://${expectedBucket}/${key}`);
    const head = expectedJson(await raw(object.headEvidence), true),
      acl = expectedJson(await raw(object.aclEvidence), true),
      get = expectedJson(await raw(object.getEvidence), true);
    expectedRequire(Array.isArray(head?.bucketChecks) && head.bucketChecks.length === 6);
    const bucketRecords = [];
    for (const ref of head.bucketChecks) bucketRecords.push(expectedJson(await raw(ref), true));
    const records = [...bucketRecords, head, acl, get],
      operations = [...expectedBucketTools, "HeadObject", "GetObjectAcl", "GetObject"];
    let previousAt;
    const bodies = new Map();
    for (let i = 0; i < records.length; i++) {
      const v = records[i],
        operation = operations[i],
        isObject = i >= 6;
      expectedRequire(
        exact(v, [
          "recordVersion",
          "operation",
          "bucket",
          "objectKey",
          "readerPrincipal",
          "observedAt",
          "response",
          "bucketChecks"
        ]) &&
          v.recordVersion === "manual-expected-oss-readback.v1" &&
          v.operation === operation &&
          v.bucket === expectedBucket &&
          v.objectKey === (isObject ? key : null) &&
          v.readerPrincipal === reader &&
          expectedOrder([...(previousAt ? [previousAt] : []), v.observedAt, object.readbackAt]) &&
          exact(v.response, ["status", "headers", "body"]) &&
          v.response.status === 200 &&
          exact(v.response.headers, expectedHeaderKeys) &&
          Array.isArray(v.bucketChecks) &&
          (operation === "HeadObject" || v.bucketChecks.length === 0)
      );
      previousAt = v.observedAt;
      const h = v.response.headers,
        body = await raw(v.response.body);
      expectedRequire(
        expectedHeaderKeys.every(
          (name) =>
            h[name] === null ||
            (typeof h[name] === "string" &&
              h[name].length <= 1024 &&
              [...h[name]].every(
                (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
              ))
        ) &&
          httpTime(h.date) &&
          typeof h["x-oss-request-id"] === "string" &&
          /^[A-Za-z0-9-]+$/u.test(h["x-oss-request-id"]) &&
          (h["content-length"] === null ||
            (/^(?:0|[1-9][0-9]*)$/u.test(h["content-length"]) &&
              Number.isSafeInteger(Number(h["content-length"])) &&
              (operation === "HeadObject" || Number(h["content-length"]) === body.length)))
      );
      bodies.set(operation, body);
      if (["GetObject", "HeadObject"].includes(operation))
        expectedRequire(
          h["content-length"] !== null &&
            Number(h["content-length"]) === subject.bytes &&
            httpTime(h["last-modified"]) &&
            typeof h.etag === "string" &&
            h.etag.length > 0 &&
            h["x-oss-server-side-encryption"] === "AES256" &&
            typeof h["content-type"] === "string" &&
            h["content-type"].length > 0 &&
            (operation === "HeadObject" ? body.length === 0 : body.equals(bytes))
        );
    }
    await aclBody(bodies.get("GetBucketAcl"));
    await aclBody(bodies.get("GetObjectAcl"));
    const worm = await xmlBody(bodies.get("GetBucketWorm"), "WormConfiguration");
    expectedRequire(
      exact(worm, ["WormId", "State", "RetentionPeriodInDays", "CreationDate"]) &&
        expectedString(worm.WormId) &&
        worm.State === "Locked" &&
        worm.RetentionPeriodInDays === "210" &&
        typeof worm.CreationDate === "string" &&
        Number.isFinite(Date.parse(worm.CreationDate)) &&
        Date.parse(worm.CreationDate) <= Date.parse(object.storedAt)
    );
    const version = await xmlBody(bodies.get("GetBucketVersioning"), "VersioningConfiguration");
    expectedRequire(
      (typeof version === "string" && version.trim() === "") ||
        ((exact(version, []) || exact(version, ["Status"])) &&
          (version.Status === undefined || version.Status === ""))
    );
    const encryption = await xmlBody(bodies.get("GetBucketEncryption"), "ServerSideEncryptionRule"),
      rule = encryption?.ApplyServerSideEncryptionByDefault;
    expectedRequire(
      exact(encryption, ["ApplyServerSideEncryptionByDefault"]) &&
        rule &&
        typeof rule === "object" &&
        !Array.isArray(rule) &&
        Object.keys(rule).every((k) =>
          ["SSEAlgorithm", "KMSMasterKeyID", "KMSDataEncryption"].includes(k)
        ) &&
        Object.values(rule).every((v) => typeof v === "string") &&
        rule.SSEAlgorithm === "AES256"
    );
    const policy = await xmlBody(bodies.get("GetBucketPolicyStatus"), "PolicyStatus"),
      bpa = await xmlBody(
        bodies.get("GetBucketPublicAccessBlock"),
        "PublicAccessBlockConfiguration"
      );
    expectedRequire(
      exact(policy, ["IsPublic"]) &&
        policy.IsPublic === "false" &&
        exact(bpa, ["BlockPublicAccess"]) &&
        bpa.BlockPublicAccess === "true"
    );
    const headers = head.response.headers;
    expectedRequire(
      [
        "content-length",
        "last-modified",
        "etag",
        "x-oss-server-side-encryption",
        "content-type"
      ].every((k) => headers[k] === get.response.headers[k]) &&
        object.storedAt === new Date(Date.parse(headers["last-modified"])).toISOString() &&
        object.retainUntil ===
          new Date(Date.parse(object.storedAt) + 210 * 86400000).toISOString() &&
        Date.parse(object.retainUntil) >= Date.parse(object.storedAt) + 90 * 86400000
    );
  }
}
function expectedGhArgv(file, p) {
  const argv = [
    "attestation",
    "verify",
    file,
    "--repo",
    "keqi119/subscription-Saas",
    "--signer-workflow",
    "keqi119/subscription-Saas/.github/workflows/docker-images.yml",
    "--source-ref",
    "refs/heads/main",
    "--source-digest",
    p.sourceSha,
    "--cert-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    "--deny-self-hosted-runners",
    "--format",
    "json"
  ];
  return argv;
}

function expectedGhResult({ subject, p, processResult, startedAt, argvRaw, stdout, stderr }) {
  expectedRequire(
    !processResult.problem &&
      processResult.spawned &&
      Number.isSafeInteger(processResult.pid) &&
      processResult.pid > 0 &&
      processResult.exitCode === 0 &&
      processResult.signal === null,
    processResult.problem ?? "MANUAL_EXPECTED_SCHEMA_PROCESS_FAILED"
  );
  expectedText(processResult.stderr);
  const output = expectedJson(processResult.stdout);
  expectedRequire(
    Array.isArray(output) && output.length === 1,
    "MANUAL_EXPECTED_SCHEMA_ATTESTATION_INVALID"
  );
  const item = output[0],
    result = item?.verificationResult,
    cert = result?.signature?.certificate,
    statement = result?.statement,
    signer =
      "https://github.com/keqi119/subscription-Saas/.github/workflows/docker-images.yml@refs/heads/main";
  expectedRequire(
    cert?.issuer === "https://token.actions.githubusercontent.com" &&
      (cert.subjectAlternativeName === signer ||
        (cert.subjectAlternativeName?.type === "URI" &&
          cert.subjectAlternativeName.value === signer)) &&
      cert.buildSignerURI === signer &&
      cert.buildSignerDigest === p.sourceSha &&
      cert.runnerEnvironment === "github-hosted" &&
      cert.sourceRepositoryURI === "https://github.com/keqi119/subscription-Saas" &&
      cert.sourceRepositoryDigest === p.sourceSha &&
      cert.sourceRepositoryRef === "refs/heads/main" &&
      cert.buildConfigURI === signer &&
      cert.buildConfigDigest === p.sourceSha &&
      cert.runInvocationURI ===
        `https://github.com/keqi119/subscription-Saas/actions/runs/${p.ci.runId}/attempts/1` &&
      statement?._type === "https://in-toto.io/Statement/v1" &&
      Array.isArray(statement.subject) &&
      statement.subject.length === 1 &&
      exact(statement.subject[0]?.digest, ["sha256"]) &&
      statement.subject[0].digest.sha256 === subject.digest.slice(7) &&
      Array.isArray(result.verifiedTimestamps) &&
      result.verifiedTimestamps.length > 0 &&
      result.verifiedTimestamps.every(
        (v) =>
          typeof v?.timestamp === "string" &&
          Number.isFinite(Date.parse(v.timestamp)) &&
          Date.parse(p.generatedAt) <= Date.parse(v.timestamp) &&
          Date.parse(v.timestamp) <= Date.parse(processResult.closedAt)
      ),
    "MANUAL_EXPECTED_SCHEMA_ATTESTATION_INVALID"
  );
  const bundle = item.attestation?.bundle,
    payload = bundle?.dsseEnvelope?.payload;
  expectedRequire(
    bundle &&
      typeof bundle === "object" &&
      !Array.isArray(bundle) &&
      bundle.dsseEnvelope?.payloadType === "application/vnd.in-toto+json" &&
      typeof payload === "string",
    "MANUAL_EXPECTED_SCHEMA_ATTESTATION_INVALID"
  );
  const payloadBytes = Buffer.from(payload, "base64");
  expectedRequire(
    payloadBytes.toString("base64") === payload &&
      encodeManualJson(expectedJson(payloadBytes)).equals(encodeManualJson(statement)),
    "MANUAL_EXPECTED_SCHEMA_ATTESTATION_INVALID"
  );
  return {
    subject,
    argv: argvRaw,
    stdout,
    stderr,
    pid: processResult.pid,
    startedAt,
    closedAt: processResult.closedAt,
    exitCode: 0,
    signal: null,
    bundleDigest: sha256Canonical(bundle)
  };
}

async function openManualExpectedSchemaInputs(input) {
  if (
    !exact(input, [
      "fixed",
      "build",
      "profile",
      "principal",
      "targetContext",
      "allocation",
      "attemptAllocationDigest"
    ])
  )
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  const descriptors = Object.getOwnPropertyDescriptors(input.fixed);
  for (const key of ["operation", "indexDigest", "proofBytes", "materialBytes"])
    if (!descriptors[key] || !("value" in descriptors[key]))
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  if (
    ![descriptors.proofBytes.value, descriptors.materialBytes.value].every(
      (bytes) => Buffer.isBuffer(bytes) && bytes.length <= expectedLimit
    )
  )
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  const facts = sourceValue({
      build: input.build,
      profile: input.profile,
      principal: input.principal,
      targetContext: input.targetContext
    }),
    fixed = {
      ...sourceValue({
        operation: descriptors.operation.value,
        indexDigest: descriptors.indexDigest.value
      }),
      proofBytes: Buffer.from(descriptors.proofBytes.value),
      materialBytes: Buffer.from(descriptors.materialBytes.value)
    },
    allocation = sourceValue(input.allocation),
    attemptAllocationDigest = input.attemptAllocationDigest;
  const { build, profile, principal } = facts;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  expectedRequire(
    uuid.test(fixed.operation.operationRef) &&
      uuid.test(allocation.attemptId) &&
      expectedDigest(build.proofRawDigest) &&
      expectedDigest(build.materialRawDigest) &&
      sha256Bytes(fixed.proofBytes) === build.proofRawDigest &&
      sha256Bytes(fixed.materialBytes) === build.materialRawDigest &&
      sha256Canonical(allocation) === attemptAllocationDigest &&
      path.isAbsolute(profile.storage.archiveRoot) &&
      path.resolve(profile.storage.archiveRoot) === profile.storage.archiveRoot
  );
  const bound = { ...facts, fixed },
    opened = [],
    sourcePins = [],
    raws = new Map(),
    subjects = new Map(),
    copies = [];
  let closed = false,
    recorded;
  const close = async () => {
    if (closed) return;
    closed = true;
    const settled = await Promise.allSettled(
      [...opened, ...sourcePins].map((item) => item.close())
    );
    for (const item of [...opened, ...sourcePins]) item.bytes.fill(0);
    for (const bytes of [...raws.values(), ...copies, fixed.proofBytes, fixed.materialBytes])
      bytes.fill(0);
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  };
  const copy = (bytes) => {
    const result = Buffer.from(bytes);
    copies.push(result);
    return result;
  };
  const rawRef = (bytes) => ({ digest: sha256Bytes(bytes), bytes: bytes.length });
  const proof = expectedJson(fixed.proofBytes),
    root = path.join(
      profile.storage.archiveRoot,
      "inputs",
      "expected-schema",
      build.proofRawDigest.slice(7)
    ),
    admissionRoot = path.join(root, "admissions", fixed.operation.operationRef),
    options = { principal, privateRoot: profile.storage.archiveRoot };
  try {
    const pin = async (file) => {
      const item = await pinPrivateInput(file, options);
      opened.push(item);
      return item;
    };
    // Hold the exact already-verified originals; this is identity/byte custody,
    // never another proof/material/receipt/CI verifier.
    for (const [digest, suffix, bytes] of [
      [build.proofRawDigest, "proof.json", fixed.proofBytes],
      [build.materialRawDigest, "material.json", fixed.materialBytes]
    ]) {
      const original = await pin(
        path.join(profile.storage.archiveRoot, "inputs", "build", `${digest.slice(7)}.${suffix}`)
      );
      expectedRequire(original.bytes.equals(bytes), "MANUAL_OPERATION_INPUT_UNAVAILABLE");
    }
    const files = new Map();
    for (const name of [
      "provenance.json",
      "expected.sql",
      "schema.prisma",
      "prisma-version.stdout",
      "import-readback.json"
    ])
      files.set(name, await pin(path.join(root, name)));
    const p = expectedJson(files.get("provenance.json").bytes, true),
      imported = expectedJson(files.get("import-readback.json").bytes, true);
    expectedProvenanceShape(p, bound, proof);
    const raw = async (ref) => {
      expectedRawRef(ref);
      if (!raws.has(ref.digest))
        raws.set(
          ref.digest,
          Buffer.from((await pin(path.join(root, "raw", `${ref.digest.slice(7)}.bin`))).bytes)
        );
      const bytes = raws.get(ref.digest);
      expectedRequire(
        bytes.length === ref.bytes && sha256Bytes(bytes) === ref.digest,
        "MANUAL_EXPECTED_SCHEMA_RAW_INVALID"
      );
      return bytes;
    };
    const sourceRaw = async (ref) => {
      const bytes = await raw(ref);
      subjects.set(ref.digest, bytes);
      return bytes;
    };
    const provenanceRaw = files.get("provenance.json").bytes;
    subjects.set(sha256Bytes(provenanceRaw), provenanceRaw);
    expectedRequire((await sourceRaw(p.proofRaw)).equals(fixed.proofBytes));
    for (const [key, name] of [
      ["sourceSchema", "schema.prisma"],
      ["config", null],
      ["lockfile", null]
    ]) {
      const item = await expectedCheckoutPin(p[key].path);
      sourcePins.push(item);
      const bytes = await sourceRaw(p[key].raw);
      expectedRequire(bytes.equals(item.bytes) && (!name || bytes.equals(files.get(name).bytes)));
      expectedText(bytes);
    }
    expectedRequire(
      (await sourceRaw(p.expectedScript)).equals(files.get("expected.sql").bytes) &&
        (await sourceRaw(p.toolchain.prismaVersionRaw)).equals(
          files.get("prisma-version.stdout").bytes
        ) &&
        expectedText(files.get("prisma-version.stdout").bytes).trim() === p.toolchain.prismaVersion
    );
    expectedText(files.get("expected.sql").bytes);
    const catalog = await computeMigrationCatalog(repoRoot),
      extensionSet = new Set(["plpgsql"]);
    expectedRequire(catalog.digest === p.migrationCatalogDigest && catalog.entries.length > 0);
    for (const entry of catalog.entries) {
      const item = await expectedCheckoutPin(entry.path);
      sourcePins.push(item);
      expectedRequire(sha256Bytes(item.bytes) === entry.sha256);
      for (const match of expectedText(item.bytes).matchAll(
        /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/giu
      ))
        extensionSet.add(match[1].toLowerCase());
    }
    const references = [];
    for (const r of p.references)
      references.push(
        await expectedReference(
          r,
          p,
          sourceRaw,
          proof,
          facts.targetContext,
          catalog,
          [...extensionSet].sort()
        )
      );
    const [a, b] = p.references;
    expectedRequire(
      a.referenceRunId !== b.referenceRunId &&
        a.identity.cluster.databaseContainerId !== b.identity.cluster.databaseContainerId &&
        !(
          a.identity.cluster.systemIdentifier === b.identity.cluster.systemIdentifier &&
          a.identity.databaseOid === b.identity.databaseOid
        ) &&
        expectedEqual(references[0], references[1]),
      "MANUAL_EXPECTED_SCHEMA_REPRODUCTION_FAILED"
    );
    await expectedOssImport(imported, p, bound, subjects, raw);
    const recheck = async () => {
      if (closed) fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
      for (const items of [opened, sourcePins]) {
        for (let offset = 0; offset < items.length; offset += 8) {
          const settled = await Promise.allSettled(
            items.slice(offset, offset + 8).map((item) => item.recheck())
          );
          const failed = settled.find((result) => result.status === "rejected");
          if (failed) throw failed.reason;
        }
      }
      const head = (
        await nativeText("git", [
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-C",
          repoRoot,
          "rev-parse",
          "--verify",
          "HEAD"
        ])
      ).trim();
      const status = await nativeText("git", [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-C",
        repoRoot,
        "status",
        "--porcelain",
        "--untracked-files=all"
      ]);
      expectedRequire(
        head === p.sourceSha &&
          status === "" &&
          (await computeRepositoryContract(repoRoot)).digest ===
            proof.identity.repositoryContractDigest &&
          (await computeMigrationCatalog(repoRoot)).digest === p.migrationCatalogDigest
      );
    };
    const expectation = {
      schemaVersion: "manual-runner-evidence.v1",
      recordedAt: p.generatedAt,
      promotionEligible: false,
      kind: "schema-expectation",
      buildProofDigest: build.buildProofDigest,
      sourceSchemaDigest: p.sourceSchema.raw.digest,
      prismaVersion: p.toolchain.prismaVersion,
      script: p.expectedScript,
      sourceSchemaPath: expectedSchemaPath
    };
    validateContract("manual-runner-evidence.v1", expectation);
    const expectationBytes = encodeManualJson(expectation),
      expectationDigest = sha256Bytes(expectationBytes),
      provenance = rawRef(provenanceRaw);
    const recordedDirectory = path.join(
        profile.storage.archiveRoot,
        "inputs",
        "operations",
        fixed.operation.operationRef,
        "runner-launch",
        allocation.attemptId
      ),
      appendDirectories = new Set([
        path.join(profile.storage.archiveRoot, "raw"),
        path.join(profile.storage.archiveRoot, "objects"),
        recordedDirectory
      ]),
      recordedFiles = new Map();
    // These three fixed directories gain ordinary sibling files during work.
    // Reopen every original independently; only their directory contents may
    // change. Leaf bytes/identity, nlink, all ACLs and other ancestors stay fixed.
    const readRecordedFile = async (file) => {
      const item = await pinPrivateInput(file, options);
      try {
        await item.recheck();
        const chain = await checkedPrivatePath(file, options),
          previous = recordedFiles.get(file);
        expectedRequire(
          !previous ||
            (item.bytes.equals(previous.bytes) &&
              chain.length === previous.chain.length &&
              chain.every(
                (entry, index) =>
                  entry.path === previous.chain[index].path &&
                  (entry.path !== options.privateRoot &&
                  !entry.path.startsWith(options.privateRoot + path.sep)
                    ? samePublicDirectory(entry.stat, previous.chain[index].stat)
                    : sameIdentity(
                        entry.stat,
                        previous.chain[index].stat,
                        !appendDirectories.has(entry.path)
                      ))
              )),
          "MANUAL_OPERATION_INPUT_UNAVAILABLE"
        );
        if (!previous) {
          const saved = {
            bytes: Buffer.from(item.bytes),
            chain,
            recheck: async () => {
              await readRecordedFile(file);
            },
            close: async () => {}
          };
          recordedFiles.set(file, saved);
          opened.push(saved);
        }
        return recordedFiles.get(file);
      } finally {
        await item.close();
      }
    };
    const archiveRaw = async (ref) => {
      expectedRawRef(ref);
      const item = await readRecordedFile(
        path.join(profile.storage.archiveRoot, "raw", ref.digest.slice(7) + ".bin")
      );
      expectedRequire(
        item.bytes.length === ref.bytes && sha256Bytes(item.bytes) === ref.digest,
        "MANUAL_STORAGE_UNVERIFIED"
      );
      return item.bytes;
    };
    const readRecordedAdmission = async () => {
      if (closed) fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
      if (recorded) {
        await recheck();
        return recorded;
      }
      try {
        const sidecar = await pin(path.join(admissionRoot, allocation.attemptId + ".json")),
          admission = expectedJson(sidecar.bytes, true),
          calls = [],
          captured = [],
          directory = recordedDirectory;
        for (const [name, subject, prefix] of [
          ["provenance.json", provenance, "expected-provenance.gh"],
          ["expected.sql", p.expectedScript, "expected-script.gh"]
        ]) {
          const captureInput = await readRecordedFile(
              path.join(directory, prefix + ".capture.json")
            ),
            capture = expectedJson(captureInput.bytes, true);
          expectedRequire(
            exact(capture, [
              "recordVersion",
              "subject",
              "argv",
              "stdout",
              "stderr",
              "pid",
              "startedAt",
              "closedAt",
              "exitCode",
              "signal",
              "processProblem",
              "recordedAt",
              "promotionEligible"
            ]) &&
              capture.recordVersion === "manual-expected-gh-capture.v1" &&
              capture.promotionEligible === false &&
              expectedEqual(capture.subject, subject) &&
              exact(capture.stdout, ["raw", "complete"]) &&
              exact(capture.stderr, ["raw", "complete"]) &&
              capture.stdout.complete === true &&
              capture.stderr.complete === true &&
              capture.processProblem === null &&
              expectedOrder([
                p.generatedAt,
                capture.startedAt,
                capture.closedAt,
                capture.recordedAt,
                admission.recordedAt
              ]) &&
              Date.parse(admission.recordedAt) <= Date.now(),
            "MANUAL_EXPECTED_SCHEMA_PROCESS_FAILED"
          );
          const argvBytes = await archiveRaw(capture.argv),
            stdout = await readRecordedFile(path.join(directory, prefix + ".stdout")),
            stderr = await readRecordedFile(path.join(directory, prefix + ".stderr"));
          expectedRequire(
            argvBytes.equals(encodeManualJson(expectedGhArgv(path.join(root, name), p))),
            "MANUAL_EXPECTED_SCHEMA_PROCESS_FAILED"
          );
          for (const [stream, item] of [
            ["stdout", stdout],
            ["stderr", stderr]
          ])
            expectedRequire(
              (await archiveRaw(capture[stream].raw)).equals(item.bytes),
              "MANUAL_STORAGE_UNVERIFIED"
            );
          calls.push(
            expectedGhResult({
              subject,
              p,
              argvRaw: capture.argv,
              stdout: capture.stdout.raw,
              stderr: capture.stderr.raw,
              startedAt: capture.startedAt,
              processResult: {
                stdout: stdout.bytes,
                stderr: stderr.bytes,
                pid: capture.pid,
                spawned: true,
                problem: capture.processProblem,
                exitCode: capture.exitCode,
                signal: capture.signal,
                closedAt: capture.closedAt
              }
            })
          );
          captured.push({
            capture: captureInput.bytes,
            argv: argvBytes,
            stdout: stdout.bytes,
            stderr: stderr.bytes
          });
        }
        const object = await readRecordedFile(
          path.join(profile.storage.archiveRoot, "objects", expectationDigest.slice(7) + ".json")
        );
        expectedRequire(
          object.bytes.equals(expectationBytes) &&
            (await archiveRaw(rawRef(expectationBytes))).equals(expectationBytes),
          "MANUAL_STORAGE_UNVERIFIED"
        );
        const recordedAt = admission.recordedAt,
          expectedAdmission = {
            recordVersion: "manual-expected-schema-readback.v1",
            operationRef: fixed.operation.operationRef,
            indexDigest: fixed.indexDigest,
            runId: fixed.operation.runId,
            profileDigest: fixed.operation.profileDigest,
            attemptId: allocation.attemptId,
            attemptAllocationDigest,
            buildProofDigest: build.buildProofDigest,
            proofRawDigest: build.proofRawDigest,
            provenance,
            sourceSchema: p.sourceSchema.raw,
            prismaVersion: p.toolchain.prismaVersionRaw,
            script: p.expectedScript,
            schemaExpectation: { digest: expectationDigest, bytes: expectationBytes.length },
            calls,
            recordedAt,
            promotionEligible: false
          };
        expectedRequire(
          expectedEqual(admission, expectedAdmission) &&
            expectedOrder([
              calls[0].startedAt,
              calls[0].closedAt,
              calls[1].startedAt,
              calls[1].closedAt,
              recordedAt
            ])
        );
        await recheck();
        recorded = Object.freeze({
          bytes: Object.freeze({
            admission: copy(sidecar.bytes),
            expectation: copy(expectationBytes),
            calls: Object.freeze(
              captured.map((item) =>
                Object.freeze(
                  Object.fromEntries(Object.entries(item).map(([key, bytes]) => [key, copy(bytes)]))
                )
              )
            )
          }),
          refs: sourceValue({
            admission: rawRef(sidecar.bytes),
            expectation: rawRef(expectationBytes),
            calls: captured.map((item) =>
              Object.fromEntries(Object.entries(item).map(([key, bytes]) => [key, rawRef(bytes)]))
            )
          }),
          context: sourceValue({ admission })
        });
        return recorded;
      } catch (cause) {
        if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
          fail("MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED");
        throw cause;
      }
    };
    return Object.freeze({
      bytes: Object.freeze({
        files: Object.freeze(
          Object.fromEntries([...files].map(([name, item]) => [name, copy(item.bytes)]))
        ),
        raws: Object.freeze([...raws.values()].map(copy))
      }),
      refs: sourceValue({
        files: Object.fromEntries([...files].map(([name, item]) => [name, rawRef(item.bytes)])),
        raws: [...raws.values()].map(rawRef),
        expectation: rawRef(expectationBytes)
      }),
      context: sourceValue({ provenance: p, imported, expectation }),
      recheck,
      readRecordedAdmission,
      close
    });
  } catch (cause) {
    await close();
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      fail("MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED");
    throw cause;
  }
}

export {
  sameIdentity,
  samePublicDirectory,
  observedPath,
  readPinned,
  nativeText,
  ownerOnly,
  checkedPrivatePath,
  h3Same,
  h3Require,
  canonicalH3,
  pinPrivateInput,
  readCanonicalPrivateInput,
  openManualH3AInputs,
  openManualH3BInputs,
  expectedLimit,
  expectedRequire,
  expectedText,
  expectedJson,
  expectedEqual,
  expectedOrder,
  expectedGhArgv,
  expectedGhResult,
  openManualExpectedSchemaInputs
};
