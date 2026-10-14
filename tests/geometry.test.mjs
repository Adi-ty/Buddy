import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadSource } from './load-source.mjs'

const { mapDisplays, companionBounds, companionPosition, companionDisplay, safeActualBounds } =
  await loadSource('tests/geometry-entry.ts')
const electron = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 38, width: 1512, height: 920 },
  scaleFactor: 2,
  rotation: 0,
}
test('mapping preserves Electron DIP geometry without applying scale or rotation again', () => {
  const expected = [{ id: electron.id, bounds: electron.bounds, workArea: electron.workArea }]
  assert.deepEqual(mapDisplays([electron]), expected)
  assert.deepEqual(mapDisplays([{ ...electron, scaleFactor: 1.25, rotation: 90 }]), expected)
})

test('compact and expanded cards stay inside the supplied work area', () => {
  const [display] = mapDisplays([electron])
  for (const expanded of [false, true]) {
    const bounds = companionBounds(display, expanded)
    assert(safeActualBounds(display, bounds))
    assert.equal(bounds.x + bounds.width, electron.workArea.width - 12)
    assert(!safeActualBounds(display, { ...bounds, y: 0 }))
    assert(!safeActualBounds(display, { ...bounds, x: -100 }))
  }
})

test('negative monitor origins and side docks use Electron coordinates without conversion', () => {
  const [display] = mapDisplays([
    {
      ...electron,
      bounds: { x: -1512, y: -982, width: 1512, height: 982 },
      workArea: { x: -1452, y: -944, width: 1452, height: 920 },
    },
  ])
  for (const expanded of [false, true]) {
    assert(safeActualBounds(display, companionBounds(display, expanded, { x: 0, y: 0 })))
    assert(safeActualBounds(display, companionBounds(display, expanded, { x: 1, y: 1 })))
  }
})

test('unusable display geometry is rejected and cramped work areas decline the card', () => {
  for (const candidate of [
    { ...electron, id: -1 },
    { ...electron, workArea: { ...electron.workArea, width: 0 } },
    { ...electron, bounds: { ...electron.bounds, x: NaN } },
    { ...electron, workArea: { ...electron.workArea, x: -100 } },
  ])
    assert.deepEqual(mapDisplays([candidate]), [])
  const [display] = mapDisplays([electron])
  assert.equal(
    companionBounds({ ...display, workArea: { ...display.workArea, width: 280 } }, false),
    null,
  )
  assert.equal(
    companionBounds({ ...display, workArea: { ...display.workArea, height: 240 } }, true),
    null,
  )
})

test('expansion grows inward at every edge and retains the compact anchor across work-area changes', () => {
  const [display] = mapDisplays([electron])
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

test('saved display IDs restore positions; missing IDs fall back to primary without guessing identity', () => {
  const [display] = mapDisplays([electron])
  const saved = companionPosition(display, companionBounds(display, false))
  const external = { ...display, id: 2 }
  assert.equal(companionDisplay([display, external], saved, 2), display)
  assert.equal(companionDisplay([external, display], { ...saved, displayId: 99 }, 1), display)
  assert.equal(companionDisplay([external, display], null, 1), display)
  assert.equal(companionDisplay([external], saved, 1), external)
  assert.equal(companionDisplay([], saved, 1), undefined)
  const clamped = companionPosition(display, { x: -9000, y: 9000, width: 320, height: 60 })
  assert.equal(clamped.x, 0)
  assert.equal(clamped.y, 1)
})
