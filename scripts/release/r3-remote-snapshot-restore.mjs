// Internal one-target R3 restore. The consumed native session owns authority and Engine transport.
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  sqlIdentifier,
  sqlLiteral
} from "../../packages/release-foundation/src/database-roles.mjs";
import { normalizeSnapshotOwnership } from "../../packages/release-foundation/src/snapshot/normalize-ownership.mjs";

const CODE = "R3_REMOTE_SNAPSHOT_RESTORE_UNAVAILABLE";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTAINER = /^[0-9a-f]{64}$/u;
const DB = /^s1ci_[0-9a-f]{24}$/u;
const ROLE = /^s1[rmx]_[0-9a-f]{24}$/u;
const OID = /^[1-9][0-9]*$/u;
const PASSWORD = /^[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const LIMIT = 131072;
const ADMIN_SCRIPT =
  'export PGPASSWORD="$(cat /run/stage1-postgres-password)" PGSSLMODE=require PGCONNECT_TIMEOUT=5 LC_ALL=C LANG=C; exec /usr/bin/psql --no-psqlrc --quiet --no-password --tuples-only --no-align --set=ON_ERROR_STOP=1 --host "$1" --port 5432 --username release_provisioner --dbname "$2" --command "$3"';
function fail() {
  throw Object.assign(new Error(CODE), { code: CODE });
}
function need(value) {
  if (!value) fail();
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function signalCheck(signal) {
  need(
    signal &&
      typeof signal.addEventListener === "function" &&
      typeof signal.removeEventListener === "function" &&
      !signal.aborted
  );
}
function text(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length <= LIMIT);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail();
  }
}
function json(bytes) {
  const raw = text(bytes);
  need(raw.length > 0);
  try {
    return JSON.parse(raw);
  } catch {
    fail();
  }
}
function multiplex(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length <= LIMIT);
  let offset = 0,
    stdoutSize = 0,
    stderrSize = 0;
  const stdout = [],
    stderr = [];
  while (offset < bytes.length) {
    need(
      bytes.length - offset >= 8 &&
        [1, 2].includes(bytes[offset]) &&
        bytes[offset + 1] === 0 &&
        bytes[offset + 2] === 0 &&
        bytes[offset + 3] === 0
    );
    const channel = bytes[offset],
      length = bytes.readUInt32BE(offset + 4);
    offset += 8;
    need(length <= bytes.length - offset && length <= LIMIT);
    const chunk = bytes.subarray(offset, offset + length);
    if (channel === 1) {
      stdout.push(chunk);
      stdoutSize += length;
    } else {
      stderr.push(chunk);
      stderrSize += length;
    }
    need(stdoutSize + stderrSize <= LIMIT);
    offset += length;
  }
  return {
    stdout: text(Buffer.concat(stdout, stdoutSize)),
    stderr: text(Buffer.concat(stderr, stderrSize))
  };
}
function responseObject(output) {
  const value = output.trim();
  need(value.length > 0 && !value.includes("\n"));
  try {
    return JSON.parse(value);
  } catch {
    fail();
  }
}
function statRow(output, expectedType) {
  const match = output.match(
    /^(directory|regular file)\|([0-7]{3,4})\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([^|\n]+)\|([^|\n]+)\n$/u
  );
  need(
    match &&
      match[1] === expectedType &&
      match[3] === "0" &&
      match[4] === "0" &&
      Number.isSafeInteger(Number(match[5])) &&
      BigInt(match[6]) > 0n &&
      BigInt(match[7]) > 0n &&
      BigInt(match[8]) > 0n
  );
  const row = {
    type: match[1],
    mode: match[2],
    uid: 0,
    gid: 0,
    size: Number(match[5]),
    device: match[6],
    inode: match[7],
    links: Number(match[8]),
    modifiedAt: match[9],
    changedAt: match[10]
  };
  need(
    row.mode === (expectedType === "directory" ? "700" : "600") &&
      (expectedType !== "regular file" || row.links === 1)
  );
  return freeze(row);
}
function sameNode(a, b, directory = false) {
  return (
    a?.type === b?.type &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.device === b.device &&
    a.inode === b.inode &&
    a.links === b.links &&
    (directory ||
      (a.size === b.size && a.modifiedAt === b.modifiedAt && a.changedAt === b.changedAt))
  );
}
function ustar(name, bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1024);
  const pad = (512 - (bytes.length % 512)) % 512;
  const tar = Buffer.alloc(512 + bytes.length + pad + 1024);
  const header = tar.subarray(0, 512);
  header.write(name, 0, "ascii");
  header.write("0000600\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(32, 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.write(
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, "0")}\0 `,
    148,
    "ascii"
  );
  bytes.copy(tar, 512);
  return tar;
}
function credentialOkay(value, username, databaseName) {
  return (
    value &&
    value.username === username &&
    PASSWORD.test(value.password) &&
    value.host === "127.0.0.1" &&
    value.port === 55441 &&
    value.database === databaseName &&
    value.tlsMode === "require"
  );
}
function targetIdentitySql(databaseName) {
  return `/*r3:target*/ SELECT jsonb_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'serverVersionNum',current_setting('server_version_num')::int,'sessionUser',session_user,'currentUser',current_user,'serverAddress',host(inet_server_addr()),'tls',COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),false),'databaseName',d.datname,'databaseOid',d.oid::text,'marker',COALESCE(shobj_description(d.oid,'pg_database'),''),'owner',pg_get_userbyid(d.datdba))::text FROM pg_database d WHERE d.datname=${sqlLiteral(databaseName)}`;
}
function roleSql(username, databaseName, migrateRole, label) {
  return `/*r3:role-${label}*/ SELECT jsonb_build_object('name',r.rolname,'oid',r.oid::text,'canLogin',r.rolcanlogin,'superuser',r.rolsuper,'createdb',r.rolcreatedb,'createrole',r.rolcreaterole,'inherit',r.rolinherit,'replication',r.rolreplication,'bypassrls',r.rolbypassrls,'memberships',(SELECT count(*)::int FROM pg_auth_members m WHERE m.member=r.oid),'grantedTo',(SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid=r.oid),'canConnect',has_database_privilege(r.rolname,${sqlLiteral(databaseName)},'CONNECT'),'canCreateDatabase',has_database_privilege(r.rolname,${sqlLiteral(databaseName)},'CREATE'),'canCreateTemporary',has_database_privilege(r.rolname,${sqlLiteral(databaseName)},'TEMP'),'passwordNull',(SELECT a.rolpassword IS NULL FROM pg_authid a WHERE a.oid=r.oid),'membership',(SELECT jsonb_build_object('role',p.rolname,'inherit',m.inherit_option,'set',m.set_option,'admin',m.admin_option) FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid WHERE m.member=r.oid AND p.rolname=${sqlLiteral(migrateRole)}))::text FROM pg_roles r WHERE r.rolname=${sqlLiteral(username)}`;
}
function schemaSql(databaseName, restoreRole) {
  return `/*r3:schema*/ SELECT jsonb_build_object('schemaOwner',pg_get_userbyid(n.nspowner),'restoreCanCreate',has_schema_privilege(${sqlLiteral(restoreRole)},'public','CREATE'))::text FROM pg_namespace n WHERE n.nspname='public'`;
}
function connectedSql(label) {
  return `/*r3:connected-${label}*/ SELECT jsonb_build_object('databaseName',current_database(),'role',current_user,'databaseOid',d.oid::text,'marker',COALESCE(shobj_description(d.oid,'pg_database'),''),'owner',pg_get_userbyid(d.datdba),'serverVersionNum',current_setting('server_version_num')::int,'tls',COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),false))::text FROM pg_database d WHERE d.datname=current_database()`;
}
const OWNERSHIP_SQL = [
  "/*r3:inventory*/ WITH objects AS (",
  "SELECT 'schema'::text AS object_class,n.nspname::text AS schema_name,n.nspname::text AS object_name,pg_get_userbyid(n.nspowner)::text AS owner,NULL::text AS extension_name FROM pg_namespace n WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'",
  "UNION ALL SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned-table' WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized-view' END,n.nspname,c.relname,pg_get_userbyid(c.relowner),e.extname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e' LEFT JOIN pg_extension e ON e.oid=d.refobjid WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m')",
  "UNION ALL SELECT 'function',n.nspname,p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',pg_get_userbyid(p.proowner),e.extname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace LEFT JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e' LEFT JOIN pg_extension e ON e.oid=d.refobjid WHERE n.nspname='public'",
  "UNION ALL SELECT 'type',n.nspname,t.typname,pg_get_userbyid(t.typowner),e.extname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_depend d ON d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e' LEFT JOIN pg_extension e ON e.oid=d.refobjid WHERE n.nspname='public' AND t.typisdefined AND t.typelem=0",
  ") SELECT COALESCE(jsonb_agg(jsonb_build_object('objectClass',object_class,'schemaName',schema_name,'objectName',object_name,'owner',owner,'extensionName',extension_name) ORDER BY object_class,schema_name,object_name),'[]'::jsonb)::text FROM objects"
].join("\n");

export async function restoreR3SnapshotDatabase(input) {
  try {
    const {
      operationRef,
      postgres,
      target,
      copied,
      ownershipMap,
      restoreCredential,
      migrationCredential,
      engineCall,
      recheck,
      transition,
      signal
    } = input ?? {};
    signalCheck(signal);
    need(
      UUID.test(operationRef) &&
        CONTAINER.test(postgres?.containerId) &&
        typeof postgres?.engineId === "string" &&
        postgres.engineId.length > 0 &&
        /^([0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(postgres?.containerAddress) &&
        postgres.containerAddress.split(".").every((part) => Number(part) <= 255) &&
        OID.test(postgres.postgres?.systemIdentifier) &&
        Number.isInteger(postgres.postgres?.serverVersionNum) &&
        postgres.postgres.serverVersionNum >= 170000 &&
        postgres.postgres.serverVersionNum < 180000 &&
        DB.test(target?.databaseName) &&
        OID.test(target.databaseOid) &&
        typeof target.marker === "string" &&
        target.marker.length > 0 &&
        target.marker.length <= 4096 &&
        target.owner === target.roles?.migrate &&
        target.schemaOwner === target.roles.migrate &&
        ROLE.test(target.roles.migrate) &&
        ROLE.test(target.roles["runtime-test"]) &&
        ROLE.test(target.roles.restore) &&
        target.roles.migrate.startsWith("s1m_") &&
        target.roles["runtime-test"].startsWith("s1r_") &&
        target.roles.restore.startsWith("s1x_") &&
        OID.test(target.roleReadback?.restore?.oid) &&
        OID.test(target.roleReadback?.migrate?.oid) &&
        target.databaseIdentityDigest ===
          sha256Canonical({
            kind: "r3-database-target",
            engineId: postgres.engineId,
            systemIdentifier: postgres.postgres.systemIdentifier,
            databaseOid: target.databaseOid,
            marker: target.marker
          }) &&
        typeof copied?.recheck === "function" &&
        copied.facts?.containerId === postgres.containerId &&
        copied.facts.path === `/tmp/stage1-r3-${operationRef.replaceAll("-", "")}/snapshot.dump` &&
        DIGEST.test(copied.facts.snapshotDigest) &&
        Number.isSafeInteger(copied.facts.plaintextSizeBytes) &&
        copied.facts.plaintextSizeBytes > 0 &&
        copied.facts.plaintextSizeBytes <= 1073741824 &&
        credentialOkay(restoreCredential, target.roles.restore, target.databaseName) &&
        credentialOkay(migrationCredential, target.roles.migrate, target.databaseName) &&
        typeof engineCall === "function" &&
        typeof recheck === "function" &&
        typeof transition === "function"
    );
    const cid = postgres.containerId,
      db = target.databaseName,
      addr = postgres.containerAddress;
    const restoreRole = target.roles.restore,
      migrateRole = target.roles.migrate;
    const directory = `/tmp/stage1-r3-${operationRef.replaceAll("-", "")}-restore-${db.slice(5)}`;
    const restoreFile = `${directory}/restore.pgpass`,
      migrationFile = `${directory}/migration.pgpass`;
    const files = new Map();
    let directoryNode,
      grantAttempted = false,
      revoked = false,
      restored = false;
    let before, granted, revokedRole, ownershipObservation, ownershipInventories, denial;
    let schema, restoreExecution, migrationReconnect, cleanupObservation;
    const stage = (name) => {
      need(transition(name) === undefined);
    };
    const run = async (command, env = [], allowFailure = false) => {
      signalCheck(signal);
      const created = json(
        await engineCall(
          "POST",
          `/containers/${cid}/exec`,
          { AttachStdout: true, AttachStderr: true, Tty: false, User: "0", Cmd: command, Env: env },
          201
        )
      );
      need(CONTAINER.test(created?.Id));
      const output = multiplex(
        await engineCall(
          "POST",
          `/exec/${created.Id}/start`,
          { Detach: false, Tty: false },
          200,
          command[0] === "/usr/bin/pg_restore" ? { timeout: 120000 } : undefined
        )
      );
      const done = json(await engineCall("GET", `/exec/${created.Id}/json`, undefined, 200));
      need(
        done?.ID === created.Id &&
          done.ContainerID === cid &&
          done.Running === false &&
          Number.isInteger(done.ExitCode)
      );
      signalCheck(signal);
      if (!allowFailure) need(done.ExitCode === 0 && output.stderr === "");
      return {
        ...output,
        executionId: created.Id,
        command: [...command],
        containerId: done.ContainerID,
        running: done.Running,
        exitCode: done.ExitCode
      };
    };
    const admin = async (sql, database = "postgres") =>
      (await run(["/bin/bash", "-ec", ADMIN_SCRIPT, "--", addr, database, sql])).stdout;
    const role = async (username, file, sql, allowFailure = false) =>
      run(
        [
          "/usr/bin/psql",
          "--host",
          addr,
          "--port",
          "5432",
          "--username",
          username,
          "--dbname",
          db,
          "--no-psqlrc",
          "--quiet",
          "--no-password",
          "--tuples-only",
          "--no-align",
          "--set=ON_ERROR_STOP=1",
          "--command",
          sql
        ],
        [`PGPASSFILE=${file}`, "PGSSLMODE=require", "PGCONNECT_TIMEOUT=5", "LC_ALL=C", "LANG=C"],
        allowFailure
      );
    const readRole = async (username, label) =>
      responseObject(await admin(roleSql(username, db, migrateRole, label)));
    const stat = async (path, type) =>
      statRow(
        (await run(["/usr/bin/stat", "-c", "%F|%a|%u|%g|%s|%d|%i|%h|%y|%z", "--", path])).stdout,
        type
      );
    const checkTarget = async () => {
      const value = responseObject(await admin(targetIdentitySql(db)));
      need(
        value.systemIdentifier === postgres.postgres.systemIdentifier &&
          value.serverVersionNum === postgres.postgres.serverVersionNum &&
          value.sessionUser === "release_provisioner" &&
          value.currentUser === "release_provisioner" &&
          value.serverAddress === addr &&
          value.tls === true &&
          value.databaseName === db &&
          value.databaseOid === target.databaseOid &&
          value.marker === target.marker &&
          value.owner === migrateRole
      );
      return value;
    };
    const checkRole = (value, username, oid, status) => {
      need(
        value?.name === username &&
          value.oid === oid &&
          value.superuser === false &&
          value.createdb === false &&
          value.createrole === false &&
          value.inherit === false &&
          value.replication === false &&
          value.bypassrls === false &&
          value.grantedTo === 0 &&
          value.canCreateDatabase === (username === migrateRole) &&
          value.canCreateTemporary === (username === migrateRole)
      );
      if (status === "pristine")
        need(
          value.canLogin === true &&
            value.canConnect === true &&
            value.memberships === 0 &&
            value.membership === null &&
            value.passwordNull === false
        );
      if (status === "granted")
        need(
          value.canLogin === true &&
            value.canConnect === true &&
            value.memberships === 1 &&
            value.membership?.role === migrateRole &&
            value.membership.inherit === false &&
            value.membership.set === true &&
            value.membership.admin === false &&
            value.passwordNull === false
        );
      if (status === "revoked")
        need(
          value.canLogin === false &&
            value.canConnect === false &&
            value.memberships === 0 &&
            value.membership === null &&
            value.passwordNull === true
        );
      return value;
    };
    const checkConnected = (value, username) => {
      need(
        value?.databaseName === db &&
          value.role === username &&
          value.databaseOid === target.databaseOid &&
          value.marker === target.marker &&
          value.owner === migrateRole &&
          value.serverVersionNum === postgres.postgres.serverVersionNum &&
          value.tls === true
      );
    };
    const upload = async (name, password) => {
      const secret = Buffer.from(
        `${addr}:5432:${db}:${name === "restore.pgpass" ? restoreRole : migrateRole}:${password}\n`,
        "ascii"
      );
      let tar;
      try {
        tar = ustar(name, secret);
        await engineCall(
          "PUT",
          `/containers/${cid}/archive?path=${encodeURIComponent(directory)}`,
          tar,
          200,
          { contentType: "application/x-tar", timeout: 15000 }
        );
      } finally {
        secret.fill(0);
        tar?.fill(0);
      }
      const path = `${directory}/${name}`;
      const node = await stat(path, "regular file");
      need(
        node.size ===
          `${addr}:5432:${db}:${name === "restore.pgpass" ? restoreRole : migrateRole}:${password}\n`
            .length && sameNode(directoryNode, await stat(directory, "directory"), true)
      );
      files.set(path, node);
    };
    const cleanup = async () => {
      if (!directoryNode) return;
      need(sameNode(directoryNode, await stat(directory, "directory"), true));
      for (const [path, pinned] of files) {
        need(sameNode(pinned, await stat(path, "regular file")));
        need((await run(["/usr/bin/rm", "--", path])).stdout === "");
      }
      need((await run(["/usr/bin/rmdir", "--", directory])).stdout === "");
      const missing = await run(["/usr/bin/stat", "--", directory], [], true);
      need(
        missing.exitCode !== 0 &&
          missing.stdout === "" &&
          /No such file or directory\s*$/u.test(missing.stderr)
      );
      cleanupObservation = {
        directory: directoryNode,
        files: Object.fromEntries(files),
        absentExitCode: missing.exitCode,
        absentStderr: missing.stderr
      };
    };
    const revoke = async () => {
      stage("REVOKING");
      await admin(
        `/*r3:revoke*/ SET client_min_messages=error; REVOKE ${sqlIdentifier(migrateRole)} FROM ${sqlIdentifier(restoreRole)}; REVOKE CONNECT ON DATABASE ${sqlIdentifier(db)} FROM ${sqlIdentifier(restoreRole)}; ALTER ROLE ${sqlIdentifier(restoreRole)} NOLOGIN; ALTER ROLE ${sqlIdentifier(restoreRole)} PASSWORD NULL;`
      );
      revokedRole = checkRole(
        await readRole(restoreRole, "restore"),
        restoreRole,
        target.roleReadback.restore.oid,
        "revoked"
      );
      stage("REVOKED");
      revoked = true;
    };
    let failed = false,
      cleanupFailed = false;
    try {
      await recheck();
      await copied.recheck();
      signalCheck(signal);
      before = await checkTarget();
      checkRole(
        await readRole(restoreRole, "restore"),
        restoreRole,
        target.roleReadback.restore.oid,
        "pristine"
      );
      checkRole(
        await readRole(migrateRole, "migrate"),
        migrateRole,
        target.roleReadback.migrate.oid,
        "pristine"
      );
      schema = responseObject(await admin(schemaSql(db, restoreRole), db));
      need(schema.schemaOwner === migrateRole && schema.restoreCanCreate === false);
      need((await run(["/usr/bin/mkdir", "-m", "0700", "--", directory])).stdout === "");
      directoryNode = await stat(directory, "directory");
      await upload("restore.pgpass", restoreCredential.password);
      await upload("migration.pgpass", migrationCredential.password);
      await copied.recheck();
      await recheck();
      signalCheck(signal);
      stage("GRANTING");
      grantAttempted = true;
      await admin(
        `/*r3:grant*/ SET client_min_messages=error; GRANT ${sqlIdentifier(migrateRole)} TO ${sqlIdentifier(restoreRole)} WITH INHERIT FALSE, SET TRUE;`
      );
      granted = checkRole(
        await readRole(restoreRole, "restore"),
        restoreRole,
        target.roleReadback.restore.oid,
        "granted"
      );
      stage("GRANTED");
      await recheck();
      await copied.recheck();
      signalCheck(signal);
      await checkTarget();
      checkConnected(
        responseObject((await role(restoreRole, restoreFile, connectedSql("restore"))).stdout),
        restoreRole
      );
      restoreExecution = await run(
        [
          "/usr/bin/pg_restore",
          "--host",
          addr,
          "--port",
          "5432",
          "--username",
          restoreRole,
          "--dbname",
          db,
          "--exit-on-error",
          "--no-owner",
          "--no-acl",
          `--role=${migrateRole}`,
          copied.facts.path
        ],
        [
          `PGPASSFILE=${restoreFile}`,
          "PGSSLMODE=require",
          "PGCONNECT_TIMEOUT=5",
          "LC_ALL=C",
          "LANG=C"
        ]
      );
      restored = true;
      const ownershipTarget = {
        databaseIdentityDigest: target.databaseIdentityDigest,
        migrationRole: migrateRole,
        runtimeRole: target.roles["runtime-test"]
      };
      const inventory = async () => {
        const objects = responseObject(
          (await role(migrateRole, migrationFile, OWNERSHIP_SQL)).stdout
        );
        need(Array.isArray(objects) && objects.length <= 100000);
        return { databaseIdentityDigest: target.databaseIdentityDigest, objects };
      };
      ownershipInventories = { before: await inventory() };
      ownershipObservation = await normalizeSnapshotOwnership({
        ownershipMap,
        target: ownershipTarget,
        inventory: ownershipInventories.before,
        transferOwnership: async () => fail(),
        readInventory: async () => (ownershipInventories.after = await inventory())
      });
      await copied.recheck();
      await checkTarget();
    } catch {
      failed = true;
    }
    if (grantAttempted) {
      try {
        await revoke();
      } catch {
        failed = true;
      }
      if (revoked) {
        try {
          await recheck();
          signalCheck(signal);
          migrationReconnect = responseObject(
            (await role(migrateRole, migrationFile, connectedSql("migrate"))).stdout
          );
          checkConnected(migrationReconnect, migrateRole);
          const rejected = await role(restoreRole, restoreFile, connectedSql("restore"), true);
          need(
            rejected.exitCode === 2 &&
              rejected.stdout === "" &&
              rejected.stderr ===
                `psql: error: connection to server at "${addr}", port 5432 failed: FATAL:  password authentication failed for user "${restoreRole}"\n`
          );
          denial = { exitCode: rejected.exitCode, stderr: rejected.stderr };
        } catch {
          failed = true;
        }
      }
    }
    try {
      await cleanup();
    } catch {
      cleanupFailed = true;
    }
    need(!failed && !cleanupFailed && restored && revoked && denial && ownershipObservation);
    const facts = freeze({
      containerId: cid,
      databaseName: db,
      databaseOid: target.databaseOid,
      directory: copied.facts.path.slice(0, -"/snapshot.dump".length),
      snapshotDigest: copied.facts.snapshotDigest,
      ownershipObservationDigest: sha256Canonical(ownershipObservation),
      restoreRoleDisabled: true,
      credentialFilesRemoved: true
    });
    const observations = freeze({
      before,
      schema,
      granted,
      restoreExecution,
      revokedRole,
      ownershipObservation,
      ownershipInventories,
      restoreLoginDenial: denial,
      migrationReconnect,
      credentialCleanup: cleanupObservation
    });
    return freeze({ facts, observations });
  } catch {
    fail();
  }
}
