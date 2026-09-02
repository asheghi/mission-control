// Bun embeds non-JS assets imported with `with { type: "text" }` as strings.
declare module "*.sql" {
  const content: string;
  export default content;
}
