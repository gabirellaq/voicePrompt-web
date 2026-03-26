# voiceprompt-web -> React Native 改动记录

## 背景与目标

本次改造目标是将原有 Vite + React Web 项目迁移为 React Native（Expo）写法，并保证以下能力可用：

- 跨端运行（Web / iOS / Android）
- 语音识别（Web 与原生分别走对应机制）
- 一键优化 Prompt（LLM 请求）
- 复制到剪贴板
- UI 风格尽量接近原 Web 版本（玻璃感、层次感）

---

## 一、工程形态迁移（Web -> Expo）

### 1) 启动与构建体系切换

- 从 Vite 脚本迁移为 Expo 脚本：
  - `start`
  - `android`
  - `ios`
  - `web`
- 增加 `typecheck` 脚本（`tsc --noEmit`）。

### 2) 新增/删除配置文件

- 新增：
  - `app.json`
  - `babel.config.cjs`
- 删除：
  - `vite.config.ts`
  - `index.html`
  - `src/main.tsx`
  - `src/index.css`
  - `tsconfig.app.json`
  - `tsconfig.node.json`

### 3) TypeScript 配置调整

- `tsconfig.json` 改为基于 Expo 的配置。
- 补充 JSX 与严格类型校验相关项，确保 RN 代码通过类型检查。

### 4) ESLint 配置适配

- 移除仅 Vite/Web 场景相关的配置。
- 调整全局环境定义，适配当前 Expo + RN 项目形态。

---

## 二、依赖迁移与新增

### 1) 移除 Web 专属依赖（原先）

- 如 `react-markdown`、`lucide-react`、Tailwind/Vite 相关依赖等 Web 方案。

### 2) 新增 React Native / Expo 相关依赖

- `expo`
- `react-native`
- `react-native-web`
- `react-native-markdown-display`
- `lucide-react-native`
- `react-native-svg`
- `react-native-safe-area-context`
- `expo-speech-recognition`
- `@react-native-clipboard/clipboard`

---

## 三、核心页面改造（`App.tsx`）

### 1) 组件体系改造

将 Web DOM + className 写法改为 React Native 组件写法：

- `SafeAreaView`
- `View`
- `Text`
- `ScrollView`
- `Pressable`
- `StyleSheet`

### 2) Markdown 渲染改造

- 从 `react-markdown` 切换为 `react-native-markdown-display`。
- 保留并沿用 `normalizePromptMarkdown` 逻辑，以适配模型输出格式。

### 3) 交互按钮行为完善

- 录音/停止录音
- 一键优化/取消优化
- 清空转录
- 复制到剪贴板
- 各按钮补齐禁用态逻辑与视觉反馈

### 4) UI 视觉升级（贴近原 Web 风格）

- 半透明“玻璃卡片”风格面板
- 背景光斑层次（暖色 + 紫色）
- 主次按钮层级增强
- 统一阴影、圆角、边框透明度与状态样式

---

## 四、语音识别跨端实现

### 1) Web 端

- 保留 Web Speech API 方案（`SpeechRecognition / webkitSpeechRecognition`）。
- 继续支持连续识别与 interim/final 结果处理。

### 2) iOS / Android 端

- 接入 `expo-speech-recognition`：
  - `requestPermissionsAsync()`
  - `start() / stop() / abort()`
  - `useSpeechRecognitionEvent('result' | 'error' | 'start' | 'end')`

### 3) 状态与稳定性处理

- 增加权限申请中状态，防止弹窗期间重复点击录音按钮。
- 原生识别结果改为“final 累积 + interim 拼接显示”，避免覆盖历史文本。
- 组件卸载时主动中止识别，避免会话残留。

### 4) 平台适配文件

- `src/speech/createSpeechRecognition.ts`
  - `web` 返回浏览器识别构造器
  - 原生平台返回 `null`（由 `expo-speech-recognition` 处理）

---

## 五、剪贴板能力完善

- 已接入 `@react-native-clipboard/clipboard`。
- `handleCopy` 使用 `Clipboard.setString(promptOut)` 执行真实复制。
- 成功时显示“已复制”短暂反馈；失败时提示错误。

---

## 六、LLM 调用环境变量改造

`src/services/promptOptimizer.ts` 已从 Vite 环境变量迁移为 Expo 规范：

- `EXPO_PUBLIC_LLM_BASE_URL`
- `EXPO_PUBLIC_LLM_MODEL`
- `EXPO_PUBLIC_LLM_API_KEY`

并保留流式解析与异常处理逻辑。

---

## 七、权限与插件配置

`app.json` 已加入：

- `plugins: ["expo-speech-recognition"]`

用于在 iOS/Android 侧注入语音识别所需原生配置。

---

## 八、校验与结果

多轮改造后均已通过：

- `npm run typecheck`
- `npm run lint`

当前项目已具备：

- Web / iOS / Android 三端可运行形态
- 跨端语音识别机制（Web 与原生分支）
- 原生剪贴板复制
- 接近原版视觉风格的 RN UI

---

## 九、后续建议

1. 真机联调时执行一次原生工程生成/更新（如 `expo prebuild` 或 `expo run:ios/android`）。
2. 如需进一步贴近原 UI，可补充：
   - 状态胶囊指示点动画
   - 面板渐变层与动态阴影
   - 转录区“录音波动”动效
3. 可补充 E2E/集成测试用例，覆盖：
   - 权限拒绝路径
   - 中断恢复路径
   - 连续识别长文本场景

