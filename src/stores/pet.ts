import { defineStore } from 'pinia';
import type { PetFrameSet } from '../../shared/types';

export const usePetStore = defineStore('pet', {
  state: () => ({
    frames: null as PetFrameSet | null,
    urls: {} as Record<string, string>,
    current: '' as string,
    animating: false,
    bubble: '' as string,
    bubbleTimer: 0 as ReturnType<typeof setTimeout> | 0
  }),
  actions: {
    async loadFrames() {
      this.frames = await window.api.pet.getFrames();
      this.current = '';
      await this.preloadAll();
    },
    async resolve(path: string): Promise<string> {
      if (!path) return '';
      if (this.urls[path]) return this.urls[path];
      try {
        const url = await window.api.asset.toUrl(path);
        this.urls[path] = url;
        return url;
      } catch {
        return '';
      }
    },
    async preloadAll() {
      if (!this.frames) return;
      const paths = new Set<string>([this.frames.image]);
      for (const frames of Object.values(this.frames.actions)) {
        for (const f of frames) paths.add(f);
      }
      await Promise.all([...paths].map((p) => this.resolve(p)));
    },
    async play(frames: string[]) {
      const urls = (await Promise.all(frames.map((f) => this.resolve(f)))).filter(Boolean);
      if (!urls.length) return;
      this.animating = true;
      const cycle = urls.length > 1 ? urls : [...urls, ...urls];
      let i = 0;
      await new Promise<void>((done) => {
        const step = () => {
          this.current = cycle[i % cycle.length];
          i++;
          if (i < cycle.length + (urls.length > 1 ? 1 : 2)) {
            setTimeout(step, 160);
          } else {
            this.animating = false;
            if (this.frames) this.current = this.urls[this.frames.image] ?? this.current;
            done();
          }
        };
        step();
      });
    },
    notify(text: string) {
      this.bubble = text;
      if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
      this.bubbleTimer = setTimeout(() => (this.bubble = ''), 6000);
    }
  }
});
