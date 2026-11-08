export type ThemeId = 'dark' | 'light';

export const THEME_KEY = 'aio.theme';

/**
 * 首次启动（没有存档里的主题、也没有本地记录）时跟随 Windows / 系统设置。
 *
 * `prefers-color-scheme` 在 WebView2 里直接反映 Windows 的「应用模式」，
 * 浏览器预览下同样有效，所以不需要额外走宿主通道。
 */
export function systemTheme(): ThemeId {
  try {
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  } catch {
    /* matchMedia 不可用：按深色处理 */
  }
  return 'dark';
}

/** 本地记录的主题；没有则返回 null（交给存档或系统决定）。 */
export function storedTheme(): ThemeId | null {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    /* storage blocked */
  }
  return null;
}

export function storeTheme(theme: ThemeId): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage blocked: keep for this run only */
  }
}

/** 主题写入 DOM + 通知宿主原生标题栏。 */
export function applyThemeToDom(theme: ThemeId): void {
  document.documentElement.setAttribute('data-theme', theme);
  // 原生窗口标题栏跟随页面主题（浏览器里没有宿主，可选链天然跳过）。
  window.aio?.setTheme?.(theme);
}
