import { registerView } from "../../views";
import { MineView } from "./MineView";

registerView("mine", {
  kind: "component",
  title: "My work",
  href: "#/mine",
  component: MineView,
});

export { MineView } from "./MineView";
