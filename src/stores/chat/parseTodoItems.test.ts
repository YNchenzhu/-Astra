import { describe, expect, it } from 'vitest'
import { parseTodoItemsFromToolOutput } from './parseTodoItems'

describe('parseTodoItemsFromToolOutput', () => {
  it('returns undefined for non-string input', () => {
    expect(parseTodoItemsFromToolOutput(null)).toBeUndefined()
    expect(parseTodoItemsFromToolOutput(123)).toBeUndefined()
    expect(parseTodoItemsFromToolOutput({ items: [] })).toBeUndefined()
  })

  it('returns undefined for empty / whitespace string', () => {
    expect(parseTodoItemsFromToolOutput('')).toBeUndefined()
    expect(parseTodoItemsFromToolOutput('   ')).toBeUndefined()
  })

  it('returns undefined for non-JSON string', () => {
    expect(parseTodoItemsFromToolOutput('not json at all')).toBeUndefined()
  })

  it('parses the canonical { items, message } envelope', () => {
    const raw = JSON.stringify({ items: [{ content: 'a', status: 'pending' }], message: 'ok' })
    expect(parseTodoItemsFromToolOutput(raw)).toEqual([{ content: 'a', status: 'pending' }])
  })

  it('accepts a bare JSON array (legacy shape)', () => {
    const raw = JSON.stringify([{ content: 'x', status: 'completed' }])
    expect(parseTodoItemsFromToolOutput(raw)).toEqual([{ content: 'x', status: 'completed' }])
  })

  it('returns undefined when items is present but not an array', () => {
    expect(parseTodoItemsFromToolOutput(JSON.stringify({ items: 'nope' }))).toBeUndefined()
  })

  it('returns undefined for a JSON object lacking items', () => {
    expect(parseTodoItemsFromToolOutput(JSON.stringify({ message: 'hi' }))).toBeUndefined()
  })

  it('returns empty array when items is an empty array', () => {
    expect(parseTodoItemsFromToolOutput(JSON.stringify({ items: [] }))).toEqual([])
  })
})
