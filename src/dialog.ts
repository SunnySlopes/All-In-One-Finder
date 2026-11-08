import { applyI18n, t } from './i18n';

export function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
}

/**
 * 轻量非阻塞提示（决策 16）。
 *
 * 只用于「复制成功 / 导出成功」这类用户无需确认的操作反馈；
 * 错误与需要用户选择的情况仍走 modal（showNotice / ask）。
 */
export function showToast(message: string, kind: 'info' | 'error' = 'info'): void {
  const host = document.querySelector<HTMLElement>('#toast-host');
  if (!host) return;

  const toast = document.createElement('div');
  toast.className = kind === 'error' ? 'toast is-error' : 'toast';
  toast.setAttribute('role', 'status');

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.setAttribute('aria-hidden', 'true');
  // 简单勾选/告警字形，避免引入图标依赖。
  icon.textContent = kind === 'error' ? '!' : '✓';

  const text = document.createElement('span');
  text.textContent = message;

  toast.append(icon, text);
  host.append(toast);

  const remove = () => {
    toast.classList.add('is-leaving');
    window.setTimeout(() => toast.remove(), 200);
  };
  window.setTimeout(remove, 2400);
}

export function showNotice(message: string, closeKey = 'common.dialog.close'): void {
  const modal = document.querySelector<HTMLElement>('#modal')!;
  const dialog = document.querySelector<HTMLElement>('#dialog')!;
  dialog.innerHTML = `
    <div>${escapeText(message)}</div>
    <div class="row"><button type="button" class="btn primary sm" data-choice="dismiss" data-i18n="${closeKey}"></button></div>
  `;
  applyI18n(dialog);
  modal.classList.add('show');
  const close = () => {
    modal.classList.remove('show');
    modal.onclick = null;
  };
  dialog.querySelector('button')!.addEventListener('click', (event) => {
    event.stopPropagation();
    close();
  });
  modal.onclick = (event) => {
    if (event.target === modal) close();
  };
}

export function ask(message: string, buttons: { id: string; key: string }[]): Promise<string> {
  const modal = document.querySelector<HTMLElement>('#modal')!;
  const dialog = document.querySelector<HTMLElement>('#dialog')!;
  dialog.innerHTML = `<div>${escapeText(message)}</div><div class="row">${buttons
    .map(
      (button, index) =>
        `<button type="button" class="btn sm ${index === 0 ? 'primary' : 'ghost'}" data-choice="${button.id}">${escapeText(t(button.key))}</button>`,
    )
    .join('')}</div>`;
  modal.classList.add('show');
  return new Promise((resolve) => {
    const finish = (choice: string) => {
      modal.classList.remove('show');
      modal.onclick = null;
      resolve(choice);
    };
    dialog.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        finish(button.dataset.choice || 'dismiss');
      });
    });
    modal.onclick = (event) => {
      if (event.target === modal) finish('dismiss');
    };
  });
}
