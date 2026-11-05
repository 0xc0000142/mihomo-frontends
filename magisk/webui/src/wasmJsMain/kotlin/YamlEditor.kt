package mihomo

// config.yaml 编辑器：轻量 YAML 语法高亮（键、字符串、数字/布尔、注释、锚点）与输入停顿后的实时校验。

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import top.yukonga.miuix.kmp.theme.MiuixTheme

internal data class YamlColors(val key: Color, val string: Color, val scalar: Color, val comment: Color, val mark: Color)

private val keyPattern = Regex("""^(\s*)(- +)?((?:"[^"]*"|'[^']*'|[^\s#'"{}\[\],:][^#:]*?))(:)(?=\s|$)""")
private val scalarPattern = Regex("""^(?:true|false|null|~|yes|no|on|off|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|0x[0-9A-Fa-f]+)$""", RegexOption.IGNORE_CASE)

/** 超过这个长度不再高亮，避免每次按键都整篇重新着色导致卡顿。 */
private const val HIGHLIGHT_LIMIT = 400_000

internal class YamlHighlighter(private val colors: YamlColors) : VisualTransformation {
    private var lastText: String? = null
    private var lastResult: AnnotatedString? = null

    override fun filter(text: AnnotatedString): TransformedText {
        val raw = text.text
        if (raw.length > HIGHLIGHT_LIMIT) return TransformedText(text, OffsetMapping.Identity)
        val cached = lastResult
        val styled = if (cached != null && lastText == raw) cached else highlight(raw).also { lastText = raw; lastResult = it }
        return TransformedText(styled, OffsetMapping.Identity)
    }

    private fun highlight(raw: String): AnnotatedString = buildAnnotatedString {
        append(raw)
        var start = 0
        while (start <= raw.length) {
            val end = raw.indexOf('\n', start).let { if (it < 0) raw.length else it }
            line(raw.substring(start, end), start)
            start = end + 1
        }
    }

    private fun AnnotatedString.Builder.span(color: Color, from: Int, to: Int) {
        if (to > from) addStyle(SpanStyle(color = color), from, to)
    }

    private fun AnnotatedString.Builder.line(line: String, offset: Int) {
        val comment = commentStart(line)
        val code = if (comment >= 0) line.substring(0, comment) else line
        if (comment >= 0) span(colors.comment, offset + comment, offset + line.length)
        var valueStart = 0
        val key = keyPattern.find(code)
        if (key != null) {
            val dash = key.groups[2]
            if (dash != null) span(colors.mark, offset + dash.range.first, offset + dash.range.first + 1)
            val name = key.groups[3]!!
            span(colors.key, offset + name.range.first, offset + name.range.last + 1)
            valueStart = key.range.last + 1
        } else {
            val trimmed = code.trimStart()
            if (trimmed.startsWith("- ") || trimmed == "-") {
                val dash = code.indexOf('-')
                span(colors.mark, offset + dash, offset + dash + 1)
                valueStart = dash + 1
            }
        }
        val rest = code.substring(valueStart)
        val value = rest.trim()
        if (value.isEmpty()) return
        val begin = offset + valueStart + rest.indexOf(value[0])
        when {
            value.startsWith('"') || value.startsWith('\'') -> span(colors.string, begin, begin + value.length)
            value.startsWith('&') || value.startsWith('*') || value.startsWith('!') || value == "|" || value == ">" ||
                value.startsWith("|-") || value.startsWith(">-") -> span(colors.mark, begin, begin + value.length)
            scalarPattern.matches(value) -> span(colors.scalar, begin, begin + value.length)
        }
    }

    /** 注释起点：行首或空白后的 #，且不在引号内。 */
    private fun commentStart(line: String): Int {
        var quote: Char? = null
        for (index in line.indices) {
            val char = line[index]
            when {
                quote != null -> if (char == quote) quote = null
                char == '"' || char == '\'' -> if (index == 0 || line[index - 1].isWhitespace() || line[index - 1] in ":-[{,") quote = char
                char == '#' && (index == 0 || line[index - 1].isWhitespace()) -> return index
            }
        }
        return -1
    }
}

@Composable
internal fun rememberYamlHighlighter(): VisualTransformation {
    val scheme = MiuixTheme.colorScheme
    val colors = YamlColors(key = scheme.primary, string = Tone.success, scalar = Tone.warning, comment = Tone.muted, mark = Tone.danger)
    return remember(colors) { YamlHighlighter(colors) }
}

internal data class YamlProblem(val line: Int, val col: Int, val message: String, val error: Boolean)

/** 输入停顿 0.6 秒后校验；返回最近一次的问题列表（null 表示尚未校验）。 */
@Composable
internal fun rememberYamlLint(content: String, enabled: Boolean): List<YamlProblem>? {
    var problems by remember { mutableStateOf<List<YamlProblem>?>(null) }
    LaunchedEffect(content, enabled) {
        if (!enabled) return@LaunchedEffect
        delay(600)
        problems = try {
            request("yamlLint", json("content" to content)).objects("problems").map {
                YamlProblem((it["line"] as? JsonPrimitive)?.intOrNull ?: 0, (it["col"] as? JsonPrimitive)?.intOrNull ?: 0,
                    it.string("message"), it.string("level") != "warning")
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            null
        }
    }
    return problems
}
