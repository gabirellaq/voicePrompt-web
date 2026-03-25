import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import {
  Check,
  Copy,
  Eraser,
  Loader2,
  Mic,
  Sparkles,
  Square,
} from 'lucide-react'
import { getSpeechRecognitionConstructor } from './speech/createSpeechRecognition'
import { runPromptOptimization } from './services/promptOptimizer'

type AppStatus = 'idle' | 'recording' | 'processing'

function normalizePromptMarkdown(raw: string): string {
  // 兼容模型输出里常见的“标题写法不严格/标题插在一行中间”的情况：
  // - CommonMark 标题需要 `# Title`（`#` 后紧跟内容时需要补空格）
  // - 如果 `#Title` 出现在句子中间，通常需要人为插入段落换行（`\n\n`）
  // 同时避免在代码块（```...```）内改写内容。
  const normalizedNewlines = raw.replace(/\r\n?/g, '\n')
  const chunks = normalizedNewlines.split('```')

  const processed = chunks.map((chunk, idx) => {
    if (idx % 2 === 1) return chunk // fence 内不处理

    let s = chunk

    // 1) 修复行首标题：`#Role` -> `# Role`（允许标题前有空白）
    s = s.replace(/(^|\n)\s*(#{1,6})(\S)/g, '$1$2 $3')

    // 1.5) 修复“无 # 的分段标签”：模型输出可能是 `TaskObjective请...` 或 `RoleDefinition你是...`
    // 当行首出现较长 CamelCase 英文标签，并且后面紧跟中文/括号/【，则在标签后插入空行以形成段落。
    s = s.replace(
      /(^|\n)(\s*)([A-Z][A-Za-z0-9_&-]{5,})(?=[\u4e00-\u9fff（(【[])/g,
      '$1$2$3\n\n',
    )

    // 1.6) 修复 `OutputFormat-设计...` / `KeyDeliverablesChecklist-[]...` 这类 “标签-正文”写法
    // 将标签加粗，并把 `-` 后的内容拆成新段落。
    s = s.replace(
      /(^|\n)(\s*)([A-Z][A-Za-z0-9_&]{4,})\s*-\s*([\u4e00-\u9fff（(【[])/g,
      '$1$2**$3**\n\n$4',
    )

    // 2) 把“标题标签”和正文拆开，避免出现 `#RoleDefinition你是...` 被整行都当成标题文本
    //    规则：行首 `#Label` 后紧跟中文/括号/方括号内容，则在 Label 后插入换行：
    //    `# RoleDefinition你是...` -> `# RoleDefinition\n你是...`
    s = s.replace(
      /(^|\n)(\s*)(#{1,6})\s*([A-Za-z][A-Za-z0-9_&-]*)([\u4e00-\u9fff(（[][^\n]*)/g,
      '$1$2$3 $4\n$5',
    )

    // 3) 修复“行内标题”并强制分段：把句子中间的 `#Task...` 拆成新段落
    //    同时允许 `#` 后可能已带空格（`\s*`）。
    s = s.replace(/([^\n])\s*(#{1,6})\s*(\S)/g, '$1\n\n$2 $3')

    // 4) 尝试把 `1. 2. 3.` 这种编号项拆行（避免把整个列表挤成一行）
    //    只在“前一个字符不是数字”的情况下拆行，降低误伤（如 8.0 这种）。
    s = s.replace(/([^\d])([1-9])\.\s*(\S)/g, '$1\n$2. $3')

    // 5) 把“【...】”当作强调重点：转为 Markdown 加粗（只在 fence 外处理）
    s = s.replace(/【([^】]+)】/g, '**$1**')

    // 6) 把同一段内用 `。- / ，- / ）-` 这类符号拼出来的“要点”拆成 Markdown 列表
    //    要点：这里必须不要“吃掉后续正文”，因此只在分隔符处插入 `\n\n- `，不捕获正文内容。
    //    例：`...）。-代码实现：...` -> `...）。\n\n- 代码实现：...`
    s = s.replace(/-\s*\[/g, '\n\n- [') // checklist：`-[` -> 新的列表项
    s = s.replace(/([。！？；，）\]])\s*-\s*/g, '$1\n\n- ')

    return s
  })

  return processed.join('```')
}

export default function App() {
  const [status, setStatus] = useState<AppStatus>('idle')
  const [transcript, setTranscript] = useState('')
  const [promptOut, setPromptOut] = useState('')
  const [speechError, setSpeechError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const finalTranscriptRef = useRef('')
  const listenLoopRef = useRef(false)
  const transcriptScrollRef = useRef<HTMLDivElement>(null)
  const optimizeAbortRef = useRef<AbortController | null>(null)

  const speechSupported = getSpeechRecognitionConstructor() !== null

  useEffect(() => {
    const el = transcriptScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [transcript])

  const stopRecognition = useCallback(() => {
    listenLoopRef.current = false
    const r = recognitionRef.current
    recognitionRef.current = null
    if (r) {
      r.onend = null
      r.stop()
    }
  }, [])

  useEffect(() => {
    return () => {
      stopRecognition()
    }
  }, [stopRecognition])

  const startRecording = useCallback(() => {
    const Ctor = getSpeechRecognitionConstructor()
    if (!Ctor) {
      setSpeechError('当前浏览器不支持语音识别，请使用 Chrome（桌面端）。')
      return
    }

    setSpeechError(null)
    setPromptOut('')
    finalTranscriptRef.current = ''
    setTranscript('')
    optimizeAbortRef.current?.abort()
    optimizeAbortRef.current = null
    stopRecognition()

    const recognition = new Ctor()
    recognitionRef.current = recognition
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'zh-CN'

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const piece = result[0]?.transcript ?? ''
        if (result.isFinal) {
          finalTranscriptRef.current += piece
        } else {
          interim += piece
        }
      }
      setTranscript(finalTranscriptRef.current + interim)
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'aborted') return
      setSpeechError(`语音识别异常：${event.error}`)
      listenLoopRef.current = false
      setStatus('idle')
    }

    recognition.onend = () => {
      if (listenLoopRef.current && recognitionRef.current === recognition) {
        try {
          recognition.start()
        } catch {
          /* already running */
        }
      }
    }

    listenLoopRef.current = true
    setStatus('recording')
    try {
      recognition.start()
    } catch {
      setSpeechError('无法启动麦克风，请检查权限或重试。')
      listenLoopRef.current = false
      setStatus('idle')
    }
  }, [stopRecognition])

  const stopRecording = useCallback(() => {
    stopRecognition()
    setStatus('idle')
  }, [stopRecognition])

  const toggleRecord = useCallback(() => {
    if (status === 'recording') stopRecording()
    else startRecording()
  }, [status, startRecording, stopRecording])

  const handleOptimize = useCallback(async () => {
    if (status === 'processing') return
    setStatus('processing')
    setPromptOut('')
    optimizeAbortRef.current?.abort()
    const controller = new AbortController()
    optimizeAbortRef.current = controller
    try {
      const out = await runPromptOptimization(
        transcript,
        (chunk) => {
          // 逐步渲染流式输出
          setPromptOut((prev) => prev + chunk)
        },
        { signal: controller.signal, timeoutMs: 180_000 },
      )
      // 最终兜底：确保去掉可能残留的尾部空白
      setPromptOut(out)
      setSpeechError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSpeechError(`一键优化失败：${msg}`)
      setPromptOut('')
    } finally {
      setStatus('idle')
      if (optimizeAbortRef.current === controller) optimizeAbortRef.current = null
    }
  }, [status, transcript])

  const handleCancelOptimize = useCallback(() => {
    optimizeAbortRef.current?.abort()
    optimizeAbortRef.current = null
    setStatus('idle')
  }, [])

  const handleCopy = useCallback(async () => {
    if (!promptOut) return
    try {
      await navigator.clipboard.writeText(promptOut)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setSpeechError('复制失败，请检查浏览器权限。')
    }
  }, [promptOut])

  const handleClearTranscript = useCallback(() => {
    finalTranscriptRef.current = ''
    setTranscript('')
  }, [])

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden app-backdrop">
      <div
        className="pointer-events-none absolute -left-24 top-1/4 size-72 rounded-full bg-[#fad0c4] opacity-35 blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -right-20 bottom-1/4 size-80 rounded-full bg-[#ffe8e0] opacity-50 blur-3xl"
        aria-hidden
      />

      <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-4 p-4 md:p-6">
        <header className="glass-bar flex shrink-0 flex-wrap items-center justify-between gap-4 rounded-[1.75rem] px-5 py-4 md:px-7 md:py-5">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-[var(--color-ink)] md:text-xl">
              voiceprompt-web
            </h1>
            <p className="text-sm text-[var(--color-ink-muted)]">
              口述想法 → 结构化 Vibe Coding Prompt
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div
              className="glass-panel-light flex items-center gap-2 rounded-full px-4 py-2 text-sm text-[var(--color-ink)]"
              role="status"
              aria-live="polite"
            >
              <span
                className={`size-2 rounded-full ${
                  status === 'idle'
                    ? 'bg-zinc-400'
                    : status === 'recording'
                      ? 'motion-safe:animate-pulse bg-rose-500'
                      : 'motion-safe:animate-pulse bg-amber-400'
                }`}
                aria-hidden
              />
              <span className="font-medium">
                {status === 'idle' && '空闲'}
                {status === 'recording' && '录音中'}
                {status === 'processing' && '处理中'}
              </span>
            </div>

            <button
              type="button"
              onClick={toggleRecord}
              disabled={!speechSupported || status === 'processing'}
              className="shadow-soft-cta inline-flex cursor-pointer items-center gap-2 rounded-full bg-[var(--color-ink)] px-6 py-3 text-sm font-semibold text-white transition-[transform,opacity,background-color] duration-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {status === 'recording' ? (
                <>
                  <Square className="size-5" strokeWidth={2.25} aria-hidden />
                  停止录音
                </>
              ) : (
                <>
                  <Mic className="size-5" strokeWidth={2.25} aria-hidden />
                  开始录音
                </>
              )}
            </button>
          </div>
        </header>

        {!speechSupported && (
          <div
            className="glass-alert-warn shrink-0 rounded-[1.25rem] px-5 py-3 text-sm text-amber-950"
            role="alert"
          >
            未检测到 Web Speech API。请使用桌面版 Chrome 并允许麦克风权限。
          </div>
        )}

        {speechError && (
          <div
            className="glass-alert-error shrink-0 rounded-[1.25rem] px-5 py-3 text-sm text-red-900"
            role="alert"
          >
            {speechError}
          </div>
        )}

        <main className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row md:gap-5">
          <section
            className="glass-panel-dark flex min-h-[40vh] min-w-0 flex-1 flex-col overflow-hidden rounded-[1.75rem] md:min-h-0"
            aria-labelledby="transcript-heading"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-4">
              <h2
                id="transcript-heading"
                className="text-sm font-semibold text-white/90"
              >
                实时语音转录
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-white/45">
                  Web Speech API
                </span>
                <button
                  type="button"
                  onClick={handleClearTranscript}
                  disabled={!transcript}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-white/20 bg-white/8 px-3 py-1.5 text-xs font-medium text-white/80 transition-colors duration-200 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <Eraser className="size-3.5" aria-hidden />
                  清空
                </button>
              </div>
            </div>
            <div
              ref={transcriptScrollRef}
              className="min-h-0 flex-1 overflow-y-auto px-5 py-4 font-mono text-sm leading-relaxed text-white/88"
            >
              {transcript || (
                <span className="text-white/40">
                  点击「开始录音」后，识别结果将实时显示在此…
                </span>
              )}
            </div>
          </section>

          <section
            className="glass-panel-light flex min-h-[40vh] min-w-0 flex-1 flex-col overflow-hidden rounded-[1.75rem] md:min-h-0"
            aria-labelledby="prompt-heading"
          >
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/50 px-5 py-4">
              <h2
                id="prompt-heading"
                className="text-sm font-semibold text-[var(--color-ink)]"
              >
                Vibe Coding Prompt
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleOptimize}
                  disabled={status === 'recording' || status === 'processing'}
                  className="shadow-soft-cta inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[var(--color-ink)] px-5 py-2.5 text-sm font-medium text-white transition-[opacity,background-color] duration-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {status === 'processing' ? (
                    <Loader2
                      className="size-4 motion-safe:animate-spin"
                      aria-hidden
                    />
                  ) : (
                    <Sparkles className="size-4" aria-hidden />
                  )}
                  一键优化
                </button>
                <button
                  type="button"
                  onClick={handleCancelOptimize}
                  disabled={status !== 'processing'}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/80 bg-white/55 px-5 py-2.5 text-sm font-medium text-[var(--color-ink)] backdrop-blur-md transition-[background-color,border-color] duration-200 hover:border-white hover:bg-white/75 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Square className="size-4" aria-hidden />
                  取消优化
                </button>
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={!promptOut}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/80 bg-white/55 px-5 py-2.5 text-sm font-medium text-[var(--color-ink)] backdrop-blur-md transition-[background-color,border-color] duration-200 hover:border-white hover:bg-white/75 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {copied ? (
                    <Check className="size-4 text-emerald-600" aria-hidden />
                  ) : (
                    <Copy className="size-4" aria-hidden />
                  )}
                  {copied ? '已复制' : '复制到剪贴板'}
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed text-[var(--color-ink)]">
              {promptOut ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks]}
                  skipHtml
                  components={{
                    p: ({ ...props }) => (
                      <p {...props} className="mb-3 last:mb-0" />
                    ),
                    h1: ({ ...props }) => (
                      <h1 {...props} className="mt-6 mb-2 text-base font-bold" />
                    ),
                    h2: ({ ...props }) => (
                      <h2 {...props} className="mt-5 mb-2 text-sm font-semibold" />
                    ),
                    h3: ({ ...props }) => (
                      <h3 {...props} className="mt-4 mb-2 text-sm font-semibold" />
                    ),
                    ul: ({ ...props }) => (
                      <ul {...props} className="mb-3 list-disc pl-5" />
                    ),
                    ol: ({ ...props }) => (
                      <ol {...props} className="mb-3 list-decimal pl-5" />
                    ),
                    li: ({ ...props }) => <li {...props} className="mb-1" />,
                    a: ({ ...props }) => (
                      <a
                        {...props}
                        className="underline underline-offset-2 hover:text-[var(--color-ink-muted)]"
                      />
                    ),
                    pre: ({ ...props }) => (
                      <pre
                        {...props}
                        className="my-3 overflow-x-auto rounded-lg bg-black/5 p-3"
                      />
                    ),
                    code: ({ className, children, ...props }) => {
                      const isBlockCode =
                        typeof className === 'string' &&
                        className.startsWith('language-')

                      return (
                        <code
                          {...props}
                          className={
                            isBlockCode
                              ? ['font-mono text-sm', className]
                                  .filter(Boolean)
                                  .join(' ')
                              : [
                                  'rounded bg-black/5 px-1 py-0.5 font-mono text-[0.95em]',
                                  className,
                                ]
                                  .filter(Boolean)
                                  .join(' ')
                          }
                        >
                          {children}
                        </code>
                      )
                    },
                    table: ({ ...props }) => (
                      <table
                        {...props}
                        className="my-3 w-full table-auto border-separate border-spacing-0 overflow-hidden rounded-lg border border-black/10"
                      />
                    ),
                    th: ({ ...props }) => (
                      <th
                        {...props}
                        className="bg-black/5 px-3 py-2 text-left text-xs font-semibold"
                      />
                    ),
                    td: ({ ...props }) => (
                      <td {...props} className="border-t border-black/10 px-3 py-2" />
                    ),
                    hr: ({ ...props }) => (
                      <hr {...props} className="my-4 border-black/10" />
                    ),
                    blockquote: ({ ...props }) => (
                      <blockquote
                        {...props}
                        className="my-3 border-l-2 border-black/20 pl-4 text-[var(--color-ink-muted)]"
                      />
                    ),
                  }}
                >
                  {normalizePromptMarkdown(promptOut)}
                </ReactMarkdown>
              ) : (
                <span className="text-[var(--color-ink-muted)]/70">
                  停止录音后，点击「一键优化」生成可粘贴到 Claude Code / Cursor /
                  Trae 的 Prompt。
                </span>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}
