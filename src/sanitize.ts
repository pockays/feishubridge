/**
 * 模型偶尔会"退化"成输出原生工具调用语法，而不是结构化的 tool_use 块。
 * 实测在 DeepSeek 经 Anthropic 兼容层调用时出现过，形态是：尖括号里包着
 * 两枚全角竖线，中间是 DSML 或 invoke / parameter 之类的关键字。
 *
 * 这些文字如果原样发到飞书，用户看到的就是一堆乱码标签。这里把它们清掉：
 * 从第一个标记处截断（这类输出通常整段都是标签噪音；若前面还有正常文字则保留）。
 */

const TOOL_MARKUP =
  /<[|\uFF5C]{1,2}\s*(?:DSML|tool[\s_-]*calls?|invoke|parameter|function[\s_-]*calls?)\b|<(?:tool_calls?|function_calls?|invoke|parameter)[\s>]/i

export interface SanitizeResult {
  text: string
  hadMarkup: boolean
}

export function stripToolMarkup(text: string): SanitizeResult {
  const idx = text.search(TOOL_MARKUP)
  if (idx < 0) return { text, hadMarkup: false }
  return { text: text.slice(0, idx).trim(), hadMarkup: true }
}
