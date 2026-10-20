import Anthropic from '@anthropic-ai/sdk'
import type {
  ContentBlock,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages.js'
import { config } from './config.js'
import { logger } from './logger.js'
import { anthropicTools, executeTool } from './tools.js'
import { stripToolMarkup } from './sanitize.js'

/**
 * Anthropic client wrapper with tool-use loop. The loop:
 *   1. send messages (+ tool defs) to the model
 *   2. if `stop_reason === 'tool_use'`, execute each tool_use block,
 *      append the assistant turn + a user turn of tool_result blocks,
 *      and re-send
 *   3. otherwise return the final text
 *
 * Capped at MAX_TOOL_ITERATIONS to prevent runaway loops. The last iteration is
 * sent WITHOUT tool definitions, which forces the model to answer with whatever
 * it has already gathered instead of ending the turn with "hit the cap".
 */

const client = new Anthropic({
  ...(config.ANTHROPIC_BASE_URL ? { baseURL: config.ANTHROPIC_BASE_URL } : {}),
  authToken: config.ANTHROPIC_AUTH_TOKEN,
})

const MAX_TOOL_ITERATIONS = config.MAX_TOOL_ITERATIONS

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatResult {
  text: string
  inputTokens: number
  outputTokens: number
  modelEcho: string
  toolCalls: number
  /** 被取消（用户发了新消息 / 撤回了消息）时为 true，调用方不要再回复。 */
  aborted?: boolean
}

export interface ChatOptions {
  signal?: AbortSignal
  /** 当前会话 id，工具可以用它把"当前对话"作为默认值（例如列出本会话最近消息）。 */
  chatId?: string
}

const SYSTEM_PROMPT = `You are a helpful Feishu/Lark assistant connected to the user via a bot bridge. Reply in the same language as the user's message. When the user asks about specific chats, documents, or tables they have access to, use the provided tools to fetch real data rather than guessing.

Be economical with tools — this is a chat UI and the user is waiting:
- Search first, then read only the 1-3 most relevant hits. Do NOT read every result.
- **搜索类问题一律先用 lark_search_all**（用户说 搜索/查一下/有没有关于 X/X 在哪/一共多少）：它一次覆盖 文档+知识库+表格（标题片段）、聊天记录、以及最相关表格的表内单元格。返回里三个来源口径不同，回答时要分别标明（文档数 / 聊天条数 / 单元格数），再说结论。
- 需要更深的表内检索时，再用 lark_search_in_sheet 指定具体表格；需要看聊天原文用 lark_chat_messages_list。
- 回答要短：一般控制在 200 字以内。除非用户明确要清单，不要整张表照搬，只给关键几行/几个字段。输出越长用户等得越久。
- For spreadsheets: call lark_sheet_info to see the tab list before reading (they often have 30+ tabs), and use lark_search_in_sheet to locate a specific row/ID — never assume the first tab or a guessed range holds the answer.
- 在表里找东西时用 lark_search_in_sheet，并且**尽量带上 sheet_name**：只扫一页约 1 秒，扫整本 38 页要 20 秒。猜得出大概在哪页（道具/活动/装备…）就先只扫那页；实在不知道再整本扫。不要反复换关键词重扫整本表，两次没找到就换策略或直接说明没找到。
- 用户说「所有 / 全部 / 完整清单 / 都列出来」时，必须在调用 lark_search_in_sheet 时传 scan_all=true（默认只找到 10 条就停，会漏）。工具返回里 stopped_early=true 说明还有页签没扫完，这时要么用 scan_all 重扫，要么在回答里说明结果不完整。
- **多张图要一次插完**：用 lark_doc_insert_images（一次调用可带多个分组、每组一个标题、组内多张图），**不要**逐张调 lark_doc_insert_image——26 张图那样会把工具轮数耗光。单张才用 lark_doc_insert_image。
- lark_chat_messages_list **不传 chat_id 就默认当前会话**，不要为了拿 chat_id 去查 +chat-list。
- **报数量时必须说清口径**：lark_search_docs 的 total 是**文档数**（全库，一篇算一条）；lark_search_in_sheet 的 match_count 是**单元格数**（而且只覆盖你指定的那一本表）。两者数字不同是正常的，不要互相替换着说。用户问"KVM 一共多少"这类问题时，把两个数都给出并标明范围，例如「全库文档 139 篇；《常用ID信息表》原版表内 75 个单元格」。
- 同一份资料常有多份副本（…副本 / 原版 / 第三份），只扫一本就报"全部"是错的 —— 要么把相关副本都扫了，要么明确说只扫了哪一本。
- When a task needs something the tools above do not cover (Bitable records, uploading files, writing cells, chat admin, whiteboards…), use lark_cli with the raw command array; it exposes every authorised Feishu CLI command. Irreversible commands are refused by the bridge — tell the user to do those by hand.
- ALWAYS 附上来源链接：只要回答里提到了具体的文档、表格或某一行数据，就用 Markdown 链接写出工具结果里返回的 url 字段，例如 [《…常用ID信息表》](https://thedream.feishu.cn/wiki/xxxx)。直接复制工具给的 url，不要自己拼。多个来源就列多条链接。
- The moment you have enough to answer, stop calling tools and write the answer.
- If a tool returns nothing useful after two attempts, say so plainly instead of trying more variations.`

export async function chat(history: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  // Anthropic SDK uses MessageParam[] which accepts string content for the
  // initial turns. We append tool-result turns as we loop.
  const messages: MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }))

  let totalIn = 0
  let totalOut = 0
  let toolCalls = 0
  let finalText = ''
  let modelEcho = config.ANTHROPIC_MODEL

  const aborted = (): boolean => opts.signal?.aborted === true
  const abortedResult = (): ChatResult => ({
    text: '',
    inputTokens: totalIn,
    outputTokens: totalOut,
    modelEcho,
    toolCalls,
    aborted: true,
  })

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    // 用户又发了一条 / 撤回了这条 → 立刻停手，连工具都不用跑了
    if (aborted()) {
      logger.info({ iter, toolCalls }, 'turn aborted by a newer message or a recall')
      return abortedResult()
    }
    // 最后一轮不带工具：模型想再查也查不了，只能把已有信息整理成回答。
    const isLastIteration = iter === MAX_TOOL_ITERATIONS - 1
    // 重要（踩过）：最后一轮**不能**把 tools 从请求里去掉。历史里已经有
    // tool_use / tool_result 块，模型看到"没有工具却又要接着调"，就会退化成
    // 输出原始调用标记（DeepSeek 上必现），清洗后正文变空 → 用户收到兜底文案。
    // 正确做法是继续带着工具定义，但用一句话要求它现在给结论。
    const callMessages: MessageParam[] = isLastIteration
      ? [
          ...messages,
          {
            role: 'user',
            content:
              '（系统提示：工具调用次数已达上限，请立刻用已有信息给出最终回答，不要再调用任何工具。）',
          },
        ]
      : messages
    let resp: Awaited<ReturnType<typeof client.messages.create>>
    try {
      const reqOptions = opts.signal ? { signal: opts.signal } : {}
      resp = await client.messages.create(
        {
          model: config.ANTHROPIC_MODEL,
          max_tokens: config.MAX_TOKENS_REPLY,
          system: SYSTEM_PROMPT,
          ...(config.ENABLE_TOOLS ? { tools: anthropicTools() } : {}),
          messages: callMessages,
        },
        reqOptions,
      )
    } catch (err) {
      if (aborted()) {
        logger.info({ iter }, 'request aborted mid-flight')
        return abortedResult()
      }
      throw err
    }

    totalIn += resp.usage.input_tokens
    totalOut += resp.usage.output_tokens
    modelEcho = resp.model

    if (resp.stop_reason !== 'tool_use') {
      finalText = extractText(resp.content)
      logger.debug(
        { iter, in: totalIn, out: totalOut, toolCalls, stop: resp.stop_reason, last: isLastIteration },
        'chat done',
      )
      break
    }

    // 最后一轮它还是想调工具：不再执行，取它写出来的正文收尾。
    if (isLastIteration) {
      finalText = extractText(resp.content).replace(/^\(empty response\)$/, '')
      logger.warn(
        { iter, toolCalls, wanted: resp.content.filter((b) => b.type === 'tool_use').length },
        'still asked for tools on the final iteration, answering with what we have',
      )
      break
    }

    if (!config.ENABLE_TOOLS) {
      // Defensive: if a model returns tool_use without us asking, just take
      // whatever text it gave and call it a day.
      finalText = extractText(resp.content) || '(unexpected tool_use without ENABLE_TOOLS)'
      break
    }

    const toolUses = resp.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    )
    toolCalls += toolUses.length

    // 模型刚给出工具调用，但这期间用户已经发了新消息 → 不要再执行了
    if (aborted()) {
      logger.info({ iter, toolCalls }, 'aborted before executing tools')
      return abortedResult()
    }

    // Echo the assistant turn verbatim so the next request has full context.
    messages.push({ role: 'assistant', content: resp.content })

    // 同一轮里的多个工具调用并行跑：模型经常一次发 2~3 个（搜表 + 搜文档…），
    // 串行的话每个都要等一次 lark-cli（约 0.9~1.3s）。结果按原顺序回填，
    // tool_use_id 保证了对得上。
    const toolResults: ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu) => {
        const out = await executeTool(tu.name, (tu.input ?? {}) as Record<string, unknown>, {
          ...(opts.chatId ? { chatId: opts.chatId } : {}),
        })
        return {
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: typeof out === 'string' ? out : JSON.stringify(out).slice(0, 8000),
        }
      }),
    )
    messages.push({ role: 'user', content: toolResults })
  }

  // 模型偶尔会退化成输出原生工具调用标记（不是结构化 tool_use），
  // 那玩意儿发到飞书就是一堆乱码标签。清掉；如果清完什么都不剩，
  // 再给它一次机会，明确要求用自然语言作答。
  const sanitized = stripToolMarkup(finalText)
  if (sanitized.hadMarkup) {
    logger.warn({ toolCalls, before: finalText.length }, 'model leaked raw tool-call markup, stripped')
    finalText = sanitized.text
  }

  if (aborted()) return abortedResult()

  if (!finalText && sanitized.hadMarkup) {
    try {
      // 用一个**干净的最小上下文**重新问一次：不带任何 tool_use / tool_result。
      // 复用原来的 messages 会再次把模型带进"工具模式"、继续吐标记（实测三次都这样）。
      const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content ?? ''
      const retry = await client.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: config.MAX_TOKENS_REPLY,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content:
              `用户的问题：${lastUser}\n\n` +
              '（请直接用自然语言回答这个问题，不要输出任何工具调用标记，也不要调用工具。）',
          },
        ],
      })
      totalIn += retry.usage.input_tokens
      totalOut += retry.usage.output_tokens
      finalText = stripToolMarkup(extractText(retry.content)).text
      logger.info(
        { recoveredChars: finalText.length, toolCalls },
        'recovered a prose answer with a clean context after markup leak',
      )
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'recovery call after leaked markup failed')
    }
  }

  if (!finalText || finalText === '(empty response)') {
    finalText =
      '这次我没能组织出回答（模型连续输出无效内容）。可以再问一次，或者把范围说具体一点——比如直接给我文档/表格的名字。'
  }

  return {
    text: finalText,
    inputTokens: totalIn,
    outputTokens: totalOut,
    modelEcho,
    toolCalls,
  }
}

function extractText(blocks: ContentBlock[]): string {
  return (
    blocks
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim() || '(empty response)'
  )
}
