import type { ComponentChildren } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import { ITEM_RELATIONSHIP_LABELS, WORK_ITEM_TYPE_LABELS } from "../../../domain/types";
import { boundDiff, diffLines, formatTime, parseItemId, taskTypeAllowed, tokenizeInline } from "./helpers";
import {
  DETAIL_ADD_RELATIONSHIP_NAMES,
  DETAIL_ADD_RELATIONSHIP_NONE,
  DETAIL_DUPLICATE_OF_NAME,
  DETAIL_PRIORITIES,
  DETAIL_RELATIONSHIP_GROUPS,
  DETAIL_STATUSES,
  DETAIL_WORK_ITEM_TYPES,
  LABEL_NAME_MAX_LENGTH,
  LABEL_SET_MAX,
} from "./types";
import type { BodyTab, DetailHistoryEntry, DetailItem, DetailParticipant, DetailRelationship, DetailState, DiffOperation, InlineToken } from "./types";

/** Shown when the participant roster could not be loaded. */
export const ROSTER_UNAVAILABLE_NOTE = "Some assignment or label options could not be loaded.";

// Mirrors BOARD_COLUMN_LABELS so a status never reads differently here than it
// does on the board column it came from.
const STATUS_LABELS: Readonly<Record<string, string>> = {
  todo: "To do",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

/**
 * The label for a work-item type, tolerating a value the domain has no label
 * for. A type the server sends that this build does not know is still shown
 * verbatim rather than rendered as `undefined`.
 */
function typeLabel(type: string): string {
  return WORK_ITEM_TYPE_LABELS[type as keyof typeof WORK_ITEM_TYPE_LABELS] ?? type;
}

/** The label for a relative relationship name, with the same tolerance. */
function relationshipLabel(name: string): string {
  return ITEM_RELATIONSHIP_LABELS[name as keyof typeof ITEM_RELATIONSHIP_LABELS] ?? name;
}

function InlineMarkdown({ token }: { token: InlineToken }) {
  if (token.kind === "text") return <>{token.text}</>;
  if (token.kind === "strong") return <strong>{token.text}</strong>;
  if (token.kind === "em") return <em>{token.text}</em>;
  if (token.kind === "code") return <code translate={false}>{token.text}</code>;
  return token.link.external
    ? <a href={token.link.href} target="_blank" rel="noopener noreferrer">{token.text}</a>
    : <a href={token.link.href}>{token.text}</a>;
}

export function Markdown({ children }: { children: string }) {
  const paragraphs = children.split(/\n{2,}/);
  return (
    <div class="markdown">
      {paragraphs.map((paragraph, paragraphIndex) => (
        <p key={paragraphIndex}>
          {paragraph.split("\n").map((line, lineIndex) => (
            <span key={lineIndex}>
              {lineIndex > 0 ? <br /> : null}
              {tokenizeInline(line, location.origin).map((token, tokenIndex) => <InlineMarkdown key={tokenIndex} token={token} />)}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

export function DetailHeader({ detail }: { detail: DetailState }) {
  const item = detail.item;
  if (item === null) return null;
  return (
    <>
      <a class="breadcrumb" href="#/board">← Back to board</a>
      <div class="detail-head">
        <div class="detail-title-area">
          <h1 class="detail-page-title">Work item #{item.id}</h1>
          <label for="detail-title" class="sr-only">Title</label>
          <input
            id="detail-title"
            class="detail-title-input"
            type="text"
            name="title"
            value={detail.titleDraft}
            maxLength={256}
            autoComplete="off"
            aria-invalid={detail.titleDraft.trim() === ""}
            aria-describedby="detail-title-state"
            disabled={detail.deleting}
            onFocus={() => detail.setTitleFocused(true)}
            onInput={(event) => detail.setTitleDraft(event.currentTarget.value)}
            onBlur={() => { detail.setTitleFocused(false); void detail.flushTitle(); }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void detail.flushTitle();
            }}
          />
          <span id="detail-title-state" class="detail-save-state muted">{detail.titleStatus}</span>
        </div>
        <button
          class="danger"
          type="button"
          aria-label={`Delete item #${item.id}`}
          disabled={detail.deleting}
          onClick={() => void detail.deleteItem()}
        >
          {detail.deleting ? "Deleting…" : "Delete item"}
        </button>
      </div>
      <div class="detail-meta muted">
        <span class={`chip status-chip status-${item.status}`}>{STATUS_LABELS[item.status] ?? item.status}</span>
        <span>created <time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time></span>
        {item.closedAt === null ? null : <span>· closed <time dateTime={item.closedAt}>{formatTime(item.closedAt)}</time></span>}
      </div>
    </>
  );
}

export function FieldControls({ detail }: { detail: DetailState }) {
  const item = detail.item;
  if (item === null) return null;
  const assigneeId = item.assignee?.id ?? null;
  // The roster may not have loaded (or may have failed). An assignee that is
  // not in the list must never be shown as "Unassigned": either the current
  // assignee gets its own option, or the control is explicitly disabled and the
  // reason is stated. Showing "Unassigned" for an assigned item would invite the
  // user to "fix" a field that is already correct, and would silently clear the
  // assignment on the next change.
  const assigneeIsKnown = assigneeId !== null
    && detail.participants.some((person) => person.id === assigneeId);
  const rosterUnavailable = assigneeId !== null && !assigneeIsKnown;
  const assigneeValue = assigneeId === null ? "" : String(assigneeId);
  const busy = detail.fieldsBusy;
  // The server refuses a Task with no parent ("A Task must have a parent"), so
  // the option is withheld from a top-level item rather than offered and then
  // rejected. The rule is stated where the user can see it, so a missing option
  // reads as a rule instead of a bug.
  const taskAllowed = taskTypeAllowed(item.parentId);
  const typeOptions = taskAllowed
    ? DETAIL_WORK_ITEM_TYPES
    : DETAIL_WORK_ITEM_TYPES.filter((type) => type !== "task");
  // A type this build does not know must stay selected and visible: without its
  // own option the browser would fall back to the first one and the control
  // would misreport the item, exactly as an unknown assignee would.
  const typeIsUnknown = !DETAIL_WORK_ITEM_TYPES.includes(item.type);
  return (
    <fieldset class="detail-controls card" aria-busy={busy} aria-label="Item fields">
      {/* The label names the control; the hint sits BESIDE it, not inside it.
          A span nested in a <label> joins the accessible name, so the combobox
          would be announced as "Type Task is available once this item has a
          parent." — a sentence where a name belongs — and the aria-describedby
          reference would then repeat it. The hint keeps its describedby role. */}
      <label for="detail-type">Type</label>
      <select id="detail-type" value={item.type} disabled={busy || detail.deleting} aria-describedby={taskAllowed ? undefined : "detail-type-note"} onChange={(event) => {
        const type = DETAIL_WORK_ITEM_TYPES.find((candidate) => candidate === event.currentTarget.value);
        // Guard the server's own invariant on the client too: a Task with no
        // parent is a 400, and this control must not be able to cause one.
        if (type !== undefined && type !== item.type && (type !== "task" || taskAllowed)) {
          detail.patchField({ type });
        }
      }}>
        {typeOptions.map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}
        {typeIsUnknown ? <option value={item.type}>{typeLabel(item.type)}</option> : null}
      </select>
      {taskAllowed ? null : (
        <span id="detail-type-note" class="detail-field-note muted">
          {typeLabel("task")} is available once this item has a parent.
        </span>
      )}
      <label>Status
        <select value={item.status} disabled={busy || detail.deleting} onChange={(event) => {
          const status = DETAIL_STATUSES.find((candidate) => candidate === event.currentTarget.value);
          if (status !== undefined) detail.patchField({ status });
        }}>
          {DETAIL_STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status] ?? status}</option>)}
        </select>
      </label>
      <label>Priority
        <select value={String(item.priority)} disabled={busy || detail.deleting} onChange={(event) => {
          const value = Number(event.currentTarget.value);
          const priority = DETAIL_PRIORITIES.find((candidate) => candidate === value);
          if (priority !== undefined) detail.patchField({ priority });
        }}>
          {DETAIL_PRIORITIES.map((priority) => <option key={priority} value={priority}>P{priority}</option>)}
        </select>
      </label>
      <label>Assignee
        <select
          value={assigneeValue}
          disabled={busy || detail.deleting || rosterUnavailable}
          aria-describedby={rosterUnavailable ? "detail-assignee-note" : undefined}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "") detail.patchField({ assigneeId: null });
            else {
              const nextId = Number(value);
              if (Number.isSafeInteger(nextId) && detail.participants.some((person) => person.id === nextId)) {
                detail.patchField({ assigneeId: nextId });
              }
            }
          }}>
          <option value="">Unassigned</option>
          {detail.participants.map((person) => <option key={person.id} value={String(person.id)}>{person.name}{person.kind === "agent" ? " (agent)" : ""}</option>)}
          {/* Keep the real assignee selected and visible when the roster has
              not supplied it, so the control never misreports the item. */}
          {rosterUnavailable && item.assignee !== null
            ? <option value={String(item.assignee.id)}>{item.assignee.name}{item.assignee.kind === "agent" ? " (agent)" : ""}</option>
            : null}
        </select>
        {rosterUnavailable ? (
          <span id="detail-assignee-note" class="detail-field-note muted">
            {ROSTER_UNAVAILABLE_NOTE} This item stays assigned to {item.assignee?.name ?? "its current assignee"}; reopen the page to change it.
          </span>
        ) : null}
      </label>
    </fieldset>
  );
}

/**
 * One relationship row: the item's id, its type, its status, and its title,
 * linked to that item's detail route.
 *
 * The link text carries the id and title, which is what a reader needs to
 * identify the item; the type and status chips are beside it. Both facts are
 * pushed into `aria-describedby` text as well, because a chip is a visual
 * affordance — a screen-reader user must not have to infer "Bug / Blocked" from
 * two adjacent labels the link does not own.
 *
 * `relationshipId` is supplied only for a group whose rows can be removed. A
 * hierarchy row has no link id, so it gets no remove button rather than a
 * button that would have to invent one.
 */
function RelationshipRow({ item, relationshipId, relationshipName, busy, onRemove }: {
  item: DetailItem;
  // Declared as `| undefined` rather than optional: `exactOptionalPropertyTypes`
  // is on, and the caller passes these unconditionally, computing `undefined`
  // for a hierarchy row that has no removable link.
  relationshipId: number | undefined;
  relationshipName: string;
  busy: boolean;
  onRemove: ((relationshipId: number) => void) | undefined;
}) {
  const descriptionId = `relationship-${item.id}-${relationshipName}-description`;
  return (
    <li class="relationship-row">
      <span class="chip" aria-hidden="true">{typeLabel(item.type)}</span>
      <span class={`chip status-chip status-${item.status}`} aria-hidden="true">{STATUS_LABELS[item.status] ?? item.status}</span>
      <a href={`#/item/${item.id}`} aria-describedby={descriptionId}>#{item.id} {item.title}</a>
      <span id={descriptionId} class="sr-only">
        Type: {typeLabel(item.type)}. Status: {STATUS_LABELS[item.status] ?? item.status}. Priority P{item.priority}.{item.assignee === null ? " Unassigned." : ` Assigned to ${item.assignee.name}.`}
      </span>
      {relationshipId === undefined || onRemove === undefined ? null : (
        <button
          class="button-invisible relationship-remove"
          type="button"
          aria-label={`Remove ${relationshipLabel(relationshipName)} relationship with item #${item.id} ${item.title}`}
          disabled={busy}
          onClick={() => onRemove(relationshipId)}
        >Remove</button>
      )}
    </li>
  );
}

/** The placeholder shown by a relationship group that has no rows. */
function RelationshipEmpty({ children }: { children: ComponentChildren }) {
  return <p class="muted">{children}</p>;
}

/**
 * Every relationship the item has, grouped by how it relates.
 *
 * The section has no local error state: `detail.notice` already carries the
 * failure copy for a rejected add or remove into the view's one visible notice
 * banner, so a second copy here would state the same failure twice.
 */
export function Relationships({ detail }: { detail: DetailState }) {
  const [parentDraft, setParentDraft] = useState("");
  const [subtaskDraft, setSubtaskDraft] = useState("");
  const [addName, setAddName] = useState<string>(DETAIL_ADD_RELATIONSHIP_NONE);
  const [addItemId, setAddItemId] = useState("");
  const busy = detail.relationshipsBusy;
  const done = detail.children.filter((item) => item.status === "done").length;
  const addItemIdIsValid = parseItemId(addItemId) !== null;
  const addIsComplete = addName !== DETAIL_ADD_RELATIONSHIP_NONE && addItemIdIsValid;
  const duplicateOf = detail.duplicateOf;
  return (
    <section class="card detail-relationships" aria-labelledby="detail-relationships-heading" aria-busy={busy}>
      <div class="relationships-head">
        <h2 id="detail-relationships-heading">Relationships</h2>
        <span class="chip">{done}/{detail.children.length} children done</span>
      </div>
      <div class="relationship-parent">
        <h3>{relationshipLabel("parent")}</h3>
        {detail.parent === null ? <RelationshipEmpty>This is a top-level item.</RelationshipEmpty> : (
          <ul class="relationship-list">
            <RelationshipRow item={detail.parent} relationshipName="parent" relationshipId={undefined} onRemove={undefined} busy={busy} />
          </ul>
        )}
        {/* Detaching a Task is the one hierarchy edit the server refuses while
            the item is still a Task, so the button is withheld rather than
            offered and rejected. Changing the type first makes it available. */}
        {detail.parent === null ? (
          <form class="relationship-form" onSubmit={(event) => {
            event.preventDefault();
            const parentId = parseItemId(parentDraft);
            if (parentId !== null) detail.setParent(parentId);
          }}>
            <label for="detail-parent-id">Parent item ID</label>
            <div><input id="detail-parent-id" inputMode="numeric" pattern="[0-9]+" autoComplete="off" value={parentDraft} placeholder="e.g. 42…" disabled={busy} onInput={(event) => setParentDraft(event.currentTarget.value)} /><button type="submit" disabled={busy || parseItemId(parentDraft) === null}>Set parent</button></div>
          </form>
        ) : detail.item !== null && detail.item.type === "task" ? (
          <p class="muted">A {typeLabel("task")} must keep a parent. Change the type to detach it.</p>
        ) : (
          <button class="button-invisible" type="button" disabled={busy} onClick={() => detail.setParent(null)}>Remove parent</button>
        )}
      </div>
      <div class="relationship-children">
        {/* A plural heading in words rather than `{label}ren`: the label map
            is singular, and building it by concatenation would ship the heading
            as two fragments a reader of the bundle cannot recognize. */}
        <h3>Children</h3>
        {detail.children.length === 0 ? <RelationshipEmpty>No children yet.</RelationshipEmpty> : (
          <ul class="relationship-list">
            {detail.children.map((child) => (
              <RelationshipRow key={child.id} item={child} relationshipName="child" relationshipId={undefined} onRemove={undefined} busy={busy} />
            ))}
          </ul>
        )}
        <form class="quick-add relationship-add" onSubmit={(event) => {
          event.preventDefault();
          void detail.createSubtask(subtaskDraft).then((created) => { if (created) setSubtaskDraft(""); });
        }}>
          <label class="sr-only" for="detail-subtask-title">Add a child item</label>
          <input id="detail-subtask-title" name="subtask-title" autoComplete="off" value={subtaskDraft} maxLength={256} placeholder="Add a child item…" disabled={busy} onInput={(event) => setSubtaskDraft(event.currentTarget.value)} />
          <button type="submit" disabled={busy || subtaskDraft.trim() === ""}>Add</button>
        </form>
      </div>
      {DETAIL_RELATIONSHIP_GROUPS.map((group) => {
        const rows: readonly DetailRelationship[] = detail[group.key];
        return (
          <div key={group.key} class={`relationship-group relationship-${group.key}`}>
            <h3>{relationshipLabel(group.name)}</h3>
            {rows.length === 0 ? (
              <RelationshipEmpty>No {relationshipLabel(group.name).toLowerCase()} items.</RelationshipEmpty>
            ) : (
              <ul class="relationship-list">
                {rows.map((relationship) => (
                  <RelationshipRow
                    key={relationship.id}
                    item={relationship.item}
                    relationshipName={group.name}
                    relationshipId={group.removable ? relationship.id : undefined}
                    busy={busy}
                    onRemove={group.removable ? detail.removeRelationship : undefined}
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {/* `duplicate_of` is the mirror of `duplicates` and the only group whose
          state holds one relationship rather than a list, so it is rendered
          separately instead of being forced into the map above. */}
      <div class="relationship-group relationship-duplicate-of">
        <h3>{relationshipLabel(DETAIL_DUPLICATE_OF_NAME)}</h3>
        {duplicateOf === null ? (
          <RelationshipEmpty>This item is not a duplicate of another item.</RelationshipEmpty>
        ) : (
          <ul class="relationship-list">
            <RelationshipRow
              item={duplicateOf.item}
              relationshipName={DETAIL_DUPLICATE_OF_NAME}
              relationshipId={duplicateOf.id}
              busy={busy}
              onRemove={detail.removeRelationship}
            />
          </ul>
        )}
      </div>
      {/* The one place a non-hierarchy link is created. `parent` and `child`
          are absent from the list on purpose: the hierarchy has its own
          controls above, and a second entry point for the same field could
          disagree with them. */}
      <form class="relationship-form relationship-add-link" onSubmit={(event) => {
        event.preventDefault();
        const name = DETAIL_ADD_RELATIONSHIP_NAMES.find((candidate) => candidate === addName);
        const itemId = parseItemId(addItemId);
        if (name === undefined || itemId === null) return;
        detail.addRelationship(name, itemId);
        setAddItemId("");
      }}>
        <label for="detail-relationship-name">Add relationship</label>
        <label class="sr-only" for="detail-relationship-item-id">Related item ID</label>
        <div class="relationship-add-fields">
          <select
            id="detail-relationship-name"
            value={addName}
            disabled={busy}
            onChange={(event) => setAddName(event.currentTarget.value)}
          >
            <option value={DETAIL_ADD_RELATIONSHIP_NONE}>Relationship…</option>
            {DETAIL_ADD_RELATIONSHIP_NAMES.map((name) => (
              <option key={name} value={name}>{relationshipLabel(name)}</option>
            ))}
          </select>
          <input
            id="detail-relationship-item-id"
            inputMode="numeric"
            pattern="[0-9]+"
            autoComplete="off"
            value={addItemId}
            placeholder="e.g. 42…"
            disabled={busy}
            aria-invalid={addItemId !== "" && !addItemIdIsValid}
            aria-describedby={addItemId !== "" && !addItemIdIsValid ? "detail-relationship-item-error" : undefined}
            onInput={(event) => setAddItemId(event.currentTarget.value)}
          />
          <button type="submit" disabled={busy || !addIsComplete}>Add</button>
        </div>
        {addItemId === "" || addItemIdIsValid ? null : (
          <span id="detail-relationship-item-error" class="relationship-form-error" role="status">Enter the ID of an existing item, as a whole number.</span>
        )}
      </form>
    </section>
  );
}

export function LabelsEditor({ detail }: { detail: DetailState }) {
  const suggestions = detail.labels.filter((label) => !detail.selectedLabelNames.includes(label.name));
  const busy = detail.labelsBusy;
  return (
    <section class="card detail-labels" aria-labelledby="detail-labels-heading" aria-busy={busy}>
      <div class="labels-head">
        <h2 id="detail-labels-heading" class="labels-title">Labels</h2>
        {detail.selectedLabelNames.length === 0 ? <span class="muted">No labels</span> : null}
        {detail.selectedLabelNames.map((name) => (
          <span class="chip label-chip label-filter" key={name}>
            {name}
            <button
              class="chip-remove"
              type="button"
              aria-label={`Remove label ${name}`}
              disabled={busy || detail.deleting}
              onClick={() => detail.removeLabel(name)}
            >×</button>
          </span>
        ))}
      </div>
      {detail.labelNotice === "" ? null : <div class="notice-banner detail-label-notice">{detail.labelNotice}</div>}
      {suggestions.length === 0 ? null : (
        <div class="labels-suggestions" aria-label="Suggested labels">
          {suggestions.map((label) => (
            <button class="label-suggestion" type="button" key={label.id} disabled={busy || detail.deleting}
              onClick={() => detail.addLabel(label.name)}>+ {label.name}</button>
          ))}
        </div>
      )}
      <form class="labels-add" onSubmit={(event) => { event.preventDefault(); detail.addLabel(detail.labelDraft); }}>
        <label class="sr-only" for="detail-label-input">Add label</label>
        <input
          id="detail-label-input"
          class="label-input"
          value={detail.labelDraft}
          list="detail-label-options"
          autoComplete="off"
          name="label"
          maxLength={LABEL_NAME_MAX_LENGTH}
          placeholder="Add label…"
          disabled={busy || detail.deleting}
          aria-describedby="detail-label-limit"
          onInput={(event) => detail.setLabelDraft(event.currentTarget.value)}
        />
        <datalist id="detail-label-options">{suggestions.map((label) => <option key={label.id} value={label.name} />)}</datalist>
        <span id="detail-label-limit" class="muted">
          Up to {LABEL_SET_MAX} labels, {LABEL_NAME_MAX_LENGTH} characters each ({detail.selectedLabelNames.length}/{LABEL_SET_MAX} used).
        </span>
      </form>
    </section>
  );
}

function nextTab(key: string, current: BodyTab): BodyTab | null {
  if (key === "ArrowRight" || key === "ArrowLeft") return current === "preview" ? "edit" : "preview";
  if (key === "Home") return "preview";
  if (key === "End") return "edit";
  return null;
}

export function BodyEditor({ detail }: { detail: DetailState }) {
  const previewRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const selectTab = (tab: BodyTab, focus = false): void => {
    detail.setBodyTab(tab);
    if (focus) (tab === "preview" ? previewRef.current : editRef.current)?.focus();
  };
  const tabKey = (event: KeyboardEvent, current: BodyTab): void => {
    const tab = nextTab(event.key, current);
    if (tab === null) return;
    event.preventDefault();
    selectTab(tab, true);
  };
  return (
    <section class="card detail-body" aria-labelledby="description-heading">
      <h2 id="description-heading" class="sr-only">Description</h2>
      <div class="tabbar" role="tablist" aria-label="Description view">
        <button ref={previewRef} class="tab" type="button" role="tab" id="body-tab-preview" aria-controls="body-panel-preview"
          aria-selected={detail.bodyTab === "preview"} tabIndex={detail.bodyTab === "preview" ? 0 : -1}
          onClick={() => selectTab("preview")} onKeyDown={(event) => tabKey(event, "preview")}>Preview</button>
        <button ref={editRef} class="tab" type="button" role="tab" id="body-tab-edit" aria-controls="body-panel-edit"
          aria-selected={detail.bodyTab === "edit"} tabIndex={detail.bodyTab === "edit" ? 0 : -1}
          onClick={() => selectTab("edit")} onKeyDown={(event) => tabKey(event, "edit")}>Edit</button>
        <span class="detail-save-state muted">{detail.bodyStatus}</span>
      </div>
      <div id="body-panel-preview" role="tabpanel" aria-labelledby="body-tab-preview" tabIndex={0} hidden={detail.bodyTab !== "preview"}>
        <div class="detail-body-text"><Markdown>{detail.bodyDraft === "" ? "*(no description)*" : detail.bodyDraft}</Markdown></div>
      </div>
      <div id="body-panel-edit" role="tabpanel" aria-labelledby="body-tab-edit" tabIndex={0} hidden={detail.bodyTab !== "edit"}>
        <label class="sr-only" for="detail-body-input">Edit description</label>
        <textarea id="detail-body-input" class="body-editor" rows={10} value={detail.bodyDraft}
          maxLength={100_000}
          name="description"
          placeholder="Describe the work (markdown-lite: *italic*, **bold**, `code`, links)…"
          onFocus={() => detail.setBodyFocused(true)}
          onBlur={() => { detail.setBodyFocused(false); void detail.flushBody(); }}
          onInput={(event) => detail.setBodyDraft(event.currentTarget.value)} />
      </div>
    </section>
  );
}

export function CommentComposer({ detail }: { detail: DetailState }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listId = `mention-options-${detail.id ?? "unknown"}`;
  /**
   * Insert the mention and keep the textarea focused with the caret after it.
   *
   * The option element receives both `mousedown` and `click`, and the textarea
   * also handles Enter/Tab, so this can run twice for one selection. It is
   * idempotent: `chooseMention` inserts only while the trigger is still present
   * in the current draft, so a second call in the same tick is a no-op rather
   * than a duplicate insertion.
   */
  const choose = (participant: DetailParticipant): void => {
    const inserted = detail.chooseMention(participant);
    if (inserted === null) return;
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.setSelectionRange(inserted.caret, inserted.caret);
  };
  const activeOption = detail.mention?.options[detail.mention.activeIndex];
  return (
    <form class="composer card" onSubmit={(event) => { event.preventDefault(); detail.submitComment(); }}>
      <label for="detail-comment">Add a comment</label>
      <textarea
        ref={inputRef}
        id="detail-comment"
        rows={3}
        name="comment"
        maxLength={100_000}
        value={detail.commentDraft}
        placeholder="Write a comment; use @ to mention someone…"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={detail.mention !== null}
        aria-controls={listId}
        aria-activedescendant={activeOption === undefined ? undefined : `${listId}-${activeOption.id}`}
        onInput={(event) => detail.setCommentDraft(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
        onKeyDown={(event) => {
          if (detail.mention !== null) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              detail.moveMention(event.key === "ArrowDown" ? 1 : -1);
              return;
            }
            if ((event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) && activeOption !== undefined) {
              event.preventDefault();
              choose(activeOption);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              detail.closeMention();
              return;
            }
          }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            detail.submitComment();
          }
        }}
      />
      <div id={listId} class="mention-list" role="listbox" aria-label="Mention suggestions" hidden={detail.mention === null}>
        {detail.mention?.options.map((participant, index) => (
          <div id={`${listId}-${participant.id}`} class={`mention-option${index === detail.mention?.activeIndex ? " highlighted" : ""}`}
            role="option" aria-selected={index === detail.mention?.activeIndex}
            key={participant.id} onMouseDown={(event) => { event.preventDefault(); choose(participant); }} onClick={() => choose(participant)}>
            @{participant.name} {participant.kind === "agent" ? <span class="muted">agent</span> : null}
          </div>
        ))}
      </div>
      <div class="composer-actions">
        <span class="muted">Ctrl/⌘+Enter to post</span>
        <button class="primary" type="submit" disabled={detail.commentBusy || detail.commentDraft.trim() === ""}>{detail.commentBusy ? "Posting…" : "Post comment"}</button>
      </div>
    </form>
  );
}

export function Comments({ detail }: { detail: DetailState }) {
  return (
    <section class="detail-comments" aria-labelledby="comments-heading">
      <h2 id="comments-heading">Comments</h2>
      {detail.comments.length === 0 ? <p class="muted">No comments yet.</p> : detail.comments.map((comment) => (
        <article class="comment card" key={comment.id}>
          <header class="comment-head"><strong>{comment.author.name}</strong><time class="muted" dateTime={comment.createdAt}>{formatTime(comment.createdAt)}</time></header>
          <Markdown>{comment.body}</Markdown>
        </article>
      ))}
    </section>
  );
}

/**
 * One description change. The row's `+n/−n` counts and its diff are both
 * derived from `diffLines`, which builds an O(n·m) LCS table, so neither is
 * computed until the row is actually expanded. A collapsed history of a hundred
 * large edits therefore costs nothing to render.
 */
function HistoryBody({ entry, expanded, onToggle }: { entry: DetailHistoryEntry; expanded: boolean; onToggle: () => void }) {
  const bounded = useMemo(
    () => (expanded ? boundDiff(diffLines(entry.oldValue, entry.newValue)) : null),
    [expanded, entry.oldValue, entry.newValue],
  );
  const operations = bounded?.operations ?? EMPTY_DIFF;
  const added = operations.reduce((total, operation) => operation.type === "add" ? total + 1 : total, 0);
  const removed = operations.reduce((total, operation) => operation.type === "del" ? total + 1 : total, 0);
  return (
    <div class="history-diff-group">
      <button class="history-entry diff-row" type="button" aria-expanded={expanded} onClick={onToggle}>
        <time class="muted" dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>{" "}
        <span class="diff-label">description changed</span>
        {expanded ? <span class="diff-stat"><span class="diff-stat-add">+{added}</span>{" "}<span class="diff-stat-del">−{removed}</span></span> : <span class="diff-stat muted">View changes</span>}
        <em class="muted"> — {entry.actorName}</em><span class="diff-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>
      <pre class="diff-box" hidden={!expanded} tabIndex={0} aria-label={`Description change by ${entry.actorName}`}>
        {operations.map((operation, index) => <span class={`diff-line ${operation.type}`} key={index}>{operation.type === "add" ? "+" : operation.type === "del" ? "−" : " "} {operation.line}{"\n"}</span>)}
        {/* A shortened view must say so: presenting a clipped diff as the whole
            change would misrepresent what the edit did. */}
        {bounded?.truncated === true ? <span class="diff-truncated muted">…diff truncated for display; open the item history for the full change.</span> : null}
      </pre>
    </div>
  );
}

const EMPTY_DIFF: readonly DiffOperation[] = [];

/**
 * History entries, newest first.
 *
 * The API returns history in chronological order, so the sort is explicit
 * rather than a bare `reverse()`: entries are ordered by `createdAt` descending
 * and ties are broken by id descending. An explicit comparator keeps the newest
 * entry first even if the server ever returns a partially ordered page, and
 * `reverse()` would silently depend on the input already being sorted.
 */
function newestFirst(entries: readonly DetailHistoryEntry[]): readonly DetailHistoryEntry[] {
  return [...entries].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return right.id - left.id;
  });
}

export function History({ detail }: { detail: DetailState }) {
  const entries = useMemo(() => newestFirst(detail.history), [detail.history]);
  return (
    <section class="card detail-history" aria-labelledby="history-heading">
      <h2 id="history-heading">History</h2>
      {entries.length === 0 ? <p class="muted">No history yet.</p> : entries.map((entry) => entry.field === "body" && (typeof entry.oldValue === "string" || typeof entry.newValue === "string")
        ? <HistoryBody key={entry.id} entry={entry} expanded={detail.expandedHistory.has(entry.id)} onToggle={() => detail.toggleHistory(entry.id)} />
        : <div class="history-entry" key={entry.id}>
            <time class="muted" dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>{" "}
            {entry.oldValue === null && entry.newValue === null ? entry.field : <>{entry.field}: {entry.oldValue ?? "∅"} → {entry.newValue ?? "∅"}</>}
            <em class="muted"> — {entry.actorName}</em>
          </div>)}
    </section>
  );
}

/**
 * The view's single polite live region. Every status message is announced here
 * and nowhere else: `detail.announcement` carries the latest one, and the
 * loading/refreshing text is derived, so two regions can never interleave and
 * read the same update twice.
 */
export function DetailStatus({ detail, children }: { detail: DetailState; children?: ComponentChildren }) {
  const message = detail.loading ? "Loading item…" : detail.refreshing ? "Refreshing item…" : detail.announcement || children;
  return <div class="detail-live" role="status" aria-live="polite" aria-atomic="true">{message}</div>;
}
