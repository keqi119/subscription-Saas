"""Private one-off H1 Staging snapshot data runtime; no CLI or caller-selected paths.

The root controller must verify admission before calling produce(). This class
controls only the fixed source reader role and its own target/worker containers.
The separate attempt volume owner destroys the LUKS workspace after cleanup.
"""
import base64
import copy
import datetime
import hashlib
import json
import os
import re
import select
import shutil
import stat
import subprocess
import time
try:
    import resource
    import pwd
except ImportError:  # Windows unit tests import the module, never run the host path.
    resource = pwd = None


IMAGE = 'postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0'
SOURCE_NAME = 'subauto-staging-postgres-1'
SOURCE_IMAGE = 'postgres:17-alpine'
SOURCE_DATABASE = 'subscription_saas_staging'
SOURCE_ADMIN = 'subscription_saas'
SOURCE_READER = 'stage1_snapshot_reader'
SOURCE_OID = '16384'
SOURCE_SYSTEM = '7661173341297905697'
SOURCE_ROLE_OID = '85641'
TARGET_DATABASE = 'stage1_snapshot_workspace'
TARGET_ROLE = 'stage1_snapshot_migrate'
NODE = '/opt/subscription-saas/snapshot-adapter/v2/runtime/node'
NODE_SHA = 'fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48'
BUNDLE_DIGEST = 'sha256:cf0d859bee9022916b312cce869cd417a56b9a17e125f322a36cbbab1fab611e'
BUNDLE = '/opt/subscription-saas/snapshot-adapter/v2/bundles/' + BUNDLE_DIGEST[7:]
VOLUMES = '/var/lib/subscription-saas/snapshot-volumes'
MAX_WORKER_LINE = 2097152
TARGET_MEMORY = 192 * 1048576
WORKER_MEMORY = 192 * 1048576
AUTH_VALIDATOR = r'''
import { createPublicKey, createHash } from 'node:crypto';
import { validateProducerCryptoAuthorization } from '/opt/subscription-saas/snapshot-adapter/v2/bundles/cf0d859bee9022916b312cce869cd417a56b9a17e125f322a36cbbab1fab611e/packages/release-foundation/src/snapshot/producer-crypto-contracts.mjs';
let raw = '';
for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1048576) process.exit(1); }
try {
  const { authorization, publicKey, attemptId } = JSON.parse(raw);
  validateProducerCryptoAuthorization(authorization);
  const key = createPublicKey(publicKey);
  const digest = 'sha256:' + createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
  if (authorization.schemaVersion !== 'producer-crypto-run-authorization.v2' ||
      authorization.repository.name !== 'keqi119/subscription-Saas' ||
      authorization.repository.id !== '1253231368' ||
      authorization.releaseAttemptId !== attemptId ||
      Date.now() < Date.parse(authorization.notBefore) ||
      Date.now() >= Date.parse(authorization.notAfter) ||
      key.type !== 'public' || key.asymmetricKeyType !== 'rsa' ||
      key.asymmetricKeyDetails?.modulusLength !== 3072 ||
      key.asymmetricKeyDetails?.publicExponent !== 65537n ||
      digest !== authorization.localKey.keyFingerprint) process.exit(1);
  process.stdout.write(String(Date.parse(authorization.notAfter)));
} catch { process.exit(1); }
'''
SOURCE_IDENTITY_SQL = """SELECT json_build_object(
 'databaseName',current_database(),
 'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),
 'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
 'readerOid',(SELECT oid::text FROM pg_authid WHERE rolname='stage1_snapshot_reader'),
 'readerLogin',(SELECT rolcanlogin FROM pg_authid WHERE rolname='stage1_snapshot_reader'),
 'readerPasswordSet',(SELECT rolpassword IS NOT NULL FROM pg_authid WHERE rolname='stage1_snapshot_reader'),
 'readerSessions',(SELECT count(*) FROM pg_stat_activity WHERE usename='stage1_snapshot_reader'),
 'adminRole',current_user,
 'databaseBytes',pg_database_size(current_database()),
 'logStatement',current_setting('log_statement'),
 'logMinDuration',current_setting('log_min_duration_statement'),
 'logDuration',current_setting('log_duration'),
 'sharedPreload',current_setting('shared_preload_libraries'),
 'pgauditLog',current_setting('pgaudit.log',true))::text;
"""


class ProducerFailure(Exception):
    """Fixed non-secret errors only."""


def require(value, code):
    if not value:
        raise ProducerFailure('H1_PRODUCER_' + code)


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False).encode('utf-8')


def _digest(raw):
    return 'sha256:' + hashlib.sha256(raw).hexdigest()


def _utc(epoch=None):
    at = datetime.datetime.fromtimestamp(time.time() if epoch is None else epoch,
                                         datetime.timezone.utc)
    return at.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _docker_time(value):
    match = re.fullmatch(r'([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})\.([0-9]{1,9})Z', value or '')
    require(match is not None, 'WORKER_TIME_INVALID')
    parsed = datetime.datetime.strptime(match.group(1), '%Y-%m-%dT%H:%M:%S')
    require(parsed.year >= 2026, 'WORKER_TIME_INVALID')
    return match.group(1) + '.' + (match.group(2) + '000')[:3] + 'Z'


def _memory_protection():
    with open('/proc/swaps', 'rb') as source:
        swaps = source.read(8193)
    with open('/proc/sys/kernel/core_pattern', 'rb') as source:
        core = source.read(129)
    limits = resource.getrlimit(resource.RLIMIT_CORE)
    require(0 < len(swaps) <= 8192 and len(swaps.splitlines()) == 1 and
            core.strip() == b'|/bin/false' and limits == (0, 0), 'MEMORY_PROTECTION_CHANGED')
    return {'observedAt': _utc(), 'hostSwapDisabled': True, 'coreDumpDisabled': True,
            'swapTableDigest': _digest(swaps), 'corePatternDigest': _digest(core),
            'coreLimit': list(limits)}


def _fingerprint(name, oid, system):
    return _digest(_canonical({'databaseName': name, 'databaseOid': oid,
                               'systemIdentifier': system}))


def _safe_file(path, digest, mode):
    info = os.lstat(path)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and
            info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == mode and
            os.path.realpath(path) == path, 'FILE_INVALID')
    hasher = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1048576), b''):
            hasher.update(chunk)
    require(hasher.hexdigest() == digest, 'FILE_INVALID')


def _host_command(argv, code):
    try:
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=15, cwd='/', env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
        require(result.returncode == 0 and len(result.stdout) <= 8192, code)
        return result.stdout.decode('ascii')
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise ProducerFailure('H1_PRODUCER_' + code) from None


def _host_preflight(mount):
    require(os.name == 'posix' and resource is not None and os.geteuid() == 0,
            'HOST_INVALID')
    with open('/proc/swaps', 'r') as source:
        require(len(source.read(8192).splitlines()) == 1, 'HOST_INVALID')
    with open('/proc/sys/kernel/core_pattern', 'r') as source:
        require(source.read(128).strip() == '|/bin/false', 'HOST_INVALID')
    require(resource.getrlimit(resource.RLIMIT_CORE) == (0, 0), 'HOST_INVALID')
    try:
        pwd.getpwuid(65532)
    except KeyError:
        pass
    else:
        raise ProducerFailure('H1_PRODUCER_HOST_INVALID')
    proc = '/proc'
    for name in os.listdir(proc):
        if name.isdecimal():
            try:
                require(os.stat(proc + '/' + name).st_uid != 65532, 'HOST_INVALID')
            except FileNotFoundError:
                pass
    with open('/proc/meminfo', 'r') as source:
        available = next((int(line.split()[1]) * 1024 for line in source
                          if line.startswith('MemAvailable:')), 0)
    require(available >= 640 * 1048576, 'HOST_CAPACITY')
    info = os.lstat(mount)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and
            stat.S_IMODE(info.st_mode) == 0o700 and os.path.realpath(mount) == mount and
            shutil.disk_usage(mount).free >= 268435456, 'VOLUME_INVALID')
    attempt = os.path.basename(mount)[:-4]
    require(mount == VOLUMES + '/' + attempt + '.mnt' and
            re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
                         attempt), 'VOLUME_INVALID')
    mapper_name = 'subscription-s1-' + attempt
    mapper = '/dev/mapper/' + mapper_name
    backing = VOLUMES + '/' + attempt + '.luks'
    backing_info = os.lstat(backing)
    mapper_info = os.stat(mapper)
    require(stat.S_ISREG(backing_info.st_mode) and backing_info.st_uid ==
            backing_info.st_gid == 0 and backing_info.st_nlink == 1 and
            stat.S_IMODE(backing_info.st_mode) == 0o600 and
            os.path.realpath(backing) == backing and stat.S_ISBLK(mapper_info.st_mode) and
            info.st_dev == mapper_info.st_rdev, 'VOLUME_INVALID')
    status = _host_command(['/usr/sbin/cryptsetup', 'status', mapper_name], 'VOLUME_INVALID')
    match = re.search(r'^\s*device:\s*(/dev/loop[0-9]+)\s*$', status, re.M)
    require(mapper + ' is active' in status and
            re.search(r'^\s*type:\s*LUKS2\s*$', status, re.M) and match,
            'VOLUME_INVALID')
    loops = _host_command(['/usr/sbin/losetup', '-j', backing], 'VOLUME_INVALID').splitlines()
    require(len(loops) == 1 and loops[0].startswith(match.group(1) + ':'),
            'VOLUME_INVALID')
    try:
        result = subprocess.run(['/usr/bin/findmnt', '-J', '--mountpoint', mount, '-o',
                                 'TARGET,SOURCE,FSTYPE,OPTIONS'], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=15, cwd='/',
                                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
        require(result.returncode == 0 and len(result.stdout) <= 8192, 'VOLUME_INVALID')
        rows = json.loads(result.stdout.decode('utf-8')).get('filesystems')
        require(type(rows) is list and len(rows) == 1 and rows[0].get('target') == mount and
                rows[0].get('source') == mapper and rows[0].get('fstype') == 'ext4' and
                {'rw', 'nosuid', 'nodev', 'noexec'} <=
                set(rows[0].get('options', '').split(',')) and not rows[0].get('children'),
                'VOLUME_INVALID')
    except (OSError, subprocess.TimeoutExpired, ValueError, UnicodeError):
        raise ProducerFailure('H1_PRODUCER_VOLUME_INVALID') from None


def _verify_bundle():
    _safe_file(NODE, NODE_SHA, 0o555)
    manifest_path = BUNDLE + '/runtime-installation.json'
    info = os.lstat(manifest_path)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and
            info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o444 and
            os.path.realpath(manifest_path) == manifest_path and
            0 < info.st_size <= 4194304, 'BUNDLE_INVALID')
    with open(manifest_path, 'rb') as source:
        raw = source.read(4194305)
    try:
        manifest = json.loads(raw.decode('utf-8'))
        require(raw == _canonical(manifest) and _digest(raw) == BUNDLE_DIGEST and
                type(manifest) is dict and set(manifest) == {
                    'format', 'nodeSha256', 'postgresImage', 'packages', 'files'} and
                manifest['format'] == 'stage1-h1-worker-runtime/v1' and
                manifest['nodeSha256'] == NODE_SHA and manifest['postgresImage'] == IMAGE and
                type(manifest['files']) is list and len(manifest['files']) == 403,
                'BUNDLE_INVALID')
        expected = {}
        for item in manifest['files']:
            name = item['path']
            require(type(item) is dict and set(item) == {'path', 'sha256', 'sizeBytes'} and
                    type(name) is str and re.fullmatch(r'[A-Za-z0-9@_./+-]+', name) and
                    not name.startswith('/') and
                    all(part not in ('', '.', '..') for part in name.split('/')) and
                    name not in expected and type(item['sizeBytes']) is int and
                    0 <= item['sizeBytes'] <= 4194304 and
                    re.fullmatch(r'sha256:[a-f0-9]{64}', item['sha256']),
                    'BUNDLE_INVALID')
            expected[name] = item
        require('scripts/release/snapshot-h1-data-worker.mjs' in expected and
                sum(item['sizeBytes'] for item in expected.values()) == 1438635,
                'BUNDLE_INVALID')
        observed = set()
        for parent, directories, files in os.walk(BUNDLE, followlinks=False):
            current = os.lstat(parent)
            require(stat.S_ISDIR(current.st_mode) and current.st_uid == current.st_gid == 0
                    and stat.S_IMODE(current.st_mode) == 0o555, 'BUNDLE_INVALID')
            for name in directories:
                require(not os.path.islink(os.path.join(parent, name)), 'BUNDLE_INVALID')
            for name in files:
                path = os.path.join(parent, name)
                relative = os.path.relpath(path, BUNDLE).replace(os.sep, '/')
                item = expected.get(relative)
                if relative == 'runtime-installation.json':
                    require(stat.S_IMODE(os.lstat(path).st_mode) == 0o444,
                            'BUNDLE_INVALID')
                else:
                    require(item is not None and os.lstat(path).st_size == item['sizeBytes'],
                            'BUNDLE_INVALID')
                    _safe_file(path, item['sha256'][7:], 0o444)
                observed.add(relative)
        require(observed == set(expected) | {'runtime-installation.json'}, 'BUNDLE_INVALID')
    except (KeyError, TypeError, ValueError, UnicodeError):
        raise ProducerFailure('H1_PRODUCER_BUNDLE_INVALID') from None


class H1FixedSnapshotProducer:
    """One fixed source, one encrypted target, one low-privilege worker."""

    def __init__(self, attempt_id, authorization, public_key, worker_bundle_digest):
        require(type(attempt_id) is str and re.fullmatch(
            r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
            attempt_id) is not None, 'INPUT_INVALID')
        require(worker_bundle_digest in (BUNDLE_DIGEST, BUNDLE_DIGEST[7:]),
                'BUNDLE_INVALID')
        require(type(authorization) is dict and
                authorization.get('schemaVersion') == 'producer-crypto-run-authorization.v2' and
                authorization.get('repository') == {
                    'name': 'keqi119/subscription-Saas', 'id': '1253231368'} and
                type(authorization.get('snapshotRunId')) is str and
                re.fullmatch(r'[1-9][0-9]*', authorization['snapshotRunId']) and
                type(authorization.get('releaseAttemptId')) is str and
                authorization['releaseAttemptId'] == attempt_id and
                type(authorization.get('localKey')) is dict,
                'AUTHORIZATION_INVALID')
        require(type(public_key) is str and 0 < len(public_key) <= 16384 and
                public_key.startswith('-----BEGIN PUBLIC KEY-----\n') and
                public_key.rstrip().endswith('-----END PUBLIC KEY-----'),
                'PUBLIC_KEY_INVALID')
        try:
            encoded = ''.join(public_key.splitlines()[1:-1])
            der = base64.b64decode(encoded.encode('ascii'), validate=True)
            require(base64.b64encode(der).decode('ascii') == encoded and
                    _digest(der) == authorization['localKey'].get('keyFingerprint'),
                    'PUBLIC_KEY_INVALID')
        except (ValueError, UnicodeError):
            raise ProducerFailure('H1_PRODUCER_PUBLIC_KEY_INVALID') from None
        self.attempt_id = attempt_id
        self.authorization = copy.deepcopy(authorization)
        self.public_key = public_key
        self.mount = VOLUMES + '/' + attempt_id + '.mnt'
        self.crypto = self.mount + '/crypto'
        self.target_data = self.mount + '/target'
        self.target_pgdata = self.target_data + '/pgdata'
        self.target_secret = self.target_data + '/bootstrap-password'
        self.target_name = 'stage1-snapshot-target-' + attempt_id
        self.worker_name = 'stage1-snapshot-producer-' + attempt_id
        self.source_id = None
        self.target_id = None
        self.worker_id = None
        self.target_attempted = False
        self.worker_attempted = False
        self.role_touched = False
        self.started = False
        self.complete = None
        self.cleanup_observation = None
        self.observation = None
        self._worker_process = None
        self._worker_buffer = bytearray()
        self._source_password = None
        self._target_password = None
        self._deadline = None

    def _verify_authorization(self):
        raw = _canonical({'authorization': self.authorization,
                          'publicKey': self.public_key, 'attemptId': self.attempt_id})
        require(len(raw) <= 1048576, 'AUTHORIZATION_INVALID')
        try:
            result = subprocess.run([NODE, '--input-type=module', '--eval', AUTH_VALIDATOR],
                input=raw, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=15, cwd='/',
                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
            require(result.returncode == 0 and
                    re.fullmatch(rb'[1-9][0-9]{0,14}', result.stdout) is not None,
                    'AUTHORIZATION_INVALID')
            return int(result.stdout) / 1000
        except (OSError, subprocess.TimeoutExpired):
            raise ProducerFailure('H1_PRODUCER_AUTHORIZATION_INVALID') from None

    def _docker(self, argv, data=None, timeout=30, discard=False):
        try:
            result = subprocess.run(['/usr/bin/docker'] + argv, input=data,
                stdout=subprocess.DEVNULL if discard else subprocess.PIPE,
                stderr=subprocess.DEVNULL if discard else subprocess.PIPE,
                timeout=timeout, cwd='/',
                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
            require(discard or len(result.stdout) <= 65536 and len(result.stderr) <= 65536,
                    'DOCKER_UNKNOWN')
            return result
        except (OSError, subprocess.TimeoutExpired):
            raise ProducerFailure('H1_PRODUCER_DOCKER_UNKNOWN') from None

    def _inspect(self, identity):
        result = self._docker(['container', 'inspect', identity])
        if result.returncode != 0:
            require(b'No such container' in result.stderr or
                    b'No such object' in result.stderr, 'DOCKER_UNKNOWN')
            return None
        try:
            rows = json.loads(result.stdout.decode('utf-8'))
            require(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict,
                    'DOCKER_INVALID')
            return rows[0]
        except (ValueError, UnicodeError):
            raise ProducerFailure('H1_PRODUCER_DOCKER_INVALID') from None

    def _source_owned(self):
        require(self.source_id is not None, 'SOURCE_UNASSIGNED')
        value = self._inspect(self.source_id)
        require(type(value) is dict and value.get('Id') == self.source_id and
                value.get('Name') == '/' + SOURCE_NAME and
                value.get('Config', {}).get('Image') == SOURCE_IMAGE and
                value.get('State', {}).get('Running') is True and
                value.get('State', {}).get('Health', {}).get('Status') == 'healthy',
                'SOURCE_INVALID')
        return value

    def _resolve_source(self):
        require(self.source_id is None, 'SOURCE_ALREADY_RESOLVED')
        value = self._inspect(SOURCE_NAME)
        require(type(value) is dict and type(value.get('Id')) is str and
                re.fullmatch(r'[a-f0-9]{64}', value['Id']) is not None,
                'SOURCE_INVALID')
        self.source_id = value['Id']
        return self._source_owned()

    def _sql(self, identity, sql, target=False):
        require(type(sql) is str and len(sql) <= 8192 and '\x00' not in sql,
                'SQL_INVALID')
        role = 'postgres' if target else SOURCE_ADMIN
        database = TARGET_DATABASE if target else SOURCE_DATABASE
        if not target:
            # The guard is in the same admin backend and precedes any secret SQL.
            sql = ("SET log_statement='none';\nSET log_min_duration_statement=-1;\n"
                   "SET log_duration=off;\nSET log_min_error_statement='panic';\n" + sql)
        result = self._docker(['exec', '--interactive', identity, 'psql', '-X', '-q',
            '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-U', role, '-d', database] +
            (['-p', '5433'] if target else []), data=sql.encode('utf-8'), timeout=30)
        require(result.returncode == 0 and len(result.stdout) <= 8192,
                'SQL_FAILED')
        return result.stdout.decode('utf-8').strip()

    def _source_readback(self, identity, dormant=True, sessions_zero=True,
                         admission_checks=True):
        try:
            value = json.loads(self._sql(identity, SOURCE_IDENTITY_SQL))
            require(type(value) is dict and value.get('databaseName') == SOURCE_DATABASE and
                    value.get('databaseOid') == SOURCE_OID and
                    value.get('systemIdentifier') == SOURCE_SYSTEM and
                    value.get('readerOid') == SOURCE_ROLE_OID and
                    value.get('adminRole') == SOURCE_ADMIN and
                    type(value.get('readerSessions')) is int and
                    (not sessions_zero or value['readerSessions'] == 0) and
                    type(value.get('readerLogin')) is bool and
                    type(value.get('readerPasswordSet')) is bool and
                    (not admission_checks or
                     type(value.get('databaseBytes')) is int and
                     0 < value['databaseBytes'] <= 128 * 1048576 and
                     value.get('logStatement') == 'none' and
                     value.get('logMinDuration') == '-1' and
                     value.get('logDuration') == 'off' and
                     value.get('sharedPreload') == '' and
                     value.get('pgauditLog') in (None, '', 'none')) and
                    (not dormant or value['readerLogin'] is False and
                     value['readerPasswordSet'] is False), 'SOURCE_IDENTITY_INVALID')
            return value
        except (ValueError, TypeError):
            raise ProducerFailure('H1_PRODUCER_SOURCE_IDENTITY_INVALID') from None

    def _set_reader(self, enabled):
        self._source_owned()
        self._source_readback(self.source_id, dormant=enabled,
                              sessions_zero=enabled, admission_checks=enabled)
        require(enabled or self.role_touched, 'ROLE_NOT_OWNED')
        self.role_touched = True
        if enabled:
            self._source_password = os.urandom(32).hex()
            expires = self.authorization['notAfter'].replace("'", '')
            require(expires == self.authorization['notAfter'], 'AUTHORIZATION_INVALID')
            sql = "ALTER ROLE stage1_snapshot_reader LOGIN PASSWORD '" + \
                  self._source_password + "' VALID UNTIL '" + expires + "';"
        else:
            sql = 'ALTER ROLE stage1_snapshot_reader NOLOGIN PASSWORD NULL;'
        self._sql(self.source_id, sql)
        observed = self._source_readback(self.source_id, dormant=not enabled,
                                         sessions_zero=not enabled,
                                         admission_checks=enabled)
        require(observed['readerLogin'] is enabled and
                observed['readerPasswordSet'] is enabled, 'ROLE_INVALID')
        if not enabled:
            self._source_password = None

    def _target_owned(self):
        require(self.target_id is not None, 'TARGET_UNASSIGNED')
        value = self._inspect(self.target_id)
        if value is None:
            return None
        require(value.get('Id') == self.target_id and
                value.get('Name') == '/' + self.target_name and
                value.get('Config', {}).get('Image') == IMAGE and
                value.get('Config', {}).get('User') == '999:999' and
                value.get('Config', {}).get('Labels', {}).get('stage1.attempt') ==
                self.attempt_id and
                value.get('HostConfig', {}).get('NetworkMode') ==
                'container:' + self.source_id, 'TARGET_MISMATCH')
        return value

    def _worker_owned(self):
        require(self.worker_id is not None, 'WORKER_UNASSIGNED')
        value = self._inspect(self.worker_id)
        if value is None:
            return None
        require(value.get('Id') == self.worker_id and
                value.get('Name') == '/' + self.worker_name and
                value.get('Config', {}).get('Image') == IMAGE and
                value.get('Config', {}).get('User') == '65532:65532' and
                value.get('Config', {}).get('Labels', {}).get('stage1.attempt') ==
                self.attempt_id and
                value.get('HostConfig', {}).get('NetworkMode') ==
                'container:' + self.source_id, 'WORKER_MISMATCH')
        return value

    def _confined(self, kind):
        # Ownership is intentionally checked separately so drift cannot block cleanup.
        value = self._target_owned() if kind == 'target' else self._worker_owned()
        require(value is not None, kind.upper() + '_CONFINEMENT_INVALID')
        code = kind.upper() + '_CONFINEMENT_INVALID'
        try:
            config, host = value['Config'], value['HostConfig']
            expected_binds = ([(self.target_pgdata, '/var/lib/postgresql/data', True),
                               (self.target_secret, '/run/bootstrap-password', False)]
                              if kind == 'target' else
                              [(BUNDLE, '/bundle', False), (NODE, '/fixed-node', False),
                               (self.crypto, '/work/crypto', True)])
            tmpfs = ({'/var/run/postgresql':
                      'rw,nosuid,nodev,size=1m,mode=0700,uid=999,gid=999',
                      '/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=1777'}
                     if kind == 'target' else
                     {'/var/lib/postgresql/data':
                      'rw,nosuid,nodev,noexec,size=64k,mode=000',
                      '/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=65532,gid=65532'})
            mounts = value['Mounts']
            binds = [(item['Source'], item['Destination'], item['RW']) for item in mounts
                     if item['Type'] == 'bind']
            other = [item for item in mounts if item['Type'] != 'bind']
            require(len(binds) == len(expected_binds) and
                    set(binds) == set(expected_binds) and
                    all(item['Type'] == 'tmpfs' and item['Destination'] in tmpfs and
                        item['RW'] is True for item in other) and
                    len({item['Destination'] for item in mounts}) == len(mounts) and
                    host['Tmpfs'] == tmpfs and host['ReadonlyRootfs'] is True and
                    host['Privileged'] is False and host['CapDrop'] == ['ALL'] and
                    not host.get('CapAdd') and
                    host['SecurityOpt'] in (['no-new-privileges'],
                                            ['no-new-privileges:true']) and
                    host['Memory'] == host['MemorySwap'] == TARGET_MEMORY and
                    host['PidsLimit'] == 128 and
                    {'Name': 'core', 'Soft': 0, 'Hard': 0} in host['Ulimits'] and
                    host['LogConfig']['Type'] == 'none' and
                    host['RestartPolicy']['Name'] == 'no' and
                    not host.get('Binds') and not host.get('VolumesFrom') and
                    not host.get('Devices') and not host.get('DeviceRequests') and
                    not host.get('PortBindings') and
                    config['OpenStdin'] is True and config['Tty'] is False,
                    code)
            if kind == 'target':
                require(config['Entrypoint'] == ['/usr/local/bin/docker-entrypoint.sh'] and
                        config['Cmd'] == ['postgres', '-p', '5433', '-c',
                                          'listen_addresses=127.0.0.1'], code)
                additions = ['POSTGRES_PASSWORD_FILE=/run/bootstrap-password',
                             'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
                             'POSTGRES_DB=' + TARGET_DATABASE]
            else:
                require(config['Entrypoint'] == ['/fixed-node'] and
                        config['Cmd'] == ['/bundle/scripts/release/snapshot-h1-data-worker.mjs']
                        and config['WorkingDir'] == '/bundle', code)
                additions = []
            # Compare with the pinned image's inherited environment so extra
            # container variables cannot change either fixed entrypoint.
            image = self._docker(['image', 'inspect', IMAGE])
            require(image.returncode == 0 and len(image.stdout) <= 65536, code)
            rows = json.loads(image.stdout.decode('utf-8'))
            require(type(rows) is list and len(rows) == 1 and
                    value['Image'] == rows[0]['Id'], code)
            expected_env = rows[0]['Config']['Env'] + additions
            actual_env = config['Env']
            # Docker may put explicit variables before inherited image values.
            # Exact names and values matter; ordering does not. Duplicate names
            # are rejected rather than letting process-specific precedence win.
            require(type(actual_env) is list and
                    all(type(item) is str and '=' in item for item in actual_env) and
                    len(actual_env) == len(expected_env) and
                    len({item.split('=', 1)[0] for item in actual_env}) == len(actual_env) and
                    set(actual_env) == set(expected_env), code)
            return value
        except (KeyError, TypeError, ValueError, UnicodeError):
            raise ProducerFailure('H1_PRODUCER_' + code) from None

    def _assert_port_free(self):
        self._source_owned()
        result = self._docker(['exec', self.source_id, 'cat', '/proc/net/tcp',
                               '/proc/net/tcp6'])
        require(result.returncode == 0 and len(result.stdout) <= 65536,
                'PORT_UNKNOWN')
        for line in result.stdout.decode('ascii').splitlines()[1:]:
            fields = line.split()
            if len(fields) >= 4:
                local = fields[1].split(':')
                require(not (len(local) == 2 and local[1].upper() == '1539' and
                             fields[3] == '0A'), 'PORT_OCCUPIED')

    def _prepare_directories(self):
        require(not os.path.lexists(self.crypto) and
                not os.path.lexists(self.target_data), 'DIRECTORY_EXISTS')
        try:
            for path, uid in ((self.crypto, 65532), (self.target_data, 999)):
                os.mkdir(path, 0o700)
                os.chown(path, uid, uid)
                os.chmod(path, 0o700)
            os.mkdir(self.target_pgdata, 0o700)
            os.chown(self.target_pgdata, 999, 999)
            os.chmod(self.target_pgdata, 0o700)
        except OSError:
            raise ProducerFailure('H1_PRODUCER_DIRECTORY_UNKNOWN') from None

    def _create_target(self):
        require(self._inspect(self.target_name) is None, 'TARGET_NAME_EXISTS')
        self._target_password = os.urandom(32).hex()
        password_path = self.target_secret
        descriptor = os.open(password_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                             getattr(os, 'O_NOFOLLOW', 0), 0o400)
        try:
            os.fchown(descriptor, 999, 999)
            os.fchmod(descriptor, 0o400)
            os.write(descriptor, self._target_password.encode('ascii'))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        args = ['create', '--interactive', '--name', self.target_name,
            '--label', 'stage1.attempt=' + self.attempt_id, '--pull=never',
            '--network', 'container:' + self.source_id, '--user', '999:999',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--memory', '192m', '--memory-swap', '192m', '--pids-limit', '128',
            '--ulimit', 'core=0:0', '--log-driver', 'none', '--restart', 'no',
            '--mount', 'type=bind,source=' + self.target_pgdata +
                       ',target=/var/lib/postgresql/data',
            '--mount', 'type=bind,source=' + password_path +
                       ',target=/run/bootstrap-password,readonly',
            '--tmpfs', '/var/run/postgresql:rw,nosuid,nodev,size=1m,mode=0700,uid=999,gid=999',
            '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
            '--env', 'POSTGRES_PASSWORD_FILE=/run/bootstrap-password',
            '--env', 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
            '--env', 'POSTGRES_DB=' + TARGET_DATABASE,
            '--entrypoint', '/usr/local/bin/docker-entrypoint.sh', IMAGE,
            'postgres', '-p', '5433', '-c', 'listen_addresses=127.0.0.1']
        self.target_attempted = True
        result = self._docker(args)
        require(result.returncode == 0, 'TARGET_CREATE_UNKNOWN')
        identity = result.stdout.decode('ascii').strip()
        require(re.fullmatch(r'[a-f0-9]{64}', identity), 'TARGET_CREATE_UNKNOWN')
        self.target_id = identity
        require(self._target_owned() is not None, 'TARGET_MISMATCH')
        self._confined('target')
        require(self._docker(['start', self.target_id]).returncode == 0,
                'TARGET_START_UNKNOWN')
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            ready = self._docker(['exec', self.target_id, 'pg_isready', '-h',
                                  '127.0.0.1', '-p', '5433', '-U', 'postgres'],
                                 timeout=5)
            if ready.returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise ProducerFailure('H1_PRODUCER_TARGET_NOT_READY')
        require(self._confined('target').get('State', {}).get('Running') is True,
                'TARGET_NOT_READY')
        sql = "CREATE ROLE stage1_snapshot_migrate LOGIN PASSWORD '" + \
            self._target_password + "' NOSUPERUSER NOCREATEDB NOCREATEROLE " + \
            "NOBYPASSRLS NOINHERIT; ALTER DATABASE stage1_snapshot_workspace " + \
            "OWNER TO stage1_snapshot_migrate; ALTER SCHEMA public OWNER TO " + \
            "stage1_snapshot_migrate; GRANT EXECUTE ON FUNCTION " + \
            "pg_catalog.pg_control_system() TO stage1_snapshot_migrate;"
        self._sql(self.target_id, sql, target=True)
        identity_sql = "SELECT json_build_object('databaseName',current_database()," + \
            "'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database())," + \
            "'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()))::text;"
        observed = json.loads(self._sql(self.target_id, identity_sql, target=True))
        require(observed.get('databaseName') == TARGET_DATABASE and
                re.fullmatch(r'[1-9][0-9]*', observed.get('databaseOid', '')) and
                re.fullmatch(r'[1-9][0-9]*', observed.get('systemIdentifier', '')),
                'TARGET_IDENTITY_INVALID')
        return _fingerprint(observed['databaseName'], observed['databaseOid'],
                            observed['systemIdentifier'])

    def _create_worker(self):
        require(self._inspect(self.worker_name) is None, 'WORKER_NAME_EXISTS')
        args = ['create', '--interactive', '--name', self.worker_name,
            '--label', 'stage1.attempt=' + self.attempt_id, '--pull=never',
            '--network', 'container:' + self.source_id, '--user', '65532:65532',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--memory', '192m', '--memory-swap', '192m', '--pids-limit', '128',
            '--ulimit', 'core=0:0', '--log-driver', 'none', '--restart', 'no',
            '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=64k,mode=000',
            '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=65532,gid=65532',
            '--mount', 'type=bind,source=' + BUNDLE + ',target=/bundle,readonly',
            '--mount', 'type=bind,source=' + NODE + ',target=/fixed-node,readonly',
            '--mount', 'type=bind,source=' + self.crypto + ',target=/work/crypto',
            '--workdir', '/bundle', '--entrypoint', '/fixed-node', IMAGE,
            '/bundle/scripts/release/snapshot-h1-data-worker.mjs']
        self.worker_attempted = True
        result = self._docker(args)
        require(result.returncode == 0, 'WORKER_CREATE_UNKNOWN')
        identity = result.stdout.decode('ascii').strip()
        require(re.fullmatch(r'[a-f0-9]{64}', identity), 'WORKER_CREATE_UNKNOWN')
        self.worker_id = identity
        require(self._worker_owned() is not None, 'WORKER_MISMATCH')
        self._confined('worker')

    def _spawn_worker(self):
        try:
            return subprocess.Popen(['/usr/bin/docker', 'start', '--attach',
                                     '--interactive', self.worker_id],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                cwd='/', env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
        except OSError:
            raise ProducerFailure('H1_PRODUCER_WORKER_START_UNKNOWN') from None

    def _next_worker_record(self, timeout):
        deadline = min(time.monotonic() + timeout,
                       self._deadline if self._deadline is not None else float('inf'))
        while b'\n' not in self._worker_buffer:
            remaining = deadline - time.monotonic()
            require(remaining > 0, 'WORKER_TIMEOUT')
            ready, _, _ = select.select([self._worker_process.stdout], [], [], remaining)
            require(bool(ready), 'WORKER_TIMEOUT')
            chunk = os.read(self._worker_process.stdout.fileno(), 65536)
            require(bool(chunk), 'WORKER_EOF')
            self._worker_buffer.extend(chunk)
            require(len(self._worker_buffer) <= MAX_WORKER_LINE, 'WORKER_OUTPUT_INVALID')
        line, _, remainder = self._worker_buffer.partition(b'\n')
        self._worker_buffer = bytearray(remainder)
        require(0 < len(line) <= MAX_WORKER_LINE, 'WORKER_OUTPUT_INVALID')
        try:
            value = json.loads(line.decode('utf-8'))
            require(type(value) is dict, 'WORKER_OUTPUT_INVALID')
            return value
        except (ValueError, UnicodeError):
            raise ProducerFailure('H1_PRODUCER_WORKER_OUTPUT_INVALID') from None

    def _remove_owned(self, kind):
        identity = self.worker_id if kind == 'worker' else self.target_id
        attempted = self.worker_attempted if kind == 'worker' else self.target_attempted
        if not attempted:
            return True
        require(identity is not None, kind.upper() + '_UNKNOWN')
        record = self._worker_owned() if kind == 'worker' else self._target_owned()
        if record is None:
            return True
        require(self._docker(['rm', '--force', '--volumes', identity]).returncode == 0 and
                self._inspect(identity) is None, kind.upper() + '_REMOVE_UNKNOWN')
        return True

    def _destroy_ack(self, request):
        require(type(request) is dict and set(request) == {
            'kind', 'snapshotRunId', 'releaseAttemptId', 'backendPid', 'nonce'} and
            request['kind'] == 'workspace-destroy-request' and
            request['snapshotRunId'] == self.authorization['snapshotRunId'] and
            request['releaseAttemptId'] == self.authorization['releaseAttemptId'] and
            type(request['backendPid']) is int and request['backendPid'] > 0 and
            type(request['nonce']) is str and
            re.fullmatch(r'[a-f0-9]{32}', request['nonce']), 'DESTROY_REQUEST_INVALID')
        self._source_owned()
        self._source_readback(self.source_id, dormant=False, admission_checks=False)
        query = 'SELECT count(*) FROM pg_stat_activity WHERE pid=' + \
                str(request['backendPid']) + ';'
        require(self._sql(self.target_id, query, target=True) == '0',
                'TARGET_SESSION_ACTIVE')
        self._set_reader(False)
        self._remove_owned('target')
        require(self._inspect(self.target_id) is None, 'TARGET_REMOVE_UNKNOWN')
        ack = dict(request, kind='workspace-destroyed')
        raw = (json.dumps(ack, separators=(',', ':')) + '\n').encode('ascii')
        self._worker_process.stdin.write(raw)
        self._worker_process.stdin.flush()
        self._worker_process.stdin.close()

    def _worker_protocol(self, source_fingerprint, target_fingerprint):
        self._confined('target')
        self._confined('worker')
        self._worker_process = self._spawn_worker()
        config = {'kind': 'configure', 'authorization': self.authorization,
                  'publicKey': self.public_key,
                  'source': {'port': 5432, 'password': self._source_password,
                             'identityFingerprint': source_fingerprint},
                  'workspace': {'port': 5433, 'password': self._target_password,
                                'identityFingerprint': target_fingerprint}}
        payload = bytearray((json.dumps(config, separators=(',', ':')) + '\n').encode('utf-8'))
        require(len(payload) <= 1048576, 'CONFIG_TOO_LARGE')
        self._confined('target')
        self._confined('worker')
        try:
            self._worker_process.stdin.write(payload)
            self._worker_process.stdin.flush()
        finally:
            # Drop parent-side credential copies; tokenization material is now
            # generated only in the worker. This is not a physical-memory wipe.
            for index in range(len(payload)): payload[index] = 0
            config = payload = None
        first = self._next_worker_record(900)
        require(first.get('kind') == 'workspace-destroy-request', 'WORKER_FAILED')
        self._destroy_ack(first)
        terminal = self._next_worker_record(120)
        require(terminal.get('status') == 'COMPLETE' and
                terminal.get('ciphertextPath') == '/work/crypto/snapshot.enc' and
                type(terminal.get('metadata')) is dict and
                type(terminal.get('privilegeObservation')) is dict and
                type(terminal.get('fingerprintObservation')) is dict and
                type(terminal.get('scan')) is dict and
                terminal['scan'].get('schemaVersion') == 'sanitization-scan.v2' and
                type(terminal.get('envelope')) is dict and
                terminal['envelope'].get('schemaVersion') == 'snapshot-encryption-envelope.v2' and
                type(terminal.get('keyCleanup')) is dict and
                set(terminal['keyCleanup']) == {'tokenizationKeyBufferCleared',
                    'workspaceKeyBufferCleared', 'observedAt'} and
                terminal['keyCleanup']['tokenizationKeyBufferCleared'] is True and
                terminal['keyCleanup']['workspaceKeyBufferCleared'] is True and
                type(terminal['keyCleanup']['observedAt']) is str and
                re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',
                    terminal['keyCleanup']['observedAt']) is not None and
                type(terminal.get('cryptoOperation')) is dict and
                terminal['cryptoOperation'].get('envelopeDigest') == _digest(_canonical(terminal['envelope'])),
                'WORKER_RESULT_INVALID')
        remaining = self._deadline - time.monotonic()
        require(remaining > 0, 'WORKER_TIMEOUT')
        require(self._worker_process.wait(timeout=min(30, remaining)) == 0,
                'WORKER_EXIT_INVALID')
        require(not self._worker_buffer and
                os.read(self._worker_process.stdout.fileno(), 1) == b'',
                'WORKER_OUTPUT_INVALID')
        state = self._worker_owned().get('State', {})
        require(state.get('Status') == 'exited' and state.get('ExitCode') == 0 and
                state.get('OOMKilled') is False, 'WORKER_EXIT_INVALID')
        self.observation['processExit'] = {
            'workerId': self.worker_id, 'image': IMAGE,
            'startedAt': _docker_time(state.get('StartedAt')),
            'finishedAt': _docker_time(state.get('FinishedAt')), 'observedAt': _utc(),
            'exitCode': state['ExitCode'], 'signal': None, 'oomKilled': state['OOMKilled'],
            'stdoutClosed': True, 'toolExitCode': self._worker_process.returncode}
        self.observation['memoryAfter'] = _memory_protection()
        ciphertext = self.crypto + '/snapshot.enc'
        info = os.lstat(ciphertext)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 65532 and
                info.st_size > 0 and info.st_nlink == 1 and
                os.path.realpath(ciphertext) == ciphertext and
                info.st_size == terminal['envelope'].get('ciphertextSizeBytes'),
                'CIPHERTEXT_INVALID')
        hasher = hashlib.sha256()
        with open(ciphertext, 'rb') as source:
            for chunk in iter(lambda: source.read(1048576), b''):
                hasher.update(chunk)
        require('sha256:' + hasher.hexdigest() ==
                terminal['envelope'].get('ciphertextDigest'), 'CIPHERTEXT_INVALID')
        self._source_readback(self.source_id, dormant=True, admission_checks=False)
        require(self._inspect(self.target_id) is None, 'TARGET_REMOVE_UNKNOWN')
        return terminal

    def produce(self):
        require(not self.started, 'ALREADY_USED')
        self.started = True
        try:
            _host_preflight(self.mount)
            _verify_bundle()
            expires_at = self._verify_authorization()
            remaining = expires_at - time.time()
            duration = self.authorization['execution']['requestedDurationSeconds']
            require(type(duration) is int and 0 < duration <= 900 and remaining > 0,
                    'AUTHORIZATION_EXPIRED')
            self._deadline = time.monotonic() + min(duration, remaining)
            issued = time.time()
            self.observation = {'attemptId': self.attempt_id,
                'snapshotRunId': self.authorization['snapshotRunId'],
                'authorizationDigest': _digest(_canonical(self.authorization)),
                'workerBundleDigest': BUNDLE_DIGEST,
                'issuedAt': _utc(issued), 'expiresAt': _utc(min(expires_at, issued + duration)),
                'memoryBefore': _memory_protection()}
            self._resolve_source()
            self._source_readback(self.source_id)
            self._assert_port_free()
            self._prepare_directories()
            target_fingerprint = self._create_target()
            self._confined('target')
            self._set_reader(True)
            self._create_worker()
            source_fingerprint = _fingerprint(SOURCE_DATABASE, SOURCE_OID, SOURCE_SYSTEM)
            self.complete = self._worker_protocol(source_fingerprint, target_fingerprint)
            return copy.deepcopy(self.complete)
        except BaseException:
            try:
                self.cleanup()
            except Exception:
                pass
            raise

    def cleanup(self):
        failed = False
        self.cleanup_observation = None
        source_readback = None
        # Terminating the exact worker container closes its source connection.
        try:
            require(self._remove_owned('worker') is True, 'WORKER_REMOVE_UNKNOWN')
        except Exception:
            failed = True
        try:
            if self._worker_process is not None:
                self._worker_process.wait(timeout=5)
        except Exception:
            failed = True
        try:
            if self.role_touched:
                self._source_owned()
                self._set_reader(False)
                source_readback = self._source_readback(self.source_id, dormant=True, admission_checks=False)
            elif self.source_id is not None:
                self._source_owned()
                source_readback = self._source_readback(self.source_id, dormant=True, admission_checks=False)
        except Exception:
            failed = True
        try:
            require(self._remove_owned('target') is True, 'TARGET_REMOVE_UNKNOWN')
        except Exception:
            failed = True
        self._source_password = None
        self._target_password = None
        require(not failed, 'CLEANUP_UNKNOWN')
        if source_readback is not None and self.worker_attempted and self.target_attempted:
            self.cleanup_observation = {
                'observedAt': _utc(), 'workerContainerRemoved': True,
                'targetContainerRemoved': True,
                'accessReferencesCleared': self._source_password is None and self._target_password is None,
                'sourceReader': dict({name: source_readback[name] for name in
                    ('databaseOid', 'systemIdentifier', 'readerOid')},
                    login=source_readback['readerLogin'],
                    authenticationPresent=source_readback['readerPasswordSet'],
                    sessions=source_readback['readerSessions'])}
        return True
