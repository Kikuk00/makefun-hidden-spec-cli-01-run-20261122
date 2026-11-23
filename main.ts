// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A,
// JSON edits), finds the lines each edit names at the first of three matching tiers,
// and writes every change or none, printing what it changed or why it failed.
// SPEC.md is the whole contract.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** An edit: applies itself to the tree, or throws Fail. Returns a move pair [old, new] when it moves a file. */
type Edit = (tree: Tree) => [string, string] | null | void;

// ---------------------------------------------------------------------------
// Files: a file is its line break, its lines and whether it ends with a break.
// (SPEC.md section 3.)
// ---------------------------------------------------------------------------

interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC.md section 5).
// tier 0: every line equal; tier 1: equal once trailing spaces and tabs are
// removed from both; tier 2: equal once leading and trailing spaces and tabs
// are removed from both. Only spaces and tabs are ever stripped.
// ---------------------------------------------------------------------------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions i at or after `from` where O's lines match the file's lines i, i+1, ... */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (at or after `from`), with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of O or N. `ctx` is the index of the line in O when it is a context line, else null. */
interface LN {
  text: string;
  ctx: number | null;
}

/** Split hunk/chunk body lines into O (context and `-` lines) and N (context and `+` lines). */
function buildON(body: string[]): { o: LN[]; n: LN[] } {
  const o: LN[] = [];
  const n: LN[] = [];
  for (const l of body) {
    if (l.startsWith(' ') || l === '') {
      const t = l === '' ? '' : l.slice(1);
      o.push({ text: t, ctx: o.length });
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push({ text: l.slice(1), ctx: null });
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: null });
    }
    // A `\` line is part of neither O nor N.
  }
  return { o, n };
}

function plainON(oTexts: string[], nTexts: string[]): { o: LN[]; n: LN[] } {
  return {
    o: oTexts.map((text) => ({ text, ctx: null })),
    n: nTexts.map((text) => ({ text, ctx: null })),
  };
}

/**
 * The lines that replace the k matched lines at `pos`: a context line is written
 * as the file's own matched line, never the patch's; at tier 2 every other line
 * is re-indented from the patch's first old line to the file's first matched line.
 * With no old lines there is nothing to match against, so the new lines are
 * written as they are.
 */
function replacement(fileLines: string[], o: LN[], n: LN[], tier: number, pos: number): string[] {
  if (o.length === 0) return n.map((e) => e.text);
  const F = leadWs(fileLines[pos] ?? '');
  const P = leadWs(o[0]!.text);
  const out: string[] = [];
  for (const e of n) {
    if (e.ctx !== null) {
      out.push(fileLines[pos + e.ctx]!);
      continue;
    }
    let t = e.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6).
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const isBodyLine = (l: string): boolean =>
  l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');

/** The path after `--- `/`+++ `: the text after the four characters, up to the first tab, trimmed. */
function parsePathLine(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function resolveUni(s: UniSection): { oldP: string | null; newP: string | null } {
  let oldP: string | null;
  let newP: string | null;
  if (s.pairOld !== null) {
    oldP = s.pairOld;
    newP = s.pairNew;
  } else if (s.renFrom !== null || s.renTo !== null) {
    oldP = s.renFrom ?? s.diffOld;
    newP = s.renTo ?? s.diffNew;
  } else {
    oldP = s.diffOld;
    newP = s.diffNew;
  }
  const norm = (p: string | null): string | null => {
    if (p === null) return null;
    const q = stripAB(p);
    return q === '/dev/null' ? null : q;
  };
  return { oldP: norm(oldP), newP: norm(newP) };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        diffOld: m[1]!,
        diffNew: m[2]!,
        pairOld: null,
        pairNew: null,
        renFrom: null,
        renTo: null,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const bl = lines[j]!;
        // The body ends at a `--- ` line followed by a `+++ ` line, even though
        // such a line starts with `-`.
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (!isBodyLine(bl)) break;
        body.push(bl);
        j++;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, body });
      i = j;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nextIsPlus = (lines[i + 1] ?? '').startsWith('+++ ');
      if (cur !== null && cur.hunks.length === 0) {
        // Inside a section's header: a `--- ` line must be followed by `+++ `.
        if (!nextIsPlus) throw new Exit2(`error: parse ${i + 2}`);
        if (cur.pairOld === null) {
          cur.pairOld = parsePathLine(line);
          cur.pairNew = parsePathLine(lines[i + 1]!);
        }
        i += 2;
        continue;
      }
      if (nextIsPlus) {
        // A new section, outside any header.
        cur = {
          diffOld: null,
          diffNew: null,
          pairOld: parsePathLine(line),
          pairNew: parsePathLine(lines[i + 1]!),
          renFrom: null,
          renTo: null,
          isCreate: false,
          isDelete: false,
          hunks: [],
        };
        sections.push(cur);
        i += 2;
        continue;
      }
      // A stray `--- ` line outside a header: prose, ignored.
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Header lines before the first hunk.
      if (line.startsWith('rename from ')) cur.renFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity
      // index`, `Index:` and any other line are ignored.
      i++;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoBreak(body: string[]): boolean {
  let lastIdx = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith(' ') || l.startsWith('+') || l === '') lastIdx = k;
  }
  return lastIdx >= 0 && body[lastIdx + 1] !== undefined && body[lastIdx + 1]!.startsWith('\\');
}

/** True when a `\` line follows the last `+` line of any of the section's hunks. */
function createNoBreak(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.startsWith('+')) {
        const nx = body[k + 1];
        return nx !== undefined && nx.startsWith('\\');
      }
    }
  }
  return false;
}

function applyHunk(file: FileState, hunk: Hunk, d: number, strict: boolean, path: string): { file: FileState; d: number } {
  const { o, n } = buildON(hunk.body);
  const noBreak = hunkNoBreak(hunk.body);
  if (o.length === 0 && n.length === 0) return { file, d };
  if (o.length === 0) {
    // N is inserted after the first A + d lines (all of them when the file has fewer).
    const at = Math.min(Math.max(hunk.a + d, 0), file.lines.length);
    const lines2 = [...file.lines.slice(0, at), ...n.map((e) => e.text), ...file.lines.slice(at)];
    const touchesEnd = at >= file.lines.length;
    return { file: { br: file.br, lines: lines2, final: touchesEnd ? !noBreak : file.final }, d: d + n.length };
  }
  const found = findTier(file.lines, o.map((e) => e.text), strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.occ[0]!;
  let best = Math.abs(pos - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      best = dist;
      pos = p;
    }
  }
  const repl = replacement(file.lines, o, n, found.tier, pos);
  const lines2 = [...file.lines.slice(0, pos), ...repl, ...file.lines.slice(pos + o.length)];
  const touchesEnd = pos + o.length >= file.lines.length;
  return { file: { br: file.br, lines: lines2, final: touchesEnd ? !noBreak : file.final }, d: d + (n.length - o.length) };
}

function unifiedEdit(s: UniSection, strict: boolean): Edit {
  return (tree) => {
    const { oldP, newP } = resolveUni(s);
    if (newP === null || s.isDelete) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return null;
    }
    if (oldP === null || s.isCreate) {
      const p = newP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const l of h.body) if (l.startsWith('+')) plus.push(l.slice(1));
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (createNoBreak(s.hunks) ? '' : '\n'));
      return null;
    }
    const oldPath = oldP;
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const isMove = oldPath !== newP;
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let file = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const r = applyHunk(file, h, d, strict, oldPath);
      file = r.file;
      d = r.d;
    }
    const text = joinFile(file);
    if (isMove) {
      tree.now.set(oldPath, null);
      tree.now.set(newP, text);
      return [oldPath, newP];
    }
    tree.now.set(oldPath, text);
    return null;
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7).
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0; // index after the previous block's `>>>>>>> REPLACE` line
  let i = 0;
  while (true) {
    let s = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    // The path is the nearest line before the SEARCH line, after the previous
    // block's REPLACE line, that is not blank and does not start with ```.
    let path: string | null = null;
    for (let k = s - 1; k >= searchFrom; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return null;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const file = splitFile(before);
    const found = findTier(file.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const { o, n } = plainON(oldLines, newLines);
    const repl = replacement(file.lines, o, n, found.tier, pos);
    tree.now.set(path, joinFile({ br: file.br, lines: [...file.lines.slice(0, pos), ...repl, ...file.lines.slice(pos + oldLines.length)], final: file.final }));
    return null;
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8).
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const startKind = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = startKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = l.slice(prefix.length).trim();
    const raw: Array<{ text: string; no: number }> = [];
    let j = i + 1;
    while (j < last && startKind(lines[j]!) === null) {
      raw.push({ text: lines[j]!, no: j + 1 });
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(v4aEdit(kind, path, raw, i + 1, strict));
    i = j;
  }
  return edits;
}

function v4aEdit(kind: 'add' | 'delete' | 'update', path: string, raw: Array<{ text: string; no: number }>, lineNo: number, strict: boolean): Edit {
  let addLines: string[] = [];
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  if (kind === 'add') {
    for (const { text, no } of raw) {
      if (text.startsWith('+')) addLines.push(text.slice(1));
      else if (text === '') addLines.push('');
      else throw new Exit2(`error: parse ${no}`);
    }
  } else if (kind === 'delete') {
    const bad = raw.find((r) => !blank(r.text));
    if (bad !== undefined) throw new Exit2(`error: parse ${bad.no}`);
  } else {
    let k = 0;
    if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
      moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
      k = 1;
    }
    let cur: VChunk | null = null;
    let started = false;
    while (k < raw.length) {
      const { text, no } = raw[k]!;
      if (text.startsWith('@@')) {
        cur = { anchor: text.slice(2).trim(), eof: false, body: [] };
        chunks.push(cur);
        started = true;
        k++;
        continue;
      }
      if (text === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${no}`);
        cur.eof = true;
        cur = null;
        k++;
        continue;
      }
      if (text.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${no}`);
      if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
        if (cur === null) {
          if (!started) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
            started = true;
          } else if (blank(text)) {
            // A blank line between chunks is ignored.
            k++;
            continue;
          } else {
            throw new Exit2(`error: parse ${no}`);
          }
        }
        cur.body.push(text);
        k++;
        continue;
      }
      throw new Exit2(`error: parse ${no}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
  }
  return (tree) => {
    if (kind === 'add') {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      return null;
    }
    if (kind === 'delete') {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return null;
    }
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let file = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const at = findSingle(file.lines, chunk.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = buildON(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? file.lines.length : cursor;
        file = { br: file.br, lines: [...file.lines.slice(0, at), ...n.map((e) => e.text), ...file.lines.slice(at)], final: file.final };
        cursor = at + n.length;
        continue;
      }
      const found = findTierEof(file.lines, o.map((e) => e.text), strict, cursor, chunk.eof);
      if (found === null) throw new Fail('no-match', path);
      const repl = replacement(file.lines, o, n, found.tier, found.pos);
      file = {
        br: file.br,
        lines: [...file.lines.slice(0, found.pos), ...repl, ...file.lines.slice(found.pos + o.length)],
        final: file.final,
      };
      cursor = found.pos + repl.length;
    }
    const text = joinFile(file);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      return [path, moveTo];
    }
    tree.now.set(path, text);
    return null;
  };
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is. */
function findSingle(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/** The first occurrence of O at or after `from`, at the first tier with one; an end-of-file chunk takes only an occurrence ending at the file's last line. */
function findTierEof(lines: string[], o: string[], strict: boolean, from: number, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from).filter((p) => !eof || p + o.length === lines.length);
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC.md section 4).
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9).
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC.md sections 1, 2 and 10).
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Array<[string, string]> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv !== null && mv !== undefined) moves.push(mv);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // What changed, against the tree as the patch found it.
  const changes = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changes.set(p, { was, now });
  }
  const claimed = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of moves) {
    const oc = changes.get(oldP);
    const nc = changes.get(newP);
    if (
      oc !== undefined &&
      nc !== undefined &&
      oc.was !== null &&
      oc.now === null &&
      nc.was === null &&
      nc.now !== null &&
      !claimed.has(oldP) &&
      !claimed.has(newP)
    ) {
      claimed.add(oldP);
      claimed.add(newP);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const [p, c] of changes) {
    if (claimed.has(p)) continue;
    const k = c.was === null ? 'A' : c.now === null ? 'D' : 'M';
    rows.push({ key: p, line: `${k} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, c] of changes) if (c.now === null) rmSync(p, { force: true });
    for (const [p, c] of changes) {
      if (c.now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
