#!/usr/bin/env bash
# Prepare only the empty, unmounted evidence account and its sshd Match rule.
# The operation adapter owns the temporary key, tmpfs mount and exchange files.
set -Eeuo pipefail
umask 077

account=stage1-r3-evidence
group=stage1-r3-evidence
exchange=/run/stage1-r3-evidence
key_directory=/etc/ssh/stage1-r3-evidence
key_file=$key_directory/authorized_keys
config=/etc/ssh/sshd_config
backup_root=/var/backups/stage1-r3-evidence
sshd=/usr/sbin/sshd
begin='# BEGIN stage1-r3-evidence (managed by stage1-r3-evidence-account.sh)'
host=139.196.227.195

die() { printf 'stage1-r3-evidence: %s\n' "$*" >&2; exit 1; }
require_root() { [[ $(id -u) == 0 ]] || die 'root required'; }
require_tools() {
  for tool in getent id stat findmnt mountpoint pgrep cmp mktemp cp mv chmod chown \
    groupadd groupdel useradd userdel systemctl cat grep sed find install rmdir rm sudo; do
    command -v "$tool" >/dev/null 2>&1 || die "missing $tool"
  done
  [[ -x $sshd && -f $config && ! -L $config ]] || die 'sshd or main configuration unavailable'
}

match_block() {
  cat <<'EOF'
# BEGIN stage1-r3-evidence (managed by stage1-r3-evidence-account.sh)
Match User stage1-r3-evidence
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthorizedKeysFile /etc/ssh/stage1-r3-evidence/authorized_keys
    AuthorizedKeysCommand none
    TrustedUserCAKeys none
    AuthorizedPrincipalsFile none
    AuthorizedPrincipalsCommand none
    ChrootDirectory /run/stage1-r3-evidence
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
# END stage1-r3-evidence
EOF
}

owner_mode() { [[ $(stat -c '%u:%g:%a' -- "$1") == "$2" ]]; }
empty_directory() { [[ -z $(find "$1" -mindepth 1 -maxdepth 1 -print -quit) ]]; }

account_state() {
  if ! getent passwd "$account" >/dev/null; then
    getent group "$group" >/dev/null && die 'orphan group exists'
    printf 'absent'
    return
  fi
  local name unused uid gid description home shell group_name group_gid members shadow password sudo_listing
  IFS=: read -r name unused uid gid description home shell < <(getent passwd "$account")
  [[ $name == "$account" && $uid =~ ^[0-9]+$ && $uid != 0 && $uid != 994 && \
    $gid =~ ^[0-9]+$ && $home == / && $shell == /sbin/nologin ]] || die 'account differs from approved state'
  IFS=: read -r group_name unused group_gid members < <(getent group "$group")
  [[ $group_name == "$group" && $group_gid == "$gid" && -z $members ]] || die 'group differs from approved state'
  [[ $(id -G "$account") == "$gid" ]] || die 'supplementary group present'
  shadow=$(getent shadow "$account") || die 'shadow entry missing'
  IFS=: read -r unused password _ <<< "$shadow"
  [[ $password == '!'* || $password == '*'* ]] || die 'password is not locked'
  if command -v sudo >/dev/null 2>&1; then
    # This host's sudo can return zero for a successful listing of no grants.
    # Require its explicit C-locale denial; unknown/listed policies fail closed.
    sudo_listing=$(LC_ALL=C sudo -n -l -U "$account" 2>&1) || true
    [[ $sudo_listing == "User $account is not allowed to run sudo on "*'.' &&
      $sudo_listing != *$'\n'* ]] || die 'sudo absence could not be verified'
  fi
  printf 'exact'
}

path_state() {
  local result=empty
  [[ -d /run && ! -L /run ]] && owner_mode /run '0:0:755' || die 'unsafe /run parent'
  [[ -d /etc/ssh && ! -L /etc/ssh ]] || die 'unsafe /etc/ssh parent'
  local ssh_owner ssh_group ssh_mode
  IFS=: read -r ssh_owner ssh_group ssh_mode < <(stat -c '%u:%g:%a' -- /etc/ssh)
  [[ $ssh_owner == 0 && $ssh_group == 0 && $ssh_mode =~ ^[0-7]{3,4}$ &&
    $((8#$ssh_mode & 0022)) == 0 ]] || die 'unsafe /etc/ssh ownership or write mode'
  if [[ -e $exchange || -L $exchange ]]; then
    [[ -d $exchange && ! -L $exchange ]] && owner_mode "$exchange" '0:0:755' || die 'unsafe exchange root'
    if mountpoint -q -- "$exchange"; then
      local kind options block_size blocks inodes
      kind=$(findmnt -n --mountpoint "$exchange" -o FSTYPE)
      options=,$(findmnt -n --mountpoint "$exchange" -o OPTIONS),
      [[ $kind == tmpfs && $options == *,nodev,* && $options == *,nosuid,* && $options == *,noexec,* ]] || die 'unexpected exchange mount'
      read -r block_size blocks inodes < <(stat -f -c '%S %b %c' -- "$exchange")
      [[ $((block_size * blocks)) -eq 8388608 && $inodes -eq 128 ]] || die 'exchange mount limit mismatch'
      result=active
    else
      empty_directory "$exchange" || die 'unmounted exchange is not empty'
    fi
  fi
  if [[ -e $key_directory || -L $key_directory ]]; then
    [[ -d $key_directory && ! -L $key_directory ]] && owner_mode "$key_directory" '0:0:755' || die 'unsafe key directory'
    local entry
    for entry in "$key_directory"/* "$key_directory"/.[!.]* "$key_directory"/..?*; do
      [[ -e $entry || -L $entry ]] || continue
      [[ $entry == "$key_file" ]] || die 'unexpected key-directory entry'
    done
  fi
  if [[ -e $key_file || -L $key_file ]]; then
    [[ -f $key_file && ! -L $key_file ]] && owner_mode "$key_file" '0:0:644' || die 'unsafe authorized_keys'
    [[ $(stat -c '%h' -- "$key_file") == 1 ]] || die 'linked authorized_keys'
    [[ ! -s $key_file ]] || result=active
  fi
  if getent passwd "$account" >/dev/null; then
    local uid
    uid=$(id -u "$account")
    if pgrep -u "$uid" >/dev/null 2>&1; then result=active; fi
  fi
  printf '%s' "$result"
}

config_state() {
  local count actual expected
  count=$(grep -Fc -- "$begin" "$config" || true)
  [[ $count == 0 || $count == 1 ]] || die 'duplicate evidence Match marker'
  if [[ $count == 0 ]]; then
    grep -Eq '^[[:space:]]*Match[[:space:]]+User[[:space:]]+stage1-r3-evidence([[:space:]]|$)' "$config" && die 'unmanaged evidence Match exists'
    printf 'absent'
    return
  fi
  actual=$(sed -n '/^# BEGIN stage1-r3-evidence (managed by stage1-r3-evidence-account.sh)$/,$p' "$config")
  expected=$(match_block)
  [[ $actual == "$expected" ]] || die 'evidence Match differs from approved block'
  printf 'exact'
}

effective() { "$sshd" -T -f "$1" -C "user=$2,host=$host,addr=127.0.0.1"; }
assert_effective() {
  local actual field value
  actual=$(cat -- "$1") || die 'effective configuration could not be read'
  while IFS='|' read -r field value; do
    grep -Fqx -- "$field $value" <<< "$actual" || die "effective $field mismatch"
  done <<'EOF'
authenticationmethods|publickey
pubkeyauthentication|yes
passwordauthentication|no
kbdinteractiveauthentication|no
authorizedkeysfile|/etc/ssh/stage1-r3-evidence/authorized_keys
authorizedkeyscommand|none
trustedusercakeys|none
authorizedprincipalsfile|none
authorizedprincipalscommand|none
chrootdirectory|/run/stage1-r3-evidence
forcecommand|internal-sftp -d / -u 0077 -p open,close,read,write,lstat,fstat,stat,realpath,rename,posix-rename
maxsessions|1
allowtcpforwarding|no
allowstreamlocalforwarding|no
permitlisten|none
permitopen|none
allowagentforwarding|no
x11forwarding|no
permittty|no
permittunnel|no
permituserrc|no
EOF
}

check() {
  require_root
  require_tools
  "$sshd" -t -f "$config" >/dev/null 2>&1 || die 'existing sshd configuration fails syntax check'
  local identity paths rule
  identity=$(account_state)
  paths=$(path_state)
  rule=$(config_state)
  if [[ $rule == exact ]]; then
    [[ $identity == exact ]] || die 'Match exists without exact account'
    local current
    current=$(effective "$config" "$account") || die 'effective evidence Match unavailable'
    assert_effective <(printf '%s\n' "$current")
  fi
  if [[ $paths == active ]]; then
    printf 'ACTIVE: account=%s Match=%s; check-only made no changes\n' "$identity" "$rule"
  elif [[ $identity == exact && $rule == exact && -d $exchange && -f $key_file ]]; then
    printf 'READY: empty unmounted exchange and key; check-only made no changes\n'
  elif [[ $identity == absent && $rule == absent && ! -e $exchange && ! -e $key_directory ]]; then
    printf 'ABSENT: check-only made no changes\n'
  else
    printf 'INCOMPLETE: account=%s Match=%s; check-only made no changes\n' "$identity" "$rule"
  fi
}

assert_unmounted_exchange() {
  # util-linux 2.32 reports a non-mountpoint as 1; newer versions use 32.
  # Read a successful, nonempty kernel table instead of guessing from that code.
  local targets target root_seen=0
  targets=$(findmnt --kernel --noheadings --raw --output TARGET 2>&1) || die 'mount table unavailable'
  while IFS= read -r target; do
    [[ $target == /* ]] || die 'mount table invalid'
    [[ $target != "$exchange" ]] || die 'evidence root mounted'
    [[ $target != / ]] || root_seen=1
  done <<< "$targets"
  [[ $root_seen == 1 ]] || die 'mount table root missing'
}

check_idle() {
  require_root
  require_tools
  command -v ss >/dev/null 2>&1 || die 'missing ss'
  "$sshd" -t -f "$config" >/dev/null 2>&1 || die 'existing sshd configuration fails syntax check'
  [[ $(account_state) == exact && $(path_state) == empty && $(config_state) == exact ]] || die 'evidence surface is not IDLE'
  [[ -d $exchange && ! -L $exchange ]] && owner_mode "$exchange" '0:0:755' || die 'formal evidence root missing'
  assert_unmounted_exchange
  local root_entry
  root_entry=$(find "$exchange" -mindepth 1 -maxdepth 1 -print -quit) || die 'evidence root entries unknown'
  [[ -z $root_entry ]] || die 'evidence root is not empty'
  [[ -f $key_file && ! -L $key_file ]] && owner_mode "$key_file" '0:0:644' &&
    [[ $(stat -c '%h' -- "$key_file") == 1 && ! -s $key_file ]] || die 'evidence key is not IDLE'
  local forward_key=/etc/ssh/stage1-r3-forward/authorized_keys
  local forward_owner forward_mode
  [[ -d ${forward_key%/*} && ! -L ${forward_key%/*} ]] || die 'forward key directory differs'
  IFS=: read -r forward_owner forward_mode < <(stat -c '%u:%a' -- "${forward_key%/*}")
  [[ $forward_owner == 0 && $forward_mode =~ ^[0-7]{3,4}$ &&
    $((8#$forward_mode & 0022)) == 0 ]] || die 'forward key directory is writable'
  local forward_file_owner forward_file_mode forward_links forward_size
  [[ -f $forward_key && ! -L $forward_key ]] || die 'forward key is not regular'
  IFS=: read -r forward_file_owner forward_file_mode forward_links forward_size < <(stat -c '%u:%a:%h:%s' -- "$forward_key")
  [[ $forward_file_owner == 0 && $forward_file_mode == 644 && $forward_links == 1 && $forward_size == 0 ]] || die 'forward key is not IDLE'
  local evidence_uid forward_status=0 evidence_status=0 listeners current
  evidence_uid=$(id -u "$account") || die 'evidence UID unknown'
  pgrep -u "$evidence_uid" >/dev/null 2>&1 || evidence_status=$?
  [[ $evidence_status == 1 ]] || die 'evidence process present or state unknown'
  pgrep -u 994 >/dev/null 2>&1 || forward_status=$?
  [[ $forward_status == 1 ]] || die 'forward process present or state unknown'
  listeners=$(ss -H -ltn 'sport = :55440 or sport = :55441') || die 'forward listeners unknown'
  [[ -z $listeners ]] || die 'forward listener remains'
  current=$(effective "$config" "$account") || die 'effective evidence Match unavailable'
  assert_effective <(printf '%s\n' "$current")
  printf 'IDLE: formal evidence and forward surfaces are empty; check-only made no changes\n'
}

apply() {
  require_root
  require_tools
  "$sshd" -t -f "$config" >/dev/null 2>&1 || die 'existing sshd configuration fails syntax check'
  local identity paths rule backup candidate='' created_group=0 created_user=0
  local created_exchange=0 created_key_directory=0 created_key=0 changed_config=0
  identity=$(account_state)
  paths=$(path_state)
  rule=$(config_state)
  [[ $paths == empty ]] || die 'active exchange, key or account process; apply refused'
  if [[ $rule == exact ]]; then
    [[ $identity == exact && -d $exchange && -f $key_file ]] || die 'partial prior configuration'
    check
    return
  fi
  [[ $rule == absent ]] || die 'unexpected Match state'
  [[ -d $backup_root && ! -L $backup_root ]] || {
    [[ ! -e $backup_root && ! -L $backup_root ]] || die 'unsafe backup root'
    install -d -m 0700 -o root -g root -- "$backup_root"
  }
  owner_mode "$backup_root" '0:0:700' || die 'unsafe backup root'
  backup=$(mktemp -d "$backup_root/apply.XXXXXXXX")
  chmod 0700 "$backup"
  cp -p -- "$config" "$backup/sshd_config"
  rollback() {
    local exit_code=$?
    trap - EXIT
    set +e
    if (( changed_config )); then
      local restored
      restored=$(mktemp /etc/ssh/.sshd_config.stage1-r3-restore.XXXXXXXX)
      cp -p -- "$backup/sshd_config" "$restored"
      mv -Tf -- "$restored" "$config"
      "$sshd" -t -f "$config" >/dev/null 2>&1 && systemctl reload sshd >/dev/null 2>&1
    fi
    [[ -z $candidate || ! -e $candidate ]] || rm -f -- "$candidate"
    (( created_key == 0 )) || rm -f -- "$key_file"
    (( created_key_directory == 0 )) || rmdir -- "$key_directory"
    (( created_exchange == 0 )) || rmdir -- "$exchange"
    (( created_user == 0 )) || userdel -- "$account"
    if (( created_group )) && getent group "$group" >/dev/null; then groupdel -- "$group"; fi
    printf 'stage1-r3-evidence: apply failed; attempted rollback; backup=%s\n' "$backup" >&2
    exit "$exit_code"
  }
  trap rollback EXIT
  effective "$config" root > "$backup/root.before"
  effective "$config" stage1-r3-forward > "$backup/forward.before"
  candidate=$(mktemp /etc/ssh/.sshd_config.stage1-r3-evidence.XXXXXXXX)
  cp -p -- "$config" "$candidate"
  printf '\n' >> "$candidate"
  match_block >> "$candidate"
  chmod --reference="$config" "$candidate"
  chown --reference="$config" "$candidate"
  "$sshd" -t -f "$candidate" >/dev/null 2>&1 || die 'candidate sshd syntax failed'
  effective "$candidate" root > "$backup/root.candidate"
  effective "$candidate" stage1-r3-forward > "$backup/forward.candidate"
  effective "$candidate" "$account" > "$backup/evidence.candidate"
  cmp -s "$backup/root.before" "$backup/root.candidate" || die 'candidate changes root SSH configuration'
  cmp -s "$backup/forward.before" "$backup/forward.candidate" || die 'candidate changes forward SSH configuration'
  assert_effective "$backup/evidence.candidate"
  systemctl is-active --quiet sshd || die 'sshd service is not active'

  if [[ $identity == absent ]]; then
    groupadd --system "$group"
    created_group=1
    useradd --system --no-create-home --home-dir / --shell /sbin/nologin \
      --gid "$group" --password '!' "$account"
    created_user=1
  fi
  [[ $(account_state) == exact ]] || die 'new account verification failed'
  if [[ ! -e $exchange ]]; then
    install -d -m 0755 -o root -g root -- "$exchange"
    created_exchange=1
  fi
  if [[ ! -e $key_directory ]]; then
    install -d -m 0755 -o root -g root -- "$key_directory"
    created_key_directory=1
  fi
  if [[ ! -e $key_file ]]; then
    local key_temp
    key_temp=$(mktemp "$key_directory/.authorized_keys.XXXXXXXX")
    chmod 0644 "$key_temp"
    chown root:root "$key_temp"
    mv -T -- "$key_temp" "$key_file"
    created_key=1
  fi
  [[ $(path_state) == empty ]] || die 'exchange became active during apply'
  cmp -s "$config" "$backup/sshd_config" || die 'sshd configuration changed during apply'
  mv -T -- "$candidate" "$config"
  candidate=''
  changed_config=1
  "$sshd" -t -f "$config" >/dev/null 2>&1 || die 'installed sshd syntax failed'
  effective "$config" root > "$backup/root.after"
  effective "$config" stage1-r3-forward > "$backup/forward.after"
  effective "$config" "$account" > "$backup/evidence.after"
  cmp -s "$backup/root.before" "$backup/root.after" || die 'installed rule changes root SSH configuration'
  cmp -s "$backup/forward.before" "$backup/forward.after" || die 'installed rule changes forward SSH configuration'
  cmp -s "$backup/evidence.candidate" "$backup/evidence.after" || die 'installed evidence rule drifted'
  systemctl reload sshd || die 'sshd reload failed'
  [[ $(account_state) == exact && $(path_state) == empty && $(config_state) == exact ]] || die 'post-reload state differs'
  trap - EXIT
  printf 'READY: applied exact account/Match; backup=%s\n' "$backup"
}

[[ $# == 1 ]] || die 'usage: stage1-r3-evidence-account.sh check|check-idle|apply'
case $1 in
  check) check ;;
  check-idle) check_idle ;;
  apply) apply ;;
  *) die 'usage: stage1-r3-evidence-account.sh check|check-idle|apply' ;;
esac
