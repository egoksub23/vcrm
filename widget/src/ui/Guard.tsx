import { Component, type ComponentChildren } from 'preact'

interface GuardProps {
  /** What to show instead when a child throws while rendering. `reset` tries the children again. */
  fallback: (reset: () => void) => ComponentChildren
  /** When this changes (e.g. the row was updated), a previously failed child is given another chance. */
  resetKey?: string
  children?: ComponentChildren
}

interface GuardState {
  failed: boolean
  key?: string
}

/**
 * Error boundary. Preact unmounts the whole tree when a component throws while
 * rendering and nothing catches it; on the chat that looks like a blank widget
 * (or, after a reload, like the session ended). One malformed message must
 * only ever degrade ITS OWN bubble, and a crash anywhere must leave a visible
 * message with a retry, never a blank panel.
 */
export class Guard extends Component<GuardProps, GuardState> {
  state: GuardState = { failed: false, key: this.props.resetKey }

  static getDerivedStateFromError(): Partial<GuardState> {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: GuardProps, state: GuardState): Partial<GuardState> | null {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null
  }

  componentDidCatch(error: unknown): void {
    console.warn('[vircle-widget] a part of the chat failed to render', error)
  }

  private reset = (): void => {
    this.setState({ failed: false })
  }

  render() {
    return this.state.failed ? this.props.fallback(this.reset) : this.props.children
  }
}
