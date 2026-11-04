# mihomo-frontends

mihomo（[liuran001/mihomo](https://github.com/liuran001/mihomo)，smart + eBPF 分支）核心 + 各平台前端封装。

```
shared/   平台无关的资源（配置模板等）
magisk/   Magisk / KernelSU 模块封装（KSU WebUI 管理界面）
luci/     OpenWrt LuCI 应用（luci-app-mihomo-ebpf）
```

## Magisk / KernelSU 模块（`magisk/`）

在 KernelSU / Magisk（带 WebUI 的分支）里刷入模块 zip，然后在模块列表点「WebUI」打开管理界面。

- **数据与模块分离**：内核、配置、备份、运行状态放 `/data/adb/mihomo`，模块目录只放脚本与 WebUI；更新模块不丢数据。
- **内核按需下载**：模块 zip 不含二进制。打开 WebUI「内核」页，按设备架构（arm64 / x86_64）从 GitHub release 下载，支持镜像前缀与版本回滚。
- **设置向导**：三步——下载内核 → 填订阅（渲染共享模板 `shared/template.yaml`：eBPF hybrid 透明代理 + Smart 策略组 + zashboard 面板）→ 生成并启动。
- **写配置必先校验**：`mihomo -t` 通过后备份旧配置、原子替换、重启；启动失败自动回滚。备份保留最近 10 份，可一键恢复。
- **开机自启**：WebUI 概览页开关，状态存 `settings.ini`，由 `service.sh` 等网络就绪后拉起。

功能对照 LuCI 版：概览、代理切换、连接管理、配置文件（校验/备份/回滚）、内核管理、设置向导、日志。订阅的表单化编辑（分组、规则）在 Android 上直接改 YAML 或交给 zashboard。

### 构建模块 zip

```sh
sh magisk/build.sh        # 需要 zip；输出 dist/mihomo-ebpf-magisk-<版本>.zip
```

CI：push 或打 v* tag 会同时构建 Magisk zip 与 LuCI apk，tag 构建自动发 Release（见 .github/workflows/build.yml）。

模板是单一来源：`shared/template.yaml` 是唯一副本，luci 与 magisk 构建/部署时由脚本同步（`luci/scripts/sync-template.sh`、`magisk/build.sh`）。

### 手动打包（无 zip 工具时）

把 `magisk/` 目录下的 `module.prop`、`webroot/`、`scripts/`、`customize.sh`、`service.sh`、`post-fs-data.sh` 打成 zip（保持目录结构）即可刷入。

### 结构

```
magisk/
├── module.prop          # 模块声明
├── customize.sh         # 安装时校验架构
├── service.sh           # 开机自启（等网络 → mihomo.sh autostart）
├── post-fs-data.sh      # 建运行目录
├── scripts/
│   ├── common.sh        # 路径、settings.ini、工具函数
│   ├── mihomo.sh        # 进程管理（start/stop/restart/status/enable/disable）
│   ├── core.sh          # 内核下载/信息/回滚/下载设置
│   ├── apply.sh         # 配置校验→备份→替换→重启，失败回滚
│   └── backup.sh        # 备份列表/读取/删除/恢复
└── webroot/             # KSU WebUI（无依赖单页应用）
    ├── index.html
    ├── template.yaml    # 配置模板（与 shared/ 同步）
    └── js/app.js        # ksu.exec 调脚本 + mihomo 控制器 REST
```

WebUI 通过 `ksu.exec` 调 `scripts/` 下的 shell 脚本做文件与进程操作；节点切换、连接管理走内核的 `external-controller` REST（读配置取地址与密钥，连 `127.0.0.1`）。

## 内核要求

- 内核二进制：liuran001/mihomo 的 smart + eBPF 分支构建产物（`mihomo-linux-arm64` / `mihomo-linux-amd64`）。
- Android 设备：内核需启用 eBPF（cgroup BPF、sockmap 等，Android 11+ 的 GKI 内核一般都满足）。
- 透明代理走 eBPF（cgroup + packet_rewrite），不需要 iptables TPROXY 规则。
