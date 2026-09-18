import { useErrorBoundary } from "preact/hooks";
import { AppShell } from "./shell/AppShell";

function TopLevelErrorBoundary() {
  const [error, resetError] = useErrorBoundary();

  if (error !== undefined) {
    return (
      <main class="content">
        <div class="error-banner" role="alert">
          <p>MissionControl could not render this page.</p>
          <button type="button" onClick={resetError}>Retry</button>
        </div>
      </main>
    );
  }

  return <AppShell />;
}

export function App() {
  return <TopLevelErrorBoundary />;
}
