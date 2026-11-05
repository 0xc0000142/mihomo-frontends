package mihomo

// Sub-Store：订阅管理工具。两种用法：填写已有 Sub-Store 的后端地址，或在本机运行（按需下载 node 与 Sub-Store，约 30 MB）。
// 页面可列出 Sub-Store 里的订阅 / 组合订阅，一键加入内核配置的订阅（proxy-providers）。

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Refresh

internal data class SubStoreItem(val kind: String, val name: String, val title: String, val url: String)

internal object SubStoreState {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    var status by mutableStateOf<JsonObject?>(null)
    var items by mutableStateOf<List<SubStoreItem>?>(null)
    var providerUrls by mutableStateOf<Set<String>>(emptySet())
    var busy by mutableStateOf("")
    var error by mutableStateOf("")
    var notice by mutableStateOf("")

    val mode: String get() = status?.string("mode") ?: "off"
    val port: Int get() = (status?.get("port") as? JsonPrimitive)?.intOrNull ?: 3001
    val lan: Boolean get() = status?.boolean("lan") == true
    val url: String get() = status?.string("url").orEmpty()
    val running: Boolean get() = status?.boolean("running") == true
    private fun installed(part: String): Boolean = (status?.get("installed") as? JsonObject)?.boolean(part) == true
    val ready: Boolean get() = installed("node") && installed("backend")
    val frontend: Boolean get() = installed("frontend")
    fun version(part: String): String = (status?.get("versions") as? JsonObject)?.string(part).orEmpty()

    private fun run(label: String, block: suspend () -> Unit) {
        if (busy.isNotEmpty()) return
        busy = label
        error = ""
        notice = ""
        scope.launch {
            try {
                block()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                error = failure.message ?: "操作失败"
            } finally {
                busy = ""
            }
        }
    }

    fun load() = run("读取…") { status = request("substoreStatus") }

    fun set(mode: String = this.mode, port: Int = this.port, lan: Boolean = this.lan, url: String = this.url, message: String = "已保存") =
        run(if (mode == "local" && this.mode != "local") "启动 Sub-Store…" else "保存…") {
            status = request("substoreSet", json("mode" to mode, "port" to port, "lan" to lan, "url" to url))
            items = null
            notice = message
        }

    fun install(what: String = "all") = run(if (what == "all" && !ready) "下载 Sub-Store（约 30 MB，可能需要几分钟）…" else "更新…") {
        status = request("substoreInstall", json("what" to what))
        notice = if (running) "已下载并启动" else "已下载"
    }

    fun service(action: String, message: String) = run("请稍候…") {
        status = request("substoreService", json("action" to action))
        if (action == "reset-path" || action == "uninstall") items = null
        notice = message
    }

    fun list() = run("读取订阅…") {
        items = request("substoreList").objects("list").map {
            SubStoreItem(it.string("kind"), it.string("name"), it.string("title"), it.string("url"))
        }
        providerUrls = currentProviderUrls()
    }

    private suspend fun currentProviderUrls(): Set<String> {
        val content = request("configRead").string("content")
        return request("configSchema", json("content" to content)).objects("providers").mapNotNull { provider ->
            provider.objects("fields").firstOrNull { it.string("id") == "url" }?.let { (it["value"] as? JsonPrimitive)?.contentOrNull }
        }.toSet()
    }

    /** 把一条 Sub-Store 订阅加入内核配置的订阅，然后校验、保存并重启服务。 */
    fun addProvider(item: SubStoreItem) = run("加入订阅…") {
        val content = request("configRead").string("content")
        val taken = request("configSchema", json("content" to content)).objects("providers").map { it.string("name") }.toSet()
        val base = ("Sub-Store " + item.title).replace(Regex("[/,\\\\\\n\\r]"), " ").trim().take(56)
        val name = generateSequence(1) { it + 1 }.map { if (it == 1) base else "$base $it" }.first { it !in taken }
        val op = JsonObject(mapOf("op" to JsonPrimitive("provider.add"), "name" to JsonPrimitive(name),
            "values" to json("url" to item.url, "interval" to 3600)))
        busy = "生成配置…"
        val patched = request("configPatch", JsonObject(mapOf("content" to JsonPrimitive(content), "ops" to JsonArray(listOf(op))))).string("content")
        if (request("coreInfo").boolean("installed")) {
            busy = "校验配置…"
            request("validate", json("content" to patched))
        }
        busy = "写入配置并重启服务…"
        markToolsConfigChanged()
        request("apply", json("content" to patched, "restart" to true))
        LiveOverview.invalidate()
        ProfileState.loadedOnce = false
        providerUrls = providerUrls + item.url
        notice = "已加入订阅「$name」"
    }
}

@Composable
fun SubStorePage(onBack: () -> Unit) {
    val state = SubStoreState
    var editUrl by remember { mutableStateOf(false) }
    var editPort by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf(false) }
    var confirmReset by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { state.load() }
    val idle = state.busy.isEmpty()
    Page(title = "Sub-Store", navigationIcon = { BackIcon(onBack) }, actions = {
        BarAction(MiuixIcons.Regular.Refresh, "刷新", enabled = idle) { state.load() }
    }) {
        banner(state.busy, BannerKind.Progress, "busy")
        banner(state.error, BannerKind.Error, "error")
        banner(state.notice, BannerKind.Success, "notice")
        if (state.status == null) return@Page
        group("使用方式") {
            DropdownRow("Sub-Store", listOf("不使用", "在本机运行", "使用已有服务"), when (state.mode) { "local" -> 1; "remote" -> 2; else -> 0 },
                "合并、筛选、重命名多个机场订阅，再作为一个订阅给内核使用", enabled = idle) { index ->
                when (index) {
                    0 -> state.set(mode = "off", message = "已关闭 Sub-Store")
                    1 -> if (state.ready) state.set(mode = "local") else state.set(mode = "local", message = "已切换到本机运行，请先下载")
                    else -> if (state.url.isEmpty()) editUrl = true else state.set(mode = "remote")
                }
            }
        }
        when (state.mode) {
            "local" -> group("本机运行") {
                InfoRow("状态", when {
                    !state.ready -> "未下载"
                    state.running -> "运行中"
                    else -> "未运行"
                }, valueColor = if (state.running) Tone.success else if (state.ready) Tone.warning else Tone.muted,
                    summary = if (!state.ready) "需要下载 node 与 Sub-Store，约 30 MB；使用「内核版本」里设置的下载镜像" else null)
                if (state.ready) {
                    InfoRow("版本", listOfNotNull(
                        state.version("backend").ifEmpty { null }?.let { "Sub-Store $it" },
                        state.version("frontend").ifEmpty { null }?.let { "前端 $it" },
                        state.version("node").ifEmpty { null }?.let { "node $it" },
                    ).joinToString(" · ").ifEmpty { "—" })
                    ArrowRow("端口", "改动后服务会重启", value = state.port.toString(), enabled = idle) { editPort = true }
                    SwitchRow("允许局域网访问", state.lan, "同一网络里的设备可以打开 Sub-Store；接口仍需带随机路径才能访问", enabled = idle) {
                        state.set(lan = it)
                    }
                }
                ButtonRow(Modifier.padding(top = 4.dp)) {
                    if (!state.ready) {
                        ActionButton("下载并启动", primary = true, enabled = idle) { state.install() }
                    } else {
                        if (state.running) ActionButton("停止", enabled = idle) { state.service("stop", "已停止") }
                        else ActionButton("启动", primary = true, enabled = idle) { state.service("start", "已启动") }
                        ActionButton("更新", enabled = idle) { state.install("all") }
                    }
                }
            }
            "remote" -> group("已有服务") {
                ArrowRow("后端地址", "Sub-Store 设置里「后端地址」显示的链接", value = state.url.ifEmpty { "未填写" }, enabled = idle) { editUrl = true }
            }
        }
        if (state.mode != "off") group("订阅", "subs") {
            val open = state.status?.string("open").orEmpty()
            ArrowRow("打开 Sub-Store", when {
                open.isNotEmpty() -> "在浏览器里管理订阅"
                state.mode == "local" && !state.running -> "Sub-Store 没有运行"
                else -> "当前经网页管理访问：请开启「允许局域网访问」"
            }, enabled = open.isNotEmpty()) {
                state.notice = ""
                Dashboard.openUrl(open) { state.error = it }
            }
            ArrowRow("加入内核订阅", "把 Sub-Store 里的订阅或组合订阅加入内核配置", enabled = idle && (state.mode == "remote" || state.running)) { state.list() }
            val items = state.items
            if (items != null && items.isEmpty()) Caption("Sub-Store 里还没有订阅。先打开 Sub-Store 添加机场订阅。")
            for (item in items.orEmpty()) {
                val added = item.url in state.providerUrls
                ArrowRow(item.title, if (item.kind == "collection") "组合订阅" else "单条订阅", value = if (added) "已加入" else "加入",
                    enabled = idle && !added) { state.addProvider(item) }
            }
        }
        if (state.mode == "local" && state.ready) group("维护", "maintain") {
            ArrowRow("更换接口路径", "旧的订阅链接与浏览器里保存的后端地址会失效", enabled = idle) { confirmReset = true }
            ArrowRow("删除程序", "删除下载的 node 与 Sub-Store，保留订阅数据", enabled = idle) { confirmRemove = true }
        }
        item(key = "note") {
            Caption("Sub-Store 的数据保存在 /data/adb/mihomo/substore/data。本机运行时接口地址带随机路径，只有知道它的人才能访问。")
        }
    }
    EditDialog(show = editUrl, title = "Sub-Store 后端地址", initial = state.url.ifEmpty { "https://" },
        summary = "例如 https://sub.example.com/路径（不是前端地址）", onDismiss = { editUrl = false }) { text ->
        val value = text.trim().trimEnd('/')
        if (!Regex("^https?://[^\\s\"']+$").matches(value)) return@EditDialog "请填写 http(s) 链接"
        editUrl = false
        state.set(mode = "remote", url = value)
        null
    }
    EditDialog(show = editPort, title = "端口", initial = state.port.toString(), summary = "1024–65535，默认 3001", onDismiss = { editPort = false }) { text ->
        val value = text.trim().toIntOrNull()
        if (value == null || value !in 1024..65535) return@EditDialog "端口须为 1024–65535"
        editPort = false
        state.set(port = value)
        null
    }
    ConfirmDialog(show = confirmReset, title = "更换接口路径", summary = "已加入内核的 Sub-Store 订阅链接会失效，需要删除后重新加入。", confirm = "更换",
        danger = true, onDismiss = { confirmReset = false }) {
        confirmReset = false
        state.service("reset-path", "已更换接口路径")
    }
    ConfirmDialog(show = confirmRemove, title = "删除 Sub-Store 程序", summary = "停止服务并删除下载的程序，订阅数据保留，之后可以重新下载。", confirm = "删除",
        danger = true, onDismiss = { confirmRemove = false }) {
        confirmRemove = false
        state.service("uninstall", "已删除程序")
    }
}
