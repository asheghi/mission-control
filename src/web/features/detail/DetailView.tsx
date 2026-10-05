import { useEffect, useRef, useState } from "preact/hooks";
import { AttachmentsPanel, BodyEditor, CommentComposer, Comments, DetailHeader, DetailStatus, FieldControls, History, LabelsEditor } from "./components";
import { Links } from "./Links";
import { useDetail } from "./hooks";
import type { DetailViewProps } from "./types";

export function DetailView(props: DetailViewProps) {
  const detail = useDetail(props);
  const tabs = ["Details", "Attachments", "History"] as const;
  const [activeTab, setActiveTab] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => setActiveTab(0), [detail.id]);
  const tabbar = (
    <div class="tabbar detail-tabs" role="tablist" aria-label="Work item view">
      {tabs.map((name, index) => (
        <button key={name} ref={(element) => { tabRefs.current[index] = element; }} type="button" class="tab" role="tab"
          id={`detail-tab-${index}`} aria-controls={`detail-panel-${index}`} aria-selected={activeTab === index}
          tabIndex={activeTab === index ? 0 : -1} onClick={() => setActiveTab(index)}
          onKeyDown={(event) => {
            const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
              : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
              : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
            if (next === null) return;
            event.preventDefault();
            setActiveTab(next);
            tabRefs.current[next]?.focus();
          }}>{name}</button>
      ))}
    </div>
  );

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
      <DetailHeader detail={detail}>{tabbar}</DetailHeader>
      <div class="detail-fieldbar">
        <FieldControls detail={detail} />
        <details class="detail-label-disclosure"><summary>Labels{detail.selectedLabelNames.length ? ` (${detail.selectedLabelNames.length})` : ""}</summary><LabelsEditor detail={detail} /></details>
      </div>
      {/* Visible text only. Announcement is owned by the single polite live
          region above, so this must not be a live region too — two regions
          carrying the same message read it to a screen reader twice. */}
      {detail.notice === "" ? null : <div class="notice-banner detail-notice">{detail.notice}</div>}
      {detail.error === "" ? null : (
        <div class="error-banner" role="alert">{detail.error} <button type="button" onClick={detail.retry}>Retry</button></div>
      )}
      {/* Keep drafts mounted across tabs. Each column flows independently, so
          a tall links list never pushes comments below an empty description. */}
      <div id="detail-panel-0" role="tabpanel" aria-labelledby="detail-tab-0" hidden={activeTab !== 0}>
        <div class="detail-layout">
          <div class="detail-main">
            <BodyEditor detail={detail} />
            <div class="detail-discussion"><CommentComposer detail={detail} /><Comments detail={detail} /></div>
          </div>
          <Links key={detail.id} detail={detail} />
        </div>
      </div>
      <div id="detail-panel-1" role="tabpanel" aria-labelledby="detail-tab-1" hidden={activeTab !== 1}>
        <AttachmentsPanel key={detail.id} detail={detail} />
      </div>
      <div id="detail-panel-2" role="tabpanel" aria-labelledby="detail-tab-2" hidden={activeTab !== 2}>
        <History detail={detail} />
      </div>
    </div>
  );
}
