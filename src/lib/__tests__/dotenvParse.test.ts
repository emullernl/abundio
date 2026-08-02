import { describe, expect, it } from "vitest";
import { injectionCost, isValidEnvName, parseDotenv } from "../dotenvParse";

describe("parseDotenv", () => {
	it("parses plain KEY=value lines", () => {
		const r = parseDotenv("A=1\nB=two");
		expect(r.entries).toEqual([
			{ name: "A", value: "1" },
			{ name: "B", value: "two" },
		]);
		expect(r.invalidNames).toEqual([]);
		expect(r.skippedLines).toBe(0);
		expect(r.unterminated).toEqual([]);
	});

	it("strips a leading `export `", () => {
		expect(parseDotenv("export TOKEN=abc").entries).toEqual([
			{ name: "TOKEN", value: "abc" },
		]);
	});

	it("splits on the first = so values may contain more", () => {
		expect(parseDotenv("URL=https://x.test/?a=1&b=2").entries[0].value).toBe(
			"https://x.test/?a=1&b=2",
		);
		// base64 padding is a real-world case
		expect(parseDotenv("K=YWJj==").entries[0].value).toBe("YWJj==");
	});

	it("unwraps double quotes and interprets escapes", () => {
		expect(parseDotenv('A="line1\\nline2"').entries[0].value).toBe(
			"line1\nline2",
		);
		expect(parseDotenv('A="tab\\there"').entries[0].value).toBe("tab\there");
		expect(parseDotenv('A="back\\\\slash"').entries[0].value).toBe(
			"back\\slash",
		);
	});

	// Regression: chained replaces decoded a LITERAL backslash-n into a newline,
	// so `abundio-env print` output did not round-trip back through import.
	it("keeps a literal backslash-n as two characters", () => {
		expect(parseDotenv('P="C:\\\\newdir"').entries[0].value).toBe("C:\\newdir");
		expect(parseDotenv('A="a\\\\nb"').entries[0].value).toBe("a\\nb");
	});

	it("leaves an unknown escape untouched rather than eating the backslash", () => {
		expect(parseDotenv('A="a\\qb"').entries[0].value).toBe("a\\qb");
	});

	it("unwraps single quotes literally", () => {
		expect(parseDotenv("A='no\\nescape'").entries[0].value).toBe("no\\nescape");
	});

	it("leaves unquoted values alone", () => {
		expect(parseDotenv("A=plain value").entries[0].value).toBe("plain value");
	});

	it("skips blank lines and whole-line comments", () => {
		const r = parseDotenv("# a comment\n\n  \nA=1\n   # indented comment\nB=2");
		expect(r.entries).toHaveLength(2);
		expect(r.skippedLines).toBe(0);
	});

	// A `#` inside a value is NOT a comment — truncating a token at one would
	// silently corrupt a secret, which is far worse than keeping a stray hash.
	it("does not treat # inside a value as a comment", () => {
		expect(parseDotenv("PASS=abc#def").entries[0].value).toBe("abc#def");
	});

	it("accepts an empty value", () => {
		expect(parseDotenv("EMPTY=").entries).toEqual([
			{ name: "EMPTY", value: "" },
		]);
	});

	it("tolerates CRLF", () => {
		expect(parseDotenv("A=1\r\nB=2").entries).toHaveLength(2);
	});

	it("collapses duplicates with last-wins", () => {
		const r = parseDotenv("A=first\nA=second");
		expect(r.entries).toEqual([{ name: "A", value: "second" }]);
	});

	it("counts lines with no = as skipped", () => {
		const r = parseDotenv("A=1\njust some prose\nB=2");
		expect(r.entries).toHaveLength(2);
		expect(r.skippedLines).toBe(1);
	});

	it("collects invalid names instead of throwing", () => {
		const r = parseDotenv("1BAD=x\nGOOD=y\nHAS-DASH=z");
		expect(r.entries).toEqual([{ name: "GOOD", value: "y" }]);
		expect(r.invalidNames).toEqual(["1BAD", "HAS-DASH"]);
	});

	it("reports reserved names as invalid", () => {
		const r = parseDotenv("ABUNDIO_PTY_ID=x\nZDOTDIR=y\nOK=z");
		expect(r.entries).toEqual([{ name: "OK", value: "z" }]);
		expect(r.invalidNames).toEqual(["ABUNDIO_PTY_ID", "ZDOTDIR"]);
	});

	it("does not repeat a duplicated invalid name", () => {
		expect(parseDotenv("1BAD=x\n1BAD=y").invalidNames).toEqual(["1BAD"]);
	});

	it("handles a realistic .env paste", () => {
		const r = parseDotenv(`
# Database
DATABASE_URL="postgres://user:pw@localhost:5432/app?sslmode=disable"
export STRIPE_SECRET_KEY=sk_test_abc123

API_PORT=8080
FEATURE_FLAGS='a,b,c'
`);
		expect(r.entries).toEqual([
			{
				name: "DATABASE_URL",
				value: "postgres://user:pw@localhost:5432/app?sslmode=disable",
			},
			{ name: "STRIPE_SECRET_KEY", value: "sk_test_abc123" },
			{ name: "API_PORT", value: "8080" },
			{ name: "FEATURE_FLAGS", value: "a,b,c" },
		]);
		expect(r.invalidNames).toEqual([]);
		expect(r.skippedLines).toBe(0);
	});

	// The contract with `quote_dotenv_value` in hook_server.rs: whatever
	// `abundio-env print` emits must parse back to the original value. Mirrors
	// the Rust escaper exactly — backslash FIRST, then the control characters.
	it("round-trips values escaped the way abundio-env print escapes them", () => {
		const rustQuote = (v: string) =>
			`"${v
				.replace(/\\/g, "\\\\")
				.replace(/"/g, '\\"')
				.replace(/\n/g, "\\n")
				.replace(/\r/g, "\\r")
				.replace(/\t/g, "\\t")}"`;

		for (const original of [
			"plain",
			"",
			"has space",
			'quotes " inside',
			"C:\\Users\\dev",
			"literal\\nbackslash-n",
			"-----BEGIN CERTIFICATE-----\nMIIDdz\n-----END CERTIFICATE-----\n",
			"tab\there",
			'mixed \\ " \n end',
		]) {
			const line = `K=${rustQuote(original)}`;
			expect(parseDotenv(line).entries[0]?.value).toBe(original);
		}
	});

	// The flagship case: a PEM in a .env is written as a multi-line quoted value.
	// Line-at-a-time parsing silently imported a truncated certificate.
	describe("multi-line quoted values", () => {
		const PEM =
			"-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+g\nabc\n-----END CERTIFICATE-----";

		it("keeps a double-quoted certificate intact", () => {
			const r = parseDotenv(`TLS_CERT="${PEM}"\nAPI_PORT=8080`);
			expect(r.entries).toEqual([
				{ name: "TLS_CERT", value: PEM },
				{ name: "API_PORT", value: "8080" },
			]);
			expect(r.skippedLines).toBe(0);
			expect(r.unterminated).toEqual([]);
		});

		it("keeps a single-quoted multi-line value intact", () => {
			const r = parseDotenv(`KEY='line1\nline2'`);
			expect(r.entries).toEqual([{ name: "KEY", value: "line1\nline2" }]);
		});

		it("does not treat a value that closes on its own line as multi-line", () => {
			const r = parseDotenv('A="one"\nB="two"');
			expect(r.entries).toEqual([
				{ name: "A", value: "one" },
				{ name: "B", value: "two" },
			]);
		});

		// Refusing beats importing a secret cut off at end-of-file.
		it("reports an unterminated quote instead of truncating", () => {
			const r = parseDotenv('TLS_CERT="-----BEGIN CERTIFICATE-----\nMIIDdz');
			expect(r.entries).toEqual([]);
			expect(r.unterminated).toEqual(["TLS_CERT"]);
		});

		it("still parses entries that follow a completed multi-line value", () => {
			const r = parseDotenv(`A="x\ny"\n# comment\nB=2`);
			expect(r.entries.map((e) => e.name)).toEqual(["A", "B"]);
		});

		it("an escaped quote does not close the value", () => {
			const r = parseDotenv('A="say \\"hi\\"\nsecond"');
			expect(r.entries[0].value).toBe('say "hi"\nsecond');
		});
	});

	it("returns nothing for empty input", () => {
		const r = parseDotenv("");
		expect(r.entries).toEqual([]);
		expect(r.skippedLines).toBe(0);
	});
});

describe("isValidEnvName", () => {
	it("accepts shell identifiers", () => {
		for (const n of ["FOO", "_A1", "a", "MY_VAR_2", "PATH"]) {
			expect(isValidEnvName(n)).toBe(true);
		}
	});

	it("rejects non-identifiers", () => {
		for (const n of ["", "1FOO", "FOO-BAR", "FOO BAR", "FÖÖ", 'a"; rm -rf ~']) {
			expect(isValidEnvName(n)).toBe(false);
		}
	});

	it("rejects Abundio-owned names case-insensitively", () => {
		for (const n of [
			"ABUNDIO_X",
			"abundio_x",
			"Abundio_X",
			"zdotdir",
			"TERM",
		]) {
			expect(isValidEnvName(n)).toBe(false);
		}
	});
});

describe("injectionCost", () => {
	// Mirrors env_crypto::injection_cost. If this drifts, the Add form starts
	// accepting variables that build_env_injection silently drops at spawn.
	it("matches the Rust formula", () => {
		// (name + value + 2) * 2 + "ABUNDIO_ENV__".length + name + 1
		expect(injectionCost(5, 3)).toBe((5 + 3 + 2) * 2 + 13 + 5 + 1);
		expect(injectionCost(0, 0)).toBe(2 * 2 + 13 + 0 + 1);
		expect(injectionCost(1, 5)).toBe((1 + 5 + 2) * 2 + 13 + 1 + 1);
	});

	it("is materially larger than a naive name+value estimate", () => {
		// The bug this replaced: TOKEN=abc predicted 8 bytes, really costs 39.
		expect(injectionCost(5, 3)).toBe(39);
		expect(injectionCost(5, 3)).toBeGreaterThan(5 + 3);
	});
});
