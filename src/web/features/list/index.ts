import { registerView } from "../../views";
import { ListView } from "./ListView";

registerView("list", {
  kind: "component",
  title: "List",
  href: "#/list",
  component: ListView,
});

export { ListView } from "./ListView";
export type { ListViewProps } from "./types";
