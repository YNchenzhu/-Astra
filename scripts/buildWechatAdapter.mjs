/**
 * Bundle the WeChat IM adapter into a single, dependency-free Node CommonJS
 * file so the packaged Electron app can run it via `utilityProcess.fork`
 * WITHOUT requiring Bun or a separate `npm install` on the end-user machine.
 *
 * The adapter source uses the Bun/tsx convention of importing TypeScript files
 * with a `.js` extension; a small resolve plugin maps those back to the real
 * `.ts` so esbuild can bundle them. `ws` (the only runtime dep) is bundled in;
 * its optional native accelerators are marked external (ws works without them).
 *
 * Output: `dist-adapter/wechat-adapter.cjs`
 */
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Map relative `./x.js` imports to `./x.ts` when only the .ts exists. */
const jsToTsPlugin = {
  name: 'js-to-ts',
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === 'entry-point' || !args.path.startsWith('.')) return undefined
      const tsPath = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'))
      if (existsSync(tsPath)) return { path: tsPath }
      return undefined
    })
  },
}

await build({
  entryPoints: [path.join(root, 'adapters/wechat/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: path.join(root, 'dist-adapter/wechat-adapter.cjs'),
  plugins: [jsToTsPlugin],
  // ws's optional native speed-ups — resolved lazily, safe to leave external.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'info',
  banner: { js: '/* 星构Astra — bundled WeChat IM adapter (no Bun required) */' },
})

console.log('[buildWechatAdapter] wrote dist-adapter/wechat-adapter.cjs')
