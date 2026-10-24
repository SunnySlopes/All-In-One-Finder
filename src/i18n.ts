import en from '../locales/en.json';
import zh from '../locales/zh.json';
import packageJson from '../package.json';

export type LocaleId = 'zh' | 'en';

const STORAGE_KEY = 'aio.locale';

const catalogs = { zh, en };
export const APP_VERSION = packageJson.version;

/** System UI language: the main process already maps it to a locale; navigator covers the browser. */
function systemLocale(): LocaleId {
  const fromMain = window.aio?.initialLocale;
  if (fromMain === 'zh' || fromMain === 'en') return fromMain;
  const tag = String(navigator.language || '').replaceAll('_', '-').toLowerCase();
  return tag.startsWith('zh') ? 'zh' : 'en';
}

/**
 * A saved choice always wins. On a machine without a session file the first run follows the
 * system locale (any zh* locale => Chinese, otherwise English), and that result is remembered
 * so a later auto-created session cannot flip the language back to Chinese.
 */
function initialLocale(): LocaleId {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'zh' || stored === 'en') return stored;
  const resolved: LocaleId = window.aio?.hasSession ? 'zh' : systemLocale();
  try {
    localStorage.setItem(STORAGE_KEY, resolved);
  } catch {
    /* storage blocked: keep the resolved default for this run only */
  }
  return resolved;
}

let current: LocaleId = initialLocale();
document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
const listeners = new Set<() => void>();

function lookup(locale: LocaleId, key: string): string | undefined {
  let node: unknown = catalogs[locale];
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

export function locale(): LocaleId {
  return current;
}

export function setLocale(next: LocaleId): void {
  current = next;
  localStorage.setItem(STORAGE_KEY, next);
  document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  applyI18n();
  listeners.forEach((listener) => listener());
}

export function onLocale(listener: () => void): void {
  listeners.add(listener);
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let text = lookup(current, key) ?? lookup('en', key) ?? key;
  const values = { version: APP_VERSION, ...vars };
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

export function biomeLabel(name: string): string {
  if (!name) return '';
  const key = `common.biome.${name}`;
  const text = t(key);
  return text === key ? name.replaceAll('_', ' ') : text;
}

export function structureLabel(key: string): string {
  const full = `common.structure.${key}`;
  const text = t(full);
  return text === full ? key : text;
}

export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n;
    if (key) node.textContent = t(key);
  });
}
