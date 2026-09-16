import { render } from "preact";
import "./styles.css";
import "./features/board";
import "./features/list";
import "./features/detail";
import { App } from "./app";

const app = document.getElementById("app");

if (app === null) throw new Error("Workboard application host is missing");

render(<App />, app);
