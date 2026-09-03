// Ambient declarations for assets embedded as text (single-binary friendly).

declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*web/app.js" {
  const content: string;
  export default content;
}

declare module "*web/api.js" {
  const content: string;
  export default content;
}
