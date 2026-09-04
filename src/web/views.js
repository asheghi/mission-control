// View registry (kept dependency-free so views can register themselves
// without import cycles). Null prototype: hash-router lookups must never
// resolve inherited Object.prototype keys as view names.
export const views = Object.assign(Object.create(null), {});

export function registerView(name, definition) {
  views[name] = definition;
}
