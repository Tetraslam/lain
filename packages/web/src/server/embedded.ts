// Embedded single-file web client for the compiled `lain` binary.
//
// The binary build (scripts/build-binary.ts) first runs `vite build` with
// vite-plugin-singlefile, producing a fully self-contained dist/index.html
// (all JS/CSS inlined). `bun build --compile` then inlines that file here as a
// string via the `type: "text"` import. The binary entry (cli/src/bin.ts)
// passes it to startServer({ clientHtml }).
//
// In source / dev this module is never imported — the server reads dist/ from
// disk instead — so the import below is only ever resolved at binary-compile
// time, when dist/index.html is guaranteed to exist.
// @ts-ignore — resolved by `bun build --compile`; no .html type decl needed.
import html from "../../dist/index.html" with { type: "text" };

export const EMBEDDED_CLIENT: string = html as unknown as string;
