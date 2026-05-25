import type { ReactNode } from 'react'
import {
  render as inkRender,
  type Instance,
  type RenderOptions,
} from 'ink'

export type AnthropicInkRenderOptions = RenderOptions

export function render(
  node: ReactNode,
  options?: AnthropicInkRenderOptions,
): Instance {
  return inkRender(node, normalizeRenderOptions(options))
}

export function normalizeRenderOptions(
  options: AnthropicInkRenderOptions | undefined,
): AnthropicInkRenderOptions | undefined {
  if (!options) {
    return undefined
  }

  const normalized: AnthropicInkRenderOptions = {}
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      normalized[key as keyof AnthropicInkRenderOptions] = value as never
    }
  }

  return normalized
}
