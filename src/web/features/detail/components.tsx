import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ITEM_RELATIONSHIP_LABELS, WORK_ITEM_TYPE_LABELS } from "../../../domain/types";
import { boundDiff, diffLines, formatTime, taskTypeAllowed, tokenizeInline } from "./helpers";
import { ATTACHMENT_ACCEPT, filesFromDataTransfer, formatBytes } from "./attachments";
import type { UploadedAttachment } from "./attachments";
import * as api from "../../api.js";
import {
  DETAIL_PRIORITIES,
  DETAIL_STATUSES,
  DETAIL_WORK_ITEM_TYPES,
  LABEL_NAME_MAX_LENGTH,
  LABEL_SET_MAX,
} from "./types";
import type { BodyTab, DetailHistoryEntry, DetailItem, DetailParticipant, DetailState, DiffOperation, InlineToken } from "./types";

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

/**
 * An attachment rendered inside a body or comment.
 *
 * The bytes are fetched with the bearer token and shown from an object URL
 * rather than pointing `<img>` at the API path. A plain `src` would be requested
 * by the browser without the Authorization header — the token is in
 * localStorage, not a cookie — so the server would answer 401 and the image
 * would simply not appear. Every URL this creates is revoked when the component
 * unmounts, because a blob URL holds its bytes for the life of the document.
 */
function InlineAttachment({ id, alt }: { id: number; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [kind, setKind] = useState<"image" | "video">("image");

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    setState("loading");
    setUrl(null);
    void (async () => {
      try {
        // The media type decides the element, and it comes from the server's
        // stored, sniffed value rather than from the filename.
        const meta = await api.getAttachment(id);
        if (cancelled) return;
        setKind(meta.data.kind === "video" ? "video" : "image");
        const objectUrl = await api.fetchAttachmentObjectUrl(id);
        if (cancelled) {
          api.releaseAttachmentObjectUrl(objectUrl);
          return;
        }
        created = objectUrl;
        setUrl(objectUrl);
        setState("ready");
      } catch {
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
      if (created !== null) api.releaseAttachmentObjectUrl(created);
    };
  }, [id]);

  if (state === "failed") {
    return <span class="attachment-inline is-failed">Attachment {id} could not be shown.</span>;
  }
  if (state === "loading" || url === null) {
    return <span class="attachment-inline is-loading" aria-busy="true">{alt || `Attachment ${id}`}…</span>;
  }
  if (kind === "video") {
    return <video class="attachment-inline" src={url} controls preload="metadata" aria-label={alt || `Attachment ${id}`} />;
  }
  return <img class="attachment-inline" src={url} alt={alt || `Attachment ${id}`} loading="lazy" />;
}

/** Gallery previews are bounded small images, fetched only near the viewport. */
function AttachmentThumbnail({ id, alt, mediaType, sizeBytes }: { id: number; alt: string; mediaType: string; sizeBytes: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const previewable = mediaType.startsWith("image/") && sizeBytes <= 4 * 1024 * 1024;
  useEffect(() => {
    if (!previewable || container.current === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "100px" });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [id, previewable]);
  return <div ref={container} class="attachment-thumbnail">
    {previewable && visible ? <InlineAttachment id={id} alt={alt} /> : <span class="muted">{mediaType.startsWith("video/") ? "Video" : "Image"} · Open to view</span>}
  </div>;
}

function InlineMarkdown({ token }: { token: InlineToken }) {
  if (token.kind === "text") return <>{token.text}</>;
  if (token.kind === "strong") return <strong>{token.text}</strong>;
  if (token.kind === "em") return <em>{token.text}</em>;
  if (token.kind === "code") return <code translate={false}>{token.text}</code>;
  if (token.kind === "image") return <InlineAttachment id={token.attachmentId} alt={token.text} />;
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

export function DetailHeader({ detail, children }: { detail: DetailState; children?: ComponentChildren }) {
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
        {children}
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
    <fieldset class="detail-controls" aria-busy={busy} aria-label="Item fields">
      {/* The label names the control; the hint sits BESIDE it, not inside it.
          A span nested in a <label> joins the accessible name, so the combobox
          would be announced as "Type Task is available once this item has a
          parent." — a sentence where a name belongs — and the aria-describedby
          reference would then repeat it. The hint keeps its describedby role. */}
      <div class="detail-type-field">
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
          {typeLabel("task")} requires a parent.
        </span>
      )}
      </div>
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
export function RelationshipRow({ item, relationshipId, relationshipName, busy, onRemove }: {
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
  const bodyFileRef = useRef<HTMLInputElement>(null);

  /** Upload, then append the references to the description draft. */
  const attachToBody = (files: File[]): void => {
    const itemId = detail.id;
    if (itemId === null || files.length === 0) return;
    void detail.uploads.uploadFiles(itemId, files).then((uploaded) => {
      if (uploaded.length === 0) return;
      const references = attachmentReferences(uploaded);
      const next = detail.bodyDraft.trim() === "" ? references : `${detail.bodyDraft}\n\n${references}`;
      detail.setBodyDraft(next);
    });
  };
  const bodyDrop = useFileDrop(attachToBody, detail.id !== null && !detail.deleting);
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
      <div
        id="body-panel-edit"
        role="tabpanel"
        aria-labelledby="body-tab-edit"
        tabIndex={0}
        hidden={detail.bodyTab !== "edit"}
        class={bodyDrop.dragging ? "is-dragging" : undefined}
        onDragOver={bodyDrop.handlers.onDragOver}
        onDragLeave={bodyDrop.handlers.onDragLeave}
        onDrop={bodyDrop.handlers.onDrop}
      >
        <label class="sr-only" for="detail-body-input">Edit description</label>
        <textarea id="detail-body-input" class="body-editor" rows={10} value={detail.bodyDraft}
          maxLength={100_000}
          name="description"
          placeholder="Describe the work (markdown-lite: *italic*, **bold**, `code`, links)…"
          onFocus={() => detail.setBodyFocused(true)}
          onBlur={() => { detail.setBodyFocused(false); void detail.flushBody(); }}
          onInput={(event) => detail.setBodyDraft(event.currentTarget.value)}
          onPaste={(event) => {
            const files = filesFromDataTransfer(event.clipboardData);
            if (files.length === 0) return;
            event.preventDefault();
            attachToBody(files);
          }} />
        <input
          ref={bodyFileRef}
          id="detail-body-file"
          class="sr-only"
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            attachToBody(files);
          }}
        />
        <label for="detail-body-file" class="attachment-pick attachment-pick-inline">Add images or videos</label>
      </div>
    </section>
  );
}

/**
 * Files dropped onto an element, without the browser navigating away.
 *
 * `dragover` must call preventDefault or the drop never fires; `dragleave`
 * fires when moving between child elements, so the highlight is cleared on
 * drop and on a drag that leaves the element entirely.
 */
function useFileDrop(onFiles: (files: File[]) => void, enabled: boolean) {
  const [dragging, setDragging] = useState(false);
  const handlers = {
    onDragOver: (event: DragEvent) => {
      if (!enabled || !event.dataTransfer) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (!enabled) return;
      // Related target inside the element means this is not a real exit.
      const next = event.relatedTarget as Node | null;
      if (next !== null && (event.currentTarget as Node).contains(next)) return;
      setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!enabled) return;
      event.preventDefault();
      setDragging(false);
      const files = filesFromDataTransfer(event.dataTransfer);
      if (files.length > 0) onFiles(files);
    },
  };
  return { dragging, handlers };
}

/**
 * The attachment list for one work item: a drop target, a file picker, and the
 * files already attached.
 *
 * Uploads are independent and reported per file, because a batch of screenshots
 * should not fail as a unit and a 200 MB video should not look like one opaque
 * spinner.
 */
export function AttachmentsPanel({ detail }: { detail: DetailState }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = detail.uploads;
  const picker = (
    <input
      ref={inputRef}
      id="detail-attachment-input"
      class="sr-only"
      type="file"
      multiple
      accept={ATTACHMENT_ACCEPT}
      onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        // Reset first: picking the same file twice must still fire a change.
        event.currentTarget.value = "";
        if (files.length > 0) void upload.uploadFiles(detail.id ?? 0, files);
      }}
    />
  );
  const drop = useFileDrop((files) => void upload.uploadFiles(detail.id ?? 0, files), detail.id !== null && !detail.deleting);

  return (
    <section class="card detail-attachments" aria-labelledby="attachments-heading" aria-busy={upload.busy}>
      <div class="attachments-head">
        <h2 id="attachments-heading">Attachments</h2>
        {detail.attachments.length === 0 ? <span class="muted">None</span> : <span class="muted">{detail.attachments.length}</span>}
      </div>
      <div
        class={`attachment-drop${drop.dragging ? " is-dragging" : ""}`}
        onDragOver={drop.handlers.onDragOver}
        onDragLeave={drop.handlers.onDragLeave}
        onDrop={drop.handlers.onDrop}
      >
        <label for="detail-attachment-input" class="attachment-pick">Add images or videos</label>
        {picker}
        <span class="muted">Drop or paste files here; markdown image syntax inserts them inline.</span>
      </div>
      {upload.notice === "" ? null : (
        <div class="notice-banner attachment-notice" role="status">
          {upload.notice}
          <button type="button" class="chip-remove" aria-label="Dismiss" onClick={upload.dismissNotice}>×</button>
        </div>
      )}
      {upload.uploads.length === 0 ? null : (
        <ul class="attachment-uploads">
          {upload.uploads.map((item) => (
            <li class={`attachment-upload is-${item.state}`} key={item.id}>
              <span class="attachment-upload-name">{item.filename}</span>
              <span class="muted">
                {item.state === "failed"
                  ? item.error
                  : item.state === "done"
                    ? "Uploaded"
                    : `${formatBytes(item.loaded)} / ${formatBytes(item.total)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {detail.attachments.length === 0 ? null : (
        <ul class="attachment-list">
          {detail.attachments.map((attachment) => (
            <li class="attachment-row" key={attachment.id}>
              <AttachmentThumbnail id={attachment.id} alt={attachment.filename} mediaType={attachment.mediaType} sizeBytes={attachment.sizeBytes} />
              <a href={attachment.contentPath} onClick={(event) => { event.preventDefault(); detail.openAttachment(attachment.id); }}>
                {attachment.filename}
              </a>
              <span class="muted">{attachment.mediaType} · {formatBytes(attachment.sizeBytes)}</span>
              <button
                type="button"
                class="chip-remove"
                aria-label={`Delete attachment ${attachment.filename}`}
                disabled={detail.deleting}
                onClick={() => detail.removeAttachment(attachment.id)}
              >×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Markdown references for uploaded files, built from the file/id pairs the hook
 * returns rather than from positions.
 *
 * Uploads complete out of order, so zipping ids against the input array would
 * name a fast file after a slow one and mislabel everything after a failure.
 */
function attachmentReferences(uploaded: readonly UploadedAttachment[]): string {
  return uploaded
    .map((entry) => `![${entry.file.name || "attachment"}](/api/attachments/${entry.id}/content)`)
    .join("\n");
}

export function CommentComposer({ detail }: { detail: DetailState }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listId = `mention-options-${detail.id ?? "unknown"}`;

  /**
   * Upload pasted or dropped files, then append their references to the draft.
   *
   * Only successfully uploaded files are referenced: inserting a link to an
   * upload that failed would put a broken image in the comment.
   */
  const attach = (files: File[]): void => {
    const itemId = detail.id;
    if (itemId === null || files.length === 0) return;
    void detail.uploads.uploadFiles(itemId, files).then((uploaded) => {
      if (uploaded.length === 0) return;
      const references = attachmentReferences(uploaded);
      const next = detail.commentDraft.trim() === "" ? references : `${detail.commentDraft}\n${references}`;
      detail.setCommentDraft(next, next.length);
    });
  };

  const drop = useFileDrop(attach, detail.id !== null && !detail.commentBusy);
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
    <form
      class={`composer card${drop.dragging ? " is-dragging" : ""}`}
      onSubmit={(event) => { event.preventDefault(); detail.submitComment(); }}
      onDragOver={drop.handlers.onDragOver}
      onDragLeave={drop.handlers.onDragLeave}
      onDrop={drop.handlers.onDrop}
    >
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
        onPaste={(event) => {
          // Pasting a screenshot is the common case; text paste is untouched.
          const files = filesFromDataTransfer(event.clipboardData);
          if (files.length === 0) return;
          event.preventDefault();
          attach(files);
        }}
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
        <input
          ref={fileRef}
          id="detail-comment-file"
          class="sr-only"
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            attach(files);
          }}
        />
        <label for="detail-comment-file" class="attachment-pick attachment-pick-inline">Attach</label>
        <span class="muted">Ctrl/⌘+Enter to post</span>
        <button class="primary" type="submit" disabled={detail.commentBusy || detail.commentDraft.trim() === ""}>{detail.commentBusy ? "Posting…" : "Post comment"}</button>
      </div>
    </form>
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
        : <div class="history-diff-group" key={entry.id}>
            <button class="history-entry diff-row" type="button" aria-expanded={detail.expandedHistory.has(entry.id)} onClick={() => detail.toggleHistory(entry.id)}>
              <time class="muted" dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>{" "}
              <span>{entry.field} changed</span><em class="muted"> — {entry.actorName}</em>
              <span class="diff-caret" aria-hidden="true">{detail.expandedHistory.has(entry.id) ? "▾" : "▸"}</span>
            </button>
            <div class="history-values" hidden={!detail.expandedHistory.has(entry.id)}>
              {entry.oldValue === null && entry.newValue === null ? entry.field : <><div><span class="muted">Before: </span>{entry.oldValue ?? "∅"}</div><div><span class="muted">After: </span>{entry.newValue ?? "∅"}</div></>}
            </div>
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
