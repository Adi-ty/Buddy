import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadSource } from './load-source.mjs'

const { OverlayController, screen, BrowserWindow, requests } = await loadSource(
  'tests/overlay-entry.ts',
  {
    electron: 'tests/electron-mock.mjs',
    'node:child_process': 'tests/process-mock.mjs',
  },
)
const native = JSON.stringify({
  version: 1,
  displays: [
    {
      id: 1,
      name: 'Built-in',
      builtIn: true,
      frame: { x: 0, y: 0, width: 1512, height: 982 },
      visibleFrame: { x: 0, y: 24, width: 1512, height: 920 },
      backingScaleFactor: 2,
      safeAreaInsets: { top: 38, left: 0, bottom: 0, right: 0 },
      auxiliaryLeft: { x: 0, y: 944, width: 650, height: 38 },
      auxiliaryRight: { x: 862, y: 944, width: 650, height: 38 },
    },
  ],
})

test(
  'completion expiry holds hovered rows, releases on leave/collapse and never holds closed sessions',
  { skip: process.platform !== 'darwin' },
  (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 })
    let state = {
      displayId: null,
      geometry: 'loading',
      message: null,
      displays: [],
      anchorId: null,
      expanded: false,
      visible: false,
      actualBounds: null,
      shortcutAvailable: false,
    }
    let window
    const controller = new OverlayController(
      {
        getState: () => state,
        publish: (next) => {
          state = next
        },
        createWindow: () => {
          window = new BrowserWindow()
          return window
        },
        openDashboard() {},
      },
      '/project/out/main',
    )
    t.after(() => controller.dispose())
    screen.cursor = { x: 0, y: 0 }
    controller.start()
    t.mock.timers.tick(181)
    requests.at(-1).callback(null, native)
    const done = () => ({ id: 'codex:done', status: 'completed', statusChangedAt: Date.now() })
    controller.setLiveSessions([done()])
    window.emit('ready-to-show')
    screen.cursor = { x: window.bounds.x + 10, y: window.bounds.y + 10 }
    controller.expand(true)
    t.mock.timers.tick(12_001)
    assert.equal(state.visible, true)
    assert.equal(state.expanded, true)
    assert.deepEqual(state.completionHoldIds, ['codex:done'])
    screen.cursor = { x: 0, y: 0 }
    t.mock.timers.tick(201)
    t.mock.timers.tick(1400)
    assert.equal(state.visible, false)
    assert.equal(state.expanded, false)
    assert.deepEqual(state.completionHoldIds, [])
    assert.equal(window.ignored, true)
    // An explicit collapse dismisses an expired row even while still hovered.
    controller.setLiveSessions([done()])
    screen.cursor = { x: window.bounds.x + 10, y: window.bounds.y + 10 }
    controller.expand(true)
    t.mock.timers.tick(12_001)
    controller.expand(false)
    assert.equal(state.visible, false)
    // Focused input also holds the row with the pointer elsewhere, but closure
    // still wins; no empty focused/click-blocking window can remain.
    controller.setLiveSessions([done()])
    controller.expand(true)
    controller.setInputActive(true)
    screen.cursor = { x: 0, y: 0 }
    t.mock.timers.tick(12_001)
    assert.equal(state.visible, true)
    controller.setLiveSessions([])
    assert.equal(state.visible, false)
    assert.equal(window.focusable, false)
    assert.deepEqual(state.completionHoldIds, [])
  },
)

test(
  'live sessions control notch visibility, expansion and recovery',
  { skip: process.platform !== 'darwin' },
  (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 })
    // Tick in polling-sized steps so Date advances between interval callbacks.
    const advance = (ms) => {
      while (ms > 0) {
        const step = Math.min(ms, 100)
        t.mock.timers.tick(step)
        ms -= step
      }
    }
    let state = {
      displayId: null,
      geometry: 'loading',
      message: null,
      displays: [],
      anchorId: null,
      expanded: false,
      visible: false,
      actualBounds: null,
      shortcutAvailable: false,
    }
    const windows = []
    const controller = new OverlayController(
      {
        getState: () => state,
        publish: (next) => {
          state = next
        },
        createWindow: () => {
          const window = new BrowserWindow()
          windows.push(window)
          return window
        },
        openDashboard() {},
      },
      '/project/out/main',
    )
    t.after(() => controller.dispose())
    controller.start()
    advance(220)
    requests.at(-1).callback(null, native)
    assert.equal(windows.length, 0, 'No empty notch or hit region')
    controller.setLiveSessions([{ id: 'codex:real-session' }])
    assert.equal(windows.length, 1, 'A real observation opens the notch')
    const window = windows[0]
    window.emit('ready-to-show')
    assert.equal(state.visible, true)
    assert.equal(window.ignored, false, 'Notch must accept clicks')
    controller.expand(true)
    assert.equal(state.expanded, true)
    assert.equal(window.bounds.height, 440)
    controller.expand(false)
    screen.cursor = { x: window.bounds.x + 10, y: window.bounds.y + 10 }
    advance(800)
    assert.equal(state.expanded, false, 'Collapse must stay closed while pointer remains inside')
    screen.cursor = { x: 0, y: 0 }
    advance(250)
    screen.cursor = { x: window.bounds.x + 10, y: window.bounds.y + 10 }
    advance(850)
    assert.equal(state.expanded, true, 'Hover expands after reentering')
    screen.cursor = { x: 0, y: 0 }
    advance(1650)
    assert.equal(state.expanded, false, 'Leaving dismisses the expanded notch')
    window.webContents.emit('render-process-gone')
    assert.equal(state.visible, false)
    advance(2100)
    assert.equal(windows.length, 2, 'Live sessions recover after renderer failure')
    windows[1].emit('ready-to-show')
    assert.equal(state.visible, true)
    state = {
      ...state,
      displays: [
        ...state.displays,
        {
          ...state.displays[0],
          id: 2,
          name: 'External display',
          builtIn: false,
          camera: null,
          auxiliaryLeft: null,
          auxiliaryRight: null,
          safeTop: 0,
          bounds: { x: 2000, y: 0, width: 1920, height: 1080 },
          workArea: { x: 2000, y: 24, width: 1920, height: 1056 },
        },
      ],
    }
    controller.configure({ displayId: 2 })
    assert.equal(state.anchorId, 2)
    assert(windows[1].bounds.x >= 2000, 'Choosing another display moves the native window')
    controller.configure({ displayId: null })
    assert.equal(state.anchorId, 1, 'Automatic returns to the built-in notch')
    controller.configure({ displayId: 999 })
    assert.equal(state.anchorId, 1)
    assert(
      state.message.includes('disconnected'),
      'A missing pinned display falls back with feedback',
    )
    controller.setLiveSessions([])
    assert.equal(state.visible, false)
    assert.equal(windows[1].ignored, true)
  },
)
