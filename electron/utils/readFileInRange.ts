/**
 * Line-oriented file reader with two code paths.
 *
 * Fast path  (regular files < 10 MB): readFile + in-memory line split.
 * Streaming path (large files, pipes): createReadStream, only accumulates
 *   lines inside the requested range.
 *
 * Both paths strip UTF-8 BOM and normalise CRLF to LF.
 * mtime comes from stat on the file.
 */

import { createReadStream, type ReadStream } from 'fs'
import { stat as fsStat, readFile } from 'fs/promises'

const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024

export interface ReadFileRangeResult {
  content: string
  lineCount: number
  totalLines: number
  totalBytes: number
  readBytes: number
  mtimeMs: number
}

export async function readFileInRange(
  filePath: string,
  offset = 0,
  maxLines?: number,
  signal?: AbortSignal,
): Promise<ReadFileRangeResult> {
  signal?.throwIfAborted()

  const stats = await fsStat(filePath)

  if (stats.isDirectory()) {
    throw new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`)
  }

  if (stats.isFile() && stats.size < FAST_PATH_MAX_SIZE) {
    const text = await readFile(filePath, { encoding: 'utf8', signal })
    return readFileInRangeFast(text, stats.mtimeMs, offset, maxLines)
  }

  return readFileInRangeStreaming(filePath, stats.mtimeMs, offset, maxLines, signal)
}

function readFileInRangeFast(
  raw: string,
  mtimeMs: number,
  offset: number,
  maxLines: number | undefined,
): ReadFileRangeResult {
  const endLine = maxLines !== undefined ? offset + maxLines : Infinity
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw

  const selectedLines: string[] = []
  let lineIndex = 0
  let startPos = 0
  let newlinePos: number

  while ((newlinePos = text.indexOf('\n', startPos)) !== -1) {
    if (lineIndex >= offset && lineIndex < endLine) {
      let line = text.slice(startPos, newlinePos)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      selectedLines.push(line)
    }
    lineIndex++
    startPos = newlinePos + 1
  }

  if (lineIndex >= offset && lineIndex < endLine) {
    let line = text.slice(startPos)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    selectedLines.push(line)
  }
  lineIndex++

  const content = selectedLines.join('\n')
  return {
    content,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    totalBytes: Buffer.byteLength(text, 'utf8'),
    readBytes: Buffer.byteLength(content, 'utf8'),
    mtimeMs,
  }
}

async function readFileInRangeStreaming(
  filePath: string,
  mtimeMs: number,
  offset: number,
  maxLines: number | undefined,
  signal?: AbortSignal,
): Promise<ReadFileRangeResult> {
  const endLine = maxLines !== undefined ? offset + maxLines : Infinity

  return new Promise<ReadFileRangeResult>((resolve, reject) => {
    const stream: ReadStream = createReadStream(filePath, {
      encoding: 'utf8',
      highWaterMark: 512 * 1024,
    })

    let lineIndex = 0
    let totalBytes = 0
    let leftover = ''
    let bomStripped = false
    const selectedLines: string[] = []

    const cleanup = () => {
      stream.removeAllListeners()
      stream.destroy()
    }

    if (signal) {
      const onAbort = () => {
        cleanup()
        reject(signal.reason ?? new Error('Aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      stream.once('close', () => signal.removeEventListener('abort', onAbort))
    }

    stream.on('data', (chunk: string | Buffer) => {
      if (Buffer.isBuffer(chunk)) chunk = chunk.toString('utf8')
      if (!bomStripped) {
        bomStripped = true
        if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1)
      }

      totalBytes += Buffer.byteLength(chunk, 'utf8')
      leftover += chunk

      let pos = 0
      let nlPos: number
      while ((nlPos = leftover.indexOf('\n', pos)) !== -1) {
        if (lineIndex >= offset && lineIndex < endLine) {
          let line = leftover.slice(pos, nlPos)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          selectedLines.push(line)
        }
        lineIndex++
        pos = nlPos + 1
      }
      leftover = leftover.slice(pos)
    })

    stream.once('end', () => {
      if (leftover.length > 0) {
        if (lineIndex >= offset && lineIndex < endLine) {
          let line = leftover
          if (line.endsWith('\r')) line = line.slice(0, -1)
          selectedLines.push(line)
        }
        lineIndex++
      }

      const content = selectedLines.join('\n')
      resolve({
        content,
        lineCount: selectedLines.length,
        totalLines: lineIndex,
        totalBytes,
        readBytes: Buffer.byteLength(content, 'utf8'),
        mtimeMs,
      })
    })

    stream.once('error', (err: Error) => {
      cleanup()
      reject(err)
    })
  })
}
