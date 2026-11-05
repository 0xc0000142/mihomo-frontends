# Backend policy contract

Run `sh magisk/tests/backend.sh` with POSIX sh, Git Bash or BusyBox ash. The suite
uses an isolated temporary module and stubs process launch/locking; it does not
contact a device, execute a downloaded core, or test real eBPF/kernel behavior.
`sh magisk/tests/backend-process.sh` separately checks real stale/foreign PID
rejection and inherited-FD closure without launching any proxy process.
`sh magisk/tests/backend-readiness.sh` exercises the actual startup readiness
loop with mocked process/network tools: absent or empty `/ebpf` must stop the
service and fail; a nonempty diagnostic list succeeds.

- `sh policy.sh get`: JSON with `ok`, boolean `autostart`/`tethering`/`allowed`,
  comma-delimited `tethering_interfaces`, newline-delimited `bypass_packages` and
  `wifi_ssids`, `wifi_mode` (`off`, `only`, `exclude`), and `current_ssid`.
- `sh policy.sh set AUTO TETHER INTERFACES_B64 PACKAGES_B64 WIFI_MODE SSIDS_B64`:
  switch values are `0` or `1`; empty interfaces selects
  `ap0,wlan1,rndis0,usb0,bt-pan`. Returns `{"ok":true}` or an error JSON/nonzero
  exit. Settings are committed together. A running service is restarted or
  paused; a stopped service is not started by saving settings.
- SSID comparison is literal, case-sensitive, and whitespace-preserving. Blank
  lines do not match a disconnected station. `only` denies no connection;
  `exclude` allows it. Inputs use LF-delimited UTF-8 text, no control characters,
  max 32 bytes per SSID. Ambiguous/unrecognized Wi-Fi status means disconnected.
- Manual `start`/`restart` sets a per-boot manual intent. SSID denies pause it;
  an allowed SSID resumes it even if autostart is off. Manual `stop` cancels
  intent, including autostart, until an explicit start or the next boot.
  Autostart only establishes automatic intent at boot; merely enabling the
  setting never starts a manually stopped service. Disabling a module stops it.
  Turning autostart off only affects the next boot, not existing automatic
  intent. `mihomo.sh status` adds `desired` (`manual`, `auto`, `stopped`),
  `allowed` and `current_ssid` alongside the original process fields.
- `apply.sh BASE64 restart` explicitly applies and starts, including when stopped
  (SSID still gates actual startup). Omitting `restart` only saves the source.
  Failure restores the old source and previous running/stopped intent.
  The command interface currently limits base64 configurations to 120000 bytes;
  the caller must reject oversized arguments before invoking Android `sh`.
- The source YAML remains untouched by policy. Runtime is `run/config.yaml`,
  passed with `-f`. Supported: exactly one explicit block-style `ebpf` listener,
  normal unquoted mapping keys, block role mappings, scalar/flow scalar lists.
  Multiple listeners (including mixed non-eBPF listeners), flow listeners,
  listener anchors/aliases/merges/tags, multiline scalars, duplicate keys and
  YAML documents/directives are rejected, rather than partially applying policy.
  Non-listener sections, including their anchors, are copied unchanged.
- The policy owns mode (`local`/`hybrid`), local DNS `respect_policy`,
  `local.exclude-package` and `shared.interface`. Existing values in these
  managed fields are replaced in runtime only. Role enable/enabled selectors
  are removed to avoid conflicting with mode. Other supported fields survive.
- Package bypass requires an Android core when installed. Actual support is
  checked on startup, not through a `with_ebpf` version tag. Readiness requires
  a nonempty `/ebpf` response on a private controller Unix socket. The socket is
  inside root-only `run` and does not change the user's TCP controller/secret.
- Android entrypoints re-execute the installed KSU/Magisk/APatch BusyBox ash with
  standalone mode. Locks use `flock -n` on an inherited FD with bounded retry,
  released automatically on exit. Spawned core/watch processes close unrelated
  lock FDs and detach with `setsid` and all standard streams redirected.
- PID records contain PID and Linux process start ticks. Signals also verify
  executable identity and exact `-d`/runtime `-f` arguments; arbitrary stale or
  legacy PID files never trigger name-based killing.

Device integration still needs real service boot, module disable, Wi-Fi changes,
hotspot interface availability, missing/failed eBPF attachment, and real process
exit/rollback verification. Interface defaults are candidates, not a guarantee
that every Android build exposes each interface. Forced SIGKILL may prevent
the core from restoring Android netd BPF hooks; normal shutdown is preferred.
