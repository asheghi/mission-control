// View registry (kept dependency-free so views can register themselves
// without import cycles).
export const views = {};

export function registerView(name, definition) {
  views[name] = definition;
}
