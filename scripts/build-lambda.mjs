/**
 * Bundle the Lambda handler into dist/index.mjs.
 *
 * - ESM output so `import.meta` keeps working.
 * - @aws-sdk/* left external — the Lambda Node.js runtime ships it.
 * - tiny plugin rewrites ".js" import specifiers to their ".ts" source
 *   (the codebase uses NodeNext-style .js extensions that tsx resolves at
 *   runtime, but esbuild needs the real files when bundling).
 *
 * Terraform's archive_file then zips dist/ into the deployment package.
 */
import { build } from "esbuild";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const resolveTsExtensions = {
  name: "ts-ext",
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.importer === "") return; // entry point
      const tsPath = path.resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      if (existsSync(tsPath)) return { path: tsPath };
      return; // let esbuild handle non-relative / real .js
    });
  },
};

await build({
  entryPoints: [path.join(root, "src/lambda/handler.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: path.join(root, "dist/index.mjs"),
  external: ["@aws-sdk/*"],
  plugins: [resolveTsExtensions],
  logLevel: "info",
});

console.log("✅ built dist/index.mjs");
