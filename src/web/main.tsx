import { render } from "preact";
import "./styles.css";
import "./app.js";

const markerHost = document.getElementById("preact-marker");

if (markerHost !== null) {
  render(<span data-preact-marker="phase-a">Preact browser build active</span>, markerHost);
}
