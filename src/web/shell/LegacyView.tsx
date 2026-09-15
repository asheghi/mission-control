import { useEffect, useRef } from "preact/hooks";
import { isTerminalAuthError } from "../public-errors.js";
import type { LegacyLifecycleHandle, LegacyViewDefinition, ViewDefinition } from "./types";
import { safeErrorMessage } from "./safe-error";

interface ViewHostProps {
  view: ViewDefinition | undefined;
  params: Record<string, unknown>;
  generation: number;
  onAuthenticationFailure: () => void;
}

interface LegacyHostProps extends ViewHostProps {
  view: LegacyViewDefinition;
}

function showMountError(slot: HTMLDivElement, error: unknown): void {
  const banner = document.createElement("div");
  banner.className = "error-banner";
  banner.setAttribute("role", "alert");
  banner.textContent = safeErrorMessage(error);
  slot.replaceChildren(banner);
}

function LegacyHost({ view, params, generation, onAuthenticationFailure }: LegacyHostProps) {
  const slotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const slot = slotRef.current;
    if (slot === null) return;

    let detached = false;
    let handle: LegacyLifecycleHandle | null = null;
    let tornDown = false;
    const teardown = (): void => {
      if (tornDown || handle === null) return;
      tornDown = true;
      try {
        handle.unmount();
      } catch {
        // A failing legacy teardown must not block navigation.
      }
    };

    const mountFailed = (error: unknown): void => {
      if (detached) return;
      if (isTerminalAuthError(error)) {
        onAuthenticationFailure();
        return;
      }
      showMountError(slot, error);
    };

    try {
      const mounted = view.mount(params, slot);
      void Promise.resolve(mounted).then(
        (resolvedHandle) => {
          handle = resolvedHandle;
          if (detached) teardown();
        },
        mountFailed,
      );
    } catch (error: unknown) {
      mountFailed(error);
    }

    return () => {
      detached = true;
      teardown();
    };
  }, [view, params, generation, onAuthenticationFailure]);

  return <div ref={slotRef} />;
}

export function ViewHost({ view, params, generation, onAuthenticationFailure }: ViewHostProps) {
  if (view === undefined) return null;
  if (view.kind === "component") {
    const Component = view.component;
    return (
      <Component
        params={params}
        refreshGeneration={generation}
        onAuthenticationFailure={onAuthenticationFailure}
      />
    );
  }
  return (
    <LegacyHost
      view={view}
      params={params}
      generation={generation}
      onAuthenticationFailure={onAuthenticationFailure}
    />
  );
}

/** Backward-compatible export while callers migrate to the generic host name. */
export const LegacyView = ViewHost;
