// View registry (kept dependency-free so views can register themselves
// without import cycles).
//
// The registry holds component definitions only: the imperative `mount` path,
// and the DOM/lifecycle bridge that used to service it, were removed with the
// last legacy view module. Lookups go through a null-prototype record, so a
// hash-router lookup can never resolve an inherited `Object.prototype` key as
// a view name.
import { WORK_ITEM_TYPES, WORK_ITEM_TYPE_LABELS } from "../domain/types";
import type { WorkItemType } from "../domain/types";
import type { ComponentViewDefinition } from "./shell/types";

/**
 * Whether `value` is one of the four work-item types the domain accepts.
 *
 * Exported so a filter control validates against the same list the parsers use
 * rather than repeating the literals: a stale or hand-written value must never
 * reach a request the API would reject.
 */
export function isWorkItemType(value: unknown): value is WorkItemType {
  return typeof value === "string" && (WORK_ITEM_TYPES as readonly string[]).includes(value);
}

/**
 * One-character marks for the four work-item types.
 *
 * The type chip must be distinguishable *without* colour: a greyscale display,
 * a colour-blind reader, and a text-only transcript all get the same fact from
 * the mark and the label that a sighted user gets from the chip's palette.
 */
export const WORK_ITEM_TYPE_MARKS: Readonly<Record<WorkItemType, string>> = {
  feature: "F",
  user_story: "S",
  bug: "B",
  task: "T",
};

/** Presentation facts for a work-item type chip. */
export interface WorkItemTypeBadge {
  readonly label: string;
  readonly mark: string;
  readonly className: string;
  readonly known: boolean;
}

/**
 * Presentation facts for a work-item type chip, shared by every view that
 * renders one (the board card and the list row today), so the same type never
 * reads differently in two places.
 *
 * The class suffix comes from the validated type and never from the input
 * string, so a hostile payload cannot contribute to a class name. An
 * unrecognised value degrades to "Unknown" with no type colour instead of
 * rendering as a blank chip.
 */
export function workItemTypeBadge(type: unknown): WorkItemTypeBadge {
  if (isWorkItemType(type)) {
    return {
      label: WORK_ITEM_TYPE_LABELS[type],
      mark: WORK_ITEM_TYPE_MARKS[type],
      className: `chip type-chip type-${type}`,
      known: true,
    };
  }
  return { label: "Unknown", mark: "?", className: "chip type-chip type-unknown", known: false };
}

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
