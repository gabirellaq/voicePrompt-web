const { contextBridge } = require('electron')

// 可按需在此向渲染进程暴露安全的 API
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
})
