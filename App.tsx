import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Platform,
} from 'react-native'
import Markdown from 'react-native-markdown-display'
import Clipboard from '@react-native-clipboard/clipboard'
import { SvgUri } from 'react-native-svg'
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition'
import {
  Check,
  Copy,
  Eraser,
  Loader,
  Mic,
  Sparkles,
  Square,
} from 'lucide-react-native'
import { getSpeechRecognitionConstructor } from './src/speech/createSpeechRecognition'
import { runPromptOptimization } from './src/services/promptOptimizer'

type AppStatus = 'idle' | 'recording' | 'processing'

type SvgAssetLike = string | { uri?: string; localUri?: string }
type ResolveAssetSourceFn = (source: unknown) => { uri: string }

// react-native 内部模块在 TS 声明里可能缺失；这里用 require 并最小化类型断言以通过 lint。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const resolveAssetSourceModule = require(
  'react-native/Libraries/Image/resolveAssetSource',
) as unknown as { default?: ResolveAssetSourceFn } | ResolveAssetSourceFn

const resolveAssetSource =
  typeof resolveAssetSourceModule === 'function'
    ? (resolveAssetSourceModule as ResolveAssetSourceFn)
    : (resolveAssetSourceModule as { default?: ResolveAssetSourceFn; resolveAssetSource?: ResolveAssetSourceFn })
        .default ??
      (resolveAssetSourceModule as {
        default?: ResolveAssetSourceFn
        resolveAssetSource?: ResolveAssetSourceFn
      }).resolveAssetSource

// eslint-disable-next-line @typescript-eslint/no-require-imports
const voicepromptNativeLogoLightIconAsset = require(
  './src/assets/voiceprompt-native-logo-light-icon.svg',
) as unknown as SvgAssetLike

const voicepromptNativeLogoLightIconUri = resolveAssetSource
  ? resolveAssetSource(voicepromptNativeLogoLightIconAsset as unknown).uri
  : typeof voicepromptNativeLogoLightIconAsset === 'string'
    ? voicepromptNativeLogoLightIconAsset
    : voicepromptNativeLogoLightIconAsset.uri ??
      voicepromptNativeLogoLightIconAsset.localUri ??
      ''

function normalizePromptMarkdown(raw: string): string {
  const normalizedNewlines = raw.replace(/\r\n?/g, '\n')
  const chunks = normalizedNewlines.split('```')

  const processed = chunks.map((chunk, idx) => {
    if (idx % 2 === 1) return chunk
    let s = chunk
    s = s.replace(/(^|\n)\s*(#{1,6})(\S)/g, '$1$2 $3')
    s = s.replace(
      /(^|\n)(\s*)([A-Z][A-Za-z0-9_&-]{5,})(?=[\u4e00-\u9fff（(【[])/g,
      '$1$2$3\n\n',
    )
    s = s.replace(
      /(^|\n)(\s*)([A-Z][A-Za-z0-9_&]{4,})\s*-\s*([\u4e00-\u9fff（(【[])/g,
      '$1$2**$3**\n\n$4',
    )
    s = s.replace(
      /(^|\n)(\s*)(#{1,6})\s*([A-Za-z][A-Za-z0-9_&-]*)([\u4e00-\u9fff(（[][^\n]*)/g,
      '$1$2$3 $4\n$5',
    )
    s = s.replace(/([^\n])\s*(#{1,6})\s*(\S)/g, '$1\n\n$2 $3')
    s = s.replace(/([^\d])([1-9])\.\s*(\S)/g, '$1\n$2. $3')
    s = s.replace(/【([^】]+)】/g, '**$1**')
    s = s.replace(/-\s*\[/g, '\n\n- [')
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
  const [isRequestingPermission, setIsRequestingPermission] = useState(false)

  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const finalTranscriptRef = useRef('')
  const nativeFinalTranscriptRef = useRef('')
  const listenLoopRef = useRef(false)
  const optimizeAbortRef = useRef<AbortController | null>(null)

  const speechSupported = useMemo(() => {
    if (Platform.OS === 'web') return getSpeechRecognitionConstructor() !== null
    try {
      return typeof ExpoSpeechRecognitionModule.isRecognitionAvailable === 'function'
        ? ExpoSpeechRecognitionModule.isRecognitionAvailable()
        : true
    } catch {
      return false
    }
  }, [])

  // iOS/Android: 接收原生识别结果事件
  useSpeechRecognitionEvent('result', (event) => {
    if (Platform.OS === 'web') return
    const text = event.results?.[0]?.transcript ?? ''
    if (!text) return
    if (event.isFinal) {
      nativeFinalTranscriptRef.current += text
      setTranscript(nativeFinalTranscriptRef.current)
      return
    }
    setTranscript(nativeFinalTranscriptRef.current + text)
  })

  // iOS/Android: 接收原生识别错误事件
  useSpeechRecognitionEvent('error', (event) => {
    if (Platform.OS === 'web') return
    if (event.error === 'aborted') return
    setSpeechError(`语音识别异常：${event.error}`)
    setStatus('idle')
  })
  useSpeechRecognitionEvent('start', () => {
    if (Platform.OS === 'web') return
    setStatus('recording')
  })
  useSpeechRecognitionEvent('end', () => {
    if (Platform.OS === 'web') return
    setStatus((prev) => (prev === 'processing' ? prev : 'idle'))
  })

  const stopRecognition = useCallback(() => {
    listenLoopRef.current = false
    const recognition = recognitionRef.current
    recognitionRef.current = null
    if (!recognition) return
    recognition.onend = null
    recognition.stop()
  }, [])

  useEffect(() => {
    return () => {
      optimizeAbortRef.current?.abort()
      if (Platform.OS === 'web') {
        stopRecognition()
        return
      }
      try {
        ExpoSpeechRecognitionModule.abort()
      } catch {
        // ignore
      }
    }
  }, [stopRecognition])

  const startRecording = useCallback(() => {
    if (Platform.OS === 'web') {
      const Ctor = getSpeechRecognitionConstructor()
      if (!Ctor) {
        setSpeechError('当前平台未启用语音识别。请先在 Web 端使用该功能。')
        return
      }

      setSpeechError(null)
      setPromptOut('')
      setTranscript('')
      finalTranscriptRef.current = ''
      nativeFinalTranscriptRef.current = ''
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
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i]
          if (!result) continue
          const piece = result[0]?.transcript ?? ''
          if (result.isFinal) finalTranscriptRef.current += piece
          else interim += piece
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
            // noop
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

      return
    }

    // iOS/Android: expo-speech-recognition
    ;(async () => {
      setSpeechError(null)
      setPromptOut('')
      setTranscript('')
      finalTranscriptRef.current = ''
      optimizeAbortRef.current?.abort()
      optimizeAbortRef.current = null

      // 先确保之前的识别任务被终止（避免并发状态）
      try {
        ExpoSpeechRecognitionModule.abort()
      } catch {
        // ignore
      }

      setIsRequestingPermission(true)
      try {
        const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
        const granted = (perm as unknown as { granted?: boolean }).granted === true
        if (!granted) {
          setSpeechError('未获得语音识别/麦克风权限。请在系统设置中开启权限。')
          setStatus('idle')
          return
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setSpeechError(`请求权限失败：${msg}`)
        setStatus('idle')
        return
      } finally {
        setIsRequestingPermission(false)
      }

      try {
        ExpoSpeechRecognitionModule.start({
          lang: 'zh-CN',
          interimResults: true,
          continuous: true,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setSpeechError(`无法启动麦克风：${msg}`)
        setStatus('idle')
      }
    })()
  }, [stopRecognition])

  const stopRecording = useCallback(() => {
    if (Platform.OS === 'web') stopRecognition()
    else ExpoSpeechRecognitionModule.stop()
    setStatus('idle')
  }, [stopRecognition])

  const toggleRecord = useCallback(() => {
    if (status === 'recording') stopRecording()
    else startRecording()
  }, [startRecording, status, stopRecording])

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
        (chunk) => setPromptOut((prev) => prev + chunk),
        { signal: controller.signal, timeoutMs: 180_000 },
      )
      setPromptOut(out)
      setSpeechError(null)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
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

  const handleClearTranscript = useCallback(() => {
    finalTranscriptRef.current = ''
    nativeFinalTranscriptRef.current = ''
    setTranscript('')
  }, [])

  const handleCopy = useCallback(() => {
    if (!promptOut) return
    try {
      Clipboard.setString(promptOut)
      setCopied(true)
      setSpeechError(null)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setSpeechError('复制失败，请稍后重试。')
    }
  }, [promptOut])

  const statusText =
    isRequestingPermission
      ? '请求权限中'
      : status === 'idle'
        ? '空闲'
        : status === 'recording'
          ? '录音中'
          : '处理中'

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={[styles.bgOrb, styles.bgOrbOne]} />
      <View style={[styles.bgOrb, styles.bgOrbTwo]} />
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={styles.titleContainer}>
            {voicepromptNativeLogoLightIconUri ? (
              <SvgUri
                uri={voicepromptNativeLogoLightIconUri}
                width={80}
                height={50}
                style={styles.titleIcon}
              />
            ) : null}
            <Text style={styles.subtitle}>口述想法 - 结构化 Vibe Coding Prompt</Text>
          </View>
        </View>

        {speechError ? <Text style={styles.errorText}>{speechError}</Text> : null}

        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>实时语音转录</Text>
            <Pressable
              onPress={handleClearTranscript}
              style={[styles.ghostBtn, !transcript && styles.btnDisabled]}
              disabled={!transcript}
            >
              <Eraser size={14} color="#333" />
              <Text style={styles.ghostBtnText}>清空</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.scroll}>
            <Text style={styles.bodyText}>
              {transcript || '点击「开始录音」后，识别结果将实时显示在此。'}
            </Text>
          </ScrollView>

          <View style={styles.transcriptFooter}>
            <Text style={styles.status}>{statusText}</Text>
            <Pressable
              onPress={toggleRecord}
              disabled={
                !speechSupported ||
                status === 'processing' ||
                isRequestingPermission
              }
              style={[
                styles.primaryBtn,
                (!speechSupported ||
                  status === 'processing' ||
                  isRequestingPermission) &&
                  styles.btnDisabled,
              ]}
            >
              {status === 'recording' ? (
                <Square size={16} color="#fff" />
              ) : (
                <Mic size={16} color="#fff" />
              )}
              <Text style={styles.primaryBtnText}>
                {status === 'recording' ? '停止录音' : '开始录音'}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>Prompt</Text>
            <View style={styles.row}>
              <Pressable
                onPress={handleOptimize}
                style={[
                  styles.primaryBtn,
                  (status === 'recording' || status === 'processing') &&
                    styles.btnDisabled,
                ]}
                disabled={status === 'recording' || status === 'processing'}
              >
                {status === 'processing' ? (
                  <Loader size={16} color="#fff" />
                ) : (
                  <Sparkles size={16} color="#fff" />
                )}
                <Text style={styles.primaryBtnText}>一键优化</Text>
              </Pressable>
              <Pressable
                onPress={handleCancelOptimize}
                style={[
                  styles.ghostBtn,
                  status !== 'processing' && styles.btnDisabled,
                ]}
                disabled={status !== 'processing'}
              >
                <Square size={14} color="#333" />
                <Text style={styles.ghostBtnText}>取消</Text>
              </Pressable>
              <Pressable
                onPress={handleCopy}
                style={[styles.ghostBtn, !promptOut && styles.btnDisabled]}
                disabled={!promptOut}
              >
                {copied ? (
                  <Check size={14} color="#16a34a" />
                ) : (
                  <Copy size={14} color="#333" />
                )}
                <Text style={styles.ghostBtnText}>{copied ? '已复制' : '复制'}</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView style={styles.scroll}>
            {promptOut ? (
              <Markdown>{normalizePromptMarkdown(promptOut)}</Markdown>
            ) : (
              <Text style={styles.bodyText}>
                停止录音后，点击「一键优化」生成可用于 AI 编程工具的 Prompt。
              </Text>
            )}
          </ScrollView>
        </View>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f4f2ff' },
  root: { flex: 1, padding: 16, gap: 12 },
  bgOrb: {
    position: 'absolute',
    borderRadius: 999,
    opacity: 0.22,
  },
  bgOrbOne: {
    width: 280,
    height: 280,
    backgroundColor: '#ffc9b8',
    top: 100,
    left: -80,
  },
  bgOrbTwo: {
    width: 280,
    height: 300,
    backgroundColor: '#e5d9ff',
    right: 0,
    bottom: 160,
  },
  header: {
    padding: 14,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.9)',
    gap: 10,
    shadowColor: '#8d7dc6',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 8,
  },
  titleContainer: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  title: { fontSize: 20, fontWeight: '700', color: '#111'},
  titleIcon: {  },
  subtitle: { fontSize: 13, color: '#5f5a78', fontStyle: 'italic' },
  status: { fontSize: 13, color: '#403c57', fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#151228',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  ghostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.9)',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  btnDisabled: { opacity: 0.45 },
  ghostBtnText: { color: '#333', fontSize: 12, fontWeight: '500' },
  errorText: {
    color: '#b91c1c',
    backgroundColor: '#fee2e2',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  panel: {
    flex: 1,
    minHeight: 180,
    backgroundColor: 'rgba(255,255,255,0.74)',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.9)',
    overflow: 'hidden',
    shadowColor: '#9588c6',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    elevation: 6,
  },
  panelHeader: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(80,70,120,0.08)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  panelTitle: { fontSize: 14, fontWeight: '600', color: '#111' },
  scroll: { flex: 1, paddingHorizontal: 12, paddingVertical: 10 },
  transcriptFooter: {
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(80,70,120,0.08)',
    backgroundColor: 'rgba(255,255,255,0.74)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
  },
  bodyText: { fontSize: 14, lineHeight: 21, color: '#333' },
})
