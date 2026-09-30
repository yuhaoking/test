import { request } from 'https';
import { db } from '../store/db';
import { dataStore } from '../store/dataStore';
import { AGENT_TOOLS, execAgentTool } from './agentTools';
import { notifyPet } from '../windows/petWindow';
import { logError } from '../utils/log';
import type { ChatMessage, ChatReply } from '../../shared/types';

/**
 * AI 宠物对话内核（T-05）
 *
 * - DeepSeek Chat Completions（OpenAI 兼容）驱动，人设化 System Prompt（名字/性格/口癖，设置 → 桌面宠物）；
 * - 记忆机制：最近 24 条对话持久化到 `pet_memory` 表，随上下文回灌；
 * - Agent 工具闭环（agentTools）：待办快记 / 插件命令 / 音乐控制 / 文件定位 / 截图，最多 3 轮工具调用；
 * - 回复通过宠物气泡播报（notifyPet），开启语音播报后 TTS 朗读。
 */

interface LlmMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export type { LlmMsg };

const MEMORY_KEY = 'chat';
const MEMORY_MAX = 24;

export function loadMemory(): ChatMessage[] {
  try {
    const raw = db().get('pet_memory', MEMORY_KEY);
    return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

function saveMemory(list: ChatMessage[]): void {
  try {
    db().set('pet_memory', MEMORY_KEY, JSON.stringify(list.slice(-MEMORY_MAX)));
  } catch (e) {
    logError('[llm] 记忆保存失败', e);
  }
}

export function clearMemory(): void {
  try {
    db().delete('pet_memory', MEMORY_KEY);
  } catch {
    /* 忽略 */
  }
}

function systemPrompt(): string {
  const s = dataStore().get().settings;
  const name = s.petName || '小鹏';
  const lines = [
    `你是「${name}」，一只陪伴用户左右的桌面宠物伙伴。`,
    s.petPersona || '性格温暖、俏皮、可靠，关心用户，说话简短口语化。',
    s.petWorldview ? `世界观/自我介绍（背景故事，聊到相关话题时自然体现）：${s.petWorldview}` : '',
    s.petCatchphrase ? `口癖（偶尔自然地带上，不重复）：「${s.petCatchphrase}」。` : '',
    '回复保持 1~3 句、口语化、温暖。用户要你做事时，用工具完成再汇报：翻译/插件任务走 run_plugin_command，',
    '记待办走 add_todo，音乐播放/切歌走 control_music，找文件走 find_file（可 open 直接打开），截图走 screenshot。',
    '下方附有最近对话记忆。'
  ];
  return lines.filter(Boolean).join('\n');
}

/** DeepSeek Chat Completions 底层调用（对话 / T-06 插件生成共用；tools 可选） */
export function callDeepSeek(
  key: string,
  messages: LlmMsg[],
  tools?: unknown[],
  maxTokens = 1024
): Promise<LlmMsg> {
  const body = JSON.stringify({
    model: 'deepseek-chat',
    messages,
    ...(tools ? { tools } : {}),
    max_tokens: maxTokens
  });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: 'api.deepseek.com',
        path: '/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        // P3 加固：响应体大小上限，防止异常/恶意响应把主进程内存打满
        const MAX_BYTES = 4 * 1024 * 1024;
        let data = '';
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            res.destroy(new Error('模型响应超出大小限制'));
            return;
          }
          data += c;
        });
        res.on('end', () => {
          try {
            const j = JSON.parse(data) as {
              choices?: Array<{ message: LlmMsg }>;
              error?: { message?: string };
            };
            const msg = j.choices?.[0]?.message;
            if (!msg) reject(new Error(j.error?.message || `HTTP ${res.statusCode}`));
            else resolve(msg);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('请求超时')));
    req.write(body);
    req.end();
  });
}

async function execTool(name: string, args: Record<string, unknown>): Promise<string> {
  return execAgentTool(name, args);
}

/** T-05：一轮对话（含 Agent 工具闭环，最多 3 轮工具调用） */
export async function chatRound(userMessage: string): Promise<ChatReply> {
  const s = dataStore().get().settings;
  const key = (s.deepseekApiKey ?? '').trim();
  const memory = loadMemory();
  const history: ChatMessage[] = [...memory, { role: 'user', content: userMessage }];
  const trace: string[] = [];
  if (!key) {
    const reply = '（咕…我还没接上大脑：请在 设置 → 通用 填入 DeepSeek API Key，然后我就能陪你聊天啦）';
    history.push({ role: 'assistant', content: reply });
    saveMemory(history);
    return { reply, trace };
  }
  const msgs: LlmMsg[] = [
    { role: 'system', content: systemPrompt() },
    ...memory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage }
  ];
  try {
    for (let round = 0; round < 3; round++) {
      const msg = await callDeepSeek(key, msgs, AGENT_TOOLS, 1024);
      if (msg.tool_calls?.length) {
        msgs.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
          } catch {
            /* 参数解析失败按空参数处理 */
          }
          trace.push(`${tc.function.name}(${tc.function.arguments})`);
          const out = await execTool(tc.function.name, args);
          msgs.push({ role: 'tool', content: out, tool_call_id: tc.id });
        }
        continue;
      }
      const reply = (msg.content ?? '').trim() || '（我在听…）';
      history.push({ role: 'assistant', content: reply, trace: trace.length ? [...trace] : undefined });
      saveMemory(history);
      notifyPet(reply.length > 120 ? `${reply.slice(0, 120)}…` : reply);
      return { reply, trace };
    }
    const reply = '（工具调用有点多，我先歇一下…再试一次吧）';
    history.push({ role: 'assistant', content: reply });
    saveMemory(history);
    return { reply, trace };
  } catch (e) {
    logError('[llm] 对话失败', e);
    const reply = `（唔，大脑连接失败：${(e as Error).message}）`;
    history.push({ role: 'assistant', content: reply });
    saveMemory(history);
    return { reply, trace };
  }
}
