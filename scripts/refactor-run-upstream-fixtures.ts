import { writeFileSync } from 'node:fs'

const logPath = '/tmp/r2.7-upstream-mirror-test.log'

const commands = [
  [
    'bun',
    'test',
    '--max-concurrency',
    '1',
    '--path-ignore-patterns',
    'claude-code/**',
    '--path-ignore-patterns',
    'legacy/**',
    '--path-ignore-patterns',
    'src/services/skillSearch/__tests__/prefetch.test.ts',
    '--path-ignore-patterns',
    'src/services/skillLearning/__tests__/skillLearningSmoke.test.ts',
    'src',
    'packages',
    'tests',
  ],
  [
    'bun',
    'test',
    '--max-concurrency',
    '1',
    '--path-ignore-patterns',
    'claude-code/**',
    '--path-ignore-patterns',
    'legacy/**',
    'src/services/skillSearch/__tests__/prefetch.test.ts',
  ],
  [
    'bun',
    'test',
    '--max-concurrency',
    '1',
    '--path-ignore-patterns',
    'claude-code/**',
    '--path-ignore-patterns',
    'legacy/**',
    'src/services/skillLearning/__tests__/skillLearningSmoke.test.ts',
  ],
]

let combined = ''
let exitCode = 0

for (const command of commands) {
  const header = `$ ${command.map(shellQuote).join(' ')}\n`
  process.stdout.write(header)
  combined += header

  const proc = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  combined += stdout
  combined += stderr
  if (status !== 0) {
    exitCode = status
    break
  }
}

writeFileSync(logPath, combined)
process.exit(exitCode)

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./:=*-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`
}
