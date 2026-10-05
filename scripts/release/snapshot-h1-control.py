"""Root-only H1 job boundary. No CLI, general command RPC, or admission fallback.

The trusted root orchestrator supplies fresh admission verification and private
producer/cleanup callbacks. Importing this module does not authorize or start a
production attempt. The Actions job can send only its opaque admission reference.
"""
import hashlib
import hmac
import json
import os
import posixpath
import re
import socket
import stat
import struct
import subprocess
import threading
import time

ROOT = '/run/stage1-snapshot'
NODE = '/opt/subscription-saas/snapshot-adapter/v2/runtime/node'
NODE_SHA = 'fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48'
CODE = '/opt/subscription-saas/snapshot-adapter/v2/control'
IMAGE = 'postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0'
CLIENTS = ('snapshot-h1-container-hook.js', 'snapshot-h1-job-client.mjs')
REJECTED = {'status': 'FAILED', 'code': 'H1_CONTROL_REJECTED'}


def require(value):
    if not value:
        raise RuntimeError('H1_CONTROL_REJECTED')


def frame(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


class H1SnapshotControl:
    """One attempt, two kernel-authenticated local channels, one producer call."""
    def __init__(self, admission_ref, runner_root, operations):
        require(isinstance(admission_ref, str) and re.fullmatch(r'sha256:[0-9a-f]{64}', admission_ref))
        require(isinstance(runner_root, str) and runner_root.startswith('/')
                and posixpath.normpath(runner_root) == runner_root)
        for name in ('verify_admission', 'prepare_job', 'run_job', 'verify_job_peer',
                     'produce', 'cleanup_job'):
            require(callable(getattr(operations, name, None)))
        self.reference, self.runner_root, self.operations = admission_ref, runner_root, operations
        self.phase = 'NEW'
        self.producer_started = self.producer_done = self.cleanup_started = False
        self.active_operations = 0
        self.condition = threading.Condition()
        self.stopping = threading.Event()
        self.listeners, self.threads, self.owned = [], [], []
        self.accepted_count = 0
        # Running hook + producer request + cancellation/cleanup must fit together.
        self.capacity = threading.BoundedSemaphore(3)

    def _call(self, name, *args):
        require(getattr(self.operations, name)(*args) is True)

    def _begin(self, expected, new_phase):
        with self.condition:
            require(self.phase == expected)
            self.phase = new_phase
            self.active_operations += 1

    def _end(self, new_phase=None):
        with self.condition:
            self.active_operations -= 1
            if self.phase != 'CLEANING' and new_phase is not None:
                self.phase = new_phase
            self.condition.notify_all()

    def _cleanup(self):
        with self.condition:
            require(not self.cleanup_started)
            self.cleanup_started = True
            self.phase = 'CLEANING'
        ok = False
        try:
            self._call('cleanup_job')
            deadline = time.monotonic() + 15
            with self.condition:
                while self.active_operations:
                    remaining = deadline - time.monotonic()
                    require(remaining > 0)
                    self.condition.wait(remaining)
                ok = True
        finally:
            with self.condition:
                self.phase = 'CLEANED' if ok else 'FAILED'
                self.condition.notify_all()
        return 'CLEANED'

    def _management(self, command):
        if command == 'cleanup_job':
            return self._cleanup()
        expected, pending, finished = {
            'prepare_job': ('NEW', 'PREPARING', 'PREPARED'),
            'run_script_step': ('PREPARED', 'RUNNING', 'FINISHED')
        }[command]
        self._begin(expected, pending)
        ok = False
        try:
            self._call('verify_admission')
            self._call('prepare_job' if command == 'prepare_job' else 'run_job')
            with self.condition:
                require(self.phase == pending)
                if command == 'run_script_step':
                    require(self.producer_done)
            ok = True
            return 'PREPARED' if command == 'prepare_job' else 'SUCCEEDED'
        finally:
            self._end(finished if ok else 'FAILED')

    def _produce(self, peer):
        with self.condition:
            require(self.phase == 'RUNNING' and not self.producer_started)
            self.producer_started = True
            self.active_operations += 1
        ok = False
        try:
            self._call('verify_job_peer', peer)
            self._call('verify_admission')
            self._call('produce')
            with self.condition:
                require(self.phase == 'RUNNING')
                self.producer_done = True
            ok = True
            return 'SUCCEEDED'
        finally:
            self._end(None if ok else 'FAILED')

    def handle(self, kind, peer, packet):
        """Private dispatcher; live peer tuple always comes from SO_PEERCRED."""
        try:
            require(kind in ('management', 'job') and isinstance(peer, tuple) and len(peer) == 3)
            require(type(peer[0]) is int and peer[0] > 0)
            require(peer[1:] == ((992, 988) if kind == 'management' else (65533, 65533)))
            require(type(packet) is dict and set(packet) == {'command', 'admissionRef'})
            require(type(packet['admissionRef']) is str
                    and hmac.compare_digest(packet['admissionRef'], self.reference))
            commands = ('prepare_job', 'run_script_step', 'cleanup_job') if kind == 'management' else ('produce',)
            require(packet['command'] in commands)
            status = self._management(packet['command']) if kind == 'management' else self._produce(peer)
            reply = {'status': status, 'admissionRef': self.reference}
            if kind == 'management':
                reply['runnerRoot'] = self.runner_root
            return reply
        except Exception:
            return dict(REJECTED)

    def _connection(self, kind, connection):
        try:
            peer = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            require(peer[1:] == ((992, 988) if kind == 'management' else (65533, 65533)))
            deadline, payload = time.monotonic() + 3, bytearray()
            while True:
                connection.settimeout(max(0.001, deadline - time.monotonic()))
                require(time.monotonic() < deadline)
                chunk = connection.recv(513 - len(payload))
                if not chunk:
                    break
                payload.extend(chunk)
                require(len(payload) <= 512)
            packet = json.loads(bytes(payload).decode('utf-8'), object_pairs_hook=frame)
            reply = self.handle(kind, peer, packet)
        except Exception:
            reply = dict(REJECTED)
        try:
            connection.settimeout(3)
            connection.sendall(json.dumps(reply, separators=(',', ':')).encode('ascii'))
        except OSError:
            pass
        finally:
            connection.close()
            self.capacity.release()

    def _listen(self, kind, listener):
        while not self.stopping.is_set():
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with self.condition:
                allowed = self.accepted_count < 16
                if allowed:
                    self.accepted_count += 1
            if not allowed:
                connection.close()
                continue
            if not self.capacity.acquire(False):
                connection.close()
                continue
            thread = threading.Thread(target=self._connection, args=(kind, connection), daemon=True)
            self.threads.append(thread)
            thread.start()

    def _owned(self, path):
        info = os.lstat(path)
        self.owned.append((path, info.st_dev, info.st_ino))

    def start(self):
        require(os.name == 'posix' and os.geteuid() == 0 and hasattr(socket, 'SO_PEERCRED'))
        require(not self.owned and self.phase == 'NEW')
        require(os.path.realpath('/run') == '/run' and os.stat('/run').st_uid == 0)
        require(os.path.realpath(self.runner_root) == self.runner_root)
        require(os.path.isdir(self.runner_root) and os.stat(self.runner_root).st_uid == 992)
        try:
            os.mkdir(ROOT, 0o755)
            os.chmod(ROOT, 0o755)
            self._owned(ROOT)
            for kind, gid, name in [('management', 988, 'control.sock'), ('job', 65533, 'request.sock')]:
                directory = ROOT + '/' + kind
                os.mkdir(directory, 0o750)
                os.chown(directory, 0, gid)
                os.chmod(directory, 0o750)
                self._owned(directory)
                path = directory + '/' + name
                listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.listeners.append(listener)
                listener.bind(path)
                self._owned(path)
                os.chown(path, 0, gid)
                os.chmod(path, 0o660)
                listener.listen(2)
                listener.settimeout(0.5)
                thread = threading.Thread(target=self._listen, args=(kind, listener), daemon=True)
                self.threads.append(thread)
                thread.start()
        except Exception:
            if self.owned:
                self.close()
            raise
        return self

    def close(self):
        self.stopping.set()
        for listener in self.listeners:
            listener.close()
        try:
            if not self.cleanup_started:
                self._cleanup()
        except Exception:
            pass
        deadline = time.monotonic() + 16
        for thread in list(self.threads):
            thread.join(max(0, deadline - time.monotonic()))
        ok = self.phase == 'CLEANED' and not any(thread.is_alive() for thread in self.threads)
        for path, device, inode in reversed(self.owned):
            try:
                info = os.lstat(path)
                require((info.st_dev, info.st_ino, info.st_uid) == (device, inode, 0))
                os.rmdir(path) if stat.S_ISDIR(info.st_mode) else os.unlink(path)
            except (OSError, RuntimeError):
                ok = False
        self.owned = []
        return ok


class H1FixedJobContainer:
    """Fixed Docker operations owned by root; no parameters originate in the job."""
    def __init__(self, admission_ref, client_digests, verify_admission, produce, cleanup_producer):
        require(os.name == 'posix' and os.geteuid() == 0)
        require(isinstance(admission_ref, str) and re.fullmatch(r'sha256:[0-9a-f]{64}', admission_ref))
        require(set(client_digests) == set(CLIENTS))
        for callback in (verify_admission, produce, cleanup_producer):
            require(callable(callback))
        for filename, digest in [(NODE, NODE_SHA)] + [(CODE + '/' + name, client_digests[name]) for name in CLIENTS]:
            require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest))
            require(os.path.realpath(filename) == filename)
            info = os.lstat(filename)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
                    and info.st_nlink == 1 and info.st_mode & 0o022 == 0)
            with open(filename, 'rb') as stream:
                actual = hashlib.sha256(stream.read()).hexdigest()
            require(actual == digest)
        self.reference = admission_ref
        self.name = 'stage1-snapshot-job-' + admission_ref[-32:]
        self.container_id = None
        self.creation_attempted = False
        self._verify, self._produce, self._cleanup_producer = verify_admission, produce, cleanup_producer

    def _docker(self, args, timeout=30):
        return subprocess.run(['/usr/bin/docker'] + args, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout)

    def _inspect(self, identity):
        result = self._docker(['container', 'inspect', identity])
        if result.returncode != 0:
            require(b'No such container' in result.stderr or b'No such object' in result.stderr)
            return None
        records = json.loads(result.stdout)
        require(len(records) == 1)
        return records[0]

    def _owned_container(self):
        # A matching name/label is not proof that this root invocation created it.
        require(self.container_id is not None)
        record = self._inspect(self.container_id)
        if record is None:
            return None
        require(record['Name'] == '/' + self.name and record['Config']['Image'] == IMAGE)
        require(record['Config']['Labels'].get('stage1.admission') == self.reference)
        require(record['Config']['User'] == '65533:65533')
        require(re.fullmatch('[0-9a-f]{64}', record['Id']))
        require(record['Id'] == self.container_id)
        return record

    def verify_admission(self):
        return self._verify() is True

    def prepare_job(self):
        require(not self.creation_attempted and self._inspect(self.name) is None)
        mounts = [
            'type=bind,source=' + NODE + ',target=/entry/node,readonly',
            'type=bind,source=' + ROOT + '/job,target=' + ROOT + '/job,readonly'
        ] + ['type=bind,source=' + CODE + '/' + name + ',target=/entry/' + name + ',readonly' for name in CLIENTS]
        args = ['create', '--name', self.name, '--label', 'stage1.admission=' + self.reference,
                '--user', '65533:65533', '--read-only', '--network', 'none', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--memory', '128m', '--memory-swap', '128m',
                '--pids-limit', '32', '--ulimit', 'core=0:0',
                '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=4m,mode=1777',
                # The fixed PostgreSQL tools image declares this VOLUME. Cover it
                # explicitly so a job cannot acquire an anonymous disk-backed volume.
                '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=64k,mode=000']
        for mount in mounts:
            args.extend(['--mount', mount])
        args.extend(['--entrypoint', '/entry/node', IMAGE, '/entry/snapshot-h1-job-client.mjs',
                     '--admission-ref', self.reference])
        self.creation_attempted = True
        result = self._docker(args)
        require(result.returncode == 0)
        require(re.fullmatch('[0-9a-f]{64}', result.stdout.decode('ascii').strip()))
        self.container_id = result.stdout.decode('ascii').strip()
        record = self._owned_container()
        require(record is not None and record['State']['Status'] == 'created')
        return True

    def verify_job_peer(self, peer):
        record = self._owned_container()
        require(record is not None and record['State']['Running'] and peer[1:] == (65533, 65533))
        pid = record['State']['Pid']
        require(type(pid) is int and pid > 0)
        for namespace in ('pid', 'mnt', 'net'):
            require(os.readlink('/proc/{}/ns/{}'.format(pid, namespace)) ==
                    os.readlink('/proc/{}/ns/{}'.format(peer[0], namespace)))
            require(os.readlink('/proc/{}/ns/{}'.format(pid, namespace)) !=
                    os.readlink('/proc/self/ns/' + namespace))
        return True

    def produce(self):
        return self._produce() is True

    def run_job(self):
        record = self._owned_container()
        require(record is not None and record['State']['Status'] == 'created')
        result = self._docker(['start', '--attach', self.container_id], timeout=900)
        record = self._owned_container()
        require(record is not None and record['State']['Status'] == 'exited')
        require(result.returncode == 0 and record['State']['ExitCode'] == 0
                and not record['State']['OOMKilled'] and len(result.stdout) <= 4096 and not result.stderr)
        return True

    def cleanup_job(self):
        # Invoke both cleanup paths even when either one fails; never claim CLEANED
        # until the root producer cleanup and exact container absence are confirmed.
        ok = True
        try:
            require(self._cleanup_producer() is True)
        except Exception:
            ok = False
        try:
            if self.creation_attempted:
                record = self._owned_container()
                if record is not None:
                    result = self._docker(['rm', '--force', '--volumes', self.container_id])
                    require(result.returncode == 0)
                    require(self._inspect(self.container_id) is None)
        except Exception:
            ok = False
        return ok
