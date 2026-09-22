import { registerView } from "../../views";
import { BacklogView } from "./BacklogView";

registerView("backlog", {
  kind: "component",
  title: "Backlog",
  href: "#/backlog",
  component: BacklogView,
});

export { BacklogView } from "./BacklogView";
export { backlogItemsFromResponse, backlogPageFromResponse, groupBacklog } from "./data";
export {
  BACKLOG_DIRECTION_MARKS,
  BACKLOG_MOVE_DIRECTIONS,
  backlogDropTarget,
  backlogInsertMove,
  backlogItemLabel,
  backlogLevels,
  backlogMoveActions,
  backlogMoveDirectionReason,
  backlogMoveTargets,
  displayLevel,
  isDescendantOf,
  isDroppableRow,
  dropRefusalMessage,
  rootRefusalMessage,
  typeAllowsRoot,
} from "./moves";
export { optimisticOrder } from "./hooks";
export { BACKLOG_STATUS_LABELS, BACKLOG_STATUSES, BACKLOG_TOP_LEVEL_TYPES } from "./types";
