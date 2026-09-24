import { render } from "preact";
import "./styles.css";
import { consumeTokenFromHash } from "./api.js";
import { initializeTheme } from "./theme";
// Registration order is primary-navigation order, so the default view — the
// backlog the shell lands on — is registered first.
import "./features/backlog";
import "./features/board";
import "./features/list";
import "./features/detail";
import { App } from "./app";

// Resolve the saved theme BEFORE anything renders, so the first paint already
// uses the user's selected palette instead of flashing the OS default.
initializeTheme();

// Adopt (and erase) a `#token=...` development link BEFORE anything renders, so
// the shell's first `getToken()` sees it and the address bar is already clean by
// the time the app paints.
consumeTokenFromHash();

const app = document.getElementById("app");

if (app === null) throw new Error("MissionControl application host is missing");

render(<App />, app);
