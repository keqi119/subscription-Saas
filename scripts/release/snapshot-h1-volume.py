"""Private root lifecycle for one approved H1 attempt's 1 GiB LUKS volume.

No CLI, caller-selected paths or admission assertion. The trusted parent must
stop all attempt consumers before cleanup. A failed cleanup keeps protections
and the exclusive lock; it never reports destruction from intent alone.
"""
import json
import os
import re
import stat
import subprocess
try:
    import fcntl
    import resource
except ImportError:  # Windows may import unit tests, never operate the host.
    fcntl = resource = None

ROOT = '/var/lib/subscription-saas/snapshot-volumes'
CORE = '/proc/sys/kernel/core_pattern'
CAPACITY = 1073741824
SWAPS = (('/www/swap', -2), ('/swapfile-stage9', -3))


class VolumeFailure(Exception):
    """Non-secret fixed error codes only."""


def require(value, code):
    if not value:
        raise VolumeFailure('H1_VOLUME_' + code)


def _run(argv, data=None, allowed=(0,)):
    try:
        result = subprocess.run(argv, input=data, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=90, cwd='/',
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
        require(result.returncode in allowed and len(result.stdout) < 65536 and
                len(result.stderr) < 65536, 'COMMAND_FAILED')
        return result
    except (OSError, subprocess.TimeoutExpired):
        raise VolumeFailure('H1_VOLUME_COMMAND_UNKNOWN') from None


def _swaps():
    with open('/proc/swaps', 'r') as source:
        rows = [line.split() for line in source.read(8192).splitlines()[1:]]
    require(all(len(row) == 5 for row in rows), 'SWAPS_INVALID')
    return [(row[0], int(row[4])) for row in rows]


def _memory():
    with open('/proc/meminfo', 'r') as source:
        values = {line.split(':')[0]: int(line.split()[1]) * 1024 for line in source}
    return values['MemAvailable'], values['SwapTotal'] - values['SwapFree']


def _core():
    with open(CORE, 'r') as source:
        return source.read(4096)


class H1SnapshotAttemptVolume:
    def __init__(self, attempt_id):
        require(type(attempt_id) is str and re.fullmatch(
            r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
            attempt_id) is not None, 'ATTEMPT_INVALID')
        self.attempt_id = attempt_id
        self.backing = ROOT + '/' + attempt_id + '.luks'
        self.mount = ROOT + '/' + attempt_id + '.mnt'
        self.mapper = 'subscription-s1-' + attempt_id
        self.device = '/dev/mapper/' + self.mapper
        self.observation = {'attemptId': attempt_id, 'capacityBytes': CAPACITY}
        self._owned = None
        self._mount_owned = None
        self._key = None
        self._lock = None
        self._original_core = None
        self._original_swaps = None
        self._stopped = []
        self._started = False
        self._ready = False
        self._cleaned = False

    def _acquire_lock(self):
        require(os.name == 'posix' and fcntl is not None and resource is not None and
                os.geteuid() == 0, 'ROOT_REQUIRED')
        parent = os.lstat(ROOT)
        require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == parent.st_gid == 0 and
                stat.S_IMODE(parent.st_mode) == 0o700 and os.path.realpath(ROOT) == ROOT,
                'ROOT_INVALID')
        fd = os.open(ROOT + '/.attempt.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and
                    info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600,
                    'LOCK_INVALID')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            os.close(fd)
            raise VolumeFailure('H1_VOLUME_LOCK_UNAVAILABLE') from None
        self._lock = fd
        # An interrupted attempt is never silently adopted or deleted.
        require(set(os.listdir(ROOT)) == {'.attempt.lock'}, 'ORPHAN_OR_ACTIVE_ATTEMPT')
        require(not os.path.lexists(self.device), 'NAME_IN_USE')

    def _release_lock(self):
        if self._lock is not None:
            os.close(self._lock)
            self._lock = None

    def _same_backing(self):
        info = os.lstat(self.backing)
        require(self._owned == (info.st_dev, info.st_ino) and stat.S_ISREG(info.st_mode) and
                info.st_nlink == 1 and info.st_uid == info.st_gid == 0 and
                stat.S_IMODE(info.st_mode) == 0o600 and
                os.path.realpath(self.backing) == self.backing, 'BACKING_CHANGED')

    def _keyslots(self):
        # cryptsetup 2.3.7 does not support --dump-json-metadata on this host.
        raw = _run(['cryptsetup', 'luksDump', self.backing]).stdout.decode('ascii')
        require(re.search(r'^Version:\s+2$', raw, re.M) is not None and
                raw.count('\nKeyslots:\n') == raw.count('\nTokens:\n') == 1,
                'HEADER_INVALID')
        block = raw.split('\nKeyslots:\n', 1)[1].split('Tokens:\n', 1)[0]
        entries = re.findall(r'^  ([0-9]+): (\S+)\s*$', block, re.M)
        require(all(kind == 'luks2' for _, kind in entries) and
                (bool(entries) or not block.strip()), 'KEYSLOTS_UNKNOWN')
        return [slot for slot, _ in entries]

    def _verify_mapping(self):
        self._same_backing()
        raw = _run(['cryptsetup', 'status', self.mapper]).stdout.decode('ascii')
        require((self.device + ' is active') in raw and
                re.search(r'^\s*type:\s*LUKS2\s*$', raw, re.M) is not None,
                'MAPPER_CHANGED')
        match = re.search(r'^\s*device:\s*(/dev/loop[0-9]+)\s*$', raw, re.M)
        loops = _run(['losetup', '-j', self.backing]).stdout.decode('ascii').splitlines()
        require(match is not None and len(loops) == 1 and
                loops[0].startswith(match.group(1) + ':'), 'MAPPER_CHANGED')

    def assert_ready(self):
        require(self._ready and not self._cleaned and self._lock is not None,
                'NOT_READY')
        require(_swaps() == [] and _core().strip() == '|/bin/false' and
                resource.getrlimit(resource.RLIMIT_CORE) == (0, 0), 'PROTECTION_CHANGED')
        self._verify_mapping()
        raw = _run(['findmnt', '-J', '--mountpoint', self.mount,
                    '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS']).stdout
        rows = json.loads(raw.decode('utf-8')).get('filesystems')
        require(type(rows) is list and len(rows) == 1, 'MOUNT_CHANGED')
        row = rows[0]
        require(row.get('target') == self.mount and row.get('source') == self.device and
                row.get('fstype') == 'ext4' and not row.get('children') and
                {'rw', 'nosuid', 'nodev', 'noexec'} <= set(row.get('options', '').split(',')),
                'MOUNT_CHANGED')
        info = os.lstat(self.mount)
        mapper = os.stat(self.device)
        require(stat.S_ISDIR(info.st_mode) and stat.S_ISBLK(mapper.st_mode) and
                info.st_dev == mapper.st_rdev and info.st_uid == info.st_gid == 0 and
                stat.S_IMODE(info.st_mode) == 0o700 and
                os.path.realpath(self.mount) == self.mount, 'MOUNT_CHANGED')
        return True

    def prepare(self):
        require(not self._started and not self._cleaned, 'ALREADY_USED')
        self._started = True
        try:
            self._acquire_lock()
            disk = os.statvfs(ROOT)
            require(disk.f_bavail * disk.f_frsize >= 3 * CAPACITY, 'DISK_CAPACITY')
            self._original_swaps = _swaps()
            require(self._original_swaps in ([], list(SWAPS)), 'SWAP_LAYOUT_CHANGED')
            available, used = _memory()
            require(available >= used + 384 * 1048576, 'SWAPOFF_CAPACITY')
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            self._original_core = _core()
            with open(CORE, 'w') as target:
                target.write('|/bin/false\n')
            require(_core().strip() == '|/bin/false', 'CORE_DISABLE_FAILED')
            for path, priority in self._original_swaps:
                self._stopped.append((path, priority))  # intent before possible timeout
                _run(['swapoff', path])
            require(_swaps() == [] and _memory()[0] >= 512 * 1048576, 'MEMORY_CAPACITY')
            self._key = bytearray(os.urandom(64))
            fd = os.open(self.backing, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                info = os.fstat(fd)
                self._owned = (info.st_dev, info.st_ino)
                os.posix_fallocate(fd, 0, CAPACITY)
                os.fsync(fd)
            finally:
                os.close(fd)
            _run(['cryptsetup', 'luksFormat', '--type', 'luks2', '--cipher', 'aes-xts-plain64',
                  '--key-size', '512', '--pbkdf', 'pbkdf2', '--pbkdf-force-iterations', '100000',
                  '--batch-mode', '--key-file', '-', self.backing], bytes(self._key))
            require(self._keyslots() == ['0'], 'KEYSLOT_SHAPE')
            luks_uuid = _run(['cryptsetup', 'luksUUID', self.backing]).stdout.decode('ascii').strip()
            require(re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', luks_uuid)
                    is not None, 'LUKS_UUID_INVALID')
            self.observation['luksUuid'] = luks_uuid
            _run(['cryptsetup', 'open', '--type', 'luks2', '--key-file', '-',
                  self.backing, self.mapper], bytes(self._key))
            self._verify_mapping()
            _run(['mkfs.ext4', '-q', '-F', self.device])
            os.mkdir(self.mount, 0o700)
            info = os.lstat(self.mount)
            self._mount_owned = (info.st_dev, info.st_ino)
            _run(['mount', '-t', 'ext4', '-o', 'rw,nodev,nosuid,noexec', self.device, self.mount])
            os.chmod(self.mount, 0o700)
            self._ready = True
            self.assert_ready()
            return self.mount
        except Exception:
            self.cleanup()  # preserve cleanup failure; don't claim restored on unknown
            raise

    def _destroy(self):
        if self._owned is None:
            return
        self._same_backing()
        if os.path.ismount(self.mount):
            self._verify_mapping()
            source = _run(['findmnt', '-n', '--mountpoint', self.mount, '-o', 'SOURCE']).stdout
            require(source.decode('ascii').strip() == self.device, 'MOUNT_CHANGED')
            # Never lazy/force unmount: busy consumers must be stopped by their owner.
            _run(['umount', self.mount])
        require(not os.path.ismount(self.mount), 'UNMOUNT_UNKNOWN')
        if os.path.lexists(self.device):
            self._verify_mapping()
            _run(['cryptsetup', 'close', self.mapper])
        require(not os.path.lexists(self.device), 'MAPPER_STILL_EXISTS')
        if _run(['cryptsetup', 'isLuks', self.backing], allowed=(0, 1)).returncode == 0:
            _run(['cryptsetup', 'luksErase', '--batch-mode', self.backing])
            require(self._keyslots() == [], 'KEYSLOTS_REMAIN')
            rejection = _run(['cryptsetup', 'open', '--type', 'luks2', '--test-passphrase',
                              '--key-file', '-', self.backing], bytes(self._key), allowed=(1,))
            require(rejection.stdout == b'' and rejection.stderr ==
                    b'Keyslot open failed.\nNo usable keyslot is available.\n', 'ERASE_UNKNOWN')
            self.observation.update({'keyslotsAfter': [], 'oldKeyRejected': True})
        require(not _run(['losetup', '-j', self.backing]).stdout.strip(), 'LOOP_REMAINS')
        self._same_backing()
        if self._mount_owned is not None:
            info = os.lstat(self.mount)
            require(self._mount_owned == (info.st_dev, info.st_ino) and
                    stat.S_ISDIR(info.st_mode), 'MOUNT_DIRECTORY_CHANGED')
            os.rmdir(self.mount)
            self._mount_owned = None
        os.unlink(self.backing)
        self._owned = None
        require(not os.path.lexists(self.backing) and not os.path.lexists(self.mount),
                'FILES_REMAIN')
        self.observation['destroyed'] = True

    def _restore(self):
        if self._original_swaps is not None:
            active = _swaps()
            require(all(item in self._original_swaps for item in active), 'SWAP_CHANGED_EXTERNALLY')
            for path, priority in self._stopped:
                if (path, priority) not in active:
                    # Linux assigns the original negative priorities in this order.
                    _run(['swapon', path])
            require(_swaps() == self._original_swaps, 'SWAP_RESTORE_UNKNOWN')
            self.observation['swapRestored'] = True
        if self._original_core is not None:
            require(_core().strip() == '|/bin/false', 'CORE_CHANGED_EXTERNALLY')
            with open(CORE, 'w') as target:
                target.write(self._original_core)
            require(_core() == self._original_core, 'CORE_RESTORE_UNKNOWN')
            self.observation['corePatternRestored'] = True

    def cleanup(self):
        if self._cleaned:
            return True
        self._ready = False
        self._destroy()
        if self._key is not None:
            for i in range(len(self._key)):
                self._key[i] = 0
            self._key = None
        self._restore()
        self._release_lock()
        self._cleaned = True
        return True
