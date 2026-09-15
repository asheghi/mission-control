// View registry (kept dependency-free so views can register themselves
// without import cycles). Null prototype: hash-router lookups must never
// resolve inherited Object.prototype keys as view names.
//
// Legacy callers can keep registering `{ mount }` definitions unchanged, while
// TypeScript callers are checked against the component-or-legacy view union.
/** @typedef {import("./shell/types").ViewDefinition} ViewDefinition */
/** @type {Record<string, ViewDefinition>} */
export const views = Object.assign(Object.create(null), {});

/**
 * @param {string} name
 * @param {ViewDefinition} definition
 */
export function registerView(name, definition) {
  views[name] = definition;
}
