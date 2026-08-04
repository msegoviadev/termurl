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
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";

const COLLECTION = new URL("./collection", import.meta.url).pathname;
const HISTORY_FILE = join(COLLECTION, ".termurl/history.jsonl");
const PROFILE_FILE = join(COLLECTION, "termurl.toml");

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
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? (e === ".termurl" ? [] : walk(p)) : e.endsWith(".hurl") ? [p] : [];
  });
}

function loadRequests(): Req[] {
  return walk(COLLECTION)
    .map((file) => {
      const src = readFileSync(file, "utf8");
      const name = relative(COLLECTION, file).replace(/\.hurl$/, "");
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
  body: string;
  headers: string[];
  error?: string;
};

type HurlJson = {
  success?: boolean;
  time?: number;
  entries?: Array<{
    asserts?: Array<{ success?: boolean; message?: string }>;
    calls?: Array<{
      response?: { status?: number; headers?: Array<{ name: string; value: string }> };
      timings?: { total?: number };
    }>;
    time?: number;
  }>;
};

function profileVariables(profile: string): Record<string, string> {
  const config = readFileSync(PROFILE_FILE, "utf8");
  const variables: Record<string, string> = {};
  const lines = config.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => line.trim() === `[profiles.${profile}]`);
  if (sectionStart < 0) return variables;
  for (const line of lines.slice(sectionStart + 1)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/);
    if (match) variables[match[1]] = match[2] ?? match[3] ?? match[4];
  }
  return variables;
}

function profileNames(): string[] {
  const config = readFileSync(PROFILE_FILE, "utf8");
  const names = [...config.matchAll(/^\[profiles\.([^\]]+)\]$/gm)].map((match) => match[1]);
  return names.length ? names : ["dev"];
}

function addResponseOutput(source: string, outputFile: string): string {
  const responseIndex = source.search(/^HTTP\s+/m);
  if (responseIndex < 0) return source;
  const prefix = source.slice(0, responseIndex);
  const bodyMatch = prefix.match(/^\s*(?:\{|<|```|`|base64,|hex,|file,)/m);
  const insertionIndex = bodyMatch?.index ?? responseIndex;
  const optionsIndex = prefix.search(/^\[Options\]\s*$/m);
  if (optionsIndex >= 0 && optionsIndex < insertionIndex) {
    const lineEnd = prefix.indexOf("\n", optionsIndex);
    const insertAt = lineEnd < 0 ? insertionIndex : lineEnd + 1;
    return `${source.slice(0, insertAt)}output: ${outputFile}\n${source.slice(insertAt)}`;
  }
  return `${source.slice(0, insertionIndex)}[Options]\noutput: ${outputFile}\n${source.slice(insertionIndex)}`;
}

function emptyRunResult(error: string): RunResult {
  return { success: false, status: 0, ms: 0, asserts: { passed: 0, total: 0 }, captures: [], headers: [], body: "", error };
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

async function runHurl(requestsToRun: Req[]): Promise<RunResult[]> {
  const tempDir = mkdtempSync(join(tmpdir(), "termurl-run-"));
  const hurlFile = join(tempDir, "run.hurl");
  const outputFiles = requestsToRun.map((_, index) => `response-${index + 1}.body`);
  const source = requestsToRun
    .map((req, index) => addResponseOutput(readFileSync(req.file, "utf8"), outputFiles[index]))
    .join("\n\n");
  writeFileSync(hurlFile, source);

  const args = ["hurl", "--json", "--no-color", "--error-format", "long", "--file-root", tempDir];
  for (const [name, value] of Object.entries(profileVariables(profiles[profileIdx]))) {
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
      const failedAsserts = asserts.filter((assert) => !assert.success).map((assert) => assert.message).filter(Boolean);
      const bodyPath = join(tempDir, outputFiles[index]);
      let body = "";
      try { body = readFileSync(bodyPath, "utf8"); } catch {}
      const status = call?.response?.status ?? 0;
      const error = failedAsserts.join("\n\n") || (!call ? normalizeHurlError(processError) : undefined);
      return {
        success: Boolean(entry && status > 0 && failedAsserts.length === 0),
        status,
        ms: Math.round(duration),
        asserts: { passed: asserts.filter((assert) => assert.success).length, total: asserts.length },
        captures: captureNames(req),
        headers: call?.response?.headers?.map((header) => `${header.name}: ${header.value}`) ?? [],
        body,
        ...(error ? { error } : {}),
      };
    });
  } catch (error) {
    return requestsToRun.map(() => emptyRunResult(error instanceof Error ? error.message : String(error)));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

const requests = loadRequests();
const flowQueue = new Map<string, number>();
const lastResult = new Map<string, "ok" | "fail">();
const profiles = profileNames();
let profileIdx = 0;
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
let profileInsert = false;
type ProfilePane = "list" | "editor";
let profilePane: ProfilePane = "list";
type AppWindow = "workspace" | "history" | "profiles";
let appWindow: AppWindow = "workspace";

type HistoryRecord = {
  ts: string;
  request: string;
  profile: string;
  status: number;
  success?: boolean;
  duration_ms: number;
  flow_id?: string;
  step?: number;
  flow_size?: number;
  captures?: string[];
  response?: string;
  error?: string;
};

type HistoryGroup = {
  key: string;
  flow: boolean;
  ts: string;
  profile: string;
  steps: HistoryRecord[];
};

let historyGroups: HistoryGroup[] = [];
let selectedHistory = 0;
let selectedProfile = 0;

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
} as any);
root.add(tabBar);

const main = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1 });
root.add(main);

const listBox = new BoxRenderable(renderer, {
  width: 36, border: true, borderStyle: "single", title: " REQUESTS ", flexDirection: "column",
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

const rightCol = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1 });
main.add(rightCol);

const editorBox = new BoxRenderable(renderer, {
  height: "55%", border: true, borderStyle: "single", title: " REQUEST ", borderColor: C.dim, backgroundColor: C.bg,
});
rightCol.add(editorBox);

const editor = new TextareaRenderable(renderer, {
  initialValue: requests[0] ? readFileSync(requests[0].file, "utf8") : "",
  backgroundColor: C.bg, textColor: C.fg,
});
editorBox.add(editor);

const responseBox = new BoxRenderable(renderer, {
  flexGrow: 1, border: true, borderStyle: "single", title: " RESPONSE ", borderColor: C.dim, backgroundColor: C.bg,
});
rightCol.add(responseBox);

const respView = new TextareaRenderable(renderer, {
  backgroundColor: C.bg,
  textColor: C.fg,
  selectable: true,
});
respView.setText("run a request with enter");
respView.onKeyDown = (key) => key.preventDefault();
respView.onPaste = (event) => event.preventDefault();
responseBox.add(respView);

const statusBar = new TextRenderable(renderer, { content: "", height: 1, backgroundColor: "#24283b" } as any);

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
});
historyDetailBox.add(historyDetail);
historyWindow.visible = false;

const profileWindow = new BoxRenderable(renderer, {
  flexDirection: "row",
  flexGrow: 1,
  backgroundColor: C.bg,
});
root.add(profileWindow);

const profileListBox = new BoxRenderable(renderer, {
  width: 32,
  border: true,
  borderStyle: "single",
  title: " PROFILES ",
  borderColor: C.dim,
  backgroundColor: C.bg,
  flexDirection: "column",
});
profileWindow.add(profileListBox);

const profileList = new BoxRenderable(renderer, {
  flexGrow: 1,
  flexDirection: "column",
  backgroundColor: C.bg,
});
profileListBox.add(profileList);

const profileDetailBox = new BoxRenderable(renderer, {
  flexGrow: 1,
  border: true,
  borderStyle: "single",
  title: " PROFILE (termurl.toml) ",
  borderColor: C.dim,
  backgroundColor: C.bg,
});
profileWindow.add(profileDetailBox);

const profileDetail = new TextareaRenderable(renderer, {
  backgroundColor: C.bg,
  textColor: C.fg,
});
profileDetailBox.add(profileDetail);
profileWindow.visible = false;
root.add(statusBar);

function currentReq(): Req | null {
  const row = treeRows[selectedRow];
  return row?.type === "request" ? row.req : null;
}

type VariableSource = "profile" | "environment" | "capture" | "unresolved";

const variableSyntax = SyntaxStyle.fromStyles({
  profile: { fg: C.green },
  environment: { fg: C.yellow },
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

function variableSource(name: string, req: Req | null = currentReq(), profile = profiles[profileIdx]): VariableSource {
  if (availableCaptures(req).has(name)) return "capture";
  if (profileVariables(profile)[name] !== undefined) return "profile";
  if (Bun.env[`HURL_VARIABLE_${name}`] !== undefined) return "environment";
  return "unresolved";
}

function renderTabs() {
  const tab = (key: string, label: string, active: boolean) => active ? `[${key} ${label}]` : ` ${key} ${label} `;
  tabBar.content = ` ${tab("1", "Workspace", appWindow === "workspace")} ${tab("2", "History", appWindow === "history")} ${tab("3", "Profiles", appWindow === "profiles")}    profile: ${profiles[profileIdx]}`;
}

function renderProfiles() {
  for (const child of profileList.getChildren()) {
    profileList.remove(child);
    child.destroy();
  }
  profiles.forEach((profile, index) => {
    const active = index === profileIdx;
    const selected = index === selectedProfile;
    profileList.add(new TextRenderable(renderer, {
      content: `${selected ? ">" : " "} ${profile}${active ? "  (active)" : ""}`,
      width: "100%",
      height: 1,
      fg: active ? C.green : C.fg,
      bg: selected ? "#292e42" : C.bg,
      truncate: true,
    }));
  });
}

function loadProfileFile() {
  profileDetail.setText(readFileSync(PROFILE_FILE, "utf8"));
}

function saveProfileFile() {
  writeFileSync(PROFILE_FILE, profileDetail.plainText);
  refreshEditorHighlights();
  statusMsg = "saved termurl.toml";
  setStatus();
  setTimeout(() => { statusMsg = ""; setStatus(); }, 2000);
}

function enterProfileInsert() {
  profileInsert = true;
  profileDetailBox.title = " PROFILE (INSERT · ctrl-s save · esc normal) ";
  profileDetail.focus();
  setStatus();
}

function leaveProfileInsert() {
  profileInsert = false;
  profilePane = "editor";
  profileDetailBox.title = " PROFILE (i edit · ctrl-s save · esc list) ";
  profileDetail.focus();
  setStatus();
}

function setProfilePane(next: ProfilePane) {
  clearVisual();
  pending = null;
  profileInsert = false;
  profilePane = next;
  profileListBox.borderColor = next === "list" ? C.yellow : C.dim;
  profileDetailBox.borderColor = next === "editor" ? C.yellow : C.dim;
  profileDetailBox.title = next === "editor" ? " PROFILE (i edit · ctrl-s save · esc list) " : " PROFILE (termurl.toml) ";
  if (next === "editor") profileDetail.focus();
  else profileDetail.blur();
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
    `${group.flow ? "FLOW" : "REQUEST"} · ${group.profile}`,
    `started: ${group.ts}`,
    `duration: ${duration}ms · status: ${historyStatus(group)}`,
    "",
  ];
  for (const [index, step] of group.steps.entries()) {
    lines.push(`${index + 1}. ${step.request} · ${step.status} · ${step.duration_ms}ms`);
    if (step.error && !step.response?.includes("reason:")) lines.push("reason:", step.error);
    if (step.captures?.length) lines.push(`   captures: ${step.captures.join(", ")}`);
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
    historyList.add(new TextRenderable(renderer, {
      content: historyTitle(group),
      width: "100%",
      height: 1,
      fg: index === selectedHistory ? C.fg : C.dim,
      bg: index === selectedHistory ? "#292e42" : C.bg,
      truncate: true,
    }));
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
        profile: record.profile,
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
    profile: profiles[profileIdx],
    status: result.status,
    success: result.success,
    duration_ms: result.ms,
    captures: result.captures,
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
    treeList.add(new TextRenderable(renderer, {
      content,
      width: "100%",
      height: 1,
      fg: row.type === "folder" ? C.cyan : C.fg,
      bg: selected ? "#292e42" : C.bg,
      truncate: true,
    }));
  });
}

function refreshList(keepName?: string) {
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
  if (req) {
    editor.setText(readFileSync(req.file, "utf8"));
    refreshEditorHighlights();
  }
  renderTree();
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

function setStatus() {
  const mode = appWindow === "history" ? "HISTORY" : appWindow === "profiles" ? (profileInsert ? "PROFILE-INSERT" : profilePane === "editor" ? "PROFILE-NORMAL" : "PROFILES") : pane === "editor"
    ? (insert ? "INSERT" : visual ? "REQ-VISUAL" : "REQ-NORMAL")
    : pane === "response" && visual ? "VISUAL" : pane.toUpperCase();
  const last = [...lastResult.entries()].slice(-1)[0];
  renderTabs();
  statusBar.content =
    ` ${appWindow === "workspace" ? "1 WORKSPACE" : appWindow === "history" ? "2 HISTORY" : "3 PROFILES"} · ${mode} · profile: ${profiles[profileIdx]} · queued: ${flowQueue.size}` +
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
  listBox.title = p === "list" ? " REQUESTS (focused) " : " REQUESTS ";
  editorBox.title = p === "editor" ? " REQUEST (i edit · ctrl-s save · esc list) " : " REQUEST ";
  responseBox.title = p === "response" ? " RESPONSE (hjkl · v/V select · y copy) " : " RESPONSE ";
  if (p === "editor") editor.focus();
  else editor.blur();
  if (p === "response") respView.focus();
  else respView.blur();
  setStatus();
}

function setWindow(next: AppWindow) {
  clearVisual();
  filterInput.blur();
  editor.blur();
  respView.blur();
  profileInsert = false;
  profileDetail.blur();
  appWindow = next;
  main.visible = next === "workspace";
  historyWindow.visible = next === "history";
  profileWindow.visible = next === "profiles";
  if (next === "history") {
    loadHistory();
    historyListBox.borderColor = C.yellow;
    historyDetailBox.borderColor = C.dim;
    profileListBox.borderColor = C.dim;
    profileDetailBox.borderColor = C.dim;
  } else if (next === "profiles") {
    selectedProfile = profileIdx;
    renderProfiles();
    loadProfileFile();
    profilePane = "list";
    profileDetailBox.title = " PROFILE (termurl.toml) ";
    historyListBox.borderColor = C.dim;
    historyDetailBox.borderColor = C.dim;
    profileListBox.borderColor = C.yellow;
    profileDetailBox.borderColor = C.dim;
  } else {
    historyListBox.borderColor = C.dim;
    historyDetailBox.borderColor = C.dim;
    profileListBox.borderColor = C.dim;
    profileDetailBox.borderColor = C.dim;
    setPane(pane);
  }
  setStatus();
}

function moveHistory(delta: number) {
  if (historyGroups.length === 0) return;
  selectedHistory = Math.max(0, Math.min(historyGroups.length - 1, selectedHistory + delta));
  renderHistory();
}

function formatRun(req: Req, r: RunResult): string {
  const ok = r.success;
  return `${ok ? "✓" : "✗"} ${r.status} ${ok ? "OK" : "FAILED"} · ${r.ms}ms · profile: ${profiles[profileIdx]}\n` +
    `asserts: ${r.asserts.passed}/${r.asserts.total} passed · captures: ${r.captures.join(", ") || "-"}\n\n` +
    (r.headers.length ? `headers:\n${r.headers.join("\n")}\n\n` : "") +
    (r.error ? `reason:\n${r.error}\n\n` : "") +
    (r.body || "(empty response body)");
}

async function runRequest(req: Req) {
  statusMsg = `running ${req.name}`;
  setStatus();
  const [r] = await runHurl([req]);
  lastResult.set(req.name, r.success ? "ok" : "fail");
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
  const flowId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const parts = targets.map((req, index) => {
    const r = results[index] ?? emptyRunResult("Hurl did not return a result for this step");
    lastResult.set(req.name, r.success ? "ok" : "fail");
    const response = formatRun(req, r);
    recordHistory(req, r, flowId, index + 1, targets.length);
    return `▸ ${index + 1}. ${req.name}\n${response}`;
  });
  renderResponse(`flow (profile: ${profiles[profileIdx]}), ${targets.length} requests\n\n` + parts.join("\n\n"), results.some((result) => !result.success));
  refreshEditorHighlights();
  refreshList(currentReq()?.name);
  statusMsg = "";
  setStatus();
}

function enterInsert(title = " REQUEST (INSERT · esc normal) ") {
  insert = true;
  pending = null;
  editorBox.title = title;
  setStatus();
}

function leaveInsert() {
  insert = false;
  pending = null;
  editorBox.title = " REQUEST (i edit · ctrl-s save · esc list) ";
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
  updateVisualSelection(target);
  setStatus();
  return true;
}

function vimNormal(k: string, key: KeyEvent, target: TextareaRenderable = editor, readOnly = false, editKind: "request" | "profile" = "request") {
  const eb = target.editBuffer;
  const shift = key.shift;
  const startInsert = () => editKind === "profile" ? enterProfileInsert() : enterInsert();
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
    if (p === "g" && k === "g") eb.setCursor(0, 0);
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
  else if (!readOnly && k === "r" && key.ctrl) eb.redo();
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

const HELP = `termurl keys
  windows: 1 workspace · 2 history · 3 profiles (NORMAL mode)
  list:  j/k move · ctrl-d/u page · / filter · enter run/collapse · tab queue/unqueue
         ctrl-enter flow · ctrl-f flow
         e request pane · i edit now · ctrl-n new · ctrl-x delete · ctrl-p profile · q quit
  panes: ctrl-l next (list -> request -> response) · ctrl-h prev · esc back to list
  req:   NORMAL hjkl/w/b/g/G move · v/V visual · i insert · INSERT esc normal · ctrl-s save
  resp:  NORMAL hjkl/w/b/g/G · v/V visual · yy line · Y all · c copy mouse selection
  hist:  j/k move · enter inspect · y copy details · 1 workspace · q quit
   prof:  j/k move · enter activate · ctrl-l/e termurl.toml · ctrl-h/esc list · i insert when focused · ctrl-s save · q quit`;

let helpOn = false;
renderer.keyInput.on("keypress", (key: KeyEvent) => {
  const k = key.name;
  if (helpOn) { helpOn = false; respView.setText(""); setStatus(); key.preventDefault(); return; }

  if (!insert && !profileInsert && !visual && !pending && !listPending && !filterInputFocused()) {
    if (k === "1") { setWindow("workspace"); key.preventDefault(); return; }
    if (k === "2") { setWindow("history"); key.preventDefault(); return; }
    if (k === "3") { setWindow("profiles"); key.preventDefault(); return; }
  }

  if (appWindow === "profiles") {
    if (profileInsert) {
      if (k === "s" && key.ctrl) { saveProfileFile(); key.preventDefault(); return; }
      if (k === "h" && key.ctrl) { leaveProfileInsert(); setProfilePane("list"); key.preventDefault(); return; }
      if (k === "escape") {
        leaveProfileInsert();
        key.preventDefault(); return;
      }
      return;
    }
    if (k === "q") { renderer.destroy(); process.exit(0); }
    if (profilePane === "editor") {
      if (key.ctrl && k === "s") { saveProfileFile(); key.preventDefault(); return; }
      if (key.ctrl && k === "h") { setProfilePane("list"); key.preventDefault(); return; }
      if (k === "escape") { setProfilePane("list"); key.preventDefault(); return; }
      vimNormal(k, key, profileDetail, false, "profile");
      key.preventDefault(); return;
    }
    if (key.ctrl && k === "l") { setProfilePane("editor"); key.preventDefault(); return; }
    if (k === "escape" || k === "1") { setWindow("workspace"); key.preventDefault(); return; }
    if (k === "j") { selectedProfile = Math.min(profiles.length - 1, selectedProfile + 1); renderProfiles(); key.preventDefault(); return; }
    if (k === "k") { selectedProfile = Math.max(0, selectedProfile - 1); renderProfiles(); key.preventDefault(); return; }
    if (k === "enter" || k === "return") {
      profileIdx = selectedProfile;
      refreshEditorHighlights();
      renderProfiles();
      statusMsg = `active profile: ${profiles[profileIdx]}`;
      setStatus();
      key.preventDefault(); return;
    }
    if (k === "e") {
      setProfilePane("editor");
      key.preventDefault(); return;
    }
    if (k === "i") {
      setProfilePane("editor");
      key.preventDefault(); return;
    }
    if (k === "?") { profileDetail.setText(HELP); key.preventDefault(); return; }
    key.preventDefault();
    return;
  }

  if (appWindow === "history") {
    if (k === "q") { renderer.destroy(); process.exit(0); }
    if (k === "escape") { setWindow("workspace"); key.preventDefault(); return; }
    if (k === "j") { moveHistory(1); key.preventDefault(); return; }
    if (k === "k") { moveHistory(-1); key.preventDefault(); return; }
    if (key.ctrl && k === "d") { moveHistory(5); key.preventDefault(); return; }
    if (key.ctrl && k === "u") { moveHistory(-5); key.preventDefault(); return; }
    if (k === "g") { selectedHistory = 0; renderHistory(); key.preventDefault(); return; }
    if (k === "G") { selectedHistory = Math.max(0, historyGroups.length - 1); renderHistory(); key.preventDefault(); return; }
    if (k === "enter" || k === "return") { statusMsg = "history entry selected"; setStatus(); key.preventDefault(); return; }
    if (k === "y") {
      statusMsg = `copied history (${copyToClipboard(renderer, historyDetail.plainText)})`;
      setStatus(); key.preventDefault(); return;
    }
    if (k === "?") { historyDetail.setText(HELP); key.preventDefault(); return; }
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
  if (k === "?" && pane === "list") { helpOn = true; respView.setText(HELP); key.preventDefault(); return; }
  if (k === "l" && key.ctrl) { setPane(pane === "list" ? "editor" : "response"); key.preventDefault(); return; }
  if (k === "h" && key.ctrl) { setPane(pane === "response" ? "editor" : "list"); key.preventDefault(); return; }
  if (visual && k === "escape") { clearVisual(); setStatus(); key.preventDefault(); return; }
  if (k === "escape") { setPane("list"); key.preventDefault(); return; }
  if (k === "p" && key.ctrl) {
    profileIdx = (profileIdx + 1) % profiles.length;
    selectedProfile = profileIdx;
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
  }

  if (pane === "response") {
    if (k === "c") {
      const sel = renderer.getSelection();
      const text = respView.hasSelection() ? respView.getSelectedText() : sel?.getSelectedText();
      statusMsg = text ? `copied selection (${copyToClipboard(renderer, text)})` : "no selection, use v/V or drag with mouse first";
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
profileDetail.onKeyDown = (key) => {
  if (!profileInsert) return;
  if (key.ctrl && key.name === "s") {
    saveProfileFile();
    key.preventDefault();
  } else if (key.ctrl && key.name === "h") {
    leaveProfileInsert();
    setProfilePane("list");
    key.preventDefault();
  } else if (key.name === "escape" || key.name === "esc" || key.sequence === "\u001b") {
    leaveProfileInsert();
    key.preventDefault();
  }
};
renderer.keyInput.on("keypress", (key: KeyEvent) => {
  if (filterInputFocused() && key.name === "escape") { filterInput.blur(); setPane("list"); key.preventDefault(); }
});

loadHistory();
refreshList(requests[0]?.name);
setStatus();
setWindow("workspace");
setPane("list");
renderer.start();
