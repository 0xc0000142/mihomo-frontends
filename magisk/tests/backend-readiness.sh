#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "${0%/*}/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
mkdir -p "$TEST_DIR/scripts"
for script in common.sh policy-lib.sh; do
  tr -d '\r' <"$ROOT/scripts/$script" >"$TEST_DIR/scripts/$script"
done
MODDIR=$TEST_DIR
SCRIPTS=$TEST_DIR/scripts
MIHOMO_DATA=$TEST_DIR/data
MIHOMO_START_TIMEOUT=3
. "$SCRIPTS/common.sh"
. "$SCRIPTS/policy-lib.sh"
ensure_dirs
printf 'test source\n' >"$CONFIG"
printf '#!/bin/sh\nexit 0\n' >"$BIN"
chmod +x "$BIN"
policy_render() { cp "$1" "$2"; }
validate_runtime() { return 0; }
pid_alive() { [ -f "$RUN_DIR/mock-running" ]; }
stop_core() { rm -f "$RUN_DIR/mock-running"; touch "$RUN_DIR/mock-stopped"; }
tool() {
  case "$1" in
    setsid) touch "$RUN_DIR/mock-running" ;;
    curl)
      if [ "$6" != "$CONTROL_SOCKET" ] || [ "$7" != http://localhost/ebpf ]; then
        echo 'wrong readiness endpoint' >&2; return 1
      fi
      case "$(cat "$RUN_DIR/mock-response")" in
        missing) return 22 ;;
        empty) printf '{"inbounds":[]}\n' ;;
        ready) printf '{"inbounds":[{"id":1,"mode":"local"}]}\n' ;;
      esac
      ;;
    *) return 127 ;;
  esac
}
for response in missing empty ready; do
  printf '%s\n' "$response" >"$RUN_DIR/mock-response"
  rm -f "$RUN_DIR/mock-running" "$RUN_DIR/mock-stopped"
  if start_core >"$TEST_DIR/result" 2>&1; then
    [ "$response" = ready ] || { echo "FAIL: accepted $response /ebpf"; exit 1; }
    test -f "$RUN_DIR/mock-running"
  else
    [ "$response" != ready ] || { cat "$TEST_DIR/result"; exit 1; }
    test -f "$RUN_DIR/mock-stopped"
    test ! -f "$RUN_DIR/mock-running"
    grep -q '/ebpf' "$TEST_DIR/result"
  fi
done
echo 'PASS: real start_core rejects missing/empty /ebpf and accepts nonempty (process/network mocked)'
