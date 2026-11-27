#!/bin/sh
# getty-bun.sh: the POSIX starter of Getty's Bun runtime (Linux).
#
#   sh <root>/bootstrap/getty-bun.sh run <entry> [args...]   ensure, then exec the pinned Bun
#   sh <root>/bootstrap/getty-bun.sh ensure                  install the pinned Bun if missing
#   sh <root>/bootstrap/getty-bun.sh status                  one JSON object on stdout
#
# Contract: bootstrap/README.md and docs/plan.md in getty-bun. stdout belongs to the
# entry; every starter failure is one "getty-bun: " line on stderr and exit 1.
#
# >>> getty-bun pin: generated, do not edit >>>
# version 1.4.5
# target linux-x64 bun-linux-x64.zip 94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb bun-linux-x64/bun
# target linux-x64-baseline bun-linux-x64-baseline.zip dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463 bun-linux-x64-baseline/bun
# target linux-aarch64 bun-linux-aarch64.zip 18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84 bun-linux-aarch64/bun
# target windows-x64 bun-windows-x64.zip 815ab45ec7f549abf87e6869584b506eab088e24225683957b7e150b47d6de30 bun-windows-x64/bun.exe
# target windows-x64-baseline bun-windows-x64-baseline.zip 3c081c73865e7a3453a9d514cc2ba3d699880621bcf67bb17241ff5194cb1d4b bun-windows-x64-baseline/bun.exe
# <<< getty-bun pin <<<

default_mirror=https://github.com/oven-sh/bun/releases/download
nl='
'

fail() {
  printf 'getty-bun: %s\n' "$1" >&2
  exit 1
}

usage() {
  fail "usage: getty-bun.sh run <entry> [args...] | ensure | status"
}

# Under Git Bash, MSYS2 and Cygwin the PowerShell starter owns the slot and its lock, so
# this starter hands every call to the getty-bun.ps1 next to it, arguments unchanged, by
# exec: exit code, stdin, stdout and stderr are PowerShell's. The one exception is a stdin
# that is a character device but no terminal (/dev/null, but also /dev/zero, /dev/urandom,
# /dev/full or /dev/clipboard, which PowerShell then reads as empty input): PowerShell
# gets an empty pipe instead, and its exit code becomes this shell's. Must not return.
forward_to_powershell() {
  _ps1=${0%.sh}.ps1
  [ -f "$_ps1" ] || fail "under $os this starter forwards to $(one_line "$_ps1"), which is missing"
  command -v cygpath >/dev/null 2>&1 || fail "under $os this starter needs cygpath to forward to $(one_line "$_ps1")"
  _ps1w=$(cygpath -w -a -- "$_ps1" 2>/dev/null) || _ps1w=
  [ -n "$_ps1w" ] || fail "cygpath cannot convert $(one_line "$_ps1") to a Windows path"
  # Windows PowerShell 5.1 by its fixed path; SYSTEMROOT is a Windows path.
  _ps=
  _sr=${SYSTEMROOT:-${SystemRoot-}}
  if [ -n "$_sr" ]; then
    _sr=$(cygpath -u -- "$_sr" 2>/dev/null) || _sr=
  fi
  if [ -n "$_sr" ] && [ -x "$_sr/System32/WindowsPowerShell/v1.0/powershell.exe" ]; then
    _ps=$_sr/System32/WindowsPowerShell/v1.0/powershell.exe
  else
    _ps=$(command -v powershell.exe 2>/dev/null) || _ps=$(command -v pwsh.exe 2>/dev/null) || _ps=
  fi
  if [ -z "$_ps" ] || [ ! -x "$_ps" ]; then
    fail "under $os this starter needs Windows PowerShell: no executable \$SYSTEMROOT/System32/WindowsPowerShell/v1.0/powershell.exe, powershell.exe or pwsh.exe on PATH"
  fi
  # A POSIX GETTY_HOME becomes the Windows path PowerShell needs; an empty or relative one
  # passes unchanged, so getty-bun.ps1 rejects it as getty-bun.sh would.
  case ${GETTY_HOME-} in
    /*)
      _gh=$(cygpath -w -- "$GETTY_HOME" 2>/dev/null) || _gh=
      [ -n "$_gh" ] || fail "cygpath cannot convert GETTY_HOME '$(one_line "$GETTY_HOME")' to a Windows path"
      GETTY_HOME=$_gh
      export GETTY_HOME
      ;;
  esac
  # No MSYS path conversion of the arguments. Both variables reach PowerShell, Bun and the
  # entry (bootstrap/README.md, "Windows starter").
  MSYS_NO_PATHCONV=1
  MSYS2_ARG_CONV_EXCL='*'
  export MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL
  # Under MSYS a native program whose stdin is /dev/null (MSYS's name for a NUL handle, as
  # Bun's stdin "ignore" gives) may block reading it; an empty pipe reads as end of input
  # (bootstrap/README.md, "Limit: Git Bash with a NUL stdin"). So a stdin that is a
  # character device but no terminal becomes an empty pipe; a terminal, pipe, file or
  # closed stdin still goes to PowerShell by exec.
  if [ ! -t 0 ] && [ -c /dev/stdin ]; then
    # Nothing to clean up here, and the signal trap's message would be wrong once Bun runs.
    trap - EXIT HUP INT TERM
    : | "$_ps" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$_ps1w" "$@"
    exit $?
  fi
  exec "$_ps" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$_ps1w" "$@"
}

# Staging and the .installing record of this process; removed on every exit.
stage=
installing=
on_exit() {
  if [ -n "$stage" ]; then rm -rf -- "$stage" 2>/dev/null; fi
  if [ -n "$installing" ]; then rm -f -- "$installing" "$installing.$$" 2>/dev/null; fi
  stage=
  installing=
}
trap on_exit EXIT
# Clean up before the message: stderr may already be gone when a host kills the hook.
trap 'on_exit; fail "stopped by a signal before Bun started"' HUP INT TERM

# --- target ------------------------------------------------------------------------

unsupported() {
  fail "unsupported target $1${2:+ ($2)}: getty-bun.sh supports linux-x64, linux-x64-baseline and linux-aarch64"
}

# First CPU's flags line only; no subprocess.
has_avx2() {
  [ -r /proc/cpuinfo ] || return 1
  while IFS= read -r _l; do
    case $_l in
      flags*:*)
        case " ${_l#*:} " in *" avx2 "*) return 0 ;; esac
        return 1
        ;;
    esac
  done </proc/cpuinfo
  return 1
}

detect_target() {
  case $mach in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) arch=$mach ;;
  esac
  if [ "$os" != Linux ]; then
    unsupported "$(printf '%s' "$os" | tr '[:upper:]' '[:lower:]')-$arch"
  fi
  case $arch in
    x64) _ld=/lib64/ld-linux-x86-64.so.2 ;;
    aarch64) _ld=/lib/ld-linux-aarch64.so.1 ;;
    *) unsupported "linux-$arch" ;;
  esac
  if [ ! -e "$_ld" ]; then
    for _f in /lib/ld-musl-*.so.1; do
      if [ -e "$_f" ]; then unsupported "linux-$arch-musl" "musl libc $_f, no glibc $_ld"; fi
    done
  fi
  target=linux-$arch
  if [ "$arch" = x64 ] && ! has_avx2; then target=linux-x64-baseline; fi
}

# --- pin ---------------------------------------------------------------------------

# The pin block of this file (format: bootstrap/README.md), for the detected target.
read_pin() {
  pin_version='' pin_archive='' pin_sha256='' pin_member='' _in=''
  [ -r "$0" ] || fail "cannot read the starter $0 to find its pin"
  while IFS= read -r _l; do
    case $_l in
      '# >>> getty-bun pin: generated, do not edit >>>') _in=1 ;;
      '# <<< getty-bun pin <<<') if [ -n "$_in" ]; then break; fi ;;
      '# version '*) if [ -n "$_in" ]; then pin_version=${_l#'# version '}; fi ;;
      "# target $target "*)
        if [ -n "$_in" ]; then
          _r=${_l#"# target $target "}
          pin_archive=${_r%% *}
          _r=${_r#* }
          pin_sha256=${_r%% *}
          pin_member=${_r#* }
        fi
        ;;
    esac
  done <"$0"
  [ -n "$_in" ] || fail "no pin block in $0"
  [ -n "$pin_version" ] || fail "the pin block in $0 has no version line"
  [ -n "$pin_member" ] || fail "the pin block in $0 has no line for target $target"
}

# --- slot --------------------------------------------------------------------------

# state: ready (receipt version and target match the pin, bin/bun is a non-empty
# executable), missing (no slot), mismatch (anything else). Reads the first three lines
# of the canonical receipt (bootstrap/README.md); no JSON parse, no hashing, no Bun start.
# An empty bin/bun would "run" as an empty script with exit 0, so it is a mismatch.
slot_state() {
  if [ ! -e "$slot" ] && [ ! -L "$slot" ]; then
    state=missing
    return 0
  fi
  state=mismatch
  if [ ! -f "$slot/receipt.json" ] || [ ! -r "$slot/receipt.json" ] ||
    [ ! -f "$slot/bin/bun" ] || [ ! -x "$slot/bin/bun" ] || [ ! -s "$slot/bin/bun" ]; then
    return 0
  fi
  _r1='' _r2='' _r3=''
  {
    IFS= read -r _r1
    IFS= read -r _r2
    IFS= read -r _r3
  } <"$slot/receipt.json"
  if [ "$_r1" = "{" ] &&
    [ "$_r2" = "  \"version\": \"$pin_version\"," ] &&
    [ "$_r3" = "  \"target\": \"$target\"," ]; then
    state=ready
  fi
  return 0
}

fail_mismatch() {
  fail "slot $slot does not match the pin $pin_version $target (receipt.json or bin/bun); it is left untouched, remove it to reinstall"
}

ensure_slot() {
  slot_state
  case $state in
    ready) return 0 ;;
    mismatch) fail_mismatch ;;
  esac
  install
}

# --- install -----------------------------------------------------------------------

need_tools() {
  for _t in flock unzip mktemp; do
    command -v "$_t" >/dev/null 2>&1 || fail "$_t not found on PATH; it is needed to install Bun into $slot"
  done
  if command -v sha256sum >/dev/null 2>&1; then
    hasher=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    hasher=shasum
  else
    fail "neither sha256sum nor shasum found on PATH; one is needed to install Bun into $slot"
  fi
  if command -v curl >/dev/null 2>&1; then
    fetcher=curl
  elif command -v wget >/dev/null 2>&1; then
    fetcher=wget
  else
    fail "neither curl nor wget found on PATH; one is needed to install Bun into $slot"
  fi
}

one_line() {
  printf '%s' "$1" | tr '\n\r\t' '   '
}

# _h: the SHA256 of file $1.
sha256_of() {
  if [ "$hasher" = sha256sum ]; then
    _h=$(sha256sum 2>/dev/null <"$1") || fail "sha256sum failed on $1"
  else
    _h=$(shasum -a 256 2>/dev/null <"$1") || fail "shasum -a 256 failed on $1"
  fi
  _h=${_h%% *}
}

# _json: $1 as a JSON string literal (callers reject control characters first).
json_string() {
  _s=$1 _o=
  while :; do
    case $_s in
      *[\\\"]*) ;;
      *) break ;;
    esac
    _p=${_s%%[\\\"]*}
    _c=${_s#"$_p"}
    _c=${_c%"${_c#?}"}
    _o=$_o$_p\\$_c
    _s=${_s#"$_p"?}
  done
  _json=\"$_o$_s\"
}

install() {
  need_tools
  mkdir -p -- "$lock_dir" 2>/dev/null || fail "cannot create the lock directory $lock_dir"
  (: >>"$lock") 2>/dev/null || fail "cannot open the lock file $lock"
  # The lock is held only inside this group: fd 9 closes when the group ends, before
  # any exec of Bun, so an entry never inherits it.
  {
    install_locked
  } 9>>"$lock"
}

install_locked() {
  flock -x -w "$lock_wait" -E 3 9 2>/dev/null
  _rc=$?
  if [ "$_rc" -ne 0 ]; then
    slot_state
    if [ "$state" = ready ]; then return 0; fi
    if [ "$_rc" -eq 3 ]; then
      _see=
      if [ -f "$lock_dir/.installing" ]; then _see="; see $lock_dir/.installing"; fi
      fail "timed out after $lock_wait s waiting for the install lock $lock$_see"
    fi
    fail "cannot lock $lock (flock exit $_rc)"
  fi
  # Another process may have published while this one waited.
  slot_state
  case $state in
    ready) return 0 ;;
    mismatch) fail_mismatch ;;
  esac

  mkdir -p -- "$staging_root" 2>/dev/null || fail "cannot create the staging directory $staging_root"
  stage=$(mktemp -d "$staging_root/XXXXXXXX" 2>/dev/null) || {
    stage=
    fail "cannot create a staging directory in $staging_root"
  }
  write_installing

  url=$mirror/bun-v$pin_version/$pin_archive
  archive_file=$stage/archive.zip
  # -q (first) and --no-config: no ~/.curlrc or wgetrc changes the download.
  if [ "$fetcher" = curl ]; then
    _err=$(curl -q -fsS -L --connect-timeout 30 --speed-limit 1024 --speed-time 60 \
      -o "$archive_file" "$url" 2>&1 9>&-)
  else
    _err=$(wget --no-config -q -T 60 -O "$archive_file" "$url" 2>&1 9>&-)
  fi
  _rc=$?
  [ "$_rc" -eq 0 ] || fail "download of $url failed ($fetcher exit $_rc): $(one_line "$_err")"

  sha256_of "$archive_file"
  [ "$_h" = "$pin_sha256" ] ||
    fail "checksum mismatch for $url: sha256 $_h, pinned $pin_sha256; nothing was published"

  check_members
  mkdir -p -- "$stage/slot/bin" 2>/dev/null || fail "cannot create $stage/slot/bin"
  unzip -p "$archive_file" "$pin_member" 2>/dev/null >"$stage/slot/bin/bun" 9>&- ||
    fail "cannot extract $pin_member from $url"
  chmod 755 "$stage/slot/bin/bun" 2>/dev/null || fail "cannot chmod $stage/slot/bin/bun"

  # The same isolation as the entry's start below (main unsets BUN_OPTIONS and others).
  _v=$("$stage/slot/bin/bun" --config=/dev/null --no-env-file --version 2>/dev/null 9>&-) ||
    fail "the Bun from $url does not run ($stage/slot/bin/bun --version failed); nothing was published"
  [ "$_v" = "$pin_version" ] ||
    fail "version mismatch: the Bun from $url reports '$(one_line "$_v")', pinned $pin_version; nothing was published"

  sha256_of "$stage/slot/bin/bun"
  _now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{\n  "version": "%s",\n  "target": "%s",\n  "archiveSha256": "%s",\n  "contractVersion": 1,\n  "archive": "%s",\n  "member": "%s",\n  "binarySha256": "%s",\n  "executable": "bin/bun",\n  "verifiedAt": "%s"\n}\n' \
    "$pin_version" "$target" "$pin_sha256" "$pin_archive" "$pin_member" "$_h" "$_now" \
    2>/dev/null >"$stage/slot/receipt.json" || fail "cannot write $stage/slot/receipt.json"

  mkdir -p -- "$bun_root/$pin_version" 2>/dev/null || fail "cannot create $bun_root/$pin_version"
  if [ -e "$slot" ] || [ -L "$slot" ]; then
    fail "slot $slot appeared during the install; it is left untouched"
  fi
  mv -- "$stage/slot" "$slot" 2>/dev/null || fail "cannot publish $slot (rename from $stage failed)"

  on_exit
}

# The archive holds exactly the member plus directory entries of its parents.
check_members() {
  _list=$(unzip -Z1 "$archive_file" 2>/dev/null 9>&-) ||
    fail "cannot list the entries of the archive from $url (unzip -Z1 failed)"
  _found=0
  _rest=$_list$nl
  while [ -n "$_rest" ]; do
    _e=${_rest%%"$nl"*}
    _rest=${_rest#*"$nl"}
    if [ "$_e" = "$pin_member" ]; then
      _found=$((_found + 1))
      continue
    fi
    case $_e in
      */) case $pin_member in "$_e"?*) continue ;; esac ;;
    esac
    fail "unexpected entry '$(one_line "$_e")' in the archive from $url (expected only $pin_member)"
  done
  [ "$_found" -eq 1 ] ||
    fail "the archive from $url holds the member $pin_member $_found times, expected once"
}

# Diagnostics for a waiter; never ownership (installation-locking.md).
write_installing() {
  installing=$lock_dir/.installing
  _comm=sh _start=null _env=null
  if [ -r "/proc/$$/comm" ]; then IFS= read -r _comm <"/proc/$$/comm"; fi
  if [ -r "/proc/$$/stat" ] && [ -r /proc/sys/kernel/random/boot_id ]; then
    IFS= read -r _stat <"/proc/$$/stat"
    IFS= read -r _boot </proc/sys/kernel/random/boot_id
    set -f
    # shellcheck disable=SC2086 # split the fields after "(comm) "; field 22 is starttime
    set -- ${_stat##*) }
    set +f
    if [ "$#" -ge 20 ]; then
      shift 19
      _start="\"boot:$_boot/start-ticks:$1\""
    fi
  fi
  if [ -r /proc/sys/kernel/hostname ]; then
    IFS= read -r _host </proc/sys/kernel/hostname
    json_string "$_host/linux/uid-$(id -u 2>/dev/null)"
    _env=$_json
  fi
  json_string "$_comm"
  printf '{\n  "schemaVersion": 1,\n  "pid": %s,\n  "processName": %s,\n  "processStartToken": %s,\n  "installId": "%s",\n  "environmentId": %s,\n  "requestedVersion": "%s",\n  "target": "%s"\n}\n' \
    "$$" "$_json" "$_start" "${stage##*/}" "$_env" "$pin_version" "$target" \
    2>/dev/null >"$installing.$$" || fail "cannot write $installing.$$"
  mv -f -- "$installing.$$" "$installing" 2>/dev/null || fail "cannot write $installing"
}

# --- main --------------------------------------------------------------------------

# BUN_OPTIONS adds flags to every Bun start, --preload included and even past --config,
# and the cwd of a hook is the user's project. The others, untouched by --config, load
# code or move it outside the plugin: BUN_INSPECT_PRELOAD (preload), BUN_INSPECT*
# (debugger), NODE_PATH (module path), env-chosen code caches, and a macOS webview host
# that replaces the entry.
# Removed here, before the Git Bash forwarding, so neither the staging probe nor the
# entry, nor PowerShell's Bun, sees them.
unset BUN_OPTIONS BUN_INSPECT_PRELOAD BUN_INSPECT BUN_INSPECT_CONNECT_TO NODE_PATH \
  NODE_COMPILE_CACHE BUN_RUNTIME_TRANSPILER_CACHE_PATH BUN_INTERNAL_WEBVIEW_HOST

_u=$(uname -sm 2>/dev/null) || fail "uname failed"
os=${_u%% *}
mach=${_u##* }
case $os in
  MINGW* | MSYS* | CYGWIN* | *_NT-*) forward_to_powershell "$@" ;;
esac

cmd=${1-}
case $cmd in
  run)
    [ "$#" -ge 2 ] || fail "usage: getty-bun.sh run <entry> [args...]"
    entry=$2
    shift 2
    ;;
  ensure | status) [ "$#" -eq 1 ] || usage ;;
  *) usage ;;
esac

if [ -n "${GETTY_HOME+set}" ]; then
  home=$GETTY_HOME
  case $home in
    /*) ;;
    *) fail "GETTY_HOME must be an absolute path, got '$(one_line "$home")'" ;;
  esac
else
  case ${HOME-} in
    /*) home=$HOME/.getty ;;
    *) fail "HOME is not an absolute path; set GETTY_HOME to an absolute path" ;;
  esac
fi
case $home in
  *[[:cntrl:]]*) fail "GETTY_HOME contains control characters" ;;
esac
while :; do
  case $home in
    / | *[!/]) break ;;
    *) home=${home%/} ;;
  esac
done

lock_wait=${GETTY_BUN_LOCK_WAIT-300}
case $lock_wait in
  '' | *[!0-9]*) fail "GETTY_BUN_LOCK_WAIT must be a whole number of seconds, got '$(one_line "$lock_wait")'" ;;
esac
mirror=${GETTY_BUN_MIRROR:-$default_mirror}
mirror=${mirror%/}

detect_target
read_pin

bun_root=${home%/}/runtimes/bun # GETTY_HOME=/ gives /runtimes, not //runtimes
slot=$bun_root/$pin_version/$target
lock_dir=$bun_root/.locks/$pin_version/$target
lock=$lock_dir/.install.lock
staging_root=$bun_root/.staging

case $cmd in
  status)
    slot_state
    json_string "$slot"
    printf '{"pin":"%s","target":"%s","slot":%s,"state":"%s"}\n' "$pin_version" "$target" "$_json" "$state"
    exit 0
    ;;
  ensure)
    ensure_slot
    exit 0
    ;;
esac

# run: the consumer root is the parent of this starter's directory, never the cwd.
case $0 in
  */*) _d=${0%/*} ;;
  *) _d=. ;;
esac
self_dir=$(CDPATH='' cd -- "$_d" 2>/dev/null && pwd) || fail "cannot locate the directory of $0"
root=${self_dir%/*}
case $root in
  *[[:cntrl:]]*) fail "the consumer root $self_dir/.. contains control characters" ;;
esac
ensure_slot
[ -x "$slot/bin/bun" ] || fail_mismatch
# The cwd stays the caller's (the SDK reports it), so Bun must not read its project files:
# --config=/dev/null replaces bunfig.toml (preload, [define]) with an empty config; a
# missing --config file would exit 1 like an entry, and /dev/null exists everywhere,
# with nothing to create. --no-env-file skips .env, .env.local, .env.<NODE_ENV>.
# BUN_OPTIONS and the variables beside it are unset in main. Entry arguments follow the
# entry path untouched.
exec "$slot/bin/bun" --no-install --config=/dev/null --no-env-file "$root/$entry" "$@"
