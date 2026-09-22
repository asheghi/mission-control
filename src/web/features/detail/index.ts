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
  parseItemId,
  taskTypeAllowed,
  tokenizeInline,
  truncateLine,
} from "./helpers";
export { createSettledBurstQueue } from "./queue";
export type { SettledBurstQueue } from "./queue";
export {
  DETAIL_ADD_RELATIONSHIP_NAMES,
  DETAIL_ADD_RELATIONSHIP_NONE,
  DETAIL_DUPLICATE_OF_NAME,
  DETAIL_RELATIONSHIP_GROUPS,
  DETAIL_WORK_ITEM_TYPES,
} from "./types";
export type { DetailAddRelationshipName, DetailViewProps, RelationshipGroupSpec } from "./types";
