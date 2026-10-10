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

/**
 * Anthropic client wrapper with tool-use loop. The loop:
 *   1. send messages (+ tool defs) to the model
 *   2. if `stop_reason === 'tool_use'`, execute each tool_use block,
 *      append the assistant turn + a user turn of tool_result blocks,
 *      and re-send
 *   3. otherwise return the final text
 *
 * Capped at MAX_TOOL_ITERATIONS to prevent runaway loops.
 */

const client = new Anthropic({
  ...(config.ANTHROPIC_BASE_URL ? { baseURL: config.ANTHROPIC_BASE_URL } : {}),
  authToken: config.ANTHROPIC_AUTH_TOKEN,
})

const MAX_TOOL_ITERATIONS = 6

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

const SYSTEM_PROMPT = `You are a helpful Feishu/Lark assistant connected to the user via a bot bridge. Reply in the same language as the user's message. When the user asks about specific chats, documents, or tables they have access to, use the provided tools to fetch real data rather than guessing. Keep replies concise — this is a chat UI.`

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
    const resp = await client.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: config.MAX_TOKENS_REPLY,
      system: SYSTEM_PROMPT,
      ...(config.ENABLE_TOOLS ? { tools: anthropicTools() } : {}),
      messages,
    })

    totalIn += resp.usage.input_tokens
    totalOut += resp.usage.output_tokens
    modelEcho = resp.model

    if (resp.stop_reason !== 'tool_use') {
      finalText = extractText(resp.content)
      logger.debug(
        { iter, in: totalIn, out: totalOut, toolCalls, stop: resp.stop_reason },
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

    // Run all tools (sequentially — preserve order; flat list of results).
    const toolResults: ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      const out = await executeTool(tu.name, (tu.input ?? {}) as Record<string, unknown>)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: typeof out === 'string' ? out : JSON.stringify(out).slice(0, 8000),
      })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  if (!finalText) {
    finalText = `(reached tool-use iteration cap of ${MAX_TOOL_ITERATIONS} without a final answer)`
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
