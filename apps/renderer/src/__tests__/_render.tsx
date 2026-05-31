import type { ReactElement, ReactNode } from 'react'
import { render, renderHook, type RenderOptions } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Test-render helpers (ADR-0044). Two thin wrappers around RTL:
//
//  - `renderWithQuery(ui)` - wraps in a fresh QueryClient. The
//    renderer's hooks (useBoard, useBoardMutation, useBoardsList,
//    every TanStack-Query consumer) need a provider in scope.
//  - `renderHookWithQuery(fn)` - same wrapping for hook-only tests.
//
// Each call mints a NEW QueryClient so cache state from test A never
// leaks into test B. Retries are disabled because TanStack's default
// retry-with-backoff would mask "this call failed" assertions
// behind 3 silent retries.

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        // Keep cache slots alive for the whole test run. Defaulting
        // to 0 looks tempting ("no leftover state between tests"),
        // but useBoardMutation seeds + mutates entries that have no
        // active observer - at gcTime:0 those entries get reaped
        // immediately after the mutation settles and the assertions
        // see `undefined`. Each test gets a fresh client (see
        // `renderWithQuery`/`renderHookWithQuery`) so isolation is
        // already covered.
        gcTime: Infinity
      },
      mutations: { retry: false }
    }
  })
}

function Wrapper({
  children,
  client
}: {
  children: ReactNode
  client: QueryClient
}) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/** Render under a fresh QueryClient. Returns the standard RTL result
 *  plus the client for tests that want to inspect cache directly. */
export function renderWithQuery(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
): ReturnType<typeof render> & { client: QueryClient } {
  const client = makeClient()
  const result = render(ui, {
    ...options,
    wrapper: ({ children }) => <Wrapper client={client}>{children}</Wrapper>
  })
  return Object.assign(result, { client })
}

/** Hook-only variant. Same wrapping; returns the standard
 *  `renderHook` result plus the client. */
export function renderHookWithQuery<TProps, TResult>(
  hook: (props: TProps) => TResult,
  options?: { initialProps?: TProps }
): ReturnType<typeof renderHook<TResult, TProps>> & { client: QueryClient } {
  const client = makeClient()
  const result = renderHook(hook, {
    ...options,
    wrapper: ({ children }) => <Wrapper client={client}>{children}</Wrapper>
  })
  return Object.assign(result, { client })
}
