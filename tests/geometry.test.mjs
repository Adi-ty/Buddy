import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadSource } from './load-source.mjs'

const {
  parseNativeDisplays,
  matchDisplays,
  companionBounds,
  companionPosition,
  companionDisplay,
  safeActualBounds,
} = await loadSource('tests/geometry-entry.ts')
const native = {
  id: 1,
  uuid: 'built-in-display',
  name: 'Built-in Retina',
  builtIn: true,
  frame: { x: 0, y: 0, width: 1512, height: 982 },
  visibleFrame: { x: 0, y: 24, width: 1512, height: 920 },
  backingScaleFactor: 2,
  safeAreaInsets: { top: 38, left: 0, bottom: 0, right: 0 },
  auxiliaryLeft: { x: 0, y: 944, width: 650, height: 38 },
  auxiliaryRight: { x: 862, y: 944, width: 650, height: 38 },
}
const electron = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 38, width: 1512, height: 920 },
  scaleFactor: 2,
  rotation: 0,
}
const parse = (displays, version = 1) => parseNativeDisplays(JSON.stringify({ version, displays }))

test('Retina geometry uses logical points and keeps both compact and expanded overlays clear of the camera and menu bar', () => {
  const [display] = matchDisplays(parse([native]), [electron])
  assert.equal(display.uuid, native.uuid)
  assert.deepEqual(display.camera, { x: 650, y: 0, width: 212, height: 38 })
  assert.deepEqual(display.auxiliaryLeft, { x: 0, y: 0, width: 650, height: 38 })
  for (const expanded of [false, true]) {
    const bounds = companionBounds(display, expanded)
    assert(bounds)
    assert.equal(bounds.x + bounds.width, electron.workArea.width - 12)
    assert(bounds.y >= electron.workArea.y)
    assert(safeActualBounds(display, bounds))
    assert(!safeActualBounds(display, { ...bounds, y: 0 }))
    assert(!safeActualBounds(display, { ...bounds, x: -100 }))
  }
})

test('native Y conversion follows display identity across negative origins and different desktop arrangements', () => {
  const relocated = {
    ...native,
    frame: { ...native.frame, x: -1512, y: 1080 },
    visibleFrame: { ...native.visibleFrame, x: -1512, y: 1104 },
    auxiliaryLeft: { ...native.auxiliaryLeft, x: -1512, y: 2024 },
    auxiliaryRight: { ...native.auxiliaryRight, x: -650, y: 2024 },
  }
  const matched = {
    ...electron,
    bounds: { ...electron.bounds, x: -1512, y: -982 },
    workArea: { ...electron.workArea, x: -1512, y: -944 },
  }
  const [display] = matchDisplays(parse([relocated]), [{ ...electron, id: 99 }, matched])
  assert.deepEqual(display.camera, { x: -862, y: -982, width: 212, height: 38 })
  assert.deepEqual(display.auxiliaryRight, { x: -650, y: -982, width: 650, height: 38 })
  assert(safeActualBounds(display, companionBounds(display, true)))
})

test('screens without a camera use the work area; cramped displays decline an unsafe overlay', () => {
  const ordinary = {
    ...native,
    builtIn: false,
    backingScaleFactor: 1,
    safeAreaInsets: { top: 0, left: 0, bottom: 0, right: 0 },
  }
  delete ordinary.auxiliaryLeft
  delete ordinary.auxiliaryRight
  const [display] = matchDisplays(parse([ordinary]), [{ ...electron, scaleFactor: 1 }])
  assert.equal(display.camera, null)
  assert(safeActualBounds(display, companionBounds(display, false)))
  assert.equal(
    companionBounds({ ...display, workArea: { ...display.workArea, width: 280 } }, false),
    null,
  )
  assert.equal(
    companionBounds({ ...display, workArea: { ...display.workArea, height: 240 } }, true),
    null,
  )
})

test('ambiguous display matches and malformed native snapshots fail closed', () => {
  for (const candidate of [
    { ...electron, id: 2 },
    { ...electron, rotation: 90 },
    { ...electron, scaleFactor: 1 },
    { ...electron, bounds: { ...electron.bounds, width: 3024 } },
    { ...electron, workArea: { ...electron.workArea, x: -100 } },
  ])
    assert.deepEqual(matchDisplays(parse([native]), [candidate]), [])
  for (const changed of [
    { ...native, auxiliaryRight: undefined },
    { ...native, safeAreaInsets: { ...native.safeAreaInsets, top: 900 } },
    { ...native, auxiliaryLeft: { ...native.auxiliaryLeft, width: 1000 } },
  ])
    assert.deepEqual(matchDisplays(parse([changed]), [electron]), [])
  assert.throws(() => parseNativeDisplays('{broken'))
  assert.throws(() => parse([native], 2))
  for (const displays of [
    [],
    [native, native],
    [{ ...native, id: 0 }],
    [{ ...native, frame: { ...native.frame, height: 0 } }],
    [{ ...native, safeAreaInsets: { ...native.safeAreaInsets, top: -1 } }],
  ])
    assert.throws(() => parse(displays))
})

test('expansion grows inward at every edge and retains the compact anchor across scaling', () => {
  const [display] = matchDisplays(parse([native]), [electron])
  for (const x of [0, 0.25, 0.5, 0.75, 1]) {
    for (const y of [0, 0.25, 0.5, 0.75, 1]) {
      const position = { x, y }
      const compact = companionBounds(display, false, position)
      const expanded = companionBounds(display, true, position)
      assert(safeActualBounds(display, compact))
      assert(safeActualBounds(display, expanded))
      assert(expanded.x <= compact.x && expanded.y <= compact.y)
      assert(expanded.x + expanded.width >= compact.x + compact.width)
      assert(expanded.y + expanded.height >= compact.y + compact.height)
      const saved = companionPosition(display, compact)
      assert.deepEqual(companionBounds(display, false, saved), compact)
      const scaled = {
        ...display,
        camera: { ...display.camera, y: -700 },
        bounds: { x: -1000, y: -700, width: 1000, height: 700 },
        workArea: { x: -960, y: -662, width: 960, height: 638 },
      }
      assert(safeActualBounds(scaled, companionBounds(scaled, true, saved)))
    }
  }
  const short = { ...display, workArea: { ...display.workArea, height: 300 } }
  const expanded = companionBounds(short, true)
  assert.equal(expanded.height, 276, 'Small screens get a scrollable, shorter panel')
  assert(safeActualBounds(short, expanded))
})

test('saved display identity survives ID changes and disconnected displays fall back', () => {
  const [display] = matchDisplays(parse([native]), [electron])
  const saved = companionPosition(display, companionBounds(display, false))
  const reconnected = { ...display, id: 99 }
  assert.equal(companionDisplay([reconnected], saved), reconnected)
  const external = { ...display, id: 2, uuid: 'external', builtIn: false }
  assert.equal(companionDisplay([external], saved), external)
  assert.equal(companionDisplay([], saved), undefined)
  const clamped = companionPosition(display, { x: -9000, y: 9000, width: 320, height: 60 })
  assert.equal(clamped.x, 0)
  assert.equal(clamped.y, 1)
})
