import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { dataStore, defaultPetImage, petFramesDir } from '../store/dataStore';
import { activeBubbleStyle, activeThemeScale } from './themePack';
import { playPetAction } from '../windows/petWindow';
import { logWarn } from '../utils/log';
import type { PetFrameSet } from '../../shared/types';

const ACTIONS = ['nod', 'wave', 'blink', 'jump'] as const;

/**
 * 规范化用户存的路径值：去掉首尾空白与「被引号包起来」的脏值。
 *
 * 历史缺陷（幽灵窗口根因）：设置里若存成字面量 `""`（两个引号字符），它是**真值**，
 * `settings.petImage || defaultPetImage()` 的 `||` 回退不会生效；渲染端随后用这个非法路径
 * 去 `asset.toUrl()` 加载图片失败 → `<img src="">` → **宠物窗什么都不画**，而窗口仍是
 * 透明置顶且可接收鼠标事件 = 「看不见却挡住点击」的幽灵窗口。
 */
function normalizeStoredPath(v: unknown): string {
  let s = String(v ?? '').trim();
  for (let i = 0; i < 3; i++) {
    const wrapped =
      s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")));
    if (!wrapped) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * 生效的宠物形象路径：缺失 / 非法 / 文件不存在时回退内置默认形象，并清理脏配置（自愈）。
 * 无论配置多脏，返回值一定是「存在且可读」的图片路径——宠物窗因此永远不会变成空白窗。
 */
export function resolvePetImage(): string {
  const settings = dataStore().get().settings;
  const raw = normalizeStoredPath(settings.petImage);
  if (raw && existsSync(raw)) return raw;
  const stored = String(settings.petImage ?? '');
  if (stored !== '') {
    logWarn(
      `[pet] 宠物形象不可用，已回退默认形象（配置值=${JSON.stringify(stored.slice(0, 80))} → 解析值=${JSON.stringify(raw.slice(0, 80))}）`
    );
    // 清理脏值：'' 表示使用内置默认形象，避免下次再走坏分支
    dataStore().updateSettings({ petImage: '' });
  }
  return defaultPetImage();
}

function actionFrames(action: string): string[] {
  const custom = dataStore().get().settings.petActions[action];
  // 自定义动作帧同样要过滤脏值/失效文件，否则播放动作时又会出现空白帧
  const validCustom = (custom ?? []).map(normalizeStoredPath).filter((p) => p && existsSync(p));
  if (validCustom.length) return validCustom;
  const dir = join(petFramesDir(), action);
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /\.(png|gif|webp)$/i.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export function getFrameSet(): PetFrameSet {
  const actions: Record<string, string[]> = {};
  for (const a of ACTIONS) actions[a] = actionFrames(a);
  // T-06：气泡样式与缩放来自当前主题包（无主题包时是主进程给出的默认值）
  return { image: resolvePetImage(), actions, bubble: activeBubbleStyle(), scale: activeThemeScale() };
}

export function playRandomAction(): void {
  const actions = getFrameSet().actions;
  const names = Object.keys(actions).filter((k) => actions[k].length);
  if (!names.length) return;
  const name = names[Math.floor(Math.random() * names.length)];
  playPetAction(actions[name]);
}

export function playAction(action: string): void {
  const frames = getFrameSet().actions[action];
  if (frames && frames.length) playPetAction(frames);
}
