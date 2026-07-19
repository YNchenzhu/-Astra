/**
 * API 转换器单元测试
 * 验证各种 API 格式到 Claude 格式的转换
 */

import {
  detectAPIFormat,
  transformToClaudeFormat,
  isCompatibleEndpoint,
  type APIFormat
} from './apiTransformer'

// ========== 测试数据 ==========

const testCases = {
  // OpenAI Chat 格式
  openaiChat: {
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
      {
        role: 'assistant',
        content: 'Hi there!',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location": "New York"}'
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_123',
        content: 'Sunny, 72°F'
      }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for a location',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string' }
            }
          }
        }
      }
    ],
    temperature: 0.7,
    max_completion_tokens: 1000
  },

  // OpenAI2 (Responses API) 格式
  openai2: {
    model: 'gpt-4',
    instructions: 'You are a helpful assistant.',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Hello!' }
        ]
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Hi there!' }
        ]
      },
      {
        type: 'tool_use',
        call_id: 'call_123',
        name: 'get_weather',
        input: { location: 'New York' }
      },
      {
        type: 'tool_result',
        call_id: 'call_123',
        output: 'Sunny, 72°F'
      }
    ],
    tools: [
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather for a location',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string' }
          }
        }
      }
    ],
    temperature: 0.7,
    max_output_tokens: 1000
  },

  // Gemini 格式
  gemini: {
    model: 'gemini-2.5-pro',
    systemInstruction: {
      parts: [
        { text: 'You are a helpful assistant.' }
      ]
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Hello!' }
        ]
      },
      {
        role: 'model',
        parts: [
          { text: 'Hi there!' }
        ]
      },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'get_weather',
              args: { location: 'New York' }
            }
          }
        ]
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'get_weather',
              response: { result: 'Sunny, 72°F' }
            }
          }
        ]
      }
    ],
    tools: [
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get weather for a location',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string' }
              }
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1000
    }
  },

  // Claude 格式（已经是 Claude 格式）
  claude: {
    model: 'claude-sonnet-4-20250514',
    system: 'You are a helpful assistant.',
    messages: [
      { role: 'user', content: 'Hello!' },
      { role: 'assistant', content: 'Hi there!' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_123',
            name: 'get_weather',
            input: { location: 'New York' }
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: 'Sunny, 72°F'
          }
        ]
      }
    ],
    tools: [
      {
        name: 'get_weather',
        description: 'Get weather for a location',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string' }
          }
        }
      }
    ],
    temperature: 0.7,
    max_tokens: 1000
  }
}

import { describe, it, expect } from 'vitest'

// ========== 测试函数 ==========

describe('API Transformer', () => {
  describe('format detection', () => {
    const detectionTests: Array<[string, unknown, APIFormat]> = [
      ['OpenAI Chat', testCases.openaiChat, 'openai'],
      ['OpenAI2 (Responses API)', testCases.openai2, 'openai2'],
      ['Gemini', testCases.gemini, 'gemini'],
      ['Claude', testCases.claude, 'claude']
    ]

    for (const [name, data, expectedFormat] of detectionTests) {
      it(`detects ${name} format`, () => {
        const result = detectAPIFormat(data)
        expect(result.format).toBe(expectedFormat)
      })
    }
  })

  describe('transform to Claude format', () => {
    const transformTests: Array<[string, unknown]> = [
      ['OpenAI Chat', testCases.openaiChat],
      ['OpenAI2', testCases.openai2],
      ['Gemini', testCases.gemini],
      ['Claude', testCases.claude]
    ]

    for (const [name, data] of transformTests) {
      it(`transforms ${name} to Claude`, () => {
        const { result } = transformToClaudeFormat(data)
        expect(result.messages).toBeDefined()
        expect(Array.isArray(result.messages)).toBe(true)
      })
    }
  })

  describe('compatible endpoint detection', () => {
    const endpointTests: Array<[string, string, boolean]> = [
      ['OpenAI official', 'https://api.openai.com/v1', true],
      ['local vLLM', 'http://localhost:8000/v1', true],
      ['SiliconFlow', 'https://api.siliconflow.cn/v1', true],
      ['Gemini API', 'https://generativelanguage.googleapis.com/v1beta', true],
      ['empty endpoint', '', false],
      ['invalid endpoint', 'not-a-url', true],
    ]

    for (const [name, url, expected] of endpointTests) {
      it(`detects ${name}: ${url || '(empty)'}`, () => {
        const result = isCompatibleEndpoint(url)
        expect(result).toBe(expected)
      })
    }
  })
})

// ========== 性能测试 ==========

export function runPerformanceTests() {
  console.log('\n⚡ 性能测试')
  console.log('=' .repeat(50))

  const iterations = 1000

  // 测试格式检测性能
  console.log(`\n检测性能 (${iterations} 次迭代):`)
  const detectionStart = performance.now()
  for (let i = 0; i < iterations; i++) {
    detectAPIFormat(testCases.openaiChat)
    detectAPIFormat(testCases.openai2)
    detectAPIFormat(testCases.gemini)
  }
  const detectionTime = performance.now() - detectionStart
  console.log(`  总耗时: ${detectionTime.toFixed(2)}ms`)
  console.log(`  平均耗时: ${(detectionTime / (iterations * 3)).toFixed(3)}ms`)

  // 测试转换性能
  console.log(`\n转换性能 (${iterations} 次迭代):`)
  const transformStart = performance.now()
  for (let i = 0; i < iterations; i++) {
    transformToClaudeFormat(testCases.openaiChat)
    transformToClaudeFormat(testCases.openai2)
    transformToClaudeFormat(testCases.gemini)
  }
  const transformTime = performance.now() - transformStart
  console.log(`  总耗时: ${transformTime.toFixed(2)}ms`)
  console.log(`  平均耗时: ${(transformTime / (iterations * 3)).toFixed(3)}ms`)
}

// ========== 导出测试运行器 ==========

export function runAllTests() {
  runPerformanceTests()
}

// 如果直接运行此文件
if (typeof require !== 'undefined' && require.main === module) {
  runAllTests()
}
