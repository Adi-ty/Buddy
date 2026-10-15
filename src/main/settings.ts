import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { HARNESS_IDS, type HarnessId } from '../shared/harnesses'
import { isCompanionPosition, type CompanionPosition } from '../shared/companion'
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
  get companionPosition(): CompanionPosition | null {
    return isCompanionPosition(this.data.companionPosition)
      ? {
          displayId: this.data.companionPosition.displayId,
          x: this.data.companionPosition.x,
          y: this.data.companionPosition.y,
        }
      : null
  }
  setCompanionPosition(position: CompanionPosition | null): void {
    if (position !== null && !isCompanionPosition(position))
      throw new Error('Invalid companion position')
    this.write({ ...this.data, companionPosition: position })
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
  executable(harness: HarnessId): string | null {
    const paths = this.data.executables
    if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return null
    const value = (paths as Record<string, unknown>)[harness]
    return typeof value === 'string' && isAbsolute(value) && !value.includes('\0') ? value : null
  }
  setExecutable(harness: HarnessId, path: string | null): void {
    if (path !== null && (!isAbsolute(path) || path.includes('\0')))
      throw new Error('Invalid executable path')
    const executables = Object.fromEntries(
      HARNESS_IDS.flatMap((id) => {
        const value = id === harness ? path : this.executable(id)
        return value ? [[id, value]] : []
      }),
    )
    this.write({ ...this.data, executables })
  }
  controlsEnabled(harness: HarnessId): boolean {
    return Array.isArray(this.data.controls) && this.data.controls.includes(harness)
  }
  setControls(harness: HarnessId, enabled: boolean): void {
    const controls = HARNESS_IDS.filter((id) =>
      id === harness ? enabled : this.controlsEnabled(id),
    )
    this.write({ ...this.data, controls })
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
