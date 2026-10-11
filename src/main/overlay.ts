import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, powerMonitor, screen } from 'electron'
import type { OverlayPreviewOptions, OverlayState, PreviewSession } from '../shared/contracts'
import { createAvatarPreviews } from './avatars'
import {
  matchDisplays,
  parseNativeDisplays,
  safeActualBounds,
  shelfBounds,
} from './display-geometry'

interface OverlayHost {
  getState(): OverlayState
  publish(state: OverlayState): void
  createWindow(): BrowserWindow
  openDashboard(): void
}

function createPreviewSessions(): PreviewSession[] {
  const names = ['Tobo', 'Mira', 'Juno', 'Rex', 'Pip', 'Nova', 'Lumi', 'Otto']
  const projects = ['buddy', 'web-client', 'api', 'docs']
  return names.map((name, index) => {
    const avatar = createAvatarPreviews()[index % 3]!
    return {
      ...avatar,
      id: `preview-${index}`,
      name,
      project: projects[index % 4]!,
      status: index % 3 === 2 ? 'waiting' : 'working',
    }
  })
}

// Geometry and all native window operations stay in main. Preview records never
// enter the canonical session/history arrays or change any agent configuration.
export class OverlayController {
  private window: BrowserWindow | null = null
  private ready = false
  private suspended = false
  private disposed = false
  private generation = 0
  private failures = 0
  private debounce: ReturnType<typeof setTimeout> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private probe: AbortController | null = null
  private polling: ReturnType<typeof setInterval> | null = null
  private leavingAt: number | null = null
  private readonly previews = createPreviewSessions()
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

  start(): void {
    if (process.platform !== 'darwin') {
      this.update({
        geometry: 'unavailable',
        message: 'The native overlay prototype requires macOS.',
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

  configure(options: OverlayPreviewOptions): void {
    const sessions =
      options.mode === 'idle'
        ? []
        : this.previews.slice(0, options.mode === 'overflow' ? 8 : 3).map((session, index) => ({
            ...session,
            status:
              options.mode === 'attention' && index === 0
                ? ('needs-attention' as const)
                : session.status,
          }))
    this.update({
      ...options,
      previewSessions: sessions,
      expanded: false,
      message: this.host.getState().geometry === 'ready' ? null : this.host.getState().message,
    })
    this.apply()
  }

  expand(expanded: boolean): void {
    if (this.host.getState().mode === 'idle' || this.host.getState().clickThrough) return
    this.update({ expanded })
    this.leavingAt = null
    this.apply()
  }

  refresh(): void {
    this.failures = 0
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
      this.readDisplays(this.generation)
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
                this.readDisplays(this.generation)
              },
              1000 * 2 ** this.failures,
            )
        }
      },
    )
  }

  private apply(): void {
    const state = this.host.getState()
    if (this.suspended || this.disposed || state.mode === 'idle' || state.geometry !== 'ready') {
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
      const window = this.host.createWindow()
      this.window = window
      this.ready = false
      window.once('ready-to-show', () => {
        this.ready = true
        this.apply()
      })
      window.webContents.on('render-process-gone', () => {
        window.destroy()
        this.window = null
        this.ready = false
        this.configure({
          mode: 'idle',
          displayId: this.host.getState().displayId,
          clickThrough: this.host.getState().clickThrough,
        })
        this.update({ message: 'Overlay renderer stopped. Choose a preview to reopen it.' })
      })
    }
    this.window.setBounds(bounds, false)
    const actual = this.window.getBounds()
    if (!safeActualBounds(anchor, actual)) {
      this.hide()
      this.update({
        anchorId: anchor.id,
        message: 'macOS constrained the window outside its safe region. The overlay is hidden.',
      })
      return
    }
    this.window.setIgnoreMouseEvents(state.clickThrough, { forward: true })
    if (this.ready) this.window.showInactive()
    this.update({
      anchorId: anchor.id,
      actualBounds: actual,
      visible: this.ready,
      message:
        selected || state.displayId === null
          ? null
          : 'Selected display disconnected. Using an available display.',
    })
    if (!this.polling && this.ready) this.polling = setInterval(() => this.checkPointer(), 200)
  }

  private checkPointer(): void {
    const state = this.host.getState()
    if (!state.expanded || !this.window || !state.visible || state.clickThrough) return
    const bounds = this.window.getBounds()
    const point = screen.getCursorScreenPoint()
    const inside =
      point.x >= bounds.x &&
      point.x < bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y < bounds.y + bounds.height
    if (inside) this.leavingAt = null
    else if (this.leavingAt === null) this.leavingAt = Date.now()
    else if (Date.now() - this.leavingAt > 1200) this.expand(false)
  }

  private hide(): void {
    if (this.polling) clearInterval(this.polling)
    this.polling = null
    this.leavingAt = null
    if (this.window && !this.window.isDestroyed()) {
      this.window.setIgnoreMouseEvents(true, { forward: true })
      this.window.hide()
    }
    if (this.host.getState().visible || this.host.getState().actualBounds)
      this.update({ visible: false, actualBounds: null })
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
