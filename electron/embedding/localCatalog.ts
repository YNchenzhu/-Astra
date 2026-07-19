/**
 * Local embedding-model catalog.
 *
 * Two roots are scanned:
 *   - Bundled:    `<resources>/embeddings/<modelId>/` (shipped with the app,
 *                 e.g. a ~280MB multilingual-e5-base).
 *   - Downloaded: `<userData>/downloaded-models/<modelId>/` (user-downloaded
 *                 larger / higher-quality models, e.g. bge-m3).
 *
 * A model is considered installed iff it contains BOTH a `tokenizer.json`
 * AND an .onnx file (under `onnx/` or at the model root). Partially-downloaded
 * directories are reported as `installed:false` with a human reason so the
 * Settings UI can surface "resume download" / "bad files" to the user.
 *
 * The catalog also publishes a curated list of *downloadable* models with
 * direct Hugging Face URLs + expected file sizes, used by the download UI.
 */

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface LocalModelInfo {
  id: string
  name: string
  description: string
  dir: string
  source: 'bundled' | 'downloaded'
  installed: boolean
  reason?: string
  sizeBytes?: number
  dimensions?: number
}

export interface DownloadableModelInfo {
  id: string
  name: string
  description: string
  hfRepo: string
  /** Files (relative to hfRepo root) that must be downloaded. */
  files: string[]
  /** Approximate total size in bytes for UI display. */
  approxSizeBytes: number
  /** Output dimensionality (for Settings auto-fill). */
  dimensions: number
}

// -----------------------------------------------------------------------
// Static catalog of models the Settings "一键下载" button can install.
// Order = recommended priority. All entries target HF's `Xenova/…` ONNX
// mirrors so the files are ready to use without extra conversion.
// -----------------------------------------------------------------------
export const DOWNLOADABLE_MODELS: DownloadableModelInfo[] = [
  {
    id: 'multilingual-e5-base',
    name: 'Multilingual E5 Base (int8)',
    description: '平衡之选：中英日韩多语言 · 278MB · 768 维 · MTEB ~62',
    hfRepo: 'Xenova/multilingual-e5-base',
    files: [
      'onnx/model_quantized.onnx',
      'tokenizer.json',
      'tokenizer_config.json',
      'config.json',
      'special_tokens_map.json',
    ],
    approxSizeBytes: 280 * 1024 * 1024,
    dimensions: 768,
  },
  {
    id: 'bge-m3',
    name: 'BGE-M3 (int8)',
    description: '召回率 SOTA 多语言 · 567MB · 1024 维 · MTEB ~65 · 支持长文本',
    hfRepo: 'Xenova/bge-m3',
    files: [
      'onnx/model_quantized.onnx',
      'tokenizer.json',
      'tokenizer_config.json',
      'config.json',
      'special_tokens_map.json',
    ],
    approxSizeBytes: 567 * 1024 * 1024,
    dimensions: 1024,
  },
  {
    id: 'bge-small-en-v1.5',
    name: 'BGE-Small-EN v1.5 (int8)',
    description: '极轻量英文专用 · 34MB · 384 维 · 适合低配设备',
    hfRepo: 'Xenova/bge-small-en-v1.5',
    files: [
      'onnx/model_quantized.onnx',
      'tokenizer.json',
      'tokenizer_config.json',
      'config.json',
      'special_tokens_map.json',
    ],
    approxSizeBytes: 34 * 1024 * 1024,
    dimensions: 384,
  },
]

// -----------------------------------------------------------------------
// Path resolution
// -----------------------------------------------------------------------
export function bundledRoot(): string {
  // In dev: project-root/resources/embeddings/
  // In packaged build: process.resourcesPath/embeddings/
  if (app.isPackaged) {
    return path.join(process.resourcesPath || '', 'embeddings')
  }
  return path.join(process.cwd(), 'resources', 'embeddings')
}

export function downloadedRoot(): string {
  return path.join(app.getPath('userData'), 'downloaded-models')
}

export function resolveModelDir(modelId: string): string | null {
  const d1 = path.join(downloadedRoot(), modelId)
  if (fs.existsSync(d1)) return d1
  const d2 = path.join(bundledRoot(), modelId)
  if (fs.existsSync(d2)) return d2
  return null
}

// -----------------------------------------------------------------------
// Scanning
// -----------------------------------------------------------------------
function hasOnnx(dir: string): boolean {
  const roots = [path.join(dir, 'onnx'), dir]
  for (const r of roots) {
    try {
      if (!fs.existsSync(r)) continue
      for (const f of fs.readdirSync(r)) {
        if (f.endsWith('.onnx')) return true
      }
    } catch { /* skip */ }
  }
  return false
}

function hasTokenizer(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'tokenizer.json'))
}

function readDim(dir: string): number | undefined {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>
    const v = cfg.hidden_size ?? cfg.d_model ?? cfg.hidden_dim
    if (typeof v === 'number' && v > 0) return v
  } catch { /* ignore */ }
  return undefined
}

function dirSize(dir: string): number {
  let total = 0
  try {
    const stack: string[] = [dir]
    while (stack.length > 0) {
      const d = stack.pop()!
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) stack.push(p)
        else {
          try { total += fs.statSync(p).size } catch { /* skip */ }
        }
      }
    }
  } catch { /* skip */ }
  return total
}

function scanDir(root: string, source: 'bundled' | 'downloaded'): LocalModelInfo[] {
  if (!fs.existsSync(root)) return []
  let ids: string[]
  try { ids = fs.readdirSync(root) } catch { return [] }
  const out: LocalModelInfo[] = []
  for (const id of ids) {
    const dir = path.join(root, id)
    try {
      if (!fs.statSync(dir).isDirectory()) continue
    } catch { continue }
    const tok = hasTokenizer(dir)
    const onnx = hasOnnx(dir)
    const installed = tok && onnx
    const reason = !tok ? 'missing tokenizer.json' : !onnx ? 'no .onnx file' : undefined
    const catalogEntry = DOWNLOADABLE_MODELS.find((m) => m.id === id)
    out.push({
      id,
      name: catalogEntry?.name ?? id,
      description: catalogEntry?.description ?? (source === 'bundled' ? '内置本地模型' : '已下载'),
      dir,
      source,
      installed,
      reason,
      sizeBytes: dirSize(dir),
      dimensions: readDim(dir) ?? catalogEntry?.dimensions,
    })
  }
  return out
}

/**
 * List every model discovered on disk. Downloaded versions shadow bundled
 * versions with the same id (users can upgrade a bundled model by dropping
 * a newer copy under `downloaded-models/`).
 */
export function listLocalModels(): LocalModelInfo[] {
  const downloaded = scanDir(downloadedRoot(), 'downloaded')
  const bundled = scanDir(bundledRoot(), 'bundled')
  const byId = new Map<string, LocalModelInfo>()
  for (const m of bundled) byId.set(m.id, m)
  for (const m of downloaded) byId.set(m.id, m) // downloaded shadows bundled
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}
