/**
 * Gemini generateContent / streamGenerateContent 请求体清理。
 * - inlineData / inline_data 若缺 data 或仅空白会报 parts[n].data oneof 错误
 * - functionResponse 需非空 struct
 * - Gemini 2.5 思考 + 工具：同一 Part 上需保留 thoughtSignature（与 functionCall 同级），否则会报 missing thought_signature
 */

/** 与 @google/generative-ai REST Part 对齐的可序列化字段 */
const GEMINI_PART_SERIALIZABLE_KEYS = new Set([
  'text',
  'inlineData',
  'functionCall',
  'functionResponse',
  'fileData',
  'executableCode',
  'codeExecutionResult',
])

export type GeminiContentLoose = {
  role: 'user' | 'model' | string
  parts: Array<Record<string, unknown>>
}

/** 将部分代理/手写 JSON 的 snake_case 转为 SDK 使用的 camelCase */
function normalizePartFieldNames(part: Record<string, unknown>): Record<string, unknown> {
  const p = { ...part }
  if (p.inline_data !== undefined && p.inlineData === undefined) {
    const id = p.inline_data as Record<string, unknown>
    p.inlineData = {
      mimeType:
        (typeof id.mime_type === 'string' ? id.mime_type : undefined) ||
        (typeof id.mimeType === 'string' ? id.mimeType : undefined) ||
        'application/octet-stream',
      data: typeof id.data === 'string' ? id.data : '',
    }
    delete p.inline_data
  }
  if (p.function_call !== undefined && p.functionCall === undefined) {
    p.functionCall = p.function_call
    delete p.function_call
  }
  if (p.function_response !== undefined && p.functionResponse === undefined) {
    p.functionResponse = p.function_response
    delete p.function_response
  }
  if (p.thought_signature !== undefined && p.thoughtSignature === undefined) {
    p.thoughtSignature = p.thought_signature
  }
  return p
}

/**
 * 发送前清理 contents：去掉非标准 Part 字段、补全 functionResponse、剔除空 inlineData。
 */
export function sanitizeGeminiContents(contents: GeminiContentLoose[]): GeminiContentLoose[] {
  return contents.map((turn) => ({
    role: turn.role,
    parts: turn.parts.map((part): Record<string, unknown> => {
      const raw = normalizePartFieldNames(part)

      const cleaned: Record<string, unknown> = {}
      for (const key of GEMINI_PART_SERIALIZABLE_KEYS) {
        if (key in raw && raw[key] !== undefined) {
          cleaned[key] = raw[key]
        }
      }

      if (cleaned.inlineData && typeof cleaned.inlineData === 'object' && cleaned.inlineData !== null) {
        const blob = cleaned.inlineData as Record<string, unknown>
        const data = typeof blob.data === 'string' ? blob.data : ''
        const mimeType =
          typeof blob.mimeType === 'string' && blob.mimeType.length > 0
            ? blob.mimeType
            : 'application/octet-stream'
        if (!data.trim()) {
          return { text: '[invalid inlineData: empty data]' }
        }
        return { inlineData: { mimeType, data } }
      }

      if (
        cleaned.functionResponse &&
        typeof cleaned.functionResponse === 'object' &&
        cleaned.functionResponse !== null
      ) {
        const fr = cleaned.functionResponse as Record<string, unknown>
        const name =
          typeof fr.name === 'string' && fr.name.trim().length > 0 ? fr.name.trim() : 'unknown'
        let response = fr.response
        if (
          response === undefined ||
          response === null ||
          (typeof response === 'object' &&
            !Array.isArray(response) &&
            Object.keys(response as object).length === 0)
        ) {
          response = { result: '(empty tool result)' }
        } else if (typeof response !== 'object' || Array.isArray(response)) {
          response = { result: String(response) }
        }
        return { functionResponse: { name, response: response as Record<string, unknown> } }
      }

      if (cleaned.functionCall && typeof cleaned.functionCall === 'object' && cleaned.functionCall !== null) {
        const fc = cleaned.functionCall as Record<string, unknown>
        const name = typeof fc.name === 'string' ? fc.name : 'unknown'
        const args = fc.args && typeof fc.args === 'object' && !Array.isArray(fc.args) ? fc.args : {}
        const out: Record<string, unknown> = {
          functionCall: { name, args: args as Record<string, unknown> },
        }
        const sig =
          typeof raw.thoughtSignature === 'string'
            ? raw.thoughtSignature
            : typeof raw.thought_signature === 'string'
              ? raw.thought_signature
              : undefined
        if (sig !== undefined && sig.length > 0) {
          out.thoughtSignature = sig
        }
        return out
      }

      if (typeof cleaned.text === 'string') {
        return { text: cleaned.text.length > 0 ? cleaned.text : ' ' }
      }

      return { text: ' ' }
    }),
  }))
}

/** 对 transformRequest 产出的整段 Gemini JSON 做统一清理（兼容客户端 fetch 前调用） */
export function sanitizeGeminiGeneratePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload }
  if (Array.isArray(out.contents)) {
    out.contents = sanitizeGeminiContents(out.contents as GeminiContentLoose[])
  }
  return out
}
