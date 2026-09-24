// 首屏配色（B21 启动无闪烁）：在样式表与应用脚本之前同步套用上次保存的首屏变量。
// 与 src/themes/runtime.ts 的 applyBootAppearance 保持同一格式（键 oris.appearance.boot.v1）；
// 应用脚本加载后会再调用一次并加载完整方案。CSP 只允许同源脚本，因此不写成内联脚本。
(function () {
  try {
    var cache = JSON.parse(localStorage.getItem("oris.appearance.boot.v1") || "null");
    if (!cache || cache.version !== 1) return;
    var systemDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : true;
    var mode = cache.themeMode === "system" ? (systemDark ? "dark" : "light") : cache.themeMode;
    var entry = mode === "dark" ? cache.dark : cache.light;
    if (!entry) return;
    var root = document.documentElement;
    for (var name in entry.variables) root.style.setProperty(name, entry.variables[name]);
    var dark = entry.type === "dark" || entry.type === "hcDark";
    if (entry.type === "hcDark" || entry.type === "hcLight") root.classList.add("theme-high-contrast");
    root.classList.add(dark ? "theme-dark" : "theme-light");
    root.dataset.scheme = entry.id;
    root.style.colorScheme = dark ? "dark" : "light";
  } catch (error) { /* 没有记录或存储不可用时沿用样式表默认配色 */ }
})();
