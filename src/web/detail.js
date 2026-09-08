// Item detail (Task 15): fields + quick patch controls, markdown-safe body
// and comment rendering (user text is never injected as HTML), comment
// composer with @mentions autocomplete, change history timeline.
// Title and description autosave (no save buttons): the title is always an
// input, the description uses Preview/Edit tabs (Preview is the default).
// Description history entries render as a collapsed git-style diff row that
// expands on click.
import * as api from "./api.js";
import { el, toast, navigate, errorBanner } from "./app.js";
import { registerView } from "./views.js";

const STATUSES = ["todo", "doing", "blocked", "done"];
const TITLE_DEBOUNCE_MS = 600;
const BODY_DEBOUNCE_MS = 700;

// --- Safe markdown-lite -----------------------------------------------------
// Everything is built with textContent; the only HTML-ish syntax interpreted
// is our own minimal markdown, and link URLs are scheme-restricted.

function safeUrl(raw) {
  try {
    const url = new URL(raw, location.origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function renderInline(target, text) {
  const pattern = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) target.append(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("**")) target.append(el("strong", {}, token.slice(2, -2)));
    else if (token.startsWith("`")) target.append(el("code", {}, token.slice(1, -1)));
    else if (token.startsWith("[")) {
      const label = token.slice(1, token.indexOf("]"));
      const href = safeUrl(token.slice(token.indexOf("](") + 2, -1));
      target.append(href ? el("a", { href, target: "_blank", rel: "noopener noreferrer" }, label) : token);
    } else target.append(el("em", {}, token.slice(1, -1)));
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) target.append(text.slice(lastIndex));
}

export function renderMarkdown(text) {
  const container = el("div", { class: "markdown" });
  const paragraphs = String(text).split(/\n{2,}/);
  for (const paragraph of paragraphs) {
    const node = el("p", {});
    const lines = paragraph.split("\n");
    lines.forEach((line, index) => {
      if (index > 0) node.append(el("br"));
      renderInline(node, line);
    });
    container.append(node);
  }
  return container;
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// --- Line diff (git-style) ---------------------------------------------------
// LCS-based line diff; entries that would blow the DP budget fall back to one
// wholesale removal block plus one wholesale addition block.

function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 400_000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "ctx", line: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", line: a[i] });
      i += 1;
    } else {
      ops.push({ type: "add", line: b[j] });
      j += 1;
    }
  }
  while (i < n) ops.push({ type: "del", line: a[i++] });
  while (j < m) ops.push({ type: "add", line: b[j++] });
  return ops;
}

function diffLines(oldText, newText) {
  const ops = lcsOps(String(oldText ?? "").split("\n"), String(newText ?? "").split("\n"));
  if (ops !== null) return ops;
  const ops2 = [];
  for (const line of String(oldText ?? "").split("\n")) ops2.push({ type: "del", line });
  for (const line of String(newText ?? "").split("\n")) ops2.push({ type: "add", line });
  return ops2;
}

function diffCounts(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added += 1;
    else if (op.type === "del") removed += 1;
  }
  return { added, removed };
}

// --- Detail view -------------------------------------------------------------

async function mount(params, container) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    container.replaceChildren(el("div", { class: "placeholder card" }, "Unknown item."));
    return;
  }

  const state = { item: null, comments: [], history: [], participants: [] };
  state.participants = (await api.listParticipants().catch(() => ({ data: [] }))).data;

  const metaNode = el("div", { class: "detail-meta muted" });
  const commentsNode = el("div", { class: "detail-comments" });
  const historyNode = el("div", { class: "card detail-history" });

  const statusSelect = el(
    "select",
    { "aria-label": "Change status" },
    STATUSES.map((status) => el("option", { value: status }, status)),
  );
  const prioritySelect = el(
    "select",
    { "aria-label": "Change priority" },
    [0, 1, 2, 3].map((priority) => el("option", { value: String(priority) }, `P${priority}`)),
  );
  const assigneeSelect = el(
    "select",
    { "aria-label": "Change assignee" },
    el("option", { value: "" }, "Unassigned"),
    state.participants.map((participant) => el("option", { value: String(participant.id) }, participant.name)),
  );

  async function patch(input) {
    try {
      await api.updateItem(id, input);
      await reload();
      toast("Saved");
    } catch (error) {
      toast(`Save failed: ${error.message}`, true);
      await reload();
    }
  }

  statusSelect.addEventListener("change", () => patch({ status: statusSelect.value }));
  prioritySelect.addEventListener("change", () => patch({ priority: Number(prioritySelect.value) }));
  assigneeSelect.addEventListener("change", () => patch({ assigneeId: assigneeSelect.value === "" ? null : Number(assigneeSelect.value) }));

  // --- Title: always-editable input with autosave ----------------------------

  const titleInput = el("input", { type: "text", class: "detail-title-input", "aria-label": "Item title", autocomplete: "off" });
  const titleState = el("span", { class: "detail-save-state muted", "aria-live": "polite" });
  let lastSavedTitle = "";
  let titleSaving = false;
  let titleQueued = false;
  let titleTimer = null;

  function setTitleStatus(text) {
    titleState.textContent = text;
  }

  async function saveTitleNow() {
    if (titleSaving) {
      titleQueued = true; // another change is waiting; run again after this one
      return;
    }
    const value = titleInput.value.trim();
    if (value.length === 0) {
      // The API rejects blank titles; keep the draft, never send it.
      setTitleStatus("Title cannot be empty");
      return;
    }
    if (value === lastSavedTitle) {
      setTitleStatus("");
      return;
    }
    titleSaving = true;
    setTitleStatus("Saving…");
    try {
      await api.updateItem(id, { title: value });
      lastSavedTitle = value;
      if (state.item !== null) state.item.title = value;
      setTitleStatus("Saved ✓");
    } catch (error) {
      toast(`Save failed: ${error.message}`, true);
      titleInput.value = state.item?.title ?? titleInput.value;
      lastSavedTitle = state.item?.title ?? "";
      setTitleStatus("Not saved");
    } finally {
      titleSaving = false;
    }
    if (titleQueued) {
      titleQueued = false;
      saveTitleNow();
    }
  }

  function scheduleTitleSave() {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => saveTitleNow(), TITLE_DEBOUNCE_MS);
  }

  titleInput.addEventListener("input", () => {
    setTitleStatus(titleInput.value.trim().length === 0 ? "Title cannot be empty" : "Edited");
    scheduleTitleSave();
  });
  titleInput.addEventListener("blur", () => {
    clearTimeout(titleTimer);
    saveTitleNow();
  });
  titleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      clearTimeout(titleTimer);
      saveTitleNow();
    }
  });

  // --- Description: Preview / Edit tabs with autosave ------------------------

  const bodyNode = el("div", { class: "detail-body-text markdown-pane" });
  const bodyInput = el("textarea", {
    rows: "10",
    class: "body-editor",
    placeholder: "Describe the work (markdown-lite: *italic*, **bold**, `code`, links)",
    "aria-label": "Edit description",
  });
  const bodyState = el("span", { class: "detail-save-state muted", "aria-live": "polite" });
  // Preview is the default tab; a live-update remount restores the user's
  // tab from the previous mount.
  let bodyTab = sessionStorage.getItem(`wb-body-tab-${id}`) === "edit" ? "edit" : "preview";
  let savedBody = "";
  let bodySaving = false;
  let bodyQueued = false;
  let bodyTimer = null;

  function setBodyStatus(text) {
    bodyState.textContent = text;
  }

  async function saveBodyNow() {
    if (bodySaving) {
      bodyQueued = true;
      return;
    }
    const value = bodyInput.value;
    if (value === savedBody) {
      setBodyStatus("");
      return;
    }
    bodySaving = true;
    setBodyStatus("Saving…");
    try {
      await api.updateItem(id, { body: value });
      savedBody = value;
      if (state.item !== null) state.item.body = value;
      setBodyStatus("Saved ✓");
    } catch (error) {
      toast(`Save failed: ${error.message}`, true);
      savedBody = state.item?.body ?? "";
      bodyInput.value = savedBody;
      setBodyStatus("Not saved");
    } finally {
      bodySaving = false;
    }
    if (bodyQueued) {
      bodyQueued = false;
      saveBodyNow();
    }
  }

  function scheduleBodySave() {
    clearTimeout(bodyTimer);
    bodyTimer = setTimeout(() => saveBodyNow(), BODY_DEBOUNCE_MS);
  }

  bodyInput.addEventListener("input", () => {
    setBodyStatus("Edited");
    scheduleBodySave();
  });

  async function setBodyTab(tab) {
    clearTimeout(bodyTimer);
    // If the textarea is empty because it was never populated (fresh mount),
    // fill it from server state BEFORE flushing, so switching tabs never
    // saves a blanked-out description.
    if (tab === "edit" && document.activeElement !== bodyInput) {
      bodyInput.value = state.item?.body ?? savedBody;
    }
    sessionStorage.setItem(`wb-body-tab-${id}`, tab);
    await saveBodyNow();
    bodyTab = tab;
    renderBody();
    if (bodyTab === "edit") {
      // Caret to the end after the pane becomes visible.
      queueMicrotask(() => {
        const end = bodyInput.value.length;
        bodyInput.setSelectionRange(end, end);
      });
    }
  }

  const previewTab = el("button", { type: "button", class: "tab", role: "tab", id: "body-tab-preview", "aria-controls": "body-panel-preview" }, "Preview");
  const editTab = el("button", { type: "button", class: "tab", role: "tab", id: "body-tab-edit", "aria-controls": "body-panel-edit" }, "Edit");
  previewTab.addEventListener("click", () => setBodyTab("preview"));
  editTab.addEventListener("click", () => setBodyTab("edit"));

  function renderPreview() {
    bodyNode.replaceChildren(renderMarkdown(state.item?.body ? state.item.body : "*(no description)*"));
  }

  const bodyEditorPane = el("div", { class: "body-editor-pane", id: "body-panel-edit", role: "tabpanel" }, bodyInput);
  const bodyPreviewPane = el("div", { class: "detail-body", id: "body-panel-preview", role: "tabpanel" }, bodyNode);

  function renderBody() {
    const onEdit = bodyTab === "edit";
    previewTab.setAttribute("aria-selected", onEdit ? "false" : "true");
    previewTab.tabIndex = onEdit ? -1 : 0;
    editTab.setAttribute("aria-selected", onEdit ? "true" : "false");
    editTab.tabIndex = onEdit ? 0 : -1;
    bodyPreviewPane.hidden = onEdit;
    bodyEditorPane.hidden = !onEdit;
    // Only sync the textarea from server state when the user is not actively
    // typing in it — live updates must not clobber an open draft.
    if (onEdit && document.activeElement !== bodyInput) {
      bodyInput.value = state.item?.body ?? "";
    }
    if (!onEdit) renderPreview();
  }

  function renderDetail() {
    const item = state.item;
    // Never clobber an input the user is composing in (e.g. live update).
    if (document.activeElement !== titleInput) titleInput.value = item.title;
    lastSavedTitle = item.title;
    titleInput.disabled = false;
    metaNode.replaceChildren(
      el("span", { class: "chip" }, item.status),
      ` created ${formatTime(item.createdAt)}`,
      item.closedAt ? ` · closed ${formatTime(item.closedAt)}` : "",
    );
    statusSelect.value = item.status;
    prioritySelect.value = String(item.priority);
    assigneeSelect.value = item.assignee ? String(item.assignee.id) : "";
    savedBody = item.body;
    renderBody();
    renderComments();
    renderHistory();
  }

  function renderComments() {
    commentsNode.replaceChildren(
      ...state.comments.map((comment) =>
        el(
          "article",
          { class: "comment card" },
          el("div", { class: "comment-head" }, el("strong", {}, comment.author.name), el("span", { class: "muted" }, formatTime(comment.createdAt))),
          renderMarkdown(comment.body),
        ),
      ),
    );
  }

  function renderHistory() {
    // Newest first: the API returns history in chronological order; reverse a
    // copy for display without mutating the state.
    const entries = [...state.history].reverse();
    historyNode.replaceChildren(
      el("h3", {}, "History"),
      ...entries.map((entry) => renderHistoryEntry(entry)),
    );
  }

  const expandedHistory = new Set();

  function renderHistoryEntry(entry) {
    const row = el("div", { class: "history-entry" });
    row.append(el("span", { class: "muted" }, formatTime(entry.createdAt)), " ");
    if (entry.field === "body" && typeof entry.oldValue === "string" || entry.field === "body" && typeof entry.newValue === "string") {
      const ops = diffLines(entry.oldValue ?? "", entry.newValue ?? "");
      const { added, removed } = diffCounts(ops);
      const isOpen = expandedHistory.has(entry.id);
      const summary = el(
        "span",
        { class: "diff-stat" },
        el("span", { class: "diff-stat-add" }, `+${added}`),
        " ",
        el("span", { class: "diff-stat-del" }, `−${removed}`),
      );
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      row.setAttribute("aria-expanded", isOpen ? "true" : "false");
      row.classList.add("diff-row");
      row.append(
        el("span", { class: "diff-label" }, `description changed`),
        summary,
        el("em", { class: "muted" }, ` — ${entry.actorName}`),
        el("span", { class: "diff-caret", "aria-hidden": "true" }, isOpen ? "▾" : "▸"),
      );
      const box = el("pre", { class: "diff-box", "data-diff-id": String(entry.id) });
      if (!isOpen) box.hidden = true;
      const toggle = () => {
        if (expandedHistory.has(entry.id)) expandedHistory.delete(entry.id);
        else expandedHistory.add(entry.id);
        const exp = expandedHistory.has(entry.id);
        row.setAttribute("aria-expanded", exp ? "true" : "false");
        row.querySelector(".diff-caret").textContent = exp ? "▾" : "▸";
        box.hidden = !exp;
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
      for (const op of ops) {
        const sign = op.type === "add" ? "+" : op.type === "del" ? "−" : " ";
        box.append(el("span", { class: `diff-line ${op.type}` }, `${sign} ${op.line}`));
      }
      const group = el("div", { class: "history-diff-group" });
      group.append(row, box);
      return group;
    }
    const change =
      entry.oldValue === null && entry.newValue === null
        ? entry.field
        : `${entry.field}: ${entry.oldValue ?? "∅"} → ${entry.newValue ?? "∅"}`;
    row.append(change, el("em", { class: "muted" }, ` — ${entry.actorName}`));
    return row;
  }

  // --- Composer with @mentions autocomplete ---------------------------------

  const textarea = el("textarea", { rows: "3", placeholder: "Write a comment… use @ to mention someone", "aria-label": "Write a comment" });
  const mentionList = el("div", { class: "mention-list", hidden: "hidden", role: "listbox" });
  let mentionState = { active: false, startIndex: -1, options: [], highlight: 0 };

  function closeMentions() {
    mentionState.active = false;
    mentionList.setAttribute("hidden", "hidden");
    mentionList.replaceChildren();
  }

  function openMentions(query) {
    const queryLower = query.toLowerCase();
    const options = state.participants.filter((participant) => participant.name.toLowerCase().startsWith(queryLower)).slice(0, 6);
    mentionState = { active: options.length > 0, startIndex: -1, options, highlight: 0 };
    if (!mentionState.active) {
      closeMentions();
      return;
    }
    mentionList.removeAttribute("hidden");
    renderMentionOptions();
  }

  function renderMentionOptions() {
    mentionList.replaceChildren(
      ...mentionState.options.map((participant, index) =>
        el(
          "div",
          {
            class: `mention-option${index === mentionState.highlight ? " highlighted" : ""}`,
            role: "option",
            onclick: () => applyMention(participant.name),
          },
          `@${participant.name}`,
        ),
      ),
    );
  }

  function applyMention(name) {
    const caret = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at !== -1) {
      textarea.value = `${before.slice(0, at)}@${name} ${textarea.value.slice(caret)}`;
      const nextCaret = at + name.length + 2;
      textarea.setSelectionRange(nextCaret, nextCaret);
    }
    closeMentions();
    textarea.focus();
  }

  textarea.addEventListener("input", () => {
    const caret = textarea.selectionStart ?? 0;
    const before = textarea.value.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at === -1 || /\s/.test(before.slice(at + 1))) {
      closeMentions();
      return;
    }
    openMentions(before.slice(at + 1));
  });
  textarea.addEventListener("keydown", (event) => {
    if (mentionState.active) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        mentionState.highlight = (mentionState.highlight + 1) % mentionState.options.length;
        renderMentionOptions();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        mentionState.highlight = (mentionState.highlight - 1 + mentionState.options.length) % mentionState.options.length;
        renderMentionOptions();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyMention(mentionState.options[mentionState.highlight].name);
        return;
      }
      if (event.key === "Escape") {
        closeMentions();
        return;
      }
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitComment();
    }
  });

  const submitButton = el("button", { class: "primary" }, "Comment");
  async function submitComment() {
    const body = textarea.value.trim();
    if (!body) return;
    submitButton.disabled = true;
    try {
      const result = await api.addComment(id, body);
      textarea.value = "";
      closeMentions();
      const mentioned = result.data.mentionedParticipants.map((participant) => `@${participant.name}`).join(", ");
      toast(mentioned ? `Comment added; notified ${mentioned}` : "Comment added");
      await reload();
    } catch (error) {
      toast(`Comment failed: ${error.message}`, true);
    } finally {
      submitButton.disabled = false;
    }
  }
  submitButton.addEventListener("click", submitComment);

  const bodyTabbar = el("div", { class: "tabbar", role: "tablist", "aria-label": "Description view" }, previewTab, editTab, bodyState);
  const bodyCard = el(
    "div",
    { class: "card detail-body" },
    bodyTabbar,
    bodyPreviewPane,
    bodyEditorPane,
  );

  const titleArea = el("div", { class: "detail-title-area" }, titleInput, titleState);

  const deleteButton = el("button", { class: "danger" }, "Delete item");
  deleteButton.addEventListener("click", async () => {
    if (!window.confirm(`Delete item #${id}? This cannot be undone.`)) return;
    if (document.activeElement === titleInput && titleInput.value.trim() !== lastSavedTitle) await saveTitleNow();
    try {
      await api.deleteItem(id);
      toast("Item deleted");
      navigate("#/board");
    } catch (error) {
      toast(`Delete failed: ${error.message}`, true);
    }
  });

  async function reload() {
    try {
      const detail = await api.getItem(id);
      state.item = detail.data.item;
      state.comments = detail.data.comments;
      state.history = detail.data.history;
      renderDetail();
    } catch (error) {
      container.replaceChildren(errorBanner(error));
      throw error;
    }
  }

  container.replaceChildren(
    el(
      "div",
      { class: "detail" },
      el("div", { class: "detail-head" }, titleArea, deleteButton),
      metaNode,
      el(
        "div",
        { class: "detail-controls card" },
        el("label", {}, "Status", statusSelect),
        el("label", {}, "Priority", prioritySelect),
        el("label", {}, "Assignee", assigneeSelect),
      ),
      bodyCard,
      el("div", { class: "composer card" }, textarea, mentionList, el("div", { class: "composer-actions" }, el("span", { class: "muted" }, "Ctrl+Enter to post"), submitButton)),
      commentsNode,
      historyNode,
    ),
  );

  try {
    await reload();
  } catch {
    // reload() already rendered the error banner.
  }
}

registerView("detail", { title: "Item", href: "#/item", hidden: true, mount });
