#!/usr/bin/env node
/**
 * 幽灵窗口实验结果分析器
 * 用法：node test-audit/analyze-ghost-probe.mjs [probeDir=test-audit/.ghost-probe]
 *
 * 判定逻辑（按时间戳把“点击发送”与“渲染进程收到的 mousedown”对账）：
 *   transparent 点（幽灵窗透明区，同时也在目标窗内）：
 *     落到 target = 透明像素点击穿透（Windows 正常行为）
 *     落到 ghost  = 透明像素吞点击 ← 幽灵机制之一
 *     落到 none   = 无人收到 ← 幽灵挡板（崩溃/冻结窗挡住下面的窗口）
 *   dot 点（幽灵窗的不透明小块）：应落 ghost；落 none = 幽灵窗整体失灵
 *   各阶段帧率（history.jsonl）：被遮挡阶段帧率归零 = 合成被冻结
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || join(process.cwd(), 'test-audit', '.ghost-probe');
const clicks = existsSync(join(dir, 'clicks.jsonl'))
  ? readFileSync(join(dir, 'clicks.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  : [];
const history = existsSync(join(dir, 'history.jsonl'))
  ? readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  : [];
if (!history.length) {
  console.log('没有 history.jsonl —— 探测器没有跑起来或没到分析阶段。');
  process.exit(1);
}
const last = history[history.length - 1];
const clicksOf = (win) => (last.stats && last.stats[win] && Array.isArray(last.stats[win].clicks) ? last.stats[win].clicks : []);

// 点击归属：某点发出后 ±500ms 内，哪个窗口的点击时间序列新增
const owners = [];
for (const c of clicks) {
  let owner = 'none';
  for (const w of ['ghost', 'target']) {
    const hit = clicksOf(w).some((r) => Math.abs(r.t - c.t) <= 500);
    if (hit) { owner = w; break; }
  }
  owners.push({ ...c, owner });
}

console.log('\n== 点击归属（phase / point -> 谁收到了点击）==');
for (const o of owners) {
  console.log(`  ${o.phase.padEnd(13)} ${o.point.padEnd(11)} -> ${o.owner}`);
}

const summary = {};
for (const o of owners) {
  const k = o.phase + ' / ' + o.point;
  summary[k] = summary[k] || {};
  summary[k][o.owner] = (summary[k][o.owner] || 0) + 1;
}
console.log('\n== 按阶段汇总 ==');
for (const [k, v] of Object.entries(summary)) {
  console.log(`  ${k}: ${JSON.stringify(v)}`);
}

console.log('\n== 各阶段渲染帧率（frames/s，来自 history.jsonl）==');
const phases = {};
for (const h of history) {
  (phases[h.phase] = phases[h.phase] || []).push(h);
}
for (const [p, list] of Object.entries(phases)) {
  const first = list[0], lastH = list[list.length - 1];
  const dt = (lastH.wallClock - first.wallClock) / 1000 || 1;
  const rate = (w) => {
    const a = first.stats && first.stats[w], b = lastH.stats && lastH.stats[w];
    if (!a || !b || typeof a.frames !== 'number' || typeof b.frames !== 'number') return 'n/a';
    return ((b.frames - a.frames) / dt).toFixed(1);
  };
  const vis = (lastH.windows || []).filter((w) => w.name !== 'occluder').map((w) => `${w.name}:${w.visible ? 'visible' : 'hidden'}`).join(' ');
  console.log(`  ${p.padEnd(13)} ghost=${rate('ghost').padStart(6)}/s  target=${rate('target').padStart(6)}/s  [${vis}]`);
}

console.log('\n== 判定 ==');
const verdicts = [];
for (const [k, v] of Object.entries(summary)) {
  if (k.includes('transparent')) {
    if (v.ghost) verdicts.push('[成立] 透明像素吞点击（幽灵窗透明区挡住了下面的窗口）：' + k);
    if (v.none) verdicts.push('[成立] 点击无人接收（有透明/崩溃挡板在吃点击）：' + k);
    if (v.target && !v.ghost && !v.none) verdicts.push('[正常] 透明像素点击穿透：' + k);
  }
  if (k.includes('dot') && v.none) verdicts.push('[成立] 幽灵窗不透明区也收不到点击（渲染已死/冻结）：' + k);
}
if (Object.keys(phases).includes('occluded')) {
  const g = phases.occluded;
  if (g.length > 1) {
    const dt = (g[g.length - 1].wallClock - g[0].wallClock) / 1000 || 1;
    const a = g[0].stats.ghost, b = g[g.length - 1].stats.ghost;
    const rate = a && b && typeof a.frames === 'number' ? (b.frames - a.frames) / dt : -1;
    if (rate >= 0 && rate < 1) verdicts.push('[成立] 被遮挡窗口渲染被冻结（帧率≈' + rate.toFixed(2) + '/s，窗口仍可见）—— 对应“无窗口显示/挡住点击”');
    else verdicts.push('[未复现] 被遮挡阶段渲染仍在跑（帧率≈' + (rate < 0 ? 'n/a' : rate.toFixed(1)) + '/s）');
  }
}
if (!verdicts.length) verdicts.push('未捕获到幽灵机制；请在真实幽灵出现时改用 test-audit/ghost-inspector.ps1 抓现场。');
for (const v of verdicts) console.log('  ' + v);
