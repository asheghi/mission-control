import { render } from "preact";
import "./styles.css";
// Registration order is primary-navigation order, so the default view — the
// backlog the shell lands on — is registered first.
import "./features/backlog";
import "./features/board";
import "./features/list";
import "./features/detail";
import { App } from "./app";

const app = document.getElementById("app");

if (app === null) throw new Error("MissionControl application host is missing");

render(<App />, app);
