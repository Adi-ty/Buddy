import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { HARNESS_IDS, type HarnessId } from '../shared/harnesses'
import { isCliVersion } from './versions'

export class ProfileSettings {
  private data: Record<string, unknown> = {}
  private damaged = false
  constructor(private readonly path: string) {
    try {
      if (!existsSync(path)) return
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid settings')
      this.data = value as Record<string, unknown>
    } catch {
      this.damaged = true
      console.error('Buddy settings are unreadable; using defaults and preserving the file')
    }
  }
  get desktopNotifications(): boolean {
    return this.data.desktopNotifications !== false
  }
  allowedVersion(harness: HarnessId): string | null {
    const versions = this.data.unverifiedVersions
    if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return null
    const value = (versions as Record<string, unknown>)[harness]
    return isCliVersion(value) ? value : null
  }
  setDesktopNotifications(enabled: boolean): void {
    this.write({ ...this.data, desktopNotifications: enabled })
  }
  allowVersion(harness: HarnessId, version: string): void {
    if (!isCliVersion(version)) throw new Error('Invalid CLI version')
    const versions = Object.fromEntries(
      HARNESS_IDS.flatMap((id) => (this.allowedVersion(id) ? [[id, this.allowedVersion(id)]] : [])),
    )
    this.write({ ...this.data, unverifiedVersions: { ...versions, [harness]: version } })
  }
  private write(data: Record<string, unknown>): void {
    if (this.damaged)
      throw new Error('Buddy settings are unreadable; existing settings were left unchanged')
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temporary, this.path)
    this.data = data
  }
}
