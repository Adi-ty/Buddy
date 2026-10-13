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

test('compact wings fit beside the camera within 320 points; expanded content stays below the menu', () => {
  const [display] = matchDisplays(parse([native]), [electron])
  assert.equal(display.uuid, native.uuid)
  assert.deepEqual(display.camera, { x: 650, y: 0, width: 212, height: 38 })
  assert.deepEqual(display.auxiliaryLeft, { x: 0, y: 0, width: 650, height: 38 })
  const compact = shelfBounds(display, false)
  assert.deepEqual(compact, { x: 596, y: 0, width: 320, height: 38 })
  assert(safeActualBounds(display, compact, false))
  assert(!safeActualBounds(display, { ...compact, y: 38 }, false), 'Reject OS-clamped placement')
  assert(
    !safeActualBounds(display, { ...compact, x: compact.x + 2 }, false),
    'Reject misaligned camera gap',
  )
  const expanded = shelfBounds(display, true)
  assert.equal(expanded.x + expanded.width / 2, 756)
  assert(expanded.y >= electron.workArea.y)
  assert(safeActualBounds(display, expanded, true))
  assert(!safeActualBounds(display, { ...expanded, y: 0 }, true))
  assert(!safeActualBounds(display, { ...expanded, x: -100 }, true))
})

test('a camera too wide for two useful wings uses a compact below-menu fallback', () => {
  const [display] = matchDisplays(parse([native]), [electron])
  const wide = { ...display, camera: { ...display.camera, width: 250 } }
  const compact = shelfBounds(wide, false)
  assert.equal(compact.width, 320)
  assert.equal(compact.height, 40)
  assert(compact.y >= electron.workArea.y)
  assert(safeActualBounds(wide, compact, false))
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
  const compact = shelfBounds(display, false)
  assert.equal(compact.y, -982)
  assert.equal(compact.x + compact.width / 2, -756)
  assert(safeActualBounds(display, compact, false))
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
