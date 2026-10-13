import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

test('OpenCode V2 plugin subscribes to V2 events and cleans up its subscription', async (t) => {
  const observations = []
  globalThis.__buddyPluginReport = (_path, value) => observations.push(value)
  t.after(() => delete globalThis.__buddyPluginReport)
  const result = await build({
    entryPoints: ['integrations/opencode-plugin.mjs'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'fixture-modules',
        setup(builder) {
          builder.onResolve({ filter: /^@opencode\/plugin$/ }, () => ({
            path: 'plugin-api',
            namespace: 'fixture',
          }))
          builder.onResolve({ filter: /reporter\.mjs$/ }, () => ({
            path: 'reporter',
            namespace: 'fixture',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            contents:
              args.path === 'plugin-api'
                ? 'export const Plugin = { define: (definition) => definition }'
                : 'export const report = (...args) => globalThis.__buddyPluginReport(...args)',
            loader: 'js',
          }))
        },
      },
    ],
  })
  const { default: plugin } = await import(
    'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
  )
  assert.equal(plugin.id, 'buddy.session-observer')
  let publish
  let closed = false
  const ctx = {
    location: { directory: '/projects/buddy' },
    event: {
      subscribe({ signal }) {
        return {
          async *[Symbol.asyncIterator]() {
            const queue = []
            publish = (event) => {
              queue.push(event)
              wake()
            }
            while (!signal.aborted) {
              if (!queue.length) {
                await new Promise((resolve) => (wake = resolve))
                if (signal.aborted) break
              }
              while (queue.length) yield queue.shift()
            }
            closed = true
          },
        }
      },
    },
  }
  let wake = () => {}
  const cleanup = plugin.setup(ctx)
  await new Promise((resolve) => setImmediate(resolve))
  publish({
    id: 'event-1',
    type: 'session.status',
    properties: { sessionID: 'session-1', status: { type: 'busy' } },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(observations[0].sessionId, 'session-1')
  assert.equal(observations[0].status, 'busy')
  assert.equal(observations[0].cwd, '/projects/buddy')
  cleanup()
  wake()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closed, true)
})
