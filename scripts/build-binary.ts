#!/usr/bin/env bun
//
// Build the self-contained `lain` binary with `bun build --compile`.
//
//   bun scripts/build-binary.ts [--out-dir dist-bin]
//
// What it does:
//   1. Builds every package (turbo) so @lain/core etc. have dist/, AND builds
//      the web client as a single self-contained index.html (vite-singlefile)
//      so it can be embedded into the binary.
//   2. Compiles packages/cli/src/bin.ts into one executable, embedding the Bun
//      runtime + all JS + the OpenTUI native lib + the web client.
//
// OpenTUI ships per-platform/libc native packages and resolves them with a
// conditional dynamic import(); `bun --compile` tries to resolve EVERY branch,
// so we `--external` the variants that don't match the build host (only the
// host's optional dep is installed). Therefore we build NATIVELY per platform
// (the release CI runs this on a matching runner for each target).
//
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = argValue("--out-dir") ?? path.join(REPO, "dist-bin");

const ALL_OPENTUI_VARIANTS = [
  "linux-x64", "linux-x64-musl", "linux-arm64", "linux-arm64-musl",
  "darwin-x64", "darwin-arm64", "win32-x64",
];

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: opts.cwd ?? REPO, env: opts.env ?? process.env });
  if (r.status !== 0) {
    console.error(`\n✗ command failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

function capture(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: "utf-8" });
  return (r.stdout ?? "").trim();
}

/** Host platform → { bunTarget, openTuiVariant, assetName }. */
function hostTarget() {
  const libc = process.env.LAIN_LIBC === "musl" ? "-musl" : "";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "linux") {
    return { bunTarget: `bun-linux-${arch}`, variant: `linux-${arch}${libc}`, asset: `lain-linux-${arch}${libc}` };
  }
  if (process.platform === "darwin") {
    return { bunTarget: `bun-darwin-${arch}`, variant: `darwin-${arch}`, asset: `lain-darwin-${arch}` };
  }
  if (process.platform === "win32") {
    return { bunTarget: "bun-windows-x64", variant: "win32-x64", asset: "lain-windows-x64.exe" };
  }
  throw new Error(`unsupported build host: ${process.platform}-${process.arch}`);
}

function main() {
  const { bunTarget, variant, asset } = hostTarget();
  const version = (() => {
    if (process.env.LAIN_VERSION) return process.env.LAIN_VERSION;
    // Raw version (no leading "v") — the banner adds its own "v" prefix.
    try { return JSON.parse(fs.readFileSync(path.join(REPO, "packages/cli/package.json"), "utf-8")).version; }
    catch { return "0.0.0"; }
  })();
  const commit = process.env.LAIN_COMMIT || capture("git", ["-C", REPO, "rev-parse", "--short", "HEAD"]) || "unknown";
  const branch = process.env.LAIN_BRANCH || "release";

  console.log(`\n=== lain binary build ===`);
  console.log(`  host:     ${process.platform}-${process.arch}  →  target ${bunTarget}`);
  console.log(`  opentui:  keep @opentui/core-${variant} (external the rest)`);
  console.log(`  version:  ${version}  commit ${commit}\n`);

  // 1. Build all packages + the single-file web client.
  console.log("→ building packages + web client (turbo build)...");
  sh("pnpm", ["build"]);

  const clientHtml = path.join(REPO, "packages/web/dist/index.html");
  if (!fs.existsSync(clientHtml)) {
    console.error(`✗ web client not built: ${clientHtml}`);
    process.exit(1);
  }
  console.log(`  ✓ web client: ${(fs.statSync(clientHtml).size / 1024).toFixed(0)} KB single-file\n`);

  // 2. Compile the binary.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, asset);
  const externals = ALL_OPENTUI_VARIANTS
    .filter((v) => v !== variant)
    .flatMap((v) => ["--external", `@opentui/core-${v}`]);

  const defines = [
    "--define", `process.env.LAIN_VERSION=${JSON.stringify(version)}`,
    "--define", `process.env.LAIN_COMMIT=${JSON.stringify(commit)}`,
    "--define", `process.env.LAIN_BRANCH=${JSON.stringify(branch)}`,
  ];

  console.log(`→ bun build --compile → ${outFile}`);
  sh("bun", [
    "build", "--compile",
    "--target", bunTarget,
    "packages/cli/src/bin.ts",
    "--outfile", outFile,
    ...externals,
    ...defines,
  ]);

  // Convenience: also expose an unsuffixed `lain` for local runs.
  if (process.platform !== "win32") {
    const plain = path.join(OUT_DIR, "lain");
    fs.copyFileSync(outFile, plain);
    fs.chmodSync(plain, 0o755);
  }

  const sizeMB = (fs.statSync(outFile).size / 1024 / 1024).toFixed(0);
  console.log(`\n✓ built ${asset} (${sizeMB} MB)`);
  console.log(`  ${outFile}\n`);
}

main();
