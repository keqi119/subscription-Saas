"""Root-only, fixed Docker lifecycle for one H1 snapshot JIT Runner.

This module owns only its exact container. It does not admit a job, attest a
GitHub route, destroy the encrypted source, or claim production success.
"""
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
try:
    import resource
except ImportError:  # Unit tests run on Windows; host preflight still rejects it.
    resource = None


IMAGE = 'postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0'
NODE = '/opt/subscription-saas/snapshot-adapter/v2/runtime/node'
NODE_SHA = 'fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48'
CODE = '/opt/subscription-saas/snapshot-adapter/v2/control'
DIST = '/opt/subscription-saas/snapshot-adapter/v2/runner-distributions/2.337.0'
DIST_ARCHIVE_SHA = '70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613'
VOLUMES = '/var/lib/subscription-saas/snapshot-volumes'
MANAGEMENT = '/run/stage1-snapshot/management'
ENTRIES = ('snapshot-h1-runner-entry.mjs', 'snapshot-h1-container-hook.js',
           'snapshot-h1-job-client.mjs')
MAX_FRAME = 1048576 + 4096


class RunnerFailure(Exception):
    """Only fixed non-secret codes cross the private controller boundary."""


def require(value, code='REJECTED'):
    if not value:
        raise RunnerFailure('H1_RUNNER_' + code)


def _sha_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        while True:
            chunk = source.read(1048576)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _safe_file(path, digest):
    require(os.path.realpath(path) == path, 'FILE_INVALID')
    info = os.lstat(path)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and
            info.st_nlink == 1 and info.st_mode & 0o022 == 0 and
            _sha_file(path) == digest, 'FILE_INVALID')


def _command(argv):
    try:
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=15, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin',
                                                 'LC_ALL': 'C'}, cwd='/', check=False)
        require(result.returncode == 0 and len(result.stdout) <= 65536,
                'HOST_OBSERVATION_FAILED')
        return result.stdout.decode('utf-8')
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise RunnerFailure('H1_RUNNER_HOST_OBSERVATION_FAILED') from None


def _host_preflight():
    require(os.name == 'posix' and resource is not None and os.geteuid() == 0,
            'HOST_INVALID')
    with open('/proc/swaps', 'r') as source:
        require(len(source.read(8192).splitlines()) == 1, 'MEMORY_INVALID')
    with open('/proc/sys/kernel/core_pattern', 'r') as source:
        require(source.read(128).strip() == '|/bin/false', 'MEMORY_INVALID')
    require(resource.getrlimit(resource.RLIMIT_CORE) == (0, 0), 'MEMORY_INVALID')


def _verify_volume(attempt_id, mount, runner_root):
    backing = VOLUMES + '/' + attempt_id + '.luks'
    mapper_name = 'subscription-s1-' + attempt_id
    mapper = '/dev/mapper/' + mapper_name
    parent = os.lstat(VOLUMES)
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == parent.st_gid == 0 and
            stat.S_IMODE(parent.st_mode) == 0o700 and os.path.realpath(VOLUMES) == VOLUMES,
            'VOLUME_INVALID')
    info = os.lstat(backing)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and
            info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600 and
            os.path.realpath(backing) == backing, 'VOLUME_INVALID')
    mounted = os.lstat(mount)
    require(stat.S_ISDIR(mounted.st_mode) and os.path.realpath(mount) == mount,
            'VOLUME_INVALID')
    observed = json.loads(_command(['/usr/bin/findmnt', '--json', '--mountpoint', mount,
                                    '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS']))
    rows = observed.get('filesystems') if type(observed) is dict else None
    require(type(rows) is list and len(rows) == 1, 'VOLUME_INVALID')
    row = rows[0]
    require(type(row) is dict and row.get('target') == mount and
            row.get('fstype') == 'ext4' and type(row.get('source')) is str and
            os.path.realpath(row['source']) == os.path.realpath(mapper) and
            type(row.get('options')) is str and
            {'nosuid', 'nodev', 'noexec'} <= set(row['options'].split(',')) and
            not row.get('children'), 'VOLUME_INVALID')
    mapper_stat = os.stat(mapper)
    require(stat.S_ISBLK(mapper_stat.st_mode) and mapper_stat.st_uid == 0 and
            mounted.st_dev == mapper_stat.st_rdev, 'VOLUME_INVALID')
    status = _command(['/usr/sbin/cryptsetup', 'status', mapper_name])
    require((mapper + ' is active') in status and
            re.search(r'^\s*type:\s*LUKS2\s*$', status, re.M) is not None,
            'VOLUME_INVALID')
    loop_match = re.search(r'^\s*device:\s*(/dev/loop[0-9]+)\s*$', status, re.M)
    require(loop_match is not None, 'VOLUME_INVALID')
    loops = _command(['/usr/sbin/losetup', '-j', backing]).splitlines()
    require(len(loops) == 1 and loops[0].startswith(loop_match.group(1) + ':'),
            'VOLUME_INVALID')


def _verify_runner_directory(runner_root):
    runner = os.lstat(runner_root)
    require(stat.S_ISDIR(runner.st_mode) and runner.st_uid == 992 and
            runner.st_gid == 988 and stat.S_IMODE(runner.st_mode) == 0o700 and
            os.path.realpath(runner_root) == runner_root and
            set(os.listdir(runner_root)) == {'bin', 'externals'}, 'RUNNER_DIRECTORY_INVALID')
    for name in ('bin', 'externals'):
        path = runner_root + '/' + name
        item = os.lstat(path)
        require(stat.S_ISDIR(item.st_mode) and item.st_uid in (0, 992) and
                item.st_gid in (0, 988) and item.st_mode & 0o022 == 0 and
                os.path.realpath(path) == path and not os.listdir(path),
                'RUNNER_DIRECTORY_INVALID')


def _create_runner_directory(runner_root):
    require(not os.path.lexists(runner_root), 'RUNNER_DIRECTORY_EXISTS')
    try:
        os.mkdir(runner_root, 0o700)
        os.chown(runner_root, 992, 988)
        os.chmod(runner_root, 0o700)
        for name in ('bin', 'externals'):
            path = runner_root + '/' + name
            os.mkdir(path, 0o700)
            os.chown(path, 992, 988)
            os.chmod(path, 0o700)
    except OSError:
        raise RunnerFailure('H1_RUNNER_DIRECTORY_UNKNOWN') from None
    _verify_runner_directory(runner_root)


def _verify_distribution(expected_digest):
    manifest_path = DIST + '/stage1-distribution-manifest.json'
    for parent in (os.path.dirname(DIST), DIST):
        info = os.lstat(parent)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and
                stat.S_IMODE(info.st_mode) in
                ((0o555,) if parent == DIST else (0o700, 0o755)) and
                os.path.realpath(parent) == parent,
                'DISTRIBUTION_INVALID')
    require(os.lstat(manifest_path).st_size <= 4194304, 'DISTRIBUTION_INVALID')
    _safe_file(manifest_path, expected_digest)
    require(stat.S_IMODE(os.lstat(manifest_path).st_mode) == 0o444,
            'DISTRIBUTION_INVALID')
    with open(manifest_path, 'rb') as source:
        manifest = json.load(source)
    require(type(manifest) is dict and manifest.get('version') == '2.337.0' and
            manifest.get('archiveSha256') == DIST_ARCHIVE_SHA and
            type(manifest.get('files')) is list and 0 < len(manifest['files']) <= 16384,
            'DISTRIBUTION_INVALID')
    seen = set()
    for item in manifest['files']:
        require(type(item) is dict and type(item.get('path')) is str and
                0 < len(item['path']) <= 512 and
                not item['path'].startswith('/') and '\\' not in item['path'] and
                not any(ord(char) < 32 or ord(char) == 127 for char in item['path']) and
                all(part not in ('', '.', '..') for part in item['path'].split('/')) and
                item['path'] not in seen, 'DISTRIBUTION_INVALID')
        seen.add(item['path'])
        path = DIST + '/' + item['path']
        info = os.lstat(path)
        if 'linkTarget' in item:
            target = item['linkTarget']
            require(type(target) is str and stat.S_ISLNK(info.st_mode) and
                    info.st_uid == info.st_gid == 0 and os.readlink(path) == target and
                    hashlib.sha256(target.encode('ascii')).hexdigest() == item.get('sha256') and
                    os.path.realpath(path).startswith(DIST + '/'),
                    'DISTRIBUTION_INVALID')
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and
                    info.st_nlink == 1 and item.get('mode') in (0o444, 0o555) and
                    stat.S_IMODE(info.st_mode) == item['mode'] and
                    type(item.get('sizeBytes')) is int and info.st_size == item['sizeBytes'] and
                    type(item.get('sha256')) is str and _sha_file(path) == item['sha256'],
                    'DISTRIBUTION_INVALID')
    require({'bin/Runner.Listener', 'bin/Runner.Worker', 'run.sh', 'config.sh'} <= seen,
            'DISTRIBUTION_INVALID')
    actual = set()
    for parent, directories, files in os.walk(DIST, followlinks=False):
        info = os.lstat(parent)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and
                stat.S_IMODE(info.st_mode) == 0o555, 'DISTRIBUTION_INVALID')
        for name in directories:
            path = parent + '/' + name
            require(stat.S_ISDIR(os.lstat(path).st_mode), 'DISTRIBUTION_INVALID')
        for name in files:
            relative = os.path.relpath(parent + '/' + name, DIST).replace(os.sep, '/')
            actual.add(relative)
    require(actual == seen | {'stage1-distribution-manifest.json'} and
            not os.listdir(DIST + '/_diag'), 'DISTRIBUTION_INVALID')


def _verify_entries(digests):
    _safe_file(NODE, NODE_SHA)
    for name in ENTRIES:
        _safe_file(CODE + '/' + name, digests[name])


def _verify_management():
    directory = os.lstat(MANAGEMENT)
    socket_path = MANAGEMENT + '/control.sock'
    sock = os.lstat(socket_path)
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == 0 and
            directory.st_gid == 988 and stat.S_IMODE(directory.st_mode) == 0o750 and
            stat.S_ISSOCK(sock.st_mode) and sock.st_uid == 0 and sock.st_gid == 988 and
            stat.S_IMODE(sock.st_mode) == 0o660 and
            os.path.realpath(MANAGEMENT) == MANAGEMENT,
            'MANAGEMENT_INVALID')


class H1FixedRunnerContainer:
    """Prepare once, run once, then remove only a captured and verified CID."""

    def __init__(self, attempt_id, admission_ref, entry_digests,
                 distribution_manifest_digest):
        require(type(attempt_id) is str and re.fullmatch(
            r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
            attempt_id) is not None, 'INPUT_INVALID')
        require(type(admission_ref) is str and
                re.fullmatch(r'sha256:[a-f0-9]{64}', admission_ref) is not None,
                'INPUT_INVALID')
        require(type(entry_digests) is dict and set(entry_digests) == set(ENTRIES) and
                all(type(value) is str and re.fullmatch(r'[a-f0-9]{64}', value)
                    for value in entry_digests.values()) and
                type(distribution_manifest_digest) is str and
                re.fullmatch(r'[a-f0-9]{64}', distribution_manifest_digest) is not None,
                'INPUT_INVALID')
        self.attempt_id = attempt_id
        self.admission_ref = admission_ref
        self.entry_digests = dict(entry_digests)
        self.distribution_manifest_digest = distribution_manifest_digest
        self.mount = VOLUMES + '/' + attempt_id + '.mnt'
        self.runner_root = self.mount + '/runner'
        self.name = 'stage1-snapshot-runner-' + attempt_id
        self.network_name = 'stage1-snapshot-net-' + attempt_id
        self.network_id = None
        self.network_creation_attempted = False
        self.container_id = None
        self.creation_attempted = False
        self.run_attempted = False
        self.directory_prepared = False

    def _docker(self, argv, timeout=30, input_bytes=None, discard=False):
        try:
            return subprocess.run(['/usr/bin/docker'] + argv, input=input_bytes,
                                  stdout=subprocess.DEVNULL if discard else subprocess.PIPE,
                                  stderr=subprocess.DEVNULL if discard else subprocess.PIPE,
                                  timeout=timeout, cwd='/',
                                  env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'},
                                  check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise RunnerFailure('H1_RUNNER_DOCKER_UNKNOWN') from None

    def _inspect(self, identity):
        result = self._docker(['container', 'inspect', identity])
        if result.returncode != 0:
            require(result.stderr in (b'No such container', b'No such object') or
                    b'No such container:' in result.stderr or
                    b'No such object:' in result.stderr, 'DOCKER_UNKNOWN')
            return None
        try:
            rows = json.loads(result.stdout.decode('utf-8'))
            require(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict,
                    'DOCKER_INVALID')
            return rows[0]
        except (ValueError, UnicodeError):
            raise RunnerFailure('H1_RUNNER_DOCKER_INVALID') from None

    def _inspect_network(self, identity):
        result = self._docker(['network', 'inspect', identity])
        if result.returncode != 0:
            require(b'No such network' in result.stderr or
                    b'network ' in result.stderr and b' not found' in result.stderr,
                    'NETWORK_UNKNOWN')
            return None
        try:
            rows = json.loads(result.stdout.decode('utf-8'))
            require(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict,
                    'NETWORK_INVALID')
            return rows[0]
        except (ValueError, UnicodeError):
            raise RunnerFailure('H1_RUNNER_NETWORK_INVALID') from None

    def _owned_network(self, empty=False):
        require(self.network_id is not None, 'NETWORK_UNASSIGNED')
        record = self._inspect_network(self.network_id)
        if record is None:
            return None
        require(record.get('Id') == self.network_id and
                record.get('Name') == self.network_name and
                record.get('Driver') == 'bridge' and
                record.get('Scope') == 'local' and
                record.get('Internal') is False and
                type(record.get('Labels')) is dict and
                record['Labels'].get('stage1.attempt') == self.attempt_id and
                type(record.get('Containers')) is dict and
                (not empty or not record['Containers']), 'NETWORK_MISMATCH')
        return record

    def _expected_mounts(self):
        return [(self.runner_root, self.runner_root, True),
                (DIST + '/bin', self.runner_root + '/bin', False),
                (DIST + '/externals', self.runner_root + '/externals', False),
                (MANAGEMENT, MANAGEMENT, False),
                (NODE, '/entry/node', False)] + [
                    (CODE + '/' + name, '/entry/' + name, False) for name in ENTRIES]

    def _owned(self):
        require(self.container_id is not None, 'CONTAINER_UNASSIGNED')
        record = self._inspect(self.container_id)
        if record is None:
            return None
        try:
            config, host = record['Config'], record['HostConfig']
            require(record['Id'] == self.container_id and record['Name'] == '/' + self.name and
                    config['Image'] == IMAGE and config['User'] == '992:988' and
                    config['Labels'].get('stage1.attempt') == self.attempt_id and
                    config['OpenStdin'] is True and config['Tty'] is False and
                    config['Entrypoint'] == ['/entry/node'] and
                    config['Cmd'] == ['/entry/snapshot-h1-runner-entry.mjs'] and
                    host['NetworkMode'] == self.network_id and
                    host['ReadonlyRootfs'] is True and
                    host['CapDrop'] == ['ALL'] and
                    'no-new-privileges' in host['SecurityOpt'] and
                    host['Memory'] == host['MemorySwap'] == 402653184 and
                    host['PidsLimit'] == 128 and host['LogConfig']['Type'] == 'none' and
                    host['RestartPolicy']['Name'] == 'no' and
                    {'Name': 'core', 'Soft': 0, 'Hard': 0} in host['Ulimits'],
                    'CONTAINER_MISMATCH')
            networks = record['NetworkSettings']['Networks']
            require(type(networks) is dict and len(networks) <= 1 and
                    set(networks) <= {self.network_name, self.network_id},
                    'CONTAINER_MISMATCH')
            for endpoint in networks.values():
                require(type(endpoint) is dict and
                        endpoint.get('NetworkID') in ('', self.network_id),
                        'CONTAINER_MISMATCH')
            if record['State']['Status'] != 'created':
                require(len(networks) == 1 and
                        next(iter(networks.values())).get('NetworkID') == self.network_id,
                        'CONTAINER_MISMATCH')
            observed = {(item['Source'], item['Destination'], item['RW'])
                        for item in record['Mounts'] if item['Type'] == 'bind'}
            extras = {(item['Type'], item['Destination']) for item in record['Mounts']
                      if item['Type'] != 'bind'}
            require(observed == set(self._expected_mounts()) and
                    len(record['Mounts']) == len(observed) + len(extras) and
                    extras <= {('tmpfs', '/tmp'),
                               ('tmpfs', '/var/lib/postgresql/data')},
                    'CONTAINER_MISMATCH')
            return record
        except (KeyError, TypeError, ValueError):
            raise RunnerFailure('H1_RUNNER_CONTAINER_MISMATCH') from None

    def prepare_directory(self):
        require(not self.directory_prepared, 'DIRECTORY_ALREADY_ATTEMPTED')
        _host_preflight()
        _verify_volume(self.attempt_id, self.mount, self.runner_root)
        _verify_distribution(self.distribution_manifest_digest)
        _verify_entries(self.entry_digests)
        self.directory_prepared = True
        _create_runner_directory(self.runner_root)
        return self.runner_root

    def prepare(self):
        require(self.directory_prepared, 'DIRECTORY_NOT_PREPARED')
        require(not self.creation_attempted and not self.network_creation_attempted,
                'CREATE_ALREADY_ATTEMPTED')
        _host_preflight()
        _verify_volume(self.attempt_id, self.mount, self.runner_root)
        _verify_runner_directory(self.runner_root)
        _verify_distribution(self.distribution_manifest_digest)
        _verify_entries(self.entry_digests)
        _verify_management()
        require(self._inspect(self.name) is None, 'CONTAINER_NAME_EXISTS')
        require(self._inspect_network(self.network_name) is None,
                'NETWORK_NAME_EXISTS')
        self.network_creation_attempted = True
        network_result = self._docker(['network', 'create', '--driver', 'bridge',
                                       '--label', 'stage1.attempt=' + self.attempt_id,
                                       self.network_name])
        require(network_result.returncode == 0, 'NETWORK_CREATE_UNKNOWN')
        try:
            network_id = network_result.stdout.decode('ascii').strip()
        except UnicodeError:
            raise RunnerFailure('H1_RUNNER_NETWORK_CREATE_UNKNOWN') from None
        require(re.fullmatch(r'[a-f0-9]{64}', network_id) is not None,
                'NETWORK_CREATE_UNKNOWN')
        self.network_id = network_id
        require(self._owned_network(empty=True) is not None, 'NETWORK_MISMATCH')
        args = ['create', '--interactive', '--name', self.name,
                '--label', 'stage1.attempt=' + self.attempt_id,
                '--user', '992:988', '--read-only', '--network', self.network_id,
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--memory', '384m', '--memory-swap', '384m', '--pids-limit', '128',
                '--ulimit', 'core=0:0', '--log-driver', 'none', '--restart', 'no',
                '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
                '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=64k,mode=000']
        for source, target, writable in self._expected_mounts():
            mount = 'type=bind,source=' + source + ',target=' + target
            if not writable:
                mount += ',readonly'
            args.extend(['--mount', mount])
        args.extend(['--entrypoint', '/entry/node', IMAGE,
                     '/entry/snapshot-h1-runner-entry.mjs'])
        self.creation_attempted = True
        result = self._docker(args)
        require(result.returncode == 0, 'CREATE_UNKNOWN')
        try:
            identity = result.stdout.decode('ascii').strip()
        except UnicodeError:
            raise RunnerFailure('H1_RUNNER_CREATE_UNKNOWN') from None
        require(re.fullmatch(r'[a-f0-9]{64}', identity) is not None, 'CREATE_UNKNOWN')
        self.container_id = identity
        record = self._owned()
        require(record is not None and record['State']['Status'] == 'created',
                'CONTAINER_MISMATCH')
        return True

    def run(self, private_frame):
        require(self.container_id is not None and not self.run_attempted,
                'RUN_INVALID')
        require(type(private_frame) is dict and set(private_frame) == {
            'attemptId', 'admissionRef', 'runnerId', 'routeNonce', 'encodedJitConfig'} and
            private_frame['attemptId'] == self.attempt_id and
            private_frame['admissionRef'] == self.admission_ref and
            type(private_frame['runnerId']) is str and
            re.fullmatch(r'[1-9][0-9]{0,15}', private_frame['runnerId']) is not None and
            int(private_frame['runnerId']) <= 9007199254740991 and
            type(private_frame['routeNonce']) is str and
            re.fullmatch(r'[a-f0-9]{32}', private_frame['routeNonce']) is not None and
            type(private_frame['encodedJitConfig']) is str and
            0 < len(private_frame['encodedJitConfig']) <= 1048576,
            'FRAME_INVALID')
        try:
            encoded = private_frame['encodedJitConfig']
            raw = base64.b64decode(encoded.encode('ascii'), validate=True)
            require(bool(raw) and base64.b64encode(raw).decode('ascii') == encoded,
                    'FRAME_INVALID')
            frame = json.dumps(private_frame, separators=(',', ':')).encode('ascii')
        except (ValueError, UnicodeError, TypeError):
            raise RunnerFailure('H1_RUNNER_FRAME_INVALID') from None
        require(len(frame) <= MAX_FRAME, 'FRAME_INVALID')
        record = self._owned()
        require(record is not None and record['State']['Status'] == 'created',
                'RUN_INVALID')
        self.run_attempted = True
        result = self._docker(['start', '--attach', '--interactive', self.container_id],
                              timeout=1200, input_bytes=frame, discard=True)
        require(result.returncode == 0, 'RUN_UNKNOWN')
        record = self._owned()
        require(record is not None and record['State']['Status'] == 'exited' and
                record['State']['ExitCode'] == 0 and
                record['State']['OOMKilled'] is False, 'RUN_FAILED')
        return {'exitCode': 0}

    def cleanup(self):
        if not self.creation_attempted and not self.network_creation_attempted:
            return True
        failed = False
        if self.creation_attempted:
            if self.container_id is None:
                failed = True
            else:
                try:
                    record = self._owned()
                    if record is not None:
                        result = self._docker(['rm', '--force', '--volumes', self.container_id])
                        require(result.returncode == 0 and
                                self._inspect(self.container_id) is None,
                                'REMOVE_UNCONFIRMED')
                except Exception:
                    failed = True
        if self.network_creation_attempted:
            if self.network_id is None:
                failed = True
            else:
                try:
                    network = self._owned_network(empty=True)
                    if network is not None:
                        result = self._docker(['network', 'rm', self.network_id])
                        require(result.returncode == 0 and
                                self._inspect_network(self.network_id) is None,
                                'REMOVE_UNCONFIRMED')
                except Exception:
                    failed = True
        require(not failed, 'REMOVE_UNCONFIRMED')
        return True
