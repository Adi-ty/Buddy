import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  nativeImage,
  protocol,
  session,
  Tray,
  powerMonitor,
  shell,
  clipboard,
} from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { DASHBOARD_ROUTES, IPC } from '../shared/contracts'
import { COMPANION_MOVES, type CompanionMove } from '../shared/companion'
import { isHarnessId } from '../shared/harnesses'
import type { BuddySnapshot, DashboardRoute, HarnessId } from '../shared/contracts'
import { createInitialSnapshot } from './snapshot'
import { OverlayController } from './overlay'
import { SessionStore } from './tracking/store'
import { SessionNames } from './tracking/session-names'
import { ObservationBridge } from './tracking/bridge'
import { RequestBridge } from './tracking/requests'
import { CodexAppServer } from './tracking/codex-app-server'
import { normalizeObservation, type Observation } from './tracking/events'
import { IntegrationManager, integrationAssets } from './tracking/integrations'
import { ProfileSettings } from './settings'
import { SessionNotifications } from './notifications'
import { performSessionAction } from './session-actions'
import { sessionFamilies } from '../shared/session-families'
import { runTask } from './tasks'
import { observeWake } from './tracking/wake'

const mainDirectory = dirname(fileURLToPath(import.meta.url))
const rendererDirectory = resolve(mainDirectory, '../renderer')
const rendererURL = 'buddy://app/index.html'
const developmentURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const resourceDirectory = app.isPackaged
  ? process.resourcesPath
  : resolve(mainDirectory, '../../resources')
const appIconPath = join(resourceDirectory, 'buddy-brand.png')

app.setName('Buddy')
protocol.registerSchemesAsPrivileged([
  { scheme: 'buddy', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

// Development profiles live with the checkout and never share release data.
if (!app.isPackaged) {
  const profile = resolve(mainDirectory, '../../.cache/buddy-dev')
  mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
}

let dashboard: BrowserWindow | null = null
let overlay: OverlayController | null = null
let tray: Tray | null = null
let store: SessionStore | null = null
let bridge: ObservationBridge | null = null
let requests: RequestBridge | null = null
let codexServer: CodexAppServer | null = null
let integrations: IntegrationManager | null = null
let settings: ProfileSettings | null = null
let notifications: SessionNotifications | null = null
let lastDetection = 0
let expiryTimer: ReturnType<typeof setInterval> | null = null
let stopWake: (() => void) | null = null
let publishTimer: ReturnType<typeof setTimeout> | null = null
let broadcastTimer: ReturnType<typeof setTimeout> | null = null
let setupBusy = false
let names: SessionNames | null = null
let openOnReady = process.argv.includes('--dashboard')
let navigationReady = false
let pendingRoute: DashboardRoute | null = null
const trustedWindows = new Set<BrowserWindow>()

function isTrustedPage(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.search !== '' || (parsed.hash !== '' && parsed.hash !== '#overlay')) return false
    if (developmentURL) {
      const expected = new URL(developmentURL)
      return parsed.origin === expected.origin && parsed.pathname === '/'
    }
    return (
      parsed.protocol === 'buddy:' && parsed.host === 'app' && parsed.pathname === '/index.html'
    )
  } catch {
    return false
  }
}

function installRendererSecurity(): void {
  const devOrigin = developmentURL ? new URL(developmentURL).origin : ''
  const devSocket = devOrigin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  const policy = [
    "default-src 'none'",
    `script-src 'self'${developmentURL ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${developmentURL ? ` ${devSocket}` : ''}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ')

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, respond) =>
    respond(false),
  )
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.webRequest.onHeadersReceived((details, respond) => {
    respond({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })

  protocol.handle('buddy', async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app') return new Response('Not found', { status: 404 })
    let filePath: string
    try {
      filePath = resolve(rendererDirectory, `.${decodeURIComponent(url.pathname)}`)
    } catch {
      return new Response('Invalid path', { status: 400 })
    }
    const withinRoot = relative(rendererDirectory, filePath)
    if (withinRoot.startsWith('..') || isAbsolute(withinRoot)) {
      return new Response('Not found', { status: 404 })
    }
    try {
      return await net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function secureWindow(window: BrowserWindow): void {
  trustedWindows.add(window)
  window.on('closed', () => trustedWindows.delete(window))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedPage(url)) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
}

function createDashboard(route?: DashboardRoute): void {
  if (route) pendingRoute = route
  if (dashboard && !dashboard.isDestroyed()) {
    if (navigationReady && pendingRoute) {
      dashboard.webContents.send(IPC.navigate, pendingRoute)
      pendingRoute = null
    }
    dashboard.show()
    dashboard.focus()
    return
  }

  const window = new BrowserWindow({
    title: 'Buddy',
    icon: appIconPath,
    width: 1160,
    height: 780,
    minWidth: 860,
    minHeight: 620,
    show: false,
    backgroundColor: '#171818',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 22, y: 22 },
    webPreferences: {
      preload: join(mainDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  })
  dashboard = window
  navigationReady = false
  secureWindow(window)
  window.on('focus', () => {
    if (Date.now() - lastDetection < 30_000 || setupBusy) return
    setupBusy = true
    void refreshIntegrations()
      .catch((error) => console.error('CLI refresh failed', error))
      .finally(() => {
        setupBusy = false
      })
  })
  window.webContents.on('did-start-loading', () => {
    navigationReady = false
  })
  window.once('ready-to-show', () => {
    window.show()
    window.focus()
  })
  window.on('closed', () => {
    if (dashboard === window) dashboard = null
  })
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) console.error(`Dashboard failed to load (${code}): ${description} ${url}`)
  })

  void window
    .loadURL(developmentURL ?? rendererURL)
    .catch((error) => console.error('Dashboard load failed', error))
}

function createOverlayWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: 'Buddy sessions',
    width: 320,
    height: 60,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    type: 'panel',
    acceptFirstMouse: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false, // Main moves the window from a captured pointer; native dragging stays disabled.
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    roundedCorners: false,
    hiddenInMissionControl: true,
    webPreferences: {
      preload: join(mainDirectory, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  })
  secureWindow(window)
  window.setAlwaysOnTop(true, 'floating')
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })
  window.setIgnoreMouseEvents(true, { forward: true })
  void window
    .loadURL(`${developmentURL ?? rendererURL}#overlay`)
    .catch((error) => console.error('Companion load failed', error))
  return window
}

function installMenu(): void {
  const pages = ['Sessions', 'History', 'Integrations', 'Settings']
  const navigation: MenuItemConstructorOptions[] = DASHBOARD_ROUTES.map((route, index) => ({
    label: pages[index],
    accelerator: `CmdOrCtrl+${index + 1}`,
    click: () => {
      createDashboard(route)
    },
  }))

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Buddy',
        submenu: [
          {
            label: 'Open dashboard',
            accelerator: 'CmdOrCtrl+0',
            click: () => createDashboard('/sessions'),
          },
          { type: 'separator' },
          { role: 'services' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          ...navigation,
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
}

let snapshot: BuddySnapshot

function broadcast(): void {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    runTask('Snapshot broadcast', broadcastNow)
  }, 100)
}

function broadcastNow(): void {
  if (broadcastTimer) clearTimeout(broadcastTimer)
  broadcastTimer = null
  snapshot = { ...snapshot, revision: snapshot.revision + 1 }
  for (const window of trustedWindows)
    if (!window.isDestroyed() && isTrustedPage(window.webContents.getURL()))
      window.webContents.send(IPC.updated, snapshot)
  const families = sessionFamilies(snapshot.sessions, [...snapshot.sessions, ...snapshot.history])
  const attention = families.filter((item) => item.summary.status === 'needs-attention').length
  tray?.setToolTip(
    `Buddy · ${families.length} observed sessions${attention ? ` · ${attention} need attention` : ''}`,
  )
  tray?.setTitle(attention ? ` ${attention}` : '')
}

function scheduleSessions(): void {
  if (publishTimer) return
  publishTimer = setTimeout(() => {
    publishTimer = null
    runTask('Session publish', publishSessions)
  }, 100)
}

function observeSession(event: Observation): void {
  requests?.observeTool(event)
  const before = store?.get(`${event.harness}:${event.sessionId}`) ?? null
  if (store?.apply(event)) {
    notifications?.observe(before, store.get(`${event.harness}:${event.sessionId}`))
    scheduleSessions()
  } else if (store?.message) scheduleSessions()
}

function publishSessions(): void {
  if (!store) return
  const records = store.snapshot(false)
  requests?.reconcile(records.sessions)
  const pending = [...(requests?.snapshot() ?? []), ...(codexServer?.snapshot() ?? [])]
  const sessions = records.sessions.map((record) => {
    const input = pending.filter((p) => p.sessionId === record.id)
    return input.length
      ? {
          ...record,
          status: 'needs-attention' as const,
          statusChangedAt: Math.min(...input.map((p) => p.createdAt)),
          attention: [
            ...record.attention.filter((a) => !input.some((p) => p.id === a.id)),
            ...input.map((p) => ({ id: p.id, kind: p.kind, tool: p.tool })),
          ],
        }
      : record
  })
  notifications?.reconcileObserved(sessions)
  snapshot = {
    ...snapshot,
    ...records,
    preferences: {
      desktopNotifications: settings?.desktopNotifications ?? true,
      launchAtLogin: app.isPackaged && app.getLoginItemSettings().openAtLogin,
      canLaunchAtLogin: app.isPackaged,
    },
    sessions,
    requests: pending,
    coverage: records.sessions.length || records.history.length ? 'partial' : 'not-connected',
    tracking: {
      available: store.message === null,
      phase: store.message ? 'paused' : 'running',
      message: store.message,
      droppedObservations: store.droppedObservations,
      capacityEvictions: store.capacityEvictions,
    },
  }
  snapshot = {
    ...snapshot,
    harnesses: snapshot.harnesses.map((entry) => {
      const observed = [...records.sessions, ...records.history].filter(
        (record) => record.harness === entry.id,
      )
      const recent = records.sessions.some((record) => record.harness === entry.id)
      return {
        ...entry,
        ...(entry.id === 'codex' ? codexServer?.state() : {}),
        lastEventAt: store?.lastEventAt(entry.id),
        connection: recent
          ? 'observed'
          : entry.observer === 'installed'
            ? observed.length
              ? 'stale'
              : 'configured'
            : 'not-connected',
      }
    }),
  }
  overlay?.setLiveSessions(sessions, [...sessions, ...records.history])
  broadcast()
}

async function refreshIntegrations(): Promise<void> {
  if (!integrations) return
  lastDetection = Date.now()
  const harnesses = await integrations.refresh(snapshot.harnesses)
  // Keep display/session updates received while CLI detection was in flight.
  snapshot = { ...snapshot, harnesses }
  const codex = harnesses.find((entry) => entry.id === 'codex')
  codexServer?.configure(!!codex?.controls && codex.observer === 'installed')
  publishSessions()
  if (!store) broadcast()
}

function installTray(): void {
  // Matching Template/@2x names let Electron load the Retina representation.
  const icon = nativeImage.createFromPath(join(resourceDirectory, 'buddyTrayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  const showMenu = (): void => {
    const families = sessionFamilies(snapshot.sessions, [...snapshot.sessions, ...snapshot.history])
    const observed = families.length
    const working = families.filter((item) => item.summary.status === 'working').length
    const subagents = snapshot.sessions.filter((item) => item.parentId).length
    tray?.popUpContextMenu(
      Menu.buildFromTemplate([
        {
          label: `${observed} observed sessions · ${working} working${subagents ? ` · ${subagents} subagents` : ''}`,
          enabled: false,
        },
        {
          label:
            snapshot.tracking.phase === 'starting'
              ? 'Starting local observation…'
              : snapshot.tracking.phase === 'paused'
                ? 'Observation paused — storage unavailable'
                : snapshot.tracking.available
                  ? 'Local observation running'
                  : 'Tracking unavailable — open Integrations',
          enabled: false,
        },
        { type: 'separator' },
        { label: 'Open dashboard', click: () => createDashboard('/sessions') },
        { label: 'Integrations', click: () => createDashboard('/integrations') },
        {
          label: 'Reset companion position',
          click: () => runTask('Reset companion position', () => overlay?.resetPosition()),
        },
        { type: 'separator' },
        {
          label: 'Desktop notifications',
          type: 'checkbox',
          checked: settings?.desktopNotifications ?? true,
          click: (item) => {
            try {
              settings?.setDesktopNotifications(item.checked)
              if (!item.checked) notifications?.reset()
              publishSessions()
            } catch (error) {
              console.error('Notification setting could not be saved', error)
            }
          },
        },
        {
          label: 'Launch at login',
          type: 'checkbox',
          enabled: app.isPackaged,
          checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
          click: (item) => {
            if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: item.checked })
            publishSessions()
          },
        },
        { label: 'Quit Buddy', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ]),
    )
  }
  tray.on('click', showMenu)
  tray.on('right-click', showMenu)
  tray.setToolTip('Buddy · starting local observation')
}

function trustedRequest(
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
  dashboardOnly = false,
): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (
    !window ||
    !trustedWindows.has(window) ||
    (dashboardOnly && window !== dashboard) ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedPage(event.senderFrame.url)
  ) {
    throw new Error('Untrusted Buddy request')
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (snapshot) createDashboard('/sessions')
    else openOnReady = true
  })

  void app
    .whenReady()
    .then(async () => {
      snapshot = createInitialSnapshot()
      installRendererSecurity()
      ipcMain.on(IPC.navigationReady, (event, ...args: unknown[]) => {
        try {
          trustedRequest(event, true)
          if (args.length) return
          navigationReady = true
          if (pendingRoute) {
            event.sender.send(IPC.navigate, pendingRoute)
            pendingRoute = null
          }
        } catch {
          /* Ignore untrusted or obsolete renderer handshakes. */
        }
      })
      ipcMain.handle(IPC.snapshot, (event, ...args: unknown[]) => {
        trustedRequest(event)
        if (args.length !== 0) throw new Error('Invalid snapshot request')
        return snapshot
      })
      overlay = new OverlayController({
        getState: () => snapshot.overlay,
        publish: (state) => {
          snapshot = { ...snapshot, overlay: state }
          broadcast()
        },
        createWindow: createOverlayWindow,
        openDashboard: () => createDashboard('/sessions'),
        loadPosition: () => settings?.companionPosition ?? null,
        savePosition: (position) => {
          settings?.setCompanionPosition(position)
        },
      })
      ipcMain.handle(IPC.moveCompanion, (event, ...args: unknown[]) => {
        trustedRequest(event)
        if (
          BrowserWindow.fromWebContents(event.sender) === dashboard ||
          args.length !== 1 ||
          !COMPANION_MOVES.includes(args[0] as CompanionMove)
        )
          throw new Error('Invalid companion movement request')
        overlay?.move(args[0] as CompanionMove)
      })
      ipcMain.handle(IPC.resetCompanionPosition, (event, ...args: unknown[]) => {
        trustedRequest(event, true)
        if (args.length) throw new Error('Invalid position reset request')
        overlay?.resetPosition()
      })
      ipcMain.handle(IPC.overlayExpanded, (event, ...args: unknown[]) => {
        trustedRequest(event)
        if (args.length !== 1 || typeof args[0] !== 'boolean')
          throw new Error('Invalid overlay expansion request')
        overlay?.expand(args[0])
      })
      ipcMain.handle(IPC.openDashboard, (event, ...args: unknown[]) => {
        trustedRequest(event)
        if (args.length) throw new Error('Invalid dashboard request')
        createDashboard('/sessions')
      })
      for (const [channel, install] of [
        [IPC.installIntegration, true],
        [IPC.removeIntegration, false],
      ] as const) {
        ipcMain.handle(channel, async (event, ...args: unknown[]) => {
          trustedRequest(event, true)
          if (
            (args.length !== 1 &&
              !(install && args.length === 2 && typeof args[1] === 'boolean')) ||
            !isHarnessId(args[0])
          )
            throw new Error('Invalid harness')
          if (!snapshot.tracking.available || !integrations)
            throw new Error('Local observation is unavailable')
          if (setupBusy) throw new Error('Another integration operation is in progress')
          setupBusy = true
          try {
            if (install) await integrations.install(args[0] as HarnessId, args[1] === true)
            else integrations.remove(args[0] as HarnessId)
            if (!install) {
              requests?.cancel(args[0] as HarnessId)
              if (args[0] === 'codex') codexServer?.configure(false)
            }
            await refreshIntegrations()
          } finally {
            setupBusy = false
          }
        })
      }
      ipcMain.handle(IPC.refreshIntegrations, async (event, ...args: unknown[]) => {
        trustedRequest(event, true)
        if (args.length) throw new Error('Invalid refresh request')
        if (setupBusy) throw new Error('Another integration operation is in progress')
        setupBusy = true
        try {
          await refreshIntegrations()
        } finally {
          setupBusy = false
        }
      })
      ipcMain.handle(IPC.sessionAction, (event, ...args: unknown[]) => {
        trustedRequest(event, true)
        if (args.length !== 2) throw new Error('Invalid session action')
        performSessionAction(store, args[0], args[1], {
          writeText: (text) => clipboard.writeText(text),
          showItemInFolder: (path) => shell.showItemInFolder(path),
        })
      })
      ipcMain.handle(IPC.sessionAvatar, (event, ...args: unknown[]) => {
        trustedRequest(event)
        if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length > 256)
          throw new Error('Invalid avatar request')
        const avatar = store?.get(args[0])?.dataUri
        if (!avatar) throw new Error('Session is no longer available')
        return avatar
      })
      ipcMain.handle(IPC.preference, (event, ...args: unknown[]) => {
        trustedRequest(event, true)
        const [key, enabled] = args
        if (args.length !== 2 || typeof enabled !== 'boolean' || !settings)
          throw new Error('Invalid preference')
        if (key === 'desktopNotifications') {
          settings.setDesktopNotifications(enabled)
          if (!enabled) notifications?.reset()
        } else if (key === 'launchAtLogin' && app.isPackaged) {
          app.setLoginItemSettings({ openAtLogin: enabled })
        } else throw new Error('This preference is unavailable in this build')
        publishSessions()
      })
      ipcMain.handle(IPC.integrationControls, async (event, ...args: unknown[]) => {
        trustedRequest(event, true)
        if (args.length !== 2 || !isHarnessId(args[0]) || typeof args[1] !== 'boolean')
          throw new Error('Invalid controls setting')
        if (setupBusy || !integrations || !requests || !snapshot.tracking.available)
          throw new Error('Integrations are busy or unavailable. Try again.')
        setupBusy = true
        try {
          await integrations.setControls(args[0], args[1])
          if (!args[1]) {
            requests.cancel(args[0])
            if (args[0] === 'codex') codexServer?.configure(false)
          }
          await refreshIntegrations()
        } finally {
          setupBusy = false
        }
      })
      ipcMain.handle(IPC.respondToRequest, async (event, ...args: unknown[]) => {
        trustedRequest(event)
        if (args.length !== 2 || !requests || !snapshot.tracking.available)
          throw new Error('Agent replies are unavailable.')
        if (codexServer?.owns(args[0])) await codexServer.respond(args[0], args[1])
        else await requests.respond(args[0], args[1])
      })
      ipcMain.handle(IPC.overlayInput, (event, ...args: unknown[]) => {
        trustedRequest(event)
        if (
          event.sender === dashboard?.webContents ||
          args.length !== 1 ||
          typeof args[0] !== 'boolean'
        )
          throw new Error('Invalid companion input request')
        overlay?.setInputActive(args[0])
      })
      ipcMain.handle(IPC.clearHistory, (event, ...args: unknown[]) => {
        trustedRequest(event, true)
        if (args.length) throw new Error('Invalid history request')
        if (!store || !snapshot.tracking.available)
          throw new Error('Session history is unavailable')
        store.clearHistory()
        publishSessions()
      })
      installMenu()
      if (process.platform === 'darwin') {
        app.dock?.setIcon(appIconPath)
        app.dock?.hide()
      }
      installTray()
      const profile = app.getPath('userData')
      settings = new ProfileSettings(join(profile, 'settings.json'))
      overlay.start()
      notifications = new SessionNotifications(
        () => settings?.desktopNotifications ?? true,
        () => createDashboard('/sessions'),
      )
      integrations = new IntegrationManager(
        profile,
        integrationAssets(mainDirectory, app.isPackaged),
        !app.isPackaged,
        settings,
      )
      try {
        names = new SessionNames()
        store = new SessionStore(
          join(profile, 'sessions.json'),
          (harness, id, cwd) => names?.lookup(harness, id, cwd) ?? null,
          { flushDelayMs: 200, onPersistenceError: () => scheduleSessions() },
        )
        bridge = new ObservationBridge(profile, (event) => {
          try {
            observeSession(event)
          } catch (error) {
            console.error('Session persistence failed', error)
            publishSessions()
            throw error
          }
        })
        await bridge.start()
        requests = new RequestBridge(
          profile,
          (harness) => settings?.controlsEnabled(harness) ?? false,
          scheduleSessions,
          (context) => {
            if (!store || store.message) throw new Error('Tracking is unavailable')
            if (context.harness === 'opencode') return // Real plugin activity establishes presence.
            const event = normalizeObservation({
              version: 1,
              id: `control-${context.sourceId}`,
              harness: context.harness,
              sessionId: context.providerId,
              turnId: context.turnId,
              event: 'PermissionRequest',
              tool: context.tool,
              cwd: context.cwd,
              at: Date.now(),
            })
            if (event) {
              const before = store.get(`${context.harness}:${context.providerId}`)
              if (store.apply(event)) {
                const current = store.get(`${context.harness}:${context.providerId}`)
                if (current)
                  notifications?.observe(before, {
                    ...current,
                    status: 'needs-attention',
                    attention: [
                      ...current.attention,
                      { id: context.sourceId, kind: context.kind, tool: context.tool },
                    ],
                  })
              }
            }
          },
          (context, decision) => {
            if (decision !== 'native' && context.harness !== 'opencode')
              store?.resolveControlAttention(
                `${context.harness}:${context.providerId}`,
                context.sourceId,
                context.tool,
                context.turnId,
                decision === 'allow',
              )
          },
        )
        await requests.start()
        codexServer = new CodexAppServer({
          changed: scheduleSessions,
          observed: observeSession,
          resolved: (id, requestId, tool, turnId, allowed) =>
            store?.resolveControlAttention(id, requestId, tool, turnId, allowed),
        })
        publishSessions()
        expiryTimer = setInterval(() => {
          try {
            const recovered = store?.retryPersistence()
            const expired = store?.expire()
            const renamed = store?.refreshNames()
            if (recovered || expired || renamed) publishSessions()
          } catch {
            /* Keep last durable state visible. */
          }
        }, 15_000)
        stopWake = observeWake(powerMonitor, store, publishSessions)
      } catch (error) {
        console.error('Local tracking failed to start', error)
        bridge?.dispose()
        requests?.dispose()
        codexServer?.dispose()
        codexServer = null
        requests = null
        bridge = null
        store = null
        snapshot = {
          ...snapshot,
          tracking: {
            available: false,
            phase: 'unavailable',
            message:
              'Local tracking could not start. Existing data was preserved. Quit Buddy and check its data directory.',
          },
        }
        broadcast()
      }
      await refreshIntegrations()
      if (openOnReady) createDashboard('/sessions')
      app.on('activate', () => createDashboard('/sessions'))
      app.once('will-quit', () => {
        if (expiryTimer) clearInterval(expiryTimer)
        if (publishTimer) clearTimeout(publishTimer)
        if (broadcastTimer) clearTimeout(broadcastTimer)
        bridge?.dispose()
        requests?.dispose()
        codexServer?.dispose()
        store?.dispose()
        names?.dispose()
        notifications?.reset()
        stopWake?.()
        overlay?.dispose()
        tray?.destroy()
      })
    })
    .catch((error: unknown) => {
      console.error('Buddy failed to start', error)
      app.exit(1)
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
