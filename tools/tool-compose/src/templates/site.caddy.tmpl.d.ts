// `index.ts` imports this template as raw text with `with { type: 'text' }`
// (Bun inlines it at bundle time). TypeScript has no built-in type for it.
//
// This sits beside the template rather than being one `declare module '*.tmpl'`
// wildcard, because a wildcard only types the programs that *include* the file
// declaring it. `@tools/compose` is consumed through a path mapping, so
// `tool-remote-scripts` compiles `index.ts` inside its own program — where the
// wildcard was invisible and both imports were TS2307. A declaration named for
// the module is found by *resolution*, so every consumer gets it.
declare const content: string;
export default content;
