import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

type TuiGoldenScenario = {
  name: string
  ansi: string
  screenshot: string
  mustContain: string[]
  mustNotContain?: string[]
}

type TuiGoldenManifest = {
  version: string
  terminal: {
    columns: number
    rows: number
    theme: string
  }
  componentMirrors: string[]
  scenarios: TuiGoldenScenario[]
}

type GoldenFailure = {
  scenario?: string
  path?: string
  reason: string
}

const cwd = process.cwd()
const manifestPath = 'docs/refactor/golden/tui/manifest.json'
const marker = ['R1_1', 'STRUCTURE_MIRROR'].join('_')
const componentRoots = [
  'src/components/PromptInput',
  'src/components/messages',
  'src/components/permissions',
]

const failures: GoldenFailure[] = []

if (!existsSync(join(cwd, manifestPath))) {
  failures.push({ path: manifestPath, reason: 'missing manifest' })
} else {
  const manifest = JSON.parse(readFileSync(join(cwd, manifestPath), 'utf8')) as TuiGoldenManifest
  if (!manifest.version) {
    failures.push({ path: manifestPath, reason: 'missing version' })
  }
  if (manifest.terminal.columns !== 120 || manifest.terminal.rows !== 36) {
    failures.push({ path: manifestPath, reason: 'terminal size must stay fixed at 120x36' })
  }

  for (const componentRoot of manifest.componentMirrors) {
    const absoluteRoot = join(cwd, componentRoot)
    if (!existsSync(absoluteRoot)) {
      failures.push({ path: componentRoot, reason: 'missing component mirror root' })
      continue
    }
    for (const sourceFile of listSourceFiles(componentRoot)) {
      const content = readFileSync(join(cwd, sourceFile), 'utf8')
      if (content.includes(marker)) {
        failures.push({
          path: sourceFile,
          reason: 'component mirror still contains R1.1 structure marker',
        })
      }
    }
  }

  for (const scenario of manifest.scenarios) {
    verifyScenario(scenario)
  }
}

for (const componentRoot of componentRoots) {
  for (const sourceFile of listSourceFiles(componentRoot)) {
    const content = readFileSync(join(cwd, sourceFile), 'utf8')
    if (content.includes(marker)) {
      failures.push({
        path: sourceFile,
        reason: 'component mirror still contains R1.1 structure marker',
      })
    }
  }
}

const report = {
  fixture: manifestPath,
  status: failures.length === 0 ? 'pass' : 'fail',
  scenarios: existsSync(join(cwd, manifestPath))
    ? (JSON.parse(readFileSync(join(cwd, manifestPath), 'utf8')) as TuiGoldenManifest).scenarios.length
    : 0,
  componentRoots,
  failures,
}

console.log(JSON.stringify(report, null, 2))

if (failures.length > 0) {
  process.exit(1)
}

function verifyScenario(scenario: TuiGoldenScenario): void {
  const ansiPath = join(cwd, scenario.ansi)
  const screenshotPath = join(cwd, scenario.screenshot)
  if (!existsSync(ansiPath)) {
    failures.push({ scenario: scenario.name, path: scenario.ansi, reason: 'missing ANSI frame' })
    return
  }
  if (!existsSync(screenshotPath)) {
    failures.push({
      scenario: scenario.name,
      path: scenario.screenshot,
      reason: 'missing screenshot frame',
    })
    return
  }

  const ansi = normalize(readFileSync(ansiPath, 'utf8'))
  const screenshot = normalize(readFileSync(screenshotPath, 'utf8'))
  if (ansi.length === 0 || screenshot.length === 0) {
    failures.push({ scenario: scenario.name, reason: 'empty golden frame' })
  }

  for (const expected of scenario.mustContain) {
    if (!ansi.includes(expected) && !screenshot.includes(expected)) {
      failures.push({
        scenario: scenario.name,
        reason: `missing expected text: ${expected}`,
      })
    }
  }

  for (const forbidden of scenario.mustNotContain ?? []) {
    if (ansi.includes(forbidden) || screenshot.includes(forbidden)) {
      failures.push({
        scenario: scenario.name,
        reason: `contains forbidden text: ${forbidden}`,
      })
    }
  }
}

function listSourceFiles(root: string): string[] {
  const absoluteRoot = join(cwd, root)
  if (!existsSync(absoluteRoot)) {
    return []
  }
  const files: string[] = []
  walk(absoluteRoot, files)
  return files.map(file => normalize(relative(cwd, file))).sort()
}

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry)
    const info = statSync(file)
    if (info.isDirectory()) {
      walk(file, files)
      continue
    }
    if (info.isFile() && /\.[cm]?[jt]sx?$/.test(file)) {
      files.push(file)
    }
  }
}

function normalize(value: string): string {
  return value.replace(/\r\n/g, '\n')
}
