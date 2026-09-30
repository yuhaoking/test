import { pinyin } from 'pinyin-pro';

export function uid(): string {
  return crypto.randomUUID();
}

export function formatBytes(size: number): string {
  if (!size) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = size;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function buildSearchKeys(name: string): string[] {
  try {
    const full = pinyin(name, { toneType: 'none', type: 'array' })
      .map((s) => s.toLowerCase())
      .join('');
    const first = pinyin(name, { pattern: 'first', toneType: 'none', type: 'array' })
      .map((s) => s.toLowerCase())
      .join('');
    return [name.toLowerCase(), full, first];
  } catch {
    return [name.toLowerCase()];
  }
}

export function matchKeys(name: string, keys: string[] | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (name.toLowerCase().includes(q)) return true;
  return (keys ?? []).some((k) => k.toLowerCase().includes(q));
}

/**
 * 转成可以穿过 contextBridge / IPC 的纯数据。
 *
 * 为什么必须显式转（本轮实测定位的系统性缺陷）：
 * 渲染层把 `ref`/`reactive` 里的对象直接传给 `window.api.*` 时，**contextBridge 会在 preload
 * 里任何代码执行之前，先把参数从主世界复制到隔离世界**，而这次复制用的是 V8 值序列化器 ——
 * 它遇到 Vue 的响应式 Proxy 会直接抛 `An object could not be cloned.`。
 * 实测不可序列化的形态：
 *   ref([]).value[0]        列表项（命令面板 / 侧边栏搜索 / 工作台搜索结果）
 *   ref({}).value           对象 ref（工作台的 ctxPayload）
 *   reactive({}).nested     嵌套对象
 *   [...reactiveArr, x][0]  展开响应式数组的元素（工作台待办快照）
 * 结论：**在 preload 里兜底是无效的**（那时参数早已复制完），只能在调用点转。
 * 落到界面上，这个错误的表现为"动作执行失败 / 点了没反应"，用户和开发者都极难自行定位。
 */
export function plain<T>(value: T): T {
  return value === undefined || value === null ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function showToast(message: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
