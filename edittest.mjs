import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const PORT = 3987, BASE = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['server/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), OPENAI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
const post = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }); return { s: r.status, j: await r.json() }; };
const patch = async (p, b) => { const r = await fetch(BASE + p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }); return { s: r.status, j: await r.json() }; };
const del = async (p) => { const r = await fetch(BASE + p, { method: 'DELETE' }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const get = async (p) => (await fetch(BASE + p)).json();
const R = []; const c = (n, ok, d = '') => { R.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
async function main() {
  for (let i = 0; i < 50; i++) { try { await get('/api/llm-status'); break; } catch { await sleep(200); } }
  const w = (await post('/api/workspaces', { name: 'edit', hostName: 'H' })).j;
  const wid = w.workspace.id, h = w.you;
  const t = (await post(`/api/workspaces/${wid}/topics`, { title: 'T', createdBy: h.id })).j;
  const op = (await post(`/api/workspaces/${wid}/topics/${t.id}/opinions`, { authorId: h.id, title: '제목', content: '내용' })).j;

  // 의견 수정
  const oe = await patch(`/api/workspaces/${wid}/topics/${t.id}/opinions/${op.opinion.id}`, { title: '수정제목', content: '수정내용' });
  c('의견 수정', oe.s === 200 && oe.j.content === '수정내용' && !!oe.j.editedAt);

  // 답글 등록 → 수정 → 삭제
  const cm = (await post(`/api/workspaces/${wid}/topics/${t.id}/opinions/${op.opinion.id}/comments`, { authorId: h.id, content: '답글원본' })).j;
  const ce = await patch(`/api/workspaces/${wid}/topics/${t.id}/opinions/${op.opinion.id}/comments/${cm.id}`, { content: '답글수정' });
  c('답글 수정', ce.s === 200 && ce.j.content === '답글수정');
  const cd = await del(`/api/workspaces/${wid}/topics/${t.id}/opinions/${op.opinion.id}/comments/${cm.id}`);
  c('답글 삭제 (200)', cd.s === 200);
  const fresh = await get(`/api/workspaces/${wid}/topics/${t.id}`);
  c('답글 삭제 반영', fresh.opinions[0].comments.length === 0);

  // 없는 답글 삭제 → 404
  const nf = await del(`/api/workspaces/${wid}/topics/${t.id}/opinions/${op.opinion.id}/comments/nope`);
  c('없는 답글 삭제 404', nf.s === 404);

  // 의견 삭제
  const od = await del(`/api/workspaces/${wid}/topics/${t.id}/opinions/${op.opinion.id}`);
  c('의견 삭제 (200)', od.s === 200);

  const failed = R.filter(x => !x).length;
  console.log(`\n=== ${R.length - failed}/${R.length} 통과 ===`);
  if (failed) console.log('\n--- 서버로그 ---\n' + log);
  await new Promise(r => { server.on('exit', r); server.kill(); setTimeout(r, 800); });
  process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error(e); console.log(log); server.kill(); process.exitCode = 1; });
