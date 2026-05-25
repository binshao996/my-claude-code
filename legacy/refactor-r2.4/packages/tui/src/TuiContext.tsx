import {
  createContext,
  type PropsWithChildren,
  useContext,
} from 'react'
import type { TuiRuntimeOptions } from './tuiTypes.js'

const TuiRuntimeContext = createContext<TuiRuntimeOptions | undefined>(undefined)

export function TuiRuntimeProvider(
  props: PropsWithChildren<{ value: TuiRuntimeOptions }>,
) {
  return (
    <TuiRuntimeContext.Provider value={props.value}>
      {props.children}
    </TuiRuntimeContext.Provider>
  )
}

export function useTuiRuntime(): TuiRuntimeOptions {
  const value = useContext(TuiRuntimeContext)
  if (!value) {
    throw new Error('TuiRuntimeProvider is missing')
  }

  return value
}
