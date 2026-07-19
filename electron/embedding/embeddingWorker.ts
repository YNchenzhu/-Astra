/**
 * Embedding worker thread.
 *
 * Runs transformers.js + ONNX Runtime inference in a dedicated Node
 * `worker_threads` Worker so the Electron **main process** event loop stays
 * free to service IPC and keep the renderer UI responsive.
 *
 * Without this isolation, ONNX's native CPU threads monopolize logical
 * cores and the JS tokenization + post-processing pieces (which still run
 * on a JavaScript thread) block IPC handlers for ~4-5 seconds per
 * micro-batch, making the whole app feel frozen during index builds that
 * take 10-60+ minutes.
 *
 * Message protocol (parent ⇄ worker):
 *
 *   parent → worker
 *     { type: 'load',  reqId, modelId, modelDir }
 *     { type: 'embed', reqId, texts }
 *     { type: 'unload' }
 *
 *   worker → parent
 *     { type: 'loaded',   reqId, dim }
 *     { type: 'progress', reqId, microIdx, microTotal, durationMs, maxLen }
 *     { type: 'result',   reqId, vectors: number[][], dim }
 *     { type: 'error',    reqId, error: string }
 *
 * Vectors are transferred as nested plain arrays (not Float32Array) to
 * keep the main-process consumer code unchanged. The payload is at most
 * `batch × dim × 8 bytes` of structured-clone overhead (~1 MB per 64 ×
 * 1024-dim BGE-M3 batch), which is dwarfed by the 4-5 s inference time.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { parentPort } from 'node:worker_threads'

if (!parentPort) {
  throw new Error('[embeddingWorker] must be spawned as a worker_thread')
}
const port = parentPort

// ---------------------------------------------------------------------------
// Shared constants (keep in sync with localModel.ts defaults)
// ---------------------------------------------------------------------------

const LOCAL_MAX_SEQ_TOKENS = 384
const LOCAL_MAX_CHARS_PER_TEXT = LOCAL_MAX_SEQ_TOKENS * 8
const LOCAL_MICROBATCH = 4

/**
 * In-worker intra-op thread count. Because the worker is isolated from the
 * Electron main process, we can be a bit more aggressive than we could
 * inside the main process — the worker has no UI/IPC on its event loop.
 * Still capped at 4 to avoid oversubscribing physical cores on busy boxes.
 */
const ORT_INTRA_OP_THREADS = Math.max(1, Math.min(4, os.cpus().length))

// ---------------------------------------------------------------------------
// Model loading (same logic as the old localModel.ts)
// ---------------------------------------------------------------------------

/**
 * Structural view of the slice of `@huggingface/transformers` we actually
 * call. Only fields we touch are declared; unknown members on
 * `env.backends.onnx` fall through via `Record<string, unknown>`.
 */
interface TransformersEnv {
  allowLocalModels?: boolean
  allowRemoteModels?: boolean
  backends?: {
    onnx?: { logSeverityLevel?: number } & Record<string, unknown>
  }
}
interface TransformersPipelineOutput {
  dims?: number[]
  data: Float32Array | number[]
}
interface TransformersTokenizer {
  model_max_length?: number
  _tokenizerConfig?: { model_max_length?: number } & Record<string, unknown>
  _tokenizer_config?: { model_max_length?: number } & Record<string, unknown>
}
interface TransformersPipeline {
  tokenizer?: TransformersTokenizer
  dispose?(): void
  (
    texts: string[],
    opts: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean },
  ): Promise<TransformersPipelineOutput>
}
interface TransformersModule {
  env: TransformersEnv
  pipeline(
    task: 'feature-extraction',
    model: string,
    opts: Record<string, unknown>,
  ): Promise<TransformersPipeline>
}

let cachedTfm: TransformersModule | null = null

async function loadTransformers(): Promise<TransformersModule> {
  if (cachedTfm) return cachedTfm
  const tfm = (await import('@huggingface/transformers')) as unknown as TransformersModule
  const env = tfm.env
  if (env) {
    env.allowLocalModels = true
    env.allowRemoteModels = false
    if (env.backends?.onnx?.logSeverityLevel !== undefined) {
      env.backends.onnx.logSeverityLevel = 3
    }
  }
  cachedTfm = tfm
  return tfm
}

function readDimFromConfig(modelDir: string): number {
  try {
    const raw = fs.readFileSync(path.join(modelDir, 'config.json'), 'utf8')
    const j = JSON.parse(raw) as Record<string, unknown>
    if (typeof j.hidden_size === 'number') return j.hidden_size
    if (typeof j.d_model === 'number') return j.d_model as number
    if (typeof j.hidden_dim === 'number') return j.hidden_dim as number
  } catch { /* ignore */ }
  return 0
}

function resolveOnnxFile(modelDir: string): string | null {
  const onnxDir = path.join(modelDir, 'onnx')
  if (!fs.existsSync(onnxDir)) {
    if (fs.existsSync(path.join(modelDir, 'model.onnx'))) {
      return path.join(modelDir, 'model.onnx')
    }
    return null
  }
  const preferred = [
    'model_quantized.onnx',
    'model_q8.onnx',
    'model_q4.onnx',
    'model_fp16.onnx',
    'model.onnx',
  ]
  for (const name of preferred) {
    const p = path.join(onnxDir, name)
    if (fs.existsSync(p)) return p
  }
  try {
    const any = fs.readdirSync(onnxDir).find((f) => f.endsWith('.onnx'))
    return any ? path.join(onnxDir, any) : null
  } catch { return null }
}

function dtypeForOnnxBasename(basename: string): 'q4' | 'q8' | 'fp16' | 'int8' | 'fp32' {
  if (basename === 'model_q4') return 'q4'
  if (basename === 'model_quantized') return 'q8'
  if (basename === 'model_int8') return 'int8'
  if (basename === 'model_fp16') return 'fp16'
  return 'fp32'
}

interface LoadedModel {
  id: string
  dir: string
  dim: number
  pipe: TransformersPipeline
}

let current: LoadedModel | null = null

async function loadModel(id: string, modelDir: string): Promise<LoadedModel> {
  if (current && current.id === id && current.dir === modelDir) return current

  const normDir = modelDir.replace(/\\/g, '/')
  const onnxFile = resolveOnnxFile(modelDir)
  if (!onnxFile) {
    throw new Error(`No .onnx file found under ${modelDir}`)
  }
  for (const f of ['tokenizer.json', 'tokenizer_config.json', 'config.json']) {
    if (!fs.existsSync(path.join(modelDir, f))) {
      throw new Error(`Missing required file "${f}" in ${modelDir}`)
    }
  }

  const baseName = path.basename(onnxFile, '.onnx')
  const dtype = dtypeForOnnxBasename(baseName)
  const atRoot = path.dirname(onnxFile) === modelDir
  const strippedName = baseName
    .replace(/_quantized$/, '')
    .replace(/_q[248]$/, '')
    .replace(/_int8$/, '')
    .replace(/_fp16$/, '')
  const hasExternalData =
    fs.existsSync(onnxFile + '_data') || fs.existsSync(onnxFile + '.data')

  const pipelineOpts: Record<string, unknown> = {
    local_files_only: true,
    dtype,
    // Same safety config as before — keeps BFC arena from exploding and
    // keeps worker thread affinity deterministic.
    session_options: {
      intraOpNumThreads: ORT_INTRA_OP_THREADS,
      interOpNumThreads: 1,
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
      enableMemPattern: false,
      enableCpuMemArena: false,
    },
  }
  if (atRoot) {
    pipelineOpts.subfolder = ''
    pipelineOpts.model_file_name = strippedName
  }
  if (!hasExternalData) {
    pipelineOpts.use_external_data_format = false
  }

  console.log(`[embeddingWorker] loading "${id}" from ${normDir}`)
  console.log(`[embeddingWorker]   onnx file: ${onnxFile}`)
  console.log(`[embeddingWorker]   dtype: ${dtype}; intraOpThreads: ${ORT_INTRA_OP_THREADS}`)

  const tfm = await loadTransformers()
  const t0 = Date.now()
  const pipe = await tfm.pipeline('feature-extraction', normDir, pipelineOpts)
  console.log(`[embeddingWorker]   model loaded in ${Date.now() - t0}ms`)

  // Clamp tokenizer.model_max_length via its backing _tokenizerConfig,
  // because the public property is a read-only getter in transformers.js.
  try {
    const tok = pipe?.tokenizer
    const cfg = tok?._tokenizerConfig || tok?._tokenizer_config
    if (cfg) {
      const prev = typeof cfg.model_max_length === 'number' ? cfg.model_max_length : undefined
      cfg.model_max_length = Math.min(prev ?? LOCAL_MAX_SEQ_TOKENS, LOCAL_MAX_SEQ_TOKENS)
      console.log(
        `[embeddingWorker]   tokenizer.model_max_length: ${prev ?? 'unset'} → ${tok?.model_max_length}`,
      )
    }
  } catch { /* non-fatal */ }

  const dim = readDimFromConfig(modelDir) || 0
  current = { id, dir: modelDir, dim, pipe }
  return current
}

// ---------------------------------------------------------------------------
// File walking + chunking (moved from workspaceIndex.ts)
// ---------------------------------------------------------------------------

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.fs', '.swift', '.m', '.mm',
  '.php', '.lua', '.dart', '.ex', '.exs', '.erl', '.clj',
  '.sh', '.bash', '.zsh', '.ps1',
  '.sql', '.graphql', '.proto',
  '.vue', '.svelte', '.astro',
  '.css', '.scss', '.less', '.sass',
  '.html', '.htm',
  '.md', '.mdx', '.rst', '.txt',
])

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'dist-electron', 'build', 'out', 'target', 'release',
  '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache',
  'coverage', '.nyc_output',
  '__pycache__', '.venv', 'venv', 'env',
  '.idea', '.vscode', '.cursor', '.claude',
  'vendor',
])

const SKIP_FILE_PATTERNS: RegExp[] = [
  /\.min\.(js|css)$/i,
  /\.bundle\.(js|css)$/i,
  /\.map$/i,
  /^(package-lock|yarn|pnpm-lock)\.(json|yaml|lock)$/i,
]

const WINDOW_LINES = 120
const OVERLAP_LINES = 20
const MAX_CHARS_PER_CHUNK = 4_000

interface WalkedFile {
  absPath: string
  relPath: string
  size: number
}

interface CodeChunk {
  id: string
  text: string
  relPath: string
  startLine: number
  endLine: number
}

async function walkCodeFiles(root: string, cap: number): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  const rootAbs = path.resolve(root)

  async function walk(dir: string): Promise<void> {
    if (out.length >= cap) return
    let ents
    try {
      ents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of ents) {
      if (out.length >= cap) return
      if (ent.name.startsWith('.') && SKIP_DIRS.has(ent.name)) continue
      if (SKIP_DIRS.has(ent.name)) continue
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!ent.isFile()) continue
      if (SKIP_FILE_PATTERNS.some((r) => r.test(ent.name))) continue
      const ext = path.extname(ent.name).toLowerCase()
      if (!CODE_EXTS.has(ext)) continue
      let st
      try {
        st = await stat(abs)
      } catch {
        continue
      }
      out.push({
        absPath: abs,
        relPath: path.relative(rootAbs, abs).replace(/\\/g, '/'),
        size: st.size,
      })
    }
  }

  await walk(rootAbs)
  return out
}

function chunkCodeFile(relPath: string, content: string): CodeChunk[] {
  const lines = content.split(/\r?\n/)
  if (lines.length === 0) return []
  const out: CodeChunk[] = []
  let i = 0
  const fileId = createHash('sha1').update(relPath).digest('hex').slice(0, 12)
  while (i < lines.length) {
    const end = Math.min(lines.length, i + WINDOW_LINES)
    let text = lines.slice(i, end).join('\n')
    if (text.length > MAX_CHARS_PER_CHUNK) {
      text = text.slice(0, MAX_CHARS_PER_CHUNK)
    }
    if (text.trim().length > 0) {
      out.push({
        id: `${fileId}:${i + 1}-${end}`,
        text,
        relPath,
        startLine: i + 1,
        endLine: end,
      })
    }
    if (end >= lines.length) break
    i = end - OVERLAP_LINES
    if (i <= (out[out.length - 1]?.startLine ?? 0)) i = end
  }
  return out
}

async function handleWalkChunk(
  reqId: number,
  root: string,
  maxFiles: number,
  maxBytesPerFile: number,
): Promise<void> {
  const files = await walkCodeFiles(root, maxFiles)
  const chunks: Array<{
    relPath: string
    absPath: string
    size: number
    chunks: CodeChunk[]
  }> = []
  let totalChunks = 0
  const errors: Array<{ file: string; error: string }> = []

  for (const f of files) {
    if (f.size > maxBytesPerFile) {
      errors.push({ file: f.relPath, error: `skipped (file > ${maxBytesPerFile} bytes)` })
      continue
    }
    try {
      const content = fs.readFileSync(f.absPath, 'utf8')
      const fileChunks = chunkCodeFile(f.relPath, content)
      if (fileChunks.length > 0) {
        chunks.push({ relPath: f.relPath, absPath: f.absPath, size: f.size, chunks: fileChunks })
        totalChunks += fileChunks.length
      }
    } catch (err) {
      errors.push({ file: f.relPath, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // Send results in batches to avoid structured-clone size limits
  const BATCH_SIZE = 500
  for (let off = 0; off < chunks.length; off += BATCH_SIZE) {
    const batch = chunks.slice(off, off + BATCH_SIZE)
    port.postMessage({
      type: 'walk-chunk-progress',
      reqId,
      batchIdx: Math.floor(off / BATCH_SIZE),
      batchTotal: Math.ceil(chunks.length / BATCH_SIZE),
      filesScanned: files.length,
      filesIndexed: off + batch.length,
      chunksInBatch: batch.reduce((sum, c) => sum + c.chunks.length, 0),
      totalChunks,
    })
  }

  port.postMessage({
    type: 'walk-chunk-result',
    reqId,
    filesScanned: files.length,
    chunks,
    totalChunks,
    errors,
  })
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

async function embed(
  reqId: number,
  texts: string[],
): Promise<{ vectors: number[][]; dim: number }> {
  if (!current) throw new Error('model not loaded')
  if (texts.length === 0) return { vectors: [], dim: current.dim }

  const clipped = texts.map((t) =>
    t.length > LOCAL_MAX_CHARS_PER_TEXT ? t.slice(0, LOCAL_MAX_CHARS_PER_TEXT) : t,
  )
  const microTotal = Math.ceil(clipped.length / LOCAL_MICROBATCH)

  const vectors: number[][] = []
  let dim = 0
  let microIdx = 0
  for (let off = 0; off < clipped.length; off += LOCAL_MICROBATCH) {
    const micro = clipped.slice(off, off + LOCAL_MICROBATCH)
    const mbT0 = Date.now()
    const out = await current.pipe(micro, { pooling: 'mean', normalize: true })
    const mbMaxLen = micro.reduce((m0, t) => (t.length > m0 ? t.length : m0), 0)
    microIdx += 1
    const durationMs = Date.now() - mbT0

    const dims: number[] = out.dims ?? []
    const curDim = dims[dims.length - 1] || current.dim || 0
    if (!dim) dim = curDim
    else if (curDim !== dim) throw new Error(`dim changed mid-batch: ${dim} → ${curDim}`)

    const data: Float32Array | number[] = out.data
    for (let i = 0; i < micro.length; i++) {
      const start = i * dim
      const arr = new Array(dim)
      for (let j = 0; j < dim; j++) arr[j] = Number(data[start + j])
      vectors.push(arr)
    }

    port.postMessage({
      type: 'progress',
      reqId,
      microIdx,
      microTotal,
      durationMs,
      maxLen: mbMaxLen,
    })
  }

  return { vectors, dim }
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

interface InMsg {
  type: 'load' | 'embed' | 'unload' | 'walk-chunk'
  reqId: number
  modelId?: string
  modelDir?: string
  texts?: string[]
  root?: string
  maxFiles?: number
  maxBytesPerFile?: number
}

port.on('message', async (msg: InMsg) => {
  const { type, reqId } = msg
  try {
    if (type === 'walk-chunk') {
      await handleWalkChunk(reqId, msg.root!, msg.maxFiles ?? 5_000, msg.maxBytesPerFile ?? 200_000)
      return
    }
    if (type === 'load') {
      const m = await loadModel(msg.modelId!, msg.modelDir!)
      port.postMessage({ type: 'loaded', reqId, dim: m.dim })
      return
    }
    if (type === 'embed') {
      const { vectors, dim } = await embed(reqId, msg.texts ?? [])
      port.postMessage({ type: 'result', reqId, vectors, dim })
      return
    }
    if (type === 'unload') {
      try { current?.pipe?.dispose?.() } catch { /* noop */ }
      current = null
      port.postMessage({ type: 'result', reqId, vectors: [], dim: 0 })
      return
    }
    throw new Error(`unknown message type: ${type}`)
  } catch (err) {
    port.postMessage({
      type: 'error',
      reqId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
})
