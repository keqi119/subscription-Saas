#!/usr/bin/env bash
# One isolated localhost OpenSSH probe. Never edits the installed sshd config.
set -Eeuo pipefail
umask 077
[[ $(id -u) == 0 ]] || { printf 'probe requires root\n' >&2; exit 1; }

for tool in sshd ssh sftp ssh-keygen useradd userdel groupadd groupdel mount umount \
  mountpoint mktemp timeout ss getent install cat grep cmp seq pkill tail; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'missing %s\n' "$tool" >&2; exit 1; }
done

sshd=$(command -v sshd)
tmp=$(mktemp -d /run/stage1-r3-evidence-probe.XXXXXXXX)
[[ $tmp == /run/stage1-r3-evidence-probe.* && -d $tmp && ! -L $tmp ]] || exit 1
chmod 0755 "$tmp" # sshd must traverse this root-owned parent to read authorized_keys.
install -d -m 0700 -o root -g root "$tmp/private"
evidence_user=r3evp$(printf '%x' "$RANDOM")
forward_user=r3fwp$(printf '%x' "$RANDOM")
created_evidence=0 created_forward=0 created_evidence_group=0 created_forward_group=0
mounted=0 daemon_pid='' forward_pid='' sftp_pid=''

cleanup() {
  local result=$? failed=0
  trap - EXIT
  trap - ERR
  set +e
  if (( result )); then
    for log in effective sshd.log outbox-denial.log link-denial.log shell-denial.log forward-denial.log forward.log; do
      if [[ -f $tmp/$log ]]; then
        printf 'PROBE_DIAGNOSTIC %s (last 20 lines)\n' "$log" >&2
        tail -n 20 -- "$tmp/$log" >&2
      fi
    done
  fi
  [[ -z $sftp_pid ]] || { kill "$sftp_pid" 2>/dev/null; wait "$sftp_pid" 2>/dev/null; }
  [[ -z $forward_pid ]] || { kill "$forward_pid" 2>/dev/null; wait "$forward_pid" 2>/dev/null; }
  [[ -z $daemon_pid ]] || { kill "$daemon_pid" 2>/dev/null; wait "$daemon_pid" 2>/dev/null; }
  if (( created_evidence )); then pkill -TERM -u "$evidence_user" 2>/dev/null; fi
  if (( created_forward )); then pkill -TERM -u "$forward_user" 2>/dev/null; fi
  if (( mounted )) && mountpoint -q "$tmp/chroot"; then
    umount "$tmp/chroot" || failed=1
  fi
  if mountpoint -q "$tmp/chroot"; then failed=1; fi
  if (( !failed )); then
    [[ $tmp == /run/stage1-r3-evidence-probe.* && -d $tmp && ! -L $tmp ]] && rm -rf -- "$tmp"
  fi
  if (( created_evidence )); then userdel -- "$evidence_user" || failed=1; fi
  if (( created_forward )); then userdel -- "$forward_user" || failed=1; fi
  if (( created_evidence_group )) && getent group "$evidence_user" >/dev/null; then
    groupdel -- "$evidence_user" || failed=1
  fi
  if (( created_forward_group )) && getent group "$forward_user" >/dev/null; then
    groupdel -- "$forward_user" || failed=1
  fi
  if (( failed )); then
    printf 'PROBE_CLEANUP_INCOMPLETE %s\n' "$tmp" >&2
    exit 1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'status=$?; printf "PROBE_ERROR line=%s exit=%s command=%s\n" "$LINENO" "$status" "$BASH_COMMAND" >&2' ERR
[[ $evidence_user != "$forward_user" ]] || { printf 'probe account collision\n' >&2; exit 1; }
for name in "$evidence_user" "$forward_user"; do
  getent passwd "$name" >/dev/null && { printf 'probe account collision\n' >&2; exit 1; }
  getent group "$name" >/dev/null && { printf 'probe group collision\n' >&2; exit 1; }
done

free_port=0
for offset in $(seq 0 50); do
  port=$((23000 + RANDOM % 15000))
  forward_port=$((port + 1))
  if [[ -z $(ss -H -ltn "sport = :$port") && -z $(ss -H -ltn "sport = :$forward_port") && -z $(ss -H -ltn "sport = :$((forward_port + 1))") ]]; then
    free_port=1
    break
  fi
done
(( free_port )) || { printf 'no free probe ports\n' >&2; exit 1; }

groupadd --system "$evidence_user"
created_evidence_group=1
useradd --system --no-create-home --home-dir / --shell /sbin/nologin \
  --gid "$evidence_user" --password '!' "$evidence_user"
created_evidence=1
groupadd --system "$forward_user"
created_forward_group=1
useradd --system --no-create-home --home-dir / --shell /sbin/nologin \
  --gid "$forward_user" --password '!' "$forward_user"
created_forward=1

install -d -m 0755 -o root -g root "$tmp/chroot"
mount -t tmpfs -o size=8m,nr_inodes=128,nodev,nosuid,noexec,mode=0755,uid=0,gid=0 tmpfs "$tmp/chroot"
mounted=1
install -d -m 0700 -o "$evidence_user" -g "$evidence_user" "$tmp/chroot/in"
install -d -m 0750 -o root -g "$evidence_user" "$tmp/chroot/out"
ssh-keygen -q -t ed25519 -N '' -f "$tmp/private/hostkey"
ssh-keygen -q -t ed25519 -N '' -f "$tmp/private/clientkey"
printf 'restrict %s\n' "$(cat "$tmp/private/clientkey.pub")" > "$tmp/evidence_authorized_keys"
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:%s" %s\n' \
  "$forward_port" "$(cat "$tmp/private/clientkey.pub")" > "$tmp/forward_authorized_keys"
chmod 0644 "$tmp/evidence_authorized_keys" "$tmp/forward_authorized_keys"
printf '[127.0.0.1]:%s %s\n' "$port" "$(cat "$tmp/private/hostkey.pub")" > "$tmp/known_hosts"
chmod 0600 "$tmp/known_hosts"

cat > "$tmp/sshd_config" <<EOF
Port $port
ListenAddress 127.0.0.1
HostKey $tmp/private/hostkey
PidFile $tmp/sshd.pid
UsePAM yes
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile none
Subsystem sftp internal-sftp
Match User $forward_user
    AuthenticationMethods publickey
    AuthorizedKeysFile $tmp/forward_authorized_keys
    MaxSessions 0
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:$forward_port
    PermitOpen none
    AllowAgentForwarding no
    ForceCommand /sbin/nologin
Match User $evidence_user
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthorizedKeysFile $tmp/evidence_authorized_keys
    AuthorizedKeysCommand none
    TrustedUserCAKeys none
    AuthorizedPrincipalsFile none
    AuthorizedPrincipalsCommand none
    ChrootDirectory $tmp/chroot
    ForceCommand internal-sftp -d / -u 0077 -p open,close,read,write,lstat,fstat,stat,realpath,rename,posix-rename
    MaxSessions 1
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    PermitListen none
    PermitOpen none
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    PermitTunnel no
    PermitUserRC no
EOF
"$sshd" -t -f "$tmp/sshd_config" >/dev/null
"$sshd" -T -f "$tmp/sshd_config" -C "user=$evidence_user,host=127.0.0.1,addr=127.0.0.1" > "$tmp/effective"
grep -Fqx 'kbdinteractiveauthentication no' "$tmp/effective"
grep -Fqx 'allowtcpforwarding no' "$tmp/effective"
grep -Fqx 'maxsessions 1' "$tmp/effective"
"$sshd" -D -e -f "$tmp/sshd_config" < /dev/null > "$tmp/sshd.log" 2>&1 &
daemon_pid=$!
for _ in $(seq 1 50); do
  [[ -n $(ss -H -ltn "sport = :$port") ]] && break
  kill -0 "$daemon_pid" 2>/dev/null || { printf 'isolated sshd exited\n' >&2; exit 1; }
  sleep 0.1
done
[[ -n $(ss -H -ltn "sport = :$port") ]] || { printf 'isolated sshd did not listen\n' >&2; exit 1; }

common=(-i "$tmp/private/clientkey" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$tmp/known_hosts" \
  -o ConnectTimeout=5)
printf '{"kind":"creation"}\n' > "$tmp/creation.json"
printf '{"kind":"closed"}\n' > "$tmp/closed.json"

# One SFTP process and one stdin stream remain live across every positive step.
coproc SFTP { /usr/bin/sftp -b - "${common[@]}" -P "$port" "$evidence_user@127.0.0.1" 2>&1; }
sftp_pid=$SFTP_PID
await_pwd() {
  local line last=''
  while IFS= read -r -t 15 -u "${SFTP[0]}" line; do
    last=$line
    [[ $line == *'Remote working directory: /'* ]] && return 0
  done
  printf 'persistent SFTP pwd boundary missing; last line: %s\n' "$last" >&2
  return 1
}
send() {
  printf '%s\npwd\n' "$1" >&"${SFTP[1]}"
  await_pwd
}
printf 'pwd\n' >&"${SFTP[1]}"
await_pwd
send "put $tmp/creation.json /in/creation.bundle.json.part"
send 'rename /in/creation.bundle.json.part /in/creation.bundle.json'
send "get /in/creation.bundle.json $tmp/creation.readback.json"
cmp -s "$tmp/creation.json" "$tmp/creation.readback.json"

confirmed_auth() { grep -Fq 'Authenticated to 127.0.0.1' "$1"; }
outbox_denial_status=0
printf 'put %s /out/forbidden\n' "$tmp/creation.json" | timeout 10 /usr/bin/sftp -v -b - "${common[@]}" -P "$port" "$evidence_user@127.0.0.1" > "$tmp/outbox-denial.log" 2>&1 || outbox_denial_status=$?
[[ $outbox_denial_status != 0 && $outbox_denial_status != 124 ]] && confirmed_auth "$tmp/outbox-denial.log" || {
  printf 'outbox denial did not follow authenticated server response\n' >&2; exit 1;
}
link_denial_status=0
printf 'ln /in/creation.bundle.json /in/forbidden-link\n' | timeout 10 /usr/bin/sftp -v -b - "${common[@]}" -P "$port" "$evidence_user@127.0.0.1" > "$tmp/link-denial.log" 2>&1 || link_denial_status=$?
[[ $link_denial_status != 0 && $link_denial_status != 124 ]] && confirmed_auth "$tmp/link-denial.log" || {
  printf 'link denial did not follow authenticated server response\n' >&2; exit 1;
}
shell_denial_status=0
timeout 10 /usr/bin/ssh -v "${common[@]}" -p "$port" "$evidence_user@127.0.0.1" 'printf SHELL_GRANTED' < /dev/null > "$tmp/shell-denial.log" 2>&1 || shell_denial_status=$?
[[ $shell_denial_status != 124 ]] && confirmed_auth "$tmp/shell-denial.log" && ! grep -axq 'SHELL_GRANTED' "$tmp/shell-denial.log" || {
  printf 'shell command succeeded, hung or failed authentication\n' >&2; exit 1;
}
forward_denial_status=0
timeout 10 /usr/bin/ssh -v "${common[@]}" -N -o ExitOnForwardFailure=yes \
  -R "127.0.0.1:$((forward_port + 1)):127.0.0.1:1" -p "$port" \
  "$evidence_user@127.0.0.1" < /dev/null > "$tmp/forward-denial.log" 2>&1 || forward_denial_status=$?
[[ $forward_denial_status != 0 && $forward_denial_status != 124 &&
  -z $(ss -H -ltn "sport = :$((forward_port + 1))") ]] || {
  printf 'evidence account forwarding unexpectedly succeeded or hung\n' >&2; exit 1;
}
confirmed_auth "$tmp/forward-denial.log" || { printf 'forward denial failed authentication\n' >&2; exit 1; }

/usr/bin/ssh "${common[@]}" -N -o ExitOnForwardFailure=yes \
  -R "127.0.0.1:$forward_port:127.0.0.1:1" -p "$port" \
  "$forward_user@127.0.0.1" < /dev/null > "$tmp/forward.log" 2>&1 &
forward_pid=$!
for _ in $(seq 1 50); do
  [[ -n $(ss -H -ltn "sport = :$forward_port") ]] && break
  kill -0 "$forward_pid" 2>/dev/null || { printf 'probe forward failed\n' >&2; exit 1; }
  sleep 0.1
done
[[ -n $(ss -H -ltn "sport = :$forward_port") ]] || { printf 'probe forward absent\n' >&2; exit 1; }
kill "$forward_pid"
wait "$forward_pid" 2>/dev/null || true
forward_pid=''
for _ in $(seq 1 50); do
  [[ -z $(ss -H -ltn "sport = :$forward_port") ]] && break
  sleep 0.1
done
[[ -z $(ss -H -ltn "sport = :$forward_port") ]] || { printf 'probe forward still listening\n' >&2; exit 1; }
install -m 0640 -o root -g "$evidence_user" "$tmp/closed.json" "$tmp/chroot/out/closed.json"
send "get /out/closed.json $tmp/closed.readback.json"
cmp -s "$tmp/closed.json" "$tmp/closed.readback.json"
printf 'PROBE_PASS persistent SFTP after separate forward exit; restrictions enforced\n'
