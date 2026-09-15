export interface LegacyLifecycleHandle {
  unmount: () => void;
}

export interface LegacyViewDefinition {
  title: string;
  href: string;
  hidden?: boolean;
  mount: (params: Record<string, unknown>, container: HTMLElement) => Promise<LegacyLifecycleHandle> | LegacyLifecycleHandle;
}

export interface LegacyRoute {
  name: string | null;
  view: LegacyViewDefinition | undefined;
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
