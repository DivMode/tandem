import { describe, expect, it } from 'vitest'
import { selectedTerminalBackendKind } from '../bridge/terminal-backend.ts'

describe('terminal backend selection', () => {
  it('preserves tmux as the upstream default and accepts explicit Herdr', () => {
    expect(selectedTerminalBackendKind(undefined)).toBe('tmux')
    expect(selectedTerminalBackendKind('herdr')).toBe('herdr')
  })

  it('rejects unknown lifecycle backends', () => {
    expect(() => selectedTerminalBackendKind('screen')).toThrow(/tmux.*herdr/)
  })
})
