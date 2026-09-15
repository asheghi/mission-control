import { useEffect, useRef } from "preact/hooks";
import { isTerminalAuthError } from "../public-errors.js";
import type { LegacyLifecycleHandle, LegacyViewDefinition } from "./types";
import { safeErrorMessage } from "./safe-error";

interface LegacyViewProps {
  view: LegacyViewDefinition | undefined;
  params: Record<string, unknown>;
  generation: number;
  onAuthenticationFailure: () => void;
}

function showMountError(slot: HTMLDivElement, error: unknown): void {
  const banner = document.createElement("div");
  banner.className = "error-banner";
  banner.setAttribute("role", "alert");
  banner.textContent = safeErrorMessage(error);
  slot.replaceChildren(banner);
}

export function LegacyView({ view, params, generation, onAuthenticationFailure }: LegacyViewProps) {
  const slotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const slot = slotRef.current;
    if (slot === null || view === undefined) return;

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
