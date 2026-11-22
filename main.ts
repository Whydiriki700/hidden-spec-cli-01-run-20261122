import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

type FileState = { lines: string[]; brk: string; ends: boolean };
type BodyItem = { kind: 'ctx' | 'old' | 'new'; text: string; noNl: boolean };
type Hunk = { a: number; items: BodyItem[]; o: BodyItem[]; n: BodyItem[] };
type Chunk = { anchor: string | null; eof: boolean; items: BodyItem[]; o: BodyItem[]; n: BodyItem[] };
type Edit =
  | { kind: 'unified'; oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; isMove: boolean; hunks: Hunk[] }
  | { kind: 'search'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v4a-add'; path: string; lines: string[] }
  | { kind: 'v4a-delete'; path: string }
  | { kind: 'v4a-update'; path: string; newPath: string | null; chunks: Chunk[] }
  | { kind: 'json-create'; path: string; fileText: string }
  | { kind: 'json-str'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-insert'; path: string; insertLine: number; newStr: string };
type Fail = { code: string; path: string };
type ParseRes = { edits: Edit[] } | { parseLine: number };

function out(s: string): void { process.stdout.write(s); }
function isSafe(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const parts = p.split('/');
  for (const seg of parts) if (seg === '' || seg === '.' || seg === '..') return false;
  return true;
}
function trimTrail(s: string): string { return s.replace(/[ \t]+$/, ''); }
function trimBoth(s: string): string { return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''); }
function leadWs(s: string): string { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; }
function transform(s: string, tier: number): string { if (tier === 0) return s; if (tier === 1) return trimTrail(s); return trimBoth(s); }
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const ls = text.split('\n');
  if (text.endsWith('\n')) ls.pop();
  return ls.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}
function parseFileText(text: string): FileState {
  if (text === '') return { lines: [], brk: '\n', ends: false };
  const idx = text.indexOf('\n');
  const brk = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(brk);
  const parts = text.split(brk);
  if (ends) parts.pop();
  return { lines: parts, brk, ends };
}
function serialise(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.ends ? f.brk : '');
}
function cloneFile(f: FileState): FileState { return { lines: [...f.lines], brk: f.brk, ends: f.ends }; }
function findTier(o: string[], lines: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos: number[] = [];
    const max = lines.length - o.length;
    for (let i = from; i <= max; i++) {
      if (eofOnly && i + o.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (transform(o[j], tier) !== transform(lines[i + j], tier)) { ok = false; break; }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, positions: pos };
  }
  return null;
}
function reindent(text: string, oFirst: string, fileFirst: string): string {
  if (text === '' || /^[ \t]+$/.test(text)) return text;
  const p = leadWs(oFirst);
  const f = leadWs(fileFirst);
  if (!text.startsWith(p)) return text;
  return f + text.slice(p.length);
}
function buildReplacement(nItems: BodyItem[], oItems: BodyItem[], fileLines: string[], pos: number, tier: number): string[] {
  const res: string[] = [];
  for (const it of nItems) {
    if (it.kind === 'ctx') {
      const oi = oItems.indexOf(it);
      res.push(fileLines[pos + oi]);
    } else {
      if (tier === 2 && oItems.length > 0) res.push(reindent(it.text, oItems[0].text, fileLines[pos]));
      else res.push(it.text);
    }
  }
  return res;
}
function itemsToON(items: BodyItem[]): { o: BodyItem[]; n: BodyItem[] } {
  return { o: items.filter((i) => i.kind === 'ctx' || i.kind === 'old'), n: items.filter((i) => i.kind === 'ctx' || i.kind === 'new') };
}
function bodyItemsFromRaw(raw: string[]): BodyItem[] {
  const items: BodyItem[] = [];
  for (const r of raw) {
    if (r.startsWith('\\')) { if (items.length > 0) items[items.length - 1].noNl = true; continue; }
    if (r === '') { items.push({ kind: 'ctx', text: '', noNl: false }); continue; }
    const c = r[0];
    if (c === ' ') items.push({ kind: 'ctx', text: r.slice(1), noNl: false });
    else if (c === '-') items.push({ kind: 'old', text: r.slice(1), noNl: false });
    else if (c === '+') items.push({ kind: 'new', text: r.slice(1), noNl: false });
  }
  return items;
}
function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() !== '') { first = i; break; }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (const l of lines) if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}
function stripPrefixPath(raw: string): string {
  const t = raw.trim();
  if (t === '/dev/null') return t;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}
function parseHeaderPath(line: string): string {
  const after = line.slice(4);
  const tab = after.indexOf('\t');
  const part = tab === -1 ? after : after.slice(0, tab);
  return stripPrefixPath(part);
}
function isDiffLine(l: string): boolean { return l.startsWith('diff --git'); }
function parseDiffLine(l: string, lineNo: number): { x: string; y: string } | { parseLine: number } {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
  if (!m) return { parseLine: lineNo };
  return { x: m[1], y: m[2] };
}
function parseHunkHeader(l: string, lineNo: number): { a: number } | { parseLine: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(l);
  if (!m) return { parseLine: lineNo };
  return { a: parseInt(m[1], 10) };
}
type UniSection = {
  diffOld: string | null; diffNew: string | null; renameOld: string | null; renameNew: string | null;
  headOld: string | null; headNew: string | null; pair: boolean;
  newMode: boolean; delMode: boolean; hunks: Hunk[];
};
function sectionToEdit(s: UniSection): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (s.pair) { oldP = s.headOld; newP = s.headNew; }
  else if (s.renameOld !== null || s.renameNew !== null) { oldP = s.renameOld !== null ? s.renameOld : s.diffOld; newP = s.renameNew !== null ? s.renameNew : s.diffNew; }
  else { oldP = s.diffOld; newP = s.diffNew; }
  if (oldP === '/dev/null') oldP = null;
  if (newP === '/dev/null') newP = null;
  const isCreate = oldP === null || s.newMode;
  const isDelete = newP === null || s.delMode;
  if (isCreate && newP !== null) return { kind: 'unified', oldPath: oldP, newPath: newP, isCreate: true, isDelete: false, isMove: false, hunks: s.hunks };
  if (isDelete && oldP !== null) return { kind: 'unified', oldPath: oldP, newPath: newP, isCreate: false, isDelete: true, isMove: false, hunks: s.hunks };
  const isMove = oldP !== null && newP !== null && oldP !== newP;
  return { kind: 'unified', oldPath: oldP, newPath: newP, isCreate: false, isDelete: false, isMove, hunks: s.hunks };
}
function parseUnified(lines: string[]): ParseRes {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = true;
  const fresh = (x: string | null, y: string | null): UniSection => ({ diffOld: x, diffNew: y, renameOld: null, renameNew: null, headOld: null, headNew: null, pair: false, newMode: false, delMode: false, hunks: [] });
  const pushCur = (): void => { if (cur) sections.push(cur); cur = null; };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (cur === null) {
      if (isDiffLine(line)) {
        const r = parseDiffLine(line, i + 1);
        if ('parseLine' in r) return { parseLine: r.parseLine };
        cur = fresh(r.x, r.y); inHeader = true; i++; continue;
      }
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        cur = fresh(null, null); inHeader = true;
        cur.headOld = parseHeaderPath(line); cur.headNew = parseHeaderPath(lines[i + 1]); cur.pair = true; i += 2; continue;
      }
      if (line.startsWith('@@')) return { parseLine: i + 1 };
      i++; continue;
    }
    if (inHeader) {
      if (isDiffLine(line)) {
        const r = parseDiffLine(line, i + 1);
        if ('parseLine' in r) return { parseLine: r.parseLine };
        pushCur(); cur = fresh(r.x, r.y); inHeader = true; i++; continue;
      }
      if (line.startsWith('--- ')) {
        if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
          if (!cur.pair) { cur.headOld = parseHeaderPath(line); cur.headNew = parseHeaderPath(lines[i + 1]); cur.pair = true; i += 2; continue; }
          pushCur(); cur = fresh(null, null); inHeader = true; cur.headOld = parseHeaderPath(line); cur.headNew = parseHeaderPath(lines[i + 1]); cur.pair = true; i += 2; continue;
        }
        return { parseLine: i + 2 };
      }
      if (line.startsWith('rename from ')) { cur.renameOld = line.slice('rename from '.length).trim(); i++; continue; }
      if (line.startsWith('rename to ')) { cur.renameNew = line.slice('rename to '.length).trim(); i++; continue; }
      if (line.startsWith('new file mode')) { cur.newMode = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { cur.delMode = true; i++; continue; }
      if (line.startsWith('@@')) {
        const h = parseHunkHeader(line, i + 1);
        if ('parseLine' in h) return { parseLine: h.parseLine };
        const body = collectHunkBody(lines, i + 1);
        const items = bodyItemsFromRaw(body.raw);
        const on = itemsToON(items);
        cur.hunks.push({ a: h.a, items, o: on.o, n: on.n });
        i = body.next; inHeader = false; continue;
      }
      i++; continue;
    }
    if (isDiffLine(line)) {
      const r = parseDiffLine(line, i + 1);
      if ('parseLine' in r) return { parseLine: r.parseLine };
      pushCur(); cur = fresh(r.x, r.y); inHeader = true; i++; continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      pushCur(); cur = fresh(null, null); inHeader = true; cur.headOld = parseHeaderPath(line); cur.headNew = parseHeaderPath(lines[i + 1]); cur.pair = true; i += 2; continue;
    }
    if (line.startsWith('@@')) {
      const h = parseHunkHeader(line, i + 1);
      if ('parseLine' in h) return { parseLine: h.parseLine };
      const body = collectHunkBody(lines, i + 1);
      const items = bodyItemsFromRaw(body.raw);
      const on = itemsToON(items);
      cur.hunks.push({ a: h.a, items, o: on.o, n: on.n });
      i = body.next; continue;
    }
    i++;
  }
  pushCur();
  if (sections.length === 0) return { parseLine: 1 };
  return { edits: sections.map(sectionToEdit) };
}
function collectHunkBody(lines: string[], start: number): { raw: string[]; next: number } {
  const raw: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git')) break;
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) { raw.push(l); i++; continue; }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return { raw, next: i };
}
function parseSearch(lines: string[]): ParseRes {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t; break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else return { parseLine: s + 1 };
    }
    let sep = -1;
    for (let k = s + 1; k < lines.length; k++) if (lines[k].trimEnd() === '=======') { sep = k; break; }
    if (sep === -1) return { parseLine: s + 1 };
    let end = -1;
    for (let k = sep + 1; k < lines.length; k++) if (lines[k].trimEnd() === '>>>>>>> REPLACE') { end = k; break; }
    if (end === -1) return { parseLine: s + 1 };
    edits.push({ kind: 'search', path, oldLines: lines.slice(s + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path; prevEnd = end; i = end + 1;
  }
  if (edits.length === 0) return { parseLine: 1 };
  return { edits };
}
function isV4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}
function parseV4a(lines: string[]): ParseRes {
  if (lines.length === 0) return { parseLine: 1 };
  let first = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() !== '') { first = i; break; }
  if (first === -1) return { parseLine: 1 };
  if (lines[first].trim() !== '*** Begin Patch') return { parseLine: first + 1 };
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() !== '') { last = i; break; }
  if (lines[last].trim() !== '*** End Patch') return { parseLine: lines.length + 1 };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const raw: string[] = [];
      while (i < last) {
        const l = lines[i];
        if (isV4aSectionStart(l)) break;
        if (l.startsWith('+')) { raw.push(l); i++; continue; }
        if (l === '') { raw.push(l); i++; continue; }
        if (l.trim() === '') { raw.push(''); i++; continue; }
        return { parseLine: i + 1 };
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const flines: string[] = raw.map((r) => (r === '' ? '' : r.slice(1)));
      edits.push({ kind: 'v4a-add', path, lines: flines });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const l = lines[i];
        if (isV4aSectionStart(l)) break;
        if (l.trim() === '') { i++; continue; }
        return { parseLine: i + 1 };
      }
      edits.push({ kind: 'v4a-delete', path });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updLine = i + 1;
      i++;
      let newPath: string | null = null;
      if (i < last && lines[i].startsWith('*** Move to: ')) { newPath = lines[i].slice('*** Move to: '.length).trim(); i++; }
      const chunks: Chunk[] = [];
      let firstChunk = true;
      while (i < last) {
        const l = lines[i];
        if (isV4aSectionStart(l)) break;
        if (l.trim() === '*** End of File') return { parseLine: i + 1 };
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          const anchor = anchorText === '' ? null : anchorText;
          i++;
          const res = collectV4aBody(lines, i, last);
          if ('parseLine' in res) return res;
          i = res.next;
          const items = bodyItemsFromRaw(res.raw);
          const on = itemsToON(items);
          chunks.push({ anchor, eof: res.eof, items, o: on.o, n: on.n });
          firstChunk = false;
          continue;
        }
        if (firstChunk && (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+'))) {
          const res = collectV4aBody(lines, i, last);
          if ('parseLine' in res) return res;
          i = res.next;
          const items = bodyItemsFromRaw(res.raw);
          const on = itemsToON(items);
          chunks.push({ anchor: null, eof: res.eof, items, o: on.o, n: on.n });
          firstChunk = false;
          continue;
        }
        if (l.trim() === '') {
          if (firstChunk) {
            const res = collectV4aBody(lines, i, last);
            if ('parseLine' in res) return res;
            i = res.next;
            const items = bodyItemsFromRaw(res.raw);
            const on = itemsToON(items);
            chunks.push({ anchor: null, eof: res.eof, items, o: on.o, n: on.n });
            firstChunk = false;
            continue;
          }
          i++;
          continue;
        }
        return { parseLine: i + 1 };
      }
      if (chunks.length === 0 && newPath === null) return { parseLine: updLine };
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        const rawItems = lastChunk.items;
        while (rawItems.length > 0) {
          const it = rawItems[rawItems.length - 1];
          if (it.kind === 'ctx' && it.text === '') {
            const wasEmptyRaw = true;
            if (wasEmptyRaw) { rawItems.pop(); const on = itemsToON(rawItems); lastChunk.o = on.o; lastChunk.n = on.n; continue; }
          }
          break;
        }
      }
      edits.push({ kind: 'v4a-update', path, newPath, chunks });
      continue;
    }
    return { parseLine: i + 1 };
  }
  if (edits.length === 0) return { parseLine: 1 };
  return { edits };
}
function collectV4aBody(lines: string[], start: number, last: number): { raw: string[]; next: number; eof: boolean } | { parseLine: number } {
  const raw: string[] = [];
  let i = start;
  let eof = false;
  while (i < last) {
    const l = lines[i];
    if (l.startsWith('@@')) break;
    if (l.trim() === '*** End of File') { eof = true; i++; break; }
    if (isV4aSectionStart(l)) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) { raw.push(l); i++; continue; }
    return { parseLine: i + 1 };
  }
  return { raw, next: i, eof };
}
function validateJsonEdit(obj: unknown): Edit | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  const path = o.path as string;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { kind: 'json-create', path, fileText: o.file_text as string };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || (o.old_str as string).length === 0) return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { kind: 'json-str', path, oldStr: o.old_str as string, newStr: (o.new_str as string | undefined) ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'json-insert', path, insertLine: o.insert_line as number, newStr: o.new_str as string };
  }
  return null;
}
function parseJson(lines: string[], patchText: string): ParseRes {
  let first = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() !== '') { first = i; break; }
  if (first === -1) return { parseLine: 1 };
  const firstChar = lines[first].trimStart()[0];
  if (firstChar === '[') {
    const startLine = first + 1;
    let parsed: unknown;
    try { parsed = JSON.parse(patchText); } catch { return { parseLine: startLine }; }
    if (!Array.isArray(parsed)) return { parseLine: startLine };
    if (parsed.length === 0) return { parseLine: 1 };
    const edits: Edit[] = [];
    for (const el of parsed) {
      const e = validateJsonEdit(el);
      if (!e) return { parseLine: startLine };
      edits.push(e);
    }
    return { edits };
  }
  if (firstChar === '{') {
    const edits: Edit[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '') continue;
      let parsed: unknown;
      try { parsed = JSON.parse(l); } catch { return { parseLine: i + 1 }; }
      const e = validateJsonEdit(parsed);
      if (!e) return { parseLine: i + 1 };
      edits.push(e);
    }
    if (edits.length === 0) return { parseLine: 1 };
    return { edits };
  }
  return { parseLine: first + 1 };
}
class Tree {
  initial = new Map<string, string | null>();
  virtual = new Map<string, FileState | null>();
  ensure(p: string): FileState | null {
    if (this.virtual.has(p)) return this.virtual.get(p) ?? null;
    let raw: string | null = null;
    try {
      if (existsSync(p) && statSync(p).isFile()) raw = readFileSync(p, 'utf8');
    } catch { raw = null; }
    this.initial.set(p, raw);
    const st = raw === null ? null : parseFileText(raw);
    this.virtual.set(p, st);
    return st;
  }
  exists(p: string): boolean { return this.ensure(p) !== null; }
  get(p: string): FileState | null { return this.ensure(p); }
  set(p: string, v: FileState | null): void { if (!this.initial.has(p)) this.ensure(p); this.virtual.set(p, v); }
}
function applyHunks(file: FileState, hunks: Hunk[], strict: boolean): Fail | null {
  let d = 0;
  for (const h of hunks) {
    const oTexts = h.o.map((x) => x.text);
    if (oTexts.length === 0) {
      const ins = Math.min(h.a + d, file.lines.length);
      const newLines = h.n.map((x) => x.text);
      if (newLines.length > 0 && ins === file.lines.length) {
        const lastN = h.n[h.n.length - 1];
        file.ends = !lastN.noNl;
      }
      file.lines.splice(ins, 0, ...newLines);
      d += newLines.length;
      continue;
    }
    const found = findTier(oTexts, file.lines, strict, 0, false);
    if (!found) return { code: 'no-match', path: '' };
    const target = h.a - 1 + d;
    let best = found.positions[0];
    let bestDist = Math.abs(best - target);
    for (const pos of found.positions) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) { best = pos; bestDist = dist; }
    }
    const replacement = buildReplacement(h.n, h.o, file.lines, best, found.tier);
    const touchesEnd = best + oTexts.length === file.lines.length;
    if (touchesEnd) {
      if (h.n.length === 0) file.ends = true;
      else file.ends = !h.n[h.n.length - 1].noNl;
    }
    file.lines.splice(best, oTexts.length, ...replacement);
    d += h.n.length - oTexts.length;
  }
  return null;
}
function applyEdit(e: Edit, tree: Tree, strict: boolean, moves: { old: string; nw: string }[]): Fail | null {
  if (e.kind === 'unified') {
    const paths: string[] = [];
    if (e.oldPath !== null) paths.push(e.oldPath);
    if (e.newPath !== null && e.newPath !== e.oldPath) paths.push(e.newPath);
    for (const p of paths) if (!isSafe(p)) return { code: 'unsafe', path: p };
    if (e.isCreate) {
      const np = e.newPath as string;
      if (tree.exists(np)) return { code: 'exists', path: np };
      const plus = e.hunks.flatMap((h) => h.items.filter((x) => x.kind === 'new'));
      const plusLines = plus.map((x) => x.text);
      let ends = false;
      if (plusLines.length > 0) ends = !plus[plus.length - 1].noNl;
      tree.set(np, { lines: plusLines, brk: '\n', ends });
      return null;
    }
    if (e.isDelete) {
      const op = e.oldPath as string;
      if (!tree.exists(op)) return { code: 'missing', path: op };
      tree.set(op, null);
      return null;
    }
    if (e.isMove) {
      const op = e.oldPath as string;
      const np = e.newPath as string;
      if (!tree.exists(op)) return { code: 'missing', path: op };
      if (tree.exists(np)) return { code: 'exists', path: np };
      const cur = tree.get(op) as FileState;
      const work = cloneFile(cur);
      const f = applyHunks(work, e.hunks, strict);
      if (f) return { code: f.code, path: op };
      tree.set(np, work);
      tree.set(op, null);
      moves.push({ old: op, nw: np });
      return null;
    }
    const p = (e.oldPath ?? e.newPath) as string;
    if (!tree.exists(p)) return { code: 'missing', path: p };
    const cur = tree.get(p) as FileState;
    const work = cloneFile(cur);
    const f = applyHunks(work, e.hunks, strict);
    if (f) return { code: f.code, path: p };
    tree.set(p, work);
    return null;
  }
  if (e.kind === 'search') {
    if (!isSafe(e.path)) return { code: 'unsafe', path: e.path };
    if (e.oldLines.length === 0) {
      if (tree.exists(e.path)) return { code: 'exists', path: e.path };
      tree.set(e.path, { lines: [...e.newLines], brk: '\n', ends: e.newLines.length > 0 });
      return null;
    }
    if (!tree.exists(e.path)) return { code: 'missing', path: e.path };
    const cur = tree.get(e.path) as FileState;
    const found = findTier(e.oldLines, cur.lines, strict, 0, false);
    if (!found) return { code: 'no-match', path: e.path };
    if (found.positions.length !== 1) return { code: 'ambiguous', path: e.path };
    const pos = found.positions[0];
    const repl = e.newLines.map((t) => (found.tier === 2 ? reindent(t, e.oldLines[0], cur.lines[pos]) : t));
    const work = cloneFile(cur);
    work.lines.splice(pos, e.oldLines.length, ...repl);
    tree.set(e.path, work);
    return null;
  }
  if (e.kind === 'v4a-add') {
    if (!isSafe(e.path)) return { code: 'unsafe', path: e.path };
    if (tree.exists(e.path)) return { code: 'exists', path: e.path };
    tree.set(e.path, { lines: [...e.lines], brk: '\n', ends: e.lines.length > 0 });
    return null;
  }
  if (e.kind === 'v4a-delete') {
    if (!isSafe(e.path)) return { code: 'unsafe', path: e.path };
    if (!tree.exists(e.path)) return { code: 'missing', path: e.path };
    tree.set(e.path, null);
    return null;
  }
  if (e.kind === 'v4a-update') {
    if (!isSafe(e.path)) return { code: 'unsafe', path: e.path };
    if (e.newPath !== null && !isSafe(e.newPath)) return { code: 'unsafe', path: e.newPath };
    if (!tree.exists(e.path)) return { code: 'missing', path: e.path };
    if (e.newPath !== null && tree.exists(e.newPath)) return { code: 'exists', path: e.newPath };
    const cur = tree.get(e.path) as FileState;
    const work = cloneFile(cur);
    let cursor = 0;
    for (const ch of e.chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const af = findTier([ch.anchor], work.lines, strict, cursor, false);
        if (!af) return { code: 'no-match', path: e.path };
        cursor = af.positions[0] + 1;
      }
      const oTexts = ch.o.map((x) => x.text);
      if (oTexts.length === 0) {
        const ins = ch.eof ? work.lines.length : cursor;
        const newLines = ch.n.map((x) => x.text);
        work.lines.splice(ins, 0, ...newLines);
        cursor = ins + newLines.length;
        continue;
      }
      const found = findTier(oTexts, work.lines, strict, cursor, ch.eof);
      if (!found) return { code: 'no-match', path: e.path };
      const pos = found.positions[0];
      const repl = buildReplacement(ch.n, ch.o, work.lines, pos, found.tier);
      work.lines.splice(pos, oTexts.length, ...repl);
      cursor = pos + repl.length;
    }
    if (e.newPath !== null) {
      tree.set(e.newPath, work);
      tree.set(e.path, null);
      moves.push({ old: e.path, nw: e.newPath });
    } else {
      tree.set(e.path, work);
    }
    return null;
  }
  if (e.kind === 'json-create') {
    if (!isSafe(e.path)) return { code: 'unsafe', path: e.path };
    if (tree.exists(e.path)) return { code: 'exists', path: e.path };
    tree.set(e.path, parseFileText(e.fileText));
    return null;
  }
  if (e.kind === 'json-str') {
    if (!isSafe(e.path)) return { code: 'unsafe', path: e.path };
    if (!tree.exists(e.path)) return { code: 'missing', path: e.path };
    const cur = tree.get(e.path) as FileState;
    const raw = serialise(cur);
    const isCrlf = cur.brk === '\r\n';
    const text = isCrlf ? raw.replace(/\r\n/g, '\n') : raw;
    const oldS = isCrlf ? e.oldStr.replace(/\r\n/g, '\n') : e.oldStr;
    const newS = isCrlf ? e.newStr.replace(/\r\n/g, '\n') : e.newStr;
    let count = 0;
    let firstIdx = -1;
    let idx = text.indexOf(oldS);
    while (idx !== -1) { if (firstIdx === -1) firstIdx = idx; count++; idx = text.indexOf(oldS, idx + 1); }
    if (count === 0) return { code: 'no-match', path: e.path };
    if (count > 1) return { code: 'ambiguous', path: e.path };
    const replaced = text.slice(0, firstIdx) + newS + text.slice(firstIdx + oldS.length);
    const outText = isCrlf ? replaced.replace(/\n/g, '\r\n') : replaced;
    tree.set(e.path, parseFileText(outText));
    return null;
  }
  const je = e as { kind: 'json-insert'; path: string; insertLine: number; newStr: string };
  if (!isSafe(je.path)) return { code: 'unsafe', path: je.path };
  if (!tree.exists(je.path)) return { code: 'missing', path: je.path };
  const cur2 = tree.get(je.path) as FileState;
  if (je.insertLine < 0 || je.insertLine > cur2.lines.length) return { code: 'no-match', path: je.path };
  const insLines = splitPatch(je.newStr);
  const work2 = cloneFile(cur2);
  work2.lines.splice(je.insertLine, 0, ...insLines);
  tree.set(je.path, work2);
  return null;
}
async function runCli(): Promise<number> {
  const args = process.argv.slice(2);
  let format = 'auto';
  let checkFlag = false;
  let strictFlag = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let usage = false;
  const positional: string[] = [];
  let endOpts = false;
  for (const a of args) {
    if (endOpts) { positional.push(a); continue; }
    if (a === '--') { endOpts = true; continue; }
    if (a === '-') { positional.push(a); continue; }
    if (a.startsWith('-')) {
      if (a === '--check') { if (seenCheck) usage = true; seenCheck = true; checkFlag = true; }
      else if (a === '--strict') { if (seenStrict) usage = true; seenStrict = true; strictFlag = true; }
      else if (a.startsWith('--format=')) {
        if (seenFormat) usage = true;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v === 'unified' || v === 'search-replace' || v === 'v4a' || v === 'json' || v === 'auto') format = v;
        else usage = true;
      } else usage = true;
      continue;
    }
    positional.push(a);
  }
  if (positional.length > 1) usage = true;
  if (usage) { out('error: usage\n'); return 2; }
  let patchText: string;
  const patchArg = positional[0];
  if (patchArg === undefined || patchArg === '-') {
    try { patchText = readFileSync(0, 'utf8'); } catch { patchText = ''; }
  } else {
    try { patchText = readFileSync(patchArg, 'utf8'); } catch { out('error: no-patch\n'); return 2; }
  }
  const lines = splitPatch(patchText);
  let fmt = format;
  if (fmt === 'auto') {
    const d = detectFormat(lines);
    if (d === null) { out('error: format\n'); return 2; }
    fmt = d;
  }
  let parsed: ParseRes;
  if (fmt === 'unified') parsed = parseUnified(lines);
  else if (fmt === 'search-replace') parsed = parseSearch(lines);
  else if (fmt === 'v4a') parsed = parseV4a(lines);
  else parsed = parseJson(lines, patchText);
  if ('parseLine' in parsed) { out(`error: parse ${parsed.parseLine}\n`); return 2; }
  const edits = parsed.edits;
  if (edits.length === 0) { out('error: parse 1\n'); return 2; }
  const tree = new Tree();
  const moves: { old: string; nw: string }[] = [];
  const fails: Fail[] = [];
  for (const e of edits) {
    const f = applyEdit(e, tree, strictFlag, moves);
    if (f) fails.push(f);
  }
  if (fails.length > 0) {
    for (const f of fails) out(`error: ${f.code} ${f.path}\n`);
    out(`failed: ${fails.length} of ${edits.length} edits\n`);
    return 1;
  }
  type DiffLine = { key: string; text: string };
  const diffMap = new Map<string, DiffLine>();
  const allPaths = new Set<string>([...tree.initial.keys(), ...tree.virtual.keys()]);
  for (const p of allPaths) {
    const before = tree.initial.has(p) ? tree.initial.get(p) as string | null : null;
    const afterState = tree.virtual.get(p) ?? null;
    const after = afterState === null ? null : serialise(afterState);
    if (before === after) continue;
    if (before === null && after !== null) diffMap.set(p, { key: p, text: `A ${p}` });
    else if (before !== null && after === null) diffMap.set(p, { key: p, text: `D ${p}` });
    else diffMap.set(p, { key: p, text: `M ${p}` });
  }
  for (const mv of moves) {
    const dEnt = diffMap.get(mv.old);
    const aEnt = diffMap.get(mv.nw);
    if (dEnt && dEnt.text.startsWith('D ') && aEnt && aEnt.text.startsWith('A ')) {
      diffMap.delete(mv.old);
      diffMap.delete(mv.nw);
      diffMap.set(mv.nw, { key: mv.nw, text: `R ${mv.old} -> ${mv.nw}` });
    }
  }
  const entries = [...diffMap.values()].sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  if (!checkFlag) {
    for (const p of allPaths) {
      const before = tree.initial.has(p) ? tree.initial.get(p) as string | null : null;
      const afterState = tree.virtual.get(p) ?? null;
      const after = afterState === null ? null : serialise(afterState);
      if (before === after) continue;
      if (after === null) { try { unlinkSync(p); } catch { /* ignore */ } }
      else {
        const dir = dirname(p);
        if (dir !== '.' && dir !== '') { try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }
        writeFileSync(p, after, 'utf8');
      }
    }
  }
  for (const en of entries) out(en.text + '\n');
  out(entries.length === 1 ? 'ok: 1 file\n' : `ok: ${entries.length} files\n`);
  return 0;
}
const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl) {
  await runTrial(envUrl);
} else {
  process.exitCode = await runCli();
}
