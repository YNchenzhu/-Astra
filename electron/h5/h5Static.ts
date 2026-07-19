/**
 * Static file server for the renderer SPA, so a phone browser can load the UI
 * directly from the H5 server (turnkey LAN access — no separate Vite / reverse
 * proxy needed). The bundle is the same `dist/` the Electron window loads; in
 * a browser it boots into H5 mode (no `window.electronAPI`) and shows the
 * connect screen.
 *
 * Same-origin bonus: when the SPA is served here, its API/WS calls go to the
 * same origin, so CORS is not even exercised — only the H5 token is required.
 *
 * Serving the bundle requires no token (it is public JS/HTML, same as any web
 * app shell); only `/api/*` and `/ws` are token-gated.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

let cachedDistDir: string | null | undefined

/** Resolve the built renderer dir (`dist/`) next to `dist-electron/`. */
function getDistDir(): string | null {
  if (cachedDistDir !== undefined) return cachedDistDir
  const candidate = path.resolve(__dirname, '../dist')
  cachedDistDir = fs.existsSync(path.join(candidate, 'index.html')) ? candidate : null
  return cachedDistDir
}

/** True when a built renderer bundle is available to serve. */
export function hasStaticBundle(): boolean {
  return getDistDir() !== null
}

const MISSING_BUNDLE_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>H5 前端未就绪</title>
<style>body{font-family:system-ui,sans-serif;background:#1e1e2e;color:#cdd6f4;display:flex;min-height:100dvh;align-items:center;justify-content:center;margin:0;padding:24px}
.card{max-width:480px;line-height:1.7}h1{font-size:20px}code{background:#11111b;padding:2px 6px;border-radius:4px}</style></head>
<body><div class="card"><h1>H5 前端尚未构建</h1>
<p>H5 服务端正在运行，但没有找到前端构建产物 <code>dist/</code>。</p>
<p>这是<strong>开发模式</strong>的预期表现——开发时前端由 Vite 提供。请改用以下任一方式：</p>
<ul>
<li>先执行 <code>npm run build</code> 生成 <code>dist/</code>，再重新打开本页；</li>
<li>或使用<strong>打包后的安装版</strong>（内置 <code>dist/</code>，开箱即用）。</li>
</ul>
<p>另外，手机/其它设备访问时，请确认桌面端「设置 → 远程访问 (H5)」的监听 Host 设为 <code>0.0.0.0</code>（而非默认的 <code>127.0.0.1</code> 仅本机）。</p>
</div></body></html>`

/**
 * Serve a static asset for a GET request, with SPA fallback to `index.html`.
 * Returns true when the request was handled. Never serves files outside the
 * dist root (path-traversal guard).
 *
 * When no built bundle exists (dev mode), navigation requests get a readable
 * explanation page instead of a cryptic 404; asset requests still 404.
 */
export function serveStatic(
  pathname: string,
  res: http.ServerResponse,
  extraHeaders: Record<string, string> = {},
): boolean {
  const distDir = getDistDir()
  if (!distDir) {
    const cleanPath = pathname.split('?')[0]
    if (!path.extname(cleanPath)) {
      // Dev mode: the renderer is served by Vite, not built to dist/. Redirect
      // navigations to the dev server with this server as the API origin so H5
      // is usable during development too.
      const devUrl = process.env.VITE_DEV_SERVER_URL
      if (devUrl) {
        const host = res.req?.headers?.host || 'localhost'
        const target = `${devUrl.replace(/\/$/, '')}/?serverUrl=${encodeURIComponent(`http://${host}`)}`
        res.writeHead(302, { Location: target, ...extraHeaders })
        res.end()
        return true
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders })
      res.end(MISSING_BUNDLE_HTML)
      return true
    }
    return false
  }

  const cleanPath = decodeURIComponent(pathname.split('?')[0])
  const indexFile = path.join(distDir, 'index.html')

  // Map the URL path to a file; default and SPA routes fall back to index.html.
  let target: string
  if (cleanPath === '/' || cleanPath === '') {
    target = indexFile
  } else {
    const resolved = path.resolve(distDir, `.${cleanPath}`)
    // Traversal guard: resolved must stay within distDir.
    if (resolved !== distDir && !resolved.startsWith(distDir + path.sep)) {
      res.writeHead(403, extraHeaders)
      res.end('forbidden')
      return true
    }
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      target = resolved
    } else {
      // Unknown path with no file extension → SPA route → index.html.
      // A missing asset with an extension → 404.
      if (path.extname(cleanPath)) {
        res.writeHead(404, extraHeaders)
        res.end('not found')
        return true
      }
      target = indexFile
    }
  }

  try {
    const data = fs.readFileSync(target)
    const ext = path.extname(target).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': target === indexFile ? 'no-cache' : 'public, max-age=3600',
      ...extraHeaders,
    })
    res.end(data)
  } catch {
    res.writeHead(404, extraHeaders)
    res.end('not found')
  }
  return true
}
