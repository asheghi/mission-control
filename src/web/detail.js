// Item detail (Task 15): fields + quick patch controls, markdown-safe body
// and comment rendering (user text is never injected as HTML), comment
// composer with @mentions autocomplete, change history timeline.
import * as api from "./api.js";
import { el, toast, navigate, errorBanner } from "./app.js";
import { registerView } from "./views.js";

const STATUSES = ["todo", "doing", "blocked", "done"];

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

// --- Detail view -------------------------------------------------------------

async function mount(params, container) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    container.replaceChildren(el("div", { class: "placeholder card" }, "Unknown item."));
    return;
  }

  const state = { item: null, comments: [], history: [], participants: [] };
  state.participants = (await api.listParticipants().catch(() => ({ data: [] }))).data;

  const titleNode = el("h1", { class: "detail-title" });
  const metaNode = el("div", { class: "detail-meta muted" });
  const bodyNode = el("div", { class: "detail-body-text" });
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

  function renderDetail() {
    const item = state.item;
    titleArea.replaceChildren(titleNode, titleEditButton);
    titleEditButton.disabled = false;
    titleNode.textContent = item.title;
    metaNode.replaceChildren(
      el("span", { class: "chip" }, item.status),
      ` created ${formatTime(item.createdAt)}`,
      item.closedAt ? ` · closed ${formatTime(item.closedAt)}` : "",
    );
    statusSelect.value = item.status;
    prioritySelect.value = String(item.priority);
    assigneeSelect.value = item.assignee ? String(item.assignee.id) : "";
    renderBody();
    renderComments();
    renderHistory();
  }

  // --- Inline editors for title and description ------------------------------

  function buildInlineEditor(options) {
    const multiline = options.multiline === true;
    const input = multiline
      ? el("textarea", { rows: "6", class: "inline-editor-textarea", placeholder: options.placeholder, "aria-label": options.label })
      : el("input", { type: "text", class: "inline-editor-input", placeholder: options.placeholder, "aria-label": options.label });
    input.value = options.value ?? "";
    const buttonRow = el("div", { class: "inline-editor-actions" });
    const saveButton = el("button", { type: "button", class: "primary" }, "Save");
    const cancelButton = el("button", { type: "button", class: "ghost" }, "Cancel");
    buttonRow.append(el("span", { class: "muted" }, options.hint), cancelButton, saveButton);

    function submit() {
      // Real double-submit guard: block extra PATCHes while one is in flight;
      // onSave calls the callback to re-enable after a rejected save.
      saveButton.disabled = true;
      options.onSave(input.value, () => {
        saveButton.disabled = false;
        input.focus();
      });
    }
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        options.onCancel();
        return;
      }
      const isEnter = event.key === "Enter";
      const wantsSave = multiline ? isEnter && (event.ctrlKey || event.metaKey) : isEnter && !event.shiftKey;
      if (wantsSave && !saveButton.disabled) {
        event.preventDefault();
        submit();
      }
    });
    saveButton.addEventListener("click", submit);
    cancelButton.addEventListener("click", () => options.onCancel());
    // Keyboard users land on the page top once the clicked button is removed;
    // focus once the editor is actually attached (queueMicrotask runs after
    // the caller's replaceChildren).
    queueMicrotask(() => {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    });
    return el("div", { class: "inline-editor" }, input, buttonRow);
  }

  function beginTitleEdit() {
    if (state.item === null || titleEditButton.disabled) return;
    const original = state.item.title;
    titleArea.replaceChildren(
      buildInlineEditor({
        value: original,
        placeholder: "Item title",
        label: "Edit item title",
        hint: "Enter to save · Esc to cancel",
        onCancel: () => {
          renderDetail();
          titleEditButton.focus();
        },
        onSave: (value, resume) => {
          const trimmed = value.trim();
          if (trimmed.length === 0) {
            toast("Title cannot be empty", true);
            resume();
            return;
          }
          if (trimmed === original) {
            renderDetail();
            titleEditButton.focus();
            return;
          }
          patch({ title: trimmed }).then(() => titleEditButton.focus());
          titleEditButton.disabled = true;
        },
      }),
    );
  }

  function beginBodyEdit() {
    if (state.item === null || bodyEditButton.disabled) return;
    const original = state.item.body;
    bodyNode.replaceChildren(
      buildInlineEditor({
        value: original,
        placeholder: "Describe the work (markdown-lite: *italic*, **bold**, `code`, links)",
        label: "Edit item description",
        hint: "Ctrl+Enter to save · Esc to cancel",
        multiline: true,
        onCancel: () => {
          renderDetail();
          bodyEditButton.focus();
        },
        onSave: (value, resume) => {
          if (value === original) {
            renderDetail();
            bodyEditButton.focus();
            return;
          }
          patch({ body: value }).then(() => bodyEditButton.focus());
          bodyEditButton.disabled = true;
        },
      }),
    );
  }

  function renderBody() {
    bodyEditButton.disabled = state.item === null;
    bodyNode.replaceChildren(renderMarkdown(state.item?.body ? state.item.body : "(no description)"));
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
    historyNode.replaceChildren(
      el("h3", {}, "History"),
      ...state.history.map((entry) => {
        const change =
          entry.oldValue === null && entry.newValue === null
            ? entry.field
            : `${entry.field}: ${entry.oldValue ?? "∅"} → ${entry.newValue ?? "∅"}`;
        return el("div", { class: "history-entry" }, el("span", { class: "muted" }, formatTime(entry.createdAt)), " ", change, el("em", { class: "muted" }, ` — ${entry.actorName}`));
      }),
    );
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

  const submitButton = el("button", { class: "primary" }, "Comment");  async function submitComment() {
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

  const titleEditButton = el("button", { class: "ghost ghost--small", "aria-label": "Edit title" }, "Edit title");
  titleEditButton.addEventListener("click", beginTitleEdit);
  const bodyEditButton = el("button", { class: "ghost ghost--small", "aria-label": "Edit description" }, "Edit description");
  bodyEditButton.addEventListener("click", beginBodyEdit);
  const titleArea = el("div", { class: "detail-title-area" }, titleNode, titleEditButton);
  const bodyCard = el(
    "div",
    { class: "card detail-body" },
    el("div", { class: "detail-body-head" }, bodyEditButton),
    bodyNode,
  );

  const deleteButton = el("button", { class: "danger" }, "Delete item");
  deleteButton.addEventListener("click", async () => {
    if (!window.confirm(`Delete item #${id}? This cannot be undone.`)) return;
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
