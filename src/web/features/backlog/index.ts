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
