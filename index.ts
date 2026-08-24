import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  InputRenderable,
  RGBA,
  SyntaxStyle,
  type KeyEvent,
} from "@opentui/core";
import packageJson from "./package.json" with { type: "json" };
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, watch } from "fs";
import { join, relative, resolve } from "path";
import { homedir, tmpdir } from "os";
import * as readline from "node:readline/promises";

function parseVariables(src: string): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const line of src.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]*))?\s*(?:#.*)?$/);
    if (match) variables[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return variables;
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "termurl");
const CONFIG_FILE = join(CONFIG_DIR, "config.toml");
const DEFAULT_COLLECTION = "~/collection";

function loadConfig(): Record<string, string> {
  try {
    return parseVariables(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function cliArgs(): string[] {
  const args = process.argv[1]?.endsWith(".ts") ? process.argv.slice(2) : process.argv.slice(1);
  return args.filter((arg) => !arg.startsWith("/$bunfs/") && arg !== Bun.main);
}

function scaffoldCollection(dir: string) {
  if (existsSync(dir) && readdirSync(dir).length > 0) return;
  mkdirSync(join(dir, "httpbin"), { recursive: true });
  writeFileSync(join(dir, ".env.dev"), "# dev environment variables\nhost=https://httpbin.org\n");
  writeFileSync(join(dir, ".env.example"), "# Shared secrets for all environments (copy to .env, keep it out of version control)\n# token=secret-value\n");
  writeFileSync(join(dir, "httpbin", "get.hurl"), "# Sample request\nGET {{host}}/get\nHTTP 200\n");
}

async function runInit(defaultPath: string, nonInteractive = false) {
  if (existsSync(CONFIG_FILE)) {
    console.log(`config already exists: ${CONFIG_FILE}`);
    return;
  }
  let collectionPath: string;
  if (nonInteractive) {
    collectionPath = resolve(expandHome(defaultPath));
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`termurl setup\nCollection path [${defaultPath}]: `);
    rl.close();
    collectionPath = resolve(expandHome(answer.trim() || defaultPath));
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `# termurl configuration\ncollection = "${collectionPath}"\n`);
  scaffoldCollection(collectionPath);
  console.log(`config written: ${CONFIG_FILE}`);
  console.log(`collection: ${collectionPath}`);
  console.log("run `termurl` to start");
}

const args = cliArgs();
const HEADLESS_COMMANDS = new Set(["doctor", "list", "show", "env", "run"]);
const HELP = `termurl - a terminal client for hurl collections

usage:
  termurl [collection]                         open the interactive TUI
  termurl init [path] [--yes]                  create config and a starter collection
  termurl doctor [--json]                      check hurl, config, and collection setup
  termurl list [--json]                        list requests
  termurl show <request>                       print a request file
  termurl env list [--json]                    list environments
  termurl env show <name> [--reveal] [--json]  show environment variables
  termurl run <request...> [options]            run requests in argument order
  termurl --version                            print the version

run options:
  --env <name>     choose an environment
  --var KEY=value  add a variable, repeatable
  --json           print structured results to stdout
  -q, --quiet      suppress the run report on stderr

Exit codes: 0 success, 1 usage or configuration error, 2 runtime error, 3 assert failure.
`;

const hasFlag = (name: string) => args.includes(name);

if (args[0] === "init") {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log("usage: termurl init [path] [--yes]");
    process.exit(0);
  }
  await runInit(args.slice(1).find((arg) => !arg.startsWith("-")) ?? DEFAULT_COLLECTION, hasFlag("--yes"));
  process.exit(0);
}

if (args[0] === "help" || hasFlag("--help") || hasFlag("-h")) {
  console.log(HELP);
  process.exit(0);
}

if (args[0] === "version" || hasFlag("--version")) {
  console.log(packageJson.version);
  process.exit(0);
}

const isDoctor = args[0] === "doctor";
if (!HEADLESS_COMMANDS.has(args[0] ?? "") && (args.includes("--env") || args.some((arg) => arg.startsWith("--env=")) || args.includes("--json") || args.includes("--var") || args.some((arg) => arg.startsWith("--var=")))) {
  console.error(`termurl: did you mean \`termurl run ${args.join(" ")}\`?`);
  process.exit(1);
}
const cliCollection = HEADLESS_COMMANDS.has(args[0] ?? "") ? undefined : args.find((arg) => !arg.startsWith("-"));

if (!isDoctor && !existsSync(CONFIG_FILE)) {
  console.error(`termurl is not set up. Run \`termurl init\` to create ${CONFIG_FILE}`);
  process.exit(1);
}
const CONFIG = loadConfig();
const collectionSetting = isDoctor ? CONFIG.collection : cliCollection ?? CONFIG.collection;
if (!isDoctor && !collectionSetting) {
  console.error(`no collection configured. Set collection in ${CONFIG_FILE} or pass a collection path.`);
  process.exit(1);
}
const COLLECTION = collectionSetting ? resolve(expandHome(collectionSetting)) : "";
if (!isDoctor && (!existsSync(COLLECTION) || !statSync(COLLECTION).isDirectory())) {
  const origin = cliCollection ? "passed as argument" : `set in ${CONFIG_FILE}`;
  console.error(`collection not found: ${COLLECTION} (${origin}). Fix the path or delete the config and run \`termurl init\`.`);
  process.exit(1);
}
const HISTORY_FILE = join(COLLECTION, ".termurl/history.jsonl");

const requests = loadRequests();
const environments = environmentNames();
if (environments.length === 0) environments.push("dev");
let environmentIdx = Math.max(0, environments.indexOf(CONFIG.environment ?? ""));
let cliVariables: Record<string, string> = {};

const C = {
  bg: "#1a1b26",
  fg: "#c0caf5",
  dim: "#565f89",
  yellow: "#e0af68",
  green: "#9ece6a",
  red: "#f7768e",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
};

type Req = { name: string; file: string; desc: string; method: string; path: string; vars: string[] };

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? (e === ".termurl" ? [] : walk(p)) : e.endsWith(".hurl") ? [p] : [];
  });
}

function loadRequests(collection = COLLECTION): Req[] {
  return walk(collection)
    .map((file) => {
      const src = readFileSync(file, "utf8");
      const name = relative(collection, file).replace(/\.hurl$/, "");
      const desc = src.match(/^# (.+)$/m)?.[1] ?? "";
      const reqLine = src.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+)/m);
      const method = reqLine?.[1] ?? "?";
      const path = (reqLine?.[2] ?? "").replace("{{host}}", "");
      const vars = [...new Set([...src.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]).filter((v) => v !== "host"))];
      return { name, file, desc, method, path, vars };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function section(src: string, name: string): string[] {
  const m = src.match(new RegExp(`^\\[${name}\\]\\n((?:[^\\[].*\\n?)*)`, "m"));
  return m ? m[1].trim().split("\n").filter(Boolean) : [];
}

type RunResult = {
  success: boolean;
  status: number;
  ms: number;
  asserts: { passed: number; total: number };
  captures: string[];
  captured: Record<string, string>;
  body: string;
  headers: string[];
  request?: { method: string; url: string; headers: string[] };
  error?: string;
};

type HurlJson = {
  success?: boolean;
  time?: number;
  entries?: Array<{
    asserts?: Array<{ success?: boolean; message?: string }>;
    captures?: Array<{ name?: string; value?: string }>;
    calls?: Array<{
      request?: { method?: string; url?: string; headers?: Array<{ name: string; value: string }> };
      response?: { status?: number; headers?: Array<{ name: string; value: string }> };
      timings?: { total?: number };
    }>;
    time?: number;
  }>;
};

function environmentFile(name: string, collection = COLLECTION): string {
  return join(collection, `.env.${name}`);
}

function environmentVariables(name: string, collection = COLLECTION): Record<string, string> {
  try {
    return parseVariables(readFileSync(environmentFile(name, collection), "utf8"));
  } catch {
    return {};
  }
}

function activeVariables(): Record<string, string> {
  return { ...environmentVariables(environments[environmentIdx]), ...cliVariables };
}

function renderTemplate(source: string): string {
  const variables = activeVariables();
  return source.replace(/\{\{([a-z_][a-z0-9_]*)\}\}/g, (match, key) => variables[key] ?? match);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const HTTP_STATUS_LINE = /^HTTP(\/[\d.]+)?\s+\d/;

const SECTION_HEADER = /^\[([A-Za-z]+)\]\s*$/;

function renderCurl(source: string): string | undefined {
  const lines = source.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || lines[i].trim().startsWith("#"))) i++;
  const reqLine = lines[i]?.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/);
  if (!reqLine) return undefined;
  const [, method, url] = reqLine;
  i++;

  const headers: [string, string][] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || HTTP_STATUS_LINE.test(line) || SECTION_HEADER.test(line) || line.startsWith("{") || line.startsWith("[")) break;
    const header = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (header) headers.push([header[1], header[2]]);
    i++;
  }

  const queryParams: [string, string][] = [];
  const formParams: [string, string][] = [];
  const cookies: [string, string][] = [];
  let basicAuth: string | undefined;

  let section: string | undefined;
  while (i < lines.length && (section = lines[i].match(SECTION_HEADER)?.[1])) {
    i++;
    const target = section === "QueryStringParams" ? queryParams : section === "FormParams" ? formParams : section === "Cookies" ? cookies : undefined;
    while (i < lines.length && lines[i].trim() !== "" && !HTTP_STATUS_LINE.test(lines[i]) && !SECTION_HEADER.test(lines[i])) {
      const pair = lines[i].match(/^([^:]+):\s*(.*)$/);
      if (pair) {
        if (target) target.push([pair[1].trim(), pair[2]]);
        else if (section === "BasicAuth") basicAuth = `${pair[1].trim()}:${pair[2]}`;
      }
      i++;
    }
    while (i < lines.length && lines[i].trim() === "") i++;
  }

  let body = "";
  if (lines[i]?.trim().startsWith("{") || lines[i]?.trim().startsWith("[")) {
    const bodyLines: string[] = [];
    while (i < lines.length && !HTTP_STATUS_LINE.test(lines[i])) {
      bodyLines.push(lines[i]);
      i++;
    }
    body = bodyLines.join("\n").trim();
  }

  const encodePair = ([key, value]: [string, string]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  const fullUrl = queryParams.length ? `${url}${url.includes("?") ? "&" : "?"}${queryParams.map(encodePair).join("&")}` : url;

  const parts = ["curl"];
  if (method !== "GET") parts.push("-X", method);
  parts.push(shellQuote(fullUrl));
  for (const [name, value] of headers) parts.push("-H", shellQuote(`${name}: ${value}`));
  if (cookies.length) parts.push("-H", shellQuote(`Cookie: ${cookies.map(([k, v]) => `${k}=${v}`).join("; ")}`));
  if (basicAuth) parts.push("-u", shellQuote(basicAuth));
  if (formParams.length) parts.push("--data", shellQuote(formParams.map(encodePair).join("&")));
  else if (body) parts.push("--data", shellQuote(body));
  return parts.join(" ");
}

function environmentNames(collection = COLLECTION): string[] {
  try {
    return readdirSync(collection)
      .filter((entry) => entry.startsWith(".env.") && !entry.endsWith(".example") && statSync(join(collection, entry)).isFile())
      .map((entry) => entry.slice(".env.".length))
      .sort();
  } catch {
    return [];
  }
}

function addResponseOutput(source: string, outputFile: string): string {
  const responseIndex = source.search(/^HTTP\s+/m);
  // A request may have no HTTP assertion at all (valid Hurl syntax for "just run it") —
  // fall back to the end of the request text instead of leaving the body uncaptured.
  const searchEnd = responseIndex >= 0 ? responseIndex : source.length;
  const prefix = source.slice(0, searchEnd);
  const bodyMatch = prefix.match(/^\s*(?:\{|<|```|`|base64,|hex,|file,)/m);
  const insertionIndex = bodyMatch?.index ?? searchEnd;
  const optionsIndex = prefix.search(/^\[Options\]\s*$/m);
  if (optionsIndex >= 0 && optionsIndex < insertionIndex) {
    const lineEnd = prefix.indexOf("\n", optionsIndex);
    const insertAt = lineEnd < 0 ? insertionIndex : lineEnd + 1;
    return `${source.slice(0, insertAt)}output: ${outputFile}\n${source.slice(insertAt)}`;
  }
  const before = source.slice(0, insertionIndex);
  const needsNewline = before.length > 0 && !before.endsWith("\n");
  return `${before}${needsNewline ? "\n" : ""}[Options]\noutput: ${outputFile}\n${source.slice(insertionIndex)}`;
}

function emptyRunResult(error: string): RunResult {
  return { success: false, status: 0, ms: 0, asserts: { passed: 0, total: 0 }, captures: [], captured: {}, headers: [], body: "", error };
}

function normalizeHurlError(error: string): string {
  const text = error.trim();
  const variables = [...text.matchAll(/you must set the variable\s+([a-zA-Z_][\w-]*)/g)].map((match) => match[1]);
  if (variables.length) return `Undefined variable: ${[...new Set(variables)].join(", ")}`;

  const title = text.match(/^error:\s*(.+)$/m)?.[1];
  const detail = text.match(/\)\s*([^\n]+)$/m)?.[1]?.trim();
  if (title && detail && detail !== title) return `${title}: ${detail}`;
  return title ?? text.split(/\r?\n/)[0] ?? "Unknown Hurl error";
}

function normalizeAssertMessage(message: string): string {
  const lines = message.split("\n");
  const title = (lines[0] ?? "").replace(/^error:\s*/, "").trim() || "Assert failed";
  const caret = lines.find((line) => /\^{2,}/.test(line));
  const detail = caret?.replace(/^.*?\^{2,}\s*/, "").trim();
  return detail ? `${title}: ${detail}` : title;
}

// Hurl only writes the [Options] output: file when its HTTP status assert passes.
// On a failing assert it aborts before writing the file, but it still dumps the
// response (headers + body) to stderr as part of the error report — recover the
// body from there instead of leaving it empty.
function extractBodyFromStderr(stderr: string): string {
  const match = stderr.match(/^HTTP\/[\d.]+\s+\d+.*\n(?:.+\n)*\n([\s\S]*?)\n\nerror:/m);
  return match?.[1] ?? "";
}

function prettyBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return body;
  }
}

const BODY_DISPLAY_LINES = 2000;

function formatBody(body: string): string {
  const pretty = prettyBody(body);
  const lines = pretty.split("\n");
  if (lines.length <= BODY_DISPLAY_LINES) return pretty;
  return `${lines.slice(0, BODY_DISPLAY_LINES).join("\n")}\n… truncated, showing ${BODY_DISPLAY_LINES} of ${lines.length} lines · press s to save the full body to a file`;
}

async function runHurl(requestsToRun: Req[]): Promise<RunResult[]> {
  const tempDir = mkdtempSync(join(tmpdir(), "termurl-run-"));
  const hurlFile = join(tempDir, "run.hurl");
  const outputFiles = requestsToRun.map((_, index) => `response-${index + 1}.body`);
  const source = requestsToRun
    .map((req, index) => addResponseOutput(readFileSync(req.file, "utf8"), outputFiles[index]))
    .join("\n\n");
  writeFileSync(hurlFile, source);

  const args = ["hurl", "--json", "--no-color", "--error-format", "long", "--file-root", tempDir];
  for (const [name, value] of Object.entries(activeVariables())) {
    args.push("--variable", `${name}=${value}`);
  }
  args.push(hurlFile);

  try {
    const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    let report: HurlJson | null = null;
    try { report = JSON.parse(stdout) as HurlJson; } catch {}
    const processError = stderr.trim() || `Hurl exited with code ${exitCode}`;

    return requestsToRun.map((req, index) => {
      const entry = report?.entries?.[index];
      const call = entry?.calls?.[entry.calls.length - 1];
      const asserts = entry?.asserts ?? [];
      const duration = entry?.time ?? (call?.timings?.total ? call.timings.total / 1000 : 0);
      const failedAsserts = asserts.filter((assert) => !assert.success).map((assert) => assert.message).filter(Boolean).map(normalizeAssertMessage);
      const bodyPath = join(tempDir, outputFiles[index]);
      let body = "";
      try { body = readFileSync(bodyPath, "utf8"); } catch {}
      if (!body && call?.response) body = extractBodyFromStderr(stderr);
      const status = call?.response?.status ?? 0;
      const error = failedAsserts.join("\n\n") || (!call ? normalizeHurlError(processError) : undefined);
      const captured = Object.fromEntries(
        (entry?.captures ?? [])
          .filter((capture) => capture.name)
          .map((capture) => [capture.name as string, capture.value ?? ""]),
      );
      return {
        success: Boolean(entry && status > 0 && failedAsserts.length === 0),
        status,
        ms: Math.round(duration),
        asserts: { passed: asserts.filter((assert) => assert.success).length, total: asserts.length },
        captures: captureNames(req),
        captured,
        headers: call?.response?.headers?.map((header) => `${header.name}: ${header.value}`) ?? [],
        body,
        ...(call?.request ? {
          request: {
            method: call.request.method ?? "",
            url: call.request.url ?? "",
            headers: call.request.headers?.map((header) => `${header.name}: ${header.value}`) ?? [],
          },
        } : {}),
        ...(error ? { error } : {}),
      };
    });
  } catch (error) {
    return requestsToRun.map(() => emptyRunResult(error instanceof Error ? error.message : String(error)));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function positionalArgs(values: string[]): string[] {
  const positional: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--env" || value === "--var") {
      index += 1;
      continue;
    }
    if (value.startsWith("--env=") || value.startsWith("--var=") || value === "--json" || value === "--reveal" || value === "--quiet" || value === "-q") continue;
    if (!value.startsWith("-")) positional.push(value);
  }
  return positional;
}

function optionValue(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index >= 0) return values[index + 1];
  const prefix = `${name}=`;
  const inline = values.find((value) => value.startsWith(prefix));
  return inline?.slice(prefix.length);
}

function parseCliVariables(values: string[]): { variables?: Record<string, string>; error?: string } {
  const variables: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument !== "--var" && !argument.startsWith("--var=")) continue;
    const pair = argument === "--var" ? values[++index] : argument.slice("--var=".length);
    if (pair === undefined) return { error: "--var requires KEY=value" };
    const separator = pair.indexOf("=");
    if (separator <= 0) return { error: `invalid variable ${pair}; expected KEY=value` };
    variables[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return { variables };
}

function requestForInput(input: string): Req | undefined {
  const withoutExtension = input.replace(/\.hurl$/, "");
  const absolute = resolve(input);
  const relativeName = COLLECTION ? relative(COLLECTION, absolute).replace(/\.hurl$/, "") : "";
  return requests.find((request) => request.name === input || request.name === withoutExtension || request.name === relativeName || request.file === absolute);
}

function unknownRequest(input: string): number {
  console.error(`termurl: unknown request "${input}"`);
  if (requests.length) console.error(`available requests:\n${requests.map((request) => `  ${request.name}`).join("\n")}`);
  return 1;
}

function listCommand(json: boolean): number {
  const result = requests.map((request) => ({
    name: request.name,
    file: request.file,
    method: request.method,
    path: request.path,
    description: request.desc,
    variables: request.vars,
  }));
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const width = requests.reduce((max, request) => Math.max(max, request.name.length), 0);
  for (const request of requests) {
    console.log(`${request.name.padEnd(width)}  ${request.method.padEnd(7)}  ${request.path}${request.desc ? `  - ${request.desc}` : ""}`);
  }
  return 0;
}

function showCommand(input: string | undefined): number {
  if (!input) {
    console.error("termurl: usage: termurl show <request>");
    return 1;
  }
  const request = requestForInput(input);
  if (!request) return unknownRequest(input);
  process.stdout.write(readFileSync(request.file, "utf8"));
  return 0;
}

function envListCommand(json: boolean): number {
  const names = environmentNames();
  if (json) {
    console.log(JSON.stringify(names, null, 2));
    return 0;
  }
  for (const name of names) console.log(name);
  return 0;
}

function envShowCommand(name: string | undefined, reveal: boolean, json: boolean): number {
  if (!name) {
    console.error("termurl: usage: termurl env show <name> [--reveal] [--json]");
    return 1;
  }
  const names = environmentNames();
  if (!names.includes(name)) {
    console.error(`termurl: unknown environment "${name}"`);
    console.error(`available environments: ${names.join(", ") || "none"}`);
    return 1;
  }
  const values = new Map<string, { value: string; source: string; secret: boolean }>();
  for (const [key, value] of Object.entries(environmentVariables(name))) values.set(key, { value, source: `.env.${name}`, secret: /^secret_/i.test(key) });
  const variables = [...values.entries()].map(([key, item]) => ({
    key,
    value: item.secret && !reveal ? "***" : item.value,
    source: item.source,
    secret: item.secret,
    masked: item.secret && !reveal,
  }));
  if (json) {
    console.log(JSON.stringify({ environment: name, variables }, null, 2));
    return 0;
  }
  for (const variable of variables) {
    const note = variable.secret && variable.masked ? ", masked" : "";
    console.log(`${variable.key} = ${variable.value}  (${variable.source}${note})`);
  }
  return 0;
}

function doctorCommand(json: boolean): number {
  let hurlVersion: string | undefined;
  try {
    const result = Bun.spawnSync({ cmd: ["hurl", "--version"], stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) hurlVersion = new TextDecoder().decode(result.stdout).trim();
  } catch {}

  const configExists = existsSync(CONFIG_FILE);
  const configuredCollection = CONFIG.collection ? resolve(expandHome(CONFIG.collection)) : undefined;
  const collectionExists = Boolean(configuredCollection && existsSync(configuredCollection) && statSync(configuredCollection).isDirectory());
  const collectionRequests = collectionExists ? loadRequests(configuredCollection as string).length : 0;
  const names = collectionExists ? environmentNames(configuredCollection as string) : [];
  const checks = {
    hurl: { ok: Boolean(hurlVersion), detail: hurlVersion ?? "not found on PATH; install hurl v8 or newer" },
    config: { ok: configExists, detail: configExists ? CONFIG_FILE : `missing; run termurl init to create ${CONFIG_FILE}` },
    collection: {
      ok: collectionExists,
      detail: collectionExists ? `${configuredCollection} (${collectionRequests} requests)` : configuredCollection ? `not found: ${configuredCollection}` : "not configured",
    },
    environments: { ok: collectionExists, names },
  };
  const ok = checks.hurl.ok && checks.config.ok && checks.collection.ok;
  if (json) {
    console.log(JSON.stringify({ ok, ...checks }, null, 2));
  } else {
    console.log(`${checks.hurl.ok ? "ok" : "fail"} hurl: ${checks.hurl.detail}`);
    console.log(`${checks.config.ok ? "ok" : "fail"} config: ${checks.config.detail}`);
    console.log(`${checks.collection.ok ? "ok" : "fail"} collection: ${checks.collection.detail}`);
    console.log(`info environments: ${names.join(", ") || "none"}`);
  }
  return ok ? 0 : 1;
}

function headlessResult(result: RunResult, request: Req) {
  return {
    request: request.name,
    file: request.file,
    success: result.success,
    status: result.status,
    durationMs: result.ms,
    headers: result.headers,
    body: result.body,
    asserts: result.asserts,
    captures: result.captured,
    ...(result.error ? { error: result.error } : {}),
  };
}

function printRunReport(request: Req, result: RunResult): void {
  const status = result.status || "error";
  const asserts = `${result.asserts.passed}/${result.asserts.total}`;
  const captures = Object.keys(result.captured);
  console.error(`${result.success ? "ok" : "fail"} ${request.name} ${status} ${result.ms}ms asserts ${asserts}${captures.length ? ` captures ${captures.join(",")}` : ""}`);
  if (result.error) console.error(result.error);
}

async function runCommand(values: string[]): Promise<number> {
  const parsed = parseCliVariables(values);
  if (parsed.error) {
    console.error(`termurl: ${parsed.error}`);
    return 1;
  }
  const environment = optionValue(values, "--env");
  if (environment !== undefined) {
    const index = environments.indexOf(environment);
    if (index < 0) {
      console.error(`termurl: unknown environment "${environment}"`);
      console.error(`available environments: ${environments.join(", ") || "none"}`);
      return 1;
    }
    environmentIdx = index;
  }
  cliVariables = parsed.variables ?? {};
  const inputs = positionalArgs(values);
  if (inputs.length === 0) {
    console.error("termurl: usage: termurl run <request...> [--env name] [--var KEY=value] [--json] [-q]");
    return 1;
  }
  const targets: Req[] = [];
  for (const input of inputs) {
    const request = requestForInput(input);
    if (!request) return unknownRequest(input);
    targets.push(request);
  }

  const results = await runHurl(targets);
  const json = values.includes("--json");
  const quiet = values.includes("-q") || values.includes("--quiet");
  if (!quiet) results.forEach((result, index) => printRunReport(targets[index], result));
  if (json) {
    const output = results.map((result, index) => headlessResult(result, targets[index]));
    console.log(JSON.stringify(output.length === 1 ? output[0] : output, null, 2));
  } else if (results.length === 1) {
    if (results[0].body) process.stdout.write(results[0].body);
  } else {
    results.forEach((result, index) => {
      if (index > 0) process.stdout.write("\n");
      process.stdout.write(`==> ${targets[index].name}\n`);
      if (result.body) process.stdout.write(`${result.body}${result.body.endsWith("\n") ? "" : "\n"}`);
    });
  }
  if (results.some((result) => !result.success && result.status === 0)) return 2;
  return results.some((result) => !result.success) ? 3 : 0;
}

async function runHeadlessCommand(): Promise<number> {
  const command = args[0];
  if (command === "list") return listCommand(args.includes("--json"));
  if (command === "show") return showCommand(positionalArgs(args.slice(1))[0]);
  if (command === "env") {
    const subcommand = args[1];
    const values = args.slice(2);
    if (subcommand === "list") return envListCommand(values.includes("--json"));
    if (subcommand === "show") return envShowCommand(positionalArgs(values)[0], values.includes("--reveal"), values.includes("--json"));
    console.error("termurl: usage: termurl env list [--json] | termurl env show <name> [--reveal] [--json]");
    return 1;
  }
  if (command === "run") return runCommand(args.slice(1));
  return 1;
}

if (isDoctor) process.exit(doctorCommand(args.includes("--json")));
if (HEADLESS_COMMANDS.has(args[0] ?? "")) process.exit(await runHeadlessCommand());
if (!process.stdout.isTTY) {
  console.error("termurl: interactive mode requires a terminal; use `termurl --help` for headless commands");
  process.exit(1);
}

function copyToClipboard(renderer: any, text: string): string {
  let via = "osc52";
  const ok = renderer.copyToClipboardOSC52(text);
  try {
    Bun.spawnSync({ cmd: ["pbcopy"], stdin: new TextEncoder().encode(text) });
    via = "pbcopy";
  } catch {}
  return ok || via === "pbcopy" ? via : "failed";
}

const renderer = await createCliRenderer({ useMouse: true, useAlternateScreen: true } as any);
renderer.setBackgroundColor(C.bg);

const flowQueue = new Map<string, number>();
const lastResult = new Map<string, "ok" | "fail">();
const lastBodies = new Map<string, string>();
type Pane = "list" | "editor" | "response";
let pane: Pane = "list";
let insert = false;
let pending: string | null = null;
let visual = false;
let visualAnchor = 0;
let visualAnchorOffset = 0;
let visualKind: "char" | "line" | null = null;
let visualTarget: TextareaRenderable | null = null;
let register = "";
let statusMsg = "";
let envInsert = false;
type EnvPane = "list" | "editor";
let envPane: EnvPane = "list";
type HistoryPane = "list" | "detail";
let historyPane: HistoryPane = "list";
type AppWindow = "workspace" | "history" | "environments";
let appWindow: AppWindow = "workspace";

type HistoryRecord = {
  ts: string;
  request: string;
  environment?: string;
  profile?: string;
  status: number;
  success?: boolean;
  duration_ms: number;
  flow_id?: string;
  step?: number;
  flow_size?: number;
  captures?: string[];
  request_detail?: string;
  response?: string;
  error?: string;
};

type HistoryGroup = {
  key: string;
  flow: boolean;
  ts: string;
  environment: string;
  steps: HistoryRecord[];
};

let historyGroups: HistoryGroup[] = [];
let selectedHistory = 0;
let selectedEnvironment = 0;
let secretsRevealed = false;

type TreeRow =
  | { type: "folder"; path: string; name: string; depth: number }
  | { type: "request"; req: Req; depth: number };

type TreeNode = {
  folders: Map<string, TreeNode>;
  requests: Req[];
};

const collapsed = new Set<string>();
let treeRows: TreeRow[] = [];
let selectedRow = 0;
let lastRowClick = { index: -1, time: 0 };
let listPending: string | null = null;

function requestLabel(r: Req): string {
  const order = flowQueue.get(r.name);
  const mark = order === undefined ? "[ ]" : `[${order}]`;
  const name = r.name.split("/").pop() ?? r.name;
  return `${mark} ${r.method.padEnd(6)} ${name}`;
}

const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%" });
renderer.root.add(root);

const tabBar = new TextRenderable(renderer, {
  content: "",
  height: 1,
  backgroundColor: "#24283b",
  selectable: false,
} as any);
root.add(tabBar);

const main = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1 });
root.add(main);

const listBox = new BoxRenderable(renderer, {
  width: "33%", flexShrink: 0, border: true, borderStyle: "single", title: " REQUESTS ", flexDirection: "column",
  borderColor: C.dim, backgroundColor: C.bg,
});
main.add(listBox);

const filterInput = new InputRenderable(renderer, { placeholder: "/ filter", backgroundColor: C.bg, textColor: C.fg });
listBox.add(filterInput);

const treeList = new BoxRenderable(renderer, {
  flexGrow: 1,
  flexDirection: "column",
  backgroundColor: C.bg,
});
listBox.add(treeList);

const rightCol = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, flexBasis: 0 });
main.add(rightCol);

const editorBox = new BoxRenderable(renderer, {
  height: "55%", border: true, borderStyle: "single", title: " REQUEST ", borderColor: C.dim, backgroundColor: C.bg,
  padding: 1,
});
rightCol.add(editorBox);

const editor = new TextareaRenderable(renderer, {
  initialValue: requests[0] ? readFileSync(requests[0].file, "utf8") : "",
  backgroundColor: C.bg, textColor: C.fg,
  selectable: true,
});
editorBox.add(editor);

const responseBox = new BoxRenderable(renderer, {
  flexGrow: 1, border: true, borderStyle: "single", title: " RESPONSE ", borderColor: C.dim, backgroundColor: C.bg,
  padding: 1,
});
rightCol.add(responseBox);

const respView = new TextareaRenderable(renderer, {
  backgroundColor: C.bg,
  textColor: C.fg,
  selectable: true,
  flexGrow: 1,
});
respView.setText("run a request with enter");
respView.onKeyDown = (key) => key.preventDefault();
respView.onPaste = (event) => event.preventDefault();
responseBox.add(respView);

const statusBar = new TextRenderable(renderer, { content: "", height: 1, backgroundColor: "#24283b", selectable: false } as any);

const historyWindow = new BoxRenderable(renderer, {
  flexDirection: "row",
  flexGrow: 1,
  backgroundColor: C.bg,
});
root.add(historyWindow);

const historyListBox = new BoxRenderable(renderer, {
  width: 44,
  border: true,
  borderStyle: "single",
  title: " HISTORY ",
  borderColor: C.dim,
  backgroundColor: C.bg,
  flexDirection: "column",
});
historyWindow.add(historyListBox);

const historyList = new BoxRenderable(renderer, {
  flexGrow: 1,
  flexDirection: "column",
  backgroundColor: C.bg,
});
historyListBox.add(historyList);

const historyDetailBox = new BoxRenderable(renderer, {
  flexGrow: 1,
  border: true,
  borderStyle: "single",
  title: " RUN DETAILS ",
  borderColor: C.dim,
  backgroundColor: C.bg,
});
historyWindow.add(historyDetailBox);

const historyDetail = new TextareaRenderable(renderer, {
  backgroundColor: C.bg,
  textColor: C.fg,
  selectable: true,
});
historyDetailBox.add(historyDetail);
historyWindow.visible = false;

const envWindow = new BoxRenderable(renderer, {
  flexDirection: "row",
  flexGrow: 1,
  backgroundColor: C.bg,
});
root.add(envWindow);

const envListBox = new BoxRenderable(renderer, {
  width: 32,
  border: true,
  borderStyle: "single",
  title: " ENVIRONMENTS ",
  borderColor: C.dim,
  backgroundColor: C.bg,
  flexDirection: "column",
});
envWindow.add(envListBox);

const envList = new BoxRenderable(renderer, {
  flexGrow: 1,
  flexDirection: "column",
  backgroundColor: C.bg,
});
envListBox.add(envList);

const envDetailBox = new BoxRenderable(renderer, {
  flexGrow: 1,
  border: true,
  borderStyle: "single",
  title: " ENVIRONMENT ",
  borderColor: C.dim,
  backgroundColor: C.bg,
});
envWindow.add(envDetailBox);

const envDetail = new TextareaRenderable(renderer, {
  backgroundColor: C.bg,
  textColor: C.fg,
  selectable: true,
});
envDetailBox.add(envDetail);
envWindow.visible = false;
root.add(statusBar);

const helpBackdrop = new BoxRenderable(renderer, {
  position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
  backgroundColor: C.bg, zIndex: 99, visible: false,
});
root.add(helpBackdrop);

const helpOverlay = new BoxRenderable(renderer, {
  position: "absolute", top: "20%", left: "10%", width: "80%", height: "45%",
  border: true, borderStyle: "single", title: " SHORTCUTS (press any key to close) ",
  borderColor: C.yellow, backgroundColor: C.bg, zIndex: 100, visible: false,
  padding: 1,
});
root.add(helpOverlay);

const helpText = new TextareaRenderable(renderer, { backgroundColor: C.bg, textColor: C.fg, selectable: false, flexGrow: 1 });
helpText.onKeyDown = (key) => key.preventDefault();
helpText.onPaste = (event) => event.preventDefault();
helpOverlay.add(helpText);

listBox.onMouseDown = () => { if (appWindow === "workspace" && pane !== "list") setPane("list"); };
editorBox.onMouseDown = () => { if (appWindow === "workspace" && pane !== "editor") setPane("editor"); };
responseBox.onMouseDown = () => { if (appWindow === "workspace" && pane !== "response") setPane("response"); };
historyListBox.onMouseDown = () => { if (appWindow === "history" && historyPane !== "list") setHistoryPane("list"); };
historyDetailBox.onMouseDown = () => { if (appWindow === "history" && historyPane !== "detail") setHistoryPane("detail"); };
envListBox.onMouseDown = () => { if (appWindow === "environments" && envPane !== "list") setEnvPane("list"); };
envDetailBox.onMouseDown = () => { if (appWindow === "environments" && envPane !== "editor") setEnvPane("editor"); };

function currentReq(): Req | null {
  const row = treeRows[selectedRow];
  return row?.type === "request" ? row.req : null;
}

type VariableSource = "file" | "secret" | "capture" | "unresolved";

const variableSyntax = SyntaxStyle.fromStyles({
  file: { fg: C.green },
  secret: { fg: C.yellow },
  capture: { fg: C.blue },
  unresolved: { fg: C.red },
});

const responseFailureSyntax = SyntaxStyle.fromStyles({
  failure: { fg: C.red },
});

function applyFailureHighlights(target: TextareaRenderable, text: string, failed: boolean) {
  target.editBuffer.setSyntaxStyle(responseFailureSyntax);
  target.editBuffer.clearAllHighlights();
  if (!failed) return;

  const styleId = responseFailureSyntax.getStyleId("failure") ?? 0;
  const highlightRange = (start: number, end: number) => {
    let lineStart = 0;
    for (const [line, content] of text.split("\n").entries()) {
      const lineEnd = lineStart + content.length;
      const rangeStart = Math.max(start, lineStart);
      const rangeEnd = Math.min(end, lineEnd);
      if (rangeStart < rangeEnd) {
        target.editBuffer.addHighlight(line, {
          start: rangeStart - lineStart,
          end: rangeEnd - lineStart,
          styleId,
        });
      }
      lineStart = lineEnd + 1;
    }
  };

  let searchFrom = 0;
  let highlighted = false;
  while (true) {
    const start = text.indexOf("reason:\n", searchFrom);
    if (start < 0) break;
    const blankLine = text.indexOf("\n\n", start);
    const end = blankLine < 0 ? text.length : blankLine;
    highlightRange(start, end);
    highlighted = true;
    searchFrom = end + 2;
  }
  if (!highlighted) highlightRange(0, text.length);
}

function renderResponse(text: string, failed: boolean) {
  respView.setText(text);
  applyFailureHighlights(respView, text, failed);
}

function captureNames(req: Req): string[] {
  return section(readFileSync(req.file, "utf8"), "Captures")
    .map((line) => line.match(/^([a-zA-Z_][\w-]*)\s*:/)?.[1])
    .filter((name): name is string => name !== undefined);
}

function availableCaptures(req: Req | null): Set<string> {
  const available = new Set<string>();
  if (!req) return available;
  const currentOrder = flowQueue.get(req.name);
  if (currentOrder === undefined) return available;
  for (const [name, order] of flowQueue) {
    if (order >= currentOrder) continue;
    const previous = requests.find((candidate) => candidate.name === name);
    if (previous) captureNames(previous).forEach((capture) => available.add(capture));
  }
  return available;
}

function variableSource(name: string, req: Req | null = currentReq(), environment = environments[environmentIdx]): VariableSource {
  if (availableCaptures(req).has(name)) return "capture";
  if (environmentVariables(environment)[name] !== undefined) return /^secret_/i.test(name) ? "secret" : "file";
  return "unresolved";
}

function renderTabs() {
  const tab = (key: string, label: string, active: boolean) => active ? `[${key} ${label}]` : ` ${key} ${label} `;
  tabBar.content = ` ${tab("1", "Workspace", appWindow === "workspace")} ${tab("2", "History", appWindow === "history")} ${tab("3", "Environments", appWindow === "environments")}    env: ${environments[environmentIdx]}`;
}

function envTitle(state: "list" | "editor" | "insert"): string {
  const base = `ENVIRONMENT (.env.${environments[selectedEnvironment]})`;
  if (state === "insert") return ` ${base} · INSERT `;
  if (state === "editor") return ` ${base} `;
  const text = environmentVariables(environments[selectedEnvironment]);
  const hasSecrets = Object.keys(text).some((key) => /^secret_/i.test(key));
  if (hasSecrets) return ` ${base} ${secretsRevealed ? "[revealed]" : "[masked]"} `;
  return ` ${base} `;
}

function maskSecretsText(text: string): string {
  return text.split("\n").map((line) => {
    const match = line.match(/^(\s*(secret_\w*)\s*=\s*)(.*)$/i);
    return match && match[3].trim() ? `${match[1]}***` : line;
  }).join("\n");
}

function renderEnvironments() {
  for (const child of envList.getChildren()) {
    envList.remove(child);
    child.destroy();
  }
  environments.forEach((environment, index) => {
    const active = index === environmentIdx;
    const selected = index === selectedEnvironment;
    const rowRenderable = new TextRenderable(renderer, {
      content: `${selected ? ">" : " "} ${environment}${active ? "  (active)" : ""}`,
      width: "100%",
      height: 1,
      fg: active ? C.green : C.fg,
      bg: selected ? "#292e42" : C.bg,
      truncate: true,
      selectable: false,
    });
    rowRenderable.onMouseDown = () => {
      if (appWindow === "environments" && envPane !== "list") setEnvPane("list");
      selectedEnvironment = index;
      renderEnvironments();
      loadEnvironmentFile();
    };
    envList.add(rowRenderable);
  });
}

function loadEnvironmentFile() {
  let text = "";
  try { text = readFileSync(environmentFile(environments[selectedEnvironment]), "utf8"); } catch {}
  envDetail.setText(envPane === "list" && !secretsRevealed ? maskSecretsText(text) : text);
  if (envPane === "list" && !envInsert) envDetailBox.title = envTitle("list");
}

function saveEnvironmentFile() {
  const name = environments[selectedEnvironment];
  writeFileSync(environmentFile(name), envDetail.plainText);
  statusMsg = `saved .env.${name}`;
  refreshEditorHighlights();
  setStatus();
  setTimeout(() => { statusMsg = ""; setStatus(); }, 2000);
}

function enterEnvInsert() {
  envInsert = true;
  envDetailBox.title = envTitle("insert");
  envDetail.focus();
  setStatus();
}

function leaveEnvInsert() {
  envInsert = false;
  envPane = "editor";
  envDetailBox.title = envTitle("editor");
  envDetail.focus();
  setStatus();
}

function setEnvPane(next: EnvPane) {
  clearVisual();
  pending = null;
  envInsert = false;
  envPane = next;
  envListBox.borderColor = next === "list" ? C.yellow : C.dim;
  envDetailBox.borderColor = next === "editor" ? C.yellow : C.dim;
  loadEnvironmentFile();
  envDetailBox.title = envTitle(next);
  if (next === "editor") envDetail.focus();
  else envDetail.blur();
  setStatus();
}

function refreshEditorHighlights() {
  editor.editBuffer.setSyntaxStyle(variableSyntax);
  editor.editBuffer.clearAllHighlights();
  const req = currentReq();
  for (const match of editor.plainText.matchAll(/\{\{([a-z_][a-z0-9_]*)\}\}/g)) {
    const start = match.index ?? 0;
    const lineStart = editor.plainText.lastIndexOf("\n", start - 1) + 1;
    const line = editor.plainText.slice(0, start).split("\n").length - 1;
    const source = variableSource(match[1], req);
    const styleId = variableSyntax.getStyleId(source) ?? 0;
    editor.editBuffer.addHighlight(line, {
      start: start - lineStart,
      end: start - lineStart + match[0].length,
      styleId,
    });
  }
}

function redactResponse(response: string): string {
  return response
    .replace(/("token"\s*:\s*)"[^"]*"/g, '$1"<redacted>"')
    .replace(/(Bearer\s+)\S+/g, "$1<redacted>");
}

function historyStatus(group: HistoryGroup): string {
  const failed = group.steps.find((step) => step.success === false || step.status >= 400);
  return failed ? `${failed.status} FAIL` : "OK";
}

function historyTime(ts: string): string {
  return ts.includes("T") ? ts.slice(11, 16) : ts;
}

function historyTitle(group: HistoryGroup): string {
  if (group.flow) return `${historyTime(group.ts)}  FLOW  ${group.steps.length} steps  ${historyStatus(group)}`;
  const request = group.steps[0]?.request ?? "unknown";
  return `${historyTime(group.ts)}  ${request}  ${historyStatus(group)}`;
}

function historyDetailText(group: HistoryGroup | undefined): string {
  if (!group) return "No runs recorded yet.";
  const duration = group.steps.reduce((sum, step) => sum + step.duration_ms, 0);
  const lines = [
    `${group.flow ? "FLOW" : "REQUEST"} · ${group.environment}`,
    `started: ${group.ts}`,
    `duration: ${duration}ms · status: ${historyStatus(group)}`,
    "",
  ];
  for (const [index, step] of group.steps.entries()) {
    lines.push(`${index + 1}. ${step.request} · ${step.status} · ${step.duration_ms}ms`);
    if (step.error && !step.response?.includes("reason:")) lines.push("reason:", step.error);
    if (step.captures?.length) lines.push(`   captures: ${step.captures.join(", ")}`);
    if (step.request_detail) lines.push("", "request:", step.request_detail);
    if (step.response) lines.push("", step.response);
    lines.push("");
  }
  return lines.join("\n");
}

function renderHistory() {
  for (const child of historyList.getChildren()) {
    historyList.remove(child);
    child.destroy();
  }
  historyGroups.forEach((group, index) => {
    const rowRenderable = new TextRenderable(renderer, {
      content: historyTitle(group),
      width: "100%",
      height: 1,
      fg: index === selectedHistory ? C.fg : C.dim,
      bg: index === selectedHistory ? "#292e42" : C.bg,
      truncate: true,
      selectable: false,
    });
    rowRenderable.onMouseDown = () => {
      if (appWindow === "history" && historyPane !== "list") setHistoryPane("list");
      selectedHistory = index;
      renderHistory();
    };
    historyList.add(rowRenderable);
  });
  const group = historyGroups[selectedHistory];
  const text = historyDetailText(group);
  historyDetail.setText(text);
  applyFailureHighlights(historyDetail, text, Boolean(group?.steps.some((step) => step.error || step.status >= 400)));
}

function loadHistory() {
  let records: HistoryRecord[] = [];
  try {
    records = readFileSync(HISTORY_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HistoryRecord);
  } catch {}

  const groups = new Map<string, HistoryGroup>();
  records.forEach((record, index) => {
    const key = record.flow_id ?? `request-${index}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        flow: Boolean(record.flow_id || record.flow_size && record.flow_size > 1),
        ts: record.ts,
        environment: record.environment ?? record.profile ?? "-",
        steps: [],
      };
      groups.set(key, group);
    }
    group.steps.push(record);
    if (record.ts > group.ts) group.ts = record.ts;
  });

  historyGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      steps: [...group.steps].sort((a, b) => (a.step ?? 1) - (b.step ?? 1)),
    }))
    .sort((a, b) => b.ts.localeCompare(a.ts));
  selectedHistory = Math.max(0, Math.min(selectedHistory, Math.max(0, historyGroups.length - 1)));
  if (appWindow === "history") renderHistory();
}

function recordHistory(req: Req, result: RunResult, flowId?: string, step?: number, flowSize?: number) {
  mkdirSync(join(COLLECTION, ".termurl"), { recursive: true });
  const record: HistoryRecord = {
    ts: new Date().toISOString(),
    request: req.name,
    environment: environments[environmentIdx],
    status: result.status,
    success: result.success,
    duration_ms: result.ms,
    captures: result.captures,
    ...(formatRequest(result) ? { request_detail: redactResponse(formatRequest(result)!) } : {}),
    response: redactResponse(formatRun(req, result)),
    ...(result.error ? { error: result.error } : {}),
    ...(flowId ? { flow_id: flowId, step, flow_size: flowSize } : {}),
  };
  appendFileSync(HISTORY_FILE, `${JSON.stringify(record)}\n`);
  loadHistory();
}

function normalizeFlowQueue() {
  const names = [...flowQueue.keys()].filter((name) => requests.some((r) => r.name === name));
  flowQueue.clear();
  names.forEach((name, index) => flowQueue.set(name, index + 1));
}

function toggleFlowRequest(req: Req) {
  if (flowQueue.has(req.name)) flowQueue.delete(req.name);
  else flowQueue.set(req.name, flowQueue.size + 1);
  normalizeFlowQueue();
}

function buildTree(list: Req[]): TreeNode {
  const root: TreeNode = { folders: new Map(), requests: [] };
  for (const req of list) {
    const parts = req.name.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.folders.get(part);
      if (!child) {
        child = { folders: new Map(), requests: [] };
        node.folders.set(part, child);
      }
      node = child;
    }
    node.requests.push(req);
  }
  return root;
}

function flattenTree(node: TreeNode, parentPath = "", depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const [name, child] of [...node.folders.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const path = parentPath ? `${parentPath}/${name}` : name;
    rows.push({ type: "folder", path, name, depth });
    if (!collapsed.has(path)) rows.push(...flattenTree(child, path, depth + 1));
  }
  for (const req of [...node.requests].sort((a, b) => a.name.localeCompare(b.name))) {
    rows.push({ type: "request", req, depth });
  }
  return rows;
}

function renderTree() {
  for (const child of treeList.getChildren()) {
    treeList.remove(child);
    child.destroy();
  }

  treeRows.forEach((row, index) => {
    const selected = index === selectedRow;
    const content = row.type === "folder"
      ? `${"  ".repeat(row.depth)}${collapsed.has(row.path) ? "▸" : "▾"} ${row.name}/`
      : `${"  ".repeat(row.depth + 1)}${requestLabel(row.req)}`;
    const rowRenderable = new TextRenderable(renderer, {
      content,
      width: "100%",
      height: 1,
      fg: row.type === "folder" ? C.cyan : C.fg,
      bg: selected ? "#292e42" : C.bg,
      truncate: true,
      selectable: false,
    });
    rowRenderable.onMouseDown = () => {
      if (appWindow === "workspace" && pane !== "list") setPane("list");
      const now = Date.now();
      const doubleClick = lastRowClick.index === index && now - lastRowClick.time < 400;
      lastRowClick = { index, time: now };
      selectedRow = index;
      if (row.type === "folder") {
        collapsed.has(row.path) ? collapsed.delete(row.path) : collapsed.add(row.path);
        refreshList();
        return;
      }
      if (doubleClick) {
        toggleFlowRequest(row.req);
        refreshList(row.req.name);
        setStatus();
        return;
      }
      moveSelection(0);
    };
    treeList.add(rowRenderable);
  });
}

function refreshList(keepName?: string, touchEditor = true) {
  const previous = currentReq()?.name;
  const q = filterInput.value.toLowerCase();
  const filtered = requests.filter((r) => r.name.toLowerCase().includes(q));
  treeRows = flattenTree(buildTree(filtered));
  const targetName = keepName ?? previous;
  if (targetName) {
    const idx = treeRows.findIndex((row) => row.type === "request" && row.req.name === targetName);
    if (idx >= 0) selectedRow = idx;
  }
  selectedRow = Math.max(0, Math.min(selectedRow, Math.max(0, treeRows.length - 1)));
  const req = currentReq();
  if (req && touchEditor) {
    editor.setText(readFileSync(req.file, "utf8"));
    refreshEditorHighlights();
  }
  renderTree();
}

function watchCollection() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    watch(COLLECTION, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        requests.splice(0, requests.length, ...loadRequests());
        refreshList(undefined, appWindow === "workspace" && !insert);
      }, 150);
    });
  } catch {}
}

function moveSelection(delta: number) {
  if (treeRows.length === 0) return;
  selectedRow = Math.max(0, Math.min(treeRows.length - 1, selectedRow + delta));
  const req = currentReq();
  if (req) {
    editor.setText(readFileSync(req.file, "utf8"));
    refreshEditorHighlights();
  }
  renderTree();
}

function activateSelection() {
  const row = treeRows[selectedRow];
  if (!row) return;
  if (row.type === "folder") {
    collapsed.has(row.path) ? collapsed.delete(row.path) : collapsed.add(row.path);
    refreshList();
    return;
  }
  void runRequest(row.req);
}

function clearVisual() {
  if (visualTarget) visualTarget.clearSelection();
  visual = false;
  visualKind = null;
  visualTarget = null;
}

function scrollText(target: TextareaRenderable, delta: number) {
  const viewport = target.editorView.getViewport();
  target.editorView.setViewport(
    viewport.offsetX,
    Math.max(0, viewport.offsetY + delta),
    viewport.width,
    viewport.height,
    false,
  );
}

function ensureCursorVisible(target: TextareaRenderable) {
  const view = target.editorView;
  const viewport = view.getViewport();
  const logicalRow = target.editBuffer.getCursorPosition().row;
  const sources = view.getLogicalLineInfo().lineSources;
  const visualIndex = sources.indexOf(logicalRow);
  const visualRow = visualIndex < 0 ? logicalRow : visualIndex;
  let offsetY = viewport.offsetY;
  if (visualRow < offsetY) offsetY = visualRow;
  else if (visualRow >= offsetY + viewport.height) offsetY = visualRow - viewport.height + 1;
  if (offsetY !== viewport.offsetY) view.setViewport(viewport.offsetX, offsetY, viewport.width, viewport.height, false);
}

function setStatus() {
  const mode = appWindow === "history" ? (historyPane === "detail" ? (visual ? "VISUAL" : "RUN-DETAILS") : "HISTORY") : appWindow === "environments" ? (envInsert ? "ENV-INSERT" : envPane === "editor" ? "ENV-NORMAL" : "ENVIRONMENTS") : pane === "editor"
    ? (insert ? "INSERT" : visual ? "REQ-VISUAL" : "REQ-NORMAL")
    : pane === "response" && visual ? "VISUAL" : pane.toUpperCase();
  const last = [...lastResult.entries()].slice(-1)[0];
  renderTabs();
  statusBar.content =
    ` ${appWindow === "workspace" ? "1 WORKSPACE" : appWindow === "history" ? "2 HISTORY" : "3 ENVIRONMENTS"} · ${mode} · env: ${environments[environmentIdx]} · queued: ${flowQueue.size}` +
    (last ? ` · last: ${last[0]} ${last[1] === "ok" ? "✓" : "✗"}` : "") +
    (statusMsg ? ` · ${statusMsg}` : "") +
    (pending ? ` · ${pending}` : "") +
    "   [?] help";
}

function setPane(p: Pane) {
  clearVisual();
  filterInput.blur();
  pane = p;
  insert = false;
  listBox.borderColor = p === "list" ? C.yellow : C.dim;
  editorBox.borderColor = p === "editor" ? C.yellow : C.dim;
  responseBox.borderColor = p === "response" ? C.yellow : C.dim;
  listBox.title = " REQUESTS ";
  editorBox.title = " REQUEST ";
  responseBox.title = " RESPONSE ";
  if (p === "editor") editor.focus();
  else editor.blur();
  if (p === "response") respView.focus();
  else respView.blur();
  setStatus();
}

function setHistoryPane(next: HistoryPane) {
  clearVisual();
  pending = null;
  historyPane = next;
  historyListBox.borderColor = next === "list" ? C.yellow : C.dim;
  historyDetailBox.borderColor = next === "detail" ? C.yellow : C.dim;
  historyDetailBox.title = " RUN DETAILS ";
  if (next === "detail") historyDetail.focus();
  else historyDetail.blur();
  setStatus();
}

function setWindow(next: AppWindow) {
  clearVisual();
  filterInput.blur();
  editor.blur();
  respView.blur();
  historyDetail.blur();
  envInsert = false;
  envDetail.blur();
  appWindow = next;
  main.visible = next === "workspace";
  historyWindow.visible = next === "history";
  envWindow.visible = next === "environments";
  if (next === "history") {
    loadHistory();
    historyPane = "list";
    historyListBox.borderColor = C.yellow;
    historyDetailBox.borderColor = C.dim;
    historyDetailBox.title = " RUN DETAILS ";
    envListBox.borderColor = C.dim;
    envDetailBox.borderColor = C.dim;
  } else if (next === "environments") {
    selectedEnvironment = environmentIdx;
    envPane = "list";
    renderEnvironments();
    loadEnvironmentFile();
    historyListBox.borderColor = C.dim;
    historyDetailBox.borderColor = C.dim;
    envListBox.borderColor = C.yellow;
    envDetailBox.borderColor = C.dim;
  } else {
    historyListBox.borderColor = C.dim;
    historyDetailBox.borderColor = C.dim;
    envListBox.borderColor = C.dim;
    envDetailBox.borderColor = C.dim;
    setPane(pane);
  }
  setStatus();
}

function moveHistory(delta: number) {
  if (historyGroups.length === 0) return;
  selectedHistory = Math.max(0, Math.min(historyGroups.length - 1, selectedHistory + delta));
  renderHistory();
}

function formatRequest(r: RunResult): string | undefined {
  if (!r.request) return undefined;
  return `${r.request.method} ${r.request.url}` + (r.request.headers.length ? `\n${r.request.headers.join("\n")}` : "");
}

function formatRun(req: Req, r: RunResult): string {
  const ok = r.success;
  const request = formatRequest(r);
  return `${ok ? "✓" : "✗"} ${r.status} ${ok ? "OK" : "FAILED"} · ${r.ms}ms · env: ${environments[environmentIdx]}\n` +
    (request ? `${request}\n\n` : "") +
    `asserts: ${r.asserts.passed}/${r.asserts.total} passed · captures: ${r.captures.join(", ") || "-"}\n\n` +
    (r.headers.length ? `headers:\n${r.headers.join("\n")}\n\n` : "") +
    (r.error ? `reason:\n${r.error}\n\n` : "") +
    (r.body ? formatBody(r.body) : "(empty response body)");
}

async function runRequest(req: Req) {
  statusMsg = `running ${req.name}`;
  setStatus();
  const [r] = await runHurl([req]);
  lastResult.set(req.name, r.success ? "ok" : "fail");
  lastBodies.clear();
  if (r.body) lastBodies.set(req.name, r.body);
  renderResponse(formatRun(req, r), !r.success);
  refreshEditorHighlights();
  recordHistory(req, r);
  refreshList(req.name);
  statusMsg = "";
  setStatus();
}

async function runFlow() {
  const targets = [...flowQueue.entries()]
    .sort(([, a], [, b]) => a - b)
    .map(([name]) => requests.find((r) => r.name === name))
    .filter((r): r is Req => r !== undefined);
  if (targets.length === 0) {
    statusMsg = "mark requests first";
    setStatus();
    return;
  }
  statusMsg = `running flow (${targets.length} requests)`;
  setStatus();
  const results = await runHurl(targets);
  lastBodies.clear();
  const flowId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const parts = targets.map((req, index) => {
    const r = results[index] ?? emptyRunResult("Hurl did not return a result for this step");
    lastResult.set(req.name, r.success ? "ok" : "fail");
    if (r.body) lastBodies.set(req.name, r.body);
    const response = formatRun(req, r);
    recordHistory(req, r, flowId, index + 1, targets.length);
    return `▸ ${index + 1}. ${req.name}\n${response}`;
  });
  renderResponse(`flow (env: ${environments[environmentIdx]}), ${targets.length} requests\n\n` + parts.join("\n\n"), results.some((result) => !result.success));
  refreshEditorHighlights();
  refreshList(currentReq()?.name);
  statusMsg = "";
  setStatus();
}

function enterInsert(title = " REQUEST (INSERT) ") {
  insert = true;
  pending = null;
  editorBox.title = title;
  setStatus();
}

function leaveInsert() {
  insert = false;
  pending = null;
  editorBox.title = " REQUEST ";
  setStatus();
}

function updateVisualSelection(target: TextareaRenderable) {
  const eb = target.editBuffer;
  target.selectionBg = RGBA.fromHex("#3b4261");
  target.selectionFg = RGBA.fromHex(C.fg);
  if (visualKind === "char") {
    const { row, col } = eb.getCursorPosition();
    const cursorOffset = eb.positionToOffset(row, col);
    const start = Math.min(visualAnchorOffset, cursorOffset);
    const end = Math.min(target.plainText.length, Math.max(visualAnchorOffset, cursorOffset) + 1);
    target.setSelection(start, end);
    return;
  }
  const row = eb.getCursorPosition().row;
  const startRow = Math.min(visualAnchor, row);
  const endRow = Math.max(visualAnchor, row);
  const start = eb.getLineStartOffset(startRow);
  const end = endRow + 1 < eb.getLineCount() ? eb.getLineStartOffset(endRow + 1) : target.plainText.length;
  target.setSelection(start, end);
}

function enterVisual(target: TextareaRenderable, kind: "char" | "line") {
  pending = null;
  visual = true;
  visualKind = kind;
  visualTarget = target;
  const cursor = target.editBuffer.getCursorPosition();
  visualAnchor = cursor.row;
  visualAnchorOffset = target.editBuffer.positionToOffset(cursor.row, cursor.col);
  updateVisualSelection(target);
  setStatus();
}

function moveVisual(target: TextareaRenderable, k: string, key: KeyEvent): boolean {
  const eb = target.editBuffer;
  if (k === "escape") {
    clearVisual();
    setStatus();
    return true;
  }
  if (pending) {
    const p = pending;
    pending = null;
    if (p === "g" && k === "g") {
      eb.setCursor(0, 0);
      ensureCursorVisible(target);
      updateVisualSelection(target);
    }
    setStatus();
    return true;
  }
  if (key.ctrl && (k === "d" || k === "u")) {
    scrollText(target, k === "d" ? 5 : -5);
    setStatus();
    return true;
  }
  if (k === "j") eb.moveCursorDown();
  else if (k === "k") eb.moveCursorUp();
  else if (k === "h") eb.moveCursorLeft();
  else if (k === "l") eb.moveCursorRight();
  else if (k === "w") { const c = eb.getNextWordBoundary(); eb.setCursor(c.row, c.col); }
  else if (k === "b") { const c = eb.getPrevWordBoundary(); eb.setCursor(c.row, c.col); }
  else if (k === "0") eb.setCursor(eb.getCursorPosition().row, 0);
  else if (k === "$" || (k === "4" && key.shift)) { const e = eb.getEOL(); eb.setCursor(e.row, e.col); }
  else if (k === "G" || (k === "g" && key.shift)) eb.gotoLine(eb.getLineCount() - 1);
  else if (k === "g") {
    pending = "g";
    setStatus();
    return true;
  } else if (k === "y") {
    register = target.getSelectedText();
    statusMsg = `yanked selection (${copyToClipboard(renderer, register)})`;
    clearVisual();
    setStatus();
    return true;
  } else {
    return false;
  }
  ensureCursorVisible(target);
  updateVisualSelection(target);
  setStatus();
  return true;
}

function vimNormal(k: string, key: KeyEvent, target: TextareaRenderable = editor, readOnly = false, editKind: "request" | "environment" = "request") {
  const eb = target.editBuffer;
  const shift = key.shift;
  const startInsert = () => editKind === "environment" ? enterEnvInsert() : enterInsert();
  const yankLine = () => {
    const { row } = eb.getCursorPosition();
    const start = eb.getLineStartOffset(row);
    const nextLineStart = row + 1 < eb.getLineCount() ? eb.getLineStartOffset(row + 1) : target.plainText.length;
    const line = target.plainText.slice(start, nextLineStart).replace(/\n$/, "");
    register = line;
    statusMsg = `yanked line (${copyToClipboard(renderer, line)})`;
  };

  if (visual && visualTarget === target) {
    moveVisual(target, k, key);
    return;
  }

  if (pending) {
    const p = pending;
    pending = null;
    if (p === "g" && k === "g") { eb.setCursor(0, 0); ensureCursorVisible(target); }
    else if (p === "y" && k === "y") yankLine();
    else if (!readOnly && p === "d" && k === "d") {
      const { row } = eb.getCursorPosition();
      register = eb.getTextRange(eb.getLineStartOffset(row), eb.getLineStartOffset(row + 1));
      eb.deleteLine();
    } else if (!readOnly && p === "c" && k === "c") {
      const { row } = eb.getCursorPosition();
      register = eb.getTextRange(eb.getLineStartOffset(row), eb.getLineStartOffset(row + 1));
      eb.deleteLine();
      startInsert();
    }
    setStatus();
    return;
  }

  if (k === "V" || (k === "v" && shift)) enterVisual(target, "line");
  else if (k === "v" && !shift) enterVisual(target, "char");
  else if (!readOnly && k === "i" && !shift) startInsert();
  else if (!readOnly && k === "a" && !shift) { eb.moveCursorRight(); startInsert(); }
  else if (!readOnly && (k === "A" || (k === "a" && shift))) { const e = eb.getEOL(); eb.setCursor(e.row, e.col); startInsert(); }
  else if (!readOnly && (k === "I" || (k === "i" && shift))) { eb.setCursor(eb.getCursorPosition().row, 0); startInsert(); }
  else if (!readOnly && k === "o" && !shift) { const e = eb.getEOL(); eb.setCursor(e.row, e.col); startInsert(); eb.newLine(); }
  else if (!readOnly && (k === "O" || (k === "o" && shift))) { eb.setCursor(eb.getCursorPosition().row, 0); startInsert(); eb.newLine(); eb.moveCursorUp(); }
  else if (key.ctrl && (k === "d" || k === "u")) scrollText(target, k === "d" ? 5 : -5);
  else if (k === "h") eb.moveCursorLeft();
  else if (k === "l") eb.moveCursorRight();
  else if (k === "j") eb.moveCursorDown();
  else if (k === "k") eb.moveCursorUp();
  else if (k === "w") { const c = eb.getNextWordBoundary(); eb.setCursor(c.row, c.col); }
  else if (k === "b") { const c = eb.getPrevWordBoundary(); eb.setCursor(c.row, c.col); }
  else if (k === "0") eb.setCursor(eb.getCursorPosition().row, 0);
  else if (k === "$" || (k === "4" && shift)) { const e = eb.getEOL(); eb.setCursor(e.row, e.col); }
  else if (k === "G" || (k === "g" && shift)) eb.gotoLine(eb.getLineCount() - 1);
  else if (k === "g" || k === "y" || (!readOnly && (k === "d" || k === "c"))) pending = k;
  else if (k === "Y" || (k === "y" && shift)) {
    register = target.plainText;
    statusMsg = `yanked whole buffer (${copyToClipboard(renderer, register)})`;
  }
  else if (!readOnly && k === "x") eb.deleteChar();
  else if (!readOnly && (k === "D" || (k === "d" && shift))) { const c = eb.getCursorPosition(); const e = eb.getEOL(); eb.deleteRange(c.row, c.col, e.row, e.col); }
  else if (!readOnly && (k === "C" || (k === "c" && shift))) { const c = eb.getCursorPosition(); const e = eb.getEOL(); eb.deleteRange(c.row, c.col, e.row, e.col); startInsert(); }
  else if (!readOnly && k === "p") {
    if (register) { const e = eb.getEOL(); eb.setCursor(e.row, e.col); eb.newLine(); eb.insertText(register.replace(/\n$/, "")); }
  }
  else if (!readOnly && k === "u") eb.undo();
  else if (k === "r" && key.ctrl) eb.redo();
  ensureCursorVisible(target);
  setStatus();
}

function saveEditor() {
  const req = currentReq();
  if (!req) return;
  writeFileSync(req.file, editor.plainText);
  statusMsg = `saved ${req.name}`;
  setStatus();
  setTimeout(() => { statusMsg = ""; setStatus(); }, 2000);
}

const VIM_MOVE: [string, string][] = [
  ["hjkl / w / b", "move / word forward / back"],
  ["0 / $", "start / end of line"],
  ["gg / G", "top / bottom"],
  ["ctrl-d / ctrl-u", "page down / up"],
];

const VIM_EDIT: [string, string][] = [
  ["v / V", "visual char / line"],
  ["i / a", "insert before / after cursor"],
  ["I / A", "insert at line start / end"],
  ["o / O", "new line below / above"],
  ["x", "delete char"],
  ["dd / D", "delete line / to end of line"],
  ["cc / C", "change line / to end of line"],
  ["yy / Y", "yank line / yank whole buffer"],
  ["p", "paste"],
  ["u / ctrl-r", "undo / redo"],
];

const PANE_HELP: Record<string, [string, string][]> = {
  list: [
    ["j / k", "move down / up"],
    ["gg / G", "jump to top / bottom"],
    ["ctrl-d / ctrl-u", "page down / up"],
    ["/", "filter"],
    ["enter", "run request / toggle folder"],
    ["ctrl-enter / ctrl-f", "run flow"],
    ["tab", "queue/unqueue for flow"],
    ["e / i / ctrl-l", "open request pane"],
    ["y", "copy as hurl"],
    ["Y", "copy as curl"],
    ["ctrl-n", "new request"],
    ["ctrl-x", "delete request"],
    ["ctrl-p", "cycle environment"],
    ["q", "quit"],
  ],
  editor: [
    ...VIM_MOVE,
    ...VIM_EDIT,
    ["ctrl-s", "save"],
    ["ctrl-l / ctrl-h", "next pane (response) / prev pane (list)"],
    ["esc", "leave insert / cancel visual / back to list"],
  ],
  response: [
    ...VIM_MOVE,
    ["v / V", "visual char / line"],
    ["yy / Y", "yank line / yank all"],
    ["c", "copy mouse selection"],
    ["s", "save body to file"],
    ["ctrl-p", "cycle environment"],
    ["ctrl-h", "back to request pane"],
    ["esc", "cancel visual"],
  ],
  "history-list": [
    ["j / k", "move"],
    ["g / G", "jump to top / bottom"],
    ["ctrl-d / ctrl-u", "jump 5 up / down"],
    ["enter / ctrl-l", "open details"],
    ["y", "copy all"],
    ["esc", "back to workspace"],
    ["q", "quit"],
  ],
  "history-detail": [
    ...VIM_MOVE,
    ["v / V", "visual char / line"],
    ["y", "yank selection"],
    ["yy / Y", "yank line / yank all"],
    ["ctrl-h / esc", "back to list"],
  ],
  "env-list": [
    ["j / k", "move"],
    ["enter", "activate environment"],
    ["e / i / ctrl-l", "open file for editing"],
    ["ctrl-r", "reveal/mask secrets"],
    ["esc / 1", "back to workspace"],
    ["q", "quit"],
  ],
  "env-editor": [
    ...VIM_MOVE,
    ...VIM_EDIT,
    ["ctrl-s", "save"],
    ["ctrl-h", "back to list"],
    ["esc", "leave insert / cancel visual / back to list"],
  ],
};

function formatHelp(context: string): string {
  const rows = PANE_HELP[context];
  const width = Math.max(...rows.map(([key]) => key.length));
  return rows.map(([key, desc]) => `${key.padEnd(width)} : ${desc}`).join("\n");
}

function helpContext(): keyof typeof PANE_HELP {
  if (appWindow === "history") return historyPane === "detail" ? "history-detail" : "history-list";
  if (appWindow === "environments") return envPane === "editor" ? "env-editor" : "env-list";
  if (pane === "editor") return "editor";
  if (pane === "response") return "response";
  return "list";
}

let helpVisible = false;
function hideHelp() { helpVisible = false; helpBackdrop.visible = false; helpOverlay.visible = false; }
function showHelp() {
  helpVisible = true;
  helpText.setText(formatHelp(helpContext()));
  helpBackdrop.visible = true;
  helpOverlay.visible = true;
}

renderer.keyInput.on("keypress", (key: KeyEvent) => {
  const k = key.name;
  if (helpVisible) { hideHelp(); setStatus(); key.preventDefault(); return; }
  if (k === "?" && !insert && !envInsert && !filterInputFocused()) { showHelp(); key.preventDefault(); return; }

  if (!insert && !envInsert && !visual && !pending && !listPending && !filterInputFocused()) {
    if (k === "1") { setWindow("workspace"); key.preventDefault(); return; }
    if (k === "2") { setWindow("history"); key.preventDefault(); return; }
    if (k === "3") { setWindow("environments"); key.preventDefault(); return; }
  }

  if (appWindow === "environments") {
    if (envInsert) {
      if (k === "s" && key.ctrl) { saveEnvironmentFile(); key.preventDefault(); return; }
      if (k === "h" && key.ctrl) { leaveEnvInsert(); setEnvPane("list"); key.preventDefault(); return; }
      if (k === "escape") {
        leaveEnvInsert();
        key.preventDefault(); return;
      }
      return;
    }
    if (k === "q") { renderer.destroy(); process.exit(0); }
    if (envPane === "editor") {
      if (key.ctrl && k === "s") { saveEnvironmentFile(); key.preventDefault(); return; }
      if (key.ctrl && k === "h") { setEnvPane("list"); key.preventDefault(); return; }
      if (k === "escape") { setEnvPane("list"); key.preventDefault(); return; }
      vimNormal(k, key, envDetail, false, "environment");
      key.preventDefault(); return;
    }
    if (key.ctrl && k === "l") { setEnvPane("editor"); key.preventDefault(); return; }
    if (k === "escape" || k === "1") { setWindow("workspace"); key.preventDefault(); return; }
    if (k === "j") { selectedEnvironment = Math.min(environments.length - 1, selectedEnvironment + 1); renderEnvironments(); loadEnvironmentFile(); key.preventDefault(); return; }
    if (k === "k") { selectedEnvironment = Math.max(0, selectedEnvironment - 1); renderEnvironments(); loadEnvironmentFile(); key.preventDefault(); return; }
    if (k === "enter" || k === "return") {
      environmentIdx = selectedEnvironment;
      refreshEditorHighlights();
      renderEnvironments();
      statusMsg = `active environment: ${environments[environmentIdx]}`;
      setStatus();
      key.preventDefault(); return;
    }
    if (k === "e") {
      setEnvPane("editor");
      key.preventDefault(); return;
    }
    if (k === "i") {
      setEnvPane("editor");
      key.preventDefault(); return;
    }
    if (k === "r" && key.ctrl) { secretsRevealed = !secretsRevealed; renderEnvironments(); loadEnvironmentFile(); key.preventDefault(); return; }
    key.preventDefault();
    return;
  }

  if (appWindow === "history") {
    if (historyPane === "detail") {
      if (key.ctrl && k === "h") { setHistoryPane("list"); key.preventDefault(); return; }
      if (k === "escape") { setHistoryPane("list"); key.preventDefault(); return; }
      vimNormal(k, key, historyDetail, true);
      key.preventDefault(); return;
    }
    if (k === "q") { renderer.destroy(); process.exit(0); }
    if (k === "escape") { setWindow("workspace"); key.preventDefault(); return; }
    if (k === "j") { moveHistory(1); key.preventDefault(); return; }
    if (k === "k") { moveHistory(-1); key.preventDefault(); return; }
    if (key.ctrl && k === "d") { moveHistory(5); key.preventDefault(); return; }
    if (key.ctrl && k === "u") { moveHistory(-5); key.preventDefault(); return; }
    if (key.ctrl && k === "l") { setHistoryPane("detail"); key.preventDefault(); return; }
    if (k === "g") { selectedHistory = 0; renderHistory(); key.preventDefault(); return; }
    if (k === "G") { selectedHistory = Math.max(0, historyGroups.length - 1); renderHistory(); key.preventDefault(); return; }
    if (k === "enter" || k === "return") { setHistoryPane("detail"); key.preventDefault(); return; }
    if (k === "y") {
      statusMsg = `copied history (${copyToClipboard(renderer, historyDetail.plainText)})`;
      setStatus(); key.preventDefault(); return;
    }
    key.preventDefault();
    return;
  }

  if (pane === "editor") {
    if (k === "s" && key.ctrl) { saveEditor(); key.preventDefault(); return; }
    if (k === "l" && key.ctrl) { setPane("response"); key.preventDefault(); return; }
    if (k === "h" && key.ctrl) { setPane("list"); key.preventDefault(); return; }
    if (insert) {
      if (k === "escape") { leaveInsert(); key.preventDefault(); }
      return;
    }
    if (visual && k === "escape") { clearVisual(); setStatus(); key.preventDefault(); return; }
    if (k === "escape") { setPane("list"); key.preventDefault(); return; }
    vimNormal(k, key);
    key.preventDefault();
    return;
  }

  if (k === "q" && pane === "list" && !filterInputFocused()) { renderer.destroy(); process.exit(0); }
  if (k === "l" && key.ctrl) { setPane(pane === "list" ? "editor" : "response"); key.preventDefault(); return; }
  if (k === "h" && key.ctrl) { setPane(pane === "response" ? "editor" : "list"); key.preventDefault(); return; }
  if (visual && k === "escape") { clearVisual(); setStatus(); key.preventDefault(); return; }
  if (k === "escape") { setPane("list"); key.preventDefault(); return; }
  if (k === "p" && key.ctrl) {
    environmentIdx = (environmentIdx + 1) % environments.length;
    selectedEnvironment = environmentIdx;
    refreshEditorHighlights();
    setStatus();
    key.preventDefault(); return;
  }

  if (pane === "list") {
    if (filterInputFocused()) return;
    if (k === "/" ) { filterInput.focus(); key.preventDefault(); return; }
    if (listPending) {
      const pendingList = listPending;
      listPending = null;
      if (pendingList === "g" && k === "g") {
        selectedRow = 0;
        renderTree();
      }
      key.preventDefault();
      return;
    }
    if (key.ctrl && k === "d") { moveSelection(5); key.preventDefault(); return; }
    if (key.ctrl && k === "u") { moveSelection(-5); key.preventDefault(); return; }
    if (k === "j") { moveSelection(1); key.preventDefault(); return; }
    if (k === "k") { moveSelection(-1); key.preventDefault(); return; }
    if (k === "g" && !key.shift) { listPending = "g"; setStatus(); key.preventDefault(); return; }
    if (k === "G" || (k === "g" && key.shift)) { selectedRow = Math.max(0, treeRows.length - 1); renderTree(); key.preventDefault(); return; }
    if ((k === "enter" || k === "return") && key.ctrl) { runFlow(); key.preventDefault(); return; }
    if (k === "enter" || k === "return") { activateSelection(); key.preventDefault(); return; }
    if (k === "tab") {
      const r = currentReq();
      if (r) { toggleFlowRequest(r); refreshList(r.name); setStatus(); }
      key.preventDefault(); return;
    }
    if (k === "f" && key.ctrl) { runFlow(); key.preventDefault(); return; }
    if (k === "e") { setPane("editor"); key.preventDefault(); return; }
    if (k === "i") { setPane("editor"); enterInsert(); key.preventDefault(); return; }
    if (k === "n" && key.ctrl) {
      const name = `untitled-${Date.now() % 100000}`;
      const file = join(COLLECTION, `${name}.hurl`);
      const template = "# TODO: describe this request\nGET {{host}}/\n";
      writeFileSync(file, template);
      requests.push({ name, file, desc: "TODO", method: "GET", path: "/", vars: [] });
      requests.sort((a, b) => a.name.localeCompare(b.name));
      refreshList(name);
      editor.setText(template);
      setPane("editor");
      key.preventDefault(); return;
    }
    if (k === "x" && key.ctrl) {
      const r = currentReq();
      if (r) {
        rmSync(r.file);
        requests.splice(requests.indexOf(r), 1);
        flowQueue.delete(r.name); normalizeFlowQueue(); lastResult.delete(r.name);
        refreshList(); statusMsg = `deleted ${r.name}`; setStatus();
      }
      key.preventDefault(); return;
    }
    if (k === "y" && !key.shift) {
      const r = currentReq();
      if (r) {
        const rendered = renderTemplate(readFileSync(r.file, "utf8")).replace(/\n?$/, "\n");
        const cmd = `hurl <<'HURL_EOF'\n${rendered}HURL_EOF`;
        statusMsg = `copied hurl command (${copyToClipboard(renderer, cmd)})`;
      }
      setStatus(); key.preventDefault(); return;
    }
    if (k === "Y" || (k === "y" && key.shift)) {
      const r = currentReq();
      const cmd = r ? renderCurl(renderTemplate(readFileSync(r.file, "utf8"))) : undefined;
      statusMsg = cmd ? `copied curl (${copyToClipboard(renderer, cmd)})` : "couldn't build a curl command for this request";
      setStatus(); key.preventDefault(); return;
    }
  }

  if (pane === "response") {
    if (k === "c") {
      const sel = renderer.getSelection();
      const text = respView.hasSelection() ? respView.getSelectedText() : sel?.getSelectedText();
      statusMsg = text ? `copied selection (${copyToClipboard(renderer, text)})` : "no selection, use v/V or drag with mouse first";
      setStatus(); key.preventDefault(); return;
    }
    if (k === "s") {
      if (lastBodies.size === 0) {
        statusMsg = "no body to save, run a request first";
        setStatus(); key.preventDefault(); return;
      }
      const dir = join(COLLECTION, ".termurl", "bodies");
      mkdirSync(dir, { recursive: true });
      const stamp = Date.now();
      const saved: string[] = [];
      for (const [name, body] of lastBodies) {
        const trimmed = body.trim();
        const ext = trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "txt";
        const file = join(dir, `${stamp}-${name.replaceAll("/", "-")}.${ext}`);
        writeFileSync(file, body);
        saved.push(file);
      }
      statusMsg = saved.length === 1 ? `body saved: ${saved[0]}` : `${saved.length} bodies saved to ${dir}`;
      setStatus(); key.preventDefault(); return;
    }
    vimNormal(k, key, respView, true);
    key.preventDefault();
    return;
  }
});

function filterInputFocused() { return (filterInput as any).focused === true; }
filterInput.on("input" as any, () => refreshList());
editor.onContentChange = () => refreshEditorHighlights();
envDetail.onKeyDown = (key) => {
  if (!envInsert) return;
  if (key.ctrl && key.name === "s") {
    saveEnvironmentFile();
    key.preventDefault();
  } else if (key.ctrl && key.name === "h") {
    leaveEnvInsert();
    setEnvPane("list");
    key.preventDefault();
  } else if (key.name === "escape" || key.name === "esc" || key.sequence === "") {
    leaveEnvInsert();
    key.preventDefault();
  }
};
renderer.keyInput.on("keypress", (key: KeyEvent) => {
  if (filterInputFocused() && key.name === "escape") { filterInput.blur(); setPane("list"); key.preventDefault(); }
});

loadHistory();
refreshList(requests[0]?.name);
if (requests.length === 0) statusMsg = `no .hurl files found in ${COLLECTION}`;
setStatus();
setWindow("workspace");
setPane("list");
watchCollection();
renderer.start();
