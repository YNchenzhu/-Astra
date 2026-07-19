import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyBashCommand,
  classifyBashCommandStage1,
  classifyBashCommandStage2,
  matchesDevCommandWhitelist,
} from './bashClassifier'

describe('bashClassifier', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('stage1: read-only allow -> no match', () => {
    const r = classifyBashCommandStage1('ls -la', 'posix')
    expect(r.matches).toBe(false)
    expect(r.verdict).toBe('allow')
  })

  it('stage1: deny verdict -> match', () => {
    const r = classifyBashCommandStage1('rm -rf /', 'posix')
    expect(r.matches).toBe(true)
    expect(r.verdict).toBe('deny')
  })

  it('stage1: warn verdict -> match (no auto-approve)', () => {
    const r = classifyBashCommandStage1('chmod 777 /tmp/x', 'posix')
    expect(r.matches).toBe(true)
    expect(r.verdict).toBe('warn')
  })

  it('stage1: mutating allow -> match', () => {
    const r = classifyBashCommandStage1('mkdir -p out', 'posix')
    expect(r.matches).toBe(true)
    expect(r.verdict).toBe('allow')
  })

  it('stage2 heuristic flags inline python', async () => {
    const s2 = await classifyBashCommandStage2('python3 -c "print(1)"', 'posix')
    expect(s2.matches).toBe(true)
    const safe = await classifyBashCommandStage2('ls -la', 'posix')
    expect(safe.matches).toBe(false)
  })

  it('classifyBashCommand merges heuristic stage2 by default', async () => {
    const r = await classifyBashCommand('echo hi', 'posix')
    expect(r.matches).toBe(false)
    expect(r.stage2Ran).toBe(true)
  })

  it('classifyBashCommand: auto would prompt — python -c matches stage2', async () => {
    const r = await classifyBashCommand('python3 -c "import sys"', 'posix')
    expect(r.stage2Ran).toBe(true)
    expect(r.matches).toBe(true)
  })

  it('ASTRA_BASH_CLASSIFIER_STAGE2=0 skips stage2 merge', async () => {
    vi.stubEnv('ASTRA_BASH_CLASSIFIER_STAGE2', '0')
    // Use a command that is clean under stage1 on EVERY platform. We can't
    // use `python3` here any more — on Windows it now trips the new
    // cross-platform XP_PYTHON3_ON_WINDOWS warn-level finding from
    // stage1, which is the intended layered defense (see
    // `crossPlatformChecks.ts`). A plain `echo` stays clean on linux,
    // macOS, and Windows alike, so this test isolates stage2's opt-out.
    const r = await classifyBashCommand('echo hello', 'posix')
    expect(r.stage2Ran).toBe(false)
    expect(r.matches).toBe(false)
  })
})

describe('matchesDevCommandWhitelist', () => {
  it('matches npm test', () => {
    expect(matchesDevCommandWhitelist('npm test')).toBe(true)
    expect(matchesDevCommandWhitelist('npm test -- --coverage')).toBe(true)
    expect(matchesDevCommandWhitelist('npm run build')).toBe(true)
    expect(matchesDevCommandWhitelist('npm install')).toBe(true)
    expect(matchesDevCommandWhitelist('npm ci')).toBe(true)
  })

  it('does NOT match dangerous npm commands', () => {
    expect(matchesDevCommandWhitelist('npm publish')).toBe(false)
    expect(matchesDevCommandWhitelist('npm unpublish')).toBe(false)
  })

  it('matches yarn and pnpm', () => {
    expect(matchesDevCommandWhitelist('yarn test')).toBe(true)
    expect(matchesDevCommandWhitelist('yarn build')).toBe(true)
    expect(matchesDevCommandWhitelist('pnpm install')).toBe(true)
    expect(matchesDevCommandWhitelist('pnpm dev')).toBe(true)
  })

  it('matches safe git commands', () => {
    expect(matchesDevCommandWhitelist('git status')).toBe(true)
    expect(matchesDevCommandWhitelist('git diff --staged')).toBe(true)
    expect(matchesDevCommandWhitelist('git add .')).toBe(true)
    expect(matchesDevCommandWhitelist('git commit -m "fix"')).toBe(true)
    expect(matchesDevCommandWhitelist('git log --oneline')).toBe(true)
    expect(matchesDevCommandWhitelist('git branch')).toBe(true)
    expect(matchesDevCommandWhitelist('git stash')).toBe(true)
  })

  it('does NOT match dangerous git commands', () => {
    expect(matchesDevCommandWhitelist('git push')).toBe(false)
    expect(matchesDevCommandWhitelist('git push --force')).toBe(false)
    expect(matchesDevCommandWhitelist('git reset --hard')).toBe(false)
    expect(matchesDevCommandWhitelist('git clean -fd')).toBe(false)
  })

  it('matches cargo and go', () => {
    expect(matchesDevCommandWhitelist('cargo build')).toBe(true)
    expect(matchesDevCommandWhitelist('cargo test')).toBe(true)
    expect(matchesDevCommandWhitelist('cargo check')).toBe(true)
    expect(matchesDevCommandWhitelist('go build ./...')).toBe(true)
    expect(matchesDevCommandWhitelist('go test ./...')).toBe(true)
    expect(matchesDevCommandWhitelist('go vet ./...')).toBe(true)
  })

  it('matches python test tools', () => {
    expect(matchesDevCommandWhitelist('pytest')).toBe(true)
    expect(matchesDevCommandWhitelist('pytest -xvs')).toBe(true)
    expect(matchesDevCommandWhitelist('python -m pytest')).toBe(true)
    expect(matchesDevCommandWhitelist('pip install requests')).toBe(true)
  })

  it('matches common build tools', () => {
    expect(matchesDevCommandWhitelist('make')).toBe(true)
    expect(matchesDevCommandWhitelist('make test')).toBe(true)
    expect(matchesDevCommandWhitelist('npx tsc --noEmit')).toBe(true)
    expect(matchesDevCommandWhitelist('npx eslint .')).toBe(true)
    expect(matchesDevCommandWhitelist('tsc --noEmit')).toBe(true)
    expect(matchesDevCommandWhitelist('eslint .')).toBe(true)
  })

  it('read-only commands: not in whitelist (handled by stage1 isReadOnly)', () => {
    // These are already fast-tracked by stage1's isReadOnly detection —
    // no need to duplicate in the whitelist, which targets mutating dev commands.
    expect(matchesDevCommandWhitelist('ls -la')).toBe(false)
    expect(matchesDevCommandWhitelist('pwd')).toBe(false)
    expect(matchesDevCommandWhitelist('echo hello')).toBe(false)
    expect(matchesDevCommandWhitelist('which node')).toBe(false)
    // docker ps IS in the whitelist (it's a specific development workflow)
    expect(matchesDevCommandWhitelist('docker ps')).toBe(true)
  })

  it('strips env prefix before matching', () => {
    expect(matchesDevCommandWhitelist('CI=true npm test')).toBe(true)
    expect(matchesDevCommandWhitelist('NODE_ENV=test DEBUG=* jest')).toBe(true)
    expect(matchesDevCommandWhitelist('CI=true yarn build')).toBe(true)
  })

  it('classifyBashCommand fast-tracks whitelisted commands', async () => {
    const r = await classifyBashCommand('npm test', 'posix')
    expect(r.matches).toBe(false)
    expect(r.stage2Ran).toBe(false)
  })

  it('classifyBashCommand still classifies non-whitelisted commands', async () => {
    const r = await classifyBashCommand('git push origin main', 'posix')
    // git push is NOT whitelisted, so classifier runs
    expect(r.stage2Ran).toBe(true)
  })
})
