import {
  createCliRenderer,
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  InputRenderable,
  RGBA,
  SyntaxStyle,
  t,
  fg,
  type StyledText,
  type KeyEvent,
} from "@opentui/core";
import packageJson from "./package.json" with { type: "json" };
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, renameSync, watch } from "fs";
import { join, relative, resolve, dirname } from "path";
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
  mkdirSync(join(dir, "requests", "httpbin"), { recursive: true });
  mkdirSync(join(dir, "flows"), { recursive: true });
  writeFileSync(join(dir, ".env.dev"), "# dev environment variables\nhost=https://httpbin.org\n");
  writeFileSync(join(dir, ".env.example"), "# Example environment file. Copy to .env.dev or another .env.<name>.\n# Keys prefixed with secret_ are masked until explicitly revealed.\n# secret_token=change-me\n");
  writeFileSync(join(dir, "requests", "httpbin", "get.hurl"), "# Sample request\nGET {{host}}/get\nHTTP 200\n");
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
const HEADLESS_COMMANDS = new Set(["doctor", "list", "show", "env", "run", "flows"]);
const HELP = `termurl - a terminal client for hurl collections

usage:
  termurl [collection]                         open the interactive TUI
  termurl init [path] [--yes]                  create config and a starter collection
  termurl doctor [--json]                      check hurl, config, and collection setup
  termurl list [--json]                        list requests
  termurl show <request[@variant]>             print a request file or a single variant
  termurl env list [--json]                    list environments
  termurl env show <name> [--reveal] [--json]  show environment variables
  termurl flows list [--json]                  list saved flows
  termurl flows show <name>                    print a flow file
  termurl run <target...> [options]            run requests and/or flows in argument order
  termurl --version                            print the version

run options:
  --env <name>     choose an environment
  --variant <name> run a variant for all requests without an explicit @variant
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
const VALUE_OPTIONS = ["--env", "--var", "--variant"];
const BOOLEAN_OPTIONS = ["--json", "--reveal", "--quiet", "-q"];
const hasOption = (values: string[], name: string) => values.some((value) => value === name || value.startsWith(`${name}=`));
if (!HEADLESS_COMMANDS.has(args[0] ?? "") && [...VALUE_OPTIONS, "--json"].some((name) => hasOption(args, name))) {
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

const HTTP_METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";
const REQUEST_LINE = new RegExp(`^(?:${HTTP_METHODS}) \\S+`);
const REQUEST_CAPTURE = new RegExp(`^(${HTTP_METHODS})\\s+(\\S+)`, "m");
const VARIANT_MARKER = /^#\s*variant:\s*(.+?)\s*$/;

const requests = loadRequests();
const requestDirs = loadRequestDirs();
const flowCache = new Map<string, FlowCacheEntry>();
const flows = loadFlows();
const flowDirs = loadFlowDirs();
const environments = environmentNames();
if (environments.length === 0) environments.push("dev");
let environmentIdx = Math.max(0, environments.indexOf(CONFIG.environment ?? ""));
let cliVariables: Record<string, string> = {};

type Palette = {
  bg: string;
  fg: string;
  dim: string;
  muted: string;
  yellow: string;
  green: string;
  red: string;
  blue: string;
  cyan: string;
  magenta: string;
  orange: string;
  panel: string;
  selected: string;
  active: string;
};

const DEFAULT_PALETTE: Palette = {
  bg: "#1a1b26",
  fg: "#c0caf5",
  dim: "#565f89",
  muted: "#666666",
  yellow: "#e0af68",
  green: "#9ece6a",
  red: "#f7768e",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  magenta: "#bb9af7",
  orange: "#ff9e64",
  panel: "#24283b",
  selected: "#292e42",
  active: "#3b4261",
};

const OMARCHY_COLORS_FILE = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "omarchy", "current", "theme", "colors.toml");

// Neutral grey between the background and foreground, used to de-emphasise rows
// (matches the muted input-placeholder look, but adapts to light/dark themes).
function neutralGrey(bg: string, fg: string, t = 0.45): string {
  const rgb = (value: string) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
  const a = rgb(bg);
  const b = rgb(fg);
  const grey = Math.round(a.reduce((sum, channel, i) => sum + channel + (b[i] - channel) * t, 0) / 3);
  const hex = Math.max(0, Math.min(255, grey)).toString(16).padStart(2, "0");
  return `#${hex}${hex}${hex}`;
}

function loadOmarchyPalette(): Palette | null {
  if (process.platform !== "linux") return null;
  let colors: Record<string, string>;
  try {
    colors = parseVariables(readFileSync(OMARCHY_COLORS_FILE, "utf8"));
  } catch {
    return null;
  }
  const hex = (value: string | undefined, fallback: string) => (value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback);
  const bg = hex(colors.background, DEFAULT_PALETTE.bg);
  const fg = hex(colors.bright_foreground, DEFAULT_PALETTE.fg);
  return {
    bg,
    fg,
    dim: hex(colors.dark_foreground, DEFAULT_PALETTE.dim),
    muted: neutralGrey(bg, fg),
    yellow: hex(colors.yellow, DEFAULT_PALETTE.yellow),
    green: hex(colors.green, DEFAULT_PALETTE.green),
    red: hex(colors.red, DEFAULT_PALETTE.red),
    blue: hex(colors.blue, DEFAULT_PALETTE.blue),
    cyan: hex(colors.bright_cyan ?? colors.cyan, DEFAULT_PALETTE.cyan),
    magenta: hex(colors.magenta, DEFAULT_PALETTE.magenta),
    orange: hex(colors.orange, DEFAULT_PALETTE.orange),
    panel: hex(colors.lighter_background, DEFAULT_PALETTE.panel),
    selected: hex(colors.selection, DEFAULT_PALETTE.selected),
    active: hex(colors.muted, DEFAULT_PALETTE.active),
  };
}

function resolvePalette(config: Record<string, string>): Palette {
  if (config.theme === "system") return loadOmarchyPalette() ?? DEFAULT_PALETTE;
  return DEFAULT_PALETTE;
}

const C = resolvePalette(CONFIG);

type Req = { name: string; file: string; desc: string; method: string; path: string; vars: string[]; variants: string[] };

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

// Relative paths of every directory under `dir`, so empty folders are visible in
// the request tree. Dot-directories (including .termurl) are skipped.
function walkDirs(dir: string, base = dir, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (!statSync(path).isDirectory()) continue;
    acc.push(relative(base, path));
    walkDirs(path, base, acc);
  }
  return acc;
}

function loadRequestDirs(collection = COLLECTION): string[] {
  return walkDirs(join(collection, "requests")).sort((a, b) => a.localeCompare(b));
}

function loadRequests(collection = COLLECTION): Req[] {
  const root = join(collection, "requests");
  return walk(root)
    .map((file) => {
      const src = readFileSync(file, "utf8");
      const name = relative(root, file).replace(/\.hurl$/, "");
      const desc = src.match(/^# (.+)$/m)?.[1] ?? "";
      const reqLine = src.match(REQUEST_CAPTURE);
      const method = reqLine?.[1] ?? "?";
      const path = (reqLine?.[2] ?? "").replace("{{host}}", "");
      const vars = [...new Set([...src.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]).filter((v) => v !== "host"))];
      const variants = parseEntries(src).slice(1).map((entry) => entry.name).filter((name): name is string => Boolean(name));
      return { name, file, desc, method, path, vars, variants };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

type Flow = { name: string; file: string; desc: string; steps: string[] };

// A .flow file is a saved ordered group of requests: one `request[@variant]` per
// line, `#` comment lines ignored, and the first `#` comment becomes the
// description. Nothing from a flow reaches Hurl directly; the steps are expanded
// into RunTargets and then run by the same flow engine as `termurl run`.
function flowFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? flowFiles(path) : entry.endsWith(".flow") ? [path] : [];
  });
}

function flowName(collection: string, file: string): string {
  const relativePath = relative(collection, file).replace(/\.flow$/, "");
  return relativePath.startsWith("flows/") ? relativePath.slice("flows/".length) : relativePath;
}

function loadFlowDirs(collection = COLLECTION): string[] {
  return walkDirs(join(collection, "flows")).sort((a, b) => a.localeCompare(b));
}

function parseFlow(src: string): { desc: string; steps: string[] } {
  const steps: string[] = [];
  let desc = "";
  for (const line of src.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) {
      if (!desc) desc = trimmed.replace(/^#\s*/, "");
      continue;
    }
    steps.push(trimmed);
  }
  return { desc, steps };
}

type FlowCacheEntry = { mtimeMs: number; text: string; flow: { desc: string; steps: string[] } };

function readFlowFile(file: string): FlowCacheEntry {
  try {
    const mtimeMs = statSync(file).mtimeMs;
    const cached = flowCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    const text = readFileSync(file, "utf8");
    const fresh: FlowCacheEntry = { mtimeMs, text, flow: parseFlow(text) };
    flowCache.set(file, fresh);
    return fresh;
  } catch {
    return { mtimeMs: 0, text: "", flow: { desc: "", steps: [] } };
  }
}

function loadFlows(collection = COLLECTION): Flow[] {
  return flowFiles(join(collection, "flows"))
    .map((file) => {
      const { flow } = readFlowFile(file);
      return { name: flowName(collection, file), file, desc: flow.desc, steps: flow.steps };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function resolveFlow(flow: Flow): { targets?: RunTarget[]; error?: string } {
  const targets: RunTarget[] = [];
  for (const step of flow.steps) {
    const resolved = resolveTarget(step);
    if (resolved.error) return { error: `flow ${flow.name}: ${resolved.error}` };
    if (!resolved.target) return { error: `flow ${flow.name}: unknown request "${step}"` };
    targets.push(resolved.target);
  }
  if (targets.length === 0) return { error: `flow ${flow.name} has no requests` };
  return { targets };
}

function section(src: string, name: string): string[] {
  const m = src.match(new RegExp(`^\\[${name}\\]\\n((?:[^\\[].*\\n?)*)`, "m"));
  return m ? m[1].trim().split("\n").filter(Boolean) : [];
}

// A .hurl file may hold several entries (hurl runs them top to bottom). The first
// entry is the default request; every later entry is a named variant, marked by a
// `# variant: <name>` comment directly above its request line. Extra entries
// without a marker get an auto name so they never silently disappear.
type Entry = { name?: string; start: number; end: number; text: string };

function parseEntries(src: string): Entry[] {
  const lines = src.split("\n");
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  const requestLines: number[] = [];
  lines.forEach((line, index) => { if (REQUEST_LINE.test(line)) requestLines.push(index); });
  if (requestLines.length === 0) return [{ start: 0, end: src.length, text: src }];

  const entryStartLine = (index: number): number => {
    if (index === 0) return 0;
    let start = requestLines[index];
    while (start > 0 && lines[start - 1].trimStart().startsWith("#")) start--;
    return start;
  };

  return requestLines.map((requestLine, index) => {
    const startLine = entryStartLine(index);
    const endLine = index + 1 < requestLines.length ? entryStartLine(index + 1) : lines.length;
    const start = lineOffsets[startLine];
    const end = endLine >= lines.length ? src.length : lineOffsets[endLine];
    let name: string | undefined;
    if (index > 0) {
      for (let line = requestLine - 1; line >= startLine; line--) {
        const marker = lines[line].match(VARIANT_MARKER);
        if (marker) { name = marker[1]; break; }
      }
      name ??= `entry-${index + 1}`;
    }
    return { name, start, end, text: src.slice(start, end).replace(/\n+$/, "") };
  });
}

type HurlFileCacheEntry = { mtimeMs: number; text: string; entries: Entry[] };
const hurlFileCache = new Map<string, HurlFileCacheEntry>();
const EMPTY_HURL_FILE: HurlFileCacheEntry = { mtimeMs: 0, text: "", entries: [] };

// Reads and parses a .hurl file once per on-disk version; revalidated by mtime
// so editor saves and external writes always serve fresh content.
function readHurlFile(file: string): HurlFileCacheEntry {
  try {
    const mtimeMs = statSync(file).mtimeMs;
    const cached = hurlFileCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    const text = readFileSync(file, "utf8");
    const fresh: HurlFileCacheEntry = { mtimeMs, text, entries: parseEntries(text) };
    hurlFileCache.set(file, fresh);
    return fresh;
  } catch {
    return EMPTY_HURL_FILE;
  }
}

function entrySource(req: Req, variant?: string): string {
  const { text, entries } = readHurlFile(req.file);
  if (entries.length === 0) return text;
  if (!variant) return entries[0]?.text ?? text;
  return entries.find((entry) => entry.name === variant)?.text ?? entries[0]?.text ?? text;
}

type RunTarget = { req: Req; variant?: string };

function targetKey(req: Req, variant?: string): string {
  return variant ? `${req.name}@${variant}` : req.name;
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
  request?: { method: string; url: string; headers: string[]; body?: string };
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
    curl_cmd?: string;
    time?: number;
  }>;
};

function environmentFile(name: string, collection = COLLECTION): string {
  return join(collection, `.env.${name}`);
}

const envVariablesCache = new Map<string, Record<string, string>>();

function environmentVariables(name: string, collection = COLLECTION): Record<string, string> {
  const cacheKey = `${collection}\0${name}`;
  const cached = envVariablesCache.get(cacheKey);
  if (cached) return cached;
  let variables: Record<string, string> = {};
  try {
    variables = parseVariables(readFileSync(environmentFile(name, collection), "utf8"));
  } catch {}
  envVariablesCache.set(cacheKey, variables);
  return variables;
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
  const reqLine = lines[i]?.match(REQUEST_CAPTURE);
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

// hurl's --json report never includes a request body field, but the rendered curl
// reproduction (curl_cmd) does, with all {{variables}} already substituted.
// ponytail: naive single-quote scanning, no shell-unescaping - fine for JSON bodies
// that never contain a literal '; revisit only if that stops holding.
function extractRequestBodyFromCurlCmd(curlCmd?: string): string | undefined {
  if (!curlCmd) return undefined;
  const matches = [...curlCmd.matchAll(/--(?:form|data|data-raw) '([^']*)'/g)].map((m) => m[1]);
  return matches.length ? matches.join("\n") : undefined;
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

async function runHurl(targets: RunTarget[]): Promise<RunResult[]> {
  const tempDir = mkdtempSync(join(tmpdir(), "termurl-run-"));
  const hurlFile = join(tempDir, "run.hurl");
  const outputFiles = targets.map((_, index) => `response-${index + 1}.body`);
  const source = targets
    .map((target, index) => addResponseOutput(entrySource(target.req, target.variant), outputFiles[index]))
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

    return targets.map((target, index) => {
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
        captures: captureNames(target.req, target.variant),
        captured,
        headers: call?.response?.headers?.map((header) => `${header.name}: ${header.value}`) ?? [],
        body,
        ...(call?.request ? {
          request: {
            method: call.request.method ?? "",
            url: call.request.url ?? "",
            headers: call.request.headers?.map((header) => `${header.name}: ${header.value}`) ?? [],
            body: extractRequestBodyFromCurlCmd(entry?.curl_cmd),
          },
        } : {}),
        ...(error ? { error } : {}),
      };
    });
  } catch (error) {
    return targets.map(() => emptyRunResult(error instanceof Error ? error.message : String(error)));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function positionalArgs(values: string[]): string[] {
  const positional: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (VALUE_OPTIONS.includes(value)) {
      index += 1;
      continue;
    }
    if (BOOLEAN_OPTIONS.includes(value) || VALUE_OPTIONS.some((name) => value.startsWith(`${name}=`))) continue;
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
  const relativeName = COLLECTION ? relative(join(COLLECTION, "requests"), absolute).replace(/\.hurl$/, "") : "";
  return requests.find((request) => request.name === input || request.name === withoutExtension || request.name === relativeName || request.file === absolute);
}

function resolveTarget(input: string): { target?: RunTarget; error?: string } {
  const at = input.lastIndexOf("@");
  const base = at > 0 ? input.slice(0, at) : input;
  const variant = at > 0 ? input.slice(at + 1) : undefined;
  const req = requestForInput(base);
  if (!req) return {};
  if (variant !== undefined && !req.variants.includes(variant)) {
    return { error: `unknown variant "${variant}" for ${req.name}; available variants: ${req.variants.join(", ") || "none"}` };
  }
  return { target: { req, variant } };
}

function unknownRequest(input: string): number {
  console.error(`termurl: unknown request "${input}"`);
  if (requests.length) console.error(`available requests:\n${requests.map((request) => `  ${request.name}`).join("\n")}`);
  return 1;
}

function flowForInput(input: string): Flow | undefined {
  const withoutExtension = input.replace(/\.flow$/, "");
  const absolute = resolve(input);
  const relativeName = COLLECTION ? flowName(COLLECTION, absolute) : "";
  return flows.find((flow) => flow.name === input || flow.name === withoutExtension || flow.name === relativeName || flow.file === absolute);
}

// Expands positional CLI inputs into run targets, in order. A name is first
// matched to a request and, failing that, to a saved flow whose steps are
// flattened in place, so explicit requests and flows can be mixed in one run.
function cliTargets(inputs: string[], variantOption: string | undefined): { targets?: RunTarget[]; code?: number } {
  const targets: RunTarget[] = [];
  for (const input of inputs) {
    const resolved = resolveTarget(input);
    if (resolved.error) {
      console.error(`termurl: ${resolved.error}`);
      return { code: 1 };
    }
    if (resolved.target) {
      const variant = resolved.target.variant ?? variantOption;
      if (variant && !resolved.target.req.variants.includes(variant)) {
        console.error(`termurl: unknown variant "${variant}" for ${resolved.target.req.name}; available variants: ${resolved.target.req.variants.join(", ") || "none"}`);
        return { code: 1 };
      }
      targets.push({ req: resolved.target.req, variant });
      continue;
    }
    const flow = flowForInput(input);
    if (!flow) return { code: unknownRequest(input) };
    const expanded = resolveFlow(flow);
    if (expanded.error) {
      console.error(`termurl: ${expanded.error}`);
      return { code: 1 };
    }
    for (const step of expanded.targets ?? []) {
      targets.push({ req: step.req, variant: step.variant ?? variantOption });
    }
  }
  return { targets };
}

function listCommand(json: boolean): number {
  const result = requests.map((request) => ({
    name: request.name,
    file: request.file,
    method: request.method,
    path: request.path,
    description: request.desc,
    variables: request.vars,
    variants: request.variants,
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
    console.error("termurl: usage: termurl show <request[@variant]>");
    return 1;
  }
  const resolved = resolveTarget(input);
  if (resolved.error) {
    console.error(`termurl: ${resolved.error}`);
    return 1;
  }
  if (!resolved.target) return unknownRequest(input);
  if (resolved.target.variant) {
    process.stdout.write(`${entrySource(resolved.target.req, resolved.target.variant)}\n`);
    return 0;
  }
  process.stdout.write(readFileSync(resolved.target.req.file, "utf8"));
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
  const variables = Object.entries(environmentVariables(name)).map(([key, value]) => {
    const secret = /^secret_/i.test(key);
    const masked = secret && !reveal;
    return { key, value: masked ? "***" : value, source: `.env.${name}`, secret, masked };
  });
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

function flowsListCommand(json: boolean): number {
  const result = flows.map((flow) => ({
    name: flow.name,
    file: flow.file,
    description: flow.desc,
    steps: flow.steps,
  }));
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const width = flows.reduce((max, flow) => Math.max(max, flow.name.length), 0);
  for (const flow of flows) {
    console.log(`${flow.name.padEnd(width)}  ${flow.steps.length} steps`);
  }
  return 0;
}

function flowsShowCommand(input: string | undefined): number {
  if (!input) {
    console.error("termurl: usage: termurl flows show <name>");
    return 1;
  }
  const flow = flows.find((candidate) => candidate.name === input || candidate.name === input.replace(/\.flow$/, ""));
  if (!flow) {
    console.error(`termurl: unknown flow "${input}"`);
    if (flows.length) console.error(`available flows:\n${flows.map((candidate) => `  ${candidate.name}`).join("\n")}`);
    return 1;
  }
  process.stdout.write(readFileSync(flow.file, "utf8"));
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
  const requestsDir = configuredCollection ? join(configuredCollection, "requests") : undefined;
  const requestsExist = Boolean(requestsDir && existsSync(requestsDir) && statSync(requestsDir).isDirectory());
  const collectionRequests = collectionExists ? loadRequests(configuredCollection as string).length : 0;
  const collectionFlows = collectionExists ? loadFlows(configuredCollection as string).length : 0;
  const names = collectionExists ? environmentNames(configuredCollection as string) : [];
  const checks = {
    hurl: { ok: Boolean(hurlVersion), detail: hurlVersion ?? "not found on PATH; install hurl v8 or newer" },
    config: { ok: configExists, detail: configExists ? CONFIG_FILE : `missing; run termurl init to create ${CONFIG_FILE}` },
    collection: {
      ok: collectionExists,
      detail: collectionExists ? `${configuredCollection} (${collectionRequests} requests, ${collectionFlows} flows)` : configuredCollection ? `not found: ${configuredCollection}` : "not configured",
    },
    requests: {
      ok: requestsExist,
      detail: requestsExist ? requestsDir! : configuredCollection ? `missing: ${requestsDir} (requests live here; move your .hurl files into it)` : "not configured",
    },
    environments: { ok: collectionExists, names },
  };
  const ok = checks.hurl.ok && checks.config.ok && checks.collection.ok && checks.requests.ok;
  if (json) {
    console.log(JSON.stringify({ ok, ...checks }, null, 2));
  } else {
    console.log(`${checks.hurl.ok ? "ok" : "fail"} hurl: ${checks.hurl.detail}`);
    console.log(`${checks.config.ok ? "ok" : "fail"} config: ${checks.config.detail}`);
    console.log(`${checks.collection.ok ? "ok" : "fail"} collection: ${checks.collection.detail}`);
    console.log(`${checks.requests.ok ? "ok" : "fail"} requests: ${checks.requests.detail}`);
    console.log(`info environments: ${names.join(", ") || "none"}`);
  }
  return ok ? 0 : 1;
}

function headlessResult(result: RunResult, target: RunTarget) {
  return {
    request: target.req.name,
    ...(target.variant ? { variant: target.variant } : {}),
    file: target.req.file,
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

function printRunReport(target: RunTarget, result: RunResult): void {
  const status = result.status || "error";
  const asserts = `${result.asserts.passed}/${result.asserts.total}`;
  const captures = Object.keys(result.captured);
  console.error(`${result.success ? "ok" : "fail"} ${targetKey(target.req, target.variant)} ${status} ${result.ms}ms asserts ${asserts}${captures.length ? ` captures ${captures.join(",")}` : ""}`);
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
  const variantOption = optionValue(values, "--variant");
  cliVariables = parsed.variables ?? {};
  const inputs = positionalArgs(values);
  if (inputs.length === 0) {
    console.error("termurl: usage: termurl run <target...> [--env name] [--variant name] [--var KEY=value] [--json] [-q]");
    return 1;
  }
  const resolvedTargets = cliTargets(inputs, variantOption);
  if (!resolvedTargets.targets) return resolvedTargets.code ?? 1;
  const targets = resolvedTargets.targets;

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
      process.stdout.write(`==> ${targetKey(targets[index].req, targets[index].variant)}\n`);
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
  if (command === "flows") {
    const subcommand = args[1];
    const values = args.slice(2);
    if (subcommand === "list") return flowsListCommand(values.includes("--json"));
    if (subcommand === "show") return flowsShowCommand(positionalArgs(values)[0]);
    console.error("termurl: usage: termurl flows list [--json] | termurl flows show <name>");
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
  if (process.platform === "darwin") {
    try {
      Bun.spawnSync({ cmd: ["pbcopy"], stdin: new TextEncoder().encode(text) });
      via = "pbcopy";
    } catch {}
  }
  return ok || via === "pbcopy" ? via : "failed";
}

const renderer = await createCliRenderer({ useMouse: true, enableMouseMovement: true, useAlternateScreen: true } as any);
renderer.setBackgroundColor(C.bg);

const flowQueue = new Map<string, number>();
const lastResult = new Map<string, "ok" | "fail">();
const lastBodies = new Map<string, string>();
const activeVariant = new Map<string, string>();
let editorEntry: { reqName: string; variant?: string } | null = null;
let editorSavedText = "";
let envSavedText = "";
let envMasked = true;
let envLoadedName: string | null = null;
let commandBuffer: string | null = null;
type Pane = "list" | "editor" | "response";
let pane: Pane = "list";
let insert = false;
let pending: string | null = null;
// Pending `f`/`F`/`t`/`T` motion waiting for its target character, mirroring the
// two-keystroke char search in vim. Kept separate from `pending` because the
// operator keys (`d`/`c`/`y`) and this prefix share the same keypress slot.
let charSearch: string | null = null;
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
type FlowPane = "list" | "editor" | "response";
let flowPane: FlowPane = "list";
type FlowRow =
  | { type: "folder"; path: string; name: string; depth: number }
  | { type: "flow"; flow: Flow; depth: number };
const flowCollapsed = new Set<string>();
let flowRows: FlowRow[] = [];
let selectedFlowRow = 0;

// One cached TextRenderable per list row so a selection move only repaints the
// two affected rows instead of rebuilding every row on each keypress. `key`
// identifies the logical row at a slot, so the mouse handler is rebuilt only
// when that row or its position changes. `contentKey` lets palette and file
// changes still reach the cached views; a new StyledText (history rows) carries
// theme colors, so those keys embed a palette generation.
type ListRowView<T> = {
  view: TextRenderable;
  contentKey: string;
  key: string;
  index: number;
  fg: string;
  bg: string;
  row: T | null;
};

function createRowView<T>(container: BoxRenderable): ListRowView<T> {
  const view = new TextRenderable(renderer, {
    content: "", width: "100%", height: 1, fg: C.fg, bg: C.bg, truncate: true, selectable: false,
  });
  container.add(view);
  return { view, contentKey: "", key: "", index: -1, fg: "", bg: "", row: null };
}

// Grows or shrinks the cached row list to match `count`, rebuilding every view
// only when the row count changes.
function ensureRowViews<T>(views: ListRowView<T>[], count: number, container: BoxRenderable): ListRowView<T>[] {
  if (views.length === count) return views;
  clearChildren(container);
  return Array.from({ length: count }, () => createRowView<T>(container));
}

type RowPaint<T> = { contentKey: string; content: string | StyledText; fg: string; bg: string; row: T | null };

function paintRowView<T>(entry: ListRowView<T>, paint: RowPaint<T>) {
  if (entry.contentKey !== paint.contentKey) { entry.view.content = paint.content; entry.contentKey = paint.contentKey; }
  if (entry.fg !== paint.fg) { entry.view.fg = paint.fg; entry.fg = paint.fg; }
  if (entry.bg !== paint.bg) { entry.view.bg = paint.bg; entry.bg = paint.bg; }
  entry.row = paint.row;
}

let flowRowViews: ListRowView<FlowRow>[] = [];
let flowInsert = false;
let flowSavedText = "";
let flowLoadedName: string | null = null;
type NamePurpose = "create" | "rename";
let flowNamePurpose: NamePurpose = "create";
let requestNamePurpose: NamePurpose = "create";
let pendingDelete: { label: string; confirm: () => void } | null = null;
type HistoryPane = "list" | "detail";
let historyPane: HistoryPane = "list";
type AppWindow = "requests" | "flows" | "history" | "environments";
let appWindow: AppWindow = "requests";

type HistoryRecord = {
  ts: string;
  request: string;
  variant?: string;
  environment?: string;
  profile?: string;
  status: number;
  success?: boolean;
  duration_ms: number;
  flow_id?: string;
  step?: number;
  flow_size?: number;
  flow?: string;
  queued?: boolean;
  captures?: string[];
  request_detail?: string;
  response?: string;
  error?: string;
};

type HistoryGroup = {
  key: string;
  flow: boolean;
  flowName?: string;
  queued: boolean;
  ts: string;
  environment: string;
  steps: HistoryRecord[];
};

let historyGroups: HistoryGroup[] = [];
let historyRowViews: ListRowView<HistoryGroup>[] = [];
let selectedHistory = 0;
let selectedEnvironment = 0;
let envRowViews: ListRowView<string>[] = [];
let secretsRevealed = false;

type TreeRow =
  | { type: "folder"; path: string; name: string; depth: number }
  | { type: "request"; req: Req; depth: number };

type TreeNode = {
  folders: Map<string, TreeNode>;
  requests: Req[];
};

// Synthetic row at the top of both file trees: a placeholder for the base
// directory so `a` can create files there and `enter`/`l` can expand/collapse
// every directory at once. Its path is the empty string.
const TREE_ROOT = "⌂";

const collapsed = new Set<string>();
let treeRows: TreeRow[] = [];
let treeRowViews: ListRowView<TreeRow>[] = [];
let selectedRow = 0;
let lastRowClick = { index: -1, time: 0 };

function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case "GET": return C.green;
    case "POST": return C.blue;
    case "PUT": return C.yellow;
    case "PATCH": return C.magenta;
    case "DELETE": return C.red;
    case "HEAD": return C.orange;
    case "OPTIONS": return C.fg;
    default: return C.dim;
  }
}

function requestLabel(r: Req): string {
  const variant = currentVariant(r);
  const order = flowQueue.get(targetKey(r, variant));
  const mark = order === undefined ? "" : `[${order}] `;
  const name = r.name.split("/").pop() ?? r.name;
  const suffix = variant ? ` @${variant}` : r.variants.length > 0 ? ` +${r.variants.length}` : "";
  return `${mark}${name}${suffix}`;
}

const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%" });
renderer.root.add(root);

const tabBar = new TextRenderable(renderer, {
  content: "",
  height: 1,
  backgroundColor: C.panel,
  selectable: false,
} as any);
root.add(tabBar);

const main = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1 });
root.add(main);

let sidebarSplit = 33;
let editorSplit = 55;
let historySplit = 44;
let environmentSplit = 32;
let flowSplit = 36;
let flowDetailSplit = 55;

type DividerDrag = { divider: BoxRenderable; container: BoxRenderable; axis: "x" | "y"; resize: (value: number) => void };
let activeDivider: DividerDrag | null = null;

const listBox = new BoxRenderable(renderer, {
  width: `${sidebarSplit}%`, flexShrink: 0, border: true, borderStyle: "single", title: " REQUESTS ", flexDirection: "column",
  borderColor: C.dim, backgroundColor: C.bg,
  padding: 1,
});
main.add(listBox);

const verticalDivider = new BoxRenderable(renderer, {
  width: 1, flexShrink: 0, backgroundColor: C.bg, selectable: false,
} as any);
main.add(verticalDivider);

const filterInput = new InputRenderable(renderer, { placeholder: "/ filter", backgroundColor: "transparent", textColor: C.fg });
listBox.add(filterInput);

const requestNameInput = new InputRenderable(renderer, {
  placeholder: "name (end with / for a folder)",
  backgroundColor: "transparent",
  textColor: C.fg,
  visible: false,
});
listBox.add(requestNameInput);

const treeList = new ScrollBoxRenderable(renderer, {
  flexGrow: 1,
  backgroundColor: C.bg,
  scrollY: true,
  viewportCulling: true,
});
listBox.add(treeList);

const rightCol = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, flexBasis: 0 });
main.add(rightCol);

const editorBox = new BoxRenderable(renderer, {
  height: `${editorSplit}%`, border: true, borderStyle: "single", title: " REQUEST ", borderColor: C.dim, backgroundColor: C.bg,
  padding: 1,
});
rightCol.add(editorBox);

const editor = new TextareaRenderable(renderer, {
  initialValue: requests[0] ? entrySource(requests[0]) : "",
  backgroundColor: C.bg, textColor: C.fg,
  flexGrow: 1, flexBasis: 0, height: "100%",
  selectable: true,
});

const editorGutter = new TextRenderable(renderer, {
  content: "", width: 3, height: "100%", flexShrink: 0, fg: C.dim, bg: C.bg, selectable: false,
} as any);
const editorWrap = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", flexGrow: 1, flexBasis: 0 });
editorWrap.add(editorGutter);
editorWrap.add(editor);
editorBox.add(editorWrap);

const variantStrip = new BoxRenderable(renderer, {
  height: 1, flexShrink: 0, flexDirection: "row", backgroundColor: C.panel, visible: false,
} as any);
rightCol.add(variantStrip);

const horizontalDivider = new BoxRenderable(renderer, {
  height: 1, flexShrink: 0, backgroundColor: C.bg, selectable: false,
} as any);
rightCol.add(horizontalDivider);

const responseBox = new BoxRenderable(renderer, {
  flexGrow: 1, border: true, borderStyle: "single", title: " RESPONSE ", borderColor: C.dim, backgroundColor: C.bg,
  padding: 1,
});
rightCol.add(responseBox);

const respView = new TextareaRenderable(renderer, {
  backgroundColor: C.bg,
  textColor: C.fg,
  width: "100%", height: "100%",
  selectable: true,
  flexGrow: 1,
});
respView.setText("run a request with enter");
respView.onKeyDown = (key) => key.preventDefault();
respView.onPaste = (event) => event.preventDefault();
responseBox.add(respView);

const statusBar = new TextRenderable(renderer, { content: "", height: 1, backgroundColor: C.panel, selectable: false } as any);

const historyWindow = new BoxRenderable(renderer, {
  flexDirection: "row",
  flexGrow: 1,
  backgroundColor: C.bg,
});
root.add(historyWindow);

const historyListBox = new BoxRenderable(renderer, {
  width: historySplit,
  border: true,
  borderStyle: "single",
  title: " HISTORY ",
  borderColor: C.dim,
  backgroundColor: C.bg,
  flexDirection: "column",
  padding: 1,
});
historyWindow.add(historyListBox);

const historyDivider = new BoxRenderable(renderer, {
  width: 1, flexShrink: 0, backgroundColor: C.bg, selectable: false,
} as any);
historyWindow.add(historyDivider);

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
  padding: 1,
});
historyWindow.add(historyDetailBox);

const historyDetail = new TextareaRenderable(renderer, {
  backgroundColor: C.bg,
  textColor: C.fg,
  width: "100%", height: "100%",
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
  width: environmentSplit,
  border: true,
  borderStyle: "single",
  title: " ENVIRONMENTS ",
  borderColor: C.dim,
  backgroundColor: C.bg,
  flexDirection: "column",
  padding: 1,
});
envWindow.add(envListBox);

const environmentDivider = new BoxRenderable(renderer, {
  width: 1, flexShrink: 0, backgroundColor: C.bg, selectable: false,
} as any);
envWindow.add(environmentDivider);

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
  padding: 1,
});
envWindow.add(envDetailBox);

const envDetail = new TextareaRenderable(renderer, {
  backgroundColor: C.bg,
  textColor: C.fg,
  flexGrow: 1, flexBasis: 0, height: "100%",
  selectable: true,
});
const envDetailGutter = new TextRenderable(renderer, {
  content: "", width: 3, height: "100%", flexShrink: 0, fg: C.dim, bg: C.bg, selectable: false,
} as any);
const envDetailWrap = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", flexGrow: 1, flexBasis: 0 });
envDetailWrap.add(envDetailGutter);
envDetailWrap.add(envDetail);
envDetailBox.add(envDetailWrap);
envWindow.visible = false;

const flowWindow = new BoxRenderable(renderer, {
  flexDirection: "row",
  flexGrow: 1,
  backgroundColor: C.bg,
});
root.add(flowWindow);

const flowListBox = new BoxRenderable(renderer, {
  width: flowSplit,
  border: true,
  borderStyle: "single",
  title: " FLOWS ",
  borderColor: C.dim,
  backgroundColor: C.bg,
  flexDirection: "column",
  padding: 1,
});
flowWindow.add(flowListBox);

const flowDivider = new BoxRenderable(renderer, {
  width: 1, flexShrink: 0, backgroundColor: C.bg, selectable: false,
} as any);
flowWindow.add(flowDivider);

const flowList = new BoxRenderable(renderer, {
  flexGrow: 1,
  flexDirection: "column",
  backgroundColor: C.bg,
});

const flowFilterInput = new InputRenderable(renderer, { placeholder: "/ filter", backgroundColor: "transparent", textColor: C.fg });
flowListBox.add(flowFilterInput);

const flowNameInput = new InputRenderable(renderer, {
  placeholder: "name (end with / for a folder)",
  backgroundColor: "transparent",
  textColor: C.fg,
  visible: false,
});
flowListBox.add(flowNameInput);
flowListBox.add(flowList);

const flowRightCol = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, flexBasis: 0 });
flowWindow.add(flowRightCol);

const flowDetailBox = new BoxRenderable(renderer, {
  height: `${flowDetailSplit}%`,
  border: true,
  borderStyle: "single",
  title: " FLOW ",
  borderColor: C.dim,
  backgroundColor: C.bg,
  padding: 1,
});
flowRightCol.add(flowDetailBox);

const flowDetail = new TextareaRenderable(renderer, {
  backgroundColor: C.bg,
  textColor: C.fg,
  flexGrow: 1, flexBasis: 0, height: "100%",
  selectable: true,
});
const flowDetailGutter = new TextRenderable(renderer, {
  content: "", width: 3, height: "100%", flexShrink: 0, fg: C.dim, bg: C.bg, selectable: false,
} as any);
const flowDetailWrap = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", flexGrow: 1, flexBasis: 0 });
flowDetailWrap.add(flowDetailGutter);
flowDetailWrap.add(flowDetail);
flowDetailBox.add(flowDetailWrap);

const flowHorizontalDivider = new BoxRenderable(renderer, {
  height: 1, flexShrink: 0, backgroundColor: C.bg, selectable: false,
} as any);
flowRightCol.add(flowHorizontalDivider);

const flowResponseBox = new BoxRenderable(renderer, {
  flexGrow: 1, border: true, borderStyle: "single", title: " RESPONSE ", borderColor: C.dim, backgroundColor: C.bg,
  padding: 1,
});
flowRightCol.add(flowResponseBox);

const flowRespView = new TextareaRenderable(renderer, {
  backgroundColor: C.bg,
  textColor: C.fg,
  width: "100%", height: "100%",
  selectable: true,
  flexGrow: 1,
});
flowRespView.setText("run a flow with enter");
flowRespView.onKeyDown = (key) => key.preventDefault();
flowRespView.onPaste = (event) => event.preventDefault();
flowResponseBox.add(flowRespView);

flowWindow.visible = false;
root.add(statusBar);

const commandLines: { box: BoxRenderable; line: TextRenderable }[] = [];

function createCommandLine(box: BoxRenderable): { box: BoxRenderable; line: TextRenderable } {
  const line = new TextRenderable(renderer, {
    content: "", position: "absolute", left: 0, bottom: 0, width: 10, height: 1,
    fg: C.fg, bg: C.panel, selectable: false, visible: false, zIndex: 10,
  } as any);
  box.add(line);
  const entry = { box, line };
  commandLines.push(entry);
  return entry;
}

const editorCommandLine = createCommandLine(editorBox);
const envDetailCommandLine = createCommandLine(envDetailBox);
const flowDetailCommandLine = createCommandLine(flowDetailBox);

function commandLineTarget(): { box: BoxRenderable; line: TextRenderable } | null {
  if (appWindow === "environments") return envPane === "editor" ? envDetailCommandLine : null;
  if (appWindow === "flows") return flowInsert ? null : flowDetailCommandLine;
  if (appWindow === "requests" && pane === "editor") return editorCommandLine;
  return null;
}

function renderCommandLine() {
  for (const { box, line } of commandLines) {
    line.visible = false;
    const width = Math.max(1, Math.floor(box.width) - 2);
    if (line.width !== width) line.width = width;
  }
  if (commandBuffer === null) return;
  const target = commandLineTarget();
  if (!target) return;
  target.line.content = `:${commandBuffer}`.padEnd(Math.max(1, Math.floor(target.box.width) - 2));
  target.line.visible = true;
}

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

const helpLegend = new TextRenderable(renderer, {
  content: "", height: 1, fg: C.fg, bg: C.bg, selectable: false, visible: false,
} as any);
helpOverlay.add(helpLegend);

const helpText = new TextareaRenderable(renderer, { backgroundColor: "transparent", textColor: C.fg, selectable: false, flexGrow: 1 });
helpText.onKeyDown = (key) => key.preventDefault();
helpText.onPaste = (event) => event.preventDefault();
helpOverlay.add(helpText);

const flowPickerBackdrop = new BoxRenderable(renderer, {
  position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
  backgroundColor: C.bg, zIndex: 99, visible: false,
});
root.add(flowPickerBackdrop);

const flowPicker = new BoxRenderable(renderer, {
  position: "absolute", top: "20%", left: "20%", width: "60%", height: "50%",
  border: true, borderStyle: "single", title: " FLOWS ",
  borderColor: C.yellow, backgroundColor: C.bg, zIndex: 100, visible: false,
  padding: 1,
});
root.add(flowPicker);

const flowPickerText = new TextRenderable(renderer, {
  content: "", width: "100%", height: "100%", fg: C.fg, bg: C.bg, selectable: false,
} as any);
flowPicker.add(flowPickerText);

let flowPickerVisible = false;
let flowPickerIndex = 0;

function renderFlowPicker() {
  if (!flowPickerVisible) return;
  if (flows.length === 0) {
    flowPickerText.content = "no flows yet\n\nqueue requests with tab, then :saveflow <name>";
    return;
  }
  flowPickerIndex = Math.max(0, Math.min(flowPickerIndex, flows.length - 1));
  flowPickerText.content = flows.map((flow, index) => {
    const marker = index === flowPickerIndex ? ">" : " ";
    return `${marker} ${flow.name}  (${flow.steps.length} steps)`;
  }).join("\n");
}

function showFlowPicker() {
  flows.splice(0, flows.length, ...loadFlows());
  pendingDelete = null;
  flowPickerVisible = true;
  flowPickerIndex = 0;
  flowPicker.title = ` FLOWS (${flows.length}) `;
  renderFlowPicker();
  flowPickerBackdrop.visible = true;
  flowPicker.visible = true;
}

function hideFlowPicker() {
  flowPickerVisible = false;
  flowPickerBackdrop.visible = false;
  flowPicker.visible = false;
}

listBox.onMouseDown = () => { if (appWindow === "requests" && pane !== "list") setPane("list"); };
editorBox.onMouseDown = () => { if (appWindow === "requests" && pane !== "editor") setPane("editor"); };
responseBox.onMouseDown = () => { if (appWindow === "requests" && pane !== "response") setPane("response"); };
historyListBox.onMouseDown = () => { if (appWindow === "history" && historyPane !== "list") setHistoryPane("list"); };
historyDetailBox.onMouseDown = () => { if (appWindow === "history" && historyPane !== "detail") setHistoryPane("detail"); };
envListBox.onMouseDown = () => { if (appWindow === "environments" && envPane !== "list") setEnvPane("list"); };
envDetailBox.onMouseDown = () => { if (appWindow === "environments" && envPane !== "editor") setEnvPane("editor"); };
flowListBox.onMouseDown = () => { if (appWindow === "flows" && flowPane !== "list") setFlowPane("list"); };
flowDetailBox.onMouseDown = () => { if (appWindow === "flows" && flowPane !== "editor") setFlowPane("editor"); };
flowResponseBox.onMouseDown = () => { if (appWindow === "flows" && flowPane !== "response") setFlowPane("response"); };

function setSplits(sidebar: number, editor: number) {
  sidebarSplit = Math.max(15, Math.min(60, sidebar));
  editorSplit = Math.max(20, Math.min(80, editor));
  const mainWidth = Math.max(1, main.width - verticalDivider.width);
  const contentHeight = Math.max(1, rightCol.height - horizontalDivider.height);
  listBox.width = Math.round(mainWidth * sidebarSplit / 100);
  editorBox.height = Math.round(contentHeight * editorSplit / 100);
  renderer.requestRender();
}

function setFlowDetailSplit(value: number) {
  flowDetailSplit = Math.max(20, Math.min(80, value));
  const contentHeight = Math.max(1, flowRightCol.height - flowHorizontalDivider.height);
  flowDetailBox.height = Math.round(contentHeight * flowDetailSplit / 100);
  renderer.requestRender();
}

function setFixedSidebarSplit(value: number, container: BoxRenderable, sidebar: BoxRenderable) {
  const max = Math.max(20, container.width - 20);
  const width = Math.max(20, Math.min(max, value));
  sidebar.width = width;
  if (sidebar === historyListBox) historySplit = width;
  else if (sidebar === envListBox) environmentSplit = width;
  else if (sidebar === flowListBox) flowSplit = width;
  renderer.requestRender();
}

const POINTER_SHAPE: Record<"x" | "y", string> = { x: "ew-resize", y: "ns-resize" };

function setPointerShape(shape: string) {
  (renderer as any).writeOut(`\x1b]22;${shape}\x1b\\`);
}

const showDivider = (divider: BoxRenderable, axis: "x" | "y") => {
  divider.backgroundColor = C.dim;
  setPointerShape(POINTER_SHAPE[axis]);
};
const hideDivider = (divider: BoxRenderable) => {
  divider.backgroundColor = C.bg;
  setPointerShape("default");
};

function endDividerDrag() {
  if (!activeDivider) return;
  hideDivider(activeDivider.divider);
  activeDivider = null;
}

function setupDivider(divider: BoxRenderable, container: BoxRenderable, axis: "x" | "y", resize: (value: number) => void) {
  divider.onMouseOver = () => { if (!activeDivider) showDivider(divider, axis); };
  divider.onMouseOut = () => { if (!activeDivider) hideDivider(divider); };
  divider.onMouseDown = (event) => {
    if (event.button !== 0) return;
    activeDivider = { divider, container, axis, resize };
    showDivider(divider, axis);
    event.preventDefault();
    event.stopPropagation();
  };
}

setupDivider(verticalDivider, main, "x", (x) => {
  const available = Math.max(1, main.width - verticalDivider.width);
  setSplits((x / available) * 100, editorSplit);
});

setupDivider(historyDivider, historyWindow, "x", (x) => {
  setFixedSidebarSplit(x, historyWindow, historyListBox);
});
setupDivider(environmentDivider, envWindow, "x", (x) => {
  setFixedSidebarSplit(x, envWindow, envListBox);
});
setupDivider(flowDivider, flowWindow, "x", (x) => {
  setFixedSidebarSplit(x, flowWindow, flowListBox);
});

setupDivider(horizontalDivider, rightCol, "y", (y) => {
  const height = Math.max(1, rightCol.height - horizontalDivider.height);
  setSplits(sidebarSplit, (y / height) * 100);
});
setupDivider(flowHorizontalDivider, flowRightCol, "y", (y) => {
  const height = Math.max(1, flowRightCol.height - flowHorizontalDivider.height);
  setFlowDetailSplit((y / height) * 100);
});

root.onMouseDrag = (event) => {
  if (!activeDivider) return;
  const { divider, container, axis, resize } = activeDivider;
  showDivider(divider, axis);
  resize(axis === "x" ? event.x - container.screenX : event.y - container.screenY);
  event.preventDefault();
};
root.onMouseUp = () => endDividerDrag();
root.onMouseDragEnd = () => endDividerDrag();

function currentReq(): Req | null {
  const row = treeRows[selectedRow];
  return row?.type === "request" ? row.req : null;
}

function currentVariant(req: Req): string | undefined {
  const variant = activeVariant.get(req.name);
  return variant && req.variants.includes(variant) ? variant : undefined;
}

function editorDirty(): boolean {
  return editorEntry !== null && editor.plainText !== editorSavedText;
}

function envDirty(): boolean {
  return !envMasked && envDetail.plainText !== envSavedText;
}

function diffStats(saved: string, current: string): { added: number; removed: number } {
  const a = saved.split("\n");
  const b = current.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return { added: endB - start, removed: endA - start };
}

function dirtyBufferInfos(): { name: string; added: number; removed: number }[] {
  const infos: { name: string; added: number; removed: number }[] = [];
  if (editorDirty() && editorEntry) infos.push({ name: editorEntry.reqName, ...diffStats(editorSavedText, editor.plainText) });
  if (envDirty()) infos.push({ name: `.env.${envLoadedName}`, ...diffStats(envSavedText, envDetail.plainText) });
  if (flowDirty()) infos.push({ name: `flows/${flowLoadedName}`, ...diffStats(flowSavedText, flowDetail.plainText) });
  return infos;
}

function dirtyBufferName(infos = dirtyBufferInfos()): string | null {
  return infos[0]?.name ?? null;
}

function dirtyBufferLabel(infos = dirtyBufferInfos()): string {
  return infos
    .map(({ name, added, removed }) => {
      const stats = [added > 0 ? `+${added}` : "", removed > 0 ? `-${removed}` : ""].filter(Boolean).join(" ");
      return `[${name}${stats ? ` ${stats}` : "+"}]`;
    })
    .join(" ");
}

function warnDirty(name: string) {
  statusMsg = `unsaved changes in ${name} (:w to save, :q! to discard)`;
  setStatus();
}

function focusDirtyBuffer(name: string) {
  if (name.startsWith(".env.")) {
    const envName = name.slice(".env.".length);
    setWindow("environments");
    const idx = environments.indexOf(envName);
    if (idx >= 0) {
      selectedEnvironment = idx;
      renderEnvironments();
      setEnvPane("editor");
    }
  } else if (name.startsWith("flows/")) {
    const flowName = name.slice("flows/".length);
    setWindow("flows");
    selectFlowByName(flowName);
    if (flows.some((flow) => flow.name === flowName)) setFlowPane("editor");
  } else {
    setWindow("requests");
    const idx = treeRows.findIndex((row) => row.type === "request" && row.req.name === name);
    if (idx >= 0) {
      selectedRow = idx;
      renderTree();
    }
    setPane("editor");
  }
  statusMsg = `unsaved changes in ${name} (:w to save, :q! to quit anyway)`;
  setStatus();
}

function quitApp(force = false) {
  const dirtyName = dirtyBufferName();
  if (dirtyName && !force) {
    focusDirtyBuffer(dirtyName);
    return;
  }
  renderer.destroy();
  process.exit(0);
}

function requestTitle(insertMode = false, visualMode = false): string {
  const req = currentReq();
  const variant = req ? currentVariant(req) : undefined;
  const base = req && variant
    ? `REQUEST (${req.name}@${variant})`
    : req && req.variants.length > 0
      ? `REQUEST (${req.name} +${req.variants.length})`
      : "REQUEST";
  const dirty = editorDirty() ? " [+]" : "";
  const mode = visualMode ? " (VISUAL)" : insertMode ? " (INSERT)" : "";
  return ` ${base}${dirty}${mode} `;
}

function loadEditorEntry(req: Req, force = false) {
  pending = null;
  charSearch = null;
  const variant = currentVariant(req);
  if (!force && editorDirty() && editorEntry && editorEntry.reqName === req.name && editorEntry.variant === variant) {
    syncModeTitles();
    renderVariantStrip(req);
    return;
  }
  editorEntry = { reqName: req.name, variant };
  const text = entrySource(req, variant);
  editorSavedText = text;
  editor.setText(text);
  syncModeTitles();
  renderVariantStrip(req);
  refreshEditorHighlights();
}

function variantOptions(req: Req): (string | undefined)[] {
  return [undefined, ...req.variants];
}

function setVariant(req: Req, name: string | undefined) {
  if (editorDirty()) {
    warnDirty(editorEntry?.reqName ?? req.name);
    return;
  }
  if (name) activeVariant.set(req.name, name);
  else activeVariant.delete(req.name);
  loadEditorEntry(req);
  renderTree();
  setStatus();
}

function cycleVariant(delta: number) {
  const req = currentReq();
  if (!req || req.variants.length === 0 || insert) return;
  if (editorDirty()) {
    warnDirty(editorEntry?.reqName ?? req.name);
    return;
  }
  const options = variantOptions(req);
  const index = options.indexOf(currentVariant(req));
  setVariant(req, options[(index + delta + options.length) % options.length]);
}

function clearChildren(container: BoxRenderable) {
  for (const child of container.getChildren()) {
    container.remove(child);
    child.destroy();
  }
}

function renderVariantStrip(req: Req | null) {
  clearChildren(variantStrip);
  const show = Boolean(req && req.variants.length > 0);
  variantStrip.visible = show;
  if (!req || !show) return;
  const active = currentVariant(req);
  variantStrip.add(new TextRenderable(renderer, {
    content: " variants: ", height: 1, fg: C.dim, bg: C.panel, selectable: false,
  }));
  for (const name of variantOptions(req)) {
    const isActive = name === undefined ? active === undefined : name === active;
    const segment = new TextRenderable(renderer, {
      content: ` ${name ?? "default"} `,
      height: 1,
      fg: isActive ? C.fg : C.dim,
      bg: isActive ? C.active : C.panel,
      selectable: false,
    });
    segment.onMouseDown = () => { if (!insert) setVariant(req, name); };
    variantStrip.add(segment);
    variantStrip.add(new TextRenderable(renderer, {
      content: " ", height: 1, fg: C.dim, bg: C.panel, selectable: false,
    }));
  }
}

type VariableSource = "file" | "secret" | "capture" | "unresolved";

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function buildVariableSyntax(): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    file: { fg: C.green },
    secret: { fg: C.yellow },
    capture: { fg: C.blue },
    unresolved: { fg: C.red },
  });
}

function buildResponseFailureSyntax(): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    failure: { fg: C.red },
    label: { fg: C.cyan, bold: true },
  });
}

let variableSyntax = buildVariableSyntax();
let responseFailureSyntax = buildResponseFailureSyntax();

function applyResponseHighlights(target: TextareaRenderable, text: string, failed: boolean) {
  target.editBuffer.setSyntaxStyle(responseFailureSyntax);
  target.editBuffer.clearAllHighlights();

  // Line start offsets, computed once; every range highlight below maps
  // character offsets to rows from this table instead of re-splitting text.
  const lineStarts = computeLineStarts(text);
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const mid = (low + high) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid;
    }
    return low;
  };

  const highlightRange = (start: number, end: number, styleId: number) => {
    for (let line = lineAt(start); line < lineStarts.length && lineStarts[line] < end; line++) {
      const lineStart = lineStarts[line];
      const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
      const rangeStart = Math.max(start, lineStart);
      const rangeEnd = Math.min(end, lineEnd);
      if (rangeStart < rangeEnd) {
        target.editBuffer.addHighlight(line, {
          start: rangeStart - lineStart,
          end: rangeEnd - lineStart,
          styleId,
        });
      }
    }
  };

  const labelStyleId = responseFailureSyntax.getStyleId("label") ?? 0;
  for (const label of ["REQUEST", "RESPONSE", "ASSERTIONS"]) {
    let searchFrom = 0;
    while (true) {
      const start = text.indexOf(`${label}\n`, searchFrom);
      if (start < 0) break;
      highlightRange(start, start + label.length, labelStyleId);
      searchFrom = start + label.length;
    }
  }

  // Per-step heading in a multi-request flow (e.g. "▸ 2. notification-send-push"),
  // highlighted the same as section labels so it's not lost after a long response body.
  for (let line = 0; line < lineStarts.length; line++) {
    const lineStart = lineStarts[line];
    const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
    const content = text.slice(lineStart, lineEnd);
    if (/^▸ \d+\.\s.+$/.test(content)) {
      target.editBuffer.addHighlight(line, { start: 0, end: content.length, styleId: labelStyleId });
    }
  }

  if (!failed) return;

  const styleId = responseFailureSyntax.getStyleId("failure") ?? 0;
  let searchFrom = 0;
  let highlighted = false;
  while (true) {
    const start = text.indexOf("reason:\n", searchFrom);
    if (start < 0) break;
    const blankLine = text.indexOf("\n\n", start);
    const end = blankLine < 0 ? text.length : blankLine;
    highlightRange(start, end, styleId);
    highlighted = true;
    searchFrom = end + 2;
  }
  if (!highlighted) highlightRange(0, text.length, styleId);
}

let lastResponse: { text: string; failed: boolean } | null = null;
let lastFlowResponse: { text: string; failed: boolean } | null = null;

function renderResponse(text: string, failed: boolean) {
  lastResponse = { text, failed };
  respView.setText(text);
  applyResponseHighlights(respView, text, failed);
}

function renderFlowResponse(text: string, failed: boolean) {
  lastFlowResponse = { text, failed };
  flowRespView.setText(text);
  applyResponseHighlights(flowRespView, text, failed);
}

type RunSurface = "requests" | "flows";

function focusResponse(surface: RunSurface) {
  if (surface === "flows") setFlowPane("response");
  else setPane("response");
}

function saveLastBodies(): string {
  if (lastBodies.size === 0) return "no body to save, run a request first";
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
  return saved.length === 1 ? `body saved: ${saved[0]}` : `${saved.length} bodies saved to ${dir}`;
}

function captureNames(req: Req, variant?: string): string[] {
  return section(entrySource(req, variant), "Captures")
    .map((line) => line.match(/^([a-zA-Z_][\w-]*)\s*:/)?.[1])
    .filter((name): name is string => name !== undefined);
}

function availableCaptures(req: Req | null): Set<string> {
  const available = new Set<string>();
  if (!req) return available;
  const currentOrder = flowQueue.get(targetKey(req, currentVariant(req)));
  if (currentOrder === undefined) return available;
  for (const [key, order] of flowQueue) {
    if (order >= currentOrder) continue;
    const target = resolveKey(key);
    if (target) captureNames(target.req, target.variant).forEach((capture) => available.add(capture));
  }
  return available;
}

function variableSource(name: string, captures: Set<string>): VariableSource {
  if (captures.has(name)) return "capture";
  if (environmentVariables(environments[environmentIdx])[name] !== undefined) return /^secret_/i.test(name) ? "secret" : "file";
  return "unresolved";
}

function renderTabs() {
  const tab = (key: string, label: string, active: boolean) => active ? `[${key} ${label}]` : ` ${key} ${label} `;
  tabBar.content = ` ${tab("1", "Requests", appWindow === "requests")} ${tab("2", "Flows", appWindow === "flows")} ${tab("3", "History", appWindow === "history")} ${tab("4", "Environments", appWindow === "environments")}    env: ${environments[environmentIdx]}`;
}

function envTitle(state: "list" | "editor" | "insert" | "visual"): string {
  const base = `ENVIRONMENT (.env.${environments[selectedEnvironment]})`;
  const dirty = envDirty() ? " [+]" : "";
  if (state === "insert") return ` ${base}${dirty} · INSERT `;
  if (state === "visual") return ` ${base}${dirty} · VISUAL `;
  if (state === "editor") return ` ${base}${dirty} `;
  const text = environmentVariables(environments[selectedEnvironment]);
  const hasSecrets = Object.keys(text).some((key) => /^secret_/i.test(key));
  if (hasSecrets) return ` ${base}${dirty} ${secretsRevealed ? "[revealed]" : "[masked]"} `;
  return ` ${base}${dirty} `;
}

function maskSecretsText(text: string): string {
  return text.split("\n").map((line) => {
    const match = line.match(/^(\s*(secret_\w*)\s*=\s*)(.*)$/i);
    return match && match[3].trim() ? `${match[1]}***` : line;
  }).join("\n");
}

function renderEnvironments() {
  envRowViews = ensureRowViews(envRowViews, environments.length, envList);
  environments.forEach((environment, index) => {
    const active = index === environmentIdx;
    const selected = index === selectedEnvironment;
    const content = `${selected ? ">" : " "} ${environment}${active ? "  (active)" : ""}`;
    const key = `e:${environment}`;
    const entry = envRowViews[index];
    paintRowView(entry, {
      contentKey: content,
      content,
      fg: active ? C.green : C.fg,
      bg: selected ? C.selected : C.bg,
      row: environment,
    });
    if (entry.key !== key || entry.index !== index) {
      entry.key = key;
      entry.index = index;
      entry.view.onMouseDown = () => {
        const name = environments[index];
        if (!name) return;
        if (appWindow === "environments" && envPane !== "list") setEnvPane("list");
        if (envDirty() && name !== envLoadedName) {
          warnDirty(`.env.${envLoadedName}`);
          return;
        }
        selectedEnvironment = index;
        renderEnvironments();
        loadEnvironmentFile();
      };
    }
  });
}

// Moves the environment selection, blocking when a dirty buffer would be clobbered.
function moveEnvironment(delta: number) {
  const next = Math.max(0, Math.min(environments.length - 1, selectedEnvironment + delta));
  if (next === selectedEnvironment) return;
  if (envDirty() && environments[next] !== envLoadedName) { warnDirty(`.env.${envLoadedName}`); return; }
  selectedEnvironment = next;
  renderEnvironments();
  loadEnvironmentFile();
}

function loadEnvironmentFile(force = false) {
  pending = null;
  charSearch = null;
  const name = environments[selectedEnvironment];
  if (!force && envDirty() && envLoadedName === name) {
    if (envPane === "list" && !envInsert) envDetailBox.title = envTitle("list");
    return;
  }
  let text = "";
  try { text = readFileSync(environmentFile(name), "utf8"); } catch {}
  envLoadedName = name;
  envSavedText = text;
  envMasked = envPane === "list" && !secretsRevealed;
  envDetail.setText(envMasked ? maskSecretsText(text) : text);
  if (envPane === "list" && !envInsert) envDetailBox.title = envTitle("list");
}

function saveEnvironmentFile() {
  if (envMasked) {
    statusMsg = "buffer is masked, open the editor to save";
    setStatus();
    return;
  }
  const name = environments[selectedEnvironment];
  envSavedText = envDetail.plainText;
  envMasked = false;
  envLoadedName = name;
  writeFileSync(environmentFile(name), envDetail.plainText);
  envVariablesCache.clear();
  statusMsg = `saved .env.${name}`;
  syncModeTitles();
  refreshEditorHighlights();
  setStatus();
  setTimeout(() => { statusMsg = ""; setStatus(); }, 2000);
}

function enterEnvInsert() {
  envInsert = true;
  syncModeTitles();
  envDetail.focus();
  setStatus();
}

function leaveEnvInsert() {
  envInsert = false;
  envPane = "editor";
  syncModeTitles();
  envDetail.focus();
  setStatus();
}

function setEnvPane(next: EnvPane) {
  clearVisual();
  pending = null;
  commandBuffer = null;
  pendingDelete = null;
  envInsert = false;
  envPane = next;
  refreshPaneBorders();
  loadEnvironmentFile();
  envDetailBox.title = envTitle(next);
  if (next === "editor") envDetail.focus();
  else envDetail.blur();
  setStatus();
}

function flowDirty(): boolean {
  return flowLoadedName !== null && flowDetail.plainText !== flowSavedText;
}

function currentFlowRow(): FlowRow | null {
  return flowRows[selectedFlowRow] ?? null;
}

function currentFlow(): Flow | null {
  const row = currentFlowRow();
  return row?.type === "flow" ? row.flow : null;
}

function flowTitle(state: "list" | "editor" | "insert" | "visual"): string {
  const flow = currentFlow();
  const base = flow ? `FLOW (${flow.name})` : "FLOW";
  const dirty = flowDirty() ? " [+]" : "";
  if (state === "insert") return ` ${base}${dirty} · INSERT `;
  if (state === "visual") return ` ${base}${dirty} · VISUAL `;
  return ` ${base}${dirty} `;
}

function flowLabel(flow: Flow): string {
  const name = flow.name.split("/").pop() ?? flow.name;
  return `${name}  (${flow.steps.length} steps)`;
}

// Builds the folder/flow rows for the Flows tab from flowDirs + flows. Directories
// without flows still appear, so `a`/`r`/`d` can act on them.
function buildFlowTree(): FlowRow[] {
  type Node = { folders: Map<string, Node>; flows: Flow[] };
  const root: Node = { folders: new Map(), flows: [] };
  const ensure = (parts: string[]): Node => {
    let node = root;
    for (const part of parts) {
      let child = node.folders.get(part);
      if (!child) { child = { folders: new Map(), flows: [] }; node.folders.set(part, child); }
      node = child;
    }
    return node;
  };
  const query = flowFilterInput.value.trim().toLowerCase();
  const visibleFlows = query ? flows.filter((flow) => flow.name.toLowerCase().includes(query)) : flows;
  const visibleDirs = query
    ? flowDirs.filter((dir) => visibleFlows.some((flow) => flow.name.startsWith(`${dir}/`)))
    : flowDirs;
  for (const dir of visibleDirs) ensure(dir.split("/"));
  for (const flow of visibleFlows) ensure(flow.name.split("/").slice(0, -1)).flows.push(flow);
  const rows: FlowRow[] = [];
  const walk = (node: Node, path: string, depth: number) => {
    for (const [name, child] of [...node.folders.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const childPath = path ? `${path}/${name}` : name;
      rows.push({ type: "folder", path: childPath, name, depth });
      if (!flowCollapsed.has(childPath)) walk(child, childPath, depth + 1);
    }
    for (const flow of [...node.flows].sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push({ type: "flow", flow, depth });
    }
  };
  walk(root, "", 0);
  return [{ type: "folder", path: "", name: TREE_ROOT, depth: 0 }, ...rows.map((row) => ({ ...row, depth: row.depth + 1 }))];
}

// Recursively toggles a flow folder and every directory beneath it; with path
// "" this is the tree root (every directory).
function toggleFlowSubtree(path: string) {
  const scope = flowDirs.filter((dir) => path === "" || dir.startsWith(`${path}/`));
  const expanded = !flowCollapsed.has(path) || scope.some((dir) => !flowCollapsed.has(dir));
  for (const dir of [path, ...scope]) {
    if (expanded) flowCollapsed.add(dir);
    else flowCollapsed.delete(dir);
  }
}

// Toggling the root collapses or expands every flow directory at once.
function toggleFlowRoot() {
  toggleFlowSubtree("");
}

function renderFlowList() {
  const selectedName = currentFlow()?.name;
  flowRows = buildFlowTree();
  if (selectedName) {
    const index = flowRows.findIndex((row) => row.type === "flow" && row.flow.name === selectedName);
    if (index >= 0) selectedFlowRow = index;
  }
  selectedFlowRow = Math.max(0, Math.min(selectedFlowRow, Math.max(0, flowRows.length - 1)));

  const query = flowFilterInput.value.trim();
  const message = flowRows.length === 1
    ? (query ? ` no flows match "${query}"` : " no flows yet, press a to create one")
    : null;

  flowRowViews = ensureRowViews(flowRowViews, flowRows.length + (message ? 1 : 0), flowList);

  flowRows.forEach((row, index) => {
    const entry = flowRowViews[index];
    const content = row.type === "folder"
      ? `${"  ".repeat(row.depth)}${flowCollapsed.has(row.path) ? "▸" : "▾"} ${row.name}/`
      : `${"  ".repeat(row.depth + 1)}${flowLabel(row.flow)}`;
    const key = row.type === "folder" ? `d:${row.path}` : `w:${row.flow.name}`;
    const bg = index === selectedFlowRow ? C.selected : C.bg;
    paintRowView(entry, { contentKey: content, content, fg: C.fg, bg, row });
    if (entry.key !== key || entry.index !== index) {
      entry.key = key;
      entry.index = index;
      entry.view.onMouseDown = () => {
        const current = flowRows[index];
        if (!current) return;
        if (appWindow === "flows" && flowPane !== "list") setFlowPane("list");
        if (!selectFlowRow(index)) return;
        if (current.type === "folder") { toggleFlowFolder(current.path); return; }
        loadFlowFile();
      };
    }
  });

  if (message) {
    const entry = flowRowViews[flowRows.length];
    paintRowView(entry, { contentKey: message, content: message, fg: C.dim, bg: C.bg, row: null });
    if (entry.key !== "message") {
      entry.key = "message";
      entry.index = -1;
      entry.view.onMouseDown = undefined;
    }
  }
}

// Returns false when a dirty flow buffer would be clobbered by the switch.
function selectFlowRow(index: number): boolean {
  const row = flowRows[index];
  if (!row) return false;
  if (flowDirty() && flowLoadedName !== null) {
    const targetName = row.type === "flow" ? row.flow.name : null;
    if (targetName !== flowLoadedName) {
      warnDirty(`flows/${flowLoadedName}`);
      return false;
    }
  }
  const previous = selectedFlowRow;
  selectedFlowRow = index;
  if (previous !== index) {
    const prev = flowRowViews[previous];
    if (prev) { prev.view.bg = C.bg; prev.bg = C.bg; }
    const curr = flowRowViews[index];
    if (curr) { curr.view.bg = C.selected; curr.bg = C.selected; }
  }
  return true;
}

function moveFlowSelection(delta: number) {
  if (flowRows.length === 0) return;
  const next = Math.max(0, Math.min(flowRows.length - 1, selectedFlowRow + delta));
  if (next === selectedFlowRow) return;
  if (!selectFlowRow(next)) return;
  loadFlowFile();
}

function toggleFlowFolder(path: string, recursive = false) {
  if (recursive) {
    toggleFlowSubtree(path);
  } else if (path === "") {
    toggleFlowRoot();
  } else if (flowCollapsed.has(path)) {
    flowCollapsed.delete(path);
  } else {
    flowCollapsed.add(path);
    for (const dir of flowDirs) if (dir.startsWith(`${path}/`)) flowCollapsed.add(dir);
  }
  flowRows = buildFlowTree();
  const index = flowRows.findIndex((row) => row.type === "folder" && row.path === path);
  if (index >= 0) selectedFlowRow = index;
  renderFlowList();
  loadFlowFile();
}

function loadFlowFile(force = false) {
  pending = null;
  charSearch = null;
  const flow = currentFlow();
  if (flow) {
    if (!force && flowDirty() && flowLoadedName === flow.name) {
      syncModeTitles();
      return;
    }
    let text = "";
    try { text = readFileSync(flow.file, "utf8"); } catch {}
    flowLoadedName = flow.name;
    flowSavedText = text;
    flowDetail.setText(text);
  } else {
    if (!force && flowDirty()) { syncModeTitles(); return; }
    flowLoadedName = null;
    flowSavedText = "";
    flowDetail.setText("");
  }
  syncModeTitles();
}

function saveFlowFile() {
  const flow = currentFlow();
  if (!flow) return;
  const name = flow.name;
  writeFileSync(flow.file, flowDetail.plainText);
  flowSavedText = flowDetail.plainText;
  reloadFlows();
  selectFlowByName(name);
  syncModeTitles();
  statusMsg = `saved flows/${name}`;
  refreshEditorHighlights();
  setStatus();
  setTimeout(() => { statusMsg = ""; setStatus(); }, 2000);
}

function enterFlowInsert() {
  flowInsert = true;
  syncModeTitles();
  flowDetail.focus();
  setStatus();
}

function leaveFlowInsert() {
  flowInsert = false;
  flowPane = "editor";
  syncModeTitles();
  flowDetail.focus();
  setStatus();
}

function setFlowPane(next: FlowPane) {
  clearVisual();
  pending = null;
  commandBuffer = null;
  pendingDelete = null;
  flowInsert = false;
  flowFilterInput.blur();
  flowPane = next;
  refreshPaneBorders();
  loadFlowFile();
  flowDetailBox.title = flowTitle(next === "response" ? "list" : next);
  if (next === "editor") { flowDetail.focus(); flowRespView.blur(); }
  else if (next === "response") { flowRespView.focus(); flowDetail.blur(); }
  else { flowDetail.blur(); flowRespView.blur(); }
  setStatus();
}

// Parses a name typed in a create/rename input. A trailing "/" means a
// directory; otherwise a file, with the given extension stripped if present.
function parseNameInput(value: string, extension: string): { kind: "dir" | "file"; path: string } | { error: string } {
  let raw = value.trim();
  if (raw === "") return { error: "name is required" };
  const kind = raw.endsWith("/") ? "dir" : "file";
  if (kind === "dir") raw = raw.replace(/\/+$/, "");
  else if (extension && raw.toLowerCase().endsWith(extension)) raw = raw.slice(0, -extension.length);
  if (!raw) return { error: "name is required" };
  if (raw.startsWith("/") || raw.startsWith("~")) return { error: "name must be relative to the collection" };
  const parts = raw.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return { error: `invalid name "${value}"` };
  return { kind, path: raw };
}

function flowBase(): string {
  return join(COLLECTION, "flows");
}

function reloadFlows() {
  flowCache.clear();
  flowDirs.splice(0, flowDirs.length, ...loadFlowDirs());
  flows.splice(0, flows.length, ...loadFlows());
  flowRows = buildFlowTree();
  selectedFlowRow = Math.max(0, Math.min(selectedFlowRow, Math.max(0, flowRows.length - 1)));
}

function selectFlowByName(name: string, folderPath?: string) {
  flowRows = buildFlowTree();
  const index = flowRows.findIndex((row) => row.type === "flow" ? row.flow.name === name : row.type === "folder" && row.path === folderPath);
  if (index >= 0) selectedFlowRow = index;
  renderFlowList();
}

function createFlowPath(value: string): boolean {
  const parsed = parseNameInput(value, ".flow");
  if ("error" in parsed) { statusMsg = parsed.error; setStatus(); return false; }
  const base = flowBase();
  if (parsed.kind === "dir") {
    if (existsSync(join(base, parsed.path))) { statusMsg = `flows/${parsed.path}/ already exists`; setStatus(); return false; }
    mkdirSync(join(base, parsed.path), { recursive: true });
    reloadFlows();
    selectFlowByName("", parsed.path);
    statusMsg = `created flows/${parsed.path}/`;
    setStatus();
    return true;
  }
  const file = join(base, `${parsed.path}.flow`);
  if (existsSync(file)) { statusMsg = `flow ${parsed.path} already exists`; setStatus(); return false; }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# ${parsed.path}\n`);
  reloadFlows();
  selectFlowByName(parsed.path);
  setFlowPane("editor");
  enterFlowInsert();
  statusMsg = `created flows/${parsed.path}`;
  setStatus();
  return true;
}

function renameFlowPath(value: string): boolean {
  const row = currentFlowRow();
  if (!row) return false;
  if (row.type === "folder" && row.path === "") { statusMsg = "cannot rename the root"; setStatus(); return false; }
  if (flowDirty()) { warnDirty(`flows/${flowLoadedName}`); return false; }
  const parsed = parseNameInput(value, ".flow");
  if ("error" in parsed) { statusMsg = parsed.error; setStatus(); return false; }
  const base = flowBase();
  if (row.type === "folder") {
    if (parsed.path === row.path) return false;
    const target = join(base, parsed.path);
    if (existsSync(target)) { statusMsg = `flows/${parsed.path}/ already exists`; setStatus(); return false; }
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(base, row.path), target);
    reloadFlows();
    selectFlowByName("", parsed.path);
    statusMsg = `renamed flows/${row.path}/ to flows/${parsed.path}/`;
    setStatus();
    return true;
  }
  if (parsed.path === row.flow.name) return false;
  const target = join(base, `${parsed.path}.flow`);
  if (existsSync(target)) { statusMsg = `flow ${parsed.path} already exists`; setStatus(); return false; }
  mkdirSync(dirname(target), { recursive: true });
  renameSync(row.flow.file, target);
  reloadFlows();
  selectFlowByName(parsed.path);
  statusMsg = `renamed flows/${row.flow.name} to flows/${parsed.path}`;
  setStatus();
  return true;
}

function deleteFlowPath() {
  const row = currentFlowRow();
  if (!row) return;
  if (row.type === "folder" && row.path === "") { statusMsg = "cannot delete the root"; setStatus(); return; }
  if (flowDirty() && flowLoadedName !== null && (row.type === "flow" ? row.flow.name === flowLoadedName : flowLoadedName.startsWith(`${row.path}/`))) {
    warnDirty(`flows/${flowLoadedName}`);
    return;
  }
  const label = row.type === "folder" ? `flows/${row.path}/` : `flows/${row.flow.name}`;
  if (row.type === "folder") rmSync(join(flowBase(), row.path), { recursive: true, force: true });
  else rmSync(row.flow.file, { force: true });
  reloadFlows();
  renderFlowList();
  loadFlowFile(true);
  statusMsg = `deleted ${label}`;
  setStatus();
}

function showFlowNameInput(purpose: NamePurpose, prefill = "") {
  flowPane = "list";
  pendingDelete = null;
  flowNamePurpose = purpose;
  flowNameInput.value = prefill;
  flowNameInput.visible = true;
  flowNameInput.focus();
  setStatus();
}

function hideFlowNameInput() {
  flowNameInput.visible = false;
  flowNameInput.blur();
  setStatus();
}

function flowNameInputFocused(): boolean {
  return (flowNameInput as any).focused === true;
}

function submitFlowName(value: string) {
  return flowNamePurpose === "rename" ? renameFlowPath(value) : createFlowPath(value);
}

// Prefill for `a` in the Flows tab: inside the selected folder, or the selected
// flow's parent directory, so the new file is a sibling.
function flowCreatePrefill(): string {
  const row = currentFlowRow();
  if (!row) return "";
  if (row.type === "folder") return row.path ? `${row.path}/` : "";
  const at = row.flow.name.lastIndexOf("/");
  return at > 0 ? row.flow.name.slice(0, at + 1) : "";
}

function showFlowRenameInput() {
  const row = currentFlowRow();
  if (!row) return;
  if (row.type === "folder" && row.path === "") { statusMsg = "cannot rename the root"; setStatus(); return; }
  showFlowNameInput("rename", row.type === "folder" ? row.path : row.flow.name);
}

// Appends a request (the explicit argument or the requests selection) as a new
// step at the end of the flow buffer.
function appendStepToFlow(target?: string) {
  if (!currentFlow()) {
    statusMsg = "select a flow first (tab 2)";
    setStatus();
    return;
  }
  const req = currentReq();
  const value = target ?? (req ? targetKey(req, currentVariant(req)) : undefined);
  if (!value) {
    statusMsg = "no request selected to add";
    setStatus();
    return;
  }
  const text = flowDetail.plainText.replace(/\n+$/, "");
  flowDetail.setText(`${text}\n${value}\n`);
  flowDetail.focus();
  statusMsg = `added ${value}`;
  setStatus();
}

function moveFlowLine(delta: number) {
  const eb = flowDetail.editBuffer;
  const { row } = eb.getCursorPosition();
  const targetRow = row + delta;
  if (targetRow < 0 || targetRow >= eb.getLineCount()) return;
  const text = flowDetail.plainText.split("\n");
  const [line] = text.splice(row, 1);
  text.splice(targetRow, 0, line);
  flowDetail.setText(text.join("\n"));
  eb.setCursor(targetRow, 0);
  ensureCursorVisible(flowDetail);
  setStatus();
}

function refreshEditorHighlights() {
  editor.editBuffer.setSyntaxStyle(variableSyntax);
  editor.editBuffer.clearAllHighlights();
  const text = editor.plainText;
  if (!text.includes("{{")) return;
  const captures = availableCaptures(currentReq());
  const lineStarts = computeLineStarts(text);
  let line = 0;
  for (const match of text.matchAll(/\{\{([a-z_][a-z0-9_]*)\}\}/g)) {
    const start = match.index;
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= start) line++;
    const styleId = variableSyntax.getStyleId(variableSource(match[1], captures)) ?? 0;
    editor.editBuffer.addHighlight(line, {
      start: start - lineStarts[line],
      end: start - lineStarts[line] + match[0].length,
      styleId,
    });
  }
}

function redactResponse(response: string): string {
  return response
    .replace(/("token"\s*:\s*)"[^"]*"/g, '$1"<redacted>"')
    .replace(/(Bearer\s+)\S+/g, "$1<redacted>");
}

const stepFailed = (step: HistoryRecord) => step.success === false || step.status >= 400;

function historyStatus(group: HistoryGroup): string {
  const failed = group.steps.find(stepFailed);
  return failed ? `${failed.status} FAIL` : "OK";
}

function historyFailed(group: HistoryGroup): boolean {
  return group.steps.some(stepFailed);
}

function historyTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function historyDayKey(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function historyDayLabel(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  const label = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return date.getFullYear() === now.getFullYear() ? label : `${label} ${date.getFullYear()}`;
}

function historyTitle(group: HistoryGroup): StyledText {
  const base = fg(C.fg);
  const status = fg(historyFailed(group) ? C.red : C.green);
  const time = historyTime(group.ts);
  if (group.flow) {
    const kind = group.flowName ? `FLOW  ${group.flowName}` : group.queued ? "QUEUE" : "FLOW";
    const steps = `${group.steps.length} step${group.steps.length === 1 ? "" : "s"}`;
    return t`${base(`${time}  ${kind}  (${steps})  `)}${status(historyStatus(group))}`;
  }
  const step = group.steps[0];
  const request = step ? targetKeyLabel(step) : "unknown";
  return t`${base(`${time}  REQUEST  ${request}  `)}${status(historyStatus(group))}`;
}

function targetKeyLabel(step: HistoryRecord): string {
  return step.variant ? `${step.request}@${step.variant}` : step.request;
}

function historyDetailText(group: HistoryGroup | undefined): string {
  if (!group) return "No runs recorded yet.";
  const duration = group.steps.reduce((sum, step) => sum + step.duration_ms, 0);
  const first = group.steps[0];
  const kind = group.flow
    ? group.flowName ? `FLOW ${group.flowName}` : group.queued ? "QUEUE" : "FLOW"
    : `REQUEST ${first ? targetKeyLabel(first) : "unknown"}`;
  const lines = [
    `${kind} · ${group.environment}`,
    `started: ${group.ts}`,
    `duration: ${duration}ms · status: ${historyStatus(group)}`,
    "",
  ];
  for (const [index, step] of group.steps.entries()) {
    lines.push(`${index + 1}. ${targetKeyLabel(step)} · ${step.status} · ${step.duration_ms}ms`);
    if (step.error && !step.response?.includes("reason:")) lines.push("reason:", step.error);
    if (step.captures?.length) lines.push(`   captures: ${step.captures.join(", ")}`);
    if (step.request_detail) lines.push("", "request:", step.request_detail);
    if (step.response) lines.push("", step.response);
    lines.push("");
  }
  return lines.join("\n");
}

let historyRenderedWidth = -1;
// Bumped by applyPalette so cached StyledText history rows rebuild with the new theme.
let paletteGeneration = 0;
// Maps a history group index to the cached view slot that shows it.
let historyGroupViews: number[] = [];

function updateHistoryDetail() {
  const group = historyGroups[selectedHistory];
  const text = historyDetailText(group);
  historyDetail.setText(text);
  applyResponseHighlights(historyDetail, text, Boolean(group?.steps.some((step) => step.error || step.status >= 400)));
}

function renderHistory() {
  historyRenderedWidth = Math.floor(historyList.width);
  type Slot = { key: string; group: number | null; content: string | StyledText; contentKey: string; fg: string };
  const slots: Slot[] = [];
  let lastDayKey = "";
  historyGroups.forEach((group, index) => {
    const dayKey = historyDayKey(group.ts);
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      const label = historyDayLabel(group.ts);
      const ruleWidth = Math.max(0, Math.floor(historyList.width || 20) - label.length - 4);
      slots.push({
        key: `h:${dayKey}`,
        group: null,
        content: ` ${label} ${"─".repeat(ruleWidth)}`,
        contentKey: `${dayKey}|${ruleWidth}`,
        fg: C.dim,
      });
    }
    slots.push({
      key: `g:${group.key}`,
      group: index,
      content: historyTitle(group),
      contentKey: `${group.key}|${group.steps.length}|${group.ts}|${paletteGeneration}`,
      fg: C.fg,
    });
  });

  historyRowViews = ensureRowViews(historyRowViews, slots.length, historyList);
  historyGroupViews = new Array(historyGroups.length).fill(-1);

  slots.forEach((slot, viewIndex) => {
    const entry = historyRowViews[viewIndex];
    const selected = slot.group !== null && slot.group === selectedHistory;
    paintRowView(entry, {
      contentKey: slot.contentKey,
      content: slot.content,
      fg: slot.fg,
      bg: selected ? C.selected : C.bg,
      row: slot.group === null ? null : historyGroups[slot.group],
    });
    if (slot.group !== null) historyGroupViews[slot.group] = viewIndex;
    if (entry.key !== slot.key || entry.index !== viewIndex) {
      entry.key = slot.key;
      entry.index = viewIndex;
      const groupIndex = slot.group;
      entry.view.onMouseDown = groupIndex === null ? undefined : () => {
        if (appWindow === "history" && historyPane !== "list") setHistoryPane("list");
        selectHistoryRow(groupIndex);
      };
    }
  });

  updateHistoryDetail();
}

// Moves the history selection and repaints only the two affected group rows.
function selectHistoryRow(index: number) {
  if (!historyGroups[index]) return;
  const previous = selectedHistory;
  selectedHistory = index;
  if (previous !== index) {
    const prevView = historyGroupViews[previous];
    const prev = prevView >= 0 ? historyRowViews[prevView] : undefined;
    if (prev) { prev.view.bg = C.bg; prev.bg = C.bg; }
    const currView = historyGroupViews[index];
    const curr = currView >= 0 ? historyRowViews[currView] : undefined;
    if (curr) { curr.view.bg = C.selected; curr.bg = C.selected; }
  }
  updateHistoryDetail();
}

function newHistoryGroup(key: string, record: HistoryRecord): HistoryGroup {
  return {
    key,
    flow: Boolean(record.flow_id || (record.flow_size ?? 0) > 1),
    flowName: record.flow,
    queued: Boolean(record.queued),
    ts: record.ts,
    environment: record.environment ?? record.profile ?? "-",
    steps: [],
  };
}

const byStep = (a: HistoryRecord, b: HistoryRecord) => (a.step ?? 1) - (b.step ?? 1);

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
      group = newHistoryGroup(key, record);
      groups.set(key, group);
    }
    group.steps.push(record);
    if (record.ts > group.ts) group.ts = record.ts;
  });

  historyGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      steps: [...group.steps].sort(byStep),
    }))
    .sort((a, b) => b.ts.localeCompare(a.ts));
  selectedHistory = Math.max(0, Math.min(selectedHistory, Math.max(0, historyGroups.length - 1)));
  if (appWindow === "history") renderHistory();
}

let liveHistoryKeyCounter = 0;

// Applies a freshly appended record to the in-memory groups instead of
// re-parsing the whole history.jsonl after every run. New records are always
// the most recent, so a new group goes to the front of the desc-by-ts list.
function appendHistoryRecord(record: HistoryRecord) {
  const key = record.flow_id ?? `request-live-${liveHistoryKeyCounter++}`;
  let group = historyGroups.find((candidate) => candidate.key === key);
  if (!group) {
    group = newHistoryGroup(key, record);
    historyGroups.unshift(group);
  }
  group.steps.push(record);
  group.steps.sort(byStep);
  if (record.ts > group.ts) group.ts = record.ts;
  selectedHistory = Math.max(0, Math.min(selectedHistory, Math.max(0, historyGroups.length - 1)));
  if (appWindow === "history") renderHistory();
}

function recordHistory(target: RunTarget, result: RunResult, meta: { flowId?: string; step?: number; flowSize?: number; flow?: string; queued?: boolean } = {}) {
  mkdirSync(join(COLLECTION, ".termurl"), { recursive: true });
  const requestDetail = formatRequest(result);
  const record: HistoryRecord = {
    ts: new Date().toISOString(),
    request: target.req.name,
    ...(target.variant ? { variant: target.variant } : {}),
    environment: environments[environmentIdx],
    status: result.status,
    success: result.success,
    duration_ms: result.ms,
    captures: result.captures,
    ...(requestDetail ? { request_detail: redactResponse(requestDetail) } : {}),
    response: redactResponse(formatRun(result, target.variant)),
    ...(result.error ? { error: result.error } : {}),
    ...(meta.flowId ? { flow_id: meta.flowId, step: meta.step, flow_size: meta.flowSize } : {}),
    ...(meta.flow ? { flow: meta.flow } : {}),
    ...(meta.queued ? { queued: true } : {}),
  };
  appendFileSync(HISTORY_FILE, `${JSON.stringify(record)}\n`);
  appendHistoryRecord(record);
}

function resolveKey(key: string): RunTarget | undefined {
  const at = key.lastIndexOf("@");
  const name = at > 0 ? key.slice(0, at) : key;
  const variant = at > 0 ? key.slice(at + 1) : undefined;
  const req = requests.find((r) => r.name === name);
  if (!req) return undefined;
  if (variant && !req.variants.includes(variant)) return undefined;
  return { req, variant };
}

function normalizeFlowQueue() {
  const keys = [...flowQueue.keys()].filter((key) => resolveKey(key) !== undefined);
  flowQueue.clear();
  keys.forEach((key, index) => flowQueue.set(key, index + 1));
}

function toggleFlowRequest(req: Req) {
  const key = targetKey(req, currentVariant(req));
  if (flowQueue.has(key)) flowQueue.delete(key);
  else flowQueue.set(key, flowQueue.size + 1);
  normalizeFlowQueue();
}

function clearQueue() {
  const count = flowQueue.size;
  if (count === 0) {
    statusMsg = "queue is already empty";
    setStatus();
    return;
  }
  flowQueue.clear();
  refreshList(currentReq()?.name);
  statusMsg = `cleared ${count} queued request${count === 1 ? "" : "s"}`;
  setStatus();
}

// Writes the current queue, in order, as a .flow file under flows/. The name is
// sanitized to keep it inside the flows directory; refuses to overwrite unless
// force is set.
function saveCurrentQueue(name: string, force: boolean): string {
  const trimmed = name.trim().replace(/\.flow$/, "");
  if (!trimmed) return "usage: :saveflow[!] <name>";
  if (trimmed.includes("..") || trimmed.startsWith("/") || trimmed.endsWith("/")) return `invalid flow name "${name}"`;
  const keys = [...flowQueue.entries()].sort(([, a], [, b]) => a - b).map(([key]) => key);
  if (keys.length === 0) return "queue is empty, mark requests with tab first";
  const file = join(COLLECTION, "flows", `${trimmed}.flow`);
  if (existsSync(file) && !force) return `flow ${trimmed} already exists (:saveflow! to overwrite)`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# Saved from queue\n${keys.join("\n")}\n`);
  flows.splice(0, flows.length, ...loadFlows());
  return `saved flow ${trimmed} (${keys.length} steps)`;
}

function buildTree(list: Req[], dirs: string[]): TreeNode {
  const root: TreeNode = { folders: new Map(), requests: [] };
  const ensure = (parts: string[]): TreeNode => {
    let node = root;
    for (const part of parts) {
      let child = node.folders.get(part);
      if (!child) {
        child = { folders: new Map(), requests: [] };
        node.folders.set(part, child);
      }
      node = child;
    }
    return node;
  };
  for (const dir of dirs) ensure(dir.split("/"));
  for (const req of list) ensure(req.name.split("/").slice(0, -1)).requests.push(req);
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

function requestTreeRows(list: Req[], dirs: string[]): TreeRow[] {
  const children = flattenTree(buildTree(list, dirs), "", 0);
  return [{ type: "folder", path: "", name: TREE_ROOT, depth: 0 }, ...children.map((row) => ({ ...row, depth: row.depth + 1 }))];
}

// Recursively toggles a folder and every directory beneath it: if anything in
// the subtree is expanded it collapses the whole subtree, otherwise it expands
// it. With path "" this is the tree root (every directory).
function toggleRequestSubtree(path: string) {
  const scope = requestDirs.filter((dir) => path === "" || dir.startsWith(`${path}/`));
  const expanded = !collapsed.has(path) || scope.some((dir) => !collapsed.has(dir));
  for (const dir of [path, ...scope]) {
    if (expanded) collapsed.add(dir);
    else collapsed.delete(dir);
  }
}

// Toggling the root collapses or expands every directory at once; the marker
// lives on the empty-string path.
function toggleRequestRoot() {
  toggleRequestSubtree("");
}

// Collapsing a folder also collapses its subtree, so re-expanding shows the
// nested folders collapsed by default.
function toggleRequestFolder(path: string) {
  if (collapsed.has(path)) {
    collapsed.delete(path);
    return;
  }
  collapsed.add(path);
  for (const dir of requestDirs) if (dir.startsWith(`${path}/`)) collapsed.add(dir);
}

function ensureSelectedRowVisible() {
  const height = treeList.viewport.height;
  if (height <= 0) return;
  if (selectedRow < treeList.scrollTop) treeList.scrollTop = selectedRow;
  else if (selectedRow >= treeList.scrollTop + height) treeList.scrollTop = selectedRow - height + 1;
}

// Shift+J/K jump a quarter of the visible rows, matching the nvim quarter_page.
function pageStep(height: number): number {
  return Math.max(1, Math.floor(height / 4));
}

function renderTree() {
  const queueActive = flowQueue.size > 0;

  treeRowViews = ensureRowViews(treeRowViews, treeRows.length, treeList);

  treeRows.forEach((row, index) => {
    const entry = treeRowViews[index];
    const content = row.type === "folder"
      ? `${"  ".repeat(row.depth)}${collapsed.has(row.path) ? "▸" : "▾"} ${row.name}/`
      : `${"  ".repeat(row.depth + 1)}${requestLabel(row.req)}`;
    const isQueued = row.type === "request" && flowQueue.has(targetKey(row.req, currentVariant(row.req)));
    const rowColor = row.type === "folder" ? C.fg : methodColor(row.req.method);
    const fg = queueActive && !isQueued ? C.muted : rowColor;
    const bg = index === selectedRow ? C.selected : C.bg;
    const key = row.type === "folder" ? `d:${row.path}` : `r:${row.req.name}`;
    paintRowView(entry, { contentKey: content, content, fg, bg, row });
    if (entry.key !== key || entry.index !== index) {
      entry.key = key;
      entry.index = index;
      entry.view.onMouseDown = () => {
        const current = treeRows[index];
        if (!current) return;
        if (appWindow === "requests" && pane !== "list") setPane("list");
        const now = Date.now();
        const doubleClick = lastRowClick.index === index && now - lastRowClick.time < 400;
        lastRowClick = { index, time: now };
        if (current.type === "request" && editorDirty() && editorEntry && current.req.name !== editorEntry.reqName) {
          warnDirty(editorEntry.reqName);
          return;
        }
        if (current.type === "folder") {
          selectedRow = index;
          if (current.path === "") toggleRequestRoot();
          else toggleRequestFolder(current.path);
          refreshList();
          return;
        }
        if (doubleClick) {
          selectedRow = index;
          toggleFlowRequest(current.req);
          refreshList(current.req.name);
          setStatus();
          return;
        }
        selectRequestRow(index);
      };
    }
  });
  ensureSelectedRowVisible();
}

// Moves the selection and repaints only the two affected rows.
function selectRequestRow(index: number) {
  const row = treeRows[index];
  if (!row) return;
  const targetName = row.type === "request" ? row.req.name : null;
  if (editorDirty() && editorEntry && targetName !== editorEntry.reqName) {
    warnDirty(editorEntry.reqName);
    return;
  }
  const previous = selectedRow;
  selectedRow = index;
  const req = currentReq();
  if (req) loadEditorEntry(req);
  const prev = treeRowViews[previous];
  if (prev && previous !== index) { prev.view.bg = C.bg; prev.bg = C.bg; }
  const curr = treeRowViews[index];
  if (curr) { curr.view.bg = C.selected; curr.bg = C.selected; }
  ensureSelectedRowVisible();
}

function refreshList(keepName?: string, touchEditor = true) {
  const previous = currentReq()?.name;
  const q = filterInput.value.toLowerCase();
  const filtered = requests.filter((r) => r.name.toLowerCase().includes(q));
  let dirs = requestDirs;
  if (q) {
    const needed = new Set<string>();
    for (const req of filtered) {
      const parts = req.name.split("/");
      for (let i = 1; i < parts.length; i++) needed.add(parts.slice(0, i).join("/"));
    }
    dirs = requestDirs.filter((dir) => needed.has(dir));
  }
  treeRows = requestTreeRows(filtered, dirs);
  const targetName = keepName ?? previous;
  if (targetName) {
    const idx = treeRows.findIndex((row) => row.type === "request" && row.req.name === targetName);
    if (idx >= 0) selectedRow = idx;
  }
  selectedRow = Math.max(0, Math.min(selectedRow, Math.max(0, treeRows.length - 1)));
  const req = currentReq();
  if (req && touchEditor) loadEditorEntry(req);
  renderTree();
}

function currentTreeRow(): TreeRow | null {
  return treeRows[selectedRow] ?? null;
}

function reloadRequests() {
  hurlFileCache.clear();
  requestDirs.splice(0, requestDirs.length, ...loadRequestDirs());
  requests.splice(0, requests.length, ...loadRequests());
}

function selectRequestByName(name: string, folderPath?: string) {
  refreshList();
  const index = treeRows.findIndex((row) => row.type === "request" ? row.req.name === name : row.type === "folder" && row.path === folderPath);
  if (index >= 0) selectedRow = index;
  renderTree();
}

// Rewrites or drops request step lines inside a flow's raw text, preserving
// comments, blank lines, indentation, and any @variant suffix.
function transformFlowText(text: string, rename: Map<string, string>, remove: Set<string>): { text: string; changed: boolean } {
  const next: string[] = [];
  let changed = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) { next.push(line); continue; }
    const at = trimmed.lastIndexOf("@");
    const base = (at > 0 ? trimmed.slice(0, at) : trimmed).replace(/\.hurl$/, "");
    if (remove.has(base)) { changed = true; continue; }
    const mapped = rename.get(base);
    if (mapped !== undefined) {
      const variant = at > 0 ? trimmed.slice(at) : "";
      const indent = line.slice(0, line.length - line.trimStart().length);
      next.push(`${indent}${mapped}${variant}`);
      changed = true;
    } else {
      next.push(line);
    }
  }
  if (!changed) return { text, changed: false };
  return { text: `${next.join("\n").replace(/\n+$/, "")}\n`, changed: true };
}

// Applies a request rename/delete to every .flow file (and to a loaded dirty
// flow buffer), then reloads the flow list.
function applyFlowReferenceChange(rename: Map<string, string>, remove: Set<string>) {
  if (rename.size === 0 && remove.size === 0) return;
  for (const flow of flows) {
    let src = "";
    try { src = readFileSync(flow.file, "utf8"); } catch { continue; }
    const { text, changed } = transformFlowText(src, rename, remove);
    if (changed) writeFileSync(flow.file, text);
  }
  if (flowLoadedName !== null) {
    const current = flowDetail.plainText;
    const { text, changed } = transformFlowText(current, rename, remove);
    if (changed) {
      flowDetail.setText(text);
      if (flowSavedText === current) flowSavedText = text;
    }
  }
  reloadFlows();
  if (appWindow === "flows") renderFlowList();
}

function remapKeyedMap<T>(map: Map<string, T>, remapKey: (key: string) => string | undefined) {
  const entries = [...map.entries()].map(([key, value]) => [remapKey(key), value] as [string | undefined, T]);
  map.clear();
  for (const [key, value] of entries) if (key !== undefined) map.set(key, value);
}

// Keeps in-memory references (queue, variant pick, last results, open editor)
// in sync with a request rename or delete.
function remapRequestReferences(rename: Map<string, string>, remove: Set<string>) {
  const remapKey = (key: string): string | undefined => {
    const at = key.lastIndexOf("@");
    const base = at > 0 ? key.slice(0, at) : key;
    if (remove.has(base)) return undefined;
    const mapped = rename.get(base);
    return (mapped ?? base) + (at > 0 ? key.slice(at) : "");
  };
  const queue = [...flowQueue.entries()].map(([key, order]) => [remapKey(key), order] as [string | undefined, number]);
  flowQueue.clear();
  for (const [key, order] of queue) if (key !== undefined) flowQueue.set(key, order);
  for (const [name, value] of [...activeVariant.entries()]) {
    if (remove.has(name)) activeVariant.delete(name);
    else if (rename.has(name)) { activeVariant.delete(name); activeVariant.set(rename.get(name)!, value); }
  }
  remapKeyedMap(lastResult, remapKey);
  remapKeyedMap(lastBodies, remapKey);
  if (editorEntry) {
    if (remove.has(editorEntry.reqName)) editorEntry = null;
    else if (rename.has(editorEntry.reqName)) editorEntry.reqName = rename.get(editorEntry.reqName)!;
  }
  normalizeFlowQueue();
}

function requestsBase(): string {
  return join(COLLECTION, "requests");
}

function createRequestPath(value: string): boolean {
  const parsed = parseNameInput(value, ".hurl");
  if ("error" in parsed) { statusMsg = parsed.error; setStatus(); return false; }
  if (parsed.kind === "dir") {
    const dir = join(requestsBase(), parsed.path);
    if (existsSync(dir)) { statusMsg = `folder ${parsed.path}/ already exists`; setStatus(); return false; }
    mkdirSync(dir, { recursive: true });
    reloadRequests();
    selectRequestByName("", parsed.path);
    statusMsg = `created ${parsed.path}/`;
    setStatus();
    return true;
  }
  const file = join(requestsBase(), `${parsed.path}.hurl`);
  if (existsSync(file)) { statusMsg = `request ${parsed.path} already exists`; setStatus(); return false; }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "# TODO: describe this request\nGET {{host}}/\n");
  reloadRequests();
  refreshList(parsed.path);
  setPane("editor");
  statusMsg = `created ${parsed.path}`;
  setStatus();
  return true;
}

function renameRequestPath(value: string): boolean {
  const row = currentTreeRow();
  if (!row) return false;
  if (row.type === "folder" && row.path === "") { statusMsg = "cannot rename the root"; setStatus(); return false; }
  const touchesDirty = editorDirty() && editorEntry && (row.type === "request" ? row.req.name === editorEntry.reqName : editorEntry.reqName.startsWith(`${row.path}/`));
  if (touchesDirty) { warnDirty(editorEntry!.reqName); return false; }
  const parsed = parseNameInput(value, ".hurl");
  if ("error" in parsed) { statusMsg = parsed.error; setStatus(); return false; }
  if (row.type === "folder") {
    if (parsed.path === row.path) return false;
    const target = join(requestsBase(), parsed.path);
    if (existsSync(target)) { statusMsg = `folder ${parsed.path}/ already exists`; setStatus(); return false; }
    const mapping = new Map<string, string>();
    for (const req of requests) {
      if (req.name.startsWith(`${row.path}/`)) mapping.set(req.name, `${parsed.path}${req.name.slice(row.path.length)}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(requestsBase(), row.path), target);
    applyFlowReferenceChange(mapping, new Set());
    reloadRequests();
    remapRequestReferences(mapping, new Set());
    selectRequestByName("", parsed.path);
    statusMsg = `renamed ${row.path}/ to ${parsed.path}/`;
    setStatus();
    return true;
  }
  const req = row.req;
  if (parsed.path === req.name) return false;
  const target = join(requestsBase(), `${parsed.path}.hurl`);
  if (existsSync(target)) { statusMsg = `request ${parsed.path} already exists`; setStatus(); return false; }
  mkdirSync(dirname(target), { recursive: true });
  renameSync(req.file, target);
  const mapping = new Map([[req.name, parsed.path]]);
  applyFlowReferenceChange(mapping, new Set());
  reloadRequests();
  remapRequestReferences(mapping, new Set());
  refreshList(parsed.path);
  statusMsg = `renamed ${req.name} to ${parsed.path}`;
  setStatus();
  return true;
}

function deleteRequestPath() {
  const row = currentTreeRow();
  if (!row) return;
  if (row.type === "folder" && row.path === "") { statusMsg = "cannot delete the root"; setStatus(); return; }
  if (row.type === "folder") {
    if (editorDirty() && editorEntry && editorEntry.reqName.startsWith(`${row.path}/`)) {
      warnDirty(editorEntry.reqName);
      return;
    }
    const names = new Set(requests.filter((req) => req.name.startsWith(`${row.path}/`)).map((req) => req.name));
    applyFlowReferenceChange(new Map(), names);
    rmSync(join(requestsBase(), row.path), { recursive: true, force: true });
    reloadRequests();
    remapRequestReferences(new Map(), names);
    refreshList();
    statusMsg = `deleted ${row.path}/`;
    setStatus();
    return;
  }
  const req = row.req;
  if (editorDirty() && editorEntry && editorEntry.reqName === req.name) { warnDirty(editorEntry.reqName); return; }
  applyFlowReferenceChange(new Map(), new Set([req.name]));
  rmSync(req.file, { force: true });
  reloadRequests();
  remapRequestReferences(new Map(), new Set([req.name]));
  refreshList();
  statusMsg = `deleted ${req.name}`;
  setStatus();
}

function showRequestNameInput(purpose: NamePurpose, prefill = "") {
  pendingDelete = null;
  requestNamePurpose = purpose;
  requestNameInput.value = prefill;
  requestNameInput.visible = true;
  requestNameInput.focus();
  setStatus();
}

function hideRequestNameInput() {
  requestNameInput.visible = false;
  requestNameInput.blur();
  setStatus();
}

function requestNameInputFocused(): boolean {
  return (requestNameInput as any).focused === true;
}

function submitRequestName(value: string) {
  return requestNamePurpose === "rename" ? renameRequestPath(value) : createRequestPath(value);
}

// Prefill for `a` in the Requests tab: inside the selected folder, or the
// selected request's parent directory, so the new file is a sibling.
function requestCreatePrefill(): string {
  const row = currentTreeRow();
  if (!row) return "";
  if (row.type === "folder") return row.path ? `${row.path}/` : "";
  const at = row.req.name.lastIndexOf("/");
  return at > 0 ? row.req.name.slice(0, at + 1) : "";
}

function showRequestRenameInput() {
  const row = currentTreeRow();
  if (!row) return;
  if (row.type === "folder" && row.path === "") { statusMsg = "cannot rename the root"; setStatus(); return; }
  showRequestNameInput("rename", row.type === "folder" ? row.path : row.req.name);
}

// Arms a delete and asks for confirmation; the next key decides.
function requestDelete(label: string, confirm: () => void) {
  pendingDelete = { label, confirm };
  statusMsg = `delete ${label}? (y/N)`;
  setStatus();
}

function requestDeleteSelection() {
  const row = currentTreeRow();
  if (!row) return;
  if (row.type === "folder" && row.path === "") { statusMsg = "cannot delete the root"; setStatus(); return; }
  requestDelete(row.type === "folder" ? `${row.path}/` : row.req.name, () => deleteRequestPath());
}

function flowDeleteSelection() {
  const row = currentFlowRow();
  if (!row) return;
  if (row.type === "folder" && row.path === "") { statusMsg = "cannot delete the root"; setStatus(); return; }
  requestDelete(row.type === "folder" ? `flows/${row.path}/` : `flows/${row.flow.name}`, () => deleteFlowPath());
}

function watchCollection() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    watch(COLLECTION, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        pending = null;
        charSearch = null;
        envVariablesCache.clear();
        hurlFileCache.clear();
        flowCache.clear();
        requests.splice(0, requests.length, ...loadRequests());
        requestDirs.splice(0, requestDirs.length, ...loadRequestDirs());
        flows.splice(0, flows.length, ...loadFlows());
        flowDirs.splice(0, flowDirs.length, ...loadFlowDirs());
        refreshList(undefined, appWindow === "requests" && !insert && !editorDirty());
        if (appWindow === "flows") {
          flowRows = buildFlowTree();
          selectedFlowRow = Math.max(0, Math.min(selectedFlowRow, Math.max(0, flowRows.length - 1)));
          renderFlowList();
          if (!flowDirty()) loadFlowFile();
        }
      }, 150);
    });
  } catch {}
}

function applyTextareaColors(target: TextareaRenderable) {
  target.backgroundColor = C.bg;
  target.textColor = C.fg;
  target.focusedBackgroundColor = C.bg;
  target.focusedTextColor = C.fg;
}

function refreshPaneBorders() {
  listBox.borderColor = appWindow === "requests" && pane === "list" ? C.yellow : C.dim;
  editorBox.borderColor = appWindow === "requests" && pane === "editor" ? C.yellow : C.dim;
  responseBox.borderColor = appWindow === "requests" && pane === "response" ? C.yellow : C.dim;
  historyListBox.borderColor = appWindow === "history" && historyPane === "list" ? C.yellow : C.dim;
  historyDetailBox.borderColor = appWindow === "history" && historyPane === "detail" ? C.yellow : C.dim;
  envListBox.borderColor = appWindow === "environments" && envPane === "list" ? C.yellow : C.dim;
  envDetailBox.borderColor = appWindow === "environments" && envPane === "editor" ? C.yellow : C.dim;
  flowListBox.borderColor = appWindow === "flows" && flowPane === "list" ? C.yellow : C.dim;
  flowDetailBox.borderColor = appWindow === "flows" && flowPane === "editor" ? C.yellow : C.dim;
  flowResponseBox.borderColor = appWindow === "flows" && flowPane === "response" ? C.yellow : C.dim;
}

function applyPalette() {
  Object.assign(C, resolvePalette(CONFIG));
  paletteGeneration++;
  renderer.setBackgroundColor(C.bg);
  tabBar.bg = C.panel;
  statusBar.bg = C.panel;
  variantStrip.backgroundColor = C.panel;
  for (const { line } of commandLines) { line.fg = C.fg; line.bg = C.panel; }
  editorGutter.fg = C.dim;
  editorGutter.bg = C.bg;
  envDetailGutter.fg = C.dim;
  envDetailGutter.bg = C.bg;
  flowDetailGutter.fg = C.dim;
  flowDetailGutter.bg = C.bg;
  filterInput.textColor = C.fg;
  flowFilterInput.textColor = C.fg;
  requestNameInput.textColor = C.fg;
  flowNameInput.textColor = C.fg;
  helpOverlay.borderColor = C.yellow;
  helpText.textColor = C.fg;
  helpLegend.bg = C.bg;
  if (helpVisible) { helpLegend.content = renderHelpLegend(); helpLegend.visible = helpContext() === "list"; }
  flowPicker.borderColor = C.yellow;
  flowPickerText.fg = C.fg;
  flowPickerText.bg = C.bg;
  const backgroundBoxes = [
    listBox, treeList, editorBox, responseBox,
    historyWindow, historyListBox, historyList, historyDetailBox,
    envWindow, envListBox, envList, envDetailBox,
    flowWindow, flowListBox, flowList, flowDetailBox, flowResponseBox,
    helpBackdrop, helpOverlay,
    flowPickerBackdrop, flowPicker,
    verticalDivider, horizontalDivider, historyDivider, environmentDivider, flowDivider, flowHorizontalDivider,
  ];
  for (const box of backgroundBoxes) box.backgroundColor = C.bg;
  for (const textarea of [editor, respView, historyDetail, envDetail, flowDetail, flowRespView]) applyTextareaColors(textarea);
  refreshPaneBorders();
  variableSyntax = buildVariableSyntax();
  responseFailureSyntax = buildResponseFailureSyntax();
  refreshEditorHighlights();
  if (lastResponse) applyResponseHighlights(respView, lastResponse.text, lastResponse.failed);
  if (lastFlowResponse) applyResponseHighlights(flowRespView, lastFlowResponse.text, lastFlowResponse.failed);
  renderTree();
  renderEnvironments();
  renderFlowList();
  if (historyGroups.length > 0) renderHistory();
  renderVariantStrip(currentReq());
  if (visual && visualTarget) updateVisualSelection(visualTarget);
  setStatus();
}

function watchOmarchyTheme() {
  if (CONFIG.theme !== "system" || process.platform !== "linux") return;
  const themeDir = dirname(OMARCHY_COLORS_FILE);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let themeWatcher: ReturnType<typeof watch> | null = null;
  const watchThemeDir = () => {
    try { themeWatcher?.close(); } catch {}
    try {
      themeWatcher = watch(themeDir, (_event, filename) => {
        if (filename && filename !== "colors.toml") return;
        schedule();
      });
      themeWatcher.on("error", () => {});
    } catch {
      themeWatcher = null;
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    // omarchy swaps the whole theme directory via rename, which kills the
    // directory watcher's inode, so re-establish it on every change.
    timer = setTimeout(() => { watchThemeDir(); applyPalette(); }, 150);
  };
  watchThemeDir();
  try {
    const parentWatcher = watch(dirname(themeDir), (_event, filename) => {
      if (filename && filename !== "theme") return;
      schedule();
    });
    parentWatcher.on("error", () => {});
  } catch {}
}

function moveSelection(delta: number) {
  if (treeRows.length === 0) return;
  const next = Math.max(0, Math.min(treeRows.length - 1, selectedRow + delta));
  selectRequestRow(next);
}

function activateSelection() {
  const row = treeRows[selectedRow];
  if (!row) return;
  if (row.type === "folder") {
    if (row.path === "") toggleRequestRoot();
    else toggleRequestFolder(row.path);
    refreshList();
    return;
  }
  void runRequest(row.req);
}

function syncModeTitles() {
  editorBox.title = requestTitle(insert, visual && visualTarget === editor);
  responseBox.title = visual && visualTarget === respView ? " RESPONSE (VISUAL) " : " RESPONSE ";
  historyDetailBox.title = visual && visualTarget === historyDetail ? " RUN DETAILS (VISUAL) " : " RUN DETAILS ";
  if (envPane === "editor" || envInsert) {
    envDetailBox.title = envTitle(envInsert ? "insert" : visual && visualTarget === envDetail ? "visual" : "editor");
  }
  flowDetailBox.title = flowTitle(flowInsert ? "insert" : visual && visualTarget === flowDetail ? "visual" : flowPane === "editor" ? "editor" : "list");
}

function clearVisual() {
  if (visualTarget) visualTarget.clearSelection();
  visual = false;
  visualKind = null;
  visualTarget = null;
  charSearch = null;
  pending = null;
  syncModeTitles();
}

function yankNativeSelection(target: TextareaRenderable): boolean {
  const selection = renderer.getSelection();
  const text = target.hasSelection() ? target.getSelectedText() : selection?.getSelectedText();
  if (!text) return false;
  register = text;
  target.clearSelection();
  statusMsg = `yanked selection (${copyToClipboard(renderer, text)})`;
  return true;
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

const gutterState = new WeakMap<TextRenderable, { width: number; content: string }>();

function renderGutter(target: TextareaRenderable, gutter: TextRenderable) {
  const view = target.editorView;
  const viewport = view.getViewport();
  const height = Math.min(viewport.height, gutter.height);
  if (height <= 0) return;
  const sources = view.getLogicalLineInfo().lineSources;
  const digits = String(Math.max(1, target.editBuffer.getLineCount())).length;
  const width = digits + 2;
  const rows: string[] = [];
  let prevLogical = -1;
  for (let i = 0; i < height; i++) {
    const logical = sources[viewport.offsetY + i];
    if (logical === undefined) {
      rows.push(` ${"~".padEnd(digits)} `);
      prevLogical = -1;
    } else if (logical === prevLogical) {
      rows.push(" ".repeat(width));
    } else {
      prevLogical = logical;
      rows.push(` ${String(logical + 1).padStart(digits)} `);
    }
  }
  const content = rows.join("\n");
  const state = gutterState.get(gutter) ?? { width: 0, content: "" };
  if (state.width !== width) { gutter.width = width; state.width = width; }
  if (state.content !== content) { gutter.content = content; state.content = content; }
  gutterState.set(gutter, state);
}

function refreshGutters() {
  renderGutter(editor, editorGutter);
  renderGutter(envDetail, envDetailGutter);
  renderGutter(flowDetail, flowDetailGutter);
}

function modeLabel(): string {
  if (appWindow === "history") return historyPane === "detail" ? (visual ? "VISUAL" : "RUN-DETAILS") : "HISTORY";
  if (appWindow === "environments") return envInsert ? "ENV-INSERT" : envPane === "editor" ? (visual ? "ENV-VISUAL" : "ENV-NORMAL") : "ENVIRONMENTS";
  if (appWindow === "flows") return flowInsert ? "FLOW-INSERT" : flowPane === "editor" ? (visual ? "FLOW-VISUAL" : "FLOW-NORMAL") : flowPane === "response" ? (visual ? "FLOW-VISUAL" : "FLOW-RESPONSE") : "FLOWS";
  if (pane === "editor") return insert ? "INSERT" : visual ? "REQ-VISUAL" : "REQ-NORMAL";
  if (pane === "response" && visual) return "VISUAL";
  return pane.toUpperCase();
}

function setStatus() {
  renderTabs();
  refreshGutters();
  renderCommandLine();
  const dirtyInfos = dirtyBufferInfos();
  statusBar.fg = dirtyInfos.length > 0 ? C.yellow : C.fg;
  const mode = modeLabel();
  const last = [...lastResult.entries()].slice(-1)[0];
  const windowLabel =
    appWindow === "requests" ? "1 REQUESTS"
      : appWindow === "flows" ? "2 FLOWS"
        : appWindow === "history" ? "3 HISTORY"
          : "4 ENVIRONMENTS";
  statusBar.content =
    ` ${windowLabel} · ${mode}` +
    (dirtyInfos.length > 0 ? ` ${dirtyBufferLabel(dirtyInfos)}` : "") +
    ` · env: ${environments[environmentIdx]} · queued: ${flowQueue.size}` +
    (last ? ` · last: ${last[0]} ${last[1] === "ok" ? "✓" : "✗"}` : "") +
    (statusMsg ? ` · ${statusMsg}` : "") +
    (pending ? ` · ${pending}` : "") +
    (charSearch ? ` · ${charSearch}` : "") +
    "   [?] help";
}

function setPane(p: Pane) {
  clearVisual();
  filterInput.blur();
  commandBuffer = null;
  pendingDelete = null;
  pane = p;
  insert = false;
  pending = null;
  refreshPaneBorders();
  listBox.title = " REQUESTS ";
  editorBox.title = requestTitle();
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
  pendingDelete = null;
  historyPane = next;
  refreshPaneBorders();
  historyDetailBox.title = " RUN DETAILS ";
  if (next === "detail") historyDetail.focus();
  else historyDetail.blur();
  setStatus();
}

function setWindow(next: AppWindow) {
  clearVisual();
  endDividerDrag();
  filterInput.blur();
  flowFilterInput.blur();
  commandBuffer = null;
  pendingDelete = null;
  editor.blur();
  respView.blur();
  historyDetail.blur();
  envInsert = false;
  envDetail.blur();
  flowInsert = false;
  flowDetail.blur();
  flowRespView.blur();
  flowNameInput.visible = false;
  flowNameInput.blur();
  appWindow = next;
  main.visible = next === "requests";
  flowWindow.visible = next === "flows";
  historyWindow.visible = next === "history";
  envWindow.visible = next === "environments";
  if (next === "history") {
    loadHistory();
    historyPane = "list";
    historyDetailBox.title = " RUN DETAILS ";
  } else if (next === "environments") {
    selectedEnvironment = environmentIdx;
    if (envDirty() && envLoadedName && envLoadedName !== environments[environmentIdx]) {
      const idx = environments.indexOf(envLoadedName);
      if (idx >= 0) {
        selectedEnvironment = idx;
        statusMsg = `unsaved changes in .env.${envLoadedName} (:w to save, :q! to discard)`;
      }
    }
    envPane = "list";
    renderEnvironments();
    loadEnvironmentFile();
  } else if (next === "flows") {
    flowRows = buildFlowTree();
    selectedFlowRow = Math.max(0, Math.min(selectedFlowRow, Math.max(0, flowRows.length - 1)));
    flowPane = "list";
    renderFlowList();
    loadFlowFile();
  } else {
    setPane(pane);
  }
  refreshPaneBorders();
  setStatus();
}

function moveHistory(delta: number) {
  if (historyGroups.length === 0) return;
  selectHistoryRow(Math.max(0, Math.min(historyGroups.length - 1, selectedHistory + delta)));
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function formatRequest(r: RunResult): string | undefined {
  if (!r.request) return undefined;
  return `REQUEST\n${r.request.method} ${r.request.url}` +
    (r.request.headers.length ? `\n  headers:\n${indent(indent(r.request.headers.join("\n")))}` : "") +
    (r.request.body ? `\n  body:\n${indent(indent(formatBody(r.request.body)))}` : "");
}

function formatRun(r: RunResult, variant?: string): string {
  const ok = r.success;
  const request = formatRequest(r);
  return `${ok ? "✓" : "✗"} ${r.status} ${ok ? "OK" : "FAILED"} · ${r.ms}ms · env: ${environments[environmentIdx]}${variant ? ` · variant: ${variant}` : ""}\n\n` +
    (request ? `${request}\n\n` : "") +
    `RESPONSE\n` +
    (r.headers.length ? `  headers:\n${indent(indent(r.headers.join("\n")))}\n\n` : "") +
    `  body:\n` +
    (r.body ? indent(indent(formatBody(r.body))) : "    (empty response body)") +
    `\n\nASSERTIONS\n` +
    `  ${r.asserts.passed}/${r.asserts.total} passed · captures: ${r.captures.join(", ") || "-"}\n` +
    (r.error ? `\n  reason:\n${indent(indent(r.error))}` : "");
}

async function runRequest(req: Req) {
  const variant = currentVariant(req);
  const key = targetKey(req, variant);
  statusMsg = `running ${key}`;
  setStatus();
  const [r] = await runHurl([{ req, variant }]);
  lastResult.set(key, r.success ? "ok" : "fail");
  lastBodies.clear();
  if (r.body) lastBodies.set(key, r.body);
  renderResponse(formatRun(r, variant), !r.success);
  refreshEditorHighlights();
  recordHistory({ req, variant }, r);
  refreshList(req.name);
  statusMsg = "";
  focusResponse("requests");
}

function formatFlowResponse(targets: RunTarget[], results: RunResult[], label: string): string {
  const parts = targets.map((target, index) => {
    const r = results[index] ?? emptyRunResult("Hurl did not return a result for this step");
    const key = targetKey(target.req, target.variant);
    lastResult.set(key, r.success ? "ok" : "fail");
    if (r.body) lastBodies.set(key, r.body);
    return `▸ ${index + 1}. ${key}\n${formatRun(r, target.variant)}`;
  });
  return `${label} (env: ${environments[environmentIdx]}), ${targets.length} requests\n\n` + parts.join(`\n\n${"─".repeat(60)}\n\n`);
}

async function runFlowTargets(targets: RunTarget[], label: string, surface: RunSurface = "requests", flowName?: string) {
  statusMsg = `running flow (${targets.length} requests)`;
  setStatus();
  const results = await runHurl(targets);
  lastBodies.clear();
  const flowId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  targets.forEach((target, index) => {
    const r = results[index] ?? emptyRunResult("Hurl did not return a result for this step");
    recordHistory(target, r, { flowId, step: index + 1, flowSize: targets.length, flow: flowName, queued: !flowName });
  });
  const text = formatFlowResponse(targets, results, label);
  const failed = results.some((result) => !result.success);
  if (surface === "flows") renderFlowResponse(text, failed);
  else renderResponse(text, failed);
  refreshEditorHighlights();
  refreshList(currentReq()?.name);
  statusMsg = "";
  focusResponse(surface);
}

async function runFlow() {
  const targets = [...flowQueue.entries()]
    .sort(([, a], [, b]) => a - b)
    .map(([key]) => resolveKey(key))
    .filter((target): target is RunTarget => target !== undefined);
  if (targets.length === 0) {
    statusMsg = "mark requests first";
    setStatus();
    return;
  }
  await runFlowTargets(targets, "flow");
}

async function runNamedFlow(flow: Flow, surface: RunSurface = "requests") {
  const resolved = resolveFlow(flow);
  if (resolved.error) {
    statusMsg = resolved.error;
    setStatus();
    return;
  }
  await runFlowTargets(resolved.targets ?? [], `flow ${flow.name}`, surface, flow.name);
}

function enterInsert() {
  insert = true;
  pending = null;
  charSearch = null;
  syncModeTitles();
  setStatus();
}

function leaveInsert() {
  insert = false;
  pending = null;
  charSearch = null;
  syncModeTitles();
  setStatus();
}

function updateVisualSelection(target: TextareaRenderable) {
  const eb = target.editBuffer;
  target.selectionBg = RGBA.fromHex(C.active);
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
  charSearch = null;
  visual = true;
  visualKind = kind;
  visualTarget = target;
  const cursor = target.editBuffer.getCursorPosition();
  visualAnchor = cursor.row;
  visualAnchorOffset = target.editBuffer.positionToOffset(cursor.row, cursor.col);
  updateVisualSelection(target);
  syncModeTitles();
  setStatus();
}

// Resolves a pending `f`/`F`/`t`/`T` against the keypress that carries the
// target character. Searches stay inside the current line, matching vim's
// line-scoped char search, so `0f=lD` and `T=D` work on a KEY=value entry.
function applyCharSearch(target: TextareaRenderable, key: KeyEvent): boolean {
  if (!charSearch) return false;
  const motion = charSearch;
  charSearch = null;
  const seq = key.sequence;
  if (key.name === "escape" || !seq || seq.length !== 1 || key.ctrl || key.meta || key.option) return true;
  const eb = target.editBuffer;
  const { row, col } = eb.getCursorPosition();
  const start = eb.getLineStartOffset(row);
  const end = row + 1 < eb.getLineCount() ? eb.getLineStartOffset(row + 1) : target.plainText.length;
  const line = eb.getTextRange(start, end).replace(/\n$/, "");
  const forward = motion === "f" || motion === "t";
  const index = forward ? line.indexOf(seq, col + 1) : col > 0 ? line.lastIndexOf(seq, col - 1) : -1;
  if (index < 0) return true;
  let targetCol = index;
  if (motion === "t") targetCol = index - 1;
  else if (motion === "T") targetCol = index + 1;
  targetCol = Math.max(0, Math.min(targetCol, Math.max(0, line.length - 1)));
  eb.setCursor(row, targetCol);
  return true;
}

// Toggles `#` comments across a row range, mirroring the nvim `<leader>/`
// binding. All-or-nothing: uncomment only when every line is already
// commented, otherwise comment. Blank lines get `# ` so the range stays even.
// The whole range is written back with one `replaceText` so a single `u`
// restores it, and the cursor/anchor columns are remapped so visual mode
// survives the edit instead of being dropped.
function toggleComment(target: TextareaRenderable, startRow: number, endRow: number) {
  const eb = target.editBuffer;
  const lineCount = eb.getLineCount();
  const first = Math.max(0, Math.min(startRow, lineCount - 1));
  const last = Math.max(first, Math.min(endRow, lineCount - 1));
  const oldText = target.plainText;
  const lineStart = (row: number) => eb.getLineStartOffset(row);
  const startOffset = lineStart(first);
  const endOffset = last + 1 < lineCount ? lineStart(last + 1) : oldText.length;
  const lines = oldText.slice(startOffset, endOffset).split("\n");
  const rowOf = (i: number) => first + i;
  let allCommented = true;
  for (let i = 0; i < lines.length; i++) {
    if (rowOf(i) > last) break;
    if (!/^\s*#/.test(lines[i])) { allCommented = false; break; }
  }
  const deltas: { indent: number; change: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (rowOf(i) > last) { deltas.push({ indent: 0, change: 0 }); continue; }
    const line = lines[i];
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (allCommented) {
      const rest = line.slice(indent);
      const remove = rest.startsWith("# ") ? 2 : 1;
      lines[i] = line.slice(0, indent) + rest.slice(remove);
      deltas.push({ indent, change: -remove });
    } else if (/^\s*#/.test(line)) {
      deltas.push({ indent, change: 0 });
    } else {
      lines[i] = line.slice(0, indent) + "# " + line.slice(indent);
      deltas.push({ indent, change: 2 });
    }
  }
  const newText = oldText.slice(0, startOffset) + lines.join("\n") + oldText.slice(endOffset);
  const cursor = eb.getCursorPosition();
  const anchorCol = visualAnchorOffset - lineStart(visualAnchor);
  eb.replaceText(newText);
  if (visual && visualTarget === target) {
    const newLineLen = (row: number) => (row >= first && row <= last ? lines[row - first].length : 0);
    const mapCol = (row: number, col: number) => {
      if (row < first || row > last) return col;
      const delta = deltas[row - first];
      if (delta.change > 0) return col >= delta.indent ? col + delta.change : col;
      if (delta.change < 0) return col > delta.indent ? Math.max(delta.indent, col + delta.change) : col;
      return col;
    };
    eb.setCursor(cursor.row, Math.min(mapCol(cursor.row, cursor.col), newLineLen(cursor.row)));
    visualAnchorOffset = eb.getLineStartOffset(visualAnchor) + Math.min(mapCol(visualAnchor, anchorCol), newLineLen(visualAnchor));
    updateVisualSelection(target);
  } else {
    const col = lines[0].search(/\S/);
    eb.setCursor(first, col < 0 ? 0 : col);
  }
  ensureCursorVisible(target);
}

function applyVimMotion(target: TextareaRenderable, k: string, key: KeyEvent): boolean {
  const eb = target.editBuffer;
  const shift = key.shift;
  // shift+JK jump a quarter viewport, matching the nvim config's quarter_page.
  const jumpLines = (direction: 1 | -1) => {
    const step = Math.max(1, Math.floor(target.editorView.getViewport().height / 4));
    for (let i = 0; i < step; i++) {
      if (direction > 0) eb.moveCursorDown();
      else eb.moveCursorUp();
    }
  };
  const firstNonBlank = () => {
    const row = eb.getCursorPosition().row;
    const start = eb.getLineStartOffset(row);
    const end = row + 1 < eb.getLineCount() ? eb.getLineStartOffset(row + 1) : target.plainText.length;
    const match = eb.getTextRange(start, end).search(/\S/);
    eb.setCursor(row, match < 0 ? 0 : match);
  };
  if (k === "J" || (k === "j" && shift)) jumpLines(1);
  else if (k === "K" || (k === "k" && shift)) jumpLines(-1);
  else if (k === "H" || (k === "h" && shift)) firstNonBlank();
  else if (k === "L" || (k === "l" && shift)) { const e = eb.getEOL(); eb.setCursor(e.row, Math.max(0, e.col - 1)); }
  else if (k === "h") eb.moveCursorLeft();
  else if (k === "l") eb.moveCursorRight();
  else if (k === "j") eb.moveCursorDown();
  else if (k === "k") eb.moveCursorUp();
  else if (k === "w") { const c = eb.getNextWordBoundary(); eb.setCursor(c.row, c.col); }
  else if (k === "b") { const c = eb.getPrevWordBoundary(); eb.setCursor(c.row, c.col); }
  else if (k === "f" || k === "F" || k === "t" || k === "T") charSearch = shift ? k.toUpperCase() : k;
  else if (k === "0") eb.setCursor(eb.getCursorPosition().row, 0);
  else if (k === "$" || (k === "4" && shift)) { const e = eb.getEOL(); eb.setCursor(e.row, Math.max(0, e.col - 1)); }
  else if (k === "G" || (k === "g" && shift)) eb.gotoLine(eb.getLineCount() - 1);
  else return false;
  return true;
}

function moveVisual(target: TextareaRenderable, k: string, key: KeyEvent, readOnly = false): boolean {
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
    } else if (p === "space" && k === "/" && !readOnly) {
      const row = eb.getCursorPosition().row;
      toggleComment(target, Math.min(visualAnchor, row), Math.max(visualAnchor, row));
    }
    setStatus();
    return true;
  }
  if (applyVimMotion(target, k, key)) {
    ensureCursorVisible(target);
    updateVisualSelection(target);
    setStatus();
    return true;
  }
  if (k === "g") {
    pending = "g";
    setStatus();
    return true;
  } else if (!readOnly && k === "space") {
    pending = "space";
    setStatus();
    return true;
  } else if (k === "y") {
    register = target.getSelectedText();
    statusMsg = `yanked selection (${copyToClipboard(renderer, register)})`;
    clearVisual();
    setStatus();
    return true;
  }
  return false;
}

function vimNormal(k: string, key: KeyEvent, target: TextareaRenderable = editor, readOnly = false, editKind: "request" | "environment" | "flow" = "request") {
  const eb = target.editBuffer;
  const shift = key.shift;
  const startInsert = () => editKind === "environment" ? enterEnvInsert() : editKind === "flow" ? enterFlowInsert() : enterInsert();
  const yankLine = () => {
    const { row } = eb.getCursorPosition();
    const start = eb.getLineStartOffset(row);
    const nextLineStart = row + 1 < eb.getLineCount() ? eb.getLineStartOffset(row + 1) : target.plainText.length;
    const line = target.plainText.slice(start, nextLineStart).replace(/\n$/, "");
    register = line;
    statusMsg = `yanked line (${copyToClipboard(renderer, line)})`;
  };

  if (charSearch) {
    applyCharSearch(target, key);
    if (visual && visualTarget === target) updateVisualSelection(target);
    ensureCursorVisible(target);
    setStatus();
    return;
  }

  if (visual && visualTarget === target) {
    moveVisual(target, k, key, readOnly);
    return;
  }

  if (!pending && k === "y" && !key.shift && yankNativeSelection(target)) {
    setStatus();
    return;
  }

  if (pending) {
    const p = pending;
    pending = null;
    if (p === "g" && k === "g") { eb.setCursor(0, 0); ensureCursorVisible(target); }
    else if (p === "space" && k === "/" && !readOnly) { const { row } = eb.getCursorPosition(); toggleComment(target, row, row); }
    else if (p === "y" && k === "y" && !shift) yankLine();
    else if (!readOnly && p === "d" && k === "d" && !shift) {
      const { row } = eb.getCursorPosition();
      register = eb.getTextRange(eb.getLineStartOffset(row), eb.getLineStartOffset(row + 1));
      eb.deleteLine();
    } else if (!readOnly && p === "c" && k === "c" && !shift) {
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
  else if (!applyVimMotion(target, k, key)) {
    if (k === "g" || (!readOnly && k === "space") || (!shift && (k === "y" || (!readOnly && (k === "d" || k === "c"))))) pending = k;
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
  }
  ensureCursorVisible(target);
  setStatus();
}

function saveEditor() {
  const req = currentReq();
  if (!req || !editorEntry || editorEntry.reqName !== req.name) return;
  let src = "";
  try { src = readFileSync(req.file, "utf8"); } catch { return; }
  const entries = parseEntries(src);
  const entry = editorEntry.variant ? entries.find((candidate) => candidate.name === editorEntry!.variant) : entries[0];
  if (!entry) {
    statusMsg = `variant "${editorEntry.variant}" no longer exists in ${req.name}`;
    setStatus();
    return;
  }
  const text = editor.plainText.replace(/\n+$/, "");
  const tail = src.slice(entry.end);
  const next = src.slice(0, entry.start) + text + (tail ? "\n\n" : "\n") + tail;
  writeFileSync(req.file, next);
  editorSavedText = editor.plainText;
  syncModeTitles();
  statusMsg = `saved ${targetKey(req, editorEntry.variant)}`;
  setStatus();
  setTimeout(() => { statusMsg = ""; setStatus(); }, 2000);
}

function enterCommandLine() {
  commandBuffer = "";
  pending = null;
  charSearch = null;
  setStatus();
}

type ParsedCommand = { write: boolean; quit: boolean; all: boolean; force: boolean };

function parseCommandLine(c: string): ParsedCommand | null {
  const match = c.match(/^([wqxa]+)(!)?$/);
  if (!match) return null;
  const letters = match[1];
  if (/(.).*\1/.test(letters)) return null;
  const write = letters.includes("w") || letters.includes("x");
  const quit = letters.includes("q") || letters.includes("x");
  const all = letters.includes("a");
  if (all && !write && !quit) return null;
  return { write, quit, all, force: Boolean(match[2]) };
}

function runCommandLine(cmd: string) {
  const c = cmd.trim();
  if (c === "") return;
  if (c === "flows") {
    showFlowPicker();
    return;
  }
  const saveFlow = c.match(/^saveflow(!)?\s+(.+)$/);
  if (saveFlow) {
    statusMsg = saveCurrentQueue(saveFlow[2], Boolean(saveFlow[1]));
    setStatus();
    return;
  }
  const addStep = c.match(/^add\s+(.+)$/);
  if (addStep) {
    appendStepToFlow(addStep[1].trim());
    return;
  }
  const newFlow = c.match(/^newflow\s+(.+)$/);
  if (newFlow) {
    if (appWindow === "flows") createFlowPath(newFlow[1]);
    else statusMsg = "switch to the Flows tab (2) to create a flow";
    setStatus();
    return;
  }
  const rename = c.match(/^(?:rename|mv)\s+(.+)$/);
  if (rename) {
    if (appWindow === "flows") renameFlowPath(rename[1]);
    else renameRequestPath(rename[1]);
    return;
  }
  const parsed = parseCommandLine(c);
  if (!parsed) {
    statusMsg = `not an editor command: ${c}`;
    setStatus();
    return;
  }
  const { write, quit, all, force } = parsed;
  const inEnvWindow = appWindow === "environments";
  const inEnvEditor = inEnvWindow && envPane === "editor";
  const inFlowWindow = appWindow === "flows";
  const inFlowEditor = inFlowWindow && flowPane === "editor";
  const inReqEditor = appWindow === "requests" && pane === "editor";
  if (all) {
    if (write) {
      if (editorDirty()) saveEditor();
      if (envDirty()) saveEnvironmentFile();
      if (flowDirty()) saveFlowFile();
    }
    if (quit) {
      quitApp(force);
    }
    return;
  }
  if (write && !quit) {
    if (inEnvWindow) saveEnvironmentFile();
    else if (inFlowWindow) saveFlowFile();
    else saveEditor();
    return;
  }
  if (write && quit) {
    if (inEnvEditor) {
      saveEnvironmentFile();
      setEnvPane("list");
    } else if (inFlowEditor) {
      saveFlowFile();
      setFlowPane("list");
    } else if (inReqEditor) {
      saveEditor();
      setPane("list");
    } else {
      if (inEnvWindow) saveEnvironmentFile();
      else if (inFlowWindow) saveFlowFile();
      else saveEditor();
      quitApp(force);
    }
    return;
  }
  if (inEnvEditor) {
    if (envDirty() && !force) {
      statusMsg = "no write since last change (add ! to override)";
      setStatus();
      return;
    }
    if (envDirty()) loadEnvironmentFile(true);
    setEnvPane("list");
    return;
  }
  if (inFlowEditor) {
    if (flowDirty() && !force) {
      statusMsg = "no write since last change (add ! to override)";
      setStatus();
      return;
    }
    if (flowDirty()) loadFlowFile(true);
    setFlowPane("list");
    return;
  }
  if (inReqEditor) {
    if (editorDirty() && !force) {
      statusMsg = "no write since last change (add ! to override)";
      setStatus();
      return;
    }
    const req = currentReq();
    if (editorDirty() && req) loadEditorEntry(req, true);
    setPane("list");
    return;
  }
  quitApp(force);
}

const VIM_MOVE: [string, string][] = [
  ["hjkl / w / b", "move / word forward / back"],
  ["J / K", "quarter page down / up"],
  ["H / L", "first non-blank / line end"],
  ["0 / $", "start / end of line"],
  ["f / t / F / T", "find / till a character"],
  ["gg / G", "top / bottom"],
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
  ["space /", "toggle comment (line / selection)"],
  ["u / ctrl-r", "undo / redo"],
];

const PANE_HELP: Record<string, [string, string][]> = {
  list: [
    ["j / k", "move down / up"],
    ["J / K", "quarter page down / up"],
    ["gg / G", "jump to top / bottom"],
    ["/", "filter"],
    ["enter", "run queue / request / toggle folder"],
    ["l", "toggle folder / open request pane"],
    ["shift-l", "expand/collapse all subfolders"],
    ["ctrl-g / :flows", "run a saved flow"],
    ["tab", "queue/unqueue for flow"],
    ["shift-tab", "clear queue"],
    [":saveflow <name>", "save queue as a flow"],
    ["v / ]", "next variant"],
    ["[", "previous variant"],
    ["i / ctrl-l", "open request pane"],
    ["a", "new request/folder"],
    ["r", "rename request/folder"],
    ["d", "delete request/folder (asks to confirm)"],
    ["y", "copy as hurl"],
    ["Y", "copy as curl"],
    ["alt+hjkl / alt-0", "resize panes / reset"],
    ["q", "quit"],
  ],
  editor: [
    ...VIM_MOVE,
    ...VIM_EDIT,
    ["[ / ]", "previous / next variant"],
    ["tab / shift-tab", "next / previous variant"],
    ["ctrl-s / :w", "save"],
    [":wq / :x", "save and close pane"],
    [":q / :q!", "close pane (bang discards changes)"],
    [":wa / :qa / :wqa", "save all / quit all / save all and quit"],
    ["ctrl-l / ctrl-h", "next pane (response) / prev pane (list)"],
    ["alt+hjkl / alt-0", "resize panes / reset"],
    ["esc", "leave insert / cancel visual / back to list"],
  ],
  response: [
    ...VIM_MOVE,
    ["v / V", "visual char / line"],
    ["yy / Y", "yank line / yank all"],
    ["c", "copy mouse selection"],
    ["s", "save body to file"],
    ["alt+hjkl / alt-0", "resize panes / reset"],
    ["ctrl-h", "back to request pane"],
    ["esc", "cancel visual"],
  ],
  "history-list": [
    ["j / k", "move"],
    ["J / K", "quarter page down / up"],
    ["g / G", "jump to top / bottom"],
    ["enter / l / ctrl-l", "open details"],
    ["y", "copy all"],
    ["alt+hl / alt-0", "resize sidebar / reset"],
    ["esc", "back to requests"],
    ["q", "quit"],
  ],
  "history-detail": [
    ...VIM_MOVE,
    ["v / V", "visual char / line"],
    ["y", "yank selection"],
    ["alt+hl / alt-0", "resize sidebar / reset"],
    ["yy / Y", "yank line / yank all"],
    ["ctrl-h / esc", "back to list"],
  ],
  "env-list": [
    ["j / k", "move"],
    ["J / K", "quarter page down / up"],
    ["enter", "activate environment"],
    ["l / ctrl-l", "open file for editing"],
    ["i", "open file and insert"],
    ["ctrl-r", "reveal/mask secrets"],
    ["alt+hl / alt-0", "resize sidebar / reset"],
    ["esc / 1", "back to requests"],
    ["q", "quit"],
  ],
  "env-editor": [
    ...VIM_MOVE,
    ...VIM_EDIT,
    ["ctrl-s / :w", "save"],
    [":wq / :x", "save and close pane"],
    [":q / :q!", "close pane (bang discards changes)"],
    [":wa / :qa / :wqa", "save all / quit all / save all and quit"],
    ["alt+hl / alt-0", "resize sidebar / reset"],
    ["ctrl-h", "back to list"],
    ["esc", "leave insert / cancel visual / back to list"],
  ],
  "flows-list": [
    ["j / k", "move"],
    ["J / K", "quarter page down / up"],
    ["g / G", "jump to top / bottom"],
    ["/", "filter"],
    ["enter / l", "run flow / toggle folder"],
    ["shift-l", "expand/collapse all subfolders"],
    ["ctrl-f / shift-enter", "run flow"],
    ["i / ctrl-l", "open flow editor"],
    ["a", "new flow/folder"],
    ["r", "rename flow/folder"],
    ["d", "delete flow/folder (asks to confirm)"],
    ["ctrl-g", "flow picker"],
    ["alt+hl / alt-0", "resize sidebar / reset"],
    ["esc", "back to requests"],
    ["q", "quit"],
  ],
  "flows-editor": [
    ...VIM_MOVE,
    ...VIM_EDIT,
    ["ctrl-a", "append selected request as a step"],
    [":add <request>", "append a step by name"],
    ["ctrl-s / :w", "save"],
    [":wq / :x", "save and close pane"],
    [":q / :q!", "close pane (bang discards changes)"],
    ["ctrl-f / shift-enter", "run flow"],
    ["ctrl-l", "response pane"],
    ["ctrl-h", "back to list"],
    ["esc", "leave insert / cancel visual / back to list"],
  ],
  "flows-response": [
    ...VIM_MOVE,
    ["v / V", "visual char / line"],
    ["yy / Y", "yank line / yank all"],
    ["s", "save bodies to file"],
    ["ctrl-h", "back to flow editor"],
    ["esc", "back to list"],
  ],
};

function formatHelp(context: string): string {
  const rows = PANE_HELP[context];
  const width = Math.max(...rows.map(([key]) => key.length));
  return rows.map(([key, desc]) => `${key.padEnd(width)} : ${desc}`).join("\n");
}

function renderHelpLegend(): StyledText {
  const base = fg(C.dim);
  const sep = base("  ");
  return t`${base("methods:  ")}${fg(C.green)("GET")}${sep}${fg(C.blue)("POST")}${sep}${fg(C.yellow)("PUT")}${sep}${fg(C.magenta)("PATCH")}${sep}${fg(C.red)("DELETE")}${sep}${fg(C.orange)("HEAD")}${sep}${fg(C.fg)("OPTIONS")}`;
}

function helpContext(): keyof typeof PANE_HELP {
  if (appWindow === "history") return historyPane === "detail" ? "history-detail" : "history-list";
  if (appWindow === "environments") return envPane === "editor" ? "env-editor" : "env-list";
  if (appWindow === "flows") return flowPane === "editor" ? "flows-editor" : flowPane === "response" ? "flows-response" : "flows-list";
  if (pane === "editor") return "editor";
  if (pane === "response") return "response";
  return "list";
}

let helpVisible = false;
function hideHelp() {
  helpVisible = false;
  helpBackdrop.visible = false;
  helpOverlay.visible = false;
}
function showHelp() {
  pendingDelete = null;
  pending = null;
  charSearch = null;
  helpVisible = true;
  helpLegend.content = renderHelpLegend();
  helpLegend.visible = helpContext() === "list";
  helpText.setText(formatHelp(helpContext()));
  helpBackdrop.visible = true;
  helpOverlay.visible = true;
}

function handleInputShortcut(key: KeyEvent, k: string) {
  if (insert) {
    if (key.ctrl && k === "s") { saveEditor(); key.preventDefault(); }
    else if (key.ctrl && k === "l") { setPane("response"); key.preventDefault(); }
    else if (key.ctrl && k === "h") { setPane("list"); key.preventDefault(); }
    else if (k === "escape") { leaveInsert(); key.preventDefault(); }
  } else if (envInsert) {
    if (key.ctrl && k === "s") { saveEnvironmentFile(); key.preventDefault(); }
    else if (key.ctrl && k === "h") { leaveEnvInsert(); setEnvPane("list"); key.preventDefault(); }
    else if (k === "escape") { leaveEnvInsert(); key.preventDefault(); }
  } else if (flowInsert) {
    if (key.ctrl && k === "s") { saveFlowFile(); key.preventDefault(); }
    else if (key.ctrl && k === "h") { leaveFlowInsert(); setFlowPane("list"); key.preventDefault(); }
    else if (k === "escape") { leaveFlowInsert(); key.preventDefault(); }
  }
}

renderer.keyInput.on("keypress", (key: KeyEvent) => {
  const k = key.name;
  if (flowPickerVisible) {
    if (k === "escape" || k === "q") hideFlowPicker();
    else if (k === "j" || k === "down") { flowPickerIndex = Math.min(flowPickerIndex + 1, Math.max(0, flows.length - 1)); renderFlowPicker(); }
    else if (k === "k" || k === "up") { flowPickerIndex = Math.max(0, flowPickerIndex - 1); renderFlowPicker(); }
    else if (k === "g") { flowPickerIndex = 0; renderFlowPicker(); }
    else if (k === "G") { flowPickerIndex = Math.max(0, flows.length - 1); renderFlowPicker(); }
    else if (k === "enter" || k === "return") {
      const flow = flows[flowPickerIndex];
      const surface: RunSurface = appWindow === "flows" ? "flows" : "requests";
      hideFlowPicker();
      if (flow) void runNamedFlow(flow, surface);
    }
    key.preventDefault();
    return;
  }
  if (helpVisible) { hideHelp(); setStatus(); key.preventDefault(); return; }
  if (filterInputFocused() && k === "escape") { filterInput.blur(); setPane("list"); key.preventDefault(); return; }
  if (flowFilterInputFocused() && k === "escape") { flowFilterInput.blur(); setFlowPane("list"); key.preventDefault(); return; }
  if (commandBuffer !== null) {
    if (k === "escape") { commandBuffer = null; setStatus(); }
    else if (k === "return" || k === "enter") { const cmd = commandBuffer; commandBuffer = null; runCommandLine(cmd); setStatus(); }
    else if (k === "backspace") { commandBuffer = commandBuffer.slice(0, -1); setStatus(); }
    else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta && !key.option) { commandBuffer += key.sequence; setStatus(); }
    key.preventDefault();
    return;
  }
  // Insert-style modes let the focused widget consume keys; only a few shortcuts are
  // intercepted. Every other key falls through to the single preventDefault below.
  if (flowNameInputFocused() || requestNameInputFocused()) {
    const isFlow = flowNameInputFocused();
    const input = isFlow ? flowNameInput : requestNameInput;
    if (k === "escape") {
      isFlow ? hideFlowNameInput() : hideRequestNameInput();
      key.preventDefault();
    } else if (k === "return" || k === "enter") {
      const value = input.value;
      isFlow ? hideFlowNameInput() : hideRequestNameInput();
      if (value.trim()) { isFlow ? submitFlowName(value) : submitRequestName(value); }
      key.preventDefault();
    }
    return;
  }
  if (pendingDelete) {
    const pending = pendingDelete;
    pendingDelete = null;
    if (k === "y" || k === "Y") pending.confirm();
    else { statusMsg = "delete cancelled"; setStatus(); }
    key.preventDefault();
    return;
  }
  if (k === "?" && !insert && !envInsert && !flowInsert && !filterInputFocused() && !flowFilterInputFocused()) { showHelp(); key.preventDefault(); return; }

  if (insert || envInsert || flowInsert || filterInputFocused() || flowFilterInputFocused()) { handleInputShortcut(key, k); return; }
  key.preventDefault();

  if (!visual && !pending) {
    if (k === "1") { setWindow("requests"); return; }
    if (k === "2") { setWindow("flows"); return; }
    if (k === "3") { setWindow("history"); return; }
    if (k === "4") { setWindow("environments"); return; }
  }

  if ((key.meta || key.option) && !visual && !pending) {
    if (appWindow === "requests") {
      if (k === "h") setSplits(sidebarSplit - 3, editorSplit);
      else if (k === "l") setSplits(sidebarSplit + 3, editorSplit);
      else if (k === "k") setSplits(sidebarSplit, editorSplit - 3);
      else if (k === "j") setSplits(sidebarSplit, editorSplit + 3);
      else if (k === "0") setSplits(33, 55);
      else return;
      statusMsg = `splits: ${sidebarSplit}% sidebar, ${editorSplit}% editor`;
    } else if (appWindow === "history") {
      if (k === "h") setFixedSidebarSplit(historySplit - 3, historyWindow, historyListBox);
      else if (k === "l") setFixedSidebarSplit(historySplit + 3, historyWindow, historyListBox);
      else if (k === "0") setFixedSidebarSplit(44, historyWindow, historyListBox);
      else return;
      statusMsg = `history sidebar: ${historySplit} columns`;
    } else if (appWindow === "flows") {
      if (k === "h") setFixedSidebarSplit(flowSplit - 3, flowWindow, flowListBox);
      else if (k === "l") setFixedSidebarSplit(flowSplit + 3, flowWindow, flowListBox);
      else if (k === "j") setFlowDetailSplit(flowDetailSplit + 3);
      else if (k === "k") setFlowDetailSplit(flowDetailSplit - 3);
      else if (k === "0") { setFixedSidebarSplit(36, flowWindow, flowListBox); setFlowDetailSplit(55); }
      else return;
      statusMsg = `flows sidebar: ${flowSplit} columns, editor: ${flowDetailSplit}%`;
    } else {
      if (k === "h") setFixedSidebarSplit(environmentSplit - 3, envWindow, envListBox);
      else if (k === "l") setFixedSidebarSplit(environmentSplit + 3, envWindow, envListBox);
      else if (k === "0") setFixedSidebarSplit(32, envWindow, envListBox);
      else return;
      statusMsg = `environment sidebar: ${environmentSplit} columns`;
    }
    setStatus();
    return;
  }

  if (appWindow === "environments") {
    if (k === "q") { quitApp(); return; }
    if (envPane === "editor") {
      if (key.ctrl && k === "s") { saveEnvironmentFile(); return; }
      if (key.ctrl && k === "h") { setEnvPane("list"); return; }
      if (visual && k === "escape") { clearVisual(); setStatus(); return; }
      if (k === "escape") { setEnvPane("list"); return; }
      if (!visual && (k === ":" || (k === ";" && key.shift))) { enterCommandLine(); return; }
      vimNormal(k, key, envDetail, false, "environment");
      return;
    }
    if (key.ctrl && k === "l") { setEnvPane("editor"); return; }
    if (k === "l") { setEnvPane("editor"); return; }
    if (k === "escape" || k === "1") { setWindow("requests"); return; }
    if (k === "J" || (k === "j" && key.shift)) { moveEnvironment(pageStep(envList.height)); return; }
    if (k === "K" || (k === "k" && key.shift)) { moveEnvironment(-pageStep(envList.height)); return; }
    if (k === "j") { moveEnvironment(1); return; }
    if (k === "k") { moveEnvironment(-1); return; }
    if (k === "enter" || k === "return") {
      environmentIdx = selectedEnvironment;
      refreshEditorHighlights();
      renderEnvironments();
      statusMsg = `active environment: ${environments[environmentIdx]}`;
      setStatus();
      return;
    }
    if (k === "i") { setEnvPane("editor"); enterEnvInsert(); return; }
    if (k === "r" && key.ctrl) { secretsRevealed = !secretsRevealed; renderEnvironments(); loadEnvironmentFile(); return; }
    return;
  }

  if (appWindow === "flows") {
    if (k === "q") { quitApp(); return; }
    if (flowPane === "editor") {
      if (key.ctrl && k === "s") { saveFlowFile(); return; }
      if (key.ctrl && k === "l") { setFlowPane("response"); return; }
      if (key.ctrl && k === "h") { setFlowPane("list"); return; }
      if (key.ctrl && k === "a") { appendStepToFlow(); return; }
      if (key.ctrl && k === "f") { const flow = currentFlow(); if (flow) void runNamedFlow(flow, "flows"); return; }
      if ((k === "enter" || k === "return") && key.shift) { const flow = currentFlow(); if (flow) void runNamedFlow(flow, "flows"); return; }
      if (visual && k === "escape") { clearVisual(); setStatus(); return; }
      if (k === "escape") { setFlowPane("list"); return; }
      if (!visual && (k === ":" || (k === ";" && key.shift))) { enterCommandLine(); return; }
      vimNormal(k, key, flowDetail, false, "flow");
      return;
    }
    if (flowPane === "response") {
      if (key.ctrl && k === "h") { setFlowPane("editor"); return; }
      if (visual && k === "escape") { clearVisual(); setStatus(); return; }
      if (k === "escape") { setFlowPane("list"); return; }
      if (!visual && (k === ":" || (k === ";" && key.shift))) { enterCommandLine(); return; }
      if (k === "s") { statusMsg = saveLastBodies(); setStatus(); return; }
      vimNormal(k, key, flowRespView, true);
      return;
    }
    if (!visual && (k === ":" || (k === ";" && key.shift))) { enterCommandLine(); return; }
    if (k === "/") { flowFilterInput.focus(); return; }
    if (key.ctrl && k === "l") { setFlowPane("editor"); return; }
    if (k === "L" || (k === "l" && key.shift)) {
      const row = currentFlowRow();
      if (row?.type === "folder") toggleFlowFolder(row.path, true);
      return;
    }
    if (k === "l") {
      const row = currentFlowRow();
      if (row?.type === "folder") toggleFlowFolder(row.path);
      else setFlowPane("editor");
      return;
    }
    if (k === "escape") { setWindow("requests"); return; }
    if (k === "J" || (k === "j" && key.shift)) { moveFlowSelection(pageStep(flowList.height)); return; }
    if (k === "K" || (k === "k" && key.shift)) { moveFlowSelection(-pageStep(flowList.height)); return; }
    if (k === "j") { moveFlowSelection(1); return; }
    if (k === "k") { moveFlowSelection(-1); return; }
    if (k === "g" && !key.shift) { moveFlowSelection(-selectedFlowRow); return; }
    if (k === "G" || (k === "g" && key.shift)) { moveFlowSelection(flowRows.length - 1 - selectedFlowRow); return; }
    if (k === "enter" || k === "return") {
      const row = currentFlowRow();
      if (row?.type === "folder") { toggleFlowFolder(row.path); return; }
      const flow = currentFlow();
      if (flow) void runNamedFlow(flow, "flows");
      return;
    }
    if (key.ctrl && k === "f") { const flow = currentFlow(); if (flow) void runNamedFlow(flow, "flows"); return; }
    if (k === "i") { if (currentFlow()) { setFlowPane("editor"); enterFlowInsert(); } return; }
    if (k === "a") { showFlowNameInput("create", flowCreatePrefill()); return; }
    if (k === "r") { showFlowRenameInput(); return; }
    if (k === "d") { flowDeleteSelection(); return; }
    if (key.ctrl && k === "g") { showFlowPicker(); return; }
    return;
  }

  if (appWindow === "history") {
    if (historyPane === "detail") {
      if (key.ctrl && k === "h") { setHistoryPane("list"); return; }
      if (k === "escape") { setHistoryPane("list"); return; }
      vimNormal(k, key, historyDetail, true);
      return;
    }
    if (k === "q") { quitApp(); return; }
    if (k === "escape") { setWindow("requests"); return; }
    if (k === "J" || (k === "j" && key.shift)) { moveHistory(pageStep(historyList.height)); return; }
    if (k === "K" || (k === "k" && key.shift)) { moveHistory(-pageStep(historyList.height)); return; }
    if (k === "j") { moveHistory(1); return; }
    if (k === "k") { moveHistory(-1); return; }
    if (key.ctrl && k === "l") { setHistoryPane("detail"); return; }
    if (k === "l") { setHistoryPane("detail"); return; }
    if (k === "g") { selectHistoryRow(0); return; }
    if (k === "G") { selectHistoryRow(historyGroups.length - 1); return; }
    if (k === "enter" || k === "return") { setHistoryPane("detail"); return; }
    if (k === "y") {
      statusMsg = `copied history (${copyToClipboard(renderer, historyDetail.plainText)})`;
      setStatus(); return;
    }
    return;
  }

  if (pane === "editor") {
    if (k === "s" && key.ctrl) { saveEditor(); return; }
    if (k === "l" && key.ctrl) { setPane("response"); return; }
    if (k === "h" && key.ctrl) { setPane("list"); return; }
    if (visual && k === "escape") { clearVisual(); setStatus(); return; }
    if (k === "escape") { setPane("list"); return; }
    if (!visual && (k === ":" || (k === ";" && key.shift))) { enterCommandLine(); return; }
    if (!visual && k === "[") { cycleVariant(-1); return; }
    if (!visual && k === "]") { cycleVariant(1); return; }
    if (!visual && k === "tab") { cycleVariant(key.shift ? -1 : 1); return; }
    vimNormal(k, key);
    return;
  }

  if (k === "q" && pane === "list") { quitApp(); return; }
  if (k === "l" && key.ctrl) { setPane(pane === "list" ? "editor" : "response"); return; }
  if (k === "h" && key.ctrl) { setPane(pane === "response" ? "editor" : "list"); return; }
  if (visual && k === "escape") { clearVisual(); setStatus(); return; }
  if (k === "escape") { setPane("list"); return; }

  if (pane === "list") {
    if (k === "/" ) { filterInput.focus(); return; }
    if (pending) {
      const pendingKey = pending;
      pending = null;
      if (pendingKey === "g" && k === "g") {
        selectedRow = 0;
        renderTree();
      }
      return;
    }
    if (k === "J" || (k === "j" && key.shift)) { moveSelection(pageStep(treeList.viewport.height)); return; }
    if (k === "K" || (k === "k" && key.shift)) { moveSelection(-pageStep(treeList.viewport.height)); return; }
    if (k === "j") { moveSelection(1); return; }
    if (k === "k") { moveSelection(-1); return; }
    if (k === "L" || (k === "l" && key.shift)) {
      const row = treeRows[selectedRow];
      if (row?.type === "folder") { toggleRequestSubtree(row.path); refreshList(); }
      return;
    }
    if (k === "l") {
      const row = treeRows[selectedRow];
      if (row?.type === "folder") {
        if (row.path === "") toggleRequestRoot();
        else toggleRequestFolder(row.path);
        refreshList();
      } else if (row) {
        setPane("editor");
      }
      return;
    }
    if (k === "g" && !key.shift) { pending = "g"; setStatus(); return; }
    if (k === "G" || (k === "g" && key.shift)) { selectedRow = Math.max(0, treeRows.length - 1); renderTree(); return; }
    if (k === "enter" || k === "return") {
      if (flowQueue.size > 0) void runFlow();
      else activateSelection();
      return;
    }
    if (k === "tab" && key.shift) { clearQueue(); return; }
    if (k === "tab") {
      const r = currentReq();
      if (r) { toggleFlowRequest(r); refreshList(r.name); setStatus(); }
      return;
    }
    if (k === "g" && key.ctrl) { showFlowPicker(); return; }
    if (k === "i") { setPane("editor"); enterInsert(); return; }
    if (k === "v") { cycleVariant(1); return; }
    if (k === "[") { cycleVariant(-1); return; }
    if (k === "]") { cycleVariant(1); return; }
    if (k === "a") { showRequestNameInput("create", requestCreatePrefill()); return; }
    if (k === "r") { showRequestRenameInput(); return; }
    if (k === "d") { requestDeleteSelection(); return; }
    if (k === "y" && !key.shift) {
      const r = currentReq();
      if (r) {
        const rendered = renderTemplate(entrySource(r, currentVariant(r))).replace(/\n?$/, "\n");
        const cmd = `hurl <<'HURL_EOF'\n${rendered}HURL_EOF`;
        statusMsg = `copied hurl command (${copyToClipboard(renderer, cmd)})`;
      }
      setStatus(); return;
    }
    if (k === "Y" || (k === "y" && key.shift)) {
      const r = currentReq();
      const cmd = r ? renderCurl(renderTemplate(entrySource(r, currentVariant(r)))) : undefined;
      statusMsg = cmd ? `copied curl (${copyToClipboard(renderer, cmd)})` : "couldn't build a curl command for this request";
      setStatus(); return;
    }
  }

  if (pane === "response") {
    if (k === "c") {
      const sel = renderer.getSelection();
      const text = respView.hasSelection() ? respView.getSelectedText() : sel?.getSelectedText();
      statusMsg = text ? `copied selection (${copyToClipboard(renderer, text)})` : "no selection, use v/V or drag with mouse first";
      setStatus(); return;
    }
    if (k === "s") {
      statusMsg = saveLastBodies();
      setStatus(); return;
    }
    vimNormal(k, key, respView, true);
    return;
  }
});

function filterInputFocused() { return (filterInput as any).focused === true; }
filterInput.on("input" as any, () => refreshList());
function flowFilterInputFocused() { return (flowFilterInput as any).focused === true; }
flowFilterInput.on("input" as any, () => { renderFlowList(); if (!flowDirty()) loadFlowFile(); });
editor.onContentChange = () => {
  refreshEditorHighlights();
  syncModeTitles();
  setStatus();
};
envDetail.onContentChange = () => {
  syncModeTitles();
  setStatus();
};
envDetail.onKeyDown = (key) => {
  if (!envInsert) return;
  if (key.ctrl && key.name === "s") {
    saveEnvironmentFile();
    key.preventDefault();
  } else if (key.ctrl && key.name === "h") {
    leaveEnvInsert();
    setEnvPane("list");
    key.preventDefault();
  } else if (key.name === "escape" || key.name === "esc" || key.sequence === "\u001b") {
    leaveEnvInsert();
    key.preventDefault();
  }
};
flowDetail.onContentChange = () => {
  syncModeTitles();
  setStatus();
};
flowDetail.onKeyDown = (key) => {
  if (!flowInsert) return;
  if (key.ctrl && key.name === "s") {
    saveFlowFile();
    key.preventDefault();
  } else if (key.ctrl && key.name === "h") {
    leaveFlowInsert();
    setFlowPane("list");
    key.preventDefault();
  } else if (key.name === "escape" || key.name === "esc") {
    leaveFlowInsert();
    key.preventDefault();
  }
};

loadHistory();
refreshList(requests[0]?.name);
renderFlowList();
if (requests.length === 0) statusMsg = `no .hurl files found in ${COLLECTION}`;
setStatus();
setWindow("requests");
setPane("list");
watchCollection();
watchOmarchyTheme();
let snapEditorHeight = true;
let snapFlowDetailHeight = true;
renderer.on("frame" as any, () => {
  if (snapEditorHeight && editorBox.height > 0) {
    snapEditorHeight = false;
    editorBox.height = Math.round(editorBox.height);
  }
  if (snapFlowDetailHeight && flowDetailBox.height > 0) {
    snapFlowDetailHeight = false;
    flowDetailBox.height = Math.round(flowDetailBox.height);
  }
  refreshGutters();
  renderCommandLine();
  if (appWindow === "history" && Math.floor(historyList.width) !== historyRenderedWidth) renderHistory();
});
renderer.on("resize" as any, () => {
  editorBox.height = `${editorSplit}%`;
  snapEditorHeight = true;
  flowDetailBox.height = `${flowDetailSplit}%`;
  snapFlowDetailHeight = true;
  refreshGutters();
  renderCommandLine();
});
renderer.on("blur" as any, () => endDividerDrag());
renderer.start();
