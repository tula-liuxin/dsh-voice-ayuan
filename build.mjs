import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.js'],
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  write: false,
})
const output = result.outputFiles[0].text
const target = join(root, 'client.js')
if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8')
  if (current.replaceAll('\r\n', '\n') !== output.replaceAll('\r\n', '\n')) {
    throw new Error('client.js is stale: run npm run build')
  }
  console.log('client.js matches its source build')
} else {
  await writeFile(target, output)
}
