import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadSource } from './load-source.mjs'
const { RequestService } = await loadSource('src/main/request-service.ts')
const request = () => ({
  id: 'r',
  kind: 'permission',
  expiresAt: Date.now() + 60000,
  submitting: false,
})
test('shared response operation validates and atomically arbitrates laptop and Telegram', async () => {
  const live = [request()]
  let calls = 0
  const service = new RequestService(
    () => live,
    () => true,
    async () => {
      calls++
    },
  )
  await assert.rejects(service.respond('r', { answers: [] }, 'telegram'))
  await Promise.all([
    service.respond('r', { decision: 'allow' }, 'telegram'),
    assert.rejects(service.respond('r', { decision: 'reject' }, 'buddy'), /already/),
  ])
  assert.equal(calls, 1)
  const outcomes = []
  service.subscribe((value) => outcomes.push(value))
  assert.equal(outcomes.length, 0)
  service.resolve('r', 'confirmed')
  assert.deepEqual(outcomes, [{ id: 'r', outcome: 'confirmed', origin: 'telegram' }])
})
test('retirement is not confirmation; known rejection permits a corrected answer', async () => {
  let live = [request()]
  const service = new RequestService(
    () => live,
    () => true,
    async () => {},
  )
  const outcomes = []
  service.subscribe((value) => outcomes.push(value))
  await service.respond('r', { decision: 'allow' }, 'buddy')
  service.resolve('r', 'rejected')
  assert.equal(outcomes.length, 0)
  await service.respond('r', { decision: 'reject' }, 'telegram')
  live = []
  service.reconcile()
  assert.deepEqual(outcomes, [{ id: 'r', outcome: 'unavailable', origin: 'telegram' }])
  await assert.rejects(service.respond('r', { decision: 'allow' }, 'telegram'), /no longer/)
})
test('expired or unavailable tracking never dispatches', async () => {
  const live = [{ ...request(), expiresAt: 0 }]
  const service = new RequestService(
    () => live,
    () => true,
    async () => assert.fail(),
  )
  await assert.rejects(service.respond('r', { decision: 'allow' }, 'telegram'))
  const disabled = new RequestService(
    () => [request()],
    () => false,
    async () => assert.fail(),
  )
  await assert.rejects(disabled.respond('r', { decision: 'allow' }, 'buddy'))
})

test('an uncertain submission still permits an adapter-supported native handoff', async () => {
  const calls = []
  const service = new RequestService(
    () => [request()],
    () => true,
    async (_id, response) => calls.push(response),
  )
  await service.respond('r', { decision: 'allow' }, 'telegram')
  await service.respond('r', { decision: 'native' }, 'buddy')
  assert.deepEqual(calls, [{ decision: 'allow' }, { decision: 'native' }])
})
