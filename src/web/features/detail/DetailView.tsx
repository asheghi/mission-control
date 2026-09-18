import { BodyEditor, CommentComposer, Comments, DetailHeader, DetailStatus, FieldControls, History, LabelsEditor } from "./components";
import { useDetail } from "./hooks";
import type { DetailViewProps } from "./types";

export function DetailView(props: DetailViewProps) {
  const detail = useDetail(props);

  if (detail.id === null || detail.notFound) {
    return (
      <div class="detail detail-state">
        <h1>Item not found</h1>
        <p>The requested item does not exist or is no longer available.</p>
        <a class="breadcrumb" href="#/board">← Back to board</a>
        <DetailStatus detail={detail}>Item not found.</DetailStatus>
      </div>
    );
  }

  if (detail.item === null) {
    return (
      <div class="detail detail-state">
        <h1>{detail.loading ? "Loading item…" : "Could not load item"}</h1>
        {/* A visible error is announced assertively; the polite region below
            keeps carrying progress messages, so a failure is not queued behind
            them. */}
        {detail.error === "" ? null : (
          <>
            <p class="error-banner" role="alert">{detail.error}</p>
            <button type="button" onClick={detail.retry}>Retry</button>
          </>
        )}
        <DetailStatus detail={detail}>{detail.error}</DetailStatus>
      </div>
    );
  }

  return (
    <div class="detail">
      <DetailStatus detail={detail} />
      <DetailHeader detail={detail} />
      {/* Visible text only. Announcement is owned by the single polite live
          region above, so this must not be a live region too — two regions
          carrying the same message read it to a screen reader twice. */}
      {detail.notice === "" ? null : <div class="notice-banner detail-notice">{detail.notice}</div>}
      {detail.error === "" ? null : (
        <div class="error-banner" role="alert">{detail.error} <button type="button" onClick={detail.retry}>Retry</button></div>
      )}
      <div class="detail-layout">
        <BodyEditor detail={detail} />
        <FieldControls detail={detail} />
        <CommentComposer detail={detail} />
        <LabelsEditor detail={detail} />
        <Comments detail={detail} />
        <History detail={detail} />
      </div>
    </div>
  );
}
