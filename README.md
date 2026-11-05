# mihomo-frontends

mihomo（[liuran001/mihomo](https://github.com/liuran001/mihomo)，smart + eBPF 分支）核心 + 各平台前端封装。

```
shared/   平台无关的资源（配置模板等）
magisk/   Magisk / KernelSU 模块封装（KSU WebUI 管理界面）
luci/     OpenWrt LuCI 应用（luci-app-mihomo-ebpf）
```

## Magisk / KernelSU 模块（`magisk/`）

在 KernelSU / Magisk（带 WebUI 的分支）里刷入模块 zip，然后在模块列表点「WebUI」打开管理界面。

- **真实 Compose Miuix**：`magisk/webui` 是独立 Kotlin/Wasm + Compose Multiplatform 工程，使用 `top.yukonga.miuix.kmp:miuix-ui` 组件库，而非 CSS 仿制。发布包的 `webroot/` 完全来自该工程的 production distribution，不再混入旧 `magisk/webroot/`。
- **WebView 与离线字体**：需要支持 **WasmGC 的现代 Android System WebView**，只有传统 WebAssembly 支持并不足够；建议更新 WebView 和模块管理器。不提供旧 HTML 界面回退。界面与常用中文字体子集及 `FONT-LICENSE.txt` 随包分发；动态应用名、节点名中的生僻字或 emoji 超出子集时，Compose 仍可能请求在线备用字体，离线可能显示缺字。内核、订阅等下载仍需网络。
- **数据与模块分离**：内核、配置、备份、运行状态放 `/data/adb/mihomo`，模块目录只放脚本与 WebUI；更新模块不丢数据。
- **内核按需下载**：模块 zip 包含 WebUI 的 wasm、字体等二进制资源，但不含 mihomo 核心。打开 WebUI「内核」页，按设备架构（arm64 / x86_64）从 GitHub release 下载，支持镜像前缀与版本回滚。
- **安装预设**：首次刷入时写入默认设置（开机自启、GitHub 下载镜像 `https://ghfast.top/`、默认共享网卡），并检查内核版本、BTF 与 curl，不满足时在安装日志中提示。已有 `settings.ini` 的键不会被覆盖。
- **首次引导（5 步）**：没有配置时自动进入。① 检测本机（机型、Android/内核版本、eBPF/BTF/cgroup2、IPv6 出口、内存、当前网络）并一键下载内核；② 选择来源：订阅链接（下载后自动识别是完整 Clash/mihomo 配置还是节点订阅）或直接粘贴 YAML；③ 本机优化：列出每一项调整，必要项（eBPF 入站、关闭 TUN、DNS 与 53 端口接管、本机控制器）不可取消，推荐项可逐项取消；④ 运行偏好（自启、共享、立即启动）；⑤ 校验 → 备份并写入 → 保存设置 → 启动，逐步显示结果。可在「设置 → 重新运行向导」再次执行。
- **导入配置并按本机优化**：配置引擎（`webui/bridge/config.js`，基于 `yaml` 库）在 WebView 内解析 YAML，保留注释、锚点与合并键。优化项包括：生成或规范唯一的块格式 eBPF listener（保留原 local/shared 设置，自动选择 ipcidr 中国 IP 规则集做内核直连）；关闭 TUN；移除 `tproxy-port`、`routing-mark`、`interface-name` 等路由器专用字段；控制器改为只监听 `127.0.0.1` 并生成密钥；关闭 `allow-lan`；启用 DNS 并添加 `DST-PORT,53` 接管；无 IPv6 出口时关闭 IPv6；按规则是否使用 `PROCESS-NAME`/`UID` 决定进程查找；为 GEO 规则设置 jsDelivr 下载镜像，低于 6 GB 内存时使用省内存加载；降低日志级别、开启 TCP 并发、记住节点选择与域名嗅探。优化结果再经 `policy-yaml.awk` 渲染校验，可重复执行且结果稳定。
- **内核配置（对齐 LuCI）**：「设置 → 内核配置」按字段编辑 `config.yaml`：基础（运行模式、混合端口、局域网、监听地址、IPv6、日志、进程查找、TCP 并发、统一延迟、嗅探、记住节点、GEO 加载方式）、控制器与面板（地址、密钥、面板目录与下载地址、GeoIP/GeoSite/MMDB 地址、自动更新）、DNS（启用、监听、模式、AAAA、FakeIP 段、引导/默认/代理节点/直连服务器、FakeIP 过滤）、eBPF（协议、UDP 超时、内核直连规则集、FakeIP ICMP、TUN 共存、本机与共享的数据面/DNS/IPv6/私网直连、强制进入的地址段、直连端口、按 MAC/来源地址过滤），以及订阅与规则集的增删改（新订阅沿用已有锚点并加入引用全部订阅的策略组；被规则引用的规则集不能删除）。共享网卡、包名绕过与本机 DNS 模式仍由「设置」页策略生成，不在此重复。修改累积后统一「校验 → 写入」，可选择是否重启。
- **大配置写入**：超过单条命令参数上限（Base64 120000 字节）的配置会分段写入 `run/stage.b64` 后再校验/应用，支持最大 4 MB。
- **列表性能**：应用列表在打开选择器时才读取，图标按可见项加载、限并发并使用有界缓存，滚动时暂停解码；代理组按可见节点行加载，刷新保留列表。首次界面使用约 1.8 MB 的常用中文字体子集，不再包含完整 CJK 字体。`magisk/webui/subset-font.py` 可从许可文件所列源字体复现子集，需要 Python/fonttools。
- **写配置必先校验**：`mihomo -t` 通过后备份旧配置、原子替换、重启；启动失败自动回滚。备份保留最近 10 份，可一键恢复。
- **开机自启**：概览显示状态，「设置」页独立开关；关闭自启不影响当前手动启动的服务。启动不再依赖公网 ping。
- **网络共享代理**：「设置」页控制热点、USB、蓝牙共享是否进入 eBPF；默认关闭，只代理本机。开启后填写实际下联接口（默认 `ap0,wlan1,rndis0,usb0,bt-pan`），不要把正在上网的 `wlan0` 当成热点接口。
- **包名绕过**：一行一个 Android 包名，通过 `local.exclude-package` 排除应用 UID，DNS 使用 `respect_policy`。共享 UID 的应用会一起绕过；须使用 Android 版核心，不能用 Linux 版替代。
- **Wi-Fi / SSID 策略**：不限制、仅指定 SSID 时代理、指定 SSID 时暂停三种模式，SSID 一行一个且精确匹配。未连接 Wi-Fi 时「仅指定」暂停、「指定时暂停」允许。后台检测网络变化并暂停/恢复，手动停止后不会被轮询意外拉起。
- **源配置与运行配置分离**：编辑的是 `config.yaml`；模块生成 `/data/adb/mihomo/run/config.yaml` 叠加设备策略，启动前校验。当前支持一个显式块格式的 eBPF listener（向导默认格式）；多 listener、listener 内锚点/合并键等结构会明确报错。设置页管理本机/共享模式、接口、包名和本机 DNS 策略，不会静默忽略开关。
- **Miuix 界面规范**：所有页面使用大标题 `TopAppBar`（随滚动折叠）+ 回弹列表，设置项统一为 `SmallTitle` 分组的卡片与 `BasicComponent` / `SwitchPreference` / `ArrowPreference` / `WindowDropdownPreference` 行；选择与编辑使用 `WindowBottomSheet` / `WindowDialog`，未保存修改时底部出现「撤销 / 保存」条。底部导航为首页 / 代理 / 设置，其余页面以子页压栈，支持系统返回键。浅色与深色主题跟随系统。
- **设置交互**：共享网卡在底部弹窗中勾选，显示类型、是否在线与推荐标记；应用绕过提供名称/包名搜索、用户/系统/全部/已选分类与图标；Wi-Fi 条件可一键加入当前 SSID。刷新状态不覆盖未保存草稿，保存后回读校验。
- **性能**：首页仅在服务运行时每 3 秒轮询流量，连接页每 5 秒刷新且打开详情时暂停，离开页面即停止；代理组支持组测速（一次请求测完组内节点）并显示延迟；概览不再为取控制器地址读取整份配置。

功能对照 LuCI 版：概览、设备设置、代理切换与测速、连接管理、内核配置（基础/控制器/DNS/eBPF/订阅/规则集）、配置文件（校验/备份/回滚）、内核管理、首次引导与导入优化、日志。规则列表与策略组的逐条编辑仍需直接改 YAML 或使用 zashboard。

### 构建模块 zip

从仓库根目录执行。默认先在 `magisk/webui` 调用自带 Gradle Wrapper 的 `wasmJsBrowserDistribution`，再打包。需要 **JDK 17**（`JAVA_HOME` 或 `PATH` 指向本机已有 Java 17）；无需全局安装 Gradle，首次构建需联网下载 Wrapper、Kotlin/Compose/Miuix 和相关工具依赖。

```sh
sh magisk/build.sh           # POSIX shell + zip
pwsh -File magisk/build.ps1  # Windows / PowerShell 7，无需 zip 命令
```

产物均为仓库根目录 `dist/mihomo-ebpf-magisk-<版本>.zip`。脚本校验 `magisk/webui/build/dist/wasmJs/productionExecutable` 的入口 HTML/JS、桥接、模板、字体许可、非空 wasm 和离线中文字体，再将该目录完整映射到 ZIP 的 `webroot/`；旧 `magisk/webroot/` 不会被读取、覆盖或混入，Gradle 工程和测试代码也不会随包进入。字体、wasm 及其他 WebUI 资源逐字节复制；PowerShell 只对模块的 `.sh`、`.awk` 和 `module.prop` 做 UTF-8 无 BOM/LF 规范化，ZIP 路径使用正斜杠。Shell 构建应使用 LF 检出的模块脚本。

仅当已有对应源码的 production distribution 时，才显式跳过构建：

```sh
sh magisk/build.sh --skip-webui-build
pwsh -File magisk/build.ps1 -SkipWebUiBuild
```

跳过构建仍会校验产物，但不会检查其与当前源码是否一致，也不会更新模板；缺失或不完整时直接失败，不回退到旧页面。请勿手动把整个 `magisk/` 或旧 `magisk/webroot/` 压缩发布。脚本先创建临时包，成功后替换目标 ZIP；清理仅限根 `dist/` 下自身创建的临时文件/目录，PowerShell 在删除前校验绝对路径边界。

CI：push 或打 v* tag 会同时构建 Magisk zip 与 LuCI apk，tag 构建自动发 Release（见 `.github/workflows/build.yml`）。仅 Magisk job 安装 Java 17、配置 Gradle 缓存与 Wrapper 校验，显式构建 Wasm distribution 后以跳过构建选项打包；LuCI 的构建流程保持独立。

模板是单一来源：`shared/template.yaml` 是唯一维护副本，LuCI 通过 `luci/scripts/sync-template.sh` 同步，Magisk 通过 WebUI Gradle 的 `wasmJsProcessResources` 收入产物。

### 结构

```
magisk/
├── module.prop          # 模块声明
├── customize.sh         # 安装时校验架构与内核能力，写入默认设置
├── service.sh           # 开机意愿和 SSID 监控
├── post-fs-data.sh      # 建运行目录
├── scripts/
│   ├── common.sh        # 路径、settings.ini、工具函数
│   ├── mihomo.sh        # 进程管理（start/stop/restart/status/enable/disable）
│   ├── policy.sh        # 持久化设备设置、SSID 轮询和策略应用
│   ├── policy-lib.sh    # 运行配置生成、进程就绪检测和回滚
│   ├── core.sh          # 内核下载/信息/回滚/下载设置
│   ├── apply.sh         # 配置校验→备份→替换→重启，失败回滚（支持分段暂存）
│   ├── host.sh          # 本机探测、远程配置下载、大配置分段暂存
│   └── backup.sh        # 备份列表/读取/删除/恢复
├── webui/               # 独立 Compose Miuix Kotlin/Wasm 工程
│   ├── gradlew / gradlew.bat / gradle/wrapper/
│   ├── build.gradle.kts
│   ├── bridge/backend.js  # KSU bridge 与 shell/控制器接口
│   ├── bridge/config.js   # 配置引擎：字段清单、补丁、导入分析、本机优化
│   ├── bridge/vendor/     # yaml 2.9.1（ISC）浏览器打包
│   ├── src/               # Kotlin 界面、启动页与离线字体
│   └── build/dist/wasmJs/productionExecutable/
│                          # 全量映射到发布 ZIP 的 webroot/
└── webroot/             # 旧版 HTML/JS，仅保留源码，不参与发布
```

WebUI 通过 `ksu.exec` 调 `scripts/` 下的 shell 脚本做文件与进程操作；节点切换、连接管理通过 root shell 的 `curl` 访问本机控制器，避免 WebView 跨域限制。需要设备提供 `curl`；缺失时请先安装可信的 curl 工具模块。向导默认仅在 `127.0.0.1` 开放控制器。

内核下载优先正式 release，无正式 release 时使用最新发布的 prerelease；显式指定 tag 时不回退。只选择 Android 架构资产。模块 ZIP 不含核心，可在 WebUI 下载，也可手动将带 `with_ebpf` 的 Android 可执行文件放到 `/data/adb/mihomo/mihomo` 并设置权限 `0755`。

## 内核要求

- 内核二进制：liuran001/mihomo 的 smart + eBPF 分支构建产物（`mihomo-android-arm64[-v8]-*.gz` / `mihomo-android-amd64-*.gz`），需要启用 `with_ebpf`。
- Android 设备：内核需启用 eBPF（cgroup BPF、sockmap 等，Android 11+ 的 GKI 内核一般都满足）。
- 透明代理走 eBPF（cgroup + packet_rewrite），不需要 iptables TPROXY 规则。

### 回归测试

```sh
node --test magisk/tests/frontend.test.js magisk/tests/bridge.test.js magisk/tests/onboarding.test.js magisk/tests/config.test.js
sh magisk/tests/core.test.sh
sh magisk/tests/backend.sh
sh magisk/tests/backend-process.sh
sh magisk/tests/backend-readiness.sh
```

`config.test.js` 覆盖配置引擎：模板逐字节往返、字段读写与校验、订阅/规则集增删、导入识别、本机优化（含跳过、幂等、多 listener 合并），并把优化结果交给 `policy-yaml.awk` 渲染确认模块能接管。

本地预览 WebUI（模拟后台，含配置引擎）：先构建 `wasmJsBrowserDistribution`，再运行 `node magisk/tests/preview-server.cjs`，打开 `http://127.0.0.1:8790/`；加 `?fresh=1` 模拟首次安装进入引导。

`magisk/tests/fixtures/android.yaml` 是不含订阅的 AVD 验证配置，规则为 `MATCH,REJECT`，仅用于观察流量是否被接管，不能当日常配置。实测时请先备份已有 `/data/adb/mihomo` 数据，验证结束后恢复正常配置。

**验证边界**：Compose Miuix 已通过 production 构建，90 项 JavaScript 回归通过；桌面浏览器在阻断外网时验证中文、应用选择抽屉、SSID 保存、明暗主题与 320px 窄屏。浏览器烟测使用模拟后台，不能代替原生权限验证。新 WebUI 已部署到 HyperOS AVD 并显示原生服务状态；该 AVD 的 Vulkan 合成路径会白屏，测试时临时以 OpenGL 启动 Manager，随后恢复全局属性，模块不修改渲染器。其他手机的兼容性和新界面的完整代理链路仍需分别验证。既有 namespace/veth 结果不代表真实热点、USB/蓝牙外设、OEM offload 或 IPv6 可用；详细证据分阶段记于 `magisk/tests/validation.md`。

配置写入单条命令的 base64 上限为 120000 字节，超过时分段暂存后写入，最大 4 MB。测试覆盖范围与限制见 `magisk/tests/validation.md`；后台设置和 YAML 格式约定见 `magisk/tests/backend-contract.md`。
