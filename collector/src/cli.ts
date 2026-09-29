#!/usr/bin/env node
/**
 * 命令行入口：把用户输入的参数翻译成采集器函数调用。
 * 第一行shebang让系统知道可用Node运行本文件；它不是普通TypeScript语句。
 */
import path from "node:path";
import { login, runCollection, verifyLatest } from "./collector.ts";
import { DEFAULT_QUERY, DEFAULT_TARGET, PREFLIGHT_TARGET, RUNS_DIR } from "./config.ts";
import { LoginRequiredError, SafetyStopError } from "./bayt.ts";

// 解析完成后的命令结构；`number | null`表示“数字或尚未提供”。
interface ParsedArguments {
  command: string;
  target: number | null;
  query: string | null;
  runId: string | null;
  headless: boolean;
}

/**
 * 逐个读取命令行参数。
 * `argv[++index]`会先把下标加1，再读取选项后面的值，例如`--target 500`中的500。
 */
function parseArguments(argv: string[]): ParsedArguments {
  const command = argv[0] || "help";
  let target: number | null = null;
  let query: string | null = null;
  let runId: string | null = null;
  let headless = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") target = Number.parseInt(argv[++index] || "", 10);
    else if (argument === "--query") query = argv[++index] || null;
    else if (argument === "--run") runId = argv[++index] || null;
    else if (argument === "--headless") headless = true;
    else throw new Error(`Unknown argument: ${argument}`); // 模板字符串用反引号把变量嵌进文本。
  }
  if (target !== null && (!Number.isInteger(target) || target < 1 || target > 10_000)) {
    throw new Error("--target must be an integer between 1 and 10000");
  }
  return { command, target, query, runId, headless };
}

/** 输出帮助文本。`void`表示函数不返回业务数据。 */
function usage(): void {
  process.stdout.write(`
Bayt CV collector

Commands:
  npm run login
  npm run preflight
  npm run collect -- --target 500
  npm run resume -- --run RUN_ID
  npm run verify -- --run RUN_ID

Direct usage:
  node --experimental-strip-types src/cli.ts <command> [options]

Options:
  --target N       Unique candidate target (preflight=10, collect=500)
  --query TEXT     Search query (default: Software Engineer)
  --run RUN_ID     Resume or verify a specific run
  --headless       Run without showing the browser; login must already exist
`);
}

/** 根据命令执行登录、验证、预检、正式采集或断点恢复。 */
async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(args.command)) {
    usage();
    return;
  }
  if (args.command === "login") {
    await login();
    return;
  }
  if (args.command === "verify") {
    const result = await verifyLatest(args.runId || undefined);
    // JSON.stringify的第三个参数2表示缩进两个空格，方便人阅读。
    process.stdout.write(
      `${JSON.stringify({
        runId: result.run.runId,
        status: result.run.status,
        ok: result.ok,
        errors: result.errors,
        warnings: result.warnings,
        report: path.join(RUNS_DIR, result.run.runId, "verification_report.md"),
      }, null, 2)}\n`,
    );
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (!["preflight", "collect", "resume"].includes(args.command)) {
    usage();
    throw new Error(`Unknown command: ${args.command}`);
  }
  const target =
    args.command === "preflight"
      ? args.target || PREFLIGHT_TARGET
      : args.command === "collect"
        ? args.target || DEFAULT_TARGET
        : args.target || DEFAULT_TARGET;
  // `as`只帮助TypeScript收窄类型，不会在运行时修改字符串。
  const run = await runCollection({
    command: args.command as "preflight" | "collect" | "resume",
    target,
    query: args.query || DEFAULT_QUERY,
    runId: args.runId || undefined,
    headless: args.headless,
  });
  process.stdout.write(
    `${JSON.stringify({
      runId: run.runId,
      status: run.status,
      uniqueCount: run.uniqueCount,
      report: path.join(RUNS_DIR, run.runId, "verification_report.md"),
    }, null, 2)}\n`,
  );
}

// 顶层统一处理异常并设置不同退出码，方便脚本/计划任务判断失败种类。
main().catch((error) => {
  // `instanceof`判断错误属于哪个自定义错误类。
  if (error instanceof LoginRequiredError) {
    process.stderr.write("LOGIN_REQUIRED: 请先运行 npm run login，并在专用浏览器窗口完成登录。\n");
    process.exitCode = 2;
    return;
  }
  if (error instanceof SafetyStopError) {
    process.stderr.write(`SAFETY_STOP [${error.reason}]: ${error.message}\n`);
    process.exitCode = 3;
    return;
  }
  // 未知错误保留堆栈，便于开发者排查。
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
