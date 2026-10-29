import { t } from './i18n';

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

export function messageOf(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const key = `common.error.${code}`;
  const text = t(key);
  return text === key ? code : text;
}

const THREADS_FIELD = 'input[id$="-threads"]';
const RUN_LOCK_ATTR = 'runLock';

/**
 * 搜索运行/暂停时锁定参数区：运行中所有字段不可修改；暂停中只保留线程数可改。
 *
 * 只恢复本函数亲自禁用的控件，避免覆盖面板自身的禁用规则（正方形四至、统计窗口形状、
 * 隐藏的排序按钮等）。因此每个被锁定的控件都会带上 `data-run-lock` 标记。
 */
export function applyRunLock(root: HTMLElement, running: boolean, paused: boolean): void {
  const body = root.querySelector<HTMLElement>('.search-panel-body');
  if (!body) return;
  const lockAll = running || paused;
  const controls = body.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
  >('input, select, textarea, button');
  controls.forEach((control) => {
    // 暂停时线程数是唯一可改的字段；它可能在运行阶段被本函数锁定过。
    if (paused && control.matches(THREADS_FIELD)) {
      if (control.dataset[RUN_LOCK_ATTR] === '1') {
        delete control.dataset[RUN_LOCK_ATTR];
        control.disabled = false;
      }
      return;
    }
    if (!lockAll) {
      if (control.dataset[RUN_LOCK_ATTR] === '1') {
        delete control.dataset[RUN_LOCK_ATTR];
        control.disabled = false;
      }
      return;
    }
    if (control.disabled) return;
    control.disabled = true;
    control.dataset[RUN_LOCK_ATTR] = '1';
  });
}
