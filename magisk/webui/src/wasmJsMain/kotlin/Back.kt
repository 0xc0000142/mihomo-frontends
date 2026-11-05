@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package mihomo

// 系统返回键。KernelSU 的 WebUIActivity 在 WebView 可后退时调用 goBack()，否则直接关闭页面；
// 因此按「可返回的层数」压入历史记录，popstate 时交给最上层的处理者：
// 弹窗/底部弹窗 > 子页面 > 标签页回首页。没有处理者时不压历史，返回键即退出 WebUI。
//
// Chromium 会把「没有用户操作时 pushState 加入」的历史标记为可跳过，WebView 的 canGoBack()
// 不算这些记录。所以历史只在层数增加时（用户刚点开页面/弹窗，仍有用户激活）补压，
// 返回后绝不重新压入：每层一条，返回一次正好消耗一条。

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState

// 自己调用 history.go(-n) 回退多余记录时只触发一次 popstate，用 __mihomoBackSkip 忽略它
@JsFun("""(callback) => {
    window.__mihomoBackDepth = 0;
    window.__mihomoBackSkip = 0;
    window.addEventListener('popstate', () => {
        if (window.__mihomoBackSkip > 0) { window.__mihomoBackSkip--; return; }
        window.__mihomoBackDepth = Math.max(0, window.__mihomoBackDepth - 1);
        callback();
    });
}""")
private external fun installBackListener(callback: () -> Unit)

/** 让历史栈深度与可返回层数一致：不足补压，多余回退。 */
@JsFun("""(wanted) => {
    let depth = window.__mihomoBackDepth || 0;
    while (depth < wanted) { history.pushState({ mihomo: depth + 1 }, ''); depth++; }
    if (depth > wanted) { window.__mihomoBackSkip = (window.__mihomoBackSkip || 0) + 1; history.go(wanted - depth); depth = wanted; }
    window.__mihomoBackDepth = depth;
}""")
private external fun syncBackDepth(wanted: Int)

internal class BackEntry(levels: Int, val onBack: () -> Unit) {
    var levels by mutableStateOf(levels)
}

internal object BackDispatcher {
    private val handlers = mutableStateListOf<BackEntry>()
    private var installed = false

    /** 需要的历史深度：所有处理者的层数之和。 */
    val depth: Int get() = handlers.sumOf { it.levels.coerceAtLeast(0) }

    fun install() {
        if (installed) return
        installed = true
        installBackListener {
            handlers.lastOrNull { it.levels > 0 }?.onBack?.invoke()
        }
    }

    fun push(entry: BackEntry) { handlers.add(entry) }
    fun remove(entry: BackEntry) { handlers.remove(entry) }

    fun sync(wanted: Int) = syncBackDepth(wanted)
}

/** 放在应用根部：层数变化后的组合完成时同步历史深度。 */
@Composable
fun BackSync() {
    val wanted = BackDispatcher.depth
    LaunchedEffect(wanted) { BackDispatcher.sync(wanted) }
}

/**
 * 在组合中注册一个返回处理者；enabled 为 false 时不拦截。后注册的优先。
 * levels 是这个处理者还能连续返回几次（例如子页面栈深度），用于预先压入足够的历史。
 */
@Composable
fun BackHandler(enabled: Boolean = true, levels: Int = 1, onBack: () -> Unit) {
    val current = rememberUpdatedState(onBack)
    val entry = remember { BackEntry(levels) { current.value() } }
    SideEffect { entry.levels = levels }
    DisposableEffect(enabled) {
        if (!enabled) return@DisposableEffect onDispose { }
        BackDispatcher.push(entry)
        onDispose { BackDispatcher.remove(entry) }
    }
}
