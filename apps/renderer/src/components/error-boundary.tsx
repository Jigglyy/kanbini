import { Component, type ReactNode, type ErrorInfo } from 'react'

// Render-error catch-all. Without this, an uncaught error in any
// child unmounts the entire React tree and the app goes blank with
// no in-window hint - the user has to open DevTools (or restart) to
// see what happened. This boundary keeps the window usable: shows
// the error + stack and offers a reset that re-mounts the children.
//
// Logs to console so the message stays grep-able in the dev console
// + the user's stdout if they're running `pnpm dev` from a terminal.

interface State {
  error: Error | null
  info: ErrorInfo | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info })
    console.error('[ErrorBoundary] caught render error:', error, info)
  }

  reset = (): void => this.setState({ error: null, info: null })

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="m-6 flex flex-col gap-3 rounded-lg border border-red-500/40 bg-card p-6 text-foreground">
        <h2 className="text-lg font-semibold text-red-400">
          Something broke in the UI.
        </h2>
        <p className="text-sm text-muted-foreground">
          The error is logged to DevTools and copied below. Click reset
          to try re-mounting the view, or restart the app if it
          recurs.
        </p>
        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background p-3 text-xs text-red-300">
          {this.state.error.message}
          {'\n\n'}
          {this.state.error.stack ?? '(no stack)'}
          {this.state.info?.componentStack ?? ''}
        </pre>
        <div>
          <button
            type="button"
            onClick={this.reset}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
          >
            Reset view
          </button>
        </div>
      </div>
    )
  }
}
