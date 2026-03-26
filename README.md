# voiceprompt-electron
将口述的想法转换为结构化的提示词（Prompt）桌面版


## 预览截图
![预览截图](./screenshot/electron-demo.png)

## 快速使用

```bash
npm install
npm run build
npm run electron:start"
```

## 技术栈
- React, Vite, Tailwind CSS, Lucide React(图标)
- 原生的 “Window.SpedchRecognition” 或 “Window.webkitSpeechRecognition” 事件

## 模型（LLM）
在 `.env` 文件中配置
```bash
VITE_LLM_BASE_URL=xxx/v1
VITE_LLM_MODEL=model_name
VITE_LLM_API_KEY=your_api_key
```
如果使用本地模型时通过代理解决跨域问题
在`vite.config.ts`中配置
```bash
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 开发环境通过代理转发到本地 LLM 服务，避免浏览器跨域（CORS 预检失败）。
  server: {
    proxy: {
      '/v1': {
        target: 'http://localhost:1234',
        changeOrigin: true,
      },
    },
  },
})
```




