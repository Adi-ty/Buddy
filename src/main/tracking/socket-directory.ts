import { chmodSync, lstatSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Random directories prevent another local user from reserving Buddy's name.
// Prefer the profile; macOS's per-user temporary directory handles long paths
// without exceeding the Unix socket path limit.
export function socketDirectory(profile: string): string {
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const root =
    Buffer.byteLength(join(profile, '.buddy-XXXXXX', 'controls.sock')) < 104 ? profile : tmpdir()
  const stat = lstatSync(root)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform === 'darwin' && stat.uid !== process.getuid?.())
  )
    throw new Error('A private local socket directory is unavailable')
  const directory = mkdtempSync(join(root, '.buddy-'))
  chmodSync(directory, 0o700)
  return directory
}
