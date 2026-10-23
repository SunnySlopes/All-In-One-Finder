import en from '../locales/en.json';
import zh from '../locales/zh.json';

export type LocaleId = 'zh' | 'en';

const catalogs = { zh, en };
let current: LocaleId = (localStorage.getItem('aio.locale') as LocaleId) || 'zh';
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
  localStorage.setItem('aio.locale', next);
  document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  applyI18n();
  listeners.forEach((listener) => listener());
}

export function onLocale(listener: () => void): void {
  listeners.add(listener);
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let text = lookup(current, key) ?? lookup('en', key) ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

export function biomeLabel(name: string): string {
  if (!name) return '';
  const key = `biome.${name}`;
  const text = t(key);
  return text === key ? name.replaceAll('_', ' ') : text;
}

export function structureLabel(key: string): string {
  const full = `structure.${key}`;
  const text = t(full);
  return text === full ? key : text;
}

export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n;
    if (key) node.textContent = t(key);
  });
}
