// @lexical/code (used by @mdxeditor/editor) references `Prism` as a bare global identifier
// in a diff-language extension IIFE. In Rollup's production bundle the prismjs require call
// gets placed after that IIFE, so window.Prism is never set in time.
// Importing prismjs here and assigning globalThis.Prism forces the factory to run first.
import Prism from "prismjs";

(globalThis as Record<string, unknown>).Prism = Prism;
