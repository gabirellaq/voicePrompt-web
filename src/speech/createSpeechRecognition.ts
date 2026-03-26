import { Platform } from 'react-native'

export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (Platform.OS !== 'web') return null
  const webWindow = globalThis as typeof globalThis & { window?: Window }
  return (
    webWindow.window?.SpeechRecognition ??
    webWindow.window?.webkitSpeechRecognition ??
    null
  )
}
