import { describe, it, expect } from 'vitest'
import {
  shellExecutionToolInDefinitions,
  shellExecutionToolInModelListing,
} from './schema'

describe('shellExecutionToolInDefinitions', () => {
  it('is false without shell tools', () => {
    expect(shellExecutionToolInDefinitions([{ name: 'Read' }, { name: 'Grep' }])).toBe(
      false,
    )
  })

  it('is true when Bash is listed', () => {
    expect(shellExecutionToolInDefinitions([{ name: 'Read' }, { name: 'Bash' }])).toBe(
      true,
    )
  })

  it('is true when PowerShell is listed', () => {
    expect(
      shellExecutionToolInDefinitions([{ name: 'PowerShell' }]),
    ).toBe(true)
  })
})

describe('shellExecutionToolInModelListing', () => {
  it('is false when Bash and PowerShell are denied for listing', () => {
    expect(
      shellExecutionToolInModelListing([
        { id: 'a', pattern: 'Bash', mode: 'deny' },
        { id: 'b', pattern: 'PowerShell', mode: 'deny' },
      ]),
    ).toBe(false)
  })
})
