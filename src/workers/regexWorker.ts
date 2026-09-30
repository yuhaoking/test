/**
 * 正则匹配 Worker（P2-11）
 *
 * 为什么需要它：JS 的正则一旦陷入灾难性回溯就无法中断，跑在主线程上会把整个界面冻住
 * （实测 `(a+)+$` 对 28 个字符即耗时 3.7 秒，30+ 字符基本等于死机）。
 * 放到 Worker 后，主线程可以用 worker.terminate() 在超时后强制终止，界面始终可交互。
 */
import { regexHighlight, regexTest } from '../../shared/devtools/regex';

export interface RegexRequest {
  seq: number;
  pattern: string;
  flags: string;
  input: string;
}

self.onmessage = (e: MessageEvent<RegexRequest>): void => {
  const { seq, pattern, flags, input } = e.data;
  const result = regexTest(pattern, flags, input);
  const segments = result.ok ? regexHighlight(pattern, flags, input) : [];
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ seq, result, segments });
};
