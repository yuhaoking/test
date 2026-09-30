import { defineStore } from 'pinia';
import type { AppData, Module } from '../../shared/types';

function plain<T>(value: T): T {
  return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
}

/** UI-8：模块落盘串行队列（跨操作不互相覆盖） */
let persistQueue: Promise<void> = Promise.resolve();

export const useModulesStore = defineStore('modules', {
  state: () => ({
    modules: [] as Module[]
  }),
  getters: {
    pinned(state): Module[] {
      return state.modules.filter((m) => m.pinned).sort((a, b) => a.order - b.order);
    },
    normal(state): Module[] {
      return state.modules.filter((m) => !m.pinned).sort((a, b) => a.order - b.order);
    }
  },
  actions: {
    visual(): Module[] {
      return [...this.pinned, ...this.normal];
    },
    async load() {
      const data = await window.api.store.get();
      this.modules = data.modules;
    },
    sync(data: AppData) {
      this.modules = data.modules;
    },
    async persist() {
      // UI-8 修复：串行化落盘，避免快速连续操作时“读-改-写”互相覆盖丢更新
      const run = persistQueue.then(async () => {
        const list = this.visual().map((m, i) => ({ ...m, order: i }));
        this.modules = await window.api.modules.reorder(plain(list));
      });
      persistQueue = run.catch(() => undefined);
      await run;
    },
    async add(module: Module) {
      this.modules = await window.api.modules.add(plain(module));
    },
    async update(id: string, patch: Partial<Module>) {
      this.modules = await window.api.modules.update(id, plain(patch));
    },
    async remove(id: string) {
      this.modules = await window.api.modules.remove(id);
    },
    async setPinned(id: string, pinned: boolean) {
      const target = this.modules.find((m) => m.id === id);
      if (!target || target.pinned === pinned) return;
      target.pinned = pinned;
      await this.persist();
    },
    async move(id: string, dir: -1 | 1) {
      const visual = this.visual();
      const idx = visual.findIndex((m) => m.id === id);
      const other = visual[idx + dir];
      if (!other || other.pinned !== visual[idx].pinned) return;
      visual[idx] = other;
      visual[idx + dir] = this.modules.find((m) => m.id === id)!;
      this.modules = visual;
      await this.persist();
    },
    async reorderTo(dragId: string, targetId: string) {
      const drag = this.modules.find((m) => m.id === dragId);
      if (!drag) return;
      const current = this.visual();
      const fromIdx = current.findIndex((m) => m.id === dragId);
      const toIdx = current.findIndex((m) => m.id === targetId);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
      const pinnedList = current.filter((m) => m.pinned && m.id !== dragId);
      const normalList = current.filter((m) => !m.pinned && m.id !== dragId);
      const list = drag.pinned ? pinnedList : normalList;
      const idx = list.findIndex((m) => m.id === targetId);
      // UI-11 修复：向下拖时插到目标之后（此前永远插到目标前，相邻下移失效）
      const insertAt = idx >= 0 ? (fromIdx < toIdx ? idx + 1 : idx) : 0;
      list.splice(insertAt, 0, drag);
      this.modules = [...pinnedList, ...normalList];
      await this.persist();
    }
  }
});
