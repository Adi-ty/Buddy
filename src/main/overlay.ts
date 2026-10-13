import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, powerMonitor, screen } from 'electron'
import type { OverlayOptions, OverlayState, SessionRecord } from '../shared/contracts'
import {
  matchDisplays,
  parseNativeDisplays,
  safeActualBounds,
  shelfBounds,
} from './display-geometry'
import { COMPLETION_NOTICE_MS, notchRecords } from '../shared/sessions'
import { runTask } from './tasks'
import { compactNotchBounds } from '../shared/overlay-layout'

interface OverlayHost {
  getState(): OverlayState
  publish(state: OverlayState): void
  createWindow(): BrowserWindow
  openDashboard(): void
}

export class OverlayController {
  private window: BrowserWindow | null = null
  private ready = false
  private suspended = false
  private disposed = false
  private generation = 0
  private failures = 0
  private rendererFailures = 0
  private debounce: ReturnType<typeof setTimeout> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private probe: AbortController | null = null
  private polling: ReturnType<typeof setInterval> | null = null
  private leavingAt: number | null = null
  private sessions: readonly SessionRecord[] = []
  private context: readonly SessionRecord[] = []
  private displayedIds = new Set<string>()
  private inputActive = false
  private completionTimer: ReturnType<typeof setTimeout> | null = null
  private readonly onDisplayChange = (): void => this.invalidate()
  private readonly onSuspend = (): void => {
    this.suspended = true
    this.generation++
    this.probe?.abort()
    this.clearTimers()
    this.hide()
    this.update({
      geometry: 'suspended',
      message: 'Display placement paused while your Mac is asleep or locked.',
    })
  }
  private readonly onResume = (): void => {
    this.suspended = false
    this.failures = 0
    this.invalidate()
  }

  constructor(
    private readonly host: OverlayHost,
    private readonly mainDirectory: string,
  ) {}

  private task(action: () => void): void {
    runTask('Notch update', action, () => {
      this.hide()
      this.update({
        geometry: 'unavailable',
        message: 'The notch could not update. Refresh display placement from Buddy’s menu.',
      })
    })
  }

  start(): void {
    if (process.platform !== 'darwin') {
      this.update({
        geometry: 'unavailable',
        message: 'The session notch requires macOS.',
      })
      return
    }
    screen.on('display-added', this.onDisplayChange)
    screen.on('display-removed', this.onDisplayChange)
    screen.on('display-metrics-changed', this.onDisplayChange)
    powerMonitor.on('suspend', this.onSuspend)
    powerMonitor.on('lock-screen', this.onSuspend)
    powerMonitor.on('resume', this.onResume)
    powerMonitor.on('unlock-screen', this.onResume)
    this.update({
      shortcutAvailable: globalShortcut.register('CommandOrControl+Shift+Space', () =>
        this.host.openDashboard(),
      ),
    })
    this.invalidate()
  }

  private update(changes: Partial<OverlayState>): void {
    this.host.publish({ ...this.host.getState(), ...changes })
  }

  configure(options: OverlayOptions): void {
    this.rendererFailures = 0
    this.update({ ...options, expanded: false })
    this.apply()
  }

  setLiveSessions(
    sessions: readonly SessionRecord[],
    context: readonly SessionRecord[] = sessions,
  ): void {
    this.sessions = sessions
    this.context = context
    if (this.completionTimer) clearTimeout(this.completionTimer)
    this.completionTimer = null
    const state = this.host.getState()
    const fresh = notchRecords(sessions, Date.now(), context)
    const freshIds = new Set(fresh.map((item) => item.id))
    const completionHoldIds =
      state.visible && (this.inputActive || this.pointerInside())
        ? sessions
            .filter(
              (item) =>
                item.status === 'completed' &&
                this.displayedIds.has(item.id) &&
                !freshIds.has(item.id),
            )
            .map((item) => item.id)
        : []
    if (completionHoldIds.join('|') !== (state.completionHoldIds ?? []).join('|'))
      this.update({ completionHoldIds })
    this.displayedIds = new Set([...freshIds, ...completionHoldIds])
    const deadlines = sessions
      .filter((item) => item.status === 'completed')
      .map((item) => item.statusChangedAt + COMPLETION_NOTICE_MS)
      .filter((at) => at > Date.now())
    if (deadlines.length)
      this.completionTimer = setTimeout(
        () => this.task(() => this.setLiveSessions(this.sessions, this.context)),
        Math.min(...deadlines) - Date.now() + 1,
      )
    if (!this.displayedIds.size && this.host.getState().expanded) this.update({ expanded: false })
    this.apply()
  }

  setInputActive(enabled: boolean): void {
    if (
      !this.window ||
      this.window.isDestroyed() ||
      (enabled && (!this.host.getState().expanded || !this.host.getState().visible))
    )
      return
    this.inputActive = enabled
    this.window.setFocusable(enabled)
    if (enabled) this.window.focus()
    else this.window.blur()
    this.leavingAt = null
  }

  expand(expanded: boolean): void {
    if (!this.sessions.length) return
    if (!expanded && this.inputActive) this.setInputActive(false)
    this.update({ expanded, ...(!expanded ? { completionHoldIds: [] } : {}) })
    if (!expanded)
      this.displayedIds = new Set(
        notchRecords(this.sessions, Date.now(), this.context).map((item) => item.id),
      )
    this.leavingAt = null
    this.apply()
  }

  refresh(): void {
    this.failures = 0
    this.rendererFailures = 0
    this.invalidate()
  }

  private invalidate(): void {
    if (this.disposed || this.suspended) return
    this.generation++
    this.probe?.abort()
    this.hide()
    this.update({ geometry: 'loading', displays: [], anchorId: null, message: null })
    if (this.debounce) clearTimeout(this.debounce)
    if (this.retry) clearTimeout(this.retry)
    this.debounce = setTimeout(() => {
      this.debounce = null
      this.task(() => this.readDisplays(this.generation))
    }, 180)
  }

  private readDisplays(generation: number): void {
    const executable = app.isPackaged
      ? join(process.resourcesPath, 'native/buddy-display')
      : join(this.mainDirectory, '../native/buddy-display')
    this.probe = new AbortController()
    execFile(
      executable,
      ['--snapshot'],
      { timeout: 2500, maxBuffer: 128 * 1024, encoding: 'utf8', signal: this.probe.signal },
      (error, stdout) => {
        if (generation !== this.generation || this.disposed || this.suspended) return
        this.probe = null
        try {
          if (error) throw error
          const displays = matchDisplays(parseNativeDisplays(stdout), screen.getAllDisplays())
          if (!displays.length) throw new Error('No coherent native/Electron display match')
          this.failures = 0
          this.update({ displays, geometry: 'ready', message: null })
          this.apply()
        } catch (error) {
          console.error('Native display probe failed', error)
          this.hide()
          this.update({
            geometry: 'unavailable',
            displays: [],
            anchorId: null,
            message:
              'Native display information is unavailable. The overlay is hidden; refresh to retry.',
          })
          if (++this.failures <= 3)
            this.retry = setTimeout(
              () => {
                this.retry = null
                this.task(() => this.readDisplays(this.generation))
              },
              1000 * 2 ** this.failures,
            )
        }
      },
    )
  }

  private apply(): void {
    const state = this.host.getState()
    if (
      this.suspended ||
      this.disposed ||
      this.rendererFailures >= 3 ||
      !notchRecords(this.sessions, Date.now(), this.context, state.completionHoldIds).length ||
      state.geometry !== 'ready'
    ) {
      this.hide()
      return
    }
    const selected =
      state.displayId === null
        ? null
        : state.displays.find((display) => display.id === state.displayId)
    const anchor =
      selected ??
      state.displays.find((display) => display.builtIn && display.camera) ??
      state.displays.find((display) => display.builtIn) ??
      state.displays[0]
    if (!anchor) {
      this.hide()
      return
    }
    const bounds = shelfBounds(anchor, state.expanded)
    if (!bounds) {
      this.hide()
      this.update({ message: 'The selected display has insufficient room for this overlay.' })
      return
    }
    if (!this.window || this.window.isDestroyed()) {
      if (this.retry && this.rendererFailures) return
      const window = this.host.createWindow()
      window.on('blur', () => {
        this.inputActive = false
        if (!window.isDestroyed()) window.setFocusable(false)
        this.leavingAt = null
      })
      this.window = window
      this.ready = false
      window.once('ready-to-show', () => {
        this.ready = true
        this.apply()
      })
      const rendererFailed = () => {
        window.destroy()
        this.window = null
        this.ready = false
        this.rendererFailures++
        this.update({
          expanded: false,
          visible: false,
          actualBounds: null,
          message:
            this.rendererFailures < 3
              ? 'Overlay renderer stopped. Reopening after recovery.'
              : 'Overlay renderer repeatedly stopped. Refresh display placement from Buddy’s menu to retry.',
        })
        if (this.sessions.length && this.rendererFailures < 3) {
          this.retry = setTimeout(
            () => {
              this.retry = null
              this.task(() => this.apply())
            },
            1000 * 2 ** this.rendererFailures,
          )
        }
      }
      window.webContents.on('render-process-gone', rendererFailed)
      window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3 && !window.isDestroyed()) rendererFailed()
      })
    }
    const wings = !state.expanded && compactNotchBounds(anchor)
    this.window.setAlwaysOnTop(true, wings ? 'status' : 'floating')
    this.window.setBounds(bounds, false)
    if (this.ready && safeActualBounds(anchor, this.window.getBounds(), state.expanded))
      this.window.showInactive()
    // AppKit may constrain the frame when the previously hidden window is shown.
    const actual = this.window.getBounds()
    if (!safeActualBounds(anchor, actual, state.expanded)) {
      this.hide()
      this.update({
        anchorId: anchor.id,
        message: 'macOS constrained the window outside its safe region. The overlay is hidden.',
      })
      return
    }
    this.window.setIgnoreMouseEvents(false)
    this.update({
      anchorId: anchor.id,
      actualBounds: actual,
      visible: this.ready,
      message:
        selected || state.displayId === null
          ? null
          : 'Selected display disconnected. Using an available display.',
    })
    if (!this.polling && this.ready)
      this.polling = setInterval(() => this.task(() => this.checkPointer()), 200)
  }

  private checkPointer(): void {
    const state = this.host.getState()
    if (!this.window || !state.visible) return
    const inside = this.pointerInside()
    if (!state.expanded) {
      if (!inside) {
        if (state.completionHoldIds?.length) this.setLiveSessions(this.sessions, this.context)
      }
      return
    }
    if (inside || this.inputActive) this.leavingAt = null
    else if (this.leavingAt === null) this.leavingAt = Date.now()
    else if (Date.now() - this.leavingAt > 1200) this.expand(false)
  }

  private pointerInside(): boolean {
    if (!this.window || this.window.isDestroyed()) return false
    const bounds = this.window.getBounds()
    const point = screen.getCursorScreenPoint()
    const state = this.host.getState()
    const camera = state.displays.find((display) => display.id === state.anchorId)?.camera
    if (
      !state.expanded &&
      camera &&
      point.x >= camera.x &&
      point.x < camera.x + camera.width &&
      point.y >= camera.y &&
      point.y < camera.y + camera.height
    )
      return false
    return (
      point.x >= bounds.x &&
      point.x < bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y < bounds.y + bounds.height
    )
  }

  private hide(): void {
    if (this.inputActive) this.setInputActive(false)
    if (this.polling) clearInterval(this.polling)
    this.polling = null
    this.leavingAt = null
    this.displayedIds.clear()
    if (this.window && !this.window.isDestroyed()) {
      this.window.setIgnoreMouseEvents(true, { forward: true })
      this.window.hide()
    }
    if (this.host.getState().visible || this.host.getState().actualBounds)
      this.update({ visible: false, actualBounds: null, completionHoldIds: [] })
  }

  private clearTimers(): void {
    if (this.debounce) clearTimeout(this.debounce)
    if (this.retry) clearTimeout(this.retry)
    this.debounce = null
    this.retry = null
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.probe?.abort()
    this.clearTimers()
    if (this.completionTimer) clearTimeout(this.completionTimer)
    this.hide()
    this.window?.destroy()
    globalShortcut.unregister('CommandOrControl+Shift+Space')
    screen.removeListener('display-added', this.onDisplayChange)
    screen.removeListener('display-removed', this.onDisplayChange)
    screen.removeListener('display-metrics-changed', this.onDisplayChange)
    powerMonitor.removeListener('suspend', this.onSuspend)
    powerMonitor.removeListener('lock-screen', this.onSuspend)
    powerMonitor.removeListener('resume', this.onResume)
    powerMonitor.removeListener('unlock-screen', this.onResume)
  }
}
