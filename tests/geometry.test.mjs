import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadSource } from './load-source.mjs'

const { parseNativeDisplays, matchDisplays, shelfBounds, safeActualBounds } =
  await loadSource('tests/geometry-entry.ts')
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
    const bounds = shelfBounds(display, expanded)
    assert(bounds)
    assert.equal(bounds.x + bounds.width / 2, 756)
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
  assert(safeActualBounds(display, shelfBounds(display, true)))
})

test('screens without a notch use the work area; cramped displays decline an unsafe overlay', () => {
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
  assert(safeActualBounds(display, shelfBounds(display, false)))
  assert.equal(
    shelfBounds({ ...display, workArea: { ...display.workArea, width: 280 } }, false),
    null,
  )
  assert.equal(
    shelfBounds({ ...display, workArea: { ...display.workArea, height: 300 } }, true),
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
