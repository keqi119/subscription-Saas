"""Fixed root H1 data attempt. No job-controlled commands, paths or credentials.

The approved parent opens the existing key volume with swap/core protections
before invoking this entry. A successful result is encrypted DATA_PREPARED,
not publication/custody/Stage1 completion. No plaintext leaves the attempt LUKS.
"""
import copy
import ctypes
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
MODULES = ('snapshot-h1-github.py', 'snapshot-h1-route-journal.py',
           'snapshot-h1-volume.py', 'snapshot-h1-runner.py',
           'snapshot-h1-control.py', 'snapshot-h1-producer.py')
ENTRIES = ('snapshot-h1-container-hook.js', 'snapshot-h1-job-client.mjs',
           'snapshot-h1-runner-entry.mjs')
READ_ONLY = {'snapshot-h1-volume.py', 'snapshot-h1-runner.py',
             'snapshot-h1-producer.py', 'snapshot-h1-runner-entry.mjs'}
WORKER = 'sha256:128ace637be59ff23e221f9824a732c5d7952dd2a7ba4adb494d25e54cfc53fc'


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
    sys.stdout.write(json.dumps(H1SnapshotAttempt(request).run(), separators=(',', ':')))


if __name__ == '__main__':
    try: main()
    except BaseException as error:
        code = str(error)
        sys.stderr.write((code if re.fullmatch(r'H1_[A-Z0-9_]{1,100}', code) else
                          'H1_ATTEMPT_FAILED_OR_CLEANUP_UNKNOWN') + '\n');sys.exit(1)
