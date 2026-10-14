import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadSource } from './load-source.mjs'

const { OverlayController, screen, BrowserWindow, powerMonitor } = await loadSource(
  'tests/overlay-entry.ts',
  {
    electron: 'tests/electron-mock.mjs',
  },
)

test(
  'completion expiry holds hovered rows, releases on leave/collapse and never holds closed sessions',
  { skip: process.platform !== 'darwin' },
  (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 })
    let state = {
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
    const controller = new OverlayController({
      getState: () => state,
      publish: (next) => {
        state = next
      },
      createWindow: () => {
        window = new BrowserWindow()
        return window
      },
      openDashboard() {},
      loadPosition: () => null,
      savePosition() {},
    })
    t.after(() => controller.dispose())
    screen.cursor = { x: 0, y: 0 }
    controller.start()
    t.mock.timers.tick(181)

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
  'live sessions control companion visibility, expansion and recovery',
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
    const controller = new OverlayController({
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
      loadPosition: () => null,
      savePosition() {},
    })
    t.after(() => controller.dispose())
    controller.start()
    advance(220)

    assert.equal(windows.length, 0, 'No empty companion or hit region')
    controller.setLiveSessions([{ id: 'codex:real-session' }])
    assert.equal(windows.length, 1, 'A real observation opens the companion')
    const window = windows[0]
    window.emit('ready-to-show')
    assert.equal(state.visible, true)
    assert.equal(window.ignored, false, 'Companion must accept clicks')
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
    assert.equal(state.expanded, false, 'Hover never expands a movable card')
    controller.expand(true)
    screen.cursor = { x: 0, y: 0 }
    advance(1650)
    assert.equal(state.expanded, false, 'Leaving dismisses the expanded companion')
    window.webContents.emit('render-process-gone')
    assert.equal(state.visible, false)
    advance(2100)
    assert.equal(windows.length, 2, 'Live sessions recover after renderer failure')
    windows[1].emit('ready-to-show')
    assert.equal(state.visible, true)
    controller.setLiveSessions([])
    assert.equal(state.visible, false)
    assert.equal(windows[1].ignored, true)
  },
)

test(
  'dragging saves once on release, survives refresh/restart and keeps expansion on-screen',
  { skip: process.platform !== 'darwin' },
  (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 })
    let state
    let window
    let saved = null
    let writes = 0
    let failSave = false
    const create = () => {
      state = {
        geometry: 'loading',
        message: null,
        displays: [],
        anchorId: null,
        expanded: false,
        visible: false,
        actualBounds: null,
        shortcutAvailable: false,
      }
      const controller = new OverlayController({
        getState: () => state,
        publish: (next) => {
          state = next
        },
        createWindow: () => {
          window = new BrowserWindow()
          return window
        },
        openDashboard() {},
        loadPosition: () => saved,
        savePosition: (position) => {
          if (failSave) throw new Error('disk full')
          saved = position
          writes++
        },
      })
      controller.start()
      t.mock.timers.tick(181)

      controller.setLiveSessions([{ id: 'codex:live', status: 'working' }])
      window.emit('ready-to-show')
      return controller
    }
    let controller = create()
    t.after(() => controller.dispose())
    const original = { ...window.bounds }
    screen.cursor = { x: original.x + 20, y: original.y + 20 }
    controller.move('start')
    screen.cursor = { x: original.x - 180, y: original.y - 280 }
    t.mock.timers.tick(32)
    assert.equal(window.bounds.x, original.x - 200)
    assert.equal(writes, 0, 'No disk writes while dragging')
    controller.setLiveSessions([{ id: 'codex:live', status: 'working' }])
    assert.equal(window.bounds.x, original.x - 200, 'Observations cannot snap a drag back')
    controller.move('finish')
    assert.equal(writes, 1)
    const dropped = { ...window.bounds }
    assert.equal(window.focusable, undefined, 'Moving never requests keyboard focus')
    controller.expand(true)
    assert.equal(window.bounds.height, 440)
    assert(window.bounds.x <= dropped.x)
    assert(window.bounds.y <= dropped.y)
    controller.expand(false)
    assert.deepEqual(window.bounds, dropped)
    controller.move('start')
    screen.cursor = { x: -100, y: -100 }
    t.mock.timers.tick(32)
    controller.move('cancel')
    assert.deepEqual(window.bounds, dropped)
    assert.equal(writes, 1, 'Cancellation does not overwrite the saved position')
    controller.dispose()
    controller = create()
    assert.deepEqual(window.bounds, dropped, 'Restart restores the compact position')
    controller.expand(true)
    screen.cursor = { x: window.bounds.x + 20, y: window.bounds.y + 20 }
    controller.move('start')
    screen.cursor = { x: screen.cursor.x + 80, y: screen.cursor.y + 60 }
    controller.move('finish')
    const expandedDrop = { ...window.bounds }
    controller.expand(false)
    const compactAfterExpandedMove = { ...window.bounds }
    assert.notDeepEqual(compactAfterExpandedMove, dropped)
    controller.expand(true)
    assert.deepEqual(window.bounds, expandedDrop, 'Moving the expanded card updates its anchor')
    controller.expand(false)
    controller.move('start')
    powerMonitor.emit('suspend')
    assert.equal(state.visible, false)
    const duringSleep = { ...window.bounds }
    screen.cursor = { x: 30, y: 30 }
    t.mock.timers.tick(500)
    assert.deepEqual(window.bounds, duringSleep, 'Sleep stops the drag timer')
    powerMonitor.emit('resume')
    t.mock.timers.tick(181)

    assert.deepEqual(window.bounds, compactAfterExpandedMove, 'Wake restores the saved anchor')

    failSave = true
    controller.move('left')
    assert.equal(
      window.bounds.x,
      compactAfterExpandedMove.x - 20,
      'Failed persistence does not disable movement',
    )
    assert.match(state.message, /could not be saved/)
    controller.resetPosition()
    t.mock.timers.tick(181)

    assert.deepEqual(window.bounds, original, 'Reset still works when settings cannot be written')
    assert.match(state.message, /could not be saved/)
    failSave = false
    controller.resetPosition()
    t.mock.timers.tick(181)

    assert.deepEqual(window.bounds, original)
    assert.equal(saved, null)
    controller.move('start')
    controller.setLiveSessions([])
    assert.equal(
      state.visible,
      false,
      'Closing all sessions cancels dragging and removes the hit region',
    )
    assert.equal(window.ignored, true)
  },
)

test(
  'dragging across displays clamps the drop and preserves the preferred display across disconnects',
  { skip: process.platform !== 'darwin' },
  (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 })
    const external = {
      id: 2,
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 24, width: 1920, height: 1056 },
      scaleFactor: 1,
      rotation: 0,
    }
    const builtIn = screen.getAllDisplays()[0]
    let displays = [builtIn, external]
    t.mock.method(screen, 'getAllDisplays', () => displays)
    let state = { geometry: 'loading', displays: [], expanded: false, visible: false }
    let saved = null
    let window
    const controller = new OverlayController({
      getState: () => state,
      publish: (next) => {
        state = next
      },
      createWindow: () => {
        window = new BrowserWindow()
        return window
      },
      openDashboard() {},
      loadPosition: () => saved,
      savePosition: (position) => {
        saved = position
      },
    })
    t.after(() => controller.dispose())
    const geometry = () => {
      t.mock.timers.tick(181)
    }
    controller.start()
    geometry()
    controller.setLiveSessions([{ id: 'opencode:live', status: 'working' }])
    window.emit('ready-to-show')
    screen.cursor = { x: window.bounds.x + 20, y: window.bounds.y + 20 }
    controller.move('start')
    screen.cursor = { x: -1900, y: 40 }
    controller.move('finish')
    assert.equal(state.anchorId, 2)
    assert.equal(saved.displayId, 2)
    const dropped = { ...window.bounds }
    assert(dropped.x >= -1908 && dropped.y >= 36)
    controller.expand(true)
    assert(window.bounds.x >= -1920 && window.bounds.x + window.bounds.width <= 0)
    assert(window.bounds.y >= 24 && window.bounds.y + window.bounds.height <= 1080)
    controller.expand(false)
    assert.deepEqual(window.bounds, dropped)
    displays = [builtIn]
    screen.emit('display-removed')
    geometry()
    assert.equal(state.anchorId, 1)
    assert.equal(saved.displayId, 2, 'Fallback does not overwrite the preferred display')
    displays = [builtIn, external]
    screen.emit('display-added')
    geometry()
    assert.deepEqual(window.bounds, dropped)

    // Rotation, scaling and work-area changes must reflow the existing anchor.
    const resized = {
      ...external,
      rotation: 90,
      scaleFactor: 1.5,
      bounds: { x: -720, y: -1280, width: 720, height: 1280 },
      workArea: { x: -680, y: -1256, width: 680, height: 1256 },
    }
    displays = [builtIn, resized]
    screen.emit('display-metrics-changed', {}, resized, [
      'bounds',
      'workArea',
      'scaleFactor',
      'rotation',
    ])
    geometry()
    assert.equal(state.anchorId, 2)
    controller.expand(true)
    assert(window.bounds.x >= -680 && window.bounds.x + window.bounds.width <= 0)
    assert(window.bounds.y >= -1256 && window.bounds.y + window.bounds.height <= 0)

    // Temporary display loss hides the card; retry restores it without a helper process.
    displays = []
    screen.emit('display-removed')
    geometry()
    assert.equal(state.geometry, 'unavailable')
    assert.equal(state.visible, false)
    assert.equal(window.ignored, true)
    displays = [builtIn, external]
    t.mock.timers.tick(2001)
    assert.equal(state.geometry, 'ready')
    assert.equal(state.anchorId, 2)
    controller.expand(false)
    assert.deepEqual(window.bounds, dropped)
  },
)
