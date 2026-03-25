/**
 * 未来接入真实 LLM（OpenAI / Anthropic / 自建 API）时，在此实现网络请求并解析返回。
 */
type LlmChatCompletionResponse = {
  choices?: Array<{
    message?: { content?: unknown }
    delta?: { content?: unknown }
    text?: string
  }>
  output_text?: string
  response?: string
  data?: Array<{ content?: string; text?: string }>
}

export async function optimizePromptWithLLM(
  rawTranscript: string,
  onStreamChunk?: (chunk: string) => void,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  const env = import.meta.env as unknown as Record<string, string | undefined>
  const baseUrl = env.VITE_LLM_BASE_URL
  const model = env.VITE_LLM_MODEL

  const userText = rawTranscript.trim()
  if (!userText) {
    return '（暂无转录内容。请先完成录音后再点击「一键优化」。）'
  }

  if (!baseUrl) {
    throw new Error('未配置 VITE_LLM_BASE_URL，无法请求 LLM。')
  }
  if (!model) {
    throw new Error('未配置 VITE_LLM_MODEL，无法请求 LLM。')
  }

  // 尽量使用“OpenAI 兼容”的 chat/completions 形式；若你的服务不是该路由，可改这里。
  const payload = {
    model,
    messages: [
      {
        role: 'system',
        content:
          '你是资深软件工程师与提示词重构助手。请将用户口述的杂乱想法，重构为可直接用于 AI 编程工具的高质量 Prompt。' +
          '要求：只输出最终 Prompt，不要输出解释或额外说明。' +
          'Prompt 应结构清晰、逻辑严密，包含必要的目标、约束、实现思路与交互步骤；保持可执行性与可维护性。' + 
          '使用中文回答。',
      },
      {
        role: 'user',
        content: `请实现【${userText}】该需求，保持结构清晰、可维护，并简要说明关键设计决策。只输出优化后的 Prompt。`,
      },
    ],
    // 采用 OpenAI 兼容 SSE：增量放在 `choices[].delta.content`。
    // 若你的服务不是 SSE，可以在这里替换为对应的流式解析方式。
    stream: true,
  }

  const apiKey = env.VITE_LLM_API_KEY
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const controller = new AbortController()
  const timeoutMs = opts?.timeoutMs ?? 180_000
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)
  const externalSignal = opts?.signal
  const onExternalAbort = () => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    const endpoint = '/chat/completions'
    let lastErr: unknown = null

    try {
      const extractStringContent = (v: unknown): string | null => {
        if (typeof v === 'string') return v.trim().length > 0 ? v.trim() : null
        if (Array.isArray(v)) {
          for (const item of v) {
            // 兼容 openai-like “content parts”
            if (typeof item === 'string') {
              const s = item.trim()
              if (s.length > 0) return s
              continue
            }
            if (item && typeof item === 'object') {
              const maybeText = (item as Record<string, unknown>).text
              if (typeof maybeText === 'string' && maybeText.trim().length > 0) return maybeText.trim()
            }
          }
        }
        if (v && typeof v === 'object') {
          // 兼容某些服务把 content 包在 { text: "..." } 里
          const maybeText = (v as Record<string, unknown>).text
          if (typeof maybeText === 'string' && maybeText.trim().length > 0) return maybeText.trim()
        }
        return null
      }

      const res = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`LLM 请求失败：${res.status} ${res.statusText}${text ? ` - ${text.slice(0, 200)}` : ''}`)
      }

      // SSE/NDJSON 流式解析：把 `delta.content` 逐步回调给 UI。
      const contentType = res.headers.get('content-type') || ''
      const isNdjsonLike = contentType.includes('application/x-ndjson') || contentType.includes('application/ndjson')

      const reader = res.body?.getReader()
      if (!reader) throw new Error('LLM 返回为空：res.body 不可用，无法进行流式读取。')

      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      let fullText = ''

      const appendChunk = (piece: string) => {
        if (!piece) return
        // 流式时保留原样换行/空格，避免渲染断裂。
        fullText += piece
        onStreamChunk?.(piece)
      }

      const extractFromChunk = (json: LlmChatCompletionResponse): string => {
        const contentCandidates: unknown[] = [
          json.choices?.[0]?.delta?.content,
          json.choices?.[0]?.message?.content,
          json.choices?.[0]?.text,
          json.output_text,
          json.response,
          json.data?.[0]?.content,
          json.data?.[0]?.text,
        ]
        for (const candidate of contentCandidates) {
          const piece = extractStringContent(candidate)
          if (piece) return piece
        }
        return ''
      }

      let seenAny = false

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (!line) continue

          // SSE: `data: { ... }`，最终 `data: [DONE]`
          if (line.startsWith('data:')) {
            const data = line.slice('data:'.length).trim()
            if (data === '[DONE]') return fullText.trim()

            try {
              const json = JSON.parse(data) as LlmChatCompletionResponse
              const piece = extractFromChunk(json)
              if (piece) {
                seenAny = true
                appendChunk(piece)
              }
            } catch {
              // 某些服务可能把 token 直接输出为文本行（非 JSON）
              // 如果是 NDJSON，就走下面的解析逻辑；否则继续吞掉该行。
              if (!isNdjsonLike) continue
              // 不中断：继续等下一条可能是 JSON 的 data 行
            }
            continue
          }

          // NDJSON: 每行是一段 JSON
          if (isNdjsonLike) {
            try {
              const json = JSON.parse(line) as LlmChatCompletionResponse
              const piece = extractFromChunk(json)
              if (piece) {
                seenAny = true
                appendChunk(piece)
              }
            } catch {
              // 忽略非 JSON 行
            }
          }
        }
      }

      if (!seenAny) {
        const preview = fullText.slice(0, 200)
        throw new Error(
          `LLM 流式解析失败：未从增量中提取到 content（预览：${preview || '[empty]' }）。` +
            `请检查你的 LLM 服务是否遵循 OpenAI 兼容 SSE 格式。`,
        )
      }

      return fullText.trim()
    } catch (e) {
      lastErr = e
    }

    if (lastErr instanceof DOMException && lastErr.name === 'AbortError') {
      throw new Error('请求已取消或超时。')
    }
    const msg = lastErr instanceof Error ? lastErr.message : 'LLM 请求失败'
    throw new Error(msg)
  } finally {
    window.clearTimeout(timeoutId)
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
  }
}

/** Mock：用于联调 UI，格式与产品说明一致 */
export async function mockOptimizePrompt(rawTranscript: string): Promise<string> {
  await new Promise((r) => setTimeout(r, 450))
  const t = rawTranscript.trim()
  if (!t) {
    return '（暂无转录内容。请先完成录音后再点击「一键优化」。）'
  }
  return `根据用户输入：【${t}】。请编写代码以实现上述需求，保持结构清晰、可维护，并简要说明关键设计决策。`
}

/**
 * 应用内统一入口：占位函数，便于日后切换为 `optimizePromptWithLLM`。
 */
export async function runPromptOptimization(
  rawTranscript: string,
  onStreamChunk?: (chunk: string) => void,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  // 未来可在此处提供“策略开关”（例如：优先 LLM，失败再走 mock）。
  return optimizePromptWithLLM(rawTranscript, onStreamChunk, opts)
}
