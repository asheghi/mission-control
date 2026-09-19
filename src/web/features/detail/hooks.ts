import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import * as apiModule from "../../api.js";
import { isTerminalAuthError } from "../../public-errors.js";
import {
  commentFromResponse,
  detailFromResponse,
  itemFromDetailResponse,
  labelFromResponse,
  labelsFromResponse,
  mentionedNamesFromResponse,
  participantsFromResponse,
} from "./data";
import { checkLabelAdd, deterministicLabelColor, insertMention, mentionTrigger, normalizeLabelSet } from "./helpers";
import { createSettledBurstQueue } from "./queue";
import type { SettledBurstQueue } from "./queue";
import {
  BODY_MAX_LENGTH,
  DETAIL_BODY_NOTICE,
  DETAIL_COMMENT_NOTICE,
  DETAIL_DELETE_ERROR,
  DETAIL_DELETE_FLUSH_ERROR,
  DETAIL_LABEL_ERROR,
  DETAIL_LABEL_LIMIT_NOTICE,
  DETAIL_LOAD_ERROR,
  DETAIL_NOT_FOUND_NOTICE,
  DETAIL_OPTIONS_NOTICE,
  DETAIL_SAVE_ERROR,
  DETAIL_TITLE_LIMIT_NOTICE,
  DETAIL_TITLE_NOTICE,
  TITLE_MAX_LENGTH,
} from "./types";
import type {
  BodyTab,
  DetailComment,
  DetailItem,
  DetailLabel,
  DetailParticipant,
  DetailPayload,
  DetailState,
  DetailViewProps,
  MentionState,
} from "./types";

const TITLE_DELAY_MS = 600;
const BODY_DELAY_MS = 700;
const NEW_LABEL_COLORS = ["#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899"] as const;

/**
 * How many reads a comment may follow a successful POST with. The first read
 * can be started before the comment write lands on the server, and a read is
 * always allowed to lose the race with a *newer* accepted mutation, so a
 * bounded number of attempts is what makes the comment appear reliably instead
 * of depending on one read winning that race.
 */
const COMMENT_REFRESH_ATTEMPTS = 3;

interface ApiResponse { readonly data: unknown }
interface DetailApi {
  getItem: (id: number) => Promise<ApiResponse>;
  listParticipants: () => Promise<ApiResponse>;
  listLabels: () => Promise<ApiResponse>;
  updateItem: (id: number, patch: Record<string, unknown>) => Promise<unknown>;
  createItem: (input: { title: string; parentId: number }) => Promise<unknown>;
  createLabel: (input: { name: string; color: string }) => Promise<unknown>;
  addComment: (id: number, body: string) => Promise<unknown>;
  deleteItem: (id: number) => Promise<unknown>;
}
const api = apiModule as DetailApi;

/** The three item fields the detail view mutates one at a time. */
type FieldName = "status" | "priority" | "assigneeId";

/** The item value a field's intent maps onto (`assigneeId` → `assignee`). */
type FieldValue = DetailItem["status"] | DetailItem["priority"] | number | null;

interface FieldPatch {
  readonly status?: DetailItem["status"];
  readonly priority?: DetailItem["priority"];
  readonly assigneeId?: number | null;
}

interface AcceptedItemPatch extends FieldPatch {
  readonly title?: string;
  readonly body?: string;
  readonly labels?: readonly DetailLabel[];
}

const FIELD_NAMES: readonly FieldName[] = ["status", "priority", "assigneeId"];

function validItemId(value: unknown): number | null {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function readBodyTab(id: number | null): BodyTab {
  if (id === null) return "preview";
  try {
    return sessionStorage.getItem(`wb-body-tab-${id}`) === "edit" ? "edit" : "preview";
  } catch {
    return "preview";
  }
}

/** Read one mutated field off a patch, or undefined when that field is absent. */
function patchValue(patch: FieldPatch, field: FieldName): FieldValue | undefined {
  if (field === "status") return patch.status;
  if (field === "priority") return patch.priority;
  return patch.assigneeId;
}

/** Apply a patch to the fields it actually carries, leaving the rest untouched. */
function withFields(item: DetailItem, patch: FieldPatch, participants: readonly DetailParticipant[]): DetailItem {
  let next = item;
  if (patch.status !== undefined) next = { ...next, status: patch.status };
  if (patch.priority !== undefined) next = { ...next, priority: patch.priority };
  if (patch.assigneeId !== undefined) {
    const assignee = patch.assigneeId === null
      ? null
      : participants.find((participant) => participant.id === patch.assigneeId) ?? null;
    next = { ...next, assignee };
  }
  return next;
}

/**
 * Re-apply one field's latest local intent over an authoritative item, so a
 * response that arrives after a newer edit cannot restore the older value.
 */
function reapplyIntent(
  item: DetailItem,
  field: FieldName,
  intent: FieldValue | undefined,
  participants: readonly DetailParticipant[],
): DetailItem {
  if (intent === undefined) return item;
  if (field === "status") return { ...item, status: intent as DetailItem["status"] };
  if (field === "priority") return { ...item, priority: intent as DetailItem["priority"] };
  return withFields(item, { assigneeId: intent as number | null }, participants);
}

/**
 * Re-apply EVERY pending quick-field intent over a payload the server authored.
 *
 * A PATCH response is authoritative only for the field it wrote. The reply to a
 * title or label write carries a whole item too, and it echoes whatever the
 * other quick fields held when *that* request ran — so publishing it verbatim
 * would roll a newer status, priority, or assignee choice backwards. Every
 * payload coming from the server therefore goes through this gate, which
 * restores the latest local intent of each field that still has one.
 */
function reconcileItem(
  item: DetailItem,
  intents: ReadonlyMap<FieldName, FieldValue | undefined>,
  participants: readonly DetailParticipant[],
): DetailItem {
  let next = item;
  for (const field of FIELD_NAMES) {
    next = reapplyIntent(next, field, intents.get(field), participants);
  }
  return next;
}

/** `labels: []` is not an update, so the label queue signals a failure with this. */
class LabelWriteFailed extends Error {}

/** One accepted mutation, keyed by kind. */
function sameMutation(left: MutationMark, right: MutationMark): boolean {
  return left.kind === right.kind && left.generation === right.generation;
}

interface MutationMark {
  readonly kind: "item" | "comment";
  readonly generation: number;
}

/** Oldest first, by id, so an appended comment lands at the end of the thread. */
function byCommentOrder(left: DetailComment, right: DetailComment): number {
  return left.id - right.id;
}

export function useDetail({ params, refreshGeneration, onAuthenticationFailure }: DetailViewProps): DetailState {
  const id = validItemId(params.id);
  const mountedRef = useRef(true);
  const terminalRef = useRef(false);
  const authFailureRef = useRef(onAuthenticationFailure);
  /**
   * Bumped whenever a write is accepted. A GET started before that bump carries
   * an older generation, so its response is stale by definition and must not be
   * published over state the server has already accepted.
   */
  const appliedGenerationRef = useRef(0);
  /** The mutation marks carried by the last authoritative payload published. */
  const lastAppliedMarkRef = useRef<MutationMark>({ kind: "item", generation: 0 });
  const fetchSequenceRef = useRef(0);
  const itemRef = useRef<DetailItem | null>(null);
  const participantsRef = useRef<readonly DetailParticipant[]>([]);
  const rosterLoadedRef = useRef(false);
  const labelsRef = useRef<readonly DetailLabel[]>([]);
  const selectedLabelsRef = useRef<readonly string[]>([]);
  const titleDraftRef = useRef("");
  const bodyDraftRef = useRef("");
  const titleFocusedRef = useRef(false);
  const bodyFocusedRef = useRef(false);
  const titleTimerRef = useRef<number | null>(null);
  const bodyTimerRef = useRef<number | null>(null);
  const deleteConfirmedRef = useRef(false);

  const [item, setItem] = useState<DetailItem | null>(null);
  const [comments, setComments] = useState<DetailState["comments"]>([]);
  const [history, setHistory] = useState<DetailState["history"]>([]);
  const [parent, setParentState] = useState<DetailItem | null>(null);
  const [subtasks, setSubtasks] = useState<readonly DetailItem[]>([]);
  const [participants, setParticipants] = useState<readonly DetailParticipant[]>([]);
  const [labels, setLabels] = useState<readonly DetailLabel[]>([]);
  const [selectedLabelNames, setSelectedLabelNames] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(id !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [notFound, setNotFound] = useState(id === null);
  const [error, setError] = useState("");
  const [notice, setNoticeState] = useState("");
  const [announcement, setAnnouncementState] = useState("");
  const [titleDraft, setTitleDraftState] = useState("");
  const [titleStatus, setTitleStatusState] = useState("");
  const [bodyDraft, setBodyDraftState] = useState("");
  const [bodyStatus, setBodyStatusState] = useState("");
  const [bodyTab, setBodyTabState] = useState<BodyTab>(() => readBodyTab(id));
  const [commentDraft, setCommentDraftState] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [labelsBusy, setLabelsBusy] = useState(false);
  const [fieldsBusy, setFieldsBusy] = useState(false);
  const [relationshipsBusy, setRelationshipsBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<ReadonlySet<number>>(new Set());

  // One announcement channel: a status write records the message, and the
  // single polite live region renders it. Title/body statuses stay inline next
  // to their own control, so they are visible without being announced twice.
  const announce = useCallback((message: string): void => {
    if (message === "") return;
    setAnnouncementState(message);
  }, []);
  const setNotice = useCallback((value: string): void => {
    setNoticeState(value);
    announce(value);
  }, [announce]);
  const setTitleStatus = useCallback((value: string): void => {
    setTitleStatusState(value);
    if (value !== "" && value !== "Edited") announce(`Title: ${value}`);
  }, [announce]);
  const setBodyStatus = useCallback((value: string): void => {
    setBodyStatusState(value);
    if (value !== "" && value !== "Edited") announce(`Description: ${value}`);
  }, [announce]);
  /**
   * A rejected label write is final, not a status update: it must survive the
   * refresh that follows it, which clears statuses because the value it repaints
   * is authoritative. Keeping it separate is what guarantees the failure stays
   * on screen.
   */
  const setLabelNotice = useCallback((value: string): void => {
    setLabelNoticeState(value);
    if (value !== "") announce(value);
  }, [announce]);

  authFailureRef.current = onAuthenticationFailure;
  const active = useCallback(() => mountedRef.current && !terminalRef.current, []);

  /** Every queue that must stop when the session or the view ends. */
  const stopWritesRef = useRef<(() => void)[]>([]);

  const failAuthentication = useCallback((caught: unknown): boolean => {
    if (!isTerminalAuthError(caught)) return false;
    if (!terminalRef.current) {
      terminalRef.current = true;
      // Stop every in-flight and pending write: the session is over, and later
      // edits must not be replayed against a rejected credential.
      fetchSequenceRef.current += 1;
      for (const stop of stopWritesRef.current) stop();
      authFailureRef.current();
    }
    return true;
  }, []);

  const publishItem = useCallback((next: DetailItem): void => {
    itemRef.current = next;
    setItem(next);
  }, []);

  const publishParticipants = useCallback((next: readonly DetailParticipant[]): void => {
    participantsRef.current = next;
    rosterLoadedRef.current = true;
    setParticipants(next);
  }, []);

  const publishLabels = useCallback((next: readonly DetailLabel[]): void => {
    labelsRef.current = next;
    setLabels(next);
  }, []);

  const publishSelectedLabels = useCallback((next: readonly string[]): void => {
    selectedLabelsRef.current = next;
    setSelectedLabelNames(next);
  }, []);

  /**
   * Apply an authoritative payload, preserving drafts that are focused or
   * differ from the last known server value. A focused editor keeps whatever
   * the user is typing; an already-diverged draft is a pending intent and is not
   * discarded just because a read landed.
   *
   * `labelSelection` decides who owns the label chips: `authoritative` publishes
   * the server's own set (used while reconciling a rejected label write), while
   * the default defers to a label write that is still in flight and owns the
   * selection until it settles.
   */
  const applyDetail = useCallback((
    detail: DetailPayload,
    options: { readonly labelSelection?: "authoritative" } = {},
  ): void => {
    const previous = itemRef.current;
    const titleDirty = previous !== null && titleDraftRef.current !== previous.title;
    const bodyDirty = previous !== null && bodyDraftRef.current !== previous.body;
    publishItem(reconcileItem(detail.item, fieldIntentRef.current, participantsRef.current));
    setComments(detail.comments);
    setHistory(detail.history);
    setParentState(detail.parent);
    setSubtasks(detail.subtasks);
    if (!titleDirty && !titleFocusedRef.current) {
      titleDraftRef.current = detail.item.title;
      setTitleDraftState(detail.item.title);
      setTitleStatus("");
    }
    if (!bodyDirty && !bodyFocusedRef.current) {
      bodyDraftRef.current = detail.item.body;
      setBodyDraftState(detail.item.body);
      setBodyStatus("");
    }
    if (options.labelSelection === "authoritative" || !labelQueueRef.current?.isBusy()) {
      publishSelectedLabels(detail.item.labels.map((label) => label.name));
    }
    setNotFound(false);
    setError("");
  }, [publishItem, publishSelectedLabels, setBodyStatus, setTitleStatus]);

  /**
   * Authoritative read. `mutation` is the write generation this read was issued
   * under: the payload it carries describes the item as of that generation, so
   * a newer local intent is re-applied over it and a read whose generation no
   * longer matches is a *confirmed* read rather than an overwrite.
   *
   * Returns true only when this read actually published an item payload; every
   * other outcome — stale payload, rejected request, unusable body, unmounted
   * view — returns false and leaves the caller free to retry.
   */
  const refresh = useCallback(async (
    background = false,
    mutation?: MutationMark,
    options: { readonly forceLabelSelection?: boolean } = {},
  ): Promise<boolean> => {
    if (id === null || !active()) return false;
    const generation = mutation?.generation ?? appliedGenerationRef.current;
    const sequence = ++fetchSequenceRef.current;
    if (background && itemRef.current !== null) setRefreshing(true);
    else setLoading(true);
    setError("");
    setLabelNotice("");
    const [detailResult, participantResult, labelResult] = await Promise.allSettled([
      api.getItem(id), api.listParticipants(), api.listLabels(),
    ]);
    if (!active() || sequence !== fetchSequenceRef.current) return false;
    // Keep the label label's own outcome readable inside the label queue's
    // error path, which needs to know whether this read replaced the chips.
    labelReconciledRef.current = options.forceLabelSelection === true && generation >= appliedGenerationRef.current;
    // A write was accepted after this read began, but the read still describes
    // every accepted write up to the mutation the caller named.
    const supersededByWrite = generation < appliedGenerationRef.current;
    for (const result of [detailResult, participantResult, labelResult]) {
      if (result.status === "rejected" && failAuthentication(result.reason)) return false;
    }
    if (participantResult.status === "fulfilled") {
      const nextParticipants = participantsFromResponse(participantResult.value);
      if (nextParticipants !== null) publishParticipants(nextParticipants);
    }
    if (labelResult.status === "fulfilled") {
      const nextLabels = labelsFromResponse(labelResult.value);
      if (nextLabels !== null) publishLabels(nextLabels);
    }
    if (participantResult.status === "rejected" || labelResult.status === "rejected"
      || (participantResult.status === "fulfilled" && participantsFromResponse(participantResult.value) === null)
      || (labelResult.status === "fulfilled" && labelsFromResponse(labelResult.value) === null)) {
      setNotice(DETAIL_OPTIONS_NOTICE);
    }
    if (detailResult.status === "rejected") {
      const caught = detailResult.reason;
      if (caught instanceof apiModule.ApiError && caught.status === 404) {
        setNotFound(true);
        setError("");
      } else if (itemRef.current === null) setError(DETAIL_LOAD_ERROR);
      else setNotice(supersededByWrite ? DETAIL_NOT_FOUND_NOTICE : DETAIL_LOAD_ERROR);
      setLoading(false);
      setRefreshing(false);
      return false;
    }
    const detail = detailFromResponse(detailResult.value);
    if (detail === null) {
      if (itemRef.current === null) setError(DETAIL_LOAD_ERROR);
      else setNotice(DETAIL_LOAD_ERROR);
      setLoading(false);
      setRefreshing(false);
      return false;
    }
    applyDetail(detail, options.forceLabelSelection === true ? { labelSelection: "authoritative" } : {});
    lastAppliedMarkRef.current = { kind: mutation?.kind ?? "item", generation };
    setLoading(false);
    setRefreshing(false);
    return true;
  }, [active, applyDetail, failAuthentication, id, publishLabels, publishParticipants, setLabelNotice, setNotice]);

  /** Record an accepted write, so any older in-flight read is known to be stale. */
  const markApplied = useCallback((kind: MutationMark["kind"]): MutationMark => {
    appliedGenerationRef.current += 1;
    return { kind, generation: appliedGenerationRef.current };
  }, []);

  // --- title and body: first/latest autosave --------------------------------

  const applyReturnedItem = useCallback((response: unknown, fields: AcceptedItemPatch): void => {
    const returned = itemFromDetailResponse(response);
    const current = itemRef.current;
    if (current === null) {
      if (returned !== null && returned.id === id) {
        publishItem(reconcileItem(returned, fieldIntentRef.current, participantsRef.current));
      }
      return;
    }

    // A mutation response is authoritative only for the fields in its PATCH.
    // Publishing its whole item can erase a newer external change that already
    // arrived through SSE while this request was in flight.
    let next = withFields(current, fields, participantsRef.current);
    if (fields.title !== undefined) next = { ...next, title: returned?.title ?? fields.title };
    if (fields.body !== undefined) next = { ...next, body: returned?.body ?? fields.body };
    if (fields.labels !== undefined) next = { ...next, labels: returned?.labels ?? fields.labels };
    publishItem(reconcileItem(next, fieldIntentRef.current, participantsRef.current));
  }, [id, publishItem]);

  const titleQueueRef = useRef<SettledBurstQueue<string> | null>(null);
  if (titleQueueRef.current === null) {
    titleQueueRef.current = createSettledBurstQueue(async (value: string) => {
      if (id === null || !active()) return;
      setTitleStatus("Saving…");
      try {
        const response = await api.updateItem(id, { title: value });
        if (!active()) return;
        markApplied("item");
        // The item this write produced is authoritative for the title, so the
        // payload published over any unrelated pending intent carries it.
        applyReturnedItem(response, { title: value });
        setTitleStatus(titleDraftRef.current === value ? "Saved ✓" : "Edited");
      } catch (caught: unknown) {
        if (!active() || failAuthentication(caught)) return;
        setTitleStatus("Not saved");
        setNotice(DETAIL_SAVE_ERROR);
        throw caught;
      }
    });
  }

  const bodyQueueRef = useRef<SettledBurstQueue<string> | null>(null);
  if (bodyQueueRef.current === null) {
    bodyQueueRef.current = createSettledBurstQueue(async (value: string) => {
      if (id === null || !active()) return;
      setBodyStatus("Saving…");
      try {
        const response = await api.updateItem(id, { body: value });
        if (!active()) return;
        markApplied("item");
        applyReturnedItem(response, { body: value });
        setBodyStatus(bodyDraftRef.current === value ? "Saved ✓" : "Edited");
      } catch (caught: unknown) {
        if (!active() || failAuthentication(caught)) return;
        setBodyStatus("Not saved");
        setNotice(DETAIL_SAVE_ERROR);
        throw caught;
      }
    });
  }

  /**
   * Why the title draft cannot be sent, or null when it can. The server's own
   * limit is mirrored here so an over-long title is reported before it becomes
   * a 400, and the empty-title guard is preserved for edited and unedited
   * drafts alike.
   */
  const titleRejection = useCallback((): "empty" | "long" | null => {
    const value = titleDraftRef.current.trim();
    if (value === "") return "empty";
    if (value.length > TITLE_MAX_LENGTH) return "long";
    return null;
  }, []);

  const queueTitle = useCallback(async (): Promise<boolean> => {
    if (titleTimerRef.current !== null) {
      window.clearTimeout(titleTimerRef.current);
      titleTimerRef.current = null;
    }
    const value = titleDraftRef.current.trim();
    const rejection = titleRejection();
    if (rejection !== null) {
      setTitleStatus(rejection === "empty" ? DETAIL_TITLE_NOTICE : DETAIL_TITLE_LIMIT_NOTICE);
      return false;
    }
    if (value === itemRef.current?.title && !titleQueueRef.current?.isBusy()) {
      setTitleStatus("");
      return true;
    }
    await titleQueueRef.current?.schedule(value);
    return true;
  }, [titleRejection, setTitleStatus]);

  const queueBody = useCallback(async (): Promise<boolean> => {
    if (bodyTimerRef.current !== null) {
      window.clearTimeout(bodyTimerRef.current);
      bodyTimerRef.current = null;
    }
    const value = bodyDraftRef.current;
    if (value.length > BODY_MAX_LENGTH) {
      setBodyStatus(DETAIL_BODY_NOTICE);
      return false;
    }
    if (value === itemRef.current?.body && !bodyQueueRef.current?.isBusy()) {
      setBodyStatus("");
      return true;
    }
    await bodyQueueRef.current?.schedule(value);
    return true;
  }, [setBodyStatus]);

  const flushTitle = useCallback(async (): Promise<void> => {
    if (id === null || !active()) return;
    // A rejected burst is reported by its own queue; the flush only cares that
    // the pending value is no longer queued.
    await queueTitle().catch(() => undefined);
  }, [active, id, queueTitle]);

  // Mirrors flushTitle. The description debounce is longer than the title's, so
  // without this a description typed just before navigating away was still
  // sitting in its timer when the view unmounted and was discarded.
  const flushBody = useCallback(async (): Promise<void> => {
    if (id === null || !active()) return;
    await queueBody().catch(() => undefined);
  }, [active, id, queueBody]);

  const setTitleDraft = useCallback((value: string): void => {
    // Kept inside the server's own bounds: `titleSchema` is a trimmed 1-256
    // character string, so a value the control cannot send must not be typed
    // into it in the first place.
    const next = value.length > TITLE_MAX_LENGTH ? value.slice(0, TITLE_MAX_LENGTH) : value;
    titleDraftRef.current = next;
    setTitleDraftState(next);
    // "Edited" must not be announced: it changes on every keystroke.
    setTitleStatusState(next.trim() === "" ? DETAIL_TITLE_NOTICE : "Edited");
    if (titleTimerRef.current !== null) window.clearTimeout(titleTimerRef.current);
    titleTimerRef.current = window.setTimeout(() => { void queueTitle().catch(() => undefined); }, TITLE_DELAY_MS);
  }, [queueTitle]);

  const setBodyDraft = useCallback((value: string): void => {
    // `bodySchema` caps the body at 100000 characters; the editor enforces the
    // same bound so the draft can always be sent as it stands.
    const next = value.length > BODY_MAX_LENGTH ? value.slice(0, BODY_MAX_LENGTH) : value;
    bodyDraftRef.current = next;
    setBodyDraftState(next);
    setBodyStatusState("Edited");
    if (bodyTimerRef.current !== null) window.clearTimeout(bodyTimerRef.current);
    bodyTimerRef.current = window.setTimeout(() => { void queueBody().catch(() => undefined); }, BODY_DELAY_MS);
  }, [queueBody]);

  const setBodyTab = useCallback((tab: BodyTab): void => {
    setBodyTabState(tab);
    try { if (id !== null) sessionStorage.setItem(`wb-body-tab-${id}`, tab); } catch { /* storage can be unavailable */ }
    void queueBody().catch(() => undefined);
  }, [id, queueBody]);

  // --- status / priority / assignee: per-field first/latest ------------------

  /** One queue per field, so a status write never blocks an assignee write. */
  const fieldQueuesRef = useRef(new Map<FieldName, SettledBurstQueue<FieldPatch>>());
  /**
   * The latest local intent per field. An entry exists exactly while a write
   * carrying that value is queued or in flight, and is removed the moment the
   * write that represents it is confirmed — accepted, or refused as this
   * field's current intent. It is what lets a newer choice survive every
   * response that crosses it on the wire.
   */
  const fieldIntentRef = useRef(new Map<FieldName, FieldValue | undefined>());
  /** Monotonic per-field write counter; a burst cannot finish after a later one. */
  const fieldWriteSeqRef = useRef(new Map<FieldName, number>());
  /** Bumped when the label draft is refused, so the fieldset can explain why. */
  const [labelNotice, setLabelNoticeState] = useState("");
  /** Set by a reconciling refresh that is allowed to publish the label chips. */
  const labelReconciledRef = useRef(false);

  const ensureFieldQueue = useCallback((field: FieldName): SettledBurstQueue<FieldPatch> => {
    const existing = fieldQueuesRef.current.get(field);
    if (existing !== undefined) return existing;
    const queue = createSettledBurstQueue<FieldPatch>(async (patch) => {
      if (id === null || !active()) return;
      const value = patchValue(patch, field);
      const writeSeq = (fieldWriteSeqRef.current.get(field) ?? 0) + 1;
      fieldWriteSeqRef.current.set(field, writeSeq);
      try {
        const response = await api.updateItem(id, { ...patch });
        if (!active()) return;
        markApplied("item");
        // This write is confirmed for its own field, so the intent that asked
        // for it is settled — but only if no newer write for the same field has
        // been enqueued since, which would still be represented on screen by a
        // later intent of its own.
        if (fieldWriteSeqRef.current.get(field) === writeSeq
          && fieldIntentRef.current.get(field) === value) {
          fieldIntentRef.current.delete(field);
        }
        applyReturnedItem(response, patch);
        if (fieldIntentRef.current.get(field) === undefined) setNotice("Saved.");
      } catch (caught: unknown) {
        if (!active() || failAuthentication(caught)) return;
        const settled = fieldWriteSeqRef.current.get(field) === writeSeq;
        if (settled && fieldIntentRef.current.get(field) === value) {
          // Only the intent this write carried is cleared. A newer local choice
          // is still pending and must stay on screen.
          fieldIntentRef.current.delete(field);
        }
        setNotice(DETAIL_SAVE_ERROR);
        // Roll the field back to authoritative state. The refresh receives no
        // mutation mark: it may have been in flight before this write was even
        // attempted, in which case its payload is not guaranteed to describe
        // this item, and the payload is worth having then anyway.
        const published = await refresh(true);
        if (published) {
          // The payload carries every pending intent, so a newer choice that
          // arrived while this write failed is still what the user sees.
          if (settled && active()) setNotice(DETAIL_SAVE_ERROR);
        } else if (settled && active()) {
          // No authoritative payload arrived, so the rejected value is undone
          // here: leaving it on screen would claim a write that never happened.
          const current = itemRef.current;
          if (current !== null) {
            publishItem(reapplyIntent(current, field, fieldIntentRef.current.get(field), participantsRef.current));
          }
        }
        if (settled) throw caught;
      }
    });
    fieldQueuesRef.current.set(field, queue);
    return queue;
  }, [active, applyReturnedItem, failAuthentication, id, markApplied, publishItem, refresh, setNotice]);

  const publishFieldsBusy = useCallback((): void => {
    let busy = false;
    for (const queue of fieldQueuesRef.current.values()) if (queue.isBusy()) busy = true;
    setFieldsBusy(busy);
  }, []);

  const patchField = useCallback((patch: FieldPatch): void => {
    if (id === null || !active()) return;
    const fields = FIELD_NAMES.filter((field) => patchValue(patch, field) !== undefined);
    if (fields.length === 0) return;
    if (patch.assigneeId !== undefined && patch.assigneeId !== null
      && !participantsRef.current.some((participant) => participant.id === patch.assigneeId)) {
      setNotice("Choose a valid assignee.");
      return;
    }
    // Optimistic intent: apply locally at once, per field, so a rapid change to
    // one control never shows another control's stale value.
    const current = itemRef.current;
    if (current !== null) {
      for (const field of fields) fieldIntentRef.current.set(field, patchValue(patch, field));
      publishItem(withFields(current, patch, participantsRef.current));
    }
    for (const field of fields) {
      const queue = ensureFieldQueue(field);
      const intent = patchValue(patch, field);
      const single: FieldPatch = field === "status"
        ? { status: intent as DetailItem["status"] }
        : field === "priority"
          ? { priority: intent as DetailItem["priority"] }
          : { assigneeId: intent as number | null };
      void queue.schedule(single)
        .catch(() => undefined)
        .finally(() => { if (mountedRef.current && !terminalRef.current) publishFieldsBusy(); });
    }
    publishFieldsBusy();
  }, [active, ensureFieldQueue, id, publishFieldsBusy, publishItem, setNotice]);

  // --- labels ----------------------------------------------------------------

  const labelQueueRef = useRef<SettledBurstQueue<readonly string[]> | null>(null);
  if (labelQueueRef.current === null) {
    labelQueueRef.current = createSettledBurstQueue(async (names) => {
      if (id === null || !active()) return;
      try {
        // Create only labels the server does not already have. Each create
        // response carries the real id; a 409 means someone else created it
        // concurrently, so the authoritative list is re-read instead of
        // inventing an id for it.
        for (const name of names) {
          if (labelsRef.current.some((label) => label.name === name)) continue;
          const color = deterministicLabelColor(name, NEW_LABEL_COLORS);
          let conflict = false;
          try {
            const created = await api.createLabel({ name, color });
            if (!active()) return;
            const label = labelFromResponse(created);
            if (label === null) throw new Error("Label create returned an unusable payload");
            if (!labelsRef.current.some((candidate) => candidate.name === label.name)) {
              publishLabels([...labelsRef.current, label]);
            }
          } catch (caught: unknown) {
            if (failAuthentication(caught)) return;
            if (!(caught instanceof apiModule.ApiError) || caught.status !== 409) throw caught;
            conflict = true;
          }
          if (conflict) {
            // Authoritative recovery: the 409 body tells us nothing about the
            // existing label's id, so ask the server for the real list.
            const response = await api.listLabels();
            if (!active()) return;
            const authoritative = labelsFromResponse(response);
            if (authoritative === null) throw new Error("Label list returned an unusable payload");
            publishLabels(authoritative);
          }
        }
        const response = await api.updateItem(id, { labels: names });
        if (!active()) return;
        // The accepted item owns the selection from here on, whatever the queue
        // reports while this burst finishes.
        markApplied("item");
        const returned = itemFromDetailResponse(response);
        const acceptedLabels = returned !== null && returned.id === id
          ? returned.labels
          : labelsRef.current.filter((label) => names.includes(label.name));
        const mergedLabels = new Map(labelsRef.current.map((label) => [label.id, label]));
        for (const label of acceptedLabels) mergedLabels.set(label.id, label);
        publishLabels([...mergedLabels.values()]);
        applyReturnedItem(response, { labels: acceptedLabels });
        publishSelectedLabels(names);
        setNotice("Labels saved.");
      } catch (caught: unknown) {
        if (!active() || failAuthentication(caught)) return;
        if (!(caught instanceof LabelWriteFailed) && !(caught instanceof apiModule.ApiError)) {
          // A create or PATCH that failed for any other reason still leaves the
          // optimistic selection unverified.
        }
        setLabelNotice(caught instanceof LabelWriteFailed ? caught.message : DETAIL_LABEL_ERROR);
        // A failed create/PATCH leaves the optimistic selection unverified, so
        // it is discarded rather than kept on screen as though it had saved.
        // The refresh below is *forced* to publish the server's own label set
        // even though this queue still counts as busy: reconciliation must not
        // be blocked by the very write it is recovering from.
        try {
          const response = await api.listLabels();
          if (!active()) return;
          const authoritative = labelsFromResponse(response);
          if (authoritative !== null) publishLabels(authoritative);
        } catch (error: unknown) {
          if (failAuthentication(error)) return;
        }
        labelReconciledRef.current = false;
        const published = await refresh(true, undefined, { forceLabelSelection: true });
        if (!published || !labelReconciledRef.current) {
          // The authoritative payload never arrived, so the selection is reset
          // from what is actually known: the item's own labels, filtered to the
          // vocabulary the server has confirmed. A rejected label must never
          // remain visible.
          if (active()) {
            const known = new Set(labelsRef.current.map((label) => label.name));
            publishSelectedLabels((itemRef.current?.labels ?? []).map((label) => label.name).filter((name) => known.has(name)));
          }
        }
        if (!(caught instanceof LabelWriteFailed)) throw caught;
      }
    });
  }

  const applyLabelNames = useCallback((names: readonly string[]): void => {
    const next = normalizeLabelSet(names);
    publishSelectedLabels(next);
    void labelQueueRef.current?.schedule(next)
      .catch(() => undefined)
      .finally(() => { if (mountedRef.current && !terminalRef.current) setLabelsBusy(labelQueueRef.current?.isBusy() ?? false); });
    setLabelsBusy(true);
  }, [publishSelectedLabels]);

  const addLabel = useCallback((raw: string): void => {
    const check = checkLabelAdd(raw, selectedLabelsRef.current);
    if (!check.ok) {
      setNotice(check.reason);
      return;
    }
    setLabelDraft("");
    applyLabelNames([...selectedLabelsRef.current, check.name]);
  }, [applyLabelNames, setNotice]);

  const removeLabel = useCallback((name: string): void => {
    setLabelNotice("");
    applyLabelNames(selectedLabelsRef.current.filter((candidate) => candidate !== name));
  }, [applyLabelNames, setLabelNotice]);

  // --- comments and mentions -------------------------------------------------

  const setCommentDraft = useCallback((value: string, caret: number): void => {
    setCommentDraftState(value);
    const trigger = mentionTrigger(value, caret);
    if (trigger === null) {
      setMention(null);
      return;
    }
    const query = trigger.query.toLowerCase();
    const options = participantsRef.current
      .filter((participant) => participant.name.toLowerCase().startsWith(query)).slice(0, 6);
    setMention(options.length === 0 ? null : { trigger, options, activeIndex: 0 });
  }, []);

  /**
   * Insert the chosen mention exactly once. The option element handles both
   * mousedown and click, so the mention is only applied when the trigger is
   * still present in the current draft — a second call finds no trigger and is
   * a no-op instead of inserting a duplicate.
   */
  const chooseMention = useCallback((participant: DetailParticipant): { value: string; caret: number } | null => {
    const current = mention;
    if (current === null) return null;
    const existing = mentionTrigger(commentDraft, current.trigger.start + current.trigger.query.length + 1);
    if (existing === null || existing.start !== current.trigger.start) {
      setMention(null);
      return null;
    }
    const result = insertMention(
      commentDraft,
      current.trigger.start + current.trigger.query.length + 1,
      current.trigger,
      participant.name,
    );
    setCommentDraftState(result.value);
    setMention(null);
    return result;
  }, [commentDraft, mention]);

  /**
   * Make an accepted comment visible.
   *
   * The POST reply is appended when it carries the comment — the server bumps
   * the item's `updated_at` on comment creation, so a read is not guaranteed to
   * include it. Dupes are impossible: `appendComment` drops a comment already
   * in the list, and a read replaces the list wholesale. The refresh loop then
   * runs until an authoritative payload is *published*; a read discarded
   * because an unrelated mutation was accepted while it was in flight is
   * retried rather than treated as the last word. The comment's own mutation
   * mark is not lowered by those unrelated writes, so the loop cannot be
   * silently satisfied by a payload that predates the comment.
   */
  const confirmComment = useCallback(async (mark: MutationMark, accepted: DetailComment | null): Promise<void> => {
    if (accepted !== null) {
      setComments((current) => (current.some((comment) => comment.id === accepted.id)
        ? current
        : [...current, accepted].sort(byCommentOrder)));
    }
    for (let attempt = 0; attempt < COMMENT_REFRESH_ATTEMPTS; attempt += 1) {
      if (!active()) return;
      if (lastAppliedMarkRef.current.kind === "comment"
        && lastAppliedMarkRef.current.generation >= mark.generation) return;
      const published = await refresh(true, mark);
      if (published && lastAppliedMarkRef.current.kind === "comment"
        && lastAppliedMarkRef.current.generation >= mark.generation) {
        return;
      }
    }
  }, [active, refresh]);

  const submitComment = useCallback((): void => {
    if (id === null || !active() || commentBusy) return;
    const body = commentDraft.trim();
    if (body === "") return;
    setCommentBusy(true);
    void api.addComment(id, body).then((response) => {
      if (!active()) return;
      const mentioned = mentionedNamesFromResponse(response);
      const accepted = commentFromResponse(response);
      const mark = markApplied("comment");
      // The draft is cleared only here, after the server accepted the write.
      setCommentDraftState("");
      setMention(null);
      setNotice(mentioned === null || mentioned.length === 0 ? "Comment added." : `Comment added; notified ${mentioned.map((name) => `@${name}`).join(", ")}.`);
      void confirmComment(mark, accepted);
    }).catch((caught: unknown) => {
      if (!active() || failAuthentication(caught)) return;
      setNotice(DETAIL_COMMENT_NOTICE);
    }).finally(() => {
      if (active()) setCommentBusy(false);
    });
  }, [active, commentBusy, commentDraft, confirmComment, failAuthentication, id, markApplied, setNotice]);

  // --- relationships ---------------------------------------------------------

  const setParent = useCallback((parentId: number | null): void => {
    if (id === null || !active() || relationshipsBusy) return;
    setRelationshipsBusy(true);
    void api.updateItem(id, { parentId }).then(() => {
      if (!active()) return;
      markApplied("item");
      setNotice(parentId === null ? "Parent removed." : `Parent set to item #${parentId}.`);
      void refresh(true);
    }).catch((caught: unknown) => {
      if (!active() || failAuthentication(caught)) return;
      setNotice(caught instanceof apiModule.ApiError && caught.status === 400
        ? caught.message
        : DETAIL_SAVE_ERROR);
    }).finally(() => {
      if (active()) setRelationshipsBusy(false);
    });
  }, [active, failAuthentication, id, markApplied, refresh, relationshipsBusy, setNotice]);

  const createSubtask = useCallback(async (title: string): Promise<boolean> => {
    const value = title.trim();
    if (id === null || value === "" || !active() || relationshipsBusy) return false;
    setRelationshipsBusy(true);
    try {
      await api.createItem({ title: value, parentId: id });
      if (!active()) return true;
      markApplied("item");
      setNotice("Sub-task added.");
      await refresh(true);
      return true;
    } catch (caught: unknown) {
      if (!active() || failAuthentication(caught)) return false;
      setNotice(DETAIL_SAVE_ERROR);
      return false;
    } finally {
      if (active()) setRelationshipsBusy(false);
    }
  }, [active, failAuthentication, id, markApplied, refresh, relationshipsBusy, setNotice]);

  // --- delete ----------------------------------------------------------------

  /** The fixed copy shown when the pending edits could not be sent. */
  const DELETE_FLUSH_ERROR = DETAIL_DELETE_FLUSH_ERROR;

  const flushBeforeDelete = useCallback(async (): Promise<boolean> => {
    // Stop the autosave timers first: a timer firing after the confirmation
    // prompt would PATCH an item the user is about to delete.
    if (titleTimerRef.current !== null) {
      window.clearTimeout(titleTimerRef.current);
      titleTimerRef.current = null;
    }
    if (bodyTimerRef.current !== null) {
      window.clearTimeout(bodyTimerRef.current);
      bodyTimerRef.current = null;
    }
    // An unsendable draft cannot be flushed, and must not be reported as
    // flushed either — the delete is abandoned instead of silently dropping an
    // edit the user made.
    const rejection = titleRejection();
    if (rejection !== null) {
      setTitleStatus(rejection === "empty" ? DETAIL_TITLE_NOTICE : DETAIL_TITLE_LIMIT_NOTICE);
      setNotice(rejection === "empty" ? DETAIL_TITLE_NOTICE : DETAIL_TITLE_LIMIT_NOTICE);
      return false;
    }
    if (bodyDraftRef.current.length > BODY_MAX_LENGTH) {
      setBodyStatus(DETAIL_BODY_NOTICE);
      setNotice(DETAIL_BODY_NOTICE);
      return false;
    }
    const [titleFlushed, bodyFlushed] = await Promise.all([
      queueTitle().then((sent) => sent, () => false),
      queueBody().then((sent) => sent, () => false),
    ]);
    if (!active()) return false;
    if (!titleFlushed || !bodyFlushed) {
      // A rejected flush means the server never accepted the pending edit. The
      // delete must not proceed: opening the confirmation, let alone issuing
      // DELETE, would destroy an item whose latest edit was never stored.
      setNotice(DELETE_FLUSH_ERROR);
      return false;
    }
    return true;
  }, [active, queueBody, queueTitle, setBodyStatus, setNotice, setTitleStatus, titleRejection]);

  const deleteItem = useCallback(async (): Promise<void> => {
    // The guard is set before the first await, so a second click while the
    // flush is running cannot queue a second confirmation.
    if (id === null || !active() || deleting || deleteConfirmedRef.current) return;
    deleteConfirmedRef.current = true;
    try {
      const flushed = await flushBeforeDelete();
      if (!active()) return;
      if (!flushed) return;
      if (!window.confirm(`Delete item #${id}? This cannot be undone.`)) return;
      setDeleting(true);
      try {
        await api.deleteItem(id);
        if (!active()) return;
        location.hash = "#/board";
      } catch (caught: unknown) {
        if (!active() || failAuthentication(caught)) return;
        setNotice(DETAIL_DELETE_ERROR);
      } finally {
        if (mountedRef.current && !terminalRef.current) setDeleting(false);
      }
    } finally {
      // Re-arm only while the view is alive: the guard also stops a queued
      // second click, and must not be consumed by an unmounted component.
      if (active()) deleteConfirmedRef.current = false;
    }
  }, [active, deleting, failAuthentication, flushBeforeDelete, id, setNotice]);

  // --- lifecycle -------------------------------------------------------------

  /** Cancel every pending write, so nothing is sent for a view that is gone. */
  const stopWrites = useCallback((): void => {
    for (const queue of fieldQueuesRef.current.values()) queue.cancelPending();
    titleQueueRef.current?.cancelPending();
    bodyQueueRef.current?.cancelPending();
    labelQueueRef.current?.cancelPending();
  }, []);

  useEffect(() => { void refresh(false); }, [refresh]);
  const initialRefreshGenerationRef = useRef(refreshGeneration);
  useEffect(() => {
    if (refreshGeneration === initialRefreshGenerationRef.current) return;
    initialRefreshGenerationRef.current = refreshGeneration;
    void refresh(true);
  }, [refresh, refreshGeneration]);
  useEffect(() => () => {
    mountedRef.current = false;
    fetchSequenceRef.current += 1;
    stopWrites();
    fieldQueuesRef.current.clear();
    stopWritesRef.current = [];
    if (titleTimerRef.current !== null) window.clearTimeout(titleTimerRef.current);
    if (bodyTimerRef.current !== null) window.clearTimeout(bodyTimerRef.current);
  }, [stopWrites]);

  // The auth-failure path must cancel the same pending writes the unmount path
  // does, and it runs before the queues exist on the very first render, so it
  // reads them through a ref rather than a captured closure.
  stopWritesRef.current = [stopWrites];

  return {
    id, item, comments, history, parent, subtasks, participants, labels, loading, refreshing, notFound, error, notice, announcement,
    titleDraft, titleStatus, bodyDraft, bodyStatus, bodyTab, commentDraft, commentBusy, mention,
    labelDraft, labelNotice, selectedLabelNames, labelsBusy, fieldsBusy, relationshipsBusy, deleting, expandedHistory,
    retry: () => void refresh(false),
    setTitleDraft,
    flushTitle,
    setTitleFocused: (focused) => { titleFocusedRef.current = focused; },
    setBodyDraft,
    flushBody,
    setBodyFocused: (focused) => { bodyFocusedRef.current = focused; },
    setBodyTab,
    patchField,
    setParent,
    createSubtask,
    setLabelDraft,
    addLabel,
    removeLabel,
    setCommentDraft,
    moveMention: (delta) => setMention((current) => current === null ? null : {
      ...current,
      activeIndex: (current.activeIndex + delta + current.options.length) % current.options.length,
    }),
    closeMention: () => setMention(null),
    chooseMention,
    submitComment,
    toggleHistory: (entryId) => setExpandedHistory((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId); else next.add(entryId);
      return next;
    }),
    deleteItem,
  };
}
