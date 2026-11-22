// mend: one patch tool for every AI edit format. Node 22, stdlib only.
// Implements SPEC.md v1: unified diff, SEARCH/REPLACE, V4A, JSON tool calls,
// 3-tier matching, all-or-nothing application, exact output and exit codes.
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

class ParseErr extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

function isBlank(s: string): boolean {
  return s.trim().length === 0;
}

function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function rtrimWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

interface FileLines {
  lines: string[];
  breakStr: string;
  ends: boolean;
}

function getFileLines(text: string): FileLines {
  if (text === '') return { lines: [], breakStr: '\n', ends: false };
  const firstLf = text.indexOf('\n');
  const breakStr = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(breakStr);
  let ends = false;
  if (text.endsWith(breakStr)) {
    parts.pop();
    ends = true;
  }
  return { lines: parts, breakStr, ends };
}

function linesToText(lines: string[], breakStr: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(breakStr) + (ends ? breakStr : '');
}

function trimTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimTrailing(s);
  return trimBoth(s);
}

function findOccurrences(lines: string[], o: string[], tier: number, minPos = 0, eofOnly = false): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = minPos; i + o.length <= lines.length; i++) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j], tier) !== normLine(o[j], tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierResult {
  tier: number;
  positions: number[];
}

function findTier(lines: string[], o: string[], strict: boolean, minPos = 0, eofOnly = false): TierResult | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = findOccurrences(lines, o, t, minPos, eofOnly);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

interface BodyElem {
  kind: 'context' | 'old' | 'new';
  text: string;
  backslashAfter: boolean;
}

interface NElement {
  text: string;
  isContext: boolean;
  oIndex: number;
}

interface ONPair {
  o: string[];
  n: NElement[];
}

function buildON(elems: BodyElem[]): ONPair {
  const o: string[] = [];
  const n: NElement[] = [];
  let oCounter = 0;
  for (const e of elems) {
    if (e.kind === 'context') {
      const idx = oCounter;
      o.push(e.text);
      oCounter++;
      n.push({ text: e.text, isContext: true, oIndex: idx });
    } else if (e.kind === 'old') {
      o.push(e.text);
      oCounter++;
    } else {
      n.push({ text: e.text, isContext: false, oIndex: -1 });
    }
  }
  return { o, n };
}

function lastContextNewBackslash(elems: BodyElem[]): boolean {
  for (let i = elems.length - 1; i >= 0; i--) {
    if (elems[i].kind === 'context' || elems[i].kind === 'new') return elems[i].backslashAfter;
  }
  return false;
}
function lastPlusBackslash(elems: BodyElem[]): boolean {
  for (let i = elems.length - 1; i >= 0; i--) {
    if (elems[i].kind === 'new') return elems[i].backslashAfter;
  }
  return false;
}

function buildReplacement(
  n: NElement[],
  fileLines: string[],
  pos: number,
  o: string[],
  tier: number,
): string[] {
  const out: string[] = [];
  if (tier === 2) {
    const f = leadingWs(fileLines[pos]);
    const p = o.length > 0 ? leadingWs(o[0]) : '';
    for (const el of n) {
      if (el.isContext) {
        out.push(fileLines[pos + el.oIndex]);
      } else {
        const t = el.text;
        if (t === '' || /^[ \t]+$/.test(t)) out.push(t);
        else if (t.startsWith(p)) out.push(f + t.slice(p.length));
        else out.push(t);
      }
    }
  } else {
    for (const el of n) {
      if (el.isContext) out.push(fileLines[pos + el.oIndex]);
      else out.push(el.text);
    }
  }
  return out;
}

function reindentPlain(newLines: string[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  if (tier !== 2) return [...newLines];
  const f = leadingWs(fileLines[pos]);
  const p = o.length > 0 ? leadingWs(o[0]) : '';
  return newLines.map((t) => {
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

// ---------- edit types ----------
interface Hunk {
  a: number;
  c: number;
  elems: BodyElem[];
  on: ONPair;
  lastCNBackslash: boolean;
  lastPlusBackslash: boolean;
}

type Edit =
  | { type: 'unified'; oldPath: string | undefined; newPath: string | undefined; oldDevNull: boolean; newDevNull: boolean; newFile: boolean; deletedFile: boolean; hunks: Hunk[] }
  | { type: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { type: 'v4a-add'; path: string; lines: string[] }
  | { type: 'v4a-delete'; path: string }
  | { type: 'v4a-update'; path: string; moveTo: string | undefined; chunks: V4AChunk[] }
  | { type: 'json-create'; path: string; fileText: string }
  | { type: 'json-str'; path: string; oldStr: string; newStr: string }
  | { type: 'json-insert'; path: string; insertLine: number; newStr: string };

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  elems: BodyElem[];
  on: ONPair;
}

function editPaths(e: Edit): string[] {
  switch (e.type) {
    case 'unified': {
      const oldP = e.oldDevNull ? undefined : e.oldPath;
      const newP = e.newDevNull ? undefined : e.newPath;
      const isCreate = e.oldDevNull || e.newFile;
      const isDelete = !isCreate && (e.newDevNull || e.deletedFile);
      if (isCreate) return newP !== undefined ? [newP] : [];
      if (isDelete) return oldP !== undefined ? [oldP] : [];
      if (oldP !== undefined && newP !== undefined && oldP !== newP) return [oldP, newP];
      const p = oldP ?? newP;
      return p !== undefined ? [p] : [];
    }
    case 'sr':
    case 'v4a-add':
    case 'v4a-delete':
    case 'json-create':
    case 'json-str':
    case 'json-insert':
      return [e.path];
    case 'v4a-update': {
      const out = [e.path];
      if (e.moveTo !== undefined) out.push(e.moveTo);
      return out;
    }
  }
}

// ---------- unified parsing ----------
function extractDiffPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/;

// A diff --git line is `diff --git ` plus paths, or the bare `diff --git`
// token itself; either form must be validated, never silently ignored.
function isDiffGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

interface RawSection {
  oldPath: string | undefined;
  newPath: string | undefined;
  oldDevNull: boolean;
  newDevNull: boolean;
  hasOld: boolean;
  hasNew: boolean;
  hasPair: boolean;
  diffOld: string | undefined;
  diffNew: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newRawSection(): RawSection {
  return {
    oldPath: undefined, newPath: undefined, oldDevNull: false, newDevNull: false,
    hasOld: false, hasNew: false, hasPair: false,
    diffOld: undefined, diffNew: undefined, renameFrom: undefined, renameTo: undefined,
    newFile: false, deletedFile: false, hunks: [],
  };
}

function parseDiffGit(line: string, lineNo: number): { x: string; y: string } {
  const m = DIFF_GIT_RE.exec(line);
  if (!m) throw new ParseErr(lineNo);
  return { x: m[1], y: m[2] };
}

function parseHunk(lines: string[], headerIdx: number): { hunk: Hunk; next: number } {
  const line = lines[headerIdx];
  const m = HUNK_RE.exec(line);
  if (!m) throw new ParseErr(headerIdx + 1);
  const a = parseInt(m[1], 10);
  const c = parseInt(m[3], 10);
  let j = headerIdx + 1;
  const body: string[] = [];
  while (j < lines.length) {
    const l = lines[j];
    if (isDiffGitLine(l)) break;
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const elems: BodyElem[] = [];
  for (const raw of body) {
    if (raw === '') elems.push({ kind: 'context', text: '', backslashAfter: false });
    else if (raw[0] === ' ') elems.push({ kind: 'context', text: raw.slice(1), backslashAfter: false });
    else if (raw[0] === '-') elems.push({ kind: 'old', text: raw.slice(1), backslashAfter: false });
    else if (raw[0] === '+') elems.push({ kind: 'new', text: raw.slice(1), backslashAfter: false });
    else if (raw[0] === '\\') {
      if (elems.length > 0) elems[elems.length - 1].backslashAfter = true;
    }
  }
  const on = buildON(elems);
  return {
    hunk: { a, c, elems, on, lastCNBackslash: lastContextNewBackslash(elems), lastPlusBackslash: lastPlusBackslash(elems) },
    next: j,
  };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (current === null) {
      if (isDiffGitLine(line)) {
        const d = parseDiffGit(line, i + 1);
        current = newRawSection();
        current.diffOld = d.x;
        current.diffNew = d.y;
        sections.push(current);
        inHeader = true;
        i++;
        continue;
      }
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        current = newRawSection();
        sections.push(current);
        inHeader = true;
        continue;
      }
      if (line.startsWith('@@')) throw new ParseErr(i + 1);
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('@@')) {
        const r = parseHunk(lines, i);
        current.hunks.push(r.hunk);
        inHeader = false;
        i = r.next;
        continue;
      }
      if (isDiffGitLine(line)) {
        const d = parseDiffGit(line, i + 1);
        current = newRawSection();
        current.diffOld = d.x;
        current.diffNew = d.y;
        sections.push(current);
        inHeader = true;
        i++;
        continue;
      }
      if (line.startsWith('--- ')) {
        if (i + 1 >= lines.length || !lines[i + 1].startsWith('+++ ')) throw new ParseErr(i + 2);
        const op = extractDiffPath(line);
        const np = extractDiffPath(lines[i + 1]);
        current.oldPath = op;
        current.oldDevNull = op === '/dev/null';
        current.hasOld = true;
        current.newPath = np;
        current.newDevNull = np === '/dev/null';
        current.hasNew = true;
        current.hasPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        const np = extractDiffPath(line);
        current.newPath = np;
        current.newDevNull = np === '/dev/null';
        current.hasNew = true;
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        current.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        current.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        current.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        current.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (isDiffGitLine(line)) {
      const d = parseDiffGit(line, i + 1);
      current = newRawSection();
      current.diffOld = d.x;
      current.diffNew = d.y;
      sections.push(current);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      current = newRawSection();
      sections.push(current);
      inHeader = true;
      continue;
    }
    if (line.startsWith('@@')) {
      const r = parseHunk(lines, i);
      current.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new ParseErr(1);
  const edits: Edit[] = sections.map((s) => {
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let oldDevNull = false;
    let newDevNull = false;
    if (s.hasPair || s.hasOld) {
      oldPath = s.oldPath;
      oldDevNull = s.oldDevNull;
    } else if (s.renameFrom !== undefined) {
      oldPath = s.renameFrom;
    } else if (s.diffOld !== undefined) {
      oldPath = s.diffOld;
    }
    if (s.hasPair || s.hasNew) {
      newPath = s.newPath;
      newDevNull = s.newDevNull;
    } else if (s.renameTo !== undefined) {
      newPath = s.renameTo;
    } else if (s.diffNew !== undefined) {
      newPath = s.diffNew;
    }
    return {
      type: 'unified', oldPath, newPath, oldDevNull, newDevNull,
      newFile: s.newFile, deletedFile: s.deletedFile, hunks: s.hunks,
    };
  });
  return edits;
}

// ---------- SEARCH/REPLACE parsing ----------
function parseSR(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceIdx = -1;
  let prevPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (rtrimWs(lines[i]) === '<<<<<<< SEARCH') {
      const s = i;
      let path: string | undefined;
      for (let k = s - 1; k > prevReplaceIdx; k--) {
        const cand = lines[k];
        if (isBlank(cand)) continue;
        const t = cand.trim();
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === undefined) {
        if (prevPath !== undefined) path = prevPath;
        else throw new ParseErr(s + 1);
      }
      let sep = -1;
      let j = s + 1;
      while (j < lines.length) {
        if (rtrimWs(lines[j]) === '=======') { sep = j; break; }
        if (rtrimWs(lines[j]) === '<<<<<<< SEARCH') break;
        j++;
      }
      if (sep === -1) throw new ParseErr(s + 1);
      let rep = -1;
      j = sep + 1;
      while (j < lines.length) {
        if (rtrimWs(lines[j]) === '>>>>>>> REPLACE') { rep = j; break; }
        if (rtrimWs(lines[j]) === '<<<<<<< SEARCH') break;
        j++;
      }
      if (rep === -1) throw new ParseErr(s + 1);
      const oldLines = lines.slice(s + 1, sep);
      const newLines = lines.slice(sep + 1, rep);
      edits.push({ type: 'sr', path, oldLines, newLines });
      prevPath = path;
      prevReplaceIdx = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------- V4A parsing ----------
interface V4ARawSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  raw: { text: string; lineNo: number }[];
}

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    if (!isBlank(lines[idx])) {
      if (first === -1) first = idx;
      last = idx;
    }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const sections: V4ARawSection[] = [];
  let current: V4ARawSection | null = null;
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    const isAdd = line.startsWith('*** Add File: ');
    const isDel = line.startsWith('*** Delete File: ');
    const isUpd = line.startsWith('*** Update File: ');
    if (isAdd || isDel || isUpd) {
      current = null;
      const kind = isAdd ? 'add' : isDel ? 'delete' : 'update';
      const prefixLen = isAdd ? '*** Add File: '.length : isDel ? '*** Delete File: '.length : '*** Update File: '.length;
      const path = line.slice(prefixLen).trim();
      current = { kind, path, headerLine: i + 1, raw: [] };
      sections.push(current);
      i++;
      continue;
    }
    if (current === null) {
      if (isBlank(line)) { i++; continue; }
      throw new ParseErr(i + 1);
    }
    current.raw.push({ text: line, lineNo: i + 1 });
    i++;
  }
  if (sections.length === 0) throw new ParseErr(1);
  const edits: Edit[] = [];
  for (const sec of sections) {
    let raw = [...sec.raw];
    while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new ParseErr(r.lineNo);
      }
      edits.push({ type: 'v4a-add', path: sec.path, lines: fileLines });
    } else if (sec.kind === 'delete') {
      if (raw.length > 0) throw new ParseErr(raw[0].lineNo);
      edits.push({ type: 'v4a-delete', path: sec.path });
    } else {
      let moveTo: string | undefined;
      let j = 0;
      if (j < raw.length && raw[j].text.startsWith('*** Move to: ')) {
        moveTo = raw[j].text.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      const pushCur = (): void => {
        if (cur !== null) {
          cur.on = buildON(cur.elems);
          chunks.push(cur);
          cur = null;
        }
      };
      while (j < raw.length) {
        const r = raw[j];
        const t = r.text;
        if (t.startsWith('@@')) {
          pushCur();
          const anchorText = t.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, elems: [], on: { o: [], n: [] } };
          j++;
          continue;
        }
        if (t === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, elems: [], on: { o: [], n: [] } };
            pushCur();
          } else {
            cur.eof = true;
            pushCur();
          }
          j++;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, elems: [], on: { o: [], n: [] } };
          }
          if (t === '') cur.elems.push({ kind: 'context', text: '', backslashAfter: false });
          else if (t[0] === ' ') cur.elems.push({ kind: 'context', text: t.slice(1), backslashAfter: false });
          else if (t[0] === '-') cur.elems.push({ kind: 'old', text: t.slice(1), backslashAfter: false });
          else cur.elems.push({ kind: 'new', text: t.slice(1), backslashAfter: false });
          j++;
          continue;
        }
        throw new ParseErr(r.lineNo);
      }
      pushCur();
      if (chunks.length === 0 && moveTo === undefined) throw new ParseErr(sec.headerLine);
      edits.push({ type: 'v4a-update', path: sec.path, moveTo, chunks });
    }
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------- JSON parsing ----------
function validateJsonEdit(obj: unknown): Edit | null {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  const path = o.path as string;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { type: 'json-create', path, fileText: o.file_text as string };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || (o.old_str as string).length === 0) return null;
    if ('new_str' in o && typeof o.new_str !== 'string') return null;
    const newStr = 'new_str' in o ? (o.new_str as string) : '';
    return { type: 'json-str', path, oldStr: o.old_str as string, newStr };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { type: 'json-insert', path, insertLine: o.insert_line as number, newStr: o.new_str as string };
  }
  return null;
}

function parseJson(lines: string[], patchText: string): Edit[] {
  let first = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    if (!isBlank(lines[idx])) { first = idx; break; }
  }
  if (first === -1) throw new ParseErr(1);
  const firstChar = lines[first].trimStart()[0];
  if (firstChar === '[') {
    const startLine = first + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(patchText);
    } catch {
      throw new ParseErr(startLine);
    }
    if (!Array.isArray(parsed)) throw new ParseErr(startLine);
    if (parsed.length === 0) throw new ParseErr(1);
    const edits: Edit[] = [];
    for (const item of parsed) {
      const e = validateJsonEdit(item);
      if (e === null) throw new ParseErr(startLine);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (isBlank(lines[idx])) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[idx]);
    } catch {
      throw new ParseErr(idx + 1);
    }
    const e = validateJsonEdit(parsed);
    if (e === null) throw new ParseErr(idx + 1);
    edits.push(e);
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------- format detection ----------
function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    if (!isBlank(lines[idx])) { first = idx; break; }
  }
  if (first !== -1 && lines[first].trim() === '*** Begin Patch') return 'v4a';
  if (first !== -1) {
    const ch = lines[first].trimStart()[0];
    if (ch === '[' || ch === '{') return 'json';
  }
  for (let idx = 0; idx < lines.length; idx++) {
    if (rtrimWs(lines[idx]) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx].startsWith('diff --git ')) return 'unified';
    if (lines[idx].startsWith('--- ') && idx + 1 < lines.length && lines[idx + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------- applying ----------
interface Failure {
  code: string;
  path: string;
}

interface ApplyResult {
  failure: Failure | null;
  move: { old: string; new: string } | null;
}

function applyHunks(
  origText: string,
  hunks: Hunk[],
  strict: boolean,
  failPath: string,
): { text: string } | { failure: Failure } {
  const fl = getFileLines(origText);
  let lines = [...fl.lines];
  let ends = fl.ends;
  const breakStr = fl.breakStr;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = h.on;
    if (o.length === 0) {
      const insertPos = Math.max(0, Math.min(h.a + d, lines.length));
      const newLines = n.map((e) => e.text);
      if (newLines.length > 0 && insertPos === lines.length) {
        ends = !h.lastCNBackslash;
      }
      lines.splice(insertPos, 0, ...newLines);
      d += newLines.length;
      continue;
    }
    const tierRes = findTier(lines, o, strict);
    if (tierRes === null) return { failure: { code: 'no-match', path: failPath } };
    const target = h.a - 1 + d;
    let best = tierRes.positions[0];
    let bestDist = Math.abs(best - target);
    for (const p of tierRes.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const pos = best;
    const atEnd = pos + o.length === lines.length;
    const replacement = buildReplacement(n, lines, pos, o, tierRes.tier);
    if (atEnd) {
      if (n.length === 0) ends = true;
      else ends = !h.lastCNBackslash;
    }
    lines.splice(pos, o.length, ...replacement);
    d += n.length - o.length;
  }
  return { text: linesToText(lines, breakStr, ends) };
}

function applyEdit(e: Edit, tree: Map<string, string>, strict: boolean): ApplyResult {
  switch (e.type) {
    case 'unified': {
      const oldP = e.oldDevNull ? undefined : e.oldPath;
      const newP = e.newDevNull ? undefined : e.newPath;
      const isCreate = e.oldDevNull || e.newFile;
      const isDelete = !isCreate && (e.newDevNull || e.deletedFile);
      if (isCreate) {
        if (newP === undefined) return { failure: { code: 'missing', path: '' }, move: null };
        if (tree.has(newP)) return { failure: { code: 'exists', path: newP }, move: null };
        const plus: string[] = [];
        let lastBack = false;
        let hasPlus = false;
        for (const h of e.hunks) {
          for (const el of h.elems) {
            if (el.kind === 'new') { plus.push(el.text); hasPlus = true; }
          }
          if (h.elems.some((el) => el.kind === 'new')) lastBack = h.lastPlusBackslash;
        }
        const ends = hasPlus ? !lastBack : false;
        tree.set(newP, linesToText(plus, '\n', ends));
        return { failure: null, move: null };
      }
      if (isDelete) {
        if (oldP === undefined) return { failure: { code: 'missing', path: '' }, move: null };
        if (!tree.has(oldP)) return { failure: { code: 'missing', path: oldP }, move: null };
        tree.delete(oldP);
        return { failure: null, move: null };
      }
      if (oldP !== undefined && newP !== undefined && oldP !== newP) {
        if (!tree.has(oldP)) return { failure: { code: 'missing', path: oldP }, move: null };
        if (tree.has(newP)) return { failure: { code: 'exists', path: newP }, move: null };
        const r = applyHunks(tree.get(oldP) as string, e.hunks, strict, oldP);
        if ('failure' in r) return { failure: r.failure, move: null };
        tree.delete(oldP);
        tree.set(newP, r.text);
        return { failure: null, move: { old: oldP, new: newP } };
      }
      const p = oldP ?? newP;
      if (p === undefined) return { failure: { code: 'missing', path: '' }, move: null };
      if (!tree.has(p)) return { failure: { code: 'missing', path: p }, move: null };
      const r = applyHunks(tree.get(p) as string, e.hunks, strict, p);
      if ('failure' in r) return { failure: r.failure, move: null };
      tree.set(p, r.text);
      return { failure: null, move: null };
    }
    case 'sr': {
      if (e.oldLines.length === 0) {
        if (tree.has(e.path)) return { failure: { code: 'exists', path: e.path }, move: null };
        const ends = e.newLines.length > 0;
        tree.set(e.path, linesToText(e.newLines, '\n', ends));
        return { failure: null, move: null };
      }
      if (!tree.has(e.path)) return { failure: { code: 'missing', path: e.path }, move: null };
      const fl = getFileLines(tree.get(e.path) as string);
      const tierRes = findTier(fl.lines, e.oldLines, strict);
      if (tierRes === null) return { failure: { code: 'no-match', path: e.path }, move: null };
      if (tierRes.positions.length > 1) return { failure: { code: 'ambiguous', path: e.path }, move: null };
      const pos = tierRes.positions[0];
      const replacement = reindentPlain(e.newLines, fl.lines, pos, e.oldLines, tierRes.tier);
      const newLines = [...fl.lines.slice(0, pos), ...replacement, ...fl.lines.slice(pos + e.oldLines.length)];
      tree.set(e.path, linesToText(newLines, fl.breakStr, fl.ends));
      return { failure: null, move: null };
    }
    case 'v4a-add': {
      if (tree.has(e.path)) return { failure: { code: 'exists', path: e.path }, move: null };
      const ends = e.lines.length > 0;
      tree.set(e.path, linesToText(e.lines, '\n', ends));
      return { failure: null, move: null };
    }
    case 'v4a-delete': {
      if (!tree.has(e.path)) return { failure: { code: 'missing', path: e.path }, move: null };
      tree.delete(e.path);
      return { failure: null, move: null };
    }
    case 'v4a-update': {
      if (!tree.has(e.path)) return { failure: { code: 'missing', path: e.path }, move: null };
      if (e.moveTo !== undefined && tree.has(e.moveTo)) return { failure: { code: 'exists', path: e.moveTo }, move: null };
      const fl = getFileLines(tree.get(e.path) as string);
      let lines = [...fl.lines];
      const breakStr = fl.breakStr;
      const ends = fl.ends;
      let cursor = 0;
      for (const chunk of e.chunks) {
        if (chunk.anchor !== null && chunk.anchor !== '') {
          const ar = findTier(lines, [chunk.anchor], strict, cursor, false);
          if (ar === null) return { failure: { code: 'no-match', path: e.path }, move: null };
          cursor = ar.positions[0] + 1;
        }
        const { o, n } = chunk.on;
        if (o.length === 0) {
          const insertPos = chunk.eof ? lines.length : cursor;
          const newLines = n.map((el) => el.text);
          lines.splice(insertPos, 0, ...newLines);
          cursor = insertPos + newLines.length;
          continue;
        }
        const tierRes = findTier(lines, o, strict, cursor, chunk.eof);
        if (tierRes === null) return { failure: { code: 'no-match', path: e.path }, move: null };
        const pos = tierRes.positions[0];
        const replacement = buildReplacement(n, lines, pos, o, tierRes.tier);
        lines.splice(pos, o.length, ...replacement);
        cursor = pos + replacement.length;
      }
      const text = linesToText(lines, breakStr, ends);
      if (e.moveTo !== undefined) {
        tree.delete(e.path);
        tree.set(e.moveTo, text);
        return { failure: null, move: { old: e.path, new: e.moveTo } };
      }
      tree.set(e.path, text);
      return { failure: null, move: null };
    }
    case 'json-create': {
      if (tree.has(e.path)) return { failure: { code: 'exists', path: e.path }, move: null };
      tree.set(e.path, e.fileText);
      return { failure: null, move: null };
    }
    case 'json-str': {
      if (!tree.has(e.path)) return { failure: { code: 'missing', path: e.path }, move: null };
      const orig = tree.get(e.path) as string;
      const fl = getFileLines(orig);
      const isCrlf = fl.breakStr === '\r\n';
      const text = isCrlf ? orig.replace(/\r\n/g, '\n') : orig;
      const oldN = isCrlf ? e.oldStr.replace(/\r\n/g, '\n') : e.oldStr;
      const newN = isCrlf ? e.newStr.replace(/\r\n/g, '\n') : e.newStr;
      let count = 0;
      let firstPos = -1;
      let idx = 0;
      while (true) {
        const found = text.indexOf(oldN, idx);
        if (found === -1) break;
        if (count === 0) firstPos = found;
        count++;
        if (count > 1) break;
        idx = found + 1;
      }
      if (count === 0) return { failure: { code: 'no-match', path: e.path }, move: null };
      if (count > 1) return { failure: { code: 'ambiguous', path: e.path }, move: null };
      const resultNorm = text.slice(0, firstPos) + newN + text.slice(firstPos + oldN.length);
      const result = isCrlf ? resultNorm.replace(/\n/g, '\r\n') : resultNorm;
      tree.set(e.path, result);
      return { failure: null, move: null };
    }
    case 'json-insert': {
      if (!tree.has(e.path)) return { failure: { code: 'missing', path: e.path }, move: null };
      const fl = getFileLines(tree.get(e.path) as string);
      if (e.insertLine < 0 || e.insertLine > fl.lines.length) return { failure: { code: 'no-match', path: e.path }, move: null };
      const newLines = splitPatchLines(e.newStr);
      const newFileLines = [...fl.lines.slice(0, e.insertLine), ...newLines, ...fl.lines.slice(e.insertLine)];
      tree.set(e.path, linesToText(newFileLines, fl.breakStr, fl.ends));
      return { failure: null, move: null };
    }
  }
}

// ---------- tree IO ----------
function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(d, name);
      const relPath = rel === '' ? name : `${rel}/${name}`;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, relPath);
      else if (st.isFile()) {
        try {
          out.set(relPath, readFileSync(full, 'utf8'));
        } catch {
          // unreadable file: treat as absent
        }
      }
    }
  };
  walk(dir, '');
  return out;
}

function writeChanges(original: Map<string, string>, finalTree: Map<string, string>): void {
  const cwd = process.cwd();
  const all = new Set<string>([...original.keys(), ...finalTree.keys()]);
  for (const p of all) {
    const o = original.get(p);
    const f = finalTree.get(p);
    if (o === f) continue;
    const full = join(cwd, ...p.split('/'));
    if (f === undefined) {
      try { unlinkSync(full); } catch { /* already gone */ }
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, f, 'utf8');
    }
  }
}

// ---------- main ----------
function main(): number {
  const args = process.argv.slice(2);
  let format: string | undefined;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positionals: string[] = [];
  let endOpts = false;
  let usage = false;
  for (const a of args) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) usage = true;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) usage = true;
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) usage = true;
        seenFormat = true;
        format = a.slice('--format='.length);
        if (!['unified', 'search-replace', 'v4a', 'json', 'auto'].includes(format)) usage = true;
      } else {
        usage = true;
      }
      continue;
    }
    positionals.push(a);
  }
  if (positionals.length > 1) usage = true;
  if (usage) {
    process.stdout.write('error: usage\n');
    return 2;
  }
  const patchArg = positionals.length === 1 ? positionals[0] : undefined;
  let patchText: string;
  if (patchArg === undefined || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      return 2;
    }
  }
  const lines = splitPatchLines(patchText);
  const fmt = format ?? 'auto';
  let effFormat = fmt;
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      process.stdout.write('error: format\n');
      return 2;
    }
    effFormat = detected;
  }
  let edits: Edit[];
  try {
    if (effFormat === 'unified') edits = parseUnified(lines);
    else if (effFormat === 'search-replace') edits = parseSR(lines);
    else if (effFormat === 'v4a') edits = parseV4A(lines);
    else if (effFormat === 'json') edits = parseJson(lines, patchText);
    else edits = [];
  } catch (err) {
    if (err instanceof ParseErr) {
      process.stdout.write(`error: parse ${err.line}\n`);
      return 2;
    }
    throw err;
  }
  const original = readTree(process.cwd());
  const tree = new Map<string, string>(original);
  const failures: Failure[] = [];
  const moves: { old: string; new: string }[] = [];
  for (const e of edits) {
    const paths = editPaths(e);
    let unsafePath: string | null = null;
    for (const p of paths) {
      if (!isSafePath(p)) { unsafePath = p; break; }
    }
    if (unsafePath !== null) {
      failures.push({ code: 'unsafe', path: unsafePath });
      continue;
    }
    const r = applyEdit(e, tree, strict);
    if (r.failure !== null) failures.push(r.failure);
    else if (r.move !== null) moves.push(r.move);
  }
  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(out);
    return 1;
  }
  const aSet = new Set<string>();
  const dSet = new Set<string>();
  const mSet = new Set<string>();
  const all = new Set<string>([...original.keys(), ...tree.keys()]);
  for (const p of all) {
    const o = original.get(p);
    const f = tree.get(p);
    if (o === undefined && f !== undefined) aSet.add(p);
    else if (o !== undefined && f === undefined) dSet.add(p);
    else if (o !== undefined && f !== undefined && o !== f) mSet.add(p);
  }
  const rLines: { old: string; new: string }[] = [];
  for (const mv of moves) {
    if (dSet.has(mv.old) && aSet.has(mv.new)) {
      dSet.delete(mv.old);
      aSet.delete(mv.new);
      rLines.push(mv);
    }
  }
  interface ChangeLine { key: string; line: string }
  const changeLines: ChangeLine[] = [];
  for (const p of aSet) changeLines.push({ key: p, line: `A ${p}` });
  for (const p of dSet) changeLines.push({ key: p, line: `D ${p}` });
  for (const p of mSet) changeLines.push({ key: p, line: `M ${p}` });
  for (const mv of rLines) changeLines.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
  changeLines.sort((x, y) => {
    const c = byteCompare(x.key, y.key);
    if (c !== 0) return c;
    return x.line < y.line ? -1 : x.line > y.line ? 1 : 0;
  });
  if (!check) writeChanges(original, tree);
  let out = '';
  for (const cl of changeLines) out += `${cl.line}\n`;
  out += changeLines.length === 1 ? 'ok: 1 file\n' : `ok: ${changeLines.length} files\n`;
  process.stdout.write(out);
  return 0;
}

process.exitCode = main();
