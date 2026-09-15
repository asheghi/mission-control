import { render } from "preact";
import "./styles.css";
import "./board.js";
import "./list.js";
import "./detail.js";
import { App } from "./app";

const app = document.getElementById("app");

if (app === null) throw new Error("Workboard application host is missing");

render(<App />, app);
