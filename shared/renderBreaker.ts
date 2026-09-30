/**
 * 渲染进程启动熔断的状态机（R2-T8，纯函数）
 *
 * 为什么单独抽成纯函数：审计 DEF-R01 实测到"一次启动里 250ms 内 15 次 render-process-gone"，
 * 而看门狗的恢复动作本身没有熔断 —— 每个显示入口都会再建一次渲染进程，而这类故障
 * （系统拦住了子进程创建）重试一万次也不会成功。
 *
 * 熔断是**安全关键**行为：判错一边就退化成"无限重试把日志刷爆"，
 * 判错另一边则会把"偶发一次崩溃"误判成环境故障、让用户白白被劝去关沙箱。
 * 因此把判定规则放在这里，让 npm test 能直接覆盖每一条边界，而不是只测字符串。
 *
 * 规则（全部来自实机证据）：
 *   · launch-failed —— 渲染子进程**从未创建成功**，是环境级故障，一次即可熔断；
 *   · 其它 reason（crashed / oom / killed…）—— 运行期崩溃，reload 有意义，
 *     走原有"5 分钟 ≥3 次隐藏"策略；
 *   · 熔断后**永久保持**：它反映的是环境状态，只有换启动方式（关沙箱）或改系统策略才有意义，
 *     所以在同一进程内不做自愈 —— 自愈只会把"15 次无效建窗"变成"每 5 分钟 15 次"。
 */

export type GoneReason = 'launch-failed' | 'crashed' | 'oom' | 'killed' | 'integrity-failure' | string;

export interface BreakerState {
  /** 是否已熔断（本进程内不再新建渲染进程） */
  broken: boolean;
  /** 触发熔断的原因（用于日志与对话框文案） */
  reason: string;
}

export function initialBreakerState(): BreakerState {
  return { broken: false, reason: '' };
}

/**
 * 该 reason 是否属于"环境级、重试无意义"，应直接熔断。
 *
 * 容错说明（实机踩过）：调用方可能把原因拼成展示用的形式（例如 `reason=launch-failed`），
 * 而这里原本是**精确匹配**，于是熔断永远不触发 —— 表现为"窗口被反复重建、通知一直弹"。
 * 现在剥掉常见的 `reason=` / `: ` / 空白前缀后再比对，让"传什么形式"不再决定正确性；
 * 但**只做前缀剥离，不做包含匹配**，避免把 `crashpad-launch-failed` 之类误判成环境级故障。
 */
export function isLaunchFailure(reason: GoneReason): boolean {
  const s = String(reason ?? '').trim();
  const stripped = s.replace(/^reason\s*[:=]\s*/i, '').trim();
  return stripped === 'launch-failed';
}

/**
 * 记录一次渲染进程消失，返回新的熔断状态。
 *
 * 纯函数：不读全局、不打日志、不碰 Electron，便于逐条断言。
 */
export function recordRenderGone(state: BreakerState, reason: GoneReason): BreakerState {
  if (state.broken) return state; // 已熔断：保持，且不覆盖原始原因
  if (!isLaunchFailure(reason)) return state; // 运行期崩溃不熔断
  return { broken: true, reason: `reason=${String(reason)}` };
}

/**
 * 熔断期间的统一决策：调用方（重载 / 显示前自检 / 活性探测）据此短路。
 *
 * action 语义：
 *   · reload    —— 允许重载（运行期崩溃的常规恢复）
 *   · hide-only —— 只隐藏窗口、不重载（反复崩溃，或启动失败）
 *   · skip      —— 什么都不做（熔断期间连隐藏都没必要，窗口本来就没画出来）
 */
export type RecoveryAction = 'reload' | 'hide-only' | 'skip';

export function decideRecovery(
  state: BreakerState,
  opts: { launchFailed: boolean; recentFailures: number; hideThreshold: number }
): RecoveryAction {
  if (state.broken) return 'skip';
  if (opts.launchFailed) return 'hide-only';
  if (opts.recentFailures >= opts.hideThreshold) return 'hide-only';
  return 'reload';
}
