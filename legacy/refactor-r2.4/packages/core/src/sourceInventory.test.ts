import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  buildSourceInventoryClosureReport,
  listSourceInventoryDomains,
  validateSourceInventoryClosure,
} from './sourceInventory.js'

describe('source inventory closure', () => {
  it('closes the V2.1 support, service, native, and fixture domains in this workspace', () => {
    const report = buildSourceInventoryClosureReport({ cwd: process.cwd() })

    expect(report.fail).toBe(0)
    expect(report.categories.support.fail).toBe(0)
    expect(report.categories.service.fail).toBe(0)
    expect(report.categories.native.fail).toBe(0)
    expect(report.categories.fixture.fail).toBe(0)
  })

  it('lists domains by category', () => {
    const serviceDomains = listSourceInventoryDomains('service')

    expect(serviceDomains.map(domain => domain.id)).toContain('analytics')
    expect(serviceDomains.every(domain => domain.category === 'service')).toBe(true)
  })

  it('reports missing upstream and local evidence for incomplete workspaces', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-source-inventory-'))

    try {
      const failures = validateSourceInventoryClosure({ cwd })

      expect(failures.length).toBeGreaterThan(0)
      expect(failures[0]?.status).toBe('fail')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
