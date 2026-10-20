import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
async function testFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.filter(entry => !['node_modules', 'dist', '.git'].includes(entry.name)).map(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return testFiles(path)
    return /\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : []
  }))
  return files.flat().sort()
}
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  NODE_ENV: 'test',
  DEPLOY_ENV: 'local',
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
  JWT_SECRET: 'synthetic-test-secret-not-for-deployment',
  LLM_API_KEY: 'synthetic-test-key',
  LLM_BASE_URL: 'http://127.0.0.1:1/v1',
}
const groups = [
  ['backend/shared', [resolve(root, 'packages/backend'), resolve(root, 'packages/shared')]],
  ['frontend', [resolve(root, 'packages/frontend')]],
]
for (const [name, directories] of groups) {
  const files = (await Promise.all(directories.map(testFiles))).flat()
  console.log(`\n${name}: ${files.length} test files`)
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--test', '--test-concurrency=4', '--test-timeout=30000', ...files,
    ], {
      cwd: resolve(root, 'packages/backend'), stdio: 'inherit',
      env: name === 'frontend'
        ? { ...env, TSX_TSCONFIG_PATH: resolve(root, 'packages/frontend/tsconfig.json') }
        : env,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolveExit(signal ? 1 : code ?? 1))
  })
  if (code !== 0) process.exit(code)
}
