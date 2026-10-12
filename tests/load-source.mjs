import { build } from 'esbuild'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function loadSource(entry, mocks = {}) {
  await mkdir(resolve('.cache/tests'), { recursive: true })
  // Concurrent test workers may load the same entry. Give each build its own
  // file so imports cannot read another worker's partially written bundle.
  const directory = await mkdtemp(resolve('.cache/tests/run-'))
  const outfile = join(directory, 'entry.mjs')
  try {
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      jsx: 'automatic',
      alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') },
      plugins: [
        {
          name: 'test-mocks',
          setup(build) {
            build.onResolve({ filter: /^(electron|node:child_process)$/ }, ({ path }) =>
              mocks[path] ? { path: resolve(mocks[path]) } : null,
            )
          },
        },
      ],
    })
    return await import(pathToFileURL(outfile).href)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
