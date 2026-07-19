import { defineConfig } from '@playwright/test'
import path from 'node:path'

const ELECTRON_ENTRY = path.resolve(__dirname, 'dist-electron', 'main.js')

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,

  // Playwright Electron 模式：在 Electron 应用窗口内运行测试
  use: {
    headless: false,
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    {
      name: 'electron',
      use: {
        // 通过 launchOptions 指向 Electron 应用入口
        // 测试中通过 electron.launch() 或 page 路由使用
      },
    },
  ],
})

// 导出供测试文件使用
export { ELECTRON_ENTRY }
