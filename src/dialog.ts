import { applyI18n, t } from './i18n';

export function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
}

export function showNotice(message: string, closeKey = 'common.dialog.close'): void {
  const modal = document.querySelector<HTMLElement>('#modal')!;
  const dialog = document.querySelector<HTMLElement>('#dialog')!;
  dialog.innerHTML = `
    <div>${escapeText(message)}</div>
    <div class="row"><button type="button" data-choice="dismiss" data-i18n="${closeKey}"></button></div>
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

export function ask(
  message: string,
  buttons: { id: string; key: string }[],
): Promise<string> {
  const modal = document.querySelector<HTMLElement>('#modal')!;
  const dialog = document.querySelector<HTMLElement>('#dialog')!;
  dialog.innerHTML = `<div>${escapeText(message)}</div><div class="row">${buttons.map((button) =>
    `<button type="button" data-choice="${button.id}">${escapeText(t(button.key))}</button>`).join('')}</div>`;
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
