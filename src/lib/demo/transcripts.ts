/**
 * Canned terminal transcripts for demo mode, plus the base64 encoder used to
 * deliver them on the `pty-output-<ptyId>` channel (the `pty.onOutput` wrapper
 * base64-decodes `event.payload.data`, so the mock must encode to match).
 *
 * Transcripts use CRLF line endings so xterm advances rows correctly, and
 * SGR escapes (`\x1b[...m`) for colour. They are written once, immediately, so
 * screenshots are stable and non-animated.
 */

/** UTF-8 → base64. Counterpart to `decodeBase64` in `lib/base64.ts`. */
export function encodeBase64(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const ORANGE = "\x1b[38;5;208m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const GREY = "\x1b[90m";
const MAGENTA = "\x1b[35m";

/** Claude Code mid-task — headline agent, amber "active" dot. */
const claudeSession = [
	`${DIM}~/code/acme-web${RESET} ${GREEN}❯${RESET} claude`,
	"",
	`${ORANGE}✻${RESET} ${BOLD}Claude Code${RESET} ${DIM}v2.0.14${RESET}`,
	`${DIM}  /Users/demo/code/acme-web · feature/checkout-redesign${RESET}`,
	"",
	`${GREY}> Refactor the checkout flow to validate the cart total before`,
	`  submitting the payment intent.${RESET}`,
	"",
	`${ORANGE}✻${RESET} Reading the current checkout implementation…`,
	`${DIM}  ⎿  Read src/api/checkout.ts (148 lines)${RESET}`,
	`${DIM}  ⎿  Read src/components/Cart.tsx (96 lines)${RESET}`,
	"",
	`${ORANGE}●${RESET} I'll add a guard that re-derives the total from the line`,
	`  items and rejects mismatched client-supplied totals.`,
	"",
	`${DIM}  Edit src/api/checkout.ts${RESET}`,
	`${GREEN}    + if (computedTotal !== payload.total) {${RESET}`,
	`${GREEN}    +   throw new CheckoutError("cart_total_mismatch");${RESET}`,
	`${GREEN}    + }${RESET}`,
	"",
	`${ORANGE}✻${RESET} Validating the change…  ${DIM}(esc to interrupt)${RESET}`,
	"",
].join("\r\n");

/** GitHub Copilot CLI — task finished, purple "ready" dot. */
const copilotSession = [
	`${DIM}~/code/payments-api${RESET} ${GREEN}❯${RESET} copilot`,
	"",
	`${CYAN}●${RESET} ${BOLD}GitHub Copilot CLI${RESET}`,
	`${DIM}  /Users/demo/code/payments-api · main${RESET}`,
	"",
	`${GREY}> Add retry-with-backoff to the Stripe webhook handler.${RESET}`,
	"",
	`${CYAN}●${RESET} Wrapped the handler in an exponential-backoff retry (5`,
	`  attempts, 200ms base) and added a dead-letter log on exhaustion.`,
	"",
	`${DIM}  Edited src/webhooks/stripe.ts  (+34 −6)${RESET}`,
	`${DIM}  Ran tests: ${RESET}${GREEN}24 passed${RESET}`,
	"",
	`${GREEN}✓ Done.${RESET} ${DIM}Anything else?${RESET}`,
	"",
].join("\r\n");

/** Vite dev server log — cyan "working" shell. */
const devServer = [
	`${DIM}~/code/acme-web${RESET} ${GREEN}❯${RESET} pnpm dev`,
	"",
	`  ${MAGENTA}${BOLD}VITE${RESET} ${GREEN}v8.0.3${RESET}  ready in ${BOLD}312${RESET} ms`,
	"",
	`  ${GREEN}➜${RESET}  ${BOLD}Local${RESET}:   ${CYAN}http://localhost:5173/${RESET}`,
	`  ${GREEN}➜${RESET}  ${BOLD}Network${RESET}: ${DIM}use --host to expose${RESET}`,
	"",
	`${DIM}9:41:02 AM${RESET} ${CYAN}[vite]${RESET} hmr update ${DIM}/src/components/Cart.tsx${RESET}`,
	`${DIM}9:41:07 AM${RESET} ${CYAN}[vite]${RESET} hmr update ${DIM}/src/api/checkout.ts${RESET}`,
	"",
].join("\r\n");

/** Idle shell — green prompt, no activity. */
const idleShell = [
	`${DIM}~/code/acme-web${RESET} ${GREEN}❯${RESET} git status -sb`,
	`${GREEN}## feature/checkout-redesign...origin/feature/checkout-redesign${RESET}`,
	` ${GREEN}M${RESET} src/api/checkout.ts`,
	` ${RED}M${RESET} src/components/Cart.tsx`,
	"",
	`${DIM}~/code/acme-web${RESET} ${GREEN}❯${RESET} `,
].join("\r\n");

/** A second idle shell in the Code tab. */
const scratchShell = [
	`${DIM}~/code/acme-web${RESET} ${GREEN}❯${RESET} npm test -- checkout`,
	"",
	`${GREEN}PASS${RESET} ${DIM}src/api/__tests__/checkout.test.ts${RESET}`,
	`  checkout`,
	`    ${GREEN}✓${RESET} rejects a mismatched cart total ${DIM}(4 ms)${RESET}`,
	`    ${GREEN}✓${RESET} creates a payment intent for a valid cart ${DIM}(7 ms)${RESET}`,
	"",
	`Tests:       ${GREEN}2 passed${RESET}, 2 total`,
	"",
	`${DIM}~/code/acme-web${RESET} ${GREEN}❯${RESET} `,
].join("\r\n");

/** Google Gemini CLI — agent working, amber. */
const geminiSession = [
	`${DIM}~/code/ml-pipeline${RESET} ${GREEN}❯${RESET} gemini`,
	"",
	`${CYAN}✦${RESET} ${BOLD}Gemini CLI${RESET} ${DIM}v0.3.1${RESET}`,
	`${DIM}  /Users/demo/code/ml-pipeline · feature/training-loop${RESET}`,
	"",
	`${GREY}> Optimise the data loader to prefetch batches on the GPU.${RESET}`,
	"",
	`${CYAN}✦${RESET} Profiling the current input pipeline…`,
	`${DIM}  ⎿  Read src/data/loader.py (211 lines)${RESET}`,
	"",
	`${CYAN}●${RESET} Added a prefetch buffer (depth 4) with pinned memory.`,
	`${DIM}  Edit src/data/loader.py${RESET}`,
	`${GREEN}    + loader = DataLoader(ds, num_workers=8, pin_memory=True)${RESET}`,
	`${GREEN}    + loader = Prefetcher(loader, depth=4)${RESET}`,
	"",
	`${CYAN}✦${RESET} Running the throughput benchmark…  ${DIM}(esc to cancel)${RESET}`,
	"",
].join("\r\n");

/** Aider — finished an edit, asking a follow-up (waiting, skyblue). */
const aiderSession = [
	`${DIM}~/code/design-system${RESET} ${GREEN}❯${RESET} aider`,
	"",
	`${BOLD}Aider${RESET} ${DIM}v0.64.1 · gpt-4o${RESET}`,
	"",
	`${GREY}> Add dark-mode color tokens to the design system.${RESET}`,
	"",
	`${GREEN}Applied edit to tokens/color.css${RESET}`,
	`${DIM}  + --bg-dark, --fg-dark, --accent-dark${RESET}`,
	`${DIM}  Commit 3f9a2c1  feat: dark-mode color tokens${RESET}`,
	"",
	`${MAGENTA}?${RESET} Apply the same palette to tokens/elevation.css? ${DIM}(y/n)${RESET}`,
	"",
].join("\r\n");

/** OpenAI Codex CLI — run failed (error, red). */
const codexSession = [
	`${DIM}~/code/infra-terraform${RESET} ${GREEN}❯${RESET} codex`,
	"",
	`${BOLD}Codex${RESET} ${DIM}· o4-mini${RESET}`,
	"",
	`${GREY}> Migrate the VPC module to the new AWS provider.${RESET}`,
	"",
	`${DIM}●${RESET} Rewriting modules/vpc/main.tf …`,
	`${DIM}  Running terraform init${RESET}`,
	"",
	`${RED}✗ Error:${RESET} provider ${BOLD}aws${RESET} requires version >= 5.0,`,
	`${RED}  found 4.67.0 — terraform init failed (exit 1)${RESET}`,
	"",
	`${DIM}The migration needs the provider pinned to ^5.0 first.${RESET}`,
	"",
].join("\r\n");

/** OpenCode — agent working, amber. */
const opencodeSession = [
	`${DIM}~/code/game-server${RESET} ${GREEN}❯${RESET} opencode`,
	"",
	`${MAGENTA}●${RESET} ${BOLD}OpenCode${RESET}`,
	`${DIM}  /Users/demo/code/game-server · feature/matchmaking${RESET}`,
	"",
	`${GREY}> Implement matchmaking by skill rating.${RESET}`,
	"",
	`${MAGENTA}●${RESET} Adding an Elo-based matcher…`,
	`${GREEN}    internal/match/elo.go (+88 −0)${RESET}`,
	`${DIM}  Running go test ./internal/match/…${RESET}`,
	`${GREEN}    ok  game-server/internal/match  0.214s${RESET}`,
	"",
	`${MAGENTA}●${RESET} Wiring the matcher into the lobby loop…  ${DIM}(working)${RESET}`,
	"",
].join("\r\n");

/** Qwen Code — finished a draft, awaiting confirmation (waiting, skyblue). */
const qwenSession = [
	`${DIM}~/code/data-warehouse${RESET} ${GREEN}❯${RESET} qwen`,
	"",
	`${ORANGE}●${RESET} ${BOLD}Qwen Code${RESET}`,
	"",
	`${GREY}> Write an incremental load for the orders fact table.${RESET}`,
	"",
	`${ORANGE}●${RESET} Drafted a MERGE on order_id with a watermark column.`,
	`${GREEN}    models/fact_orders.sql (+41 −7)${RESET}`,
	"",
	`${MAGENTA}?${RESET} First run will full-refresh the table — proceed? ${DIM}(y/N)${RESET}`,
	"",
].join("\r\n");

/** Finished training run (idle shell). */
const pythonTrain = [
	`${DIM}~/code/ml-pipeline${RESET} ${GREEN}❯${RESET} python train.py --epochs 10`,
	`${DIM}Epoch  1/10${RESET}  loss ${RED}0.842${RESET}  acc ${GREEN}0.71${RESET}`,
	`${DIM}Epoch  4/10${RESET}  loss ${RED}0.401${RESET}  acc ${GREEN}0.86${RESET}`,
	`${DIM}Epoch  7/10${RESET}  loss ${RED}0.219${RESET}  acc ${GREEN}0.92${RESET}`,
	`${DIM}Epoch 10/10${RESET}  loss ${RED}0.118${RESET}  acc ${GREEN}0.95${RESET}`,
	`${GREEN}✓${RESET} saved checkpoint to runs/2026-05-30/best.pt`,
	"",
	`${DIM}~/code/ml-pipeline${RESET} ${GREEN}❯${RESET} `,
].join("\r\n");

/** terraform plan output (idle shell). */
const terraformPlan = [
	`${DIM}~/code/infra-terraform${RESET} ${GREEN}❯${RESET} terraform plan`,
	"",
	`${GREEN}  + ${RESET}aws_subnet.private[2]`,
	`${ORANGE}  ~ ${RESET}aws_security_group.api`,
	`${GREEN}  + ${RESET}aws_nat_gateway.this`,
	"",
	`${BOLD}Plan:${RESET} ${GREEN}3 to add${RESET}, ${ORANGE}1 to change${RESET}, 0 to destroy.`,
	"",
	`${DIM}~/code/infra-terraform${RESET} ${GREEN}❯${RESET} `,
].join("\r\n");

/** dbt run output (idle shell). */
const sqlRun = [
	`${DIM}~/code/data-warehouse${RESET} ${GREEN}❯${RESET} dbt run --select fact_orders`,
	`${DIM}Running with dbt=1.8.3${RESET}`,
	`${GREEN}1 of 1 OK${RESET} created incremental model ${BOLD}fact_orders${RESET} ${DIM}[INSERT 12.4k]${RESET}`,
	`${GREEN}Done.${RESET} PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1`,
	"",
	`${DIM}~/code/data-warehouse${RESET} ${GREEN}❯${RESET} `,
].join("\r\n");

/** Transcripts keyed by name; referenced from `fixtures.agentPanes`. */
export const TRANSCRIPTS: Record<string, string> = {
	claudeSession,
	copilotSession,
	devServer,
	idleShell,
	scratchShell,
	geminiSession,
	aiderSession,
	codexSession,
	opencodeSession,
	qwenSession,
	pythonTrain,
	terraformPlan,
	sqlRun,
};
