/**
 * Contract tests for IPC argument schemas.
 *
 * Purpose: guard against two failure modes I could have introduced in the
 * `validatedHandle` migration —
 *   1. Legitimate renderer payloads getting rejected ("works on disk but
 *      preload invoke throws"). This is the biggest risk because Zod errors
 *      at the IPC boundary are invisible to the user until a feature breaks.
 *   2. Schemas silently loosened so that obvious garbage still passes.
 *
 * Each handler-level schema gets at least:
 *   - one "realistic renderer payload" case that MUST pass
 *   - a couple of shape-violation cases that MUST fail
 *
 * These are offline tests — they do not call into `ipcMain.handle` (that's
 * a runtime smoke test that lives outside of Vitest).
 */

import { describe, expect, it } from 'vitest'

import {
  agentsSyncCustomArgs,
  aiCancelArgs,
  aiEnqueueMidTurnInputArgs,
  aiRetryTaskArgs,
  aiSendMessageArgs,
  aiStopTaskArgs,
  fsCreateDirArgs,
  fsDeleteArgs,
  fsFileTreeArgs,
  fsOpenDialogArgs,
  fsRenameArgs,
  fsSearchArgs,
  fsWriteFileArgs,
  gitAddArgs,
  gitCommitArgs,
  gitRestoreArgs,
  gitSetIdentityArgs,
  gitUnstageArgs,
  hooksFirePayloadArgs,
  mcpConnectArgs,
  mcpDisconnectArgs,
  mcpReconnectArgs,
  memoryCreateArgs,
  memoryDeleteArgs,
  memoryGetArgs,
  memoryRecallAiArgs,
  memorySetWorkspaceArgs,
  memoryToggleEnabledArgs,
  memoryUpdateArgs,
  memoryValidateDirectoryArgs,
  settingsSetArgs,
  terminalCloseArgs,
  terminalCreateArgs,
  terminalExecArgs,
  terminalResizeArgs,
  terminalWriteArgs,
} from './schemas'

describe('fs schemas', () => {
  it('fs:write-file accepts a normal utf-8 payload', () => {
    expect(
      fsWriteFileArgs.safeParse(['G:/workspace-code/proj/src/App.tsx', 'export const x = 1\n'])
        .success,
    ).toBe(true)
  })

  it('fs:write-file rejects non-string content', () => {
    expect(fsWriteFileArgs.safeParse(['G:/x', 123]).success).toBe(false)
    expect(fsWriteFileArgs.safeParse(['G:/x', { buf: 'oops' }]).success).toBe(false)
  })

  it('fs:write-file rejects empty path (matches filePathSchema)', () => {
    expect(fsWriteFileArgs.safeParse(['', 'content']).success).toBe(false)
  })

  it('fs:write-file rejects paths containing NUL', () => {
    expect(fsWriteFileArgs.safeParse(['foo\0bar', 'content']).success).toBe(false)
  })

  it('fs:file-tree accepts one arg (dirPath only) — the renderer default', () => {
    const r = fsFileTreeArgs.safeParse(['G:/workspace-code/proj'])
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data[0]).toBe('G:/workspace-code/proj')
      expect(r.data[1]).toBeUndefined()
    }
  })

  it('fs:file-tree accepts explicit depth within bounds', () => {
    expect(fsFileTreeArgs.safeParse(['G:/x', 1]).success).toBe(true)
    expect(fsFileTreeArgs.safeParse(['G:/x', 32]).success).toBe(true)
  })

  it('fs:file-tree rejects depth out of bounds', () => {
    expect(fsFileTreeArgs.safeParse(['G:/x', 0]).success).toBe(false)
    expect(fsFileTreeArgs.safeParse(['G:/x', 999]).success).toBe(false)
    expect(fsFileTreeArgs.safeParse(['G:/x', 1.5]).success).toBe(false)
  })

  it('fs:search accepts the renderer params object', () => {
    const r = fsSearchArgs.safeParse([
      {
        dirPath: 'G:/ws',
        query: 'export',
        maxResults: 100,
        maxMatchesPerFile: 5,
      },
    ])
    expect(r.success).toBe(true)
  })

  it('fs:search tolerates missing optional limits', () => {
    expect(fsSearchArgs.safeParse([{ dirPath: 'G:/ws', query: 'export' }]).success).toBe(true)
  })

  it('fs:search rejects missing dirPath', () => {
    expect(fsSearchArgs.safeParse([{ query: 'export' }]).success).toBe(false)
  })

  it('fs:rename accepts two absolute paths', () => {
    expect(fsRenameArgs.safeParse(['G:/a.txt', 'G:/b.txt']).success).toBe(true)
  })

  it('fs:rename rejects if either arg is missing', () => {
    expect(fsRenameArgs.safeParse(['G:/a.txt']).success).toBe(false)
    expect(fsRenameArgs.safeParse([]).success).toBe(false)
  })

  it('fs:delete / fs:create-dir accept a single path', () => {
    expect(fsDeleteArgs.safeParse(['G:/foo']).success).toBe(true)
    expect(fsCreateDirArgs.safeParse(['G:/foo']).success).toBe(true)
  })

  it('fs:open-dialog accepts zero args (no options) — matches renderer default', () => {
    expect(fsOpenDialogArgs.safeParse([]).success).toBe(true)
    expect(fsOpenDialogArgs.safeParse([undefined]).success).toBe(true)
  })

  it('fs:open-dialog accepts a typical openDirectory options object', () => {
    expect(
      fsOpenDialogArgs.safeParse([
        {
          title: 'Open Folder',
          properties: ['openDirectory'],
          filters: [{ name: 'All', extensions: ['*'] }],
        },
      ]).success,
    ).toBe(true)
  })
})

describe('settings:set schema', () => {
  it('accepts a realistic partial merge patch', () => {
    expect(
      settingsSetArgs.safeParse([
        {
          providerId: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          permissionMode: 'ask',
          prefersReducedMotion: false,
          hooks: [
            { id: 'h1', event: 'PreToolUse', command: 'echo', enabled: true },
          ],
          envVars: [{ id: 'e1', key: 'FOO', value: 'bar', enabled: true }],
        },
      ]).success,
    ).toBe(true)
  })

  it('rejects non-object payload (arrays, primitives, null)', () => {
    expect(settingsSetArgs.safeParse([null]).success).toBe(false)
    expect(settingsSetArgs.safeParse([[{ providerId: 'x' }]]).success).toBe(false)
    expect(settingsSetArgs.safeParse(['a string'] as unknown[]).success).toBe(false)
    expect(settingsSetArgs.safeParse([42] as unknown[]).success).toBe(false)
  })

  it('strips or rejects prototype pollution keys at root', () => {
    // Zod 4 `z.record()` silently strips own `__proto__` during parse, so the
    // payload becomes safe (empty object) and succeeds. That is still the
    // desired outcome for the IPC boundary — the pollution never reaches the
    // handler body. We only assert that the parsed output has no own
    // `__proto__` key.
    const protoResult = settingsSetArgs.safeParse([{ ['__proto__']: { polluted: true } }])
    expect(protoResult.success).toBe(true)
    if (protoResult.success) {
      expect(
        Object.prototype.hasOwnProperty.call(protoResult.data[0], '__proto__'),
      ).toBe(false)
    }

    // `constructor` and `prototype` are not special-cased by Zod; our own
    // refine rejects them outright.
    expect(settingsSetArgs.safeParse([{ constructor: {} }]).success).toBe(false)
    expect(settingsSetArgs.safeParse([{ prototype: {} }]).success).toBe(false)
  })
})

describe('agents:sync-custom schema', () => {
  it('accepts an empty or populated array', () => {
    expect(agentsSyncCustomArgs.safeParse([[]]).success).toBe(true)
    expect(
      agentsSyncCustomArgs.safeParse([
        [
          { name: 'my-agent', description: 'does things', tools: ['Read'] },
        ],
      ]).success,
    ).toBe(true)
  })

  it('rejects non-array payload', () => {
    expect(agentsSyncCustomArgs.safeParse([{ not: 'array' }]).success).toBe(false)
    expect(agentsSyncCustomArgs.safeParse([null]).success).toBe(false)
  })
})

describe('ai:send-message schema', () => {
  it('accepts a minimal valid payload (messages + model)', () => {
    const r = aiSendMessageArgs.safeParse([
      {
        messages: [{ role: 'user', content: 'hi' }],
        model: 'claude-sonnet-4-20250514',
        providerId: 'anthropic',
      },
    ])
    expect(r.success).toBe(true)
  })

  it('accepts rich multimodal content (Anthropic block array) via unknown', () => {
    expect(
      aiSendMessageArgs.safeParse([
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'look at this' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xx' } },
              ],
            },
          ],
          model: 'claude-sonnet-4-20250514',
        },
      ]).success,
    ).toBe(true)
  })

  it('accepts additional unknown keys via passthrough', () => {
    // SendMessageParams has many optional fields (alwaysThinking,
    // permissionRules, hooks, ...). The schema uses `.passthrough()` so that
    // adding a renderer-side field does not require a schema release.
    expect(
      aiSendMessageArgs.safeParse([
        {
          messages: [{ role: 'user', content: 'hi' }],
          model: 'gpt-4o',
          providerId: 'openai',
          alwaysThinking: true,
          injectLspPassiveDiagnostics: 'errors-only',
          permissionRules: [{ tool: 'Bash', rule: 'allow' }],
          hooks: [{ id: 'h', event: 'X', command: 'y', enabled: true }],
          envVars: [],
          userRulesPrompt: 'some rules',
        },
      ]).success,
    ).toBe(true)
  })

  it('rejects missing messages array', () => {
    expect(aiSendMessageArgs.safeParse([{ model: 'x' }]).success).toBe(false)
  })

  it('rejects invalid role in messages', () => {
    expect(
      aiSendMessageArgs.safeParse([
        { messages: [{ role: 'system', content: 'hi' }], model: 'x' },
      ]).success,
    ).toBe(false)
  })
})

describe('ai:cancel / stop-task / retry-task schemas', () => {
  it('ai:cancel accepts zero-arg (global cancel) and optional conversationId', () => {
    expect(aiCancelArgs.safeParse([]).success).toBe(true)
    expect(aiCancelArgs.safeParse(['conv-abc']).success).toBe(true)
    expect(aiCancelArgs.safeParse([undefined]).success).toBe(true)
  })

  it('ai:enqueue-mid-turn-input requires non-empty conversationId and text (M2)', () => {
    expect(
      aiEnqueueMidTurnInputArgs.safeParse([{ conversationId: 'conv-1', text: '改用方案 B' }])
        .success,
    ).toBe(true)
    expect(
      aiEnqueueMidTurnInputArgs.safeParse([{ conversationId: '', text: 'x' }]).success,
    ).toBe(false)
    expect(
      aiEnqueueMidTurnInputArgs.safeParse([{ conversationId: 'conv-1', text: '' }]).success,
    ).toBe(false)
    expect(aiEnqueueMidTurnInputArgs.safeParse([{ conversationId: 'conv-1' }]).success).toBe(false)
  })

  it('ai:stop-task / retry-task require a string taskId', () => {
    expect(aiStopTaskArgs.safeParse(['task-1']).success).toBe(true)
    expect(aiStopTaskArgs.safeParse([]).success).toBe(false)
    expect(aiStopTaskArgs.safeParse([42]).success).toBe(false)
    expect(aiRetryTaskArgs.safeParse(['t']).success).toBe(true)
    expect(aiRetryTaskArgs.safeParse([null]).success).toBe(false)
  })
})

describe('hooks:* fire schemas', () => {
  it('accepts a payload object or nothing', () => {
    expect(hooksFirePayloadArgs.safeParse([{ anything: 'goes' }]).success).toBe(true)
    expect(hooksFirePayloadArgs.safeParse([]).success).toBe(true)
    expect(hooksFirePayloadArgs.safeParse([undefined]).success).toBe(true)
  })

  it('rejects an array payload', () => {
    expect(hooksFirePayloadArgs.safeParse([['x']]).success).toBe(false)
  })
})

describe('terminal:* schemas', () => {
  it('terminal:create accepts optional cwd', () => {
    expect(terminalCreateArgs.safeParse([]).success).toBe(true)
    expect(terminalCreateArgs.safeParse(['G:/workspace']).success).toBe(true)
    expect(terminalCreateArgs.safeParse([42]).success).toBe(false)
  })

  it('terminal:write requires (sessionId:number, data:string)', () => {
    expect(terminalWriteArgs.safeParse([0, 'ls\r']).success).toBe(true)
    expect(terminalWriteArgs.safeParse(['0', 'ls']).success).toBe(false)
    expect(terminalWriteArgs.safeParse([0]).success).toBe(false)
  })

  it('terminal:resize bounds cols/rows', () => {
    expect(terminalResizeArgs.safeParse([1, 80, 24]).success).toBe(true)
    expect(terminalResizeArgs.safeParse([1, 0, 24]).success).toBe(false)
    expect(terminalResizeArgs.safeParse([1, 80, 99_999]).success).toBe(false)
  })

  it('terminal:close requires a sessionId', () => {
    expect(terminalCloseArgs.safeParse([5]).success).toBe(true)
    expect(terminalCloseArgs.safeParse([-1]).success).toBe(false)
    expect(terminalCloseArgs.safeParse([]).success).toBe(false)
  })

  it('terminal:exec accepts command with optional cwd', () => {
    expect(terminalExecArgs.safeParse(['ls']).success).toBe(true)
    expect(terminalExecArgs.safeParse(['ls', 'G:/ws']).success).toBe(true)
    expect(terminalExecArgs.safeParse(['', 'G:/ws']).success).toBe(false)
  })
})

describe('git:* schemas', () => {
  it('git:add accepts literal, undefined, or array', () => {
    expect(gitAddArgs.safeParse(['G:/ws']).success).toBe(true)
    expect(gitAddArgs.safeParse(['G:/ws', 'all']).success).toBe(true)
    expect(gitAddArgs.safeParse(['G:/ws', 'tracked']).success).toBe(true)
    expect(gitAddArgs.safeParse(['G:/ws', ['a.txt', 'b.txt']]).success).toBe(true)
    expect(gitAddArgs.safeParse(['G:/ws', 'nope']).success).toBe(false)
    expect(gitAddArgs.safeParse(['G:/ws', { not: 'array' }]).success).toBe(false)
  })

  it('git:unstage requires a path array', () => {
    expect(gitUnstageArgs.safeParse(['G:/ws', []]).success).toBe(true)
    expect(gitUnstageArgs.safeParse(['G:/ws', ['a.txt']]).success).toBe(true)
    expect(gitUnstageArgs.safeParse(['G:/ws']).success).toBe(false)
    expect(gitUnstageArgs.safeParse(['G:/ws', 'a.txt']).success).toBe(false)
  })

  it('git:commit accepts long message but bounds size', () => {
    expect(gitCommitArgs.safeParse(['G:/ws', 'fix: stuff']).success).toBe(true)
    expect(gitCommitArgs.safeParse(['G:/ws', 'x'.repeat(65_537)]).success).toBe(false)
  })

  it('git:set-identity enforces scope enum', () => {
    expect(gitSetIdentityArgs.safeParse(['G:/ws', 'A', 'a@b', 'local']).success).toBe(true)
    expect(gitSetIdentityArgs.safeParse(['G:/ws', 'A', 'a@b', 'global']).success).toBe(true)
    expect(gitSetIdentityArgs.safeParse(['G:/ws', 'A', 'a@b', 'system']).success).toBe(false)
  })

  it('git:restore enforces mode enum', () => {
    expect(gitRestoreArgs.safeParse(['G:/ws', ['x'], 'worktree']).success).toBe(true)
    expect(gitRestoreArgs.safeParse(['G:/ws', ['x'], 'head']).success).toBe(true)
    expect(gitRestoreArgs.safeParse(['G:/ws', ['x'], 'untracked']).success).toBe(true)
    expect(gitRestoreArgs.safeParse(['G:/ws', ['x'], 'reset']).success).toBe(false)
  })
})

describe('mcp:* schemas', () => {
  it('mcp:connect accepts any payload (deep validation is downstream)', () => {
    expect(mcpConnectArgs.safeParse([{ config: {}, workspacePathHint: 'x' }]).success).toBe(true)
    expect(mcpConnectArgs.safeParse([null]).success).toBe(true)
  })

  it('mcp:disconnect requires a server name', () => {
    expect(mcpDisconnectArgs.safeParse(['my-server']).success).toBe(true)
    expect(mcpDisconnectArgs.safeParse(['my-server', true]).success).toBe(true)
    expect(mcpDisconnectArgs.safeParse(['my-server', false]).success).toBe(true)
    expect(mcpDisconnectArgs.safeParse(['']).success).toBe(false)
    expect(mcpDisconnectArgs.safeParse([]).success).toBe(false)
  })

  it('mcp:reconnect accepts optional nullable workspace hint', () => {
    expect(mcpReconnectArgs.safeParse(['srv']).success).toBe(true)
    expect(mcpReconnectArgs.safeParse(['srv', null]).success).toBe(true)
    expect(mcpReconnectArgs.safeParse(['srv', 'G:/ws']).success).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// memory:* schemas — F3 audit fix
// ──────────────────────────────────────────────────────────────────────────
describe('memory:* schemas', () => {
  describe('memoryGetArgs / memoryDeleteArgs (filename validation)', () => {
    it('accepts a normal workspace-scoped filename', () => {
      expect(memoryGetArgs.safeParse(['my-note.md']).success).toBe(true)
      expect(memoryDeleteArgs.safeParse(['my-note.md']).success).toBe(true)
    })

    it('accepts a user-prefixed filename', () => {
      expect(memoryGetArgs.safeParse(['user:preferences.md']).success).toBe(true)
    })

    it('accepts a memdir-prefixed read-only entry', () => {
      expect(memoryGetArgs.safeParse(['memdir:logs/2026/05/today.md']).success).toBe(true)
    })

    it('rejects empty filename', () => {
      expect(memoryGetArgs.safeParse(['']).success).toBe(false)
    })

    it('rejects parent-traversal payloads', () => {
      expect(memoryGetArgs.safeParse(['../etc/passwd']).success).toBe(false)
      expect(memoryGetArgs.safeParse(['user:../../../etc/passwd']).success).toBe(false)
      expect(memoryGetArgs.safeParse(['memdir:../escape.md']).success).toBe(false)
    })

    it('rejects absolute paths', () => {
      expect(memoryGetArgs.safeParse(['/etc/passwd']).success).toBe(false)
      expect(memoryGetArgs.safeParse(['C:\\Windows\\System32\\config']).success).toBe(false)
      expect(memoryGetArgs.safeParse(['\\\\server\\share']).success).toBe(false)
    })

    it('rejects path separators in non-memdir filenames', () => {
      expect(memoryGetArgs.safeParse(['sub/note.md']).success).toBe(false)
      expect(memoryGetArgs.safeParse(['user:nested/x.md']).success).toBe(false)
    })

    it('rejects NUL bytes', () => {
      expect(memoryGetArgs.safeParse(['name\0.md']).success).toBe(false)
    })

    it('rejects oversize filenames', () => {
      expect(memoryGetArgs.safeParse(['a'.repeat(513)]).success).toBe(false)
    })
  })

  describe('memoryCreateArgs', () => {
    it('accepts a realistic create payload', () => {
      expect(
        memoryCreateArgs.safeParse([
          {
            name: 'user-coding-style',
            description: 'preferred code style',
            type: 'user',
            content: 'Use tabs.',
            scope: 'user',
            enabled: true,
            tags: ['style'],
          },
        ]).success,
      ).toBe(true)
    })

    it('rejects unknown root-level keys (strict)', () => {
      // Note: `__proto__` as an object-literal key is the *prototype setter*
      // syntax, not an own property, so we can't use it here to test
      // strict-mode rejection. The realistic IPC threat vector uses regular
      // unknown keys that an attacker tacks on to the renderer-side payload
      // hoping the main process trusts the shape.
      expect(
        memoryCreateArgs.safeParse([
          {
            name: 'x',
            description: '',
            type: 'project',
            content: 'c',
            extraEvilField: 'sneak',
          },
        ]).success,
      ).toBe(false)
    })

    it('rejects own-property prototype pollution', () => {
      // The realistic vector for __proto__ being an OWN property is
      // JSON.parse('{"__proto__":{"polluted":true}}'). Simulate that here
      // with Object.defineProperty so Zod's strict mode sees it as an
      // unknown own key.
      const polluted: Record<string, unknown> = {
        name: 'x',
        description: '',
        type: 'project',
        content: 'c',
      }
      Object.defineProperty(polluted, '__proto__', {
        value: { polluted: true },
        enumerable: true,
        configurable: true,
        writable: true,
      })
      expect(memoryCreateArgs.safeParse([polluted]).success).toBe(false)
    })

    it('rejects invalid type enum', () => {
      expect(
        memoryCreateArgs.safeParse([
          { name: 'x', description: '', type: 'malicious', content: 'c' },
        ]).success,
      ).toBe(false)
    })

    it('rejects megabyte-scale content payloads beyond the 256KB cap', () => {
      expect(
        memoryCreateArgs.safeParse([
          {
            name: 'big',
            description: '',
            type: 'project',
            content: 'x'.repeat(300_000),
          },
        ]).success,
      ).toBe(false)
    })
  })

  describe('memoryUpdateArgs', () => {
    it('accepts a partial update with just filename + content', () => {
      expect(
        memoryUpdateArgs.safeParse([{ filename: 'note.md', content: 'new body' }]).success,
      ).toBe(true)
    })

    it('still validates the embedded filename', () => {
      expect(
        memoryUpdateArgs.safeParse([{ filename: '../bad.md', content: '' }]).success,
      ).toBe(false)
    })

    it('rejects unknown keys', () => {
      expect(
        memoryUpdateArgs.safeParse([
          { filename: 'note.md', wrongKey: 'oops' },
        ]).success,
      ).toBe(false)
    })
  })

  describe('memorySetWorkspaceArgs', () => {
    it('accepts a string', () => {
      expect(memorySetWorkspaceArgs.safeParse(['G:/workspace-code/proj']).success).toBe(true)
    })

    it('accepts explicit null', () => {
      expect(memorySetWorkspaceArgs.safeParse([null]).success).toBe(true)
    })

    it('rejects NUL', () => {
      expect(memorySetWorkspaceArgs.safeParse(['G:/proj\0evil']).success).toBe(false)
    })
  })

  describe('memoryRecallAiArgs', () => {
    it('accepts a bare userMessage string', () => {
      expect(memoryRecallAiArgs.safeParse(['hello world']).success).toBe(true)
    })

    it('accepts a payload object with userMessage + alreadySurfaced', () => {
      expect(
        memoryRecallAiArgs.safeParse([
          { userMessage: 'hi', alreadySurfaced: ['a.md', 'b.md'] },
        ]).success,
      ).toBe(true)
    })

    it('accepts multimodal content blocks (array)', () => {
      expect(
        memoryRecallAiArgs.safeParse([
          [{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64' } }],
        ]).success,
      ).toBe(true)
    })

    it('rejects unknown keys in payload object', () => {
      expect(
        memoryRecallAiArgs.safeParse([{ userMessage: 'hi', evilKey: 1 }]).success,
      ).toBe(false)
    })

    it('A6: alreadySurfaced[] elements go through the filename schema', () => {
      // Valid filenames pass.
      expect(
        memoryRecallAiArgs.safeParse([
          { userMessage: 'hi', alreadySurfaced: ['note.md', 'user:pref.md', 'memdir:logs/x.md'] },
        ]).success,
      ).toBe(true)
      // Traversal in alreadySurfaced is now rejected.
      expect(
        memoryRecallAiArgs.safeParse([
          { userMessage: 'hi', alreadySurfaced: ['../escape.md'] },
        ]).success,
      ).toBe(false)
      // Absolute paths rejected.
      expect(
        memoryRecallAiArgs.safeParse([
          { userMessage: 'hi', alreadySurfaced: ['/etc/passwd'] },
        ]).success,
      ).toBe(false)
    })
  })

  describe('memoryToggleEnabledArgs', () => {
    it('accepts filename + enabled', () => {
      expect(
        memoryToggleEnabledArgs.safeParse([{ filename: 'note.md', enabled: false }]).success,
      ).toBe(true)
    })

    it('rejects missing enabled', () => {
      expect(memoryToggleEnabledArgs.safeParse([{ filename: 'note.md' }]).success).toBe(false)
    })

    it('rejects bad filename inside the payload', () => {
      expect(
        memoryToggleEnabledArgs.safeParse([{ filename: '../bad', enabled: true }]).success,
      ).toBe(false)
    })
  })

  describe('memoryValidateDirectoryArgs', () => {
    it('accepts any plausible directory string (real validation lives in service)', () => {
      expect(memoryValidateDirectoryArgs.safeParse(['G:/proj/.claude/memory']).success).toBe(true)
    })

    it('rejects NUL', () => {
      expect(memoryValidateDirectoryArgs.safeParse(['G:/proj\0/evil']).success).toBe(false)
    })
  })
})
