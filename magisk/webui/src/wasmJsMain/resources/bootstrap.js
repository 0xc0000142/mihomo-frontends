'use strict';

(() => {
  let mounted = false;
  const message = document.getElementById('loading-message');
  const retry = document.getElementById('reload');
  function fail(text) {
    if (mounted) return;
    if (message) message.textContent = text;
    if (retry) retry.hidden = false;
  }
  const timer = setTimeout(() => fail('界面加载较慢，请确认 WebView 支持 WebAssembly，或重新加载。'), 45000);
  window.mihomoReady = () => {
    mounted = true;
    clearTimeout(timer);
    const loading = document.getElementById('loading');
    if (loading) loading.remove();
  };
  window.addEventListener('error', () => fail('界面未能启动，请更新 Android System WebView 后重试。'));
  window.addEventListener('unhandledrejection', () => fail('界面初始化失败，请重新加载。'));
  if (window.ksu) {
    const insets = document.createElement('link');
    insets.rel = 'stylesheet';
    insets.href = 'https://mui.kernelsu.org/internal/insets.css';
    document.head.appendChild(insets);
  }
  if (typeof WebAssembly !== 'object') {
    clearTimeout(timer);
    fail('当前 WebView 不支持 WebAssembly，请更新 Android System WebView。');
    return;
  }
  const script = document.createElement('script');
  script.src = 'mihomo.js';
  script.onerror = () => fail('界面资源加载失败，请重新安装完整模块后重试。');
  document.body.appendChild(script);
})();
