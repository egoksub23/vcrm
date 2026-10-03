// Builds the generated browser bundle of the client library before the tests (the simulator page serves it).
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export default function setup(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  execFileSync(process.execPath, [join(here, 'build.mjs')], { cwd: here, stdio: 'ignore' })
}
