"""Fixed root H1 data attempt and separate publisher observation.

The approved parent opens the existing key volume with swap/core protections
before invoking this entry. A successful result is encrypted DATA_PREPARED,
not publication/custody/Stage1 completion. No plaintext leaves the attempt LUKS.
The publish operation observes its own child and session, not workflow completion.
"""
import copy
import ctypes
import datetime
try:
    import fcntl
except ImportError:
    fcntl = None
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import time
try:
    import resource
except ImportError:
    resource = None

BASE = '/opt/subscription-saas/snapshot-adapter/v2'
CONTROL = BASE + '/control'
NODE = BASE + '/runtime/node'
NODE_SHA = 'fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48'
CONFIG = CONTROL + '/snapshot-h1-attempt-installation.json'
OUTPUT = '/var/lib/subscription-saas/snapshot-output'
VOLUMES = '/var/lib/subscription-saas/snapshot-volumes'
PUBLISHER_SESSION = '/var/lib/stage1-volumes/main/snapshot-authority/publisher-session.json'
ARCHIVE_OUTPUT = '/var/lib/subscription-saas/evidence-archive'
ARCHIVE_WRITER_SESSION = '/var/lib/stage1-volumes/main/snapshot-authority/archive-writer-session.json'
ARCHIVE_READER_SESSION = '/var/lib/stage1-volumes/main/snapshot-authority/archive-reader-session.json'
MODULES = ('snapshot-h1-github.py', 'snapshot-h1-route-journal.py',
           'snapshot-h1-volume.py', 'snapshot-h1-runner.py',
           'snapshot-h1-control.py', 'snapshot-h1-producer.py')
ENTRIES = ('snapshot-h1-container-hook.js', 'snapshot-h1-job-client.mjs',
           'snapshot-h1-runner-entry.mjs')
READ_ONLY = {'snapshot-h1-volume.py', 'snapshot-h1-runner.py',
             'snapshot-h1-producer.py', 'snapshot-h1-runner-entry.mjs'}
WORKER = 'sha256:3cccfc7484628e3e8ae7564983ae52db17c539138bfa519728d35323a8c8ec8d'


def require(value, code):
    if not value:
        raise RuntimeError('H1_ATTEMPT_' + code)


def pairs(values):
    result = {}
    for key, value in values:
        require(key not in result, 'INPUT_INVALID')
        result[key] = value
    return result


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf8')


def digest(raw):
    return 'sha256:' + hashlib.sha256(raw).hexdigest()


def _same(left, right):
    return all(getattr(left, field) == getattr(right, field) for field in (
        'st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
        'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def _file(path, mode, maximum=4194304, hash_only=False):
    current = path
    while current != '/':
        info = os.lstat(current)
        require(info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022, 'FILE_INVALID')
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                stat.S_IMODE(info.st_mode) == mode if current == path else
                stat.S_ISDIR(info.st_mode), 'FILE_INVALID')
        current = os.path.dirname(current)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(0 <= before.st_size <= maximum, 'FILE_INVALID')
        parts, count, hasher = [], 0, hashlib.sha256()
        while count <= maximum:
            part = os.read(fd, min(65536, maximum + 1 - count))
            if not part: break
            count += len(part)
            if hash_only: hasher.update(part)
            else: parts.append(part)
        require(count == before.st_size and _same(before, os.fstat(fd)) and
                _same(before, os.lstat(path)), 'FILE_CHANGED')
        return hasher.hexdigest() if hash_only else b''.join(parts)
    finally:
        os.close(fd)


def _installation():
    require(os.name == 'posix' and os.geteuid() == 0, 'ROOT_REQUIRED')
    raw = _file(CONFIG, 0o444, 32768)
    value = json.loads(raw.decode('utf8'), object_pairs_hook=pairs)
    require(raw == canonical(value) and type(value) is dict and set(value) == {
        'controlBundleDigest', 'workerBundleDigest', 'python', 'entries',
        'runnerDistributionDigest', 'attemptEntrySha256'}, 'INSTALLATION_INVALID')
    require(value['workerBundleDigest'] == WORKER and
            re.fullmatch(r'sha256:[a-f0-9]{64}', value['controlBundleDigest']) and
            re.fullmatch(r'[a-f0-9]{64}', value['runnerDistributionDigest']) and
            set(value['python']) == set(MODULES) and set(value['entries']) == set(ENTRIES),
            'INSTALLATION_INVALID')
    require(type(value['attemptEntrySha256']) is str and
            re.fullmatch(r'[a-f0-9]{64}', value['attemptEntrySha256']) and
            _file(CONTROL + '/snapshot-h1-attempt.py', 0o555, hash_only=True) ==
            value['attemptEntrySha256'], 'INSTALLATION_INVALID')
    require(_file(NODE, 0o555, 134217728, hash_only=True) == NODE_SHA,
            'NODE_INVALID')
    for name, sha in list(value['python'].items()) + list(value['entries'].items()):
        require(type(sha) is str and re.fullmatch(r'[a-f0-9]{64}', sha) and
                hashlib.sha256(_file(CONTROL + '/' + name,
                                    0o444 if name in READ_ONLY else 0o555)).hexdigest() == sha,
                'INSTALLATION_INVALID')
    bundle = BASE + '/bundles/' + value['controlBundleDigest'][7:]
    manifest_raw = _file(bundle + '/runtime-installation.json', 0o444)
    require(digest(manifest_raw) == value['controlBundleDigest'], 'BUNDLE_INVALID')
    manifest = json.loads(manifest_raw.decode('utf8'), object_pairs_hook=pairs)
    require(canonical(manifest) == manifest_raw and manifest['format'] == 'stage1-h1-control-runtime/v1'
            and manifest['nodeSha256'] == NODE_SHA and len(manifest['files']) <= 4096,
            'BUNDLE_INVALID')
    names, total = set(), 0
    for item in manifest['files']:
        name = item['path']
        require(type(name) is str and re.fullmatch(r'[A-Za-z0-9@_./+-]+', name) and
                not name.startswith('/') and all(p not in ('', '.', '..') for p in name.split('/'))
                and name not in names, 'BUNDLE_INVALID')
        names.add(name)
        data = _file(bundle + '/' + name, 0o444)
        total += len(data)
        require(total <= 33554432, 'BUNDLE_INVALID')
        require(len(data) == item['sizeBytes'] and digest(data) == item['sha256'], 'BUNDLE_INVALID')
    require('scripts/release/snapshot-h1-authority.mjs' in names, 'BUNDLE_INVALID')
    return value


def _load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), CONTROL + '/' + name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class H1SnapshotAttempt:
    def __init__(self, request):
        require(type(request) is dict and set(request) == {'selection', 'approvalSelection'},
                'INPUT_INVALID')
        self.request = copy.deepcopy(request)
        self.installation = _installation()
        self.adapter_digest = digest(canonical(self.installation))
        self.bundle = BASE + '/bundles/' + self.installation['controlBundleDigest'][7:]
        self.modules = {name: _load(name) for name in MODULES}
        self.volume = self.producer = self.runner = self.control = self.github = None
        self.jit_attempted = False
        self.cleanup_facts = {}
        self.admitted = None
        self.spool = None
        self.produced = False
        self.last_running_observation = None

    def _authority(self, operation, request):
        packet = canonical({'operation': operation, 'request': request})
        require(len(packet) <= 1048576, 'INPUT_INVALID')
        result = subprocess.run([NODE, self.bundle + '/scripts/release/snapshot-h1-authority.mjs'],
            input=packet, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=280,
            cwd='/', env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
        require(result.returncode == 0 and 0 < len(result.stdout) <= 4194304, 'AUTHORITY_REJECTED')
        value = json.loads(result.stdout.decode('utf8'), object_pairs_hook=pairs)
        require(canonical(value) == result.stdout, 'AUTHORITY_REJECTED')
        return value

    def _fresh(self):
        result = self._authority('recheck', {
            'admission': self.admitted['admission'],
            'producerAuthorizationDigest': digest(canonical(self.admitted['production']['authorization'])),
            'deploymentId': self.request['approvalSelection']['deploymentId']})
        require(result.get('authorizationDigest') ==
                self.admitted['admission']['dispatchAuthorizationDigest'] and
                type(result.get('validUntilEpochMs')) is int and
                time.time() * 1000 < result['validUntilEpochMs'], 'AUTHORITY_EXPIRED')
        return result['validUntilEpochMs']

    def _readmit_before_jit(self):
        # Volume/distribution preparation can take time. Re-read actual queue,
        # Environment approval and dispatch immediately before claiming the
        # route. A changed artifact or protected production input needs a new
        # attempt, never a substitution into already prepared resources.
        latest = self._authority('admit', self.request)
        require(all(canonical(latest[field]) == canonical(self.admitted[field])
                    for field in ('admission', 'production')), 'ADMISSION_CHANGED')
        self.admitted = latest

    def _verify_running(self):
        expiry = self._fresh()
        admission = self.admitted['admission']
        self.last_running_observation = self.github.read_running_job({
            'runId': admission['producerRun']['runId'], 'jobId': self.request['selection']['jobId'],
            'sourceSha': admission['producerRun']['sourceSha'], 'routeNonce': admission['route']['nonce']})
        require(time.time() * 1000 < expiry, 'AUTHORITY_EXPIRED')
        self.volume.assert_ready()
        actual_runner = self.runner._owned()
        require(actual_runner is not None and actual_runner['State']['Running'] is True,
                'RUNNER_UNKNOWN')
        return True

    def _spool_ciphertext(self, complete):
        # Only ciphertext is copied off the attempt volume. The root-owned
        # spool is not an OSS publication and carries no publishable assertion.
        parent = os.path.dirname(OUTPUT)
        info = os.lstat(parent)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and
                not info.st_mode & 0o022 and os.path.realpath(parent) == parent, 'OUTPUT_INVALID')
        if not os.path.lexists(OUTPUT): os.mkdir(OUTPUT, 0o700)
        info = os.lstat(OUTPUT)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and
                stat.S_IMODE(info.st_mode) == 0o700, 'OUTPUT_INVALID')
        directory = OUTPUT + '/' + self.producer.attempt_id
        os.mkdir(directory, 0o700)
        source = self.producer.crypto + '/snapshot.enc'
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        count, hashed = 0, hashlib.sha256()
        try:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_uid == 65532 and before.st_nlink == 1
                    and 0 < before.st_size <= 134217728, 'CIPHERTEXT_INVALID')
            with open(directory + '/snapshot.enc', 'xb') as output:
                while True:
                    part = os.read(fd, 1048576)
                    if not part: break
                    count += len(part)
                    require(count <= before.st_size, 'CIPHERTEXT_CHANGED')
                    hashed.update(part); output.write(part)
                output.flush(); os.fsync(output.fileno())
            require(_same(before, os.fstat(fd)) and _same(before, os.lstat(source)) and
                    count == before.st_size == complete['envelope']['ciphertextSizeBytes'] and
                    'sha256:' + hashed.hexdigest() == complete['envelope']['ciphertextDigest'],
                    'CIPHERTEXT_CHANGED')
        finally:
            os.close(fd)
        self.spool = directory
        return True

    def _produce(self):
        require(not self.produced, 'ALREADY_PRODUCED')
        complete = self.producer.produce()
        require(self.producer.cleanup() is True, 'PRODUCER_CLEANUP_UNKNOWN')
        self._spool_ciphertext(complete)
        self.produced = True
        return True

    def cleanup(self):
        ok = True
        for name, obj, method in [('runner', self.runner, 'cleanup'),
                                  ('control', self.control, 'close'),
                                  ('producer', self.producer, 'cleanup')]:
            if obj is None: continue
            try: success = getattr(obj, method)() is True
            except Exception: success = False
            self.cleanup_facts[name + 'Stopped'] = success
            ok = success and ok
        if self.github is not None:
            if self.jit_attempted:
                try: removed = self.github.remove_created_runner() is True
                except Exception: removed = False
                self.cleanup_facts['runnerNotRoutable'] = removed
                ok = removed and ok
            try:
                self.github.close()
                self.cleanup_facts['githubTokenRevoked'] = True
            except Exception:
                self.cleanup_facts['githubTokenRevoked'] = False
                ok = False
        if ok and self.volume is not None:
            try:
                require(self.volume.cleanup() is True and
                        self.volume.observation.get('destroyed') is True, 'VOLUME_CLEANUP_UNKNOWN')
                self.cleanup_facts['volumeDestroyed'] = True
            except Exception:
                self.cleanup_facts['volumeDestroyed'] = False
                ok = False
        return ok

    def _observe_data_disposal(self):
        # Only this attempt's fixed, confined locations are checked. Ciphertext
        # is allowed in its exact spool; the plaintext workspace must be absent.
        attempt_id = self.producer.attempt_id
        require(self.spool == OUTPUT + '/' + attempt_id, 'RESIDUAL_SCAN_INVALID')
        paths = [VOLUMES + '/' + attempt_id + '.mnt',
                 VOLUMES + '/' + attempt_id + '.luks',
                 '/dev/mapper/subscription-s1-' + attempt_id]
        require(all(not os.path.lexists(p) for p in paths), 'PLAINTEXT_RESIDUAL')
        info = os.lstat(self.spool)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and
                stat.S_IMODE(info.st_mode) == 0o700 and os.path.realpath(self.spool) == self.spool,
                'RESIDUAL_SCAN_INVALID')
        require(os.listdir(self.spool) == ['snapshot.enc'], 'PLAINTEXT_RESIDUAL')
        envelope = self.producer.complete['envelope']
        require('sha256:' + _file(self.spool + '/snapshot.enc', 0o600, 134217728, hash_only=True) ==
                envelope['ciphertextDigest'], 'CIPHERTEXT_CHANGED')
        observed = self.producer.cleanup_observation
        require(type(observed) is dict, 'PRODUCER_CLEANUP_UNKNOWN')
        return {'producerCleanup': copy.deepcopy(observed),
                'residualScan': {'performedAt': self.modules['snapshot-h1-producer.py']._utc(),
                    'pathsChecked': paths + [self.spool], 'plaintextArtifactsFound': 0}}

    def run(self):
        failure = None
        try:
            self.admitted = self._authority('admit', self.request)
            admission = self.admitted['admission']
            production = self.admitted['production']
            require(admission['adapterDigest'] == self.adapter_digest and
                    production['authorization']['bindings']['cryptoExecutableDigest'] == WORKER,
                    'EXECUTABLE_BINDING_MISMATCH')
            attempt_id = admission['releaseAttemptId']
            reference = digest(canonical(admission))
            self.volume = self.modules['snapshot-h1-volume.py'].H1SnapshotAttemptVolume(attempt_id)
            self.volume.prepare()
            self.producer = self.modules['snapshot-h1-producer.py'].H1FixedSnapshotProducer(
                attempt_id, production['authorization'], production['publicKey'], WORKER)
            self.runner = self.modules['snapshot-h1-runner.py'].H1FixedRunnerContainer(
                attempt_id, reference, self.installation['entries'],
                self.installation['runnerDistributionDigest'])
            root = self.runner.prepare_directory()
            control_module = self.modules['snapshot-h1-control.py']
            operations = control_module.H1FixedJobContainer(reference,
                {name: self.installation['entries'][name] for name in control_module.CLIENTS},
                self._verify_running, self._produce, self.producer.cleanup)
            self.control = control_module.H1SnapshotControl(reference, root, operations)
            self.control.start()
            self.runner.prepare()
            self.github = self.modules['snapshot-h1-github.py'].H1SnapshotJitGitHub(
                lambda: self._authority('jwt', {})['jwt'])
            self.github.__enter__()
            self._readmit_before_jit()
            expires = self._fresh()
            self.modules['snapshot-h1-route-journal.py'].claim(admission['route']['nonce'],
                admission['producerRun']['runId'], self.request['selection']['jobId'], reference)
            self.jit_attempted = True
            jit = self.github.create_jit(admission['producerRun']['runId'], admission['route']['nonce'])
            require(time.time() * 1000 < expires, 'AUTHORITY_EXPIRED')
            self.runner.run({'attemptId': attempt_id, 'admissionRef': reference,
                'runnerId': str(jit['runner']['id']), 'routeNonce': admission['route']['nonce'],
                'encodedJitConfig': jit['encoded_jit_config']})
            jit = None
            require(self.produced and self.control.producer_done, 'PRODUCER_INCOMPLETE')
        except BaseException as error:
            code = str(error)
            failure = code if re.fullmatch(r'H1_[A-Z0-9_]{1,100}', code) else 'H1_ATTEMPT_EXECUTION_FAILED'
        cleaned = self.cleanup()
        require(cleaned, 'CLEANUP_UNKNOWN')
        if failure is not None: raise RuntimeError(failure)
        disposal = self._observe_data_disposal()
        terminal = {
            'observedAt': self.modules['snapshot-h1-producer.py']._utc(),
            'disposalObservationDigest': digest(canonical(disposal)),
            'cleanupFactsDigest': digest(canonical(self.cleanup_facts)),
            'volumeObservationDigest': digest(canonical(self.volume.observation)),
            'runningJobObservationDigest': digest(canonical(self.last_running_observation))}
        result = {'status': 'DATA_PREPARED', 'admission': self.admitted['admission'],
            'cryptoAuthorization': self.admitted['production']['authorization'],
            'admissionVerification': self.admitted['verification'],
            'postApproval': self.admitted['postApproval'],
            'runningJobObservation': self.last_running_observation,
            'data': self.producer.complete, 'cleanup': self.cleanup_facts,
            'disposalObservation': disposal,
            'volumeObservation': self.volume.observation,
            'executionObservation': self.producer.observation, 'terminalObservation': terminal}
        raw = canonical(result)
        require(len(raw) <= 4194304, 'RESULT_TOO_LARGE')
        with open(self.spool + '/data-result.json', 'xb') as output:
            output.write(raw);output.flush();os.fsync(output.fileno())
        sealed = self._authority('seal', {})
        require(sealed.get('dataResultDigest') == digest(raw), 'RESULT_CHANGED')
        with open(self.spool + '/snapshot-proof.json', 'xb') as output:
            output.write(canonical(sealed));output.flush();os.fsync(output.fileno())
        return {'status': 'DATA_PREPARED', 'releaseAttemptId': self.producer.attempt_id,
                'resultDigest': digest(raw)}


def _publisher_time(value):
    require(type(value) is str and re.fullmatch(
        r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z', value),
        'PUBLISH_RESULT_INVALID')
    try:
        pattern = '%Y-%m-%dT%H:%M:%S.%fZ' if '.' in value else '%Y-%m-%dT%H:%M:%SZ'
        return (datetime.datetime.strptime(value, pattern) -
                datetime.datetime(1970, 1, 1)).total_seconds()
    except ValueError:
        raise RuntimeError('H1_ATTEMPT_PUBLISH_RESULT_INVALID')


def _publisher_utc(now=None):
    if now is None: now = time.time()
    return datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(
        timespec='milliseconds').replace('+00:00', 'Z')


def _safe_root_directory(path, exact_mode=None):
    current = '/'
    for part in [p for p in path.split('/') if p]:
        current = os.path.join(current, part)
        info = os.lstat(current)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and
                not info.st_mode & 0o022, 'PUBLISH_PATH_INVALID')
    if exact_mode is not None:
        require(stat.S_IMODE(info.st_mode) == exact_mode, 'PUBLISH_PATH_INVALID')
    require(os.path.realpath(path) == path, 'PUBLISH_PATH_INVALID')
    return info


def _publisher_write(fd, raw):
    written = 0
    while written < len(raw):
        count = os.write(fd, raw[written:])
        require(count > 0, 'PUBLISH_RECORD_UNKNOWN')
        written += count


class H1SnapshotPublisher:
    """Single fixed root publication; its file is a local observation only."""
    LOCK_NAME = 'publisher.lock'
    SESSION_UNKNOWN = 'PUBLISH_SESSION_UNKNOWN'
    SESSION_CHANGED = 'PUBLISH_SESSION_CHANGED'
    EXPIRY_UNKNOWN = 'PUBLISH_EXPIRY_UNKNOWN'
    def __init__(self, request):
        require(type(request) is dict and set(request) == {
            'operation', 'releaseAttemptId', 'snapshotRunId'} and
            request['operation'] == 'publish' and
            type(request['releaseAttemptId']) is str and
            re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
                         request['releaseAttemptId']) and
            type(request['snapshotRunId']) is str and
            re.fullmatch(r'[1-9][0-9]*', request['snapshotRunId']), 'INPUT_INVALID')
        self.request = copy.deepcopy(request)
        self._init_process(OUTPUT + '/' + request['releaseAttemptId'], PUBLISHER_SESSION)

    def _init_process(self, spool, session_path):
        self.installation = _installation()
        self.bundle = BASE + '/bundles/' + self.installation['controlBundleDigest'][7:]
        self.spool = spool
        self.authority = {'startedAt': None, 'finishedAt': None,
                          'exited': False, 'exitCode': None}
        self.session = {'path': session_path, 'removed': False,
                        'removedAt': None, 'absent': False}
        self.session_before = None
        self.global_lock = None

    def _authority(self, operation, request):
        return H1SnapshotAttempt._authority(self, operation, request)

    def _ensure_spool(self):
        _safe_root_directory(OUTPUT, 0o700)
        _safe_root_directory(self.spool, 0o700)

    def _lock_payload(self):
        return {'releaseAttemptId': self.request['releaseAttemptId'],
                'snapshotRunId': self.request['snapshotRunId']}

    def _lock(self):
        self._ensure_spool()
        require(fcntl is not None, 'PUBLISH_LOCK_UNKNOWN')
        global_path = OUTPUT + '/publisher-global.lock'
        global_fd = os.open(global_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(global_fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and
                    stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1 and
                    _same(info, os.lstat(global_path)), 'PUBLISH_LOCK_UNKNOWN')
            fcntl.flock(global_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fd = os.open(self.spool + '/' + self.LOCK_NAME,
                         os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                _publisher_write(fd, canonical(self._lock_payload()))
                os.fsync(fd)
            finally:
                os.close(fd)
            parent = os.open(self.spool, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try: os.fsync(parent)
            finally: os.close(parent)
            self.global_lock = global_fd
        except BaseException:
            os.close(global_fd)
            raise

    def _observe_session(self):
        parent_path = os.path.dirname(self.session['path'])
        directory_info = _safe_root_directory(parent_path)
        parent = os.open(parent_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            require(_same(directory_info, os.fstat(parent)), self.SESSION_UNKNOWN)
            info = os.stat(os.path.basename(self.session['path']), dir_fd=parent,
                           follow_symlinks=False)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and
                    stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                    self.SESSION_UNKNOWN)
            self.session_before = info
        finally:
            os.close(parent)

    def _session_absent(self):
        self.session['absent'] = False
        parent_path = os.path.dirname(self.session['path'])
        directory_info = _safe_root_directory(parent_path)
        parent = os.open(parent_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            require(_same(directory_info, os.fstat(parent)), self.SESSION_UNKNOWN)
            try:
                os.stat(os.path.basename(self.session['path']), dir_fd=parent,
                        follow_symlinks=False)
            except FileNotFoundError:
                self.session['absent'] = True
                return True
            raise RuntimeError('H1_ATTEMPT_' + self.SESSION_UNKNOWN)
        finally:
            os.close(parent)

    def _remove_session(self):
        parent_path = os.path.dirname(self.session['path'])
        directory_info = _safe_root_directory(parent_path)
        parent = os.open(parent_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            require(_same(directory_info, os.fstat(parent)), self.SESSION_UNKNOWN)
            name = os.path.basename(self.session['path'])
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(self.session_before is not None and _same(self.session_before, before) and
                    stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0 and
                    stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1,
                    self.SESSION_UNKNOWN)
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                require(_same(before, os.fstat(fd)) and
                        _same(before, os.stat(name, dir_fd=parent, follow_symlinks=False)),
                        self.SESSION_CHANGED)
                # A root-only directory plus this second inode comparison confines unlink.
                os.unlink(name, dir_fd=parent)
                require(os.fstat(fd).st_nlink == 0, self.SESSION_CHANGED)
            finally:
                os.close(fd)
            os.fsync(parent)
            self.session.update({'removed': True,
                                 'removedAt': _publisher_utc()})
            self._session_absent()
            return self.session['removedAt']
        finally:
            os.close(parent)

    def _validate_published(self, value):
        identity = self.request
        require(type(value) is dict and set(value) == {
            'status', 'releaseAttemptId', 'snapshotRunId', 'publicationDigest',
            'objects', 'writer', 'publishedAt'} and value['status'] == 'PUBLISHED' and
            value['releaseAttemptId'] == identity['releaseAttemptId'] and
            value['snapshotRunId'] == identity['snapshotRunId'] and
            type(value['publicationDigest']) is str and
            re.fullmatch(r'sha256:[a-f0-9]{64}', value['publicationDigest']) and
            type(value['objects']) is list and len(value['objects']) == 5 and
            type(value['writer']) is dict and set(value['writer']) == {
                'arn', 'issuedAt', 'expiresAt'}, 'PUBLISH_RESULT_INVALID')
        writer = value['writer']
        require(type(writer['arn']) is str and
                writer['arn'].replace(':role/', ':assumed-role/') == (
                'acs:ram::1457643390906675:assumed-role/'
                'subscription-saas-stage1-snapshot-publisher/stage1-publisher-' +
                identity['snapshotRunId'] + '-attempt-1'), 'PUBLISH_RESULT_INVALID')
        issued, expires = _publisher_time(writer['issuedAt']), _publisher_time(writer['expiresAt'])
        published = _publisher_time(value['publishedAt'])
        require(0 < expires - issued <= 900 and issued <= published < expires,
                'PUBLISH_RESULT_INVALID')
        prefix = ('snapshot-slots/v2/' + identity['releaseAttemptId'] + '/' +
                  identity['snapshotRunId'] + '/')
        names = ['snapshot.enc', 'encryption-envelope.json', 'snapshot-proof.json',
                 'data-result.json', 'diagnostics.redacted.json']
        for item, name in zip(value['objects'], names):
            require(type(item) is dict and set(item) == {
                'key', 'digest', 'sizeBytes', 'requestId', 'etag', 'putObservation'} and
                item['key'] == prefix + name and type(item['digest']) is str and
                re.fullmatch(r'sha256:[a-f0-9]{64}', item['digest']) and
                type(item['sizeBytes']) is int and item['sizeBytes'] > 0 and
                type(item['requestId']) is str and 0 < len(item['requestId']) <= 2048 and
                (item['etag'] is None or type(item['etag']) is str) and
                type(item['putObservation']) is dict, 'PUBLISH_RESULT_INVALID')
        require(value['objects'][-1]['digest'] == value['publicationDigest'],
                'PUBLISH_RESULT_INVALID')
        return expires - issued

    def _wait_expiry(self, writer, started_mono):
        issued, expires = _publisher_time(writer['issuedAt']), _publisher_time(writer['expiresAt'])
        ttl = expires - issued
        deadline = started_mono + ttl + 30
        while True:
            now_mono, now_wall = time.monotonic(), time.time()
            require(now_mono <= deadline, self.EXPIRY_UNKNOWN)
            if now_mono - started_mono >= ttl and now_wall >= expires:
                return _publisher_utc(now_wall)
            time.sleep(min(5, max(0.01, max(started_mono + ttl - now_mono,
                                             expires - now_wall)),
                           max(0.01, deadline - now_mono)))

    def _write_record(self, name, value):
        raw = canonical(value)
        require(len(raw) <= 4194304, 'PUBLISH_RESULT_INVALID')
        pending = self.spool + '/' + name + '.pending'
        final = self.spool + '/' + name
        fd = os.open(pending,
                     os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            _publisher_write(fd, raw)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.link(pending, final)
        parent = os.open(self.spool, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.unlink(pending)
            os.fsync(parent)
        finally: os.close(parent)
        return digest(raw)

    def run(self):
        self._lock()  # A retained lock forbids unknown PUT retry for this attempt.
        try:
            return self._run_locked()
        finally:
            if self.global_lock is not None:
                os.close(self.global_lock)
                self.global_lock = None

    def seal_destruction(self):
        # Separate signing only: never invoke the terminated publisher again.
        _safe_root_directory(OUTPUT, 0o700)
        _safe_root_directory(self.spool, 0o700)
        terminal = self._authority('seal-destruction', {
            'releaseAttemptId': self.request['releaseAttemptId'],
            'snapshotRunId': self.request['snapshotRunId']})
        require(type(terminal) is dict and set(terminal) == {
            'destructionProof', 'publisherUseProof'}, 'DESTRUCTION_RESULT_INVALID')
        sealed = terminal['destructionProof']
        use = terminal['publisherUseProof']
        require(type(sealed) is dict and set(sealed) == {
            'receipt', 'signature', 'dataResultDigest', 'cryptoUseProofDigest',
            'publicationDigest', 'publisherTerminalDigest'} and
            type(sealed['receipt']) is dict and
            sealed['receipt'].get('releaseAttemptId') == self.request['releaseAttemptId'] and
            sealed['receipt'].get('snapshotRunId') == self.request['snapshotRunId'],
            'DESTRUCTION_RESULT_INVALID')
        require(type(use) is dict and set(use) == {'proof', 'signature'} and
            type(use['proof']) is dict and
            use['proof'].get('releaseAttemptId') == self.request['releaseAttemptId'] and
            use['proof'].get('snapshotRunId') == self.request['snapshotRunId'] and
            all(use['proof'].get(name) == sealed[name] for name in (
                'dataResultDigest', 'cryptoUseProofDigest', 'publicationDigest',
                'publisherTerminalDigest')), 'DESTRUCTION_RESULT_INVALID')
        proof_digest = self._write_record('snapshot-destruction-proof.json', sealed)
        publisher_digest = self._write_record('publisher-use-proof.json', use)
        receipt_digest = self._write_record('snapshot-destruction-receipt.json', sealed['receipt'])
        return {'status': 'DESTRUCTION_SEALED', 'releaseAttemptId': self.request['releaseAttemptId'],
                'snapshotRunId': self.request['snapshotRunId'],
                'proofDigest': proof_digest, 'publisherUseArchiveDigest': publisher_digest,
                'publisherUseProofDigest': digest(canonical(use['proof'])),
                'receiptDigest': receipt_digest}

    def _run_locked(self):
        published = None
        error_code = None
        started_mono = time.monotonic()
        try:
            self._observe_session()
            self.authority['startedAt'] = _publisher_utc()
            published = self._authority('publish', {
                'releaseAttemptId': self.request['releaseAttemptId'],
                'snapshotRunId': self.request['snapshotRunId']})
            self.authority.update({'finishedAt': _publisher_utc(), 'exited': True, 'exitCode': 0})
            self._validate_published(published)
        except BaseException as error:
            error_code = str(error) if re.fullmatch(r'H1_ATTEMPT_[A-Z0-9_]{1,100}', str(error)) else \
                'H1_ATTEMPT_PUBLISH_OUTCOME_UNKNOWN'
            self.authority['finishedAt'] = _publisher_utc()
        try:
            self._remove_session()
        except BaseException:
            error_code = 'H1_ATTEMPT_PUBLISH_SESSION_UNKNOWN'
        if error_code is None:
            try:
                self.session['expiresAt'] = published['writer']['expiresAt']
                self.session['observedAt'] = self._wait_expiry(published['writer'], started_mono)
                self._session_absent()
                require(_publisher_time(published['publishedAt']) <=
                        _publisher_time(self.authority['finishedAt']) <=
                        _publisher_time(self.session['removedAt']) <=
                        _publisher_time(self.session['observedAt']), 'PUBLISH_ORDER_INVALID')
                record = {'status': 'PUBLISHER_TERMINAL_OBSERVED',
                          'releaseAttemptId': self.request['releaseAttemptId'],
                          'snapshotRunId': self.request['snapshotRunId'],
                          'publicationDigest': published['publicationDigest'],
                          'objects': published['objects'], 'writer': published['writer'],
                          'publishedAt': published['publishedAt'],
                          'authority': self.authority, 'publisherSession': self.session}
                observed = self._write_record('publisher-terminal.json', record)
                return {'status': 'PUBLISHER_TERMINAL_OBSERVED',
                        'releaseAttemptId': self.request['releaseAttemptId'],
                        'snapshotRunId': self.request['snapshotRunId'],
                        'observationDigest': observed}
            except BaseException as error:
                error_code = str(error) if re.fullmatch(r'H1_ATTEMPT_[A-Z0-9_]{1,100}', str(error)) else \
                    'H1_ATTEMPT_PUBLISH_OUTCOME_UNKNOWN'
        failure = {'status': 'PUBLISHER_OUTCOME_UNKNOWN',
                   'releaseAttemptId': self.request['releaseAttemptId'],
                   'snapshotRunId': self.request['snapshotRunId'],
                   'errorCode': error_code, 'authority': self.authority,
                   'publisherSession': self.session}
        self._write_record('publisher-failure.json', failure)
        raise RuntimeError(error_code)


class H1EvidenceArchiveOperation(H1SnapshotPublisher):
    """Observe one fixed archive child, session disposal, and full expiry."""
    LOCK_NAME = 'archive.lock'
    SESSION_UNKNOWN = 'ARCHIVE_SESSION_UNKNOWN'
    SESSION_CHANGED = 'ARCHIVE_SESSION_CHANGED'
    EXPIRY_UNKNOWN = 'ARCHIVE_EXPIRY_UNKNOWN'

    def __init__(self, request):
        require(type(request) is dict and set(request) == {
            'operation', 'authorizationDigest'} and
            request['operation'] in ('archive-write', 'archive-read') and
            type(request['authorizationDigest']) is str and
            re.fullmatch(r'sha256:[a-f0-9]{64}', request['authorizationDigest']),
            'INPUT_INVALID')
        self.request = copy.deepcopy(request)
        self.operation = request['operation']
        self.profile = ('archive-create-only-writer' if self.operation == 'archive-write'
                        else 'archive-readback-reader')
        session_path = (ARCHIVE_WRITER_SESSION if self.operation == 'archive-write'
                        else ARCHIVE_READER_SESSION)
        self._init_process(ARCHIVE_OUTPUT + '/' + request['authorizationDigest'][7:],
                           session_path)

    def _ensure_spool(self):
        # Both operations share the publisher mutex. The archive root and
        # digest spool are fixed, private, and never supplied as paths by a caller.
        _safe_root_directory(OUTPUT, 0o700)
        _safe_root_directory(os.path.dirname(ARCHIVE_OUTPUT))
        if not os.path.lexists(ARCHIVE_OUTPUT):
            os.mkdir(ARCHIVE_OUTPUT, 0o700)
        _safe_root_directory(ARCHIVE_OUTPUT, 0o700)
        if not os.path.lexists(self.spool):
            os.mkdir(self.spool, 0o700)
        _safe_root_directory(self.spool, 0o700)

    def _lock_payload(self):
        return self.request

    def seal_access(self):
        _safe_root_directory(ARCHIVE_OUTPUT, 0o700)
        _safe_root_directory(self.spool, 0o700)
        sealed = self._authority(self.operation.replace('archive-', 'archive-seal-'), {
            'authorizationDigest': self.request['authorizationDigest']})
        require(type(sealed) is dict and set(sealed) == {
            'status', 'authorizationDigest', 'profile', 'proofDigest', 'receiptDigest'} and
            sealed['status'] == 'ARCHIVE_ACCESS_SEALED' and
            sealed['authorizationDigest'] == self.request['authorizationDigest'] and
            sealed['profile'] == self.profile and all(
                type(sealed[name]) is str and re.fullmatch(r'sha256:[a-f0-9]{64}', sealed[name])
                for name in ('proofDigest', 'receiptDigest')), 'ARCHIVE_RESULT_INVALID')
        return sealed

    @staticmethod
    def _time(value):
        try:
            return _publisher_time(value)
        except BaseException:
            raise RuntimeError('H1_ATTEMPT_ARCHIVE_RESULT_INVALID')

    def _validate_io(self, value):
        require(type(value) is dict and set(value) == {
            'status', 'authorizationDigest', 'profile', 'operationId',
            'session', 'ioDigest', 'observedAt'} and
            value['status'] == 'ARCHIVE_IO_OBSERVED' and
            value['authorizationDigest'] == self.request['authorizationDigest'] and
            value['profile'] == self.profile and
            type(value['operationId']) is str and 0 < len(value['operationId']) <= 256 and
            type(value['ioDigest']) is str and
            re.fullmatch(r'sha256:[a-f0-9]{64}', value['ioDigest']) and
            type(value['session']) is dict and set(value['session']) == {
                'arn', 'issuedAt', 'expiresAt', 'fingerprint'},
            'ARCHIVE_RESULT_INVALID')
        session = value['session']
        role = ('subscription-saas-stage1-archive-writer' if self.operation == 'archive-write'
                else 'subscription-saas-stage1-archive-reader')
        require(type(session['arn']) is str and re.fullmatch(
            r'acs:ram::1457643390906675:(?:role|assumed-role)/' + role +
            r'/[A-Za-z0-9_-]{1,64}', session['arn']) and
            type(session['fingerprint']) is str and
            re.fullmatch(r'sha256:[a-f0-9]{64}', session['fingerprint']),
            'ARCHIVE_RESULT_INVALID')
        issued = self._time(session['issuedAt'])
        expires = self._time(session['expiresAt'])
        observed = self._time(value['observedAt'])
        started = self._time(self.authority['startedAt'])
        finished = self._time(self.authority['finishedAt'])
        require(0 < expires - issued <= 900 and
                issued <= started <= observed <= finished and observed < expires,
                'ARCHIVE_RESULT_INVALID')
        _safe_root_directory(self.spool, 0o700)
        require('sha256:' + _file(self.spool + '/archive-io.json', 0o600,
                                  8388608, hash_only=True) == value['ioDigest'],
                'ARCHIVE_IO_CHANGED')

    def _run_locked(self):
        observed = None
        error_code = None
        started_mono = time.monotonic()
        try:
            self._observe_session()
            self.authority['startedAt'] = _publisher_utc()
            observed = self._authority(self.operation, {
                'authorizationDigest': self.request['authorizationDigest']})
            self.authority.update({'finishedAt': _publisher_utc(), 'exited': True,
                                   'exitCode': 0})
            self._validate_io(observed)
        except BaseException as error:
            error_code = (str(error) if re.fullmatch(r'H1_ATTEMPT_[A-Z0-9_]{1,100}', str(error))
                          else 'H1_ATTEMPT_ARCHIVE_OUTCOME_UNKNOWN')
            self.authority['finishedAt'] = _publisher_utc()
        try:
            self._remove_session()
        except BaseException:
            error_code = 'H1_ATTEMPT_ARCHIVE_SESSION_UNKNOWN'
        if error_code is None:
            try:
                self.session['expiresAt'] = observed['session']['expiresAt']
                self.session['observedAt'] = self._wait_expiry(observed['session'], started_mono)
                self._session_absent()
                require(self.session['removed'] and self.session['absent'] and
                        self._time(self.authority['finishedAt']) <=
                        self._time(self.session['removedAt']) <=
                        self._time(self.session['observedAt']), 'ARCHIVE_ORDER_INVALID')
                record = {'status': 'ARCHIVE_TERMINAL_OBSERVED',
                          'authorizationDigest': self.request['authorizationDigest'],
                          'profile': self.profile, 'operationId': observed['operationId'],
                          'ioDigest': observed['ioDigest'], 'session': observed['session'],
                          'ioObservedAt': observed['observedAt'],
                          'authority': self.authority, 'sessionDisposal': self.session}
                terminal_digest = self._write_record('archive-terminal.json', record)
                return {'status': 'ARCHIVE_TERMINAL_OBSERVED',
                        'authorizationDigest': self.request['authorizationDigest'],
                        'profile': self.profile, 'observationDigest': terminal_digest}
            except BaseException as error:
                error_code = (str(error) if re.fullmatch(r'H1_ATTEMPT_[A-Z0-9_]{1,100}', str(error))
                              else 'H1_ATTEMPT_ARCHIVE_OUTCOME_UNKNOWN')
        failure = {'status': 'ARCHIVE_OUTCOME_UNKNOWN',
                   'authorizationDigest': self.request['authorizationDigest'],
                   'profile': self.profile, 'errorCode': error_code,
                   'authority': self.authority, 'sessionDisposal': self.session}
        self._write_record('archive-failure.json', failure)
        raise RuntimeError(error_code)


def main():
    require(len(sys.argv) == 1 and os.name == 'posix' and os.geteuid() == 0, 'ROOT_REQUIRED')
    require(os.path.abspath(__file__) == CONTROL + '/snapshot-h1-attempt.py', 'ENTRY_INVALID')
    os.umask(0o077);sys.dont_write_bytecode = True
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    require(ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) == 0, 'MEMORY_UNSAFE')
    raw = sys.stdin.buffer.read(16385)
    require(len(raw) <= 16384, 'INPUT_INVALID')
    request = json.loads(raw.decode('utf8'), object_pairs_hook=pairs)
    require(raw == canonical(request), 'INPUT_INVALID')
    if type(request) is dict and request.get('operation') in ('publish', 'seal-destruction'):
        operation = request['operation']
        publisher = H1SnapshotPublisher(dict(request, operation='publish'))
        result = publisher.run() if operation == 'publish' else publisher.seal_destruction()
    elif type(request) is dict and request.get('operation') in (
            'archive-write', 'archive-read', 'archive-seal-write', 'archive-seal-read'):
        seal = request['operation'].startswith('archive-seal-')
        archive = H1EvidenceArchiveOperation(dict(request,
            operation=request['operation'].replace('archive-seal-', 'archive-')))
        result = archive.seal_access() if seal else archive.run()
    else:
        result = H1SnapshotAttempt(request).run()
    sys.stdout.write(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    try: main()
    except BaseException as error:
        code = str(error)
        sys.stderr.write((code if re.fullmatch(r'H1_[A-Z0-9_]{1,100}', code) else
                          'H1_ATTEMPT_FAILED_OR_CLEANUP_UNKNOWN') + '\n');sys.exit(1)
