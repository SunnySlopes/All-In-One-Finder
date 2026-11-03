import type { SearcherId } from './searchers';

/**
 * 全局搜索占用状态：同一时间只允许一个搜索器运行（暂停也算占用）。
 *
 * 真正的互斥由 native 侧 search_gate 保证；这里只负责让 UI 在别的搜索器运行时
 * 禁用所有 Start 按钮，避免用户点下去才收到 "busy" 报错。
 *
 * 占用者由 src/native.ts 在 start RPC 成功返回时设置，在对应 poll 报告
 * done / running=false（或 poll 失败）时释放，因此各面板不需要各自维护一份
 * 全局状态，也不会因为切 Tab 丢掉。
 */
let owner: SearcherId | null = null;
const listeners = new Set<() => void>();

export function runLockOwner(): SearcherId | null {
  return owner;
}

/** 是否已有“别的”搜索器占用（暂停中的搜索同样占用）。 */
export function isOtherSearcherRunning(id: SearcherId): boolean {
  return owner !== null && owner !== id;
}

export function setRunLockOwner(id: SearcherId | null): void {
  if (owner === id) return;
  owner = id;
  for (const listener of listeners) listener();
}

export function onRunLockChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
