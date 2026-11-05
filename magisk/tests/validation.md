# Magisk / KernelSU validation

## Environment

- Date: 2026-11-04.
- Source core: `liuran001/mihomo`, commit `e272b9d2`.
- Host: `baka@10.0.0.88`, `/Volumes/data/HyperOS-AVD`.
- Guest: `emulator-5580`, HyperOS 4 / Android 17, arm64, kernel `6.6.66-android15-8`, KernelSU `v3.3.0 (32601-2)`, SELinux Enforcing.
- Release core downloaded by the module: `alpha-smart-e272b9d-ebpf`, Android arm64, Go 1.26.10.
- A separate locally compiled Android arm64 core with `with_gvisor with_ebpf` also passed basic cgroup interception.

No existing mihomo module or data directory was present before installation. Other installed modules were left unchanged.

## Automated regression

```sh
node --test magisk/tests/frontend.test.js
sh magisk/tests/core.test.sh
sh magisk/tests/backend.sh
sh magisk/tests/backend-process.sh
sh magisk/tests/backend-readiness.sh
```

The frontend suite exercises the actual application JavaScript with mocked DOM and native bridge. Backend pure tests cover settings, SSID parsing/matching, rendering, input rejection, apply/restore rollback and service intent. Locking and process launch are mocked only in the portable backend suite; the device tests below exercise real KernelSU locks, processes and eBPF.

## Earlier backend / HTML WebUI device results

| Check | Observed result |
| --- | --- |
| Install ZIP with `ksud module install` | Installed successfully; boot activation and script permissions verified |
| Release download | `/releases/latest` is 404; falls back to latest prerelease and downloads the Android arm64 asset successfully |
| Startup readiness | `/ebpf` on the private controller socket reports a nonempty cgroup inbound |
| Local interception | With `MATCH,REJECT`, shell curl to `http://1.1.1.1` changes from HTTP 301 to empty reply / HTTP 000 |
| Package bypass | Adding `com.android.shell` resolves UID 2000 and restores HTTP 301 while the core continues running |
| Tethering off/on/off | Downstream namespace traffic through veth `mh-test0`: HTTP 301 → rejected / HTTP 000 → HTTP 301 |
| Exact SSID deny | `exclude` + `AndroidWifi` stops interception and reports `allowed:false` |
| Exact SSID allow | `only` + `AndroidWifi` resumes the previously requested service |
| Actual Wi-Fi disconnect/reconnect | Under `only`, disabling Wi-Fi pauses the core; reconnecting resumes it automatically |
| Manual stop | Saving settings and waiting for polling does not restart a manually stopped service |
| Autostart on | Real guest reboot starts the core with automatic intent |
| Autostart off | Turning it off preserves the current service; another real reboot leaves the core stopped |
| Module disable | `ksud module disable mihomo-ebpf` causes the watcher to stop the core; re-enabling does not unexpectedly start it |
| Runtime failure rollback | An invalid eBPF data plane passes the core's configuration test but fails attachment; readiness detects the failure, returns an error, restores the exact source checksum and restarts the previous core |
| Native WebUI | Opened from KernelSU; overview renders real process state/version/controller, and settings show persisted package/SSID/shared-interface values |
| Android shell compatibility | WebUI-style `sh ...` re-executes BusyBox ash; bounded `flock -n` works with the installed BusyBox, unlike unsupported `flock -w` or mksh-inherited FDs |
| Windows package | ZIP entries use `/`, UTF-8 without BOM and LF, with no development server or test code included |

## Compose Miuix UI review (2026-11-05)

- `wasmJsBrowserDistribution` compiles the actual Miuix 0.9.4 Kotlin/Wasm UI. No legacy HTML/CSS UI is included in the ZIP.
- `node --test magisk/tests/bridge.test.js magisk/tests/frontend.test.js`: 90 tests pass. The second suite protects the legacy bridge behavior, not Compose rendering.
- `magisk/tests/webui-smoke.cjs` drives the production bundle with Playwright and an explicitly mocked bridge. It checks the application bottom sheet, cancel, help dialog, SSID save payload, dark mode and 320px layout. Screenshots go to `dist/ui-review/`. It requires Playwright (`PLAYWRIGHT_MODULE` optionally selects an existing installation), a Chromium executable (`CHROME_PATH` optional), and the production directory served at `http://127.0.0.1:8765` (`WEBUI_URL` optional). It does not install browser packages or start a server automatically.
- All non-local browser requests are blocked in this test. The full bundled Noto Sans CJK SC font renders Chinese without Google Fonts/CDN. An environment-injected Kaspersky script request is separately reported, blocked, and excluded from the application-resource assertion.
- Compose canvas owns pointer hit-testing; tests use positions from semantic bounds to click through the canvas, with settling time for Miuix overlay animations. After dismissing an overlay the tested Compose version can temporarily omit underlying accessibility nodes; subsequent test clicks use previously measured bounds. This does not establish screen-reader compatibility.
- The production WebUI was deployed to `/data/adb/modules/mihomo-ebpf/webroot` on the same HyperOS AVD, preserving the backend and all configuration. Native overview shows the installed core and stopped service. UI review does not repeat the earlier traffic-interception/reboot tests.
- Final AVD screenshots (`avd-overview.png`, `avd-settings.png`, `avd-apps.png` in `dist/ui-review/`) verify the safe-area layout, two-column interface selection and native application labels/icons in the selection sheet. The user category displayed 46 results; existing selections were retained. Bottom navigation and sheet cancel/confirm controls are above the gesture bar. No settings were saved and the proxy service was not started during this visual pass.
- On this specific AVD, a Vulkan Manager process repeatedly produces a blank WebGL surface and Chromium shared-image/fence errors. Temporarily setting `debug.hwui.renderer=skiagl` only while launching the Manager, then restoring its original `skiavk` value, yields visible UI. Repeating Vulkan/OpenGL launch reproduces blank/visible results. The property is global during that short test window; the module never applies this workaround. Manager restart on that AVD needs the test workaround again. This is not a general device fix.
- The old canvas pixel probe was removed: it reported transparency even while UI was visibly rendered and cannot be used as proof of drawing failure. Debug overlays and the red test block are not shipped.

## Scope and reproduction cautions

- Tethering was verified with a real network namespace/veth forwarding path, not a physical Wi-Fi hotspot client or USB/Bluetooth peripheral. OEM tethering offload and interface naming still need hardware-specific validation.
- Tests used a synthetic reject policy, not a user's subscription or a live upstream proxy account. IPv6 forwarding was not covered by this AVD scenario.
- `avd-tethering.sh` is specific to this disposable AVD and `fixtures/android.yaml`. It temporarily creates a namespace, veth, routes, forwarding and iptables rules to simulate a downstream client, and cleans up its own network state. The production module does not install these iptables rules. Do not run the script on a production phone or with unrelated routing table 109 rules.
- Settings support a single block-style eBPF listener. Unsupported YAML is rejected explicitly; see `backend-contract.md`.
- The AVD is left with the module installed but service/autostart disabled. A minimal DIRECT smoke-test configuration remains, not a subscription configuration.

## v1.2.0 on HyperOS AVD (2026-11-05)

Device: `emulator-5580` HyperOS 4 / Android 17, kernel 6.6.66 (BTF, cgroup2), KernelSU 32601, core `alpha-smart-e272b9d-ebpf`. Data was backed up to `HyperOS-AVD/tmp/mihomo-test/backup-before-v1.2.0.tgz` and the original `config.yaml`, service state and Manager settings were restored afterwards.

- `ksud module install` of the v1.2.0 zip keeps the existing config; `customize.sh` only appends missing settings keys (existing `autostart=0`, `tethering=1` kept).
- `tests/device-check.sh` (root shell): `host.sh probe`, a 288000-byte stage round trip in 96000-byte chunks, `fetch` of a 143 KB GitHub config, rejection of `file://`.
- Real WebView checks went through CDP (`tests/cdp-eval.mjs`, with Manager's WebView debugging enabled temporarily via `tests/avd-webdebug.sh`):
  - `tests/device-flow.js`: MetaCubeX example config → analyze (54 proxies, 20 listeners) → optimize → idempotent re-run with no required changes. The example itself fails `mihomo -t` because of placeholder values (`server: [YOUR_SERVER_IP]`) and `/path/to/ui`, so that pass is not a validation pass.
  - `tests/device-flow-template.js`: subscription → built-in template → optimize, and a router-style config (tproxy, TUN, absolute `/etc/openclash` paths, `PROCESS-NAME`) → optimize. Both pass `mihomo -t` on the device.
  - Applying the optimized template with restart started the core; `/ebpf` reported a hybrid inbound (cgroup + packet_rewrite) and the home page showed live traffic.
- UI driven via `tests/avd-ui.sh` (KernelSU WebUIActivity is not exported; launched from the Manager module list with the temporary `skiagl` workaround):
  - Wizard steps 1–3 with a real host probe and a real config URL.
  - Home, proxies (32 groups in config order, with delays), settings and the app picker with real packages and icons.
  - System back closes sheets, then returns to the previous page, and from home exits the WebUI.

Bugs found and fixed on device:
- Lists did not scroll by touch. WebView took the pan and sent `pointercancel`; fixed with `touch-action: none` on the Compose host.
- `importUrl` always failed. KernelSU runs commands in a persistent libsu shell, so a top-level `exit` reports failure; the command now runs in a subshell.
- Upstream detection found `dummy0` and IPv6 detection found a link-local route. Android uses per-network routing tables; detection now uses `ip route get`, and IPv6 requires a global source address.
- Imported configs with absolute paths were rejected by the core's SAFE_PATHS check. A required optimize step now rewrites them to relative paths.
- A URL pasted into the YAML box is now treated as a subscription.
- The overview no longer blanks values during refresh, and long core version strings are shortened.

Not covered: real hotspot/USB clients through the shared data plane, IPv6-capable networks, other OEM WebViews, and the wizard's apply step driven by touch (the same calls were exercised through CDP).

## Tailscale web login on HyperOS AVD (2026-11-05)

Same device and core. `config.yaml` and `settings.ini` were backed up to `HyperOS-AVD/tmp/mihomo-test/backup-before-tailscale.tgz` and restored afterwards; the `tailscale/` state directory created by the test was removed and the service was left stopped as before.

- Probe with an isolated core (`/data/local/tmp/tstest`, port 19190, `log-level: warning`, a tailscale outbound without `auth-key`): subscribing to `/logs?level=info` over plain HTTP and then requesting `/proxies/TS/delay` printed `To start this tsnet server, … go to: https://login.tailscale.com/a/…`. Before login `tailscaled.state` contains only `_machinekey`.
- Through CDP in the real WebView: `tailscale.add` → `validate` (real core) → `apply` with restart → `service start` → `tailscaleLogin` returned a login URL in 4.1 s and `qrCode` a 29×29 matrix. A second `tailscaleLogin` without restart returned no URL (tsnet prints it once), `restart` then `tailscaleLogin` returned a new URL, and `tailscaleLogout` stopped the core, removed the state directory, started it again and a new login URL was available.
- UI on device: Settings → Tailscale shows the outbound; 网页登录 without a fresh tsnet shows the restart hint, 重启服务后重新获取 shows the QR code and URL, 在浏览器打开 starts `com.android.browser` with the URL.

Not covered: completing a real Tailscale account login (needs the user's account), traffic to Tailnet peers after login, and the LuCI flow on a router (covered by backend tests with the real core and a frontend unit test only).
