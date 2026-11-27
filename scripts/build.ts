// Builds the extension into a flat dist/: one self-contained iife file per entry plus the static files.
// Usage: node scripts/build.ts
import { copyFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const distDir = join(root, "dist");

// Each entry is built separately so every output is a classic script with no import statements.
const ENTRIES = ["background", "content", "options"];
const STATIC_FILES = ["manifest.json", "options.html"];

rmSync(distDir, { recursive: true, force: true });
for (const name of ENTRIES) {
  await build({
    configFile: false,
    root,
    publicDir: false,
    logLevel: "warn",
    build: {
      outDir: distDir,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: join(srcDir, `${name}.ts`),
        formats: ["iife"],
        name: `browserTranslator_${name}`,
        fileName: () => `${name}.js`,
      },
    },
  });
}
for (const file of STATIC_FILES)
  copyFileSync(join(srcDir, file), join(distDir, file));
console.log(
  `built ${[...ENTRIES.map((n) => `${n}.js`), ...STATIC_FILES].join(", ")} into dist/`,
);
