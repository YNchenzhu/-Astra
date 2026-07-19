import { describe, it, expect } from 'vitest'
import { canonicalBuiltinToolName, registryPrimaryToolName } from './builtinToolAliases'

describe('builtinToolAliases', () => {
  it('maps ExitPlanModeV2 to ExitPlanMode registry primary', () => {
    expect(canonicalBuiltinToolName('ExitPlanModeV2')).toBe('ExitPlanMode')
    expect(registryPrimaryToolName('ExitPlanModeV2')).toBe('ExitPlanMode')
  })

  it('maps TaskCreate / TaskGet to themselves (registered names)', () => {
    expect(registryPrimaryToolName('TaskCreate')).toBe('TaskCreate')
    expect(registryPrimaryToolName('TaskGet')).toBe('TaskGet')
  })

  it('maps OC SyntheticOutput name to TaskOutput registry primary (not StructuredOutput)', () => {
    expect(canonicalBuiltinToolName('SyntheticOutput')).toBe('TaskOutput')
    expect(registryPrimaryToolName('SyntheticOutput')).toBe('TaskOutput')
  })
})
