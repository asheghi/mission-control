import { registerView } from "../../views";
import { DetailView } from "./DetailView";

registerView("detail", {
  kind: "component",
  title: "Item",
  href: "#/item",
  hidden: true,
  component: DetailView,
});

export { DetailView } from "./DetailView";
export { detailFromResponse, itemFromDetailResponse, labelFromResponse, labelsFromResponse, participantsFromResponse } from "./data";
export {
  boundDiff,
  checkLabelAdd,
  deterministicLabelColor,
  diffLines,
  insertMention,
  mentionTrigger,
  normalizeLabelName,
  normalizeLabelSet,
  normalizeLinkUrl,
  tokenizeInline,
  truncateLine,
} from "./helpers";
export { createSettledBurstQueue } from "./queue";
export type { SettledBurstQueue } from "./queue";
export type { DetailViewProps } from "./types";
