import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { ITEM_RELATIONSHIP_LABELS } from "../../../domain/types";
import { parseItemId } from "./helpers";
import { RelationshipRow } from "./components";
import { DETAIL_ADD_RELATIONSHIP_NAMES, DETAIL_RELATIONSHIP_GROUPS } from "./types";
import type { DetailState } from "./types";

/** Only populated links are shown; hierarchy editing lives in the add dialog. */
export function Links({ detail }: { detail: DetailState }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [name, setName] = useState("related");
  const [target, setTarget] = useState("");
  const [childTitle, setChildTitle] = useState("");
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    const element = dialog.current;
    const preventDismiss = (event: Event) => { if (submitting.current) event.preventDefault(); };
    const preventEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && element?.open && submitting.current) event.preventDefault();
    };
    element?.addEventListener("cancel", preventDismiss);
    document.addEventListener("keydown", preventEscape, true);
    return () => {
      mounted.current = false;
      element?.removeEventListener("cancel", preventDismiss);
      document.removeEventListener("keydown", preventEscape, true);
    };
  }, []);
  const busy = saving || detail.relationshipsBusy || detail.deleting;
  const itemId = parseItemId(target);
  const close = () => { if (!submitting.current) { dialog.current?.close(); trigger.current?.focus(); } };

  const settle = (saved: boolean) => {
    if (!mounted.current) return;
    submitting.current = false;
    setSaving(false);
    if (saved) { close(); setTarget(""); setChildTitle(""); }
    else setError(true);
  };

  const hasLinks = detail.parent !== null || detail.children.length > 0 || detail.duplicateOf !== null
    || DETAIL_RELATIONSHIP_GROUPS.some((group) => detail[group.key].length > 0);
  return (
    <section class="card detail-relationships" aria-labelledby="detail-relationships-heading" aria-busy={busy}>
      <h2 id="detail-relationships-heading">Links</h2>
      {!hasLinks ? <p class="muted">No links.</p> : null}
      {detail.parent === null ? null : <div class="relationship-group">
        <h3>Parent</h3><ul class="relationship-list"><RelationshipRow item={detail.parent} relationshipName="parent" relationshipId={undefined} onRemove={undefined} busy={busy} /></ul>
        {detail.item?.type === "task" ? null : <button class="button-invisible" type="button" disabled={busy} onClick={() => detail.setParent(null)}>Remove parent</button>}
      </div>}
      {detail.children.length === 0 ? null : <div class="relationship-group">
        <h3>Children <span class="muted">{detail.children.filter((child) => child.status === "done").length}/{detail.children.length} done</span></h3>
        <ul class="relationship-list">{detail.children.map((child) => <RelationshipRow key={child.id} item={child} relationshipName="child" relationshipId={undefined} onRemove={undefined} busy={busy} />)}</ul>
      </div>}
      {DETAIL_RELATIONSHIP_GROUPS.map((group) => detail[group.key].length === 0 ? null : <div class={`relationship-group relationship-${group.key}`} key={group.key}>
        <h3>{ITEM_RELATIONSHIP_LABELS[group.name]}</h3>
        <ul class="relationship-list">{detail[group.key].map((link) => <RelationshipRow key={link.id} item={link.item} relationshipName={group.name} relationshipId={group.removable ? link.id : undefined} onRemove={group.removable ? detail.removeRelationship : undefined} busy={busy} />)}</ul>
      </div>)}
      {detail.duplicateOf === null ? null : <div class="relationship-group relationship-duplicate-of">
        <h3>Duplicate of</h3><ul class="relationship-list"><RelationshipRow item={detail.duplicateOf.item} relationshipName="duplicate_of" relationshipId={detail.duplicateOf.id} onRemove={detail.removeRelationship} busy={busy} /></ul>
      </div>}
      <button ref={trigger} class="detail-add-link" type="button" disabled={busy} onClick={() => { setError(false); dialog.current?.showModal(); }}>Add link</button>
      <dialog ref={dialog} class="link-dialog" aria-labelledby="link-dialog-heading" onClose={() => trigger.current?.focus()}>
        <div class="link-dialog-head"><h2 id="link-dialog-heading">Add link</h2><button type="button" aria-label="Close add link" disabled={busy} onClick={close}>×</button></div>
        <form class="link-dialog-form" onSubmit={(event) => {
          event.preventDefault();
          if (busy || submitting.current || (name === "new_child" ? childTitle.trim() === "" : itemId === null)) return;
          submitting.current = true;
          setSaving(true);
          setError(false);
          if (name === "new_child") {
            void detail.createSubtask(childTitle).then(settle);
          } else if (itemId !== null) {
            if (name === "parent") void detail.setParent(itemId).then(settle);
            else {
              const relationship = DETAIL_ADD_RELATIONSHIP_NAMES.find((candidate) => candidate === name);
              if (relationship !== undefined) void detail.addRelationship(relationship, itemId).then(settle);
            }
          }
        }}>
          <label for="detail-relationship-name">Link type</label>
          <select id="detail-relationship-name" name="relationship" value={name} disabled={busy} onChange={(event) => setName(event.currentTarget.value)}>
            {DETAIL_ADD_RELATIONSHIP_NAMES.map((value) => <option value={value} key={value}>{ITEM_RELATIONSHIP_LABELS[value]}</option>)}
            <option value="parent">Parent</option><option value="new_child">New child</option>
          </select>
          {name === "new_child" ? <><label for="detail-subtask-title">Child title</label><input id="detail-subtask-title" name="child-title" autoComplete="off" value={childTitle} maxLength={256} disabled={busy} onInput={(event) => setChildTitle(event.currentTarget.value)} /></> : <>
            <label for="detail-relationship-item-id">Item ID</label>
            <input id="detail-relationship-item-id" name="item-id" inputMode="numeric" autoComplete="off" value={target} placeholder="e.g. 42…" disabled={busy} aria-invalid={target !== "" && itemId === null} onInput={(event) => setTarget(event.currentTarget.value)} />
          </>}
          {!error ? null : <p class="error-banner" role="alert">Could not add link. Check the item ID and link type, then retry.</p>}
          <div class="link-dialog-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="submit" class="primary" disabled={busy || (name === "new_child" ? childTitle.trim() === "" : itemId === null)}>{busy ? "Adding…" : "Add"}</button></div>
        </form>
      </dialog>
    </section>
  );
}
