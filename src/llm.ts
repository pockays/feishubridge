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
}

const SYSTEM_PROMPT = `You are a helpful Feishu/Lark assistant connected to the user via a bot bridge. Reply in the same language as the user's message. When the user asks about specific chats, documents, or tables they have access to, use the provided tools to fetch real data rather than guessing.

Be economical with tools — this is a chat UI and the user is waiting:
- Search first, then read only the 1-3 most relevant hits. Do NOT read every result.
- 回答要短：一般控制在 200 字以内。除非用户明确要清单，不要整张表照搬，只给关键几行/几个字段。输出越长用户等得越久。
- For spreadsheets: call lark_sheet_info to see the tab list before reading (they often have 30+ tabs), and use lark_search_in_sheet to locate a specific row/ID — never assume the first tab or a guessed range holds the answer.
- 在表里找东西时用 lark_search_in_sheet，并且**尽量带上 sheet_name**：只扫一页约 1 秒，扫整本 38 页要 20 秒。猜得出大概在哪页（道具/活动/装备…）就先只扫那页；实在不知道再整本扫。不要反复换关键词重扫整本表，两次没找到就换策略或直接说明没找到。
- When a task needs something the tools above do not cover (Bitable records, uploading files, writing cells, chat admin, whiteboards…), use lark_cli with the raw command array; it exposes every authorised Feishu CLI command. Irreversible commands are refused by the bridge — tell the user to do those by hand.
- ALWAYS 附上来源链接：只要回答里提到了具体的文档、表格或某一行数据，就用 Markdown 链接写出工具结果里返回的 url 字段，例如 [《…常用ID信息表》](https://thedream.feishu.cn/wiki/xxxx)。直接复制工具给的 url，不要自己拼。多个来源就列多条链接。
- The moment you have enough to answer, stop calling tools and write the answer.
- If a tool returns nothing useful after two attempts, say so plainly instead of trying more variations.`

export async function chat(history: ChatMessage[]): Promise<ChatResult> {
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

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    // 最后一轮不带工具：模型想再查也查不了，只能把已有信息整理成回答。
    const isLastIteration = iter === MAX_TOOL_ITERATIONS - 1
    const resp = await client.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: config.MAX_TOKENS_REPLY,
      system: SYSTEM_PROMPT,
      ...(config.ENABLE_TOOLS && !isLastIteration ? { tools: anthropicTools() } : {}),
      messages,
    })

    totalIn += resp.usage.input_tokens
    totalOut += resp.usage.output_tokens
    modelEcho = resp.model

    if (resp.stop_reason !== 'tool_use' || isLastIteration) {
      finalText = extractText(resp.content)
      logger.debug(
        { iter, in: totalIn, out: totalOut, toolCalls, stop: resp.stop_reason, last: isLastIteration },
        'chat done',
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

    // Echo the assistant turn verbatim so the next request has full context.
    messages.push({ role: 'assistant', content: resp.content })

    // 同一轮里的多个工具调用并行跑：模型经常一次发 2~3 个（搜表 + 搜文档…），
    // 串行的话每个都要等一次 lark-cli（约 0.9~1.3s）。结果按原顺序回填，
    // tool_use_id 保证了对得上。
    const toolResults: ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu) => {
        const out = await executeTool(tu.name, (tu.input ?? {}) as Record<string, unknown>)
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

  if (!finalText && sanitized.hadMarkup && config.ENABLE_TOOLS) {
    try {
      const retry = await client.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: config.MAX_TOKENS_REPLY,
        system: SYSTEM_PROMPT,
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              '你上一条回复只输出了工具调用的标记，没有正文。请直接用自然语言把答案写给用户，不要再输出任何标记。',
          },
        ],
      })
      totalIn += retry.usage.input_tokens
      totalOut += retry.usage.output_tokens
      finalText = stripToolMarkup(extractText(retry.content)).text
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'recovery call after leaked markup failed')
    }
  }

  if (!finalText || finalText === '(empty response)') {
    finalText =
      '我查了几轮还没能给出结论（工具调用次数用尽）。可以再问一次，或者把范围说具体一点——比如直接给我文档/表格的名字。'
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
