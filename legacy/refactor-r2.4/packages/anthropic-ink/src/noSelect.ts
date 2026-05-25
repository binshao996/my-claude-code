import { Box } from 'ink'
import React from 'react'

export const NO_SELECT_PROP = '__anthropicInkNoSelect'

export type NoSelectProps = React.ComponentProps<typeof Box> & {
  children?: React.ReactNode
  fromLeftEdge?: boolean
}

export function NoSelect({
  children,
  fromLeftEdge: _fromLeftEdge,
  ...boxProps
}: NoSelectProps): React.ReactNode {
  return React.createElement(
    Box as React.ComponentType<Record<string, unknown>>,
    {
      ...boxProps,
      [NO_SELECT_PROP]: true,
    },
    children,
  )
}

export function isNoSelectElement(element: unknown): boolean {
  return (
    React.isValidElement(element) &&
    Boolean((element.props as Record<string, unknown>)[NO_SELECT_PROP])
  )
}
