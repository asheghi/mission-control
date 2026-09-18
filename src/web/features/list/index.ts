import { registerView } from "../../views";
import { ListView } from "./ListView";

registerView("list", {
  kind: "component",
  // Matches the page heading in ListView so the nav item and the screen it
  // opens never disagree about what the user is looking at.
  title: "All work",
  href: "#/list",
  component: ListView,
});

export { ListView } from "./ListView";
export type { ListViewProps } from "./types";
