import { realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export async function resolveExistingPathInsideCwd(
  cwd: string,
  requestedPath: string,
): Promise<string> {
  const cwdRealPath = await realpath(cwd)
  const candidate = resolve(cwdRealPath, requestedPath)
  const candidateRealPath = await realpath(candidate)

  assertInside(cwdRealPath, candidateRealPath)
  return candidateRealPath
}

export async function resolvePathInsideCwd(
  cwd: string,
  requestedPath: string,
): Promise<string> {
  const cwdRealPath = await realpath(cwd)
  const candidate = resolve(cwdRealPath, requestedPath)
  assertInside(cwdRealPath, candidate)
  return candidate
}

export function assertInside(cwd: string, candidate: string) {
  if (candidate !== cwd && !candidate.startsWith(`${cwd}${sep}`)) {
    throw new Error(`path is outside the current workspace: ${candidate}`)
  }
}
