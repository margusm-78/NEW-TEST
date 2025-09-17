import fs from "fs";
import path from "path";

const SRC_DIR = path.resolve("src");

function walk(dir: string, acc: string[] = []): string[] {
  const ents = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function ensureImports(src: string, filePath: string): string {
  const hasInterfaceAbi = /from\s+["']ethers["']/.test(src) && /InterfaceAbi/.test(src);
  const hasHelper = /from\s+["'][.\/].*abi-helpers["']/.test(src) && /asInterfaceAbi/.test(src);

  let out = src;
  const rel = path.relative(path.dirname(filePath), path.resolve("src/abi/abi-helpers")).replace(/\\/g, "/");
  const helperImport = `import { asInterfaceAbi } from "${rel.startsWith(".") ? rel : "./" + rel}";\n`;

  if (!hasInterfaceAbi) out = `import type { InterfaceAbi } from "ethers";\n` + out;
  if (!hasHelper) out = helperImport + out;
  return out;
}

function fixOne(file: string) {
  let src = fs.readFileSync(file, "utf8");
  const before = src;

  if (!/new\s+ethers\.Contract\(/.test(src)) return;

  // Enforce InterfaceAbi for any "*Abi" identifier
  src = src.replace(
    /new\s+ethers\.Contract\(\s*([^,]+),\s*([A-Za-z0-9_]+Abi)\s*,/g,
    (_m, a1, a2) => `new ethers.Contract(${a1}, asInterfaceAbi(${a2}) as InterfaceAbi,`
  );

  if (src !== before) {
    src = ensureImports(src, file);
    fs.writeFileSync(file, src, "utf8");
    console.log("patched:", path.relative(process.cwd(), file));
  }
}

walk(SRC_DIR).forEach(fixOne);
console.log("done.");
