import { describe, expect, it } from 'vitest'
import { transcriptStyleRiskHeuristic } from './bashClassifierStage2Heuristics'

describe('bashClassifierStage2Heuristics', () => {
  it('flags posix inline interpreters', () => {
    expect(transcriptStyleRiskHeuristic('python3 -c "1"', 'posix')).toBe(true)
    expect(transcriptStyleRiskHeuristic('node -e "1"', 'posix')).toBe(true)
    expect(transcriptStyleRiskHeuristic('ruby -e "p 1"', 'posix')).toBe(true)
    expect(transcriptStyleRiskHeuristic('perl -e "1"', 'posix')).toBe(true)
    expect(transcriptStyleRiskHeuristic('ls', 'posix')).toBe(false)
  })

  it('flags PowerShell Invoke-Expression / encodedcommand', () => {
    expect(transcriptStyleRiskHeuristic('iex (Get-Content x)', 'powershell')).toBe(true)
    expect(transcriptStyleRiskHeuristic('Invoke-Expression "1"', 'powershell')).toBe(true)
    expect(transcriptStyleRiskHeuristic('Get-ChildItem', 'powershell')).toBe(false)
  })
})
