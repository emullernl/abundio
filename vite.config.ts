import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

/**
 * pdf.js loads its CMaps (CJK text), standard fonts (PDFs that don't embed
 * theirs), colour profiles and wasm image decoders by URL at run time. Serve
 * them under `/pdfjs/` in dev and copy them into the build, so the app never
 * fetches anything from the network (docs/plans/pdf-viewer.md).
 */
const PDFJS_ROOT = "node_modules/pdfjs-dist";
const PDFJS_DIRS = ["cmaps", "standard_fonts", "iccs", "wasm"];
function pdfjsAssets(): Plugin {
	return {
		name: "abundio-pdfjs-assets",
		configureServer(server) {
			server.middlewares.use("/pdfjs", (req, res, next) => {
				const rel = decodeURIComponent((req.url ?? "").split("?")[0]);
				const [dir, name, ...rest] = rel.replace(/^\//, "").split("/");
				if (!PDFJS_DIRS.includes(dir) || !name || rest.length > 0) {
					return next();
				}
				const file = join(PDFJS_ROOT, dir, name);
				try {
					if (!statSync(file).isFile()) return next();
				} catch {
					return next();
				}
				if (name.endsWith(".wasm")) {
					res.setHeader("Content-Type", "application/wasm");
				}
				createReadStream(file).pipe(res);
			});
		},
		generateBundle() {
			for (const dir of PDFJS_DIRS) {
				for (const name of readdirSync(join(PDFJS_ROOT, dir))) {
					this.emitFile({
						type: "asset",
						fileName: `pdfjs/${dir}/${name}`,
						source: readFileSync(join(PDFJS_ROOT, dir, name)),
					});
				}
			}
		},
	};
}

export default defineConfig(async () => ({
	plugins: [react(), tailwindcss(), pdfjsAssets()],
	build: {
		chunkSizeWarningLimit: 2000,
	},
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			ignored: ["**/src-tauri/**"],
		},
	},
}));
