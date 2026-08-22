#!/usr/bin/env node
// Reconstructs "where am I" from disk, so a session that dies mid-phase costs
// nothing. Everything it prints is derived from files in the repository — there is
// no state living only in someone's head or in a chat transcript.
//
//   node tools/progress.mjs          brief
//   node tools/progress.mjs --full   brief plus the worklog tail and git log
//   node tools/progress.mjs done <task-id> [note]
//   node tools/progress.mjs start <task-id>
//   node tools/progress.mjs block <task-id> <reason>

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, 'BUILD_STATE.json');
const WORKLOG = join(ROOT, 'docs/WORKLOG.md');

const load = () => JSON.parse(readFileSync(STATE, 'utf8'));
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');

const MARK = { done: '[x]', doing: '[>]', todo: '[ ]', blocked: '[!]' };

function git(args) {
  try { return execFileSync('git', args, { cwd: ROOT, stdio: 'pipe' }).toString().trim(); }
  catch { return ''; }
}

function brief(full) {
  const s = load();
  const phase = s.phases.find((p) => p.id === s.phase);
  console.log(`\n${s.game} — phase ${s.phase}: ${phase.name}`);
  console.log(`gate: ${phase.gate}\n`);

  const tasks = (s.tasks ?? []).filter((t) => t.phase === s.phase);
  if (tasks.length) {
    for (const t of tasks) {
      console.log(`  ${MARK[t.status] ?? '[ ]'} ${t.id}  ${t.title}`);
      if (t.note) console.log(`         ${t.note}`);
    }
    const left = tasks.filter((t) => t.status !== 'done').length;
    console.log(`\n  ${tasks.length - left}/${tasks.length} done in this phase`);
  }

  const next = tasks.find((t) => t.status === 'doing') ?? tasks.find((t) => t.status === 'todo');
  console.log(`\nnext: ${next ? `${next.id} — ${next.title}` : `phase gate — ${phase.gate}`}`);

  const dirty = git(['status', '--porcelain']);
  console.log(`tree: ${dirty ? `${dirty.split('\n').length} uncommitted change(s)` : 'clean'}`);
  console.log(`head: ${git(['log', '-1', '--format=%h %s']) || '(no commits)'}`);

  if (s.openRisks?.length) {
    console.log('\nopen risks:');
    for (const r of s.openRisks) console.log(`  - ${r.split('.')[0]}.`);
  }

  if (full) {
    console.log('\n--- worklog tail ---');
    if (existsSync(WORKLOG)) console.log(readFileSync(WORKLOG, 'utf8').split('\n').slice(-40).join('\n'));
    console.log('\n--- recent commits ---');
    console.log(git(['log', '-12', '--format=%h %ad %s', '--date=short']));
  }
  console.log('');
}

function setStatus(id, status, note) {
  const s = load();
  const t = (s.tasks ?? []).find((x) => x.id === id);
  if (!t) { console.error(`no task ${id}`); process.exit(1); }
  t.status = status;
  if (note) t.note = note; else if (status === 'done') delete t.note;
  const phaseTasks = s.tasks.filter((x) => x.phase === s.phase);
  if (phaseTasks.every((x) => x.status === 'done')) {
    console.log(`every task in ${s.phase} is done — run the gate, then bump "phase" in BUILD_STATE.json`);
  }
  save(s);
  const stamp = new Date().toISOString().slice(0, 10);
  appendFileSync(WORKLOG, `\n- ${stamp} \`${id}\` **${status}** — ${t.title}${note ? `. ${note}` : ''}\n`);
  console.log(`${MARK[status]} ${id} ${t.title}`);
}

const [cmd, id, ...rest] = process.argv.slice(2);
if (cmd === 'done' || cmd === 'start' || cmd === 'block') {
  setStatus(id, cmd === 'start' ? 'doing' : cmd === 'done' ? 'done' : 'blocked', rest.join(' '));
} else {
  brief(cmd === '--full');
}
