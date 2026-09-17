import { registerView } from "../../views";
import { BoardView } from "./BoardView";

registerView("board", {
  kind: "component",
  title: "Board",
  href: "#/board",
  component: BoardView,
});

export { BoardView } from "./BoardView";
export type { BoardViewProps } from "./types";
