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

/* ── Theme ───────────────────────────────────────────────────────────── */

/**
 * (Re-)define the "abundio" Monaco theme from the current CSS variables.
 * Call this once on init and again whenever the app theme changes.
 */
export function defineAbundioTheme(monaco: Monaco) {
	registerApexLanguage(monaco);
	monaco.editor.defineTheme("abundio", {
		base: "vs-dark",
		inherit: true,
		rules: [],
		colors: {
			"editor.background": resolve("--bg-primary"),
			"editor.foreground": resolve("--fg-primary"),
			"editorLineNumber.foreground": resolve("--fg-secondary"),
			"editorLineNumber.activeForeground": resolve("--fg-primary"),
			"editorCursor.foreground": resolve("--accent"),
			"editor.selectionBackground": `${resolve("--accent")}40`,
			"editor.lineHighlightBackground": `${resolve("--fg-primary")}0D`,
			"editorGutter.background": resolve("--bg-secondary"),
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
		page: "html",
		component: "html",
	};
	return map[ext];
}
