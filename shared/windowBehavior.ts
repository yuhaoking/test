/**
 * 悬浮窗行为规则的纯函数（侧边栏"鼠标移出自动收回"）
 *
 * 为什么单独抽出来：这段逻辑是一个小状态机（本次显示期间是否入内 / 是否还在宽限期 / 离开是否已持续够久），
 * 埋在 500ms 定时器里就只能靠手动复现来验证 —— 而它直接决定"侧边栏会不会在你正要操作时消失"。
 * 抽成纯函数后，`npm test` 可以用伪时间轴把各种时序逐个断言。
 *
 * 背景（用户反馈 + 本机日志实测）：固定 500ms 轮询 + "看到一次在外面就收回" 的判定过于敏感，
 * 日志里出现过 显示后 1.03s / 1.54s 就被收回 的记录 —— 用户的实际感受是"工作台点了侧边栏，
 * 刚要去点按钮它就没了，只能反复重开"。两个防护：
 *  · **宽限期**：显示后一段时间内绝不收回（鼠标恰好在侧边栏将要出现的位置时尤其重要）；
 *  · **离开去抖**：光标必须**持续**在外一段时间才收回，扫过边界、短暂移开去拿别的东西都不算。
 */

/** 显示后多久内绝不收回（毫秒） */
export const COLLAPSE_GRACE_MS = 1200;
/** 光标需要连续离开多久才收回（毫秒） */
export const COLLAPSE_LEAVE_MS = 900;

export interface CollapseState {
  /** 本次显示期间光标是否进入过侧边栏（没进过就永不自动收回，否则热键唤出会瞬间消失） */
  wasInside: boolean;
  /** 本次显示的起始时刻（毫秒） */
  shownAt: number;
  /** 光标开始"持续在外"的时刻；0 表示当前在内部或尚未开始计时 */
  outsideSince: number;
}

/** 每次显示侧边栏都要重置：不能把上一次的"入内过"带到下一次，否则新一轮的第一次外部采样就会立刻收回 */
export function beginCollapseSession(now: number): CollapseState {
  return { wasInside: false, shownAt: now, outsideSince: 0 };
}

export interface CollapseStepInput {
  now: number;
  /** 光标当前是否位于侧边栏矩形内 */
  inside: boolean;
  /** 覆盖宽限期（测试与特殊场景用） */
  graceMs?: number;
  /** 覆盖离开去抖时长 */
  leaveMs?: number;
}

/**
 * 推进一步状态机。
 * @returns 新状态与"本次是否应当收回"
 */
export function stepCollapse(
  state: CollapseState,
  input: CollapseStepInput
): { state: CollapseState; collapse: boolean } {
  const graceMs = input.graceMs ?? COLLAPSE_GRACE_MS;
  const leaveMs = input.leaveMs ?? COLLAPSE_LEAVE_MS;

  if (input.inside) {
    return { state: { ...state, wasInside: true, outsideSince: 0 }, collapse: false };
  }
  // 从未进入过：不收回（热键/工作台唤出侧边栏时鼠标本来就在别处）
  if (!state.wasInside) return { state, collapse: false };
  // 宽限期内：连"在外"计时都不开始 —— 这样最短存活时间是可预期的 宽限期+去抖
  if (input.now - state.shownAt < graceMs) return { state, collapse: false };

  const outsideSince = state.outsideSince || input.now;
  if (input.now - outsideSince < leaveMs) {
    return { state: { ...state, outsideSince }, collapse: false };
  }
  return { state: { ...state, outsideSince: 0 }, collapse: true };
}

/**
 * 失焦是否应当收回侧边栏。
 * 同样要过宽限期：刚从工作台/宠物呼出时，焦点交接过程中的失焦不能算"用户离开了"。
 */
export function shouldCollapseOnBlur(state: CollapseState, now: number, graceMs = COLLAPSE_GRACE_MS): boolean {
  if (!state.wasInside) return false;
  return now - state.shownAt >= graceMs;
}
