package mihomo

// 日志高亮：解析 mihomo 的 logfmt（time="…" level=info msg="…"），按级别着色，
// 并在消息里标出协议、来源 --> 目标、命中的规则与使用的节点。每行一个列表项，长日志也不卡。

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.theme.MiuixTheme

internal enum class LogLevel(val title: String, val rank: Int) {
    DEBUG("调试", 0), INFO("信息", 1), WARNING("警告", 2), ERROR("错误", 3), OTHER("其它", 1)
}

@Immutable
internal data class LogEntry(val time: String, val level: LogLevel, val message: String)

private val logfmt = Regex("^time=\"([^\"]*)\"\\s+level=(\\w+)\\s+msg=\"(.*)\"\\s*$")
private val clock = Regex("T(\\d{2}:\\d{2}:\\d{2})")
private val plainTime = Regex("^\\[?(\\d{4}-\\d{2}-\\d{2}[ T](\\d{2}:\\d{2}:\\d{2})[^\\]\\s]*)\\]?\\s*")

private fun levelOf(text: String): LogLevel = when (text.lowercase()) {
    "debug", "trace" -> LogLevel.DEBUG
    "info" -> LogLevel.INFO
    "warn", "warning" -> LogLevel.WARNING
    "error", "fatal", "panic" -> LogLevel.ERROR
    else -> LogLevel.OTHER
}

internal fun parseLog(line: String): LogEntry {
    logfmt.find(line)?.let { match ->
        val (time, level, message) = match.destructured
        return LogEntry(clock.find(time)?.groupValues?.get(1) ?: time, levelOf(level),
            message.replace("\\\"", "\"").replace("\\\\", "\\"))
    }
    // 模块脚本的日志：[2026-01-01 12:00:00] 消息
    val time = plainTime.find(line)
    val rest = if (time != null) line.substring(time.range.last + 1) else line
    val lower = rest.lowercase()
    val level = when {
        Regex("\\b(error|fatal|panic|failed|失败|错误)\\b").containsMatchIn(lower) || "失败" in rest || "错误" in rest -> LogLevel.ERROR
        Regex("\\bwarn(ing)?\\b").containsMatchIn(lower) || "警告" in rest -> LogLevel.WARNING
        else -> LogLevel.OTHER
    }
    return LogEntry(time?.groupValues?.get(2).orEmpty(), level, rest)
}

@Composable
private fun levelColor(level: LogLevel): Color = when (level) {
    LogLevel.DEBUG -> Tone.muted
    LogLevel.INFO -> MiuixTheme.colorScheme.primary
    LogLevel.WARNING -> Tone.warning
    LogLevel.ERROR -> Tone.danger
    LogLevel.OTHER -> Tone.muted
}

private val protocol = Regex("^\\[(TCP|UDP|DNS|ICMP|Sniffer|[A-Za-z]+)\\]\\s*")
private val arrow = Regex("\\s(-->|<--|->)\\s")
private val matchRule = Regex("\\bmatch\\s+(\\S+)")
private val usingProxy = Regex("\\busing\\s+(.+)$")
private val address = Regex("(\\[[0-9a-fA-F:]+\\]|\\d{1,3}(?:\\.\\d{1,3}){3}|[A-Za-z0-9.-]+\\.[A-Za-z]{2,}):(\\d{1,5})")

@Composable
private fun highlight(message: String): AnnotatedString {
    val primary = MiuixTheme.colorScheme.primary
    val text = MiuixTheme.colorScheme.onSurface
    val muted = Tone.muted
    val success = Tone.success
    val warning = Tone.warning
    return buildAnnotatedString {
        append(message)
        addStyle(SpanStyle(color = text), 0, message.length)
        protocol.find(message)?.let { addStyle(SpanStyle(color = primary, fontWeight = FontWeight.SemiBold), it.range.first, it.range.last + 1) }
        for (match in address.findAll(message)) addStyle(SpanStyle(color = text, fontWeight = FontWeight.Medium), match.range.first, match.range.last + 1)
        for (match in arrow.findAll(message)) addStyle(SpanStyle(color = muted), match.range.first, match.range.last + 1)
        matchRule.find(message)?.let { match ->
            val group = match.groups[1]!!
            addStyle(SpanStyle(color = muted), match.range.first, group.range.first)
            addStyle(SpanStyle(color = warning), group.range.first, group.range.last + 1)
        }
        usingProxy.find(message)?.let { match ->
            val group = match.groups[1]!!
            addStyle(SpanStyle(color = muted), match.range.first, group.range.first)
            addStyle(SpanStyle(color = success, fontWeight = FontWeight.Medium), group.range.first, group.range.last + 1)
        }
    }
}

@Composable
internal fun LogLevelChips(selected: LogLevel?, counts: Map<LogLevel, Int>, onSelect: (LogLevel?) -> Unit) {
    Row(Modifier.padding(horizontal = 12.dp).padding(bottom = 8.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        val options = listOf<LogLevel?>(null, LogLevel.ERROR, LogLevel.WARNING, LogLevel.INFO, LogLevel.DEBUG)
        for (level in options) {
            val active = level == selected
            val tint = if (level == null) MiuixTheme.colorScheme.primary else levelColor(level)
            val count = if (level == null) counts.values.sum() else counts[level] ?: 0
            Box(Modifier.clip(RoundedCornerShape(10.dp))
                .background(if (active) tint.copy(alpha = 0.16f) else MiuixTheme.colorScheme.surfaceContainer)
                .clickable { onSelect(level) }.padding(horizontal = 10.dp, vertical = 6.dp)) {
                Text("${level?.title ?: "全部"} $count", fontSize = 12.sp, color = if (active) tint else MiuixTheme.colorScheme.onSurface,
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal)
            }
        }
    }
}

@Composable
internal fun LogLine(entry: LogEntry) {
    val color = levelColor(entry.level)
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top) {
        Column(Modifier.widthIn(min = 52.dp), horizontalAlignment = Alignment.Start, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (entry.time.isNotEmpty()) Text(entry.time, fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = Tone.muted)
            if (entry.level != LogLevel.OTHER) {
                Box(Modifier.clip(RoundedCornerShape(4.dp)).background(color.copy(alpha = 0.14f)).padding(horizontal = 4.dp)) {
                    Text(entry.level.name.take(4), fontSize = 10.sp, fontWeight = FontWeight.Bold, color = color, fontFamily = FontFamily.Monospace)
                }
            }
        }
        Text(highlight(entry.message), fontSize = 12.sp, lineHeight = 17.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
    }
}
