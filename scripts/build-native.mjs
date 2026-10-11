import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'darwin') {
  console.log('Native display helper is macOS-only; skipping compilation.')
  process.exit(0)
}

const output = resolve('out/native')
const modules = resolve('.cache/swift-modules')
mkdirSync(output, { recursive: true })
mkdirSync(modules, { recursive: true })

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// Bundle both architectures, independent of the build host. Installed apps need
// neither a Swift compiler nor the developer's shell environment.
for (const architecture of ['arm64', 'x86_64']) {
  run('xcrun', [
    'swiftc',
    '-O',
    '-target',
    `${architecture}-apple-macosx13.0`,
    '-module-cache-path',
    modules,
    resolve('native/DisplayProbe.swift'),
    '-o',
    `${output}/buddy-display-${architecture}`,
  ])
}
run('xcrun', [
  'lipo',
  '-create',
  `${output}/buddy-display-arm64`,
  `${output}/buddy-display-x86_64`,
  '-output',
  `${output}/buddy-display`,
])
console.log('Built universal macOS display helper.')
