"""Root-only bounded GitHub read pipe. No path/URL/command/token output."""
import base64
import ctypes
import importlib.util
import json
import os
import re
import resource
import signal
import stat
import sys


MODULE = '/opt/subscription-saas/snapshot-adapter/v2/control/snapshot-h1-github.py'
JOURNAL = '/opt/subscription-saas/snapshot-adapter/v2/control/snapshot-h1-route-journal.py'


def require(value):
    if not value:
        raise RuntimeError('H1_GITHUB_QUERY_REJECTED')


def pairs(values):
    result = {}
    for key, value in values:
        require(key not in result)
        result[key] = value
    return result


def timeout(signum, frame):
    raise RuntimeError('H1_GITHUB_QUERY_TIMEOUT')


def load_module(source, name):
    path = source
    while path != '/':
        info = os.lstat(path)
        require(info.st_uid == 0 and info.st_gid == 0 and not info.st_mode & 0o022)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o555
                if path == source else stat.S_ISDIR(info.st_mode))
        path = os.path.dirname(path)
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    require(len(sys.argv) == 1 and os.geteuid() == 0)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    require(ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) == 0)
    require(len(open('/proc/swaps').read().splitlines()) == 1)
    require(open('/proc/sys/kernel/core_pattern').read().strip() == '|/bin/false')
    signal.signal(signal.SIGALRM, timeout)
    signal.signal(signal.SIGTERM, timeout)
    signal.alarm(180)
    packet = sys.stdin.buffer.read(32769)
    require(len(packet) <= 32768)
    request = json.loads(packet.decode('utf8'), object_pairs_hook=pairs)
    require(type(request) is dict and set(request) == {'jwt', 'selection'})
    sys.dont_write_bytecode = True
    module = load_module(MODULE, 'snapshot_h1_github')
    journal = load_module(JOURNAL, 'snapshot_h1_route_journal')
    journal.read_used_route_nonces()  # Missing or corrupt state fails before issuing a token.
    with module.H1SnapshotGitHub(lambda: request['jwt']) as github:
        observed = github.read_admission_inputs(request['selection'])
    observed['usedRouteNonces'] = journal.read_used_route_nonces()
    # Only return data after token revocation succeeds. No token or signed URL
    # appears in the observation; both binary values use canonical base64.
    observed['workflowBytes'] = base64.b64encode(observed['workflowBytes']).decode('ascii')
    observed['artifact']['bytes'] = base64.b64encode(observed['artifact']['bytes']).decode('ascii')
    encoded = json.dumps(observed, separators=(',', ':')).encode('utf8')
    require(len(encoded) <= 16 * 1024 * 1024)
    signal.alarm(0)
    sys.stdout.buffer.write(encoded)


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        # Do not emit a traceback, response body, credential, or download URL.
        code = str(error)
        if re.fullmatch(r'H1_GITHUB_[A-Z0-9_]{1,80}', code) is None:
            code = 'H1_GITHUB_QUERY_REJECTED'
        sys.stderr.write(code + '\n')
        sys.exit(1)
