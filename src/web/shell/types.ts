import type { ComponentType } from "preact";

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

/** A registered view: metadata plus the Preact renderer for its route. */
export interface ComponentViewDefinition extends ViewMetadata {
  kind: "component";
  component: ComponentType<ViewComponentProps>;
}

export interface ViewRoute {
  name: string | null;
  view: ComponentViewDefinition | undefined;
  params: Record<string, unknown>;
}

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
