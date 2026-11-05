@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package mihomo

// 系统返回键。KernelSU 的 WebUIActivity 在 WebView 可后退时调用 goBack()，否则直接关闭页面；
// 因此只在「确实有东西可退」时压入一条历史记录，popstate 时交给最上层的处理者：
// 弹窗/底部弹窗 > 子页面 > 标签页回首页。没有处理者时不压历史，返回键即退出 WebUI。

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.rememberUpdatedState

@JsFun("""(callback) => {
    window.__mihomoBackDepth = 0;
    window.addEventListener('popstate', () => { window.__mihomoBackDepth = Math.max(0, window.__mihomoBackDepth - 1); callback(); });
}""")
private external fun installBackListener(callback: () -> Unit)

/** 让历史栈深度与可返回层数一致：不足补压，多余回退（回退会触发一次被忽略的 popstate）。 */
@JsFun("""(wanted) => {
    let depth = window.__mihomoBackDepth || 0;
    while (depth < wanted) { history.pushState({ mihomo: depth + 1 }, ''); depth++; }
    window.__mihomoBackDepth = depth;
    if (depth > wanted) { window.__mihomoBackSkip = (window.__mihomoBackSkip || 0) + (depth - wanted); window.__mihomoBackDepth = wanted; history.go(wanted - depth); }
}""")
private external fun syncBackDepth(wanted: Int)

@JsFun("() => { const skip = window.__mihomoBackSkip || 0; if (skip > 0) { window.__mihomoBackSkip = skip - 1; return true; } return false; }")
private external fun consumeSkip(): Boolean

internal object BackDispatcher {
    private val handlers = mutableStateListOf<() -> Unit>()
    private var installed = false
    /** 每次返回或增删处理者都会变化；组合稳定后据此同步历史深度，避免与重组竞争。 */
    var version by mutableStateOf(0)
        private set

    fun install() {
        if (installed) return
        installed = true
        installBackListener {
            if (consumeSkip()) return@installBackListener
            handlers.lastOrNull()?.invoke()
            version++
        }
    }

    fun push(handler: () -> Unit) { handlers.add(handler); version++ }
    fun remove(handler: () -> Unit) { handlers.remove(handler); version++ }

    /** 只需要一层历史：有处理者时保持一条，没有时清掉，让返回键交给 WebUI 关闭页面。 */
    fun sync() = syncBackDepth(if (handlers.isEmpty()) 0 else 1)
}

/** 放在应用根部：在每次变化后的组合完成时同步历史深度。 */
@Composable
fun BackSync() {
    val version = BackDispatcher.version
    LaunchedEffect(version) { BackDispatcher.sync() }
}

/** 在组合中注册一个返回处理者；enabled 为 false 时不拦截。后注册的优先。 */
@Composable
fun BackHandler(enabled: Boolean = true, onBack: () -> Unit) {
    val current = rememberUpdatedState(onBack)
    DisposableEffect(enabled) {
        if (!enabled) return@DisposableEffect onDispose { }
        val handler: () -> Unit = { current.value() }
        BackDispatcher.push(handler)
        onDispose { BackDispatcher.remove(handler) }
    }
}
