import type { Monaco } from "@monaco-editor/react";

/**
 * Resolve a CSS custom property from :root to its computed hex value.
 */
function resolve(varName: string): string {
	return getComputedStyle(document.documentElement)
		.getPropertyValue(varName)
		.trim();
}

/* ── Apex language registration (Monaco v0.55.1 grammar) ─────────────── */

let apexRegistered = false;

const apexKeywordsLower = [
	"abstract",
	"activate",
	"and",
	"any",
	"array",
	"as",
	"asc",
	"assert",
	"autonomous",
	"begin",
	"bigdecimal",
	"blob",
	"boolean",
	"break",
	"bulk",
	"by",
	"case",
	"cast",
	"catch",
	"char",
	"class",
	"collect",
	"commit",
	"const",
	"continue",
	"convertcurrency",
	"decimal",
	"default",
	"delete",
	"desc",
	"do",
	"double",
	"else",
	"end",
	"enum",
	"exception",
	"exit",
	"export",
	"extends",
	"false",
	"final",
	"finally",
	"float",
	"for",
	"from",
	"future",
	"get",
	"global",
	"goto",
	"group",
	"having",
	"hint",
	"if",
	"implements",
	"import",
	"in",
	"inner",
	"insert",
	"instanceof",
	"int",
	"interface",
	"into",
	"join",
	"last_90_days",
	"last_month",
	"last_n_days",
	"last_week",
	"like",
	"limit",
	"list",
	"long",
	"loop",
	"map",
	"merge",
	"native",
	"new",
	"next_90_days",
	"next_month",
	"next_n_days",
	"next_week",
	"not",
	"null",
	"nulls",
	"number",
	"object",
	"of",
	"on",
	"or",
	"outer",
	"override",
	"package",
	"parallel",
	"pragma",
	"private",
	"protected",
	"public",
	"retrieve",
	"return",
	"returning",
	"rollback",
	"savepoint",
	"search",
	"select",
	"set",
	"short",
	"sort",
	"stat",
	"static",
	"strictfp",
	"super",
	"switch",
	"synchronized",
	"system",
	"testmethod",
	"then",
	"this",
	"this_month",
	"this_week",
	"throw",
	"throws",
	"today",
	"tolabel",
	"tomorrow",
	"transaction",
	"transient",
	"trigger",
	"true",
	"try",
	"type",
	"undelete",
	"update",
	"upsert",
	"using",
	"virtual",
	"void",
	"volatile",
	"webservice",
	"when",
	"where",
	"while",
	"yesterday",
];

const apexKeywords: string[] = [];
for (const kw of apexKeywordsLower) {
	apexKeywords.push(kw);
	apexKeywords.push(kw.toUpperCase());
	apexKeywords.push(kw.charAt(0).toUpperCase() + kw.slice(1));
}

function registerApexLanguage(monaco: Monaco) {
	if (apexRegistered) return;
	apexRegistered = true;

	monaco.languages.register({
		id: "apex",
		extensions: [".cls", ".trigger", ".apex"],
		aliases: ["Apex", "apex"],
	});

	monaco.languages.setLanguageConfiguration("apex", {
		wordPattern: /(-?\d*\.\d\w*)|([^`~!#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g,
		comments: { lineComment: "//", blockComment: ["/*", "*/"] },
		brackets: [
			["{", "}"],
			["[", "]"],
			["(", ")"],
		],
		autoClosingPairs: [
			{ open: "{", close: "}" },
			{ open: "[", close: "]" },
			{ open: "(", close: ")" },
			{ open: '"', close: '"' },
			{ open: "'", close: "'" },
		],
		surroundingPairs: [
			{ open: "{", close: "}" },
			{ open: "[", close: "]" },
			{ open: "(", close: ")" },
			{ open: '"', close: '"' },
			{ open: "'", close: "'" },
			{ open: "<", close: ">" },
		],
		folding: {
			markers: {
				start: /^\s*\/\/\s*(?:(?:#?region\b)|(?:<editor-fold\b))/,
				end: /^\s*\/\/\s*(?:(?:#?endregion\b)|(?:<\/editor-fold>))/,
			},
		},
	});

	monaco.languages.setMonarchTokensProvider("apex", {
		defaultToken: "",
		tokenPostfix: ".apex",
		keywords: apexKeywords,
		operators: [
			"=",
			">",
			"<",
			"!",
			"~",
			"?",
			":",
			"==",
			"<=",
			">=",
			"!=",
			"&&",
			"||",
			"++",
			"--",
			"+",
			"-",
			"*",
			"/",
			"&",
			"|",
			"^",
			"%",
			"<<",
			">>",
			">>>",
			"+=",
			"-=",
			"*=",
			"/=",
			"&=",
			"|=",
			"^=",
			"%=",
			"<<=",
			">>=",
			">>>=",
		],
		symbols: /[=><!~?:&|+\-*/^%]+/,
		escapes:
			/\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
		digits: /\d+(_+\d+)*/,
		octaldigits: /[0-7]+(_+[0-7]+)*/,
		binarydigits: /[0-1]+(_+[0-1]+)*/,
		hexdigits: /[[0-9a-fA-F]+(_+[0-9a-fA-F]+)*/,
		tokenizer: {
			root: [
				[
					/[a-z_$][\w$]*/,
					{
						cases: {
							"@keywords": { token: "keyword.$0" },
							"@default": "identifier",
						},
					},
				],
				[
					/[A-Z][\w$]*/,
					{
						cases: {
							"@keywords": { token: "keyword.$0" },
							"@default": "type.identifier",
						},
					},
				],
				{ include: "@whitespace" },
				[/[{}()[\]]/, "@brackets"],
				[/[<>](?!@symbols)/, "@brackets"],
				[
					/@symbols/,
					{
						cases: {
							"@operators": "delimiter",
							"@default": "",
						},
					},
				],
				[/@\s*[a-zA-Z_$][\w$]*/, "annotation"],
				[/(@digits)[eE]([-+]?(@digits))?[fFdD]?/, "number.float"],
				[/(@digits)\.(@digits)([eE][-+]?(@digits))?[fFdD]?/, "number.float"],
				[/(@digits)[fFdD]/, "number.float"],
				[/(@digits)[lL]?/, "number"],
				[/[;,.]/, "delimiter"],
				[/"([^"\\]|\\.)*$/, "string.invalid"],
				[/'([^'\\]|\\.)*$/, "string.invalid"],
				[/"/, "string", '@string."'],
				[/'/, "string", "@string.'"],
				[/'[^\\']'/, "string"],
				[/(')(@escapes)(')/, ["string", "string.escape", "string"]],
				[/'/, "string.invalid"],
			],
			whitespace: [
				[/[ \t\r\n]+/, ""],
				[/\/\*\*(?!\/)/, "comment.doc", "@apexdoc"],
				[/\/\*/, "comment", "@comment"],
				[/\/\/.*$/, "comment"],
			],
			comment: [
				[/[^/*]+/, "comment"],
				[/\*\//, "comment", "@pop"],
				[/[/*]/, "comment"],
			],
			apexdoc: [
				[/[^/*]+/, "comment.doc"],
				[/\*\//, "comment.doc", "@pop"],
				[/[/*]/, "comment.doc"],
			],
			string: [
				[/[^\\"']+/, "string"],
				[/@escapes/, "string.escape"],
				[/\\./, "string.escape.invalid"],
				[
					/["']/,
					{
						cases: {
							"$#==$S2": { token: "string", next: "@pop" },
							"@default": "string",
						},
					},
				],
			],
		},
	});
}

/* ── Astro language registration ─────────────────────────────────────── */

let astroRegistered = false;

// TypeScript/JavaScript keywords used inside the frontmatter fence and `{}`
// expressions. Astro frontmatter is TS; templates embed TS expressions.
const astroTsKeywords = [
	"abstract",
	"any",
	"as",
	"asserts",
	"async",
	"await",
	"boolean",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"declare",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"from",
	"function",
	"get",
	"if",
	"implements",
	"import",
	"in",
	"infer",
	"instanceof",
	"interface",
	"is",
	"keyof",
	"let",
	"namespace",
	"never",
	"new",
	"null",
	"number",
	"object",
	"of",
	"private",
	"protected",
	"public",
	"readonly",
	"return",
	"satisfies",
	"set",
	"static",
	"string",
	"super",
	"switch",
	"symbol",
	"this",
	"throw",
	"true",
	"try",
	"type",
	"typeof",
	"undefined",
	"unknown",
	"var",
	"void",
	"while",
	"yield",
];

function registerAstroLanguage(monaco: Monaco) {
	if (astroRegistered) return;
	astroRegistered = true;

	monaco.languages.register({
		id: "astro",
		extensions: [".astro"],
		aliases: ["Astro", "astro"],
	});

	monaco.languages.setLanguageConfiguration("astro", {
		comments: { blockComment: ["<!--", "-->"] },
		brackets: [
			["<!--", "-->"],
			["<", ">"],
			["{", "}"],
			["(", ")"],
		],
		autoClosingPairs: [
			{ open: "{", close: "}" },
			{ open: "[", close: "]" },
			{ open: "(", close: ")" },
			{ open: '"', close: '"' },
			{ open: "'", close: "'" },
			{ open: "`", close: "`" },
		],
		surroundingPairs: [
			{ open: "{", close: "}" },
			{ open: "[", close: "]" },
			{ open: "(", close: ")" },
			{ open: '"', close: '"' },
			{ open: "'", close: "'" },
			{ open: "`", close: "`" },
			{ open: "<", close: ">" },
		],
	});

	monaco.languages.setMonarchTokensProvider("astro", {
		defaultToken: "",
		tokenPostfix: ".astro",
		keywords: astroTsKeywords,

		tokenizer: {
			// Initial state. The `---` frontmatter fence is only meaningful as the
			// very first line; once any other content is seen we switch to @markup
			// permanently so a stray `---` line in the body can't re-trigger it.
			root: [
				[/^---\s*$/, { token: "keyword", next: "@frontmatter" }],
				[/^/, { token: "@rematch", switchTo: "@markup" }],
			],

			frontmatter: [
				[/^---\s*$/, { token: "keyword", switchTo: "@markup" }],
				{ include: "@ts" },
			],

			markup: [
				[/\{/, { token: "delimiter.bracket", next: "@expression" }],
				[/<!--/, "comment", "@comment"],
				[/<!DOCTYPE/i, "metatag", "@doctype"],
				// `<script>` / `<style>` carry TS / CSS — handle their bodies.
				[
					/(<)(script)(?=[\s/>])/,
					["delimiter", { token: "tag", next: "@scriptTag" }],
				],
				[
					/(<)(style)(?=[\s/>])/,
					["delimiter", { token: "tag", next: "@styleTag" }],
				],
				// Closing tag — @closeTag tolerates anything up to `>`
				[/(<\/)([\w-]+)/, ["delimiter", { token: "tag", next: "@closeTag" }]],
				// Opening tag — enter @tag to tokenize attributes
				[/(<)([\w-]+)/, ["delimiter", { token: "tag", next: "@tag" }]],
				[/</, "delimiter"],
				[/[^<{]+/, ""],
			],

			comment: [
				[/-->/, "comment", "@pop"],
				[/[^-]+/, "comment"],
				[/./, "comment"],
			],

			doctype: [
				[/[^>]+/, "metatag.content"],
				[/>/, "metatag", "@pop"],
			],

			tag: [
				[/\/?>/, { token: "delimiter", next: "@pop" }],
				[/\s+/, ""],
				[/=/, "delimiter"],
				// Attribute value as a `{}` expression
				[/\{/, { token: "delimiter.bracket", next: "@expression" }],
				[/"([^"]*)"/, "attribute.value"],
				[/'([^']*)'/, "attribute.value"],
				[/[\w-]+/, "attribute.name"],
			],

			closeTag: [
				[/>/, { token: "delimiter", next: "@pop" }],
				[/[^>]+/, ""],
			],

			// `<script>` attributes, then its body tokenized as TS.
			scriptTag: [
				[/\/>/, { token: "delimiter", next: "@pop" }],
				[/>/, { token: "delimiter", switchTo: "@scriptBody" }],
				[/\s+/, ""],
				[/=/, "delimiter"],
				[/\{/, { token: "delimiter.bracket", next: "@expression" }],
				[/"([^"]*)"/, "attribute.value"],
				[/'([^']*)'/, "attribute.value"],
				[/[\w-]+/, "attribute.name"],
			],
			scriptBody: [
				[/<\/script\s*>/, { token: "tag", next: "@pop" }],
				{ include: "@ts" },
			],

			// `<style>` attributes, then its body tokenized as CSS.
			styleTag: [
				[/\/>/, { token: "delimiter", next: "@pop" }],
				[/>/, { token: "delimiter", switchTo: "@styleBody" }],
				[/\s+/, ""],
				[/=/, "delimiter"],
				[/\{/, { token: "delimiter.bracket", next: "@expression" }],
				[/"([^"]*)"/, "attribute.value"],
				[/'([^']*)'/, "attribute.value"],
				[/[\w-]+/, "attribute.name"],
			],
			styleBody: [
				[/<\/style\s*>/, { token: "tag", next: "@pop" }],
				{ include: "@css" },
			],

			// `{ ... }` template expression — TS, with balanced nested braces.
			expression: [
				[/\}/, { token: "delimiter.bracket", next: "@pop" }],
				[/\{/, { token: "delimiter.bracket", next: "@expression" }],
				{ include: "@ts" },
			],

			// Shared TypeScript token rules (frontmatter + expressions).
			ts: [
				[
					/[a-zA-Z_$][\w$]*/,
					{
						cases: {
							"@keywords": "keyword",
							"@default": "identifier",
						},
					},
				],
				{ include: "@whitespace" },
				[/\d+(\.\d+)?([eE][-+]?\d+)?/, "number"],
				[/"/, "string", "@string_double"],
				[/'/, "string", "@string_single"],
				[/`/, "string", "@string_backtick"],
				[/[()[\]]/, "@brackets"],
				[/[;,.]/, "delimiter"],
				[/[=+\-*/%<>!&|^~?:]+/, "operator"],
			],

			// Minimal CSS ruleset for `<style>` bodies — selectors, properties,
			// values, comments and strings. Not a full grammar, but enough that
			// styles aren't shown as untokenized plain text.
			css: [
				[/\/\*/, "comment", "@csscomment"],
				[/[{}]/, "delimiter.bracket"],
				[/[#.][\w-]+/, "tag"],
				[/[\w-]+(?=\s*:)/, "attribute.name"],
				[/#[0-9a-fA-F]{3,8}\b/, "number.hex"],
				[
					/-?\d+(\.\d+)?(px|em|rem|%|vh|vw|s|ms|fr|deg|pt|ex|ch|vmin|vmax)?/,
					"number",
				],
				[/"/, "string", "@string_double"],
				[/'/, "string", "@string_single"],
				[/[:;,()]/, "delimiter"],
				[/!important\b/, "keyword"],
				[/@[\w-]+/, "keyword"],
				[/[a-zA-Z][\w-]*/, "attribute.value"],
				[/\s+/, ""],
			],
			csscomment: [
				[/[^*/]+/, "comment"],
				[/\*\//, "comment", "@pop"],
				[/[*/]/, "comment"],
			],

			whitespace: [
				[/[ \t\r\n]+/, ""],
				[/\/\*/, "comment", "@tscomment"],
				[/\/\/.*$/, "comment"],
			],
			tscomment: [
				[/[^*/]+/, "comment"],
				[/\*\//, "comment", "@pop"],
				[/[*/]/, "comment"],
			],
			string_double: [
				[/[^\\"]+/, "string"],
				[/\\./, "string.escape"],
				[/"/, "string", "@pop"],
			],
			string_single: [
				[/[^\\']+/, "string"],
				[/\\./, "string.escape"],
				[/'/, "string", "@pop"],
			],
			string_backtick: [
				[/\$\{/, { token: "delimiter.bracket", next: "@expression" }],
				[/[^\\`$]+/, "string"],
				[/\\./, "string.escape"],
				[/`/, "string", "@pop"],
				[/[$]/, "string"],
			],
		},
	});
}

/* ── Theme ───────────────────────────────────────────────────────────── */

let themeKey: string | null = null;

/**
 * (Re-)define the "abundio" Monaco theme from the current CSS variables.
 * Call this once on init and again whenever the app theme changes.
 * Cached by a fingerprint of key CSS vars — subsequent calls within the same
 * theme are near-free (2 getComputedStyle reads instead of ~20).
 */
export function defineAbundioTheme(monaco: Monaco) {
	registerApexLanguage(monaco);
	registerAstroLanguage(monaco);
	const key = resolve("--bg-primary") + resolve("--accent");
	if (key === themeKey) return;
	themeKey = key;
	monaco.editor.defineTheme("abundio", {
		base: "vs-dark",
		inherit: true,
		rules: [],
		colors: {
			// Transparent (8-digit hex, alpha 00) so the workspace's ambient
			// gradient shows through the editor — matches the transparent terminal
			// panes. The pane/container backgrounds are transparent too (CodeEditor
			// / FilePane). Overlay widgets keep `editorWidget.background` for legibility.
			"editor.background": "#00000000",
			"editor.foreground": resolve("--fg-primary"),
			"editorLineNumber.foreground": resolve("--fg-secondary"),
			"editorLineNumber.activeForeground": resolve("--fg-primary"),
			"editorCursor.foreground": resolve("--accent"),
			"editor.selectionBackground": `${resolve("--accent")}40`,
			"editor.lineHighlightBackground": `${resolve("--fg-primary")}0D`,
			"editorGutter.background": "#00000000",
			"editorWidget.background": resolve("--bg-secondary"),
			"editorWidget.border": resolve("--border"),
			"editor.findMatchBackground": `${resolve("--accent")}40`,
			"editor.findMatchHighlightBackground": `${resolve("--accent")}25`,
			"editorOverviewRuler.border": resolve("--border"),
			"scrollbarSlider.background": `${resolve("--fg-secondary")}40`,
			"scrollbarSlider.hoverBackground": `${resolve("--fg-secondary")}60`,
			"scrollbarSlider.activeBackground": `${resolve("--fg-secondary")}80`,
			// Diff colors
			"diffEditor.insertedTextBackground": `${resolve("--success")}20`,
			"diffEditor.removedTextBackground": `${resolve("--error")}20`,
			"diffEditor.insertedLineBackground": `${resolve("--success")}14`,
			"diffEditor.removedLineBackground": `${resolve("--error")}14`,
		},
	});
}

/**
 * Detect the Monaco language ID from a file path's extension.
 */
export function detectLanguage(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		html: "html",
		css: "css",
		json: "json",
		md: "markdown",
		py: "python",
		rs: "rust",
		cpp: "cpp",
		c: "cpp",
		h: "cpp",
		hpp: "cpp",
		java: "java",
		sh: "shell",
		bash: "shell",
		zsh: "shell",
		yaml: "yaml",
		yml: "yaml",
		toml: "ini",
		xml: "xml",
		svg: "xml",
		sql: "sql",
		go: "go",
		rb: "ruby",
		php: "php",
		swift: "swift",
		kt: "kotlin",
		lua: "lua",
		r: "r",
		dockerfile: "dockerfile",
		cls: "apex",
		trigger: "apex",
		apex: "apex",
		astro: "astro",
		page: "html",
		component: "html",
	};
	return map[ext];
}
