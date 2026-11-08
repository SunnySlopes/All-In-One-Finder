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

export type FormState = Record<string, string | boolean>;

/** Snapshot every id-bearing form control in a panel (values + checkbox state). */
export function captureForm(root: HTMLElement): FormState {
  const state: FormState = {};
  root
    .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input[id], select[id], textarea[id]')
    .forEach((control) => {
      // Experimental / one-session-only controls opt out of the saved session.
      if (control.hasAttribute('data-no-persist')) return;
      if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
        state[control.id] = control.checked;
      } else {
        state[control.id] = control.value;
      }
    });
  return state;
}

/** Restore controls produced by captureForm; unknown controls are ignored. */
export function applyForm(root: HTMLElement, state: unknown): void {
  if (!state || typeof state !== 'object') return;
  const raw = state as { form?: unknown } & Record<string, unknown>;
  const form = (raw.form && typeof raw.form === 'object' ? raw.form : raw) as Record<string, unknown>;
  root
    .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input[id], select[id], textarea[id]')
    .forEach((control) => {
      if (control.hasAttribute('data-no-persist')) return;
      if (!(control.id in form)) return;
      const value = form[control.id];
      if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
        control.checked = !!value;
      } else {
        // Session files are user-editable JSON: never hand an object/array to
        // `.value`, which would store "[object Object]" and look like real input.
        control.value = scalarText(value);
      }
    });
}

/** Coerce a persisted form value to the string a control expects. */
function scalarText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Wall-clock timer for a search run. Pausing shifts the anchors instead of tracking
 * a separate total, so every "elapsed since start/phase" query already excludes the
 * time the search was paused.
 */
export class RunTimer {
  private startedAt = 0;
  private phaseAt = 0;
  private pausedAt = 0;

  start(): void {
    const now = Date.now();
    this.startedAt = now;
    this.phaseAt = now;
    this.pausedAt = 0;
  }

  markPhase(): void {
    this.phaseAt = Date.now();
  }

  pause(): void {
    if (this.startedAt && !this.pausedAt) this.pausedAt = Date.now();
  }

  resume(): void {
    if (!this.pausedAt) return;
    const delta = Date.now() - this.pausedAt;
    this.pausedAt = 0;
    if (this.startedAt) this.startedAt += delta;
    if (this.phaseAt) this.phaseAt += delta;
  }

  elapsed(): number {
    if (!this.startedAt) return 0;
    // While paused the anchors are not shifted yet (that happens on resume), so
    // stop the clock at `pausedAt` instead of letting it keep counting.
    const now = this.pausedAt || Date.now();
    return Math.max(0, now - this.startedAt);
  }

  phaseElapsed(): number {
    if (!this.phaseAt) return this.elapsed();
    const now = this.pausedAt || Date.now();
    return Math.max(0, now - this.phaseAt);
  }
}

const THREADS_FIELD = 'input[id$="-threads"]';
const RUN_LOCK_ATTR = 'runLock';

export type ProgressCardState = 'idle' | 'running' | 'paused' | 'done' | 'error';

/**
 * 把一次搜索状态同步到精简进度卡（决策 14：百分比 + 1 格元数据 + 1 行 ETA）。
 *
 * 各面板的进度百分比算法互不相同（有的按分块、有的按阶段计数器），
 * 这里不重复计算，而是**读取进度条实际写入的宽度**换算成百分比，
 * 从而保证进度条与百分比数字永远一致。
 */
export function paintProgressCard(
  footer: HTMLElement,
  prefix: string,
  opts: { state: ProgressCardState; stateText: string },
): void {
  const bar = footer.querySelector<HTMLElement>(`#${prefix}-bar`);
  const card = footer.querySelector<HTMLElement>('.progress-card');
  const percent = footer.querySelector<HTMLElement>(`#${prefix}-percent`);
  const label = footer.querySelector<HTMLElement>(`#${prefix}-state`);

  if (percent && bar) {
    const raw = Number.parseFloat(bar.style.width || '0');
    const value = Number.isFinite(raw) ? Math.min(100, Math.max(0, Math.round(raw))) : 0;
    percent.textContent = `${value}%`;
  }

  if (label) label.textContent = opts.stateText;

  if (card) {
    card.classList.toggle('is-running', opts.state === 'running');
    card.classList.toggle('is-paused', opts.state === 'paused');
    card.classList.toggle('is-done', opts.state === 'done');
    card.classList.toggle('is-error', opts.state === 'error');
  }
}

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

/**
 * 进度卡的初始外观：面板刚渲染、尚未开始搜索时调用。
 *
 * 各面板只在拿到第一个状态后才调 paintStatus/paintProgressCard，
 * 因此初次进入某个 Tab 时状态词会是空的。这里补一次「就绪」文案，
 * 让用户看到 `就绪 / 0%` 而不是空白。
 */
export function initProgressCard(footer: HTMLElement, prefix: string): void {
  const card = footer.querySelector<HTMLElement>('.progress-card');
  const percent = footer.querySelector<HTMLElement>(`#${prefix}-percent`);
  const label = footer.querySelector<HTMLElement>(`#${prefix}-state`);
  const bar = footer.querySelector<HTMLElement>(`#${prefix}-bar`);

  if (percent) percent.textContent = '0%';
  if (label && !label.textContent) label.textContent = t('common.search.start');
  if (bar && !bar.style.width) bar.style.width = '0%';
  if (card) {
    card.classList.remove('is-running', 'is-paused', 'is-done', 'is-error');
  }
}