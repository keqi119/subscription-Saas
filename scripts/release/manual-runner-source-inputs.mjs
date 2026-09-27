// Private source readers shared by the manual launcher and result verifier.
// These readers preserve original bytes and never open a session or observe a live target.
import path from "node:path";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import {
  encodeManualJson,
  sha256Bytes,
  sha256Canonical,
  computeManualClusterFingerprint
} from "../../packages/release-foundation/src/index.mjs";

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
    "jsonb_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'serverAddress',inet_server_addr()::text,'serverPort',inet_server_port(),'databaseName',current_database(),'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'sessionUser',session_user,'currentUser',current_user,'roleOid',(SELECT oid::text FROM pg_roles WHERE rolname=current_user),'tls',coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),false))";
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
      item = await pinPrivateInput(file, { principal, privateRoot: profile.storage.archiveRoot });
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

async function pinPrivateInput(file, options, limit = 1048576) {
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
    await recheck();
    return { bytes: captured.bytes, recheck, close: () => handle.close() };
  } catch (cause) {
    await handle.close();
    throw cause;
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

export {
  sameIdentity,
  samePublicDirectory,
  observedPath,
  readPinned,
  nativeText,
  ownerOnly,
  checkedPrivatePath,
  h3Oid,
  h3Text,
  h3Instant,
  h3Same,
  h3Require,
  h3Rows,
  h3RoleRows,
  h3Table,
  h3Sources,
  canonicalH3,
  pinPrivateInput,
  openManualH3AInputs
};
