package mihomo

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import top.yukonga.miuix.kmp.basic.BasicComponent
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.CardDefaults
import top.yukonga.miuix.kmp.basic.CircularProgressIndicator
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Delete
import top.yukonga.miuix.kmp.icon.extended.Info
import top.yukonga.miuix.kmp.icon.extended.Ok
import top.yukonga.miuix.kmp.icon.extended.Report
import top.yukonga.miuix.kmp.icon.extended.Link
import top.yukonga.miuix.kmp.icon.extended.Notes
import top.yukonga.miuix.kmp.icon.extended.Pause
import top.yukonga.miuix.kmp.icon.extended.Play
import top.yukonga.miuix.kmp.icon.extended.Refresh
import top.yukonga.miuix.kmp.icon.extended.Settings
import top.yukonga.miuix.kmp.icon.extended.Tune
import top.yukonga.miuix.kmp.theme.MiuixTheme
import top.yukonga.miuix.kmp.utils.PressFeedbackType

/** 首页：状态卡 + 流量统计 + 运行信息 + 快捷入口。 */
@Composable
fun HomePage(onNavigate: (String) -> Unit) {
    val state = LiveOverview
    LaunchedEffect(Unit) { liveRead("读取状态中…") { state.load() } }
    // 运行中每 3 秒刷新流量；页面离开或服务停止时自动取消，避免后台空转。
    LaunchedEffect(state.running) {
        while (state.running == true) {
            delay(3000)
            if (liveIdle) state.pollTraffic()
        }
    }
    Page(title = "mihomo", actions = {
        BarAction(MiuixIcons.Regular.Refresh, "刷新", enabled = liveIdle) { state.refresh() }
    }) {
        item(key = "hero") { HomeStatusCard(onNavigate) }
        banner(state.feedback.error, BannerKind.Error, "error")
        banner(state.feedback.message, BannerKind.Success, "message")
        val issues = listOf("服务状态" to state.statusError, "内核" to state.coreError, "控制器" to state.controllerError)
            .filter { it.second.isNotEmpty() }.joinToString("\n") { "${it.first}：${it.second}" }
        banner(issues, BannerKind.Error, "issues")
        if (state.running == true) {
            item(key = "stats") {
                Row(Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    HomeStat("上传", formatBytes(state.trafficUp), Modifier.weight(1f))
                    HomeStat("下载", formatBytes(state.trafficDown), Modifier.weight(1f))
                    HomeStat("连接", state.connectionCount?.toString() ?: "—", Modifier.weight(1f))
                }
            }
        }
        group("运行信息") {
            val core = state.core
            ArrowRow("内核版本", value = when {
                core == null -> "—"
                core.boolean("installed") != true -> "未安装"
                else -> shortVersion(core.string("version")).ifBlank { "未知" }
            }) { onNavigate("core") }
            InfoRow("内存占用", state.memoryInUse?.let { formatBytes(it) }
                ?: state.status?.string("rss_kb")?.toDoubleOrNull()?.let { formatBytes(it * 1024) } ?: "—")
            ArrowRow("开机自启", value = when (state.policy?.let { it.boolean("autostart") }) {
                true -> "已开启"; false -> "已关闭"; null -> "—"
            }) { onNavigate("settings") }
            val ssid = state.status?.string("current_ssid").orEmpty()
            if (ssid.isNotEmpty()) InfoRow("当前 Wi-Fi", ssid)
        }
        group("快捷入口") {
            ArrowRow("代理", "切换节点与测速", startIcon = MiuixIcons.Regular.Tune) { onNavigate("proxies") }
            ArrowRow("连接", "查看与断开连接", startIcon = MiuixIcons.Regular.Link) { onNavigate("connections") }
            ArrowRow("内核配置", "DNS、eBPF、订阅与规则集", startIcon = MiuixIcons.Regular.Settings) { onNavigate("profile") }
            ArrowRow("日志", startIcon = MiuixIcons.Regular.Notes) { onNavigate("logs") }
        }
    }
}

/**
 * 状态卡：参照 KernelSU 管理器主页——整卡按状态着色，标题 + 两行说明，
 * 右下角放一枚溢出卡片边缘的大号半透明状态图标；运行中时下方追加操作按钮。
 */
@Composable
private fun HomeStatusCard(onNavigate: (String) -> Unit) {
    val state = LiveOverview
    val running = state.running
    val coreMissing = state.core?.boolean("installed") == false
    val dark = MiuixTheme.colorScheme.background.red < 0.5f
    val (container, accent) = when {
        running == true -> if (dark) Color(0xFF1B3A26) to Color(0xFF4ADE80) else Color(0xFFDFFAE4) to Color(0xFF36D167)
        running == null && state.statusError.isNotEmpty() -> if (dark) Color(0xFF3D1E1E) to Color(0xFFF87171) else Color(0xFFFFE4E4) to Color(0xFFF26B6B)
        state.paused || coreMissing -> if (dark) Color(0xFF3B2F17) to Color(0xFFFBBF24) else Color(0xFFFFF1D6) to Color(0xFFF5A524)
        else -> MiuixTheme.colorScheme.surfaceContainer to Tone.muted
    }
    val title = when {
        running == null && state.statusError.isEmpty() -> "读取中"
        running == null -> "状态未知"
        running -> "工作中"
        state.paused -> "已暂停"
        coreMissing -> "未安装内核"
        else -> "未运行"
    }
    val line1 = when {
        running == true -> "内核：" + shortVersion(state.core?.string("version")?.ifBlank { null } ?: state.controllerVersion.ifBlank { "—" })
        coreMissing -> "点击下载 mihomo 内核"
        state.paused -> "当前 Wi-Fi 不在允许范围内"
        running == null -> if (state.statusError.isEmpty()) "正在检查服务状态" else "无法读取服务状态"
        else -> "点击卡片启动透明代理"
    }
    val line2 = when {
        !liveIdle -> liveActivity
        running == true -> "eBPF 透明代理" + if (state.policy?.boolean("tethering") == true) " · 共享已开启" else ""
        state.paused -> "切换到允许的网络后自动恢复"
        else -> ""
    }
    val icon = when {
        running == true -> MiuixIcons.Regular.Ok
        state.paused -> MiuixIcons.Regular.Pause
        coreMissing -> MiuixIcons.Regular.Info
        running == null && state.statusError.isNotEmpty() -> MiuixIcons.Regular.Report
        else -> MiuixIcons.Regular.Play
    }
    val clickable = liveIdle && (coreMissing || (running == false && !state.paused))
    Card(
        modifier = Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth(),
        insideMargin = PaddingValues(0.dp),
        colors = CardDefaults.defaultColors(color = container),
        pressFeedbackType = if (clickable) PressFeedbackType.Sink else PressFeedbackType.None,
        onClick = if (clickable) ({ if (coreMissing) onNavigate("core") else state.service("start") }) else null,
    ) {
        Box(Modifier.fillMaxWidth().heightIn(min = 132.dp).clip(RoundedCornerShape(16.dp))) {
            // 与 KernelSU 主页一致：右下角大号圆形徽标，部分越出卡片边缘
            Box(
                Modifier.align(Alignment.BottomEnd).offset(x = 26.dp, y = 30.dp).size(120.dp)
                    .clip(CircleShape).background(accent.copy(alpha = 0.18f)).padding(14.dp)
                    .clip(CircleShape).background(accent),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = container, modifier = Modifier.size(52.dp))
            }
            Column(Modifier.padding(20.dp).padding(end = 72.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, fontSize = 24.sp, fontWeight = FontWeight.Bold, color = MiuixTheme.colorScheme.onSurface)
                Text(line1, fontSize = 14.sp, color = MiuixTheme.colorScheme.onSurface.copy(alpha = 0.8f),
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (line2.isNotEmpty()) Text(line2, fontSize = 14.sp, color = MiuixTheme.colorScheme.onSurface.copy(alpha = 0.8f),
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!liveIdle) CircularProgressIndicator(size = 16.dp, strokeWidth = 2.dp, modifier = Modifier.padding(top = 8.dp))
            }
        }
    }
    if (running == true || state.paused) {
        Row(Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton("停止", onClick = { state.service("stop") }, enabled = liveIdle, modifier = Modifier.weight(1f))
            TextButton("重启", onClick = { state.service("restart") }, enabled = liveIdle && running == true, modifier = Modifier.weight(1f))
            TextButton("切换节点", onClick = { onNavigate("proxies") }, enabled = running == true, modifier = Modifier.weight(1f),
                colors = ButtonDefaults.textButtonColorsPrimary())
        }
    }
}

@Composable
private fun HomeStat(label: String, value: String, modifier: Modifier = Modifier) {
    Card(modifier, insideMargin = PaddingValues(horizontal = 14.dp, vertical = 12.dp)) {
        Text(label, fontSize = 12.sp, color = Tone.muted)
        Text(value, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, color = MiuixTheme.colorScheme.onSurface)
    }
}

/** 代理：每个策略组一行，点开底部弹窗选择节点，可测速。 */
@Composable
fun ProxiesPage(onBack: (() -> Unit)?) {
    val state = LiveProxies
    var opened by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { if (state.stale) liveRead("读取代理组中…") { state.load() } }
    Page(title = "代理", navigationIcon = { if (onBack != null) BackIcon(onBack) }, actions = {
        BarAction(MiuixIcons.Regular.Refresh, "刷新", enabled = liveIdle) { state.refresh() }
    }) {
        banner(if (!liveIdle) liveActivity else "", BannerKind.Progress, "activity")
        banner(state.error.ifEmpty { state.feedback.error }, BannerKind.Error, "error")
        val groups = state.groups
        if (groups != null && groups.isEmpty()) item(key = "empty") { EmptyState(MiuixIcons.Regular.Tune, "没有策略组，请先启动服务") }
        if (!groups.isNullOrEmpty()) group(null, "groups") {
            for (group in groups) ProxyGroupRow(group) { opened = group.key }
        }
    }
    val group = state.groups?.firstOrNull { it.key == opened }
    Sheet(show = group != null, title = group?.name ?: "", onDismissRequest = { opened = null }) {
        if (group != null) ProxyNodes(group) { opened = null }
    }
}

@Composable
private fun delayColor(delay: Int?): Color = when {
    delay == null -> Tone.muted
    delay <= 0 -> Tone.danger
    delay < 300 -> Tone.success
    delay < 800 -> Tone.warning
    else -> Tone.danger
}

private fun delayText(delay: Int?): String = when {
    delay == null -> ""
    delay <= 0 -> "超时"
    else -> "$delay ms"
}

private fun groupLabel(type: String): String = when (type) {
    "Selector" -> "手动"
    "URLTest" -> "自动"
    "Fallback" -> "故障转移"
    "Smart" -> "智能"
    "LoadBalance" -> "负载均衡"
    else -> type
}

@Composable
private fun ProxyGroupRow(group: LiveProxyGroup, onOpen: () -> Unit) {
    val delay = LiveProxies.delays[group.selected]
    BasicComponent(
        title = group.name,
        summary = "${groupLabel(group.type)} · ${group.selected.ifEmpty { "未选择" }}",
        onClick = onOpen,
        endActions = {
            if (delay != null) Text(delayText(delay), fontSize = 13.sp, color = delayColor(delay))
        },
    )
}

@Composable
private fun ProxyNodes(group: LiveProxyGroup, onPicked: () -> Unit) {
    val state = LiveProxies
    val testing = group.key in state.testing
    Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
        TextButton(if (testing) "测速中…" else "测试延迟", onClick = { state.test(group) }, enabled = !testing,
            modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp))
        if (!group.selectable) {
            Text("该组由内核自动选择，不能手动切换", fontSize = 13.sp, color = Tone.muted, modifier = Modifier.padding(bottom = 8.dp))
        }
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp)) {
            items(group.options, key = { it }) { name ->
                val selected = name == group.selected
                val delay = state.delays[name]
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 2.dp).clip(RoundedCornerShape(14.dp))
                        .background(if (selected) MiuixTheme.colorScheme.primary.copy(alpha = 0.12f) else Color.Transparent)
                        .clickable(enabled = group.selectable && state.writable && !selected) {
                            state.select(group, name)
                            onPicked()
                        }
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(name, modifier = Modifier.weight(1f), fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = if (selected) MiuixTheme.colorScheme.primary else MiuixTheme.colorScheme.onSurface,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
                    if (delay != null) Text(delayText(delay), fontSize = 13.sp, color = delayColor(delay))
                }
            }
        }
    }
}

/** 连接：搜索 + 列表，点按查看详情并可断开；5 秒自动刷新。 */
@Composable
fun ConnectionsPage(onBack: () -> Unit) {
    val state = LiveConnections
    var query by remember { mutableStateOf("") }
    var detail by remember { mutableStateOf<LiveConnection?>(null) }
    var confirmAll by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        liveRead("读取连接中…") { state.load() }
        while (true) {
            delay(5000)
            if (liveIdle && detail == null) liveRead("") { state.load() }
        }
    }
    val connections = state.connections.orEmpty()
    val filtered = remember(connections, query) {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) connections else connections.filter {
            connectionTitle(it.value).lowercase().contains(needle) || connectionChain(it.value).lowercase().contains(needle) ||
                connectionProcess(it.value).lowercase().contains(needle)
        }
    }
    Page(
        title = "连接",
        subtitle = state.total?.let { "共 $it 个 · 上传 ${formatBytes(state.upload)} 下载 ${formatBytes(state.download)}" } ?: "",
        navigationIcon = { BackIcon(onBack) },
        actions = {
            BarAction(MiuixIcons.Regular.Delete, "断开全部", enabled = state.writable && connections.isNotEmpty()) { confirmAll = true }
        },
    ) {
        item(key = "search") {
            Box(Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp)) {
                InputField("搜索域名、节点或应用", query) { query = it }
            }
        }
        banner(state.error.ifEmpty { state.feedback.error }, BannerKind.Error, "error")
        banner(state.feedback.message, BannerKind.Success, "message")
        if (state.connections != null && filtered.isEmpty()) item(key = "empty") { EmptyState(MiuixIcons.Regular.Link, "没有连接") }
        if (filtered.isNotEmpty()) item(key = "list") {
            Card(Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth()) {
                for (connection in filtered) {
                    val value = connection.value
                    BasicComponent(
                        title = connectionTitle(value),
                        summary = listOf(connectionProcess(value), connectionChain(value)).filter { it.isNotEmpty() }.joinToString(" · "),
                        onClick = { detail = connection },
                        endActions = { Text("" + formatBytes(value.string("download").toDoubleOrNull()), fontSize = 12.sp, color = Tone.muted) },
                    )
                }
            }
        }
    }
    ConfirmDialog(show = confirmAll, title = "断开全部连接", summary = "正在进行的下载和通话会被中断。", confirm = "断开", danger = true,
        onDismiss = { confirmAll = false }) { confirmAll = false; state.close() }
    val shown = detail
    Sheet(show = shown != null, title = "连接详情", onDismissRequest = { detail = null }) {
        if (shown != null) {
            val value = shown.value
            val metadata = value["metadata"] as? JsonObject
            Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
                Card(colors = CardDefaults.defaultColors(color = MiuixTheme.colorScheme.secondaryContainer)) {
                    for ((label, text) in listOf(
                        "目标" to connectionTitle(value),
                        "链路" to connectionChain(value),
                        "规则" to listOf(value.string("rule"), value.string("rulePayload")).filter { it.isNotEmpty() }.joinToString(" · "),
                        "应用" to connectionProcess(value),
                        "来源" to listOf(metadata?.string("sourceIP").orEmpty(), metadata?.string("sourcePort").orEmpty())
                            .filter { it.isNotEmpty() }.joinToString(":"),
                        "流量" to "上传 ${formatBytes(value.string("upload").toDoubleOrNull())}  下载 ${formatBytes(value.string("download").toDoubleOrNull())}",
                    )) if (text.isNotEmpty()) InfoRow(label, text)
                }
                Spacer(Modifier.height(12.dp))
                TextButton("断开此连接", onClick = { state.close(value.string("id")); detail = null }, enabled = state.writable,
                    modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.textButtonColors(textColor = MiuixTheme.colorScheme.error))
            }
        }
    }
}

private fun connectionTitle(value: JsonObject): String {
    val metadata = value["metadata"] as? JsonObject
    val host = metadata?.string("host").orEmpty().ifEmpty { metadata?.string("destinationIP").orEmpty() }
    val port = metadata?.string("destinationPort").orEmpty()
    val network = metadata?.string("network").orEmpty().uppercase()
    return listOf(if (port.isEmpty()) host else "$host:$port", network).filter { it.isNotEmpty() }.joinToString("  ").ifEmpty { "未知目标" }
}

private fun connectionProcess(value: JsonObject): String = (value["metadata"] as? JsonObject)?.string("process").orEmpty()

private fun connectionChain(value: JsonObject): String =
    (value["chains"] as? JsonArray)?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
        ?.asReversed()?.joinToString(" » ").orEmpty().ifEmpty { "DIRECT" }
