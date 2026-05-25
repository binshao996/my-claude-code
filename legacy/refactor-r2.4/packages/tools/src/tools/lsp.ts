import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { z } from 'zod/v4'
import { resolveExistingPathInsideCwd } from '../pathSafety.js'
import type { Tool } from '../types.js'

const LspOperationSchema = z.enum([
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
])

const LspInputSchema = z.object({
  operation: LspOperationSchema,
  filePath: z.string().min(1),
  line: z.number().int().positive(),
  character: z.number().int().positive(),
})

type LspInput = z.infer<typeof LspInputSchema>

type SourceFile = {
  path: string
  relativePath: string
  content: string
  lines: string[]
}

type SymbolRecord = {
  name: string
  kind: string
  filePath: string
  line: number
  character: number
  preview: string
}

type ReferenceRecord = {
  filePath: string
  line: number
  character: number
  preview: string
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.my-claude-code',
])

export const lspTool: Tool<LspInput> = {
  name: 'LSP',
  description: 'Run local code intelligence operations such as definitions, references, hover, and symbols.',
  inputSchema: LspInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: LspOperationSchema.options,
        description: 'Code intelligence operation to perform.',
      },
      filePath: { type: 'string', description: 'File to inspect.' },
      line: { type: 'number', description: '1-based line number.' },
      character: { type: 'number', description: '1-based character offset.' },
    },
    required: ['operation', 'filePath', 'line', 'character'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  async checkPermissions(input, context) {
    await resolveExistingPathInsideCwd(context.cwd, input.filePath)
    return { decision: 'allow' }
  },
  async execute(input, context) {
    const targetPath = await resolveExistingPathInsideCwd(context.cwd, input.filePath)
    const targetFile = await readSourceFile(context.cwd, targetPath)
    const word = wordAtPosition(targetFile.lines, input.line, input.character)
    const workspaceFiles = await readWorkspaceSourceFiles(context.cwd)
    const workspaceSymbols = workspaceFiles.flatMap(file => extractSymbols(file))
    const result = runLspOperation(input, targetFile, workspaceFiles, workspaceSymbols, word)

    return JSON.stringify({
      operation: input.operation,
      filePath: targetFile.relativePath,
      symbol: word,
      ...result,
    })
  },
}

function runLspOperation(
  input: LspInput,
  targetFile: SourceFile,
  workspaceFiles: SourceFile[],
  workspaceSymbols: SymbolRecord[],
  word: string,
): { result: string; resultCount: number; fileCount?: number; items?: unknown[] } {
  switch (input.operation) {
    case 'documentSymbol': {
      const items = extractSymbols(targetFile)
      return {
        result: formatSymbols(items),
        resultCount: items.length,
        fileCount: 1,
        items,
      }
    }
    case 'workspaceSymbol': {
      const items = word
        ? workspaceSymbols.filter(symbol => symbol.name.includes(word))
        : workspaceSymbols
      return {
        result: formatSymbols(items),
        resultCount: items.length,
        fileCount: countFiles(items),
        items,
      }
    }
    case 'goToDefinition':
    case 'goToImplementation': {
      const items = workspaceSymbols.filter(symbol => symbol.name === word)
      return {
        result: items.length ? formatSymbols(items) : `No definition found for "${word}"`,
        resultCount: items.length,
        fileCount: countFiles(items),
        items,
      }
    }
    case 'findReferences': {
      const items = findReferences(workspaceFiles, word)
      return {
        result: items.length ? formatReferences(items) : `No references found for "${word}"`,
        resultCount: items.length,
        fileCount: countFiles(items),
        items,
      }
    }
    case 'hover': {
      const definition = workspaceSymbols.find(symbol => symbol.name === word)
      return {
        result: definition
          ? `${definition.kind} ${definition.name} at ${definition.filePath}:${definition.line}\n${definition.preview}`
          : `No hover information found for "${word}"`,
        resultCount: definition ? 1 : 0,
        fileCount: definition ? 1 : 0,
        items: definition ? [definition] : [],
      }
    }
    case 'prepareCallHierarchy': {
      const item = nearestEnclosingSymbol(extractSymbols(targetFile), input.line)
      return {
        result: item ? formatSymbols([item]) : 'No call hierarchy item found at this position',
        resultCount: item ? 1 : 0,
        fileCount: item ? 1 : 0,
        items: item ? [item] : [],
      }
    }
    case 'incomingCalls': {
      const item = nearestEnclosingSymbol(extractSymbols(targetFile), input.line)
      const items = item ? findReferences(workspaceFiles, item.name).filter(ref => {
        return !(ref.filePath === item.filePath && ref.line === item.line)
      }) : []
      return {
        result: items.length ? formatReferences(items) : 'No incoming calls found',
        resultCount: items.length,
        fileCount: countFiles(items),
        items,
      }
    }
    case 'outgoingCalls': {
      const item = nearestEnclosingSymbol(extractSymbols(targetFile), input.line)
      const items = item ? findOutgoingCalls(targetFile, item, workspaceSymbols) : []
      return {
        result: items.length ? formatSymbols(items) : 'No outgoing calls found',
        resultCount: items.length,
        fileCount: countFiles(items),
        items,
      }
    }
  }
}

async function readSourceFile(cwd: string, filePath: string): Promise<SourceFile> {
  const content = await readFile(filePath, 'utf8')
  return {
    path: filePath,
    relativePath: relative(cwd, filePath),
    content,
    lines: content.split(/\r?\n/),
  }
}

async function readWorkspaceSourceFiles(cwd: string): Promise<SourceFile[]> {
  const paths = await collectSourcePaths(cwd)
  const files: SourceFile[] = []

  for (const path of paths.slice(0, 500)) {
    try {
      const stats = await stat(path)
      if (stats.size <= 1_000_000) {
        files.push(await readSourceFile(cwd, path))
      }
    } catch {
      // Ignore files that disappear while scanning.
    }
  }

  return files
}

async function collectSourcePaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths: string[] = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        paths.push(...await collectSourcePaths(join(directory, entry.name)))
      }
      continue
    }

    if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      paths.push(join(directory, entry.name))
    }
  }

  return paths
}

function extractSymbols(file: SourceFile): SymbolRecord[] {
  const symbols: SymbolRecord[] = []
  const patterns: Array<{ kind: string; pattern: RegExp }> = [
    { kind: 'class', pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'interface', pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'type', pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'function', pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'const', pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'method', pattern: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/ },
  ]

  file.lines.forEach((line, index) => {
    for (const { kind, pattern } of patterns) {
      const name = pattern.exec(line)?.[1]
      if (!name || ['if', 'for', 'while', 'switch', 'catch'].includes(name)) {
        continue
      }
      symbols.push({
        name,
        kind,
        filePath: file.relativePath,
        line: index + 1,
        character: line.indexOf(name) + 1,
        preview: line.trim(),
      })
      break
    }
  })

  return symbols
}

function wordAtPosition(lines: string[], line: number, character: number): string {
  const text = lines[line - 1] ?? ''
  const index = Math.max(0, Math.min(character - 1, text.length))
  const left = text.slice(0, index + 1).match(/[A-Za-z_$][\w$]*$/)?.[0] ?? ''
  const right = text.slice(index + 1).match(/^[\w$]*/)?.[0] ?? ''
  return `${left}${right}`
}

function findReferences(files: SourceFile[], word: string): ReferenceRecord[] {
  if (!word) {
    return []
  }

  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'g')
  const references: ReferenceRecord[] = []

  for (const file of files) {
    file.lines.forEach((line, index) => {
      pattern.lastIndex = 0
      for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
        references.push({
          filePath: file.relativePath,
          line: index + 1,
          character: match.index + 1,
          preview: line.trim(),
        })
      }
    })
  }

  return references
}

function nearestEnclosingSymbol(symbols: SymbolRecord[], line: number): SymbolRecord | undefined {
  return symbols
    .filter(symbol => symbol.line <= line)
    .sort((a, b) => b.line - a.line)[0]
}

function findOutgoingCalls(
  file: SourceFile,
  symbol: SymbolRecord,
  workspaceSymbols: SymbolRecord[],
): SymbolRecord[] {
  const nextSymbol = extractSymbols(file)
    .filter(candidate => candidate.line > symbol.line)
    .sort((a, b) => a.line - b.line)[0]
  const body = file.lines.slice(symbol.line - 1, nextSymbol ? nextSymbol.line - 1 : undefined).join('\n')
  const names = new Set([...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]))
  names.delete(symbol.name)

  return workspaceSymbols.filter(candidate => names.has(candidate.name))
}

function formatSymbols(symbols: SymbolRecord[]): string {
  return symbols
    .map(symbol => `${symbol.filePath}:${symbol.line}:${symbol.character} ${symbol.kind} ${symbol.name} - ${symbol.preview}`)
    .join('\n')
}

function formatReferences(references: ReferenceRecord[]): string {
  return references
    .map(reference => `${reference.filePath}:${reference.line}:${reference.character} ${reference.preview}`)
    .join('\n')
}

function countFiles(items: Array<{ filePath: string }>): number {
  return new Set(items.map(item => item.filePath)).size
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
