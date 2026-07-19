import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx', 'electron/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-electron/**',
      // Separate Bun workspace; its tests import `bun:test` and are run with
      // `cd adapters && bun test`, not the root Vitest runner.
      'adapters/**',
      '.claude/worktrees/**',
    ],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
