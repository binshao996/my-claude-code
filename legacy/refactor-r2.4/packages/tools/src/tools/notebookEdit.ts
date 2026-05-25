import { readFile, writeFile } from 'node:fs/promises'
import { extname, relative } from 'node:path'
import { z } from 'zod/v4'
import { resolveExistingPathInsideCwd } from '../pathSafety.js'
import type { Tool } from '../types.js'

const NotebookEditInputSchema = z.object({
  notebook_path: z.string().min(1),
  cell_id: z.string().optional(),
  new_source: z.string().optional(),
  cell_type: z.enum(['code', 'markdown']).optional(),
  edit_mode: z.enum(['replace', 'insert', 'delete']).optional(),
})

type NotebookEditInput = z.infer<typeof NotebookEditInputSchema>

type NotebookCell = {
  id?: string
  cell_type: 'code' | 'markdown' | string
  source?: string | string[]
  metadata?: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: number | null
}

type NotebookDocument = {
  cells: NotebookCell[]
  metadata?: Record<string, unknown>
  nbformat?: number
  nbformat_minor?: number
}

export const notebookEditTool: Tool<NotebookEditInput> = {
  name: 'NotebookEdit',
  description: 'Edit, insert, or delete cells in a Jupyter notebook inside the current workspace.',
  inputSchema: NotebookEditInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      notebook_path: {
        type: 'string',
        description: 'Path to the .ipynb file to edit.',
      },
      cell_id: {
        type: 'string',
        description: 'Cell id or cell-N index to edit. Insert without cell_id inserts at the beginning.',
      },
      new_source: {
        type: 'string',
        description: 'Replacement or inserted source text.',
      },
      cell_type: {
        type: 'string',
        enum: ['code', 'markdown'],
        description: 'Cell type. Required for insert; replace keeps existing type by default.',
      },
      edit_mode: {
        type: 'string',
        enum: ['replace', 'insert', 'delete'],
        description: 'Edit mode. Defaults to replace.',
      },
    },
    required: ['notebook_path', 'new_source'],
  },
  isReadOnly: () => false,
  isDestructive: () => true,
  isConcurrencySafe: () => false,
  async checkPermissions(input, context) {
    const notebookPath = await resolveNotebookPath(context.cwd, input.notebook_path)
    return {
      decision: 'ask',
      reason: `NotebookEdit wants to modify ${relative(context.cwd, notebookPath)}`,
    }
  },
  async execute(input, context) {
    const notebookPath = await resolveNotebookPath(context.cwd, input.notebook_path)
    const mode = input.edit_mode ?? 'replace'
    const notebook = parseNotebook(await readFile(notebookPath, 'utf8'))

    if (mode === 'insert') {
      if (!input.cell_type) {
        throw new Error('cell_type is required when edit_mode=insert')
      }

      const insertAfter = input.cell_id ? resolveCellIndex(notebook, input.cell_id) + 1 : 0
      notebook.cells.splice(insertAfter, 0, createCell(input.cell_type, input.new_source ?? ''))
      await writeNotebook(notebookPath, notebook)
      return JSON.stringify({
        edit_mode: mode,
        cell_id: notebook.cells[insertAfter]?.id ?? `cell-${insertAfter}`,
        cell_type: input.cell_type,
        notebook_path: relative(context.cwd, notebookPath),
      })
    }

    if (!input.cell_id) {
      throw new Error('cell_id is required unless edit_mode=insert')
    }

    const cellIndex = resolveCellIndex(notebook, input.cell_id)

    if (mode === 'delete') {
      const [deleted] = notebook.cells.splice(cellIndex, 1)
      await writeNotebook(notebookPath, notebook)
      return JSON.stringify({
        edit_mode: mode,
        cell_id: deleted?.id ?? `cell-${cellIndex}`,
        cell_type: deleted?.cell_type ?? 'unknown',
        notebook_path: relative(context.cwd, notebookPath),
      })
    }

    const target = notebook.cells[cellIndex]
    if (!target) {
      throw new Error(`Cell ${input.cell_id} was not found in notebook`)
    }

    const nextType = input.cell_type ?? normalizeCellType(target.cell_type)
    target.cell_type = nextType
    target.source = toNotebookSource(input.new_source ?? '')
    if (nextType === 'code') {
      target.outputs ??= []
      target.execution_count ??= null
    } else {
      delete target.outputs
      delete target.execution_count
    }
    target.metadata ??= {}

    await writeNotebook(notebookPath, notebook)
    return JSON.stringify({
      edit_mode: mode,
      cell_id: target.id ?? `cell-${cellIndex}`,
      cell_type: nextType,
      notebook_path: relative(context.cwd, notebookPath),
      new_source: input.new_source ?? '',
    })
  },
}

async function resolveNotebookPath(cwd: string, requestedPath: string): Promise<string> {
  const notebookPath = await resolveExistingPathInsideCwd(cwd, requestedPath)
  if (extname(notebookPath) !== '.ipynb') {
    throw new Error('File must be a Jupyter notebook (.ipynb file)')
  }
  return notebookPath
}

function parseNotebook(content: string): NotebookDocument {
  const parsed = JSON.parse(content) as NotebookDocument
  if (!parsed || !Array.isArray(parsed.cells)) {
    throw new Error('Notebook is not valid Jupyter JSON: missing cells array')
  }
  return parsed
}

function resolveCellIndex(notebook: NotebookDocument, cellId: string): number {
  const exactIndex = notebook.cells.findIndex(cell => cell.id === cellId)
  if (exactIndex >= 0) {
    return exactIndex
  }

  const parsedIndex = /^cell-(\d+)$/.exec(cellId)?.[1]
  if (parsedIndex !== undefined) {
    const index = Number.parseInt(parsedIndex, 10)
    if (notebook.cells[index]) {
      return index
    }
  }

  throw new Error(`Cell with ID "${cellId}" not found in notebook`)
}

function createCell(cellType: 'code' | 'markdown', source: string): NotebookCell {
  const base: NotebookCell = {
    id: `cell-${Date.now().toString(36)}`,
    cell_type: cellType,
    metadata: {},
    source: toNotebookSource(source),
  }

  if (cellType === 'code') {
    base.execution_count = null
    base.outputs = []
  }

  return base
}

function normalizeCellType(cellType: string): 'code' | 'markdown' {
  return cellType === 'markdown' ? 'markdown' : 'code'
}

function toNotebookSource(source: string): string[] {
  if (!source) {
    return []
  }

  return source.match(/[^\n]*\n|[^\n]+/g) ?? []
}

async function writeNotebook(path: string, notebook: NotebookDocument): Promise<void> {
  await writeFile(path, `${JSON.stringify(notebook, null, 2)}\n`, 'utf8')
}
