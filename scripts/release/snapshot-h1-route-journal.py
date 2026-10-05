"""Private, fixed-path nonce consumption journal for the H1 root controller.

The journal records use before runner registration. It cannot defend against a
malicious root rollback; later checks must inspect the bound admission claim.
"""
import json
import os
import re
import stat


STATE_DIR = '/var/lib/subscription-saas/snapshot-root-state'
NONCE_DIR_NAME = 'route-nonces'
MAX_RECORDS = 10000
MAX_RECORD_BYTES = 1024


class JournalFailure(Exception):
    """Only fixed, non-secret error codes cross the controller boundary."""


def _require(condition, code):
    if not condition:
        raise JournalFailure('H1_ROUTE_JOURNAL_' + code)


def _require_root_owner(info):
    _require(info.st_uid == 0 and info.st_gid == 0, 'OWNERSHIP_INVALID')


def _require_posix():
    _require(os.name == 'posix' and hasattr(os, 'O_NOFOLLOW') and
             hasattr(os, 'O_DIRECTORY') and hasattr(os, 'geteuid') and
             os.geteuid() == 0, 'UNSUPPORTED')


def _open_directory(path):
    _require_posix()
    _require(os.path.isabs(path), 'PATH_INVALID')
    current = os.path.sep
    for part in [part for part in path.split(os.path.sep) if part]:
        current = os.path.join(current, part)
        info = os.lstat(current)
        _require(stat.S_ISDIR(info.st_mode), 'DIRECTORY_INVALID')
        _require_root_owner(info)
        _require(stat.S_IMODE(info.st_mode) & 0o022 == 0, 'DIRECTORY_INVALID')
    _require(stat.S_IMODE(info.st_mode) == 0o700, 'DIRECTORY_INVALID')
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        _require(stat.S_ISDIR(opened.st_mode) and
                 stat.S_IMODE(opened.st_mode) == 0o700 and
                 (opened.st_dev, opened.st_ino) == (info.st_dev, info.st_ino),
                 'DIRECTORY_INVALID')
        _require_root_owner(opened)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _open_journal():
    return _open_directory(os.path.join(STATE_DIR, NONCE_DIR_NAME))


def _valid_nonce(value):
    return type(value) is str and re.fullmatch(r'[a-f0-9]{32}', value) is not None


def _valid_id(value):
    return type(value) is str and re.fullmatch(r'[1-9][0-9]{0,18}', value) is not None


def _valid_digest(value):
    return type(value) is str and re.fullmatch(r'sha256:[a-f0-9]{64}', value) is not None


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        _require(key not in value, 'RECORD_INVALID')
        value[key] = item
    return value


def initialize():
    """Explicitly create a fresh empty journal under a verified state directory."""
    try:
        parent = _open_directory(STATE_DIR)
        try:
            os.mkdir(NONCE_DIR_NAME, 0o700, dir_fd=parent)
            os.chmod(NONCE_DIR_NAME, 0o700, dir_fd=parent, follow_symlinks=False)
            journal = os.open(NONCE_DIR_NAME, os.O_RDONLY | os.O_DIRECTORY |
                              os.O_NOFOLLOW, dir_fd=parent)
            try:
                info = os.fstat(journal)
                _require(stat.S_ISDIR(info.st_mode), 'DIRECTORY_INVALID')
                _require_root_owner(info)
                os.fchmod(journal, 0o700)
                os.fsync(journal)
                os.fsync(parent)
            finally:
                os.close(journal)
        finally:
            os.close(parent)
    except OSError:
        raise JournalFailure('H1_ROUTE_JOURNAL_IO_FAILED') from None


def claim(nonce, run_id, job_id, admission_digest):
    """Consume a nonce once; never remove a created record on any failure."""
    _require(_valid_nonce(nonce) and _valid_id(run_id) and _valid_id(job_id) and
             _valid_digest(admission_digest), 'INPUT_INVALID')
    _require(len(read_used_route_nonces()) < MAX_RECORDS, 'LIMIT_EXCEEDED')
    record = {'nonce': nonce, 'run_id': run_id, 'job_id': job_id,
              'admission_digest': admission_digest}
    raw = json.dumps(record, sort_keys=True, separators=(',', ':')).encode('ascii')
    _require(len(raw) <= MAX_RECORD_BYTES, 'INPUT_INVALID')
    try:
        directory = _open_journal()
        try:
            descriptor = os.open(nonce + '.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                                 os.O_NOFOLLOW, 0o600, dir_fd=directory)
            try:
                os.fchmod(descriptor, 0o600)
                _require_root_owner(os.fstat(descriptor))
                offset = 0
                while offset < len(raw):
                    written = os.write(descriptor, raw[offset:])
                    _require(written > 0, 'IO_FAILED')
                    offset += written
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            os.fsync(directory)
        finally:
            os.close(directory)
    except FileExistsError:
        raise JournalFailure('H1_ROUTE_JOURNAL_NONCE_USED') from None
    except OSError:
        raise JournalFailure('H1_ROUTE_JOURNAL_IO_FAILED') from None


def read_used_route_nonces():
    """Return every validated nonce in sorted order; any foreign entry fails closed."""
    try:
        directory = _open_journal()
        try:
            names = os.listdir(directory)
            _require(len(names) <= MAX_RECORDS, 'LIMIT_EXCEEDED')
            nonces = []
            for name in sorted(names):
                _require(type(name) is str and
                         re.fullmatch(r'[a-f0-9]{32}\.json', name) is not None,
                         'RECORD_INVALID')
                descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                     dir_fd=directory)
                try:
                    info = os.fstat(descriptor)
                    _require(stat.S_ISREG(info.st_mode) and
                             stat.S_IMODE(info.st_mode) == 0o600 and
                             info.st_nlink == 1 and
                             0 < info.st_size <= MAX_RECORD_BYTES,
                             'RECORD_INVALID')
                    _require_root_owner(info)
                    raw = os.read(descriptor, MAX_RECORD_BYTES + 1)
                    _require(len(raw) == info.st_size, 'RECORD_INVALID')
                finally:
                    os.close(descriptor)
                try:
                    record = json.loads(raw.decode('utf-8'), object_pairs_hook=_unique_object)
                except (ValueError, UnicodeError):
                    raise JournalFailure('H1_ROUTE_JOURNAL_RECORD_INVALID') from None
                nonce = name[:-5]
                _require(type(record) is dict and
                         set(record) == {'nonce', 'run_id', 'job_id', 'admission_digest'} and
                         record['nonce'] == nonce and _valid_nonce(record['nonce']) and
                         _valid_id(record['run_id']) and _valid_id(record['job_id']) and
                         _valid_digest(record['admission_digest']), 'RECORD_INVALID')
                nonces.append(nonce)
            return nonces
        finally:
            os.close(directory)
    except OSError:
        raise JournalFailure('H1_ROUTE_JOURNAL_IO_FAILED') from None
