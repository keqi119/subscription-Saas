#!/usr/bin/env python3
"""Bootstrap the fixed, unprivileged H1 snapshot identity; never admits a job."""

import datetime
import grp
import json
import os
import pwd
import re
import spwd
import stat
import subprocess
import sys


USER = "stage1snapshot"
MARKER = "stage1 snapshot host bootstrap v1"
HOME = "/var/lib/stage1snapshot"
VOLUMES = "/var/lib/subscription-saas/snapshot-volumes"
LIMITS = "/etc/security/limits.d/71-stage1-snapshot.conf"
LIMITS_BYTES = b"stage1snapshot soft core 0\nstage1snapshot hard core 0\n"

# The child reports only existence and access decisions, never names or bytes.
PROBE = r'''
import json, os, socket
def file_denied(path):
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        os.close(fd)
        return False
    except PermissionError: return True
    except OSError: return None
def dir_denied(path):
    try:
        with os.scandir(path) as entries: next(entries, None)
        return False
    except PermissionError: return True
    except OSError: return None
def socket_denied(path):
    sock = socket.socket(socket.AF_UNIX)
    try:
        sock.connect(path)
        return False
    except PermissionError: return True
    except OSError: return None
    finally: sock.close()
print(json.dumps({
  "source_env_denied": file_denied("/opt/subscription-saas/.env.staging.images"),
  "root_ssh_denied": dir_denied("/root/.ssh"),
  "existing_ciphertext_denied": file_denied("/var/lib/stage1-ciphertext/main.luks"),
  "docker_socket_denied": socket_denied("/var/run/docker.sock")
}, sort_keys=True))
'''


def command(argv):
    result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
                            timeout=15,
                            check=False)
    return result


def regular_file(path, mode):
    try:
        info = os.lstat(path)
        return (stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                info.st_gid == 0 and stat.S_IMODE(info.st_mode) == mode)
    except OSError:
        return False


def directory(path, mode):
    try:
        info = os.lstat(path)
        return (stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                info.st_gid == 0 and stat.S_IMODE(info.st_mode) == mode)
    except OSError:
        return False


def root_safe_directory(path):
    try:
        info = os.lstat(path)
        return (stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                info.st_gid == 0 and stat.S_IMODE(info.st_mode) & 0o100 != 0 and
                stat.S_IMODE(info.st_mode) & 0o022 == 0)
    except OSError:
        return False


def identity():
    try:
        account = pwd.getpwnam(USER)
        group = grp.getgrnam(USER)
        shadow = spwd.getspnam(USER)
    except KeyError:
        return None
    groups = {entry.gr_name for entry in grp.getgrall()
              if USER in entry.gr_mem or entry.gr_gid == account.pw_gid}
    expired = shadow.sp_expire is not None and 0 <= shadow.sp_expire <= (
        datetime.date.today() - datetime.date(1970, 1, 1)).days
    return {
        "managed_marker": account.pw_gecos == MARKER,
        "system_uid": account.pw_uid < 1000 and account.pw_uid != 0,
        "private_primary_group": account.pw_gid == group.gr_gid and
        group.gr_mem == [] and groups == {USER} and
        set(os.getgrouplist(USER, account.pw_gid)) == {group.gr_gid},
        "shell_nologin": account.pw_shell == "/sbin/nologin",
        "home_fixed": account.pw_dir == HOME,
        "password_locked": bool(shadow.sp_pwdp) and
        shadow.sp_pwdp[0] in ("!", "*"),
        "account_expired": expired,
    }


def inspect():
    checks = identity() or {key: False for key in (
        "managed_marker", "system_uid", "private_primary_group", "shell_nologin",
        "home_fixed", "password_locked", "account_expired")}
    checks["home_root_0755"] = directory(HOME, 0o755)
    checks["volume_parent_root_safe"] = root_safe_directory("/var/lib/subscription-saas")
    checks["volumes_root_0700"] = directory(VOLUMES, 0o700)
    checks["limits_root_0600"] = regular_file(LIMITS, 0o600)
    if checks["limits_root_0600"]:
        with open(LIMITS, "rb") as stream:
            checks["limits_exact"] = stream.read(len(LIMITS_BYTES) + 1) == LIMITS_BYTES
    else:
        checks["limits_exact"] = False
    checks["home_no_ssh_keys"] = not os.path.lexists(os.path.join(HOME, ".ssh"))

    if checks["managed_marker"]:
        try:
            probe = command(["runuser", "-u", USER, "--", sys.executable, "-c", PROBE])
            observed = json.loads(probe.stdout.decode("ascii")) if probe.returncode == 0 else {}
        except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
            observed = {}
        targets = {
            "source_env_denied": "/opt/subscription-saas/.env.staging.images",
            "root_ssh_denied": "/root/.ssh",
            "existing_ciphertext_denied": "/var/lib/stage1-ciphertext/main.luks",
            "docker_socket_denied": "/var/run/docker.sock",
        }
        for key, path in targets.items():
            checks[key] = os.path.lexists(path) and observed.get(key) is True
        try:
            own_sudo = command(["runuser", "-u", USER, "--", "sudo", "-n", "-l"])
            root_sudo = command(["sudo", "-n", "-l", "-U", USER])
            listing = (root_sudo.stdout + root_sudo.stderr).decode("ascii", "replace").strip()
            checks["sudo_denied"] = (own_sudo.returncode != 0 and
                re.fullmatch(r"User stage1snapshot is not allowed to run sudo on [A-Za-z0-9][A-Za-z0-9.-]*\.", listing) is not None)
        except (OSError, subprocess.TimeoutExpired):
            checks["sudo_denied"] = False
    else:
        for key in ("source_env_denied", "root_ssh_denied",
                    "existing_ciphertext_denied", "docker_socket_denied", "sudo_denied"):
            checks[key] = False
    return checks


def apply():
    if not root_safe_directory("/var/lib") or not root_safe_directory("/etc/security/limits.d"):
        raise RuntimeError("required_parent_not_root_safe")
    if os.path.lexists("/var/lib/subscription-saas") and not root_safe_directory("/var/lib/subscription-saas"):
        raise RuntimeError("volume_parent_not_root_safe")
    existing_user = None
    try:
        existing_user = pwd.getpwnam(USER)
    except KeyError:
        pass
    if existing_user is None:
        try:
            grp.getgrnam(USER)
            raise RuntimeError("unowned_group_exists")
        except KeyError:
            pass
        if any(os.path.lexists(path) for path in (HOME, VOLUMES, LIMITS)):
            raise RuntimeError("unowned_path_exists")
        result = command(["useradd", "-r", "-U", "-M", "-d", HOME,
                          "-s", "/sbin/nologin", "-c", MARKER,
                          "-p", "!", "-e", "1970-01-02", USER])
        if result.returncode != 0:
            raise RuntimeError("useradd_failed")
        # Some shadow-utils builds ignore aging arguments for system users.
        if command(["chage", "-E", "1", USER]).returncode != 0:
            raise RuntimeError("account_expiry_failed")
    else:
        current = identity()
        if current is None or not all(current.values()):
            raise RuntimeError("existing_identity_drift_or_unowned")
        for path, valid in ((HOME, directory(HOME, 0o755)),
                            (VOLUMES, directory(VOLUMES, 0o700)),
                            (LIMITS, regular_file(LIMITS, 0o600))):
            if os.path.lexists(path) and not valid:
                raise RuntimeError("managed_path_drift")
        if os.path.lexists(LIMITS):
            with open(LIMITS, "rb") as stream:
                if stream.read(len(LIMITS_BYTES) + 1) != LIMITS_BYTES:
                    raise RuntimeError("limits_content_drift")
    if not os.path.lexists("/var/lib/subscription-saas"):
        os.mkdir("/var/lib/subscription-saas", 0o755)
        os.chmod("/var/lib/subscription-saas", 0o755)
    if not os.path.lexists(HOME):
        os.mkdir(HOME, 0o755)
        os.chmod(HOME, 0o755)
    if not os.path.lexists(VOLUMES):
        os.mkdir(VOLUMES, 0o700)
        os.chmod(VOLUMES, 0o700)
    if not os.path.lexists(LIMITS):
        descriptor = os.open(LIMITS, os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                             0o600)
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(LIMITS_BYTES)
            stream.flush()
            os.fsync(stream.fileno())


def main():
    if sys.argv[1:] not in (["--check"], ["--apply"]):
        print(json.dumps({"status": "error", "code": "mode_required"}))
        return 2
    if os.geteuid() != 0:
        print(json.dumps({"status": "error", "code": "root_required"}))
        return 2
    try:
        if sys.argv[1:] == ["--apply"]:
            apply()
        checks = inspect()
        passed = all(checks.values())
        print(json.dumps({"status": "bootstrap_verified" if passed else "incomplete",
                          "checks": checks}, sort_keys=True))
        return 0 if passed else 1
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        code = str(error) if isinstance(error, RuntimeError) else "operation_failed"
        print(json.dumps({"status": "error", "code": code}, sort_keys=True))
        return 2


if __name__ == "__main__":
    sys.exit(main())
