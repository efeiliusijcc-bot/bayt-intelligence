/**
 * 跨平台测试入口：Windows cmd不会展开tests/*.test.ts，因此由Node明确列出测试文件。
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const testRoot = path.resolve("tests");
const testFiles = (await readdir(testRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => path.join(testRoot, entry.name))
  .sort();

if (!testFiles.length) {
  throw new Error(`No TypeScript test files were found in ${testRoot}`);
}

const child = spawn(
  process.execPath,
  ["--experimental-strip-types", "--test", ...testFiles],
  { stdio: "inherit" },
);

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Test process exited from signal ${signal}`));
    else resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
