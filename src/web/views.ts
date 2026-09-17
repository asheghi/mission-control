// View registry (kept dependency-free so views can register themselves
// without import cycles).
//
// The registry holds component definitions only: the imperative `mount` path,
// and the DOM/lifecycle bridge that used to service it, were removed with the
// last legacy view module. Lookups go through a null-prototype record, so a
// hash-router lookup can never resolve an inherited `Object.prototype` key as
// a view name.
import type { ComponentViewDefinition } from "./shell/types";

/** Registered views, keyed by route name. Null prototype on purpose. */
export const views: Record<string, ComponentViewDefinition> = Object.assign(Object.create(null), {});

/**
 * Register a component view under its route name.
 *
 * The definition is `{ kind: "component", component }`, so a registrant can
 * only ever supply a Preact renderer — there is no imperative host to mount
 * into and no teardown lifecycle for the shell to own.
 */
export function registerView(name: string, definition: ComponentViewDefinition): void {
  views[name] = definition;
}
