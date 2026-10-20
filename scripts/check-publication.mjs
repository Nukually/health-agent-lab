import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root })
  .toString().split('\0').filter(Boolean)
const problems = []
for (const required of ['LICENSE', 'NOTICE', 'README.md', 'THIRD_PARTY_NOTICES.md', '.env.example']) {
  if (!files.includes(required)) problems.push(`${required}: missing release file`)
}
for (const file of new Set(files)) {
  if (/^(?:reports|outputs|node_modules|\.tmp)\//.test(file) || /\.(?:pem|key|p12|pfx|jks|keystore|dump|sqlite|aar)$/.test(file) || /(?:^|\/)\.env(?:$|\.)/.test(file) && file !== '.env.example') {
    problems.push(`${file}: private/generated file`)
    continue
  }
  const text = await readFile(resolve(root, file), 'utf8')
  // Output only paths/rule names, never matched credential values.
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) problems.push(`${file}: private key`)
  if (/\b(?:sk-[A-Za-z0-9]{24,}|LTAI[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,})\b/.test(text)) problems.push(`${file}: credential pattern`)
  if (/https?:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)(?=[:/])/.test(text)) problems.push(`${file}: private network URL`)
  if (/\/Users\/[^/]+\/|\/home\/deploy\//.test(text)) problems.push(`${file}: machine-specific path`)
}
if (problems.length) {
  console.error(problems.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Publication pattern check passed (${new Set(files).size} files). This does not replace a full secret and rights review.`)
}
