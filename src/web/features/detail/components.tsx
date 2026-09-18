import type { ComponentChildren } from "preact";
import { useMemo, useRef } from "preact/hooks";
import { boundDiff, diffLines, formatTime, tokenizeInline } from "./helpers";
import { DETAIL_PRIORITIES, DETAIL_STATUSES, LABEL_NAME_MAX_LENGTH, LABEL_SET_MAX } from "./types";
import type { BodyTab, DetailHistoryEntry, DetailParticipant, DetailState, DiffOperation, InlineToken } from "./types";

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

function InlineMarkdown({ token }: { token: InlineToken }) {
  if (token.kind === "text") return <>{token.text}</>;
  if (token.kind === "strong") return <strong>{token.text}</strong>;
  if (token.kind === "em") return <em>{token.text}</em>;
  if (token.kind === "code") return <code>{token.text}</code>;
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
          <label for="detail-title">Title</label>
          <input
            id="detail-title"
            class="detail-title-input"
            type="text"
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
        <span>created {formatTime(item.createdAt)}</span>
        {item.closedAt === null ? null : <span>· closed {formatTime(item.closedAt)}</span>}
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
  return (
    <fieldset class="detail-controls card" aria-busy={busy}>
      <legend class="sr-only">Item fields</legend>
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
          placeholder="Describe the work (markdown-lite: *italic*, **bold**, `code`, links)"
          onFocus={() => detail.setBodyFocused(true)}
          onBlur={() => detail.setBodyFocused(false)}
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
        placeholder="Write a comment… use @ to mention someone"
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
