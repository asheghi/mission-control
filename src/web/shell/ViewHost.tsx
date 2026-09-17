import type { ComponentViewDefinition, ViewComponentProps } from "./types";

interface ViewHostProps extends ViewComponentProps {
  view: ComponentViewDefinition | undefined;
}

/**
 * The single render host for the application shell.
 *
 * Every registered view is a Preact component, so hosting one is a plain render:
 * there is no imperative mount, no teardown handle, and no DOM error banner.
 * A route that resolves to no view renders nothing, and a component that throws
 * is caught by the top-level error boundary in `app.tsx` — the one place that
 * owns failure copy for the whole application.
 */
export function ViewHost({ view, params, refreshGeneration, onAuthenticationFailure }: ViewHostProps) {
  if (view === undefined) return null;
  const Component = view.component;
  return (
    <Component
      params={params}
      refreshGeneration={refreshGeneration}
      onAuthenticationFailure={onAuthenticationFailure}
    />
  );
}
