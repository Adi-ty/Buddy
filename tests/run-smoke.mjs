import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import electron from 'electron'

const artifacts = resolve('.cache/smoke')
mkdirSync(artifacts, { recursive: true })
const profile = mkdtempSync(join(artifacts, 'profile-'))

try {
  const result = spawnSync(electron, ['tests/smoke.cjs'], {
    stdio: 'inherit',
    env: { ...process.env, BUDDY_SMOKE_PROFILE: profile },
    timeout: 120_000,
    killSignal: 'SIGKILL',
  })
  if (result.error) throw result.error
  assert.equal(result.signal, null, `Electron terminated with ${result.signal}`)
  assert.equal(result.status, 0, 'Electron smoke checks failed')

  // Electron and Chromium may still write during will-quit. Check persistence
  // and remove their profile only after the Electron process has exited.
  const durable = readFileSync(join(profile, 'sessions.json'), 'utf8')
  assert.equal(
    JSON.parse(durable).records.find((record) => record.id === 'codex:quit-flush')?.status,
    'working',
    'Normal quit must flush pending session state',
  )
  assert(!durable.includes('echo smoke fixture'), 'Approval details are memory-only')
  rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  console.log('PASS: normal quit flushes pending session state; temporary profile removed')
} catch (error) {
  console.error(error)
  console.error(`Smoke profile retained: ${profile}`)
  process.exitCode = 1
}
