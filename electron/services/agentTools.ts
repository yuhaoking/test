import { startFullCapture, startRegionCapture } from './captureManager';
import { openPath, quickFileSearch } from './fileSearch';
import { controlMusic, getMusicState } from './musicControl';
import { addTodoQuick } from './paletteSearch';
import { runPluginCommand } from './pluginManager';

/**
 * 桌宠 Agent 工具集（T-05「宠物即 Agent 入口」）
 *
 * 同一套工具两个出口：
 * - 对内：llm.ts DeepSeek function calling（聊天对话闭环）；
 * - 对外：mcpServer.ts MCP tools/call（外部 MCP 客户端经 stdio 桥调用）。
 */

export interface AgentToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const AGENT_TOOLS: AgentToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'add_todo',
      description: '把用户要记录的事情加入待办清单',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '待办内容' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_plugin_command',
      description:
        '调用工具箱内的插件命令完成任务。翻译文本用 plugin_id=com.office.translate.cnen, command=translate, text=待翻译内容；AI 用量播报用 plugin_id=com.office.deepseek.monitor, command=report',
      parameters: {
        type: 'object',
        properties: {
          plugin_id: { type: 'string', description: '插件 id' },
          command: { type: 'string', description: '命令 id' },
          text: { type: 'string', description: '要处理的文本' }
        },
        required: ['plugin_id', 'command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'control_music',
      description: '控制系统音乐播放（Windows SMTC，支持 QQ 音乐/网易云/Spotify/酷狗等）。也可查询当前播放状态',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['play', 'pause', 'toggle', 'next', 'prev', 'state'],
            description: '播放控制指令；state=仅查询当前播放'
          }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_file',
      description: '按名称快速查找本机文件（优先 Everything 索引，兜底快速遍历）；open=true 时直接打开第一条命中',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '文件名关键词' },
          open: { type: 'boolean', description: '是否直接打开第一条命中（找文件并打开时传 true）' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: '发起截图：region=区域截图（拖选），full=全屏截图（进入标注器）',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['region', 'full'], description: '截图方式' }
        },
        required: ['mode']
      }
    }
  }
];

function musicSummary(state: {
  hasSession: boolean;
  title: string;
  artist: string;
  playing: boolean;
}): string {
  if (!state.hasSession) return '当前没有正在播放的媒体会话';
  return `《${state.title || '未知曲目'}》- ${state.artist || '未知歌手'}（${state.playing ? '播放中' : '已暂停'}）`;
}

/** 执行一个 Agent 工具，返回人类可读结果文本（对话/MCP 共用） */
export async function execAgentTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === 'add_todo') {
      addTodoQuick(String(args.text ?? ''));
      return '已加入待办清单';
    }
    if (name === 'run_plugin_command') {
      const r = await runPluginCommand(
        String(args.plugin_id ?? ''),
        String(args.command ?? ''),
        args.text != null ? String(args.text) : undefined
      );
      const msg = (r as { message?: string } | null)?.message;
      return msg || JSON.stringify(r ?? null);
    }
    if (name === 'control_music') {
      const action = String(args.action ?? 'state');
      if (action === 'state') {
        return musicSummary(await getMusicState());
      }
      const map: Record<string, string> = {
        play: 'play',
        pause: 'pause',
        toggle: 'toggle',
        next: 'next',
        prev: 'prev'
      };
      const mapped = map[action];
      if (!mapped) return `未知音乐指令 ${action}`;
      const st = await controlMusic(mapped);
      return `已执行 ${action}；${musicSummary(st)}`;
    }
    if (name === 'find_file') {
      const query = String(args.query ?? '').trim();
      if (!query) return '缺少文件名关键词';
      const results = await quickFileSearch(query, 800, 10);
      if (!results.length) return `没有找到包含「${query}」的文件`;
      if (args.open === true) {
        await openPath(results[0].path);
        return `已打开：${results[0].path}`;
      }
      return results.map((r, i) => `${i + 1}. ${r.name} — ${r.path}`).join('\n');
    }
    if (name === 'screenshot') {
      const mode = String(args.mode ?? 'region');
      if (mode === 'full') {
        await startFullCapture();
        return '已开始全屏截图，进入标注器';
      }
      await startRegionCapture();
      return '已开始区域截图，请拖选屏幕区域';
    }
    return `未知工具 ${name}`;
  } catch (e) {
    return `工具执行失败：${(e as Error).message}`;
  }
}
