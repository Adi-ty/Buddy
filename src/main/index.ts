import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, Menu, net, protocol, session } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { DASHBOARD_ROUTES, IPC, PREVIEW_MODES } from '../shared/contracts'
import type { BuddySnapshot, DashboardRoute, OverlayPreviewOptions } from '../shared/contracts'
import { createInitialSnapshot } from './snapshot'
import { OverlayController } from './overlay'

const mainDirectory = dirname(fileURLToPath(import.meta.url))
const rendererDirectory = resolve(mainDirectory, '../renderer')
const rendererURL = 'buddy://app/index.html'
const developmentURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined

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
  window.webContents.on('did-start-loading', () => {
    navigationReady = false
  })
  window.once('ready-to-show', () => {
    if (route) window.show()
    else window.showInactive()
  })
  window.on('closed', () => {
    if (dashboard === window) dashboard = null
  })
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) console.error(`Dashboard failed to load (${code}): ${description} ${url}`)
  })

  if (developmentURL) void window.loadURL(developmentURL)
  else void window.loadURL(rendererURL)
}

function createOverlayWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: 'Buddy overlay preview',
    width: 320,
    height: 60,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    type: 'panel',
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
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
  void window.loadURL(`${developmentURL ?? rendererURL}#overlay`)
  return window
}

function installMenu(): void {
  const pages = ['Sessions', 'History', 'Integrations', 'Overlay preview']
  const navigation: MenuItemConstructorOptions[] = DASHBOARD_ROUTES.filter(
    (route) => snapshot.runtime.overlayPreviewEnabled || route !== '/overlay-preview',
  ).map((route, index) => ({
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
          ...(snapshot.runtime.overlayPreviewEnabled
            ? [
                {
                  label: 'Toggle overlay preview',
                  accelerator: 'CmdOrCtrl+Alt+O',
                  click: () =>
                    overlay?.configure({
                      mode: snapshot.overlay.mode === 'idle' ? 'running' : 'idle',
                      displayId: snapshot.overlay.displayId,
                      clickThrough: snapshot.overlay.clickThrough,
                    }),
                },
                {
                  label: 'Preview attention request',
                  accelerator: 'CmdOrCtrl+Alt+P',
                  click: () =>
                    overlay?.configure({
                      mode: 'attention',
                      displayId: snapshot.overlay.displayId,
                      clickThrough: snapshot.overlay.clickThrough,
                    }),
                },
              ]
            : []),
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
    createDashboard()
    dashboard?.focus()
  })

  void app
    .whenReady()
    .then(() => {
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
      overlay = new OverlayController(
        {
          getState: () => snapshot.overlay,
          publish: (state) => {
            snapshot = { ...snapshot, revision: snapshot.revision + 1, overlay: state }
            for (const window of trustedWindows)
              if (!window.isDestroyed() && isTrustedPage(window.webContents.getURL()))
                window.webContents.send(IPC.updated, snapshot)
          },
          createWindow: createOverlayWindow,
          openDashboard: () =>
            createDashboard(
              snapshot.runtime.overlayPreviewEnabled && snapshot.overlay.mode !== 'idle'
                ? '/overlay-preview'
                : '/sessions',
            ),
        },
        mainDirectory,
      )
      ipcMain.handle(IPC.overlayPreview, (event, ...args: unknown[]) => {
        trustedRequest(event, true)
        const value = args[0] as Partial<OverlayPreviewOptions> | undefined
        if (
          !snapshot.runtime.overlayPreviewEnabled ||
          args.length !== 1 ||
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          !PREVIEW_MODES.includes(value.mode!) ||
          typeof value.clickThrough !== 'boolean' ||
          (value.displayId !== null &&
            !snapshot.overlay.displays.some((display) => display.id === value.displayId))
        )
          throw new Error('Invalid overlay preview request')
        overlay?.configure(value as OverlayPreviewOptions)
      })
      ipcMain.handle(IPC.refreshDisplays, (event, ...args: unknown[]) => {
        trustedRequest(event, true)
        if (!snapshot.runtime.overlayPreviewEnabled || args.length)
          throw new Error('Invalid display refresh request')
        overlay?.refresh()
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
        createDashboard(
          snapshot.runtime.overlayPreviewEnabled && snapshot.overlay.mode !== 'idle'
            ? '/overlay-preview'
            : '/sessions',
        )
      })
      installMenu()
      createDashboard()
      overlay.start()
      app.on('activate', () => createDashboard('/sessions'))
      app.once('will-quit', () => overlay?.dispose())
    })
    .catch((error: unknown) => {
      console.error('Buddy failed to start', error)
      app.exit(1)
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
