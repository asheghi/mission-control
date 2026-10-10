import { useState } from "preact/hooks";
import { formatTime } from "./helpers";
import { Markdown } from "./components";
import type { DetailState } from "./types";

const INITIAL_COMMENT_COUNT = 10;
const OLDER_COMMENT_BATCH_SIZE = 10;

export function Comments({ detail }: { detail: DetailState }) {
  const [olderShown, setOlderShown] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const comments = detail.comments;
  const visibleStart = Math.max(0, comments.length - INITIAL_COMMENT_COUNT - olderShown);
  const olderCount = visibleStart;
  // Rendered newest-first: the visible slice is the tail of the chronological
  // list (the newest comments), and reversing it puts the most recent comment
  // on top while "show older" reveals earlier ones beneath it.
  const visible = comments.slice(visibleStart).reverse();
  const showOlder = (): void => {
    const count = Math.min(OLDER_COMMENT_BATCH_SIZE, olderCount);
    setOlderShown((shown) => shown + count);
    setAnnouncement(`Showing ${count} older ${count === 1 ? "comment" : "comments"}.`);
  };
  return (
    <section class="detail-comments" aria-labelledby="comments-heading">
      <h2 id="comments-heading">Comments</h2>
      {comments.length === 0 ? <p class="muted">No comments yet.</p> : <>
        {olderCount > 0 ? <button type="button" class="show-older-comments" aria-controls="comment-thread" onClick={showOlder}>
          Show older comments ({olderCount})
        </button> : null}
        <div id="comment-thread">
          {visible.map((comment) => (
            <article class="comment card" key={comment.id}>
              <header class="comment-head"><strong>{comment.author.name}</strong><time class="muted" dateTime={comment.createdAt}>{formatTime(comment.createdAt)}</time></header>
              <Markdown>{comment.body}</Markdown>
            </article>
          ))}
        </div>
        <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      </>}
    </section>
  );
}
