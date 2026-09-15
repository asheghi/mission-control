import type { ComponentType } from "preact";

export interface LegacyLifecycleHandle {
  unmount: () => void;
}

export interface ViewComponentProps {
  params: Record<string, unknown>;
  refreshGeneration: number;
  onAuthenticationFailure: () => void;
}

interface ViewMetadata {
  title: string;
  href: string;
  hidden?: boolean;
}

export interface LegacyViewDefinition extends ViewMetadata {
  kind?: "legacy";
  mount: (params: Record<string, unknown>, container: HTMLElement) => Promise<LegacyLifecycleHandle> | LegacyLifecycleHandle;
}

export interface ComponentViewDefinition extends ViewMetadata {
  kind: "component";
  component: ComponentType<ViewComponentProps>;
}

export type ViewDefinition = LegacyViewDefinition | ComponentViewDefinition;

export interface ViewRoute {
  name: string | null;
  view: ViewDefinition | undefined;
  params: Record<string, unknown>;
}

/** Compatibility alias for code that still names the legacy router shape. */
export type LegacyRoute = ViewRoute;

export interface EventStreamHandle {
  close: () => void;
}

export interface LiveController {
  start: () => boolean;
  stop: () => void;
  sessionId: () => number;
  guard: <T extends Record<string, (...args: never[]) => unknown>>(token: number, handlers: T) => T;
  connected: () => void;
  disconnected: () => number | null;
  viewEvent: () => boolean;
  handleBlur: () => boolean;
  isConnected: () => boolean;
}
