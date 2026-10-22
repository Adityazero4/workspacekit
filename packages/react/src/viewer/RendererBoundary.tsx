'use client';
import { Component, type ReactNode } from 'react';
import { viewerError, type ViewerError } from './registry';

interface RendererBoundaryProps {
  resetKey: unknown;
  onReset: () => void;
  onErrorAfterAnUpdate: (error: ViewerError) => void;
  onShowingErrorChange: (showingError: boolean) => void;
  renderError: (error: ViewerError, retry: () => void) => ReactNode;
  children: (
    reportRendererError: (error: ViewerError) => void,
    noteShown: (resetKey: unknown) => void,
  ) => ReactNode;
}

interface RendererBoundaryState {
  error: ViewerError | null;
  resetKey: unknown;
}

const NOTHING_SHOWN = Symbol('nothing shown');

class ErrorBoundaryAroundRenderer extends Component<RendererBoundaryProps, RendererBoundaryState> {
  override state: RendererBoundaryState = { error: null, resetKey: this.props.resetKey };
  #firstKeyShown: unknown = NOTHING_SHOWN;
  #reportedShowingError = false;

  static getDerivedStateFromError(thrown: unknown): Partial<RendererBoundaryState> {
    return { error: viewerError('load_error', thrown) };
  }

  static getDerivedStateFromProps(
    props: RendererBoundaryProps,
    state: RendererBoundaryState,
  ): Partial<RendererBoundaryState> | null {
    if (props.resetKey === state.resetKey) return null;
    props.onReset();
    return { error: null, resetKey: props.resetKey };
  }

  override componentDidMount(): void {
    this.#reportShowingError(this.state.error !== null);
  }

  override componentDidUpdate(): void {
    if (this.state.error) this.#firstKeyShown = NOTHING_SHOWN;
    this.#reportShowingError(this.state.error !== null);
  }

  override componentWillUnmount(): void {
    this.#reportShowingError(false);
  }

  noteShown = (resetKey: unknown): void => {
    if (this.#firstKeyShown === NOTHING_SHOWN) this.#firstKeyShown = resetKey;
  };

  reportRendererError = (error: ViewerError): void => {
    const shownAnEarlierVersion =
      this.#firstKeyShown !== NOTHING_SHOWN && this.#firstKeyShown !== this.state.resetKey;
    if (shownAnEarlierVersion) this.props.onErrorAfterAnUpdate(error);
    else this.setState({ error });
  };

  retry = (): void => {
    this.props.onReset();
    this.setState({ error: null });
  };

  #reportShowingError(showingError: boolean): void {
    if (showingError === this.#reportedShowingError) return;
    this.#reportedShowingError = showingError;
    this.props.onShowingErrorChange(showingError);
  }

  override render(): ReactNode {
    const { error } = this.state;
    return error
      ? this.props.renderError(error, this.retry)
      : this.props.children(this.reportRendererError, this.noteShown);
  }
}

/**
 * Contains a renderer: a render error or a failed chunk load becomes `load_error`, shown in place of the
 * renderer until `retry` or a new `resetKey`; both call `onReset` first, such as to forget a failed chunk
 * load. An error the renderer reports through `reportRendererError` is shown the same way unless the
 * renderer has shown an earlier `resetKey` (reported through `noteShown` once its content commits): then
 * an update failed, so the error goes to `onErrorAfterAnUpdate` instead and the renderer stays.
 * `onShowingErrorChange` hears whether the error view is shown (false again on unmount).
 *
 * @example
 * ```tsx
 * <RendererBoundary
 *   resetKey={version}
 *   onReset={() => forgetFailedLoad(renderer)}
 *   onErrorAfterAnUpdate={(error) => showBanner(error)}
 *   onShowingErrorChange={setRendererFailed}
 *   renderError={(error, retry) => <ErrorView error={error} onRetry={retry} />}
 * >
 *   {(reportRendererError, noteShown) => (
 *     <Renderer onError={reportRendererError} onCommit={() => noteShown(version)} />
 *   )}
 * </RendererBoundary>
 * ```
 */
export function RendererBoundary(props: RendererBoundaryProps): React.JSX.Element {
  return <ErrorBoundaryAroundRenderer {...props} />;
}
