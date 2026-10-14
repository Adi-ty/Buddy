import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function loadInstalledOpenCodePlugin(profile) {
  // Smoke tests simulate the host, including its Plugin.define registration
  // helper. Keep this fixture in the disposable profile, out of app dependencies.
  // The installed plugin, reporter and control client are imported unchanged.
  const packageDirectory = join(profile, 'node_modules/@opencode/plugin')
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name: '@opencode/plugin', type: 'module', exports: './index.js' }),
  )
  writeFileSync(
    join(packageDirectory, 'index.js'),
    'export const Plugin = { define: (definition) => definition }\n',
  )
  const { default: plugin } = await import(
    pathToFileURL(join(profile, 'integrations/opencode-plugin.mjs')).href
  )
  return plugin
}
