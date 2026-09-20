// public/topic.js
// 토픽 상세/문서 페이지. Notion 스타일 마크다운 문서 편집 + 참여/투표/꾸미기/의견/파일/하위토픽.

const params = new URLSearchParams(location.search);
const WS_ID = params.get('ws');
const TOPIC_ID = params.get('topic');
const LS_KEY = 'collab-meeting-identity';

const state = { workspace: null, topic: null, me: null, socket: null, saveTimer: null, previewOn: false };

const NODE_COLORS = ['#6b5cff', '#22a06b', '#f0a020', '#e0563f', '#0ea5e9', '#a855f7', '#ec4899', '#14b8a6', '#64748b'];
const AVATAR_COLORS = ['#6b5cff', '#22a06b', '#f0a020', '#e0563f', '#0ea5e9', '#a855f7', '#ec4899'];

// ---------- API ----------
const api = {
  async req(method, path, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(path, opt);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  },
  get(p) { return this.req('GET', p); },
  post(p, b) { return this.req('POST', p, b || {}); },
  patch(p, b) { return this.req('PATCH', p, b || {}); },
};

// ---------- 유틸 ----------
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) { if (c == null) continue; node.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return node;
};
const colorFor = (id) => { let h = 0; for (const ch of id || '') h = (h * 31 + ch.charCodeAt(0)) % AVATAR_COLORS.length; return AVATAR_COLORS[h]; };
const nameOf = (id) => state.workspace?.participants.find((p) => p.id === id)?.name || '?';
const initials = (n) => (n || '?').trim().slice(0, 2);
function toast(msg, accent = false) { const t = el('div', { class: `toast ${accent ? 'accent' : ''}` }, msg); $('#toasts').append(t); setTimeout(() => t.remove(), 4000); }
function fmtSize(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
function getIdentity() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}')[WS_ID] || null; } catch { return null; } }
function saveIdentity(p) { const all = (() => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; } })(); all[WS_ID] = { participantId: p.id, name: p.name }; localStorage.setItem(LS_KEY, JSON.stringify(all)); }

// ---------- 마크다운 렌더러 (체크박스/인용 포함) ----------
function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = (md || '').split('\n');
  let html = '', inList = false;
  const inline = (t) => t
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  for (const line of lines) {
    const t = inline(esc(line));
    const cb = /^\s*-\s+\[([ xX])\]\s+(.*)$/.exec(line);
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (cb) {
      if (!inList) { html += '<ul class="md-checklist">'; inList = true; }
      const checked = cb[1].toLowerCase() === 'x';
      html += `<li class="md-check"><input type="checkbox" disabled ${checked ? 'checked' : ''}/> ${inline(esc(cb[2]))}</li>`;
      continue;
    }
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(esc(li[1]))}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (/^#\s/.test(line)) html += `<h1>${inline(esc(line.slice(2)))}</h1>`;
    else if (/^##\s/.test(line)) html += `<h2>${inline(esc(line.slice(3)))}</h2>`;
    else if (/^###\s/.test(line)) html += `<h3>${inline(esc(line.slice(4)))}</h3>`;
    else if (/^>\s/.test(line)) html += `<blockquote>${inline(esc(line.slice(2)))}</blockquote>`;
    else if (line.trim() === '') html += '<br/>';
    else html += `<p>${t}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

// ---------- 파일 업로드 ----------
function fileToBase64(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = reject; r.readAsDataURL(file); });
}
async function uploadFile(file) { return api.post('/api/upload', { name: file.name, mime: file.type, dataBase64: await fileToBase64(file) }); }

// ---------- WebSocket ----------
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}`);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'subscribe', workspaceId: WS_ID })));
  socket.addEventListener('message', (ev) => { try { handleEvent(JSON.parse(ev.data)); } catch {} });
  socket.addEventListener('close', () => setTimeout(connectSocket, 1500));
  state.socket = socket;
}
function handleEvent(event) {
  if (event.type === 'topic_updated' && event.topic.id === TOPIC_ID) {
    const editing = document.activeElement === $('#doc-editor');
    const prevDoc = state.topic?.document;
    state.topic = event.topic;
    syncTopicInWorkspace(event.topic);
    // 내가 편집 중이 아니고 문서가 바뀌었으면 반영
    if (!editing && event.topic.document !== prevDoc) $('#doc-editor').value = event.topic.document || '';
    renderSidebar();
    renderDocMeta();
  } else if (event.type === 'opinion_added' && event.topicId === TOPIC_ID) {
    state.topic = event.topic;
    syncTopicInWorkspace(event.topic);
    if (event.opinion.authorId !== state.me?.id) toast(`💬 ${nameOf(event.opinion.authorId)}님의 의견`, true);
    renderOpinions();
    renderSidebar();
  } else if (event.type === 'comment_added' && event.topicId === TOPIC_ID) {
    const op = state.topic.opinions.find((o) => o.id === event.opinionId);
    if (op && !op.comments.find((c) => c.id === event.comment.id)) op.comments.push(event.comment);
    renderOpinions();
  } else if (event.type === 'opinion_deleted' && event.topicId === TOPIC_ID) {
    state.topic = event.topic;
    syncTopicInWorkspace(event.topic);
    renderOpinions();
    renderSidebar();
    renderDocMeta();
  } else if (event.type === 'opinion_updated' && event.topicId === TOPIC_ID) {
    state.topic = event.topic;
    syncTopicInWorkspace(event.topic);
    renderOpinions();
  } else if (event.type === 'comment_updated' && event.topicId === TOPIC_ID) {
    const op = state.topic.opinions.find((o) => o.id === event.opinionId);
    const cm = op?.comments.find((c) => c.id === event.comment.id);
    if (cm) { cm.content = event.comment.content; cm.editedAt = event.comment.editedAt; }
    renderOpinions();
  } else if (event.type === 'comment_deleted' && event.topicId === TOPIC_ID) {
    const op = state.topic.opinions.find((o) => o.id === event.opinionId);
    if (op) op.comments = op.comments.filter((c) => c.id !== event.commentId);
    renderOpinions();
  } else if (event.type === 'topic_deleted') {
    const ids = new Set(event.deletedIds || [event.topicId]);
    if (ids.has(TOPIC_ID)) {
      // 지금 보고 있는 토픽이 삭제됨 → 캔버스로 이동
      toast('이 토픽이 삭제되었습니다. 캔버스로 이동합니다.');
      setTimeout(() => { location.href = `/?ws=${WS_ID}`; }, 1200);
    } else {
      state.workspace.topics = state.workspace.topics.filter((t) => !ids.has(t.id));
      renderSidebar();
    }
  } else if (event.type === 'participant_joined') {
    if (!state.workspace.participants.find((p) => p.id === event.participant.id)) state.workspace.participants.push(event.participant);
    renderSidebar();
  }
}
function syncTopicInWorkspace(t) {
  if (!state.workspace) return;
  const i = state.workspace.topics.findIndex((x) => x.id === t.id);
  if (i >= 0) state.workspace.topics[i] = t; else state.workspace.topics.push(t);
}

// ---------- 문서 자동 저장 ----------
function scheduleSave() {
  $('#save-state').textContent = '저장 중...';
  $('#save-state').className = 'save-state saving';
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveDoc, 700);
}
async function saveDoc() {
  try {
    const document = $('#doc-editor').value;
    const title = $('#doc-title').value.trim();
    const patch = { document };
    if (title && title !== state.topic.title) patch.title = title;
    const updated = await api.patch(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}`, patch);
    state.topic = updated;
    syncTopicInWorkspace(updated);
    $('#save-state').textContent = '저장됨';
    $('#save-state').className = 'save-state';
  } catch (err) {
    $('#save-state').textContent = '저장 실패';
    $('#save-state').className = 'save-state fail';
    toast('문서 저장 실패: ' + err.message);
  }
}

// ---------- 렌더링 ----------
function renderDocMeta() {
  const t = state.topic;
  $('#doc-title').value = t.title;
  const main = $('#topic-title-main');
  if (main) main.textContent = t.title;
  const badge = $('#doc-badge');
  badge.className = `status-badge ${t.status}`;
  badge.textContent = t.status === 'decided' ? '✅ 완료' : '🕓 논의 중';
  $('#topic-status-top').textContent = `${state.workspace.name} · ${t.status === 'decided' ? '완료된 토픽' : '논의 중'}`;
  document.body.classList.toggle('is-decided', t.status === 'decided');
  const cnt = $('#tab-op-count');
  if (cnt) cnt.textContent = t.opinions.length;
  updateGenerateDocButton();
}

function renderSidebar() {
  const t = state.topic;
  const isMember = t.members.includes(state.me.id);

  // 완료 조건 안내
  const children = state.workspace.topics.filter((x) => x.parentId === t.id);
  const isLeaf = children.length === 0;
  const undecidedChildren = children.filter((c) => c.status !== 'decided');
  const notVoted = t.members.filter((m) => !t.checks.includes(m));
  const info = $('#decision-info');
  info.innerHTML = '';
  info.append(el('div', { class: `decide-badge ${t.status}` }, t.status === 'decided' ? '✅ 이 토픽은 완료되었습니다' : '🕓 아직 완료되지 않았습니다'));
  const cond = el('ul', { class: 'cond-list' });
  cond.append(el('li', { class: t.members.length && notVoted.length === 0 ? 'ok' : 'no' },
    t.members.length === 0 ? '참여자가 없습니다 (참여 후 투표 필요)'
      : notVoted.length === 0 ? `참여자 전원(${t.members.length}명) 찬성 완료` : `${notVoted.length}명이 아직 찬성하지 않음`));
  cond.append(el('li', { class: isLeaf || undecidedChildren.length === 0 ? 'ok' : 'no' },
    isLeaf ? '최하단 토픽 (하위 조건 없음)' : undecidedChildren.length === 0 ? `하위 토픽 ${children.length}개 모두 완료` : `하위 토픽 ${undecidedChildren.length}개 미완료`));
  info.append(cond);

  // 색상 팔레트
  const pal = $('#palette'); pal.innerHTML = '';
  for (const c of NODE_COLORS) {
    pal.append(el('button', { class: `swatch ${t.color === c ? 'active' : ''}`, style: `background:${c}`, onclick: () => updateStyle({ color: c }) }));
  }
  $('#btn-remove-img').classList.toggle('hidden', !t.imageUrl);

  // 참여자 / 투표
  const mem = $('#members'); mem.innerHTML = '';
  for (const m of t.members) {
    const checked = t.checks.includes(m);
    mem.append(el('span', { class: `chip ${checked ? 'checked' : ''}` }, [checked ? '✔ ' : '', nameOf(m)]));
  }
  if (t.members.length === 0) mem.append(el('span', { class: 'chip' }, '아직 참여자 없음'));

  const acts = $('#member-actions'); acts.innerHTML = '';
  if (isMember) {
    acts.append(
      el('button', { class: 'ghost', onclick: leaveTopic }, '토픽 나가기'),
      el('button', { onclick: toggleCheck }, t.checks.includes(state.me.id) ? '찬성 취소' : '찬성 투표 ✔'),
    );
  } else {
    acts.append(el('button', { onclick: joinTopic }, '이 토픽에 참여하기'));
  }

  // 하위 토픽 목록
  const sl = $('#sub-list'); sl.innerHTML = '';
  for (const c of children) {
    sl.append(el('li', { class: 'sub-item' }, [
      el('a', { href: `/topic.html?ws=${WS_ID}&topic=${c.id}` }, (c.status === 'decided' ? '✅ ' : '🕓 ') + c.title),
    ]));
  }

  renderOpinions();
}

function renderOpinions() {
  const t = state.topic;
  const wrap = $('#opinions'); wrap.innerHTML = '';
  if (t.opinions.length === 0) {
    wrap.append(el('div', { class: 'chat-empty' }, '아직 의견이 없습니다. 아래 "의견 추가"로 첫 의견을 남겨보세요. (제목 + Markdown 본문)'));
  }
  for (const op of t.opinions) wrap.append(renderOpinion(op));
  wrap.scrollTop = wrap.scrollHeight;

  // 하단: "의견 추가" 버튼만 (실제 작성은 모달에서)
  const formWrap = $('#opinion-form'); formWrap.innerHTML = '';
  if (t.members.includes(state.me.id)) {
    formWrap.append(el('button', { class: 'add-op-btn', onclick: openOpinionModal }, '✍️ 의견 추가'));
  } else {
    formWrap.append(el('button', { class: 'add-op-btn', onclick: joinTopic }, '이 토픽에 참여하고 의견 남기기'));
  }
}

// 의견 작성 모달 열기 (새 작성)
function openOpinionModal() {
  state.editingOpinionId = null;
  $('#op-title').value = '';
  $('#op-input').value = '';
  $('#op-files').value = '';
  $('#op-preview').innerHTML = '';
  $('#op-modal-preview').classList.add('hidden');
  $('#op-input').classList.remove('hidden');
  $('#btn-op-preview').textContent = '미리보기';
  $('#btn-op-submit').textContent = '의견 업로드 ➤';
  const fileLabel = document.querySelector('#op-modal .file-label');
  if (fileLabel) fileLabel.style.display = '';
  const h2 = document.querySelector('#op-modal h2'); if (h2) h2.textContent = '의견 작성';
  $('#op-modal').classList.remove('hidden');
  $('#op-title').focus();
}
function closeOpinionModal() { $('#op-modal').classList.add('hidden'); }

function renderOpinion(op) {
  const isMine = op.authorId === state.me.id;
  const isHost = state.me.role === 'host';
  const wrap = el('div', { class: `chat-msg ${isMine ? 'mine' : ''}` });

  wrap.append(el('span', { class: 'avatar sm chat-avatar', style: `background:${colorFor(op.authorId)}` }, initials(nameOf(op.authorId))));

  const bubble = el('div', { class: 'chat-bubble' });
  const head = el('div', { class: 'chat-msg-head' }, [
    el('span', { class: 'author' }, nameOf(op.authorId)),
    el('span', { class: 'time' }, new Date(op.createdAt).toLocaleString('ko-KR') + (op.editedAt ? ' (수정됨)' : '')),
  ]);
  if (isMine || isHost) {
    head.append(el('button', { class: 'op-del', title: '의견 수정', onclick: () => startEditOpinion(op) }, '✏️'));
    head.append(el('button', { class: 'op-del', title: '의견 삭제', onclick: () => deleteOpinion(op.id) }, '🗑'));
  }
  bubble.append(head);

  if (op.title) bubble.append(el('div', { class: 'chat-msg-title' }, op.title));
  if (op.content) bubble.append(el('div', { class: 'chat-msg-body', html: renderMarkdown(op.content) }));

  if (op.attachments?.length) {
    const at = el('div', { class: 'attachments' });
    for (const a of op.attachments) {
      if ((a.mime || '').startsWith('image/')) at.append(el('a', { href: a.url, target: '_blank', class: 'attach-img' }, [el('img', { src: a.url, alt: a.name })]));
      else at.append(el('a', { href: a.url, target: '_blank', download: a.name, class: 'attach-file' }, [el('span', {}, '📄'), el('span', {}, a.name), el('span', { class: 'file-size' }, fmtSize(a.size))]));
    }
    bubble.append(at);
  }

  if (op.comments.length) {
    const cw = el('div', { class: 'chat-replies' });
    cw.append(el('div', { class: 'comments-label' }, `💬 답글 ${op.comments.length}`));
    for (const c of op.comments) {
      const canEdit = c.authorId === state.me.id || state.me.role === 'host';
      cw.append(el('div', { class: 'comment' }, [
        el('span', { class: 'avatar xs', style: `background:${colorFor(c.authorId)}` }, initials(nameOf(c.authorId))),
        el('span', { class: 'author' }, nameOf(c.authorId)),
        el('span', { class: 'c-body' }, c.content + (c.editedAt ? ' (수정됨)' : '')),
        canEdit ? el('button', { class: 'c-edit', title: '답글 수정', onclick: () => startEditComment(op, c) }, '✏️') : null,
        canEdit ? el('button', { class: 'c-edit c-del', title: '답글 삭제', onclick: () => deleteComment(op, c) }, '🗑') : null,
      ]));
    }
    bubble.append(cw);
  }

  if (state.topic.members.includes(state.me.id)) {
    const input = el('input', { placeholder: '답글...' });
    let sending = false;
    const submit = async () => {
      if (sending) return; // 연타 방지
      const content = input.value.trim(); if (!content) return;
      sending = true;
      try {
        await api.post(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}/opinions/${op.id}/comments`, { authorId: state.me.id, content });
        input.value = '';
      } catch (e) { toast('답글 등록 실패: ' + e.message); }
      finally { sending = false; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    bubble.append(el('div', { class: 'chat-reply-form' }, [input, el('button', { class: 'mini', onclick: submit }, '답글')]));
  }
  wrap.append(bubble);
  return wrap;
}

// 의견 삭제
async function deleteOpinion(opinionId) {
  if (!confirm('이 의견을 삭제할까요?')) return;
  try {
    state.topic = await api.req('DELETE', `/api/workspaces/${WS_ID}/topics/${TOPIC_ID}/opinions/${opinionId}`);
    syncTopicInWorkspace(state.topic);
    renderSidebar();
    renderDocMeta();
    toast('의견을 삭제했습니다.');
  } catch (e) { toast('삭제 실패: ' + e.message); }
}

// 의견 수정: 작성 모달을 편집 모드로 연다
function startEditOpinion(op) {
  state.editingOpinionId = op.id;
  $('#op-title').value = op.title || '';
  $('#op-input').value = op.content || '';
  $('#op-preview').innerHTML = '';
  $('#op-modal-preview').classList.add('hidden');
  $('#op-input').classList.remove('hidden');
  $('#btn-op-preview').textContent = '미리보기';
  $('#btn-op-submit').textContent = '수정 저장 ✓';
  // 편집 시에는 새 파일 첨부 입력은 숨김(기존 첨부 유지)
  const fileLabel = document.querySelector('#op-modal .file-label');
  if (fileLabel) fileLabel.style.display = 'none';
  const h2 = document.querySelector('#op-modal h2'); if (h2) h2.textContent = '의견 수정';
  $('#op-modal').classList.remove('hidden');
  $('#op-title').focus();
}

// 댓글 수정 (간단히 prompt)
async function startEditComment(op, c) {
  const next = prompt('답글 수정:', c.content);
  if (next == null) return;
  const content = next.trim();
  if (!content || content === c.content) return;
  try {
    await api.patch(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}/opinions/${op.id}/comments/${c.id}`, { content });
    const fresh = await api.get(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}`);
    state.topic = fresh; syncTopicInWorkspace(fresh);
    renderOpinions();
    toast('답글을 수정했습니다.');
  } catch (e) { toast('수정 실패: ' + e.message); }
}

// 답글 삭제
async function deleteComment(op, c) {
  if (!confirm('이 답글을 삭제할까요?')) return;
  try {
    await api.req('DELETE', `/api/workspaces/${WS_ID}/topics/${TOPIC_ID}/opinions/${op.id}/comments/${c.id}`);
    const fresh = await api.get(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}`);
    state.topic = fresh; syncTopicInWorkspace(fresh);
    renderOpinions();
    toast('답글을 삭제했습니다.');
  } catch (e) { toast('삭제 실패: ' + e.message); }
}

// ---------- 액션 ----------
async function updateStyle(patch) { try { state.topic = await api.patch(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}`, patch); syncTopicInWorkspace(state.topic); renderSidebar(); renderDocMeta(); } catch (e) { toast('수정 실패: ' + e.message); } }
async function joinTopic() { state.topic = await api.post(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}/join`, { participantId: state.me.id }); syncTopicInWorkspace(state.topic); renderSidebar(); }
async function leaveTopic() { state.topic = await api.post(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}/leave`, { participantId: state.me.id }); syncTopicInWorkspace(state.topic); renderSidebar(); }
async function toggleCheck() { state.topic = await api.post(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}/check`, { participantId: state.me.id }); syncTopicInWorkspace(state.topic); renderSidebar(); renderDocMeta(); }

async function addOpinion() {
  // 연타로 인한 중복 등록 방지
  if (state.submittingOpinion) return;
  const title = $('#op-title').value.trim();
  const content = $('#op-input').value.trim();

  // 편집 모드: 기존 의견 수정 (PATCH)
  if (state.editingOpinionId) {
    if (!content) return toast('의견 본문을 입력하세요.');
    state.submittingOpinion = true;
    const btn = $('#btn-op-submit'); if (btn) btn.disabled = true;
    try {
      await api.patch(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}/opinions/${state.editingOpinionId}`, { title, content });
      const fresh = await api.get(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}`);
      state.topic = fresh; syncTopicInWorkspace(fresh);
      state.editingOpinionId = null;
      closeOpinionModal();
      renderOpinions(); renderSidebar(); renderDocMeta();
      toast('의견을 수정했습니다.');
    } catch (e) { toast('수정 실패: ' + e.message); }
    finally { state.submittingOpinion = false; if (btn) btn.disabled = false; }
    return;
  }

  const fileInput = $('#op-files');
  const files = fileInput ? [...fileInput.files] : [];
  if (!content && !files.length) return toast('의견 본문 또는 파일을 입력하세요.');
  state.submittingOpinion = true;
  const submitBtn = $('#btn-op-submit'); if (submitBtn) submitBtn.disabled = true;
  try {
    let attachments = [];
    if (files.length) { toast(`파일 ${files.length}개 업로드 중...`); attachments = await Promise.all(files.map(uploadFile)); }
    const { analysis } = await api.post(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}/opinions`, { authorId: state.me.id, title, content, attachments });
    const fresh = await api.get(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}`); state.topic = fresh; syncTopicInWorkspace(fresh);
    closeOpinionModal();
    renderSidebar();
    renderDocMeta();
    if (analysis?.summary) toast('🤖 ' + analysis.summary, analysis.results?.some((r) => r.type === 'duplicate' || r.type === 'conflict'));
  } catch (e) {
    toast('등록 실패: ' + e.message);
  } finally {
    state.submittingOpinion = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function addSubtopic() {
  const input = $('#sub-title'); const title = input.value.trim(); if (!title) return;
  // LLM 유사 토픽 확인
  try {
    const { similar } = await api.post(`/api/workspaces/${WS_ID}/topics/similar`, { title });
    if (similar && similar.length) {
      const lines = similar.map((s) => `• ${s.title}${s.reason ? ` — ${s.reason}` : ''}`).join('\n');
      const ok = confirm(`⚠️ 비슷한 토픽이 존재합니다:\n\n${lines}\n\n그래도 "${title}" 토픽을 새로 만드시겠습니까?`);
      if (!ok) return;
    }
  } catch { /* 유사 검사 실패 시 생성 진행 */ }
  await api.post(`/api/workspaces/${WS_ID}/topics`, { title, createdBy: state.me.id, parentId: TOPIC_ID });
  input.value = '';
  const ws = await api.get(`/api/workspaces/${WS_ID}`); state.workspace = ws; state.topic = ws.topics.find((t) => t.id === TOPIC_ID);
  renderSidebar();
}

async function suggestSubtopics() {
  const target = $('#suggest-target'); target.innerHTML = '<div class="suggest-box">🤖 추천 생성 중...</div>';
  try {
    const { suggestions } = await api.get(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}/suggest-subtopics`);
    const box = el('div', { class: 'suggest-box' }, [el('div', { class: 'suggest-head' }, '추천 하위 토픽')]);
    if (!suggestions.length) box.append(el('div', {}, '추천할 내용이 없습니다.'));
    for (const s of suggestions) box.append(el('div', { class: 'suggest-item' }, [el('span', {}, s), el('button', { class: 'mini', onclick: async () => {
      await api.post(`/api/workspaces/${WS_ID}/topics`, { title: s, createdBy: state.me.id, parentId: TOPIC_ID });
      target.innerHTML = '';
      const ws = await api.get(`/api/workspaces/${WS_ID}`); state.workspace = ws; state.topic = ws.topics.find((t) => t.id === TOPIC_ID); renderSidebar();
    } }, '＋ 추가')]));
    target.innerHTML = ''; target.append(box);
  } catch (e) { target.innerHTML = `<div class="suggest-box">추천 실패: ${e.message}</div>`; }
}

// 마크다운 툴바: 커서 위치에 삽입 또는 선택 영역 감싸기
function applyMd(btn, taSel = '#doc-editor', onChange = scheduleSave) {
  const ta = $(taSel);
  const start = ta.selectionStart, end = ta.selectionEnd;
  const val = ta.value;
  const wrap = btn.dataset.wrap;
  if (wrap) {
    const sel = val.slice(start, end) || '텍스트';
    ta.value = val.slice(0, start) + wrap + sel + wrap + val.slice(end);
    ta.selectionStart = start + wrap.length; ta.selectionEnd = start + wrap.length + sel.length;
  } else {
    const lineStart = val.lastIndexOf('\n', start - 1) + 1;
    ta.value = val.slice(0, lineStart) + btn.dataset.md + val.slice(lineStart);
    ta.selectionStart = ta.selectionEnd = start + btn.dataset.md.length;
  }
  ta.focus();
  if (onChange) onChange();
}

function togglePreview() {
  state.previewOn = !state.previewOn;
  const pv = $('#doc-preview'), ed = $('#doc-editor');
  if (state.previewOn) { pv.innerHTML = renderMarkdown(ed.value); pv.classList.remove('hidden'); ed.classList.add('hidden'); $('#btn-preview-toggle').textContent = '편집'; }
  else { pv.classList.add('hidden'); ed.classList.remove('hidden'); $('#btn-preview-toggle').textContent = '미리보기'; }
}

// 의견 모달 미리보기 토글
function toggleOpPreview() {
  const pv = $('#op-modal-preview'), ed = $('#op-input');
  const on = pv.classList.contains('hidden');
  if (on) { pv.innerHTML = renderMarkdown(ed.value); pv.classList.remove('hidden'); ed.classList.add('hidden'); $('#btn-op-preview').textContent = '편집'; }
  else { pv.classList.add('hidden'); ed.classList.remove('hidden'); $('#btn-op-preview').textContent = '미리보기'; }
}

// 중앙 탭 전환 (문서 / 의견)
function switchTab(which) {
  const isDoc = which === 'doc';
  $('#tab-doc').classList.toggle('active', isDoc);
  $('#tab-op').classList.toggle('active', !isDoc);
  $('#view-doc').classList.toggle('hidden', !isDoc);
  $('#view-op').classList.toggle('hidden', isDoc);
}

// AI 의견 추합·정리: 현재 의견들을 LLM이 정리해 의견 페이지에 올림
async function synthesizeOpinions() {
  const t = state.topic;
  if (!t.opinions.length) return toast('정리할 의견이 없습니다.');
  toast('🤖 AI가 의견을 정리하는 중...');
  try {
    await api.post(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}/synthesize`, { authorId: state.me.id });
    const fresh = await api.get(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}`);
    state.topic = fresh; syncTopicInWorkspace(fresh);
    switchTab('op');
    renderOpinions(); renderSidebar(); renderDocMeta();
    toast('AI 정리 의견을 의견 페이지에 추가했습니다.');
  } catch (e) { toast('정리 실패: ' + e.message); }
}

// "회의 정리" 버튼 활성화 상태 갱신: 토픽이 완료(전원 찬성)일 때만 활성
function updateGenerateDocButton() {
  const btn = $('#btn-generate-doc');
  const hint = $('#generate-doc-hint');
  if (!btn) return;
  const decided = state.topic.status === 'decided';
  btn.disabled = !decided;
  hint.textContent = decided
    ? '참여자 전원이 찬성했습니다. 정리 문서를 생성할 수 있어요.'
    : '참여자 전원이 찬성하면 활성화됩니다.';
}

// 완료된 토픽의 결론 정리 문서를 LLM으로 생성 → 문서 탭에 표시
async function generateConclusionDoc() {
  if (state.topic.status !== 'decided') return toast('참여자 전원이 찬성해야 정리할 수 있습니다.');
  toast('🤖 회의 결론을 정리하는 중...');
  try {
    const { document } = await api.post(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}/generate-document`, {});
    state.topic.document = document;
    syncTopicInWorkspace(state.topic);
    $('#doc-editor').value = document;
    switchTab('doc');
    if (state.previewOn) { $('#doc-preview').innerHTML = renderMarkdown(document); }
    toast('정리 문서를 생성했습니다. 문서 탭에서 확인하세요.');
  } catch (e) { toast('문서 생성 실패: ' + e.message); }
}

// 다른 하위/형제 토픽 의견과의 충돌 확인
async function checkCrossConflicts() {
  const box = $('#cross-conflict-result');
  box.innerHTML = '<div class="muted" style="font-size:12px">🤖 다른 토픽 의견과 비교 중...</div>';
  try {
    const { findings, summary } = await api.get(`/api/workspaces/${WS_ID}/topics/${TOPIC_ID}/cross-conflicts`);
    box.innerHTML = '';
    box.append(el('div', { class: `cross-summary ${findings.length ? 'warn' : 'ok'}` }, summary));
    for (const f of findings) {
      box.append(el('div', { class: 'cross-item' }, [
        el('div', { class: 'cross-topic' }, `↔ ${f.otherTopicTitle}`),
        el('div', { class: 'cross-detail' }, [
          el('span', {}, `내 의견: ${f.myOpinion}`),
          el('span', {}, `상대: ${f.otherOpinion}`),
          f.reason ? el('span', { class: 'cross-reason' }, f.reason) : (f.shared ? el('span', { class: 'cross-reason' }, `공통 키워드: ${(f.shared || []).join(', ')}`) : null),
        ]),
      ]));
    }
  } catch (e) { box.innerHTML = `<div class="muted">확인 실패: ${e.message}</div>`; }
}

// ---------- 부트스트랩 ----------
async function enter() {
  connectSocket();
  $('#doc-editor').value = state.topic.document || '';
  renderDocMeta();
  renderSidebar();

  // 이벤트 바인딩
  $('#doc-editor').addEventListener('input', scheduleSave);
  $('#doc-title').addEventListener('input', scheduleSave);
  document.querySelectorAll('.md-btn').forEach((b) => b.addEventListener('click', () => applyMd(b)));
  $('#btn-preview-toggle').addEventListener('click', togglePreview);
  // 탭 전환 (문서 / 의견)
  $('#tab-doc').addEventListener('click', () => switchTab('doc'));
  $('#tab-op').addEventListener('click', () => switchTab('op'));
  // AI 보조
  $('#btn-synthesize').addEventListener('click', synthesizeOpinions);
  $('#btn-cross-conflict').addEventListener('click', checkCrossConflicts);
  $('#btn-generate-doc').addEventListener('click', generateConclusionDoc);
  // 의견 작성 모달
  document.querySelectorAll('.md-btn2').forEach((b) => b.addEventListener('click', () => applyMd(b, '#op-input', null)));
  $('#btn-op-preview').addEventListener('click', toggleOpPreview);
  $('#btn-op-submit').addEventListener('click', () => addOpinion());
  $('#btn-close-opmodal').addEventListener('click', closeOpinionModal);
  $('#op-files').addEventListener('change', () => {
    const preview = $('#op-preview'); preview.innerHTML = '';
    for (const f of $('#op-files').files) preview.append(el('span', { class: 'attach-chip' }, `${f.name} (${fmtSize(f.size)})`));
  });
  $('#btn-add-sub').addEventListener('click', addSubtopic);
  $('#btn-suggest').addEventListener('click', suggestSubtopics);
  $('#btn-remove-img').addEventListener('click', () => updateStyle({ imageUrl: null }));
  $('#node-img').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; toast('사진 업로드 중...'); try { const a = await uploadFile(f); await updateStyle({ imageUrl: a.url }); } catch (err) { toast('실패: ' + err.message); } });
  // 문서 안 이미지 삽입
  $('#doc-img').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    toast('이미지 업로드 중...');
    try { const a = await uploadFile(f); const ta = $('#doc-editor'); const pos = ta.selectionStart; ta.value = ta.value.slice(0, pos) + `\n![${a.name}](${a.url})\n` + ta.value.slice(pos); scheduleSave(); } catch (err) { toast('실패: ' + err.message); }
  });

  // 토픽 삭제
  const delBtn = $('#btn-delete-topic');
  delBtn.classList.remove('hidden');
  delBtn.addEventListener('click', async () => {
    const children = state.workspace.topics.filter((t) => t.parentId === TOPIC_ID);
    const msg = children.length
      ? `"${state.topic.title}" 토픽과 하위 토픽 ${children.length}개 이상을 모두 삭제할까요?`
      : `"${state.topic.title}" 토픽을 삭제할까요?`;
    if (!confirm(msg)) return;
    try {
      await api.req('DELETE', `/api/workspaces/${WS_ID}/topics/${TOPIC_ID}`);
      location.href = `/?ws=${WS_ID}`;
    } catch (e) { toast('삭제 실패: ' + e.message); }
  });

  // 완료된 토픽이면 정리 문서 탭을 먼저, 진행 중이면 의견 탭을 먼저 표시
  switchTab(state.topic.status === 'decided' ? 'doc' : 'op');

  $('#doc-app').classList.remove('hidden');
}

async function boot() {
  if (!WS_ID || !TOPIC_ID) { document.body.innerHTML = '<p style="padding:40px">잘못된 접근입니다.</p>'; return; }
  $('#btn-back').addEventListener('click', (e) => { e.preventDefault(); location.href = `/?ws=${WS_ID}`; });

  let ws;
  try { ws = await api.get(`/api/workspaces/${WS_ID}`); } catch { document.body.innerHTML = '<p style="padding:40px">워크스페이스를 찾을 수 없습니다.</p>'; return; }
  state.workspace = ws;
  const topic = ws.topics.find((t) => t.id === TOPIC_ID);
  if (!topic) { document.body.innerHTML = '<p style="padding:40px">토픽을 찾을 수 없습니다.</p>'; return; }
  state.topic = topic;

  // 신원 확보: localStorage에 있으면 재입장, 없으면 이름 입력 게이트
  const prev = getIdentity();
  const doJoin = async (name) => {
    const data = await api.post(`/api/workspaces/${WS_ID}/participants`, { name, participantId: prev?.participantId });
    state.me = data.participant; state.workspace = data.workspace;
    state.topic = data.workspace.topics.find((t) => t.id === TOPIC_ID);
    saveIdentity(state.me);
    enter();
  };
  if (prev) { await doJoin(prev.name); }
  else {
    $('#gate').classList.remove('hidden');
    $('#gate-title').textContent = `"${topic.title}" 토픽에 접근하려면 이름이 필요합니다`;
    $('#btn-gate-enter').addEventListener('click', () => { const n = $('#gate-name').value.trim(); if (!n) return toast('이름을 입력하세요.'); $('#gate').classList.add('hidden'); doJoin(n); });
  }
}

boot();
