// Ambient declarations for assets embedded as text (single-binary friendly).
//
// Only the two asset kinds the source tree actually imports are declared. The
// browser bundle reaches the server as the generated `web-assets` module rather
// than as a text import, so there is no declaration for a source JavaScript
// module here — and none of the deleted legacy modules has one either.

declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}
