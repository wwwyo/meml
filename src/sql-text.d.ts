// `.sql` files imported with `with { type: "text" }` resolve to their raw text (Bun text loader).
declare module "*.sql" {
  const content: string;
  export default content;
}
