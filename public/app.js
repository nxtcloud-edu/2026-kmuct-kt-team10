// public/app.js
// Vanilla JS SPA.
// - 워크스페이스 생성/입장, 초대 링크 입장, 재방문 시 신원 복원(localStorage)
// - Miro 스타일 캔버스: 원형 토픽 노드, 드래그 이동, 화면 패닝, 색상/사진
// - 의견/코멘트, 파일·문서 첨부, LLM 추천/유사도/요약
// - WebSocket 실시간 알림

const state = {
  workspace: null,
  me: null,
  selectedTopicId: null,
  socket: null,
  view: { x: 0, y: 0 }, // 캔버스 패닝 오프셋
};

const AVATAR_COLORS = ['#6b5cff', '#22a06b', '#f0a020', '#e0563f', '#0ea5e9', '#a855f7', '#ec4899'];
const NODE_COLORS = ['#6b5cff', '#22a06b', '#f0a020', '#e0563f', '#0ea5e9', '#a855f7', '#ec4899', '#14b8a6', '#64748b'];
const LS_KEY = 'collab-meeting-identity'; // { [workspaceId]: {participantId, name} }

// ---------- API ----------
const api = {
  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  },
  async patch(path, body) {
    const res = await fetch(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  },
  async get(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  },
};

// ---------- localStorage 신원 저장/복원 ----------
function loadIdentities() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  } catch {
    return {};
  }
}
function saveIdentity(wsId, participant) {
  const all = loadIdentities();
  all[wsId] = { participantId: participant.id, name: participant.name };
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}
function getIdentity(wsId) {
  return loadIdentities()[wsId] || null;
}

// ---------- 유틸 ----------
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
};

function colorFor(id) {
  let h = 0;
  for (const ch of id || '') h = (h * 31 + ch.charCodeAt(0)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[h];
}
function nameOf(id) {
  return state.workspace?.participants.find((p) => p.id === id)?.name || '?';
}
function initials(name) {
  return (name || '?').trim().slice(0, 2);
}
function toast(msg, accent = false) {
  const t = el('div', { class: `toast ${accent ? 'accent' : ''}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function inviteLink() {
  return `${location.origin}/?ws=${state.workspace.id}`;
}

// ---------- WebSocket ----------
function connectSocket(workspaceId) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}`);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'subscribe', workspaceId })));
  socket.addEventListener('message', (ev) => {
    try {
      handleEvent(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  });
  socket.addEventListener('close', () => setTimeout(() => connectSocket(workspaceId), 1500));
  state.socket = socket;
}

function handleEvent(event) {
  switch (event.type) {
    case 'participant_joined':
      if (!state.workspace.participants.find((p) => p.id === event.participant.id)) {
        state.workspace.participants.push(event.participant);
      }
      if (event.participant.id !== state.me?.id) toast(`👋 ${event.participant.name}님이 입장했습니다.`);
      renderParticipants();
      break;
    case 'topic_created':
      if (!state.workspace.topics.find((t) => t.id === event.topic.id)) {
        state.workspace.topics.push(event.topic);
        toast(`🌱 새 토픽: "${event.topic.title}"`);
      }
      renderCanvas();
      break;
    case 'topic_updated':
      mergeTopic(event.topic);
      renderCanvas();
      if (state.selectedTopicId === event.topic.id) renderDetail();
      break;
    case 'opinion_added': {
      mergeTopic(event.topic);
      if (event.opinion.authorId !== state.me?.id) {
        toast(`💬 ${nameOf(event.opinion.authorId)}님이 "${event.topic.title}"에 의견을 남겼습니다.`, true);
      }
      renderCanvas();
      if (state.selectedTopicId === event.topicId) renderDetail();
      break;
    }
    case 'comment_added': {
      const topic = state.workspace.topics.find((t) => t.id === event.topicId);
      const op = topic?.opinions.find((o) => o.id === event.opinionId);
      if (op && !op.comments.find((c) => c.id === event.comment.id)) op.comments.push(event.comment);
      if (event.comment.authorId !== state.me?.id) toast(`↩️ ${nameOf(event.comment.authorId)}님의 코멘트`);
      if (state.selectedTopicId === event.topicId) renderDetail();
      break;
    }
  }
}

function mergeTopic(updated) {
  const idx = state.workspace.topics.findIndex((t) => t.id === updated.id);
  if (idx >= 0) state.workspace.topics[idx] = updated;
  else state.workspace.topics.push(updated);
}

// ---------- 화면 전환 ----------
function enterApp() {
  $('#landing').classList.add('hidden');
  $('#invite').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#ws-info').textContent = `${state.workspace.name} · ${state.me.name} (${state.me.role === 'host' ? '방장' : '참여자'})`;
  $('#ws-id-copy').textContent = state.workspace.id;
  saveIdentity(state.workspace.id, state.me);
  connectSocket(state.workspace.id);
  renderParticipants();
  renderCanvas();
}

// ---------- 렌더링: 참여자 ----------
function renderParticipants() {
  const list = $('#participant-list');
  list.innerHTML = '';
  for (const p of state.workspace.participants) {
    list.append(
      el('li', {}, [
        el('span', { class: 'avatar', style: `background:${colorFor(p.id)}` }, initials(p.name)),
        el('span', {}, p.name + (p.id === state.me?.id ? ' (나)' : '')),
        el('span', { class: 'role' }, p.role === 'host' ? '방장' : '참여자'),
      ]),
    );
  }
}

// ---------- 렌더링: Miro 스타일 캔버스 ----------
const NODE_SIZE = 116; // 원형 노드 지름

function renderCanvas() {
  const nodesLayer = $('#nodes');
  const edges = $('#edges');
  nodesLayer.innerHTML = '';
  edges.innerHTML = '';

  const topics = state.workspace.topics;
  const posById = new Map(topics.map((t) => [t.id, t]));

  // 엣지 (부모-자식 곡선)
  const svgNS = 'http://www.w3.org/2000/svg';
  let maxX = 0, maxY = 0;
  for (const t of topics) {
    maxX = Math.max(maxX, (t.x || 0) + 300);
    maxY = Math.max(maxY, (t.y || 0) + 300);
    if (!t.parentId) continue;
    const p = posById.get(t.parentId);
    if (!p) continue;
    const x1 = (p.x || 0) + NODE_SIZE / 2;
    const y1 = (p.y || 0) + NODE_SIZE / 2;
    const x2 = (t.x || 0) + NODE_SIZE / 2;
    const y2 = (t.y || 0) + NODE_SIZE / 2;
    const mx = (x1 + x2) / 2;
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('class', 'edge');
    path.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
    edges.append(path);
  }
  edges.setAttribute('width', maxX + 200);
  edges.setAttribute('height', maxY + 200);

  if (topics.length === 0) {
    nodesLayer.append(
      el('div', { class: 'empty-hint' }, '아직 안건이 없습니다. 왼쪽에서 최상위 안건을 추가하세요.'),
    );
  }

  // 노드 (원형)
  for (const t of topics) {
    const node = el('div', {
      class: `node ${t.status}`,
      style: `left:${t.x || 0}px; top:${t.y || 0}px; width:${NODE_SIZE}px; height:${NODE_SIZE}px; --node-color:${t.color || '#6b5cff'}`,
      'data-id': t.id,
    });

    if (t.imageUrl) {
      node.append(el('div', { class: 'node-img', style: `background-image:url('${t.imageUrl}')` }));
    }
    const inner = el('div', { class: 'node-inner' }, [
      el('div', { class: 'node-title' }, (t.status === 'decided' ? '✅ ' : '') + t.title),
      el('div', { class: 'node-meta' }, `👤${t.members.length} 💬${t.opinions.length} ✔${t.checks.length}/${t.members.length}`),
    ]);
    node.append(inner);

    makeDraggable(node, t);
    nodesLayer.append(node);
  }

  applyView();
}

// 캔버스 패닝 적용
function applyView() {
  const vp = $('#viewport');
  if (vp) vp.style.transform = `translate(${state.view.x}px, ${state.view.y}px)`;
}

// 노드 드래그 (이동) + 클릭(상세) 구분
function makeDraggable(node, topic) {
  let startX, startY, origX, origY, moved;
  const onDown = (e) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // 캔버스 패닝과 충돌 방지
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    origX = topic.x || 0;
    origY = topic.y || 0;
    node.classList.add('dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };
  const onMove = (e) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    topic.x = origX + dx;
    topic.y = origY + dy;
    node.style.left = topic.x + 'px';
    node.style.top = topic.y + 'px';
    renderEdgesOnly();
  };
  const onUp = async () => {
    node.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    if (moved) {
      // 위치 저장 (실시간 공유)
      try {
        await api.patch(`/api/workspaces/${state.workspace.id}/topics/${topic.id}`, {
          x: Math.round(topic.x),
          y: Math.round(topic.y),
        });
      } catch {
        /* ignore */
      }
    } else {
      selectTopic(topic.id); // 이동 없으면 클릭으로 간주
    }
  };
  node.addEventListener('pointerdown', onDown);
}

// 드래그 중 엣지만 다시 그려 성능 확보
function renderEdgesOnly() {
  const edges = $('#edges');
  const topics = state.workspace.topics;
  const posById = new Map(topics.map((t) => [t.id, t]));
  edges.innerHTML = '';
  const svgNS = 'http://www.w3.org/2000/svg';
  for (const t of topics) {
    if (!t.parentId) continue;
    const p = posById.get(t.parentId);
    if (!p) continue;
    const x1 = (p.x || 0) + NODE_SIZE / 2, y1 = (p.y || 0) + NODE_SIZE / 2;
    const x2 = (t.x || 0) + NODE_SIZE / 2, y2 = (t.y || 0) + NODE_SIZE / 2;
    const mx = (x1 + x2) / 2;
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('class', 'edge');
    path.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
    edges.append(path);
  }
}

// 캔버스 배경 패닝
function setupCanvasPan() {
  const canvas = $('#canvas');
  let panning = false, sx, sy, ox, oy;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node')) return; // 노드 위에서는 패닝하지 않음
    panning = true;
    sx = e.clientX; sy = e.clientY;
    ox = state.view.x; oy = state.view.y;
    canvas.classList.add('panning');
  });
  window.addEventListener('pointermove', (e) => {
    if (!panning) return;
    state.view.x = ox + (e.clientX - sx);
    state.view.y = oy + (e.clientY - sy);
    applyView();
  });
  window.addEventListener('pointerup', () => {
    panning = false;
    canvas.classList.remove('panning');
  });
}

// ---------- 렌더링: 상세 패널 ----------
function selectTopic(topicId) {
  state.selectedTopicId = topicId;
  $('#detail').classList.remove('hidden');
  renderDetail();
}

function renderDetail() {
  const topic = state.workspace.topics.find((t) => t.id === state.selectedTopicId);
  if (!topic) {
    $('#detail').classList.add('hidden');
    return;
  }
  const body = $('#detail-body');
  body.innerHTML = '';

  body.append(el('h2', {}, topic.title));
  body.append(
    el('span', { class: `status-badge ${topic.status}` }, topic.status === 'decided' ? '✅ 완료' : '🕓 논의 중'),
  );

  const isMember = topic.members.includes(state.me.id);

  // --- 꾸미기: 색상 + 사진 ---
  body.append(el('div', { class: 'section-title' }, '노드 꾸미기 (색상 · 사진)'));
  const palette = el('div', { class: 'palette' });
  for (const c of NODE_COLORS) {
    palette.append(
      el('button', {
        class: `swatch ${topic.color === c ? 'active' : ''}`,
        style: `background:${c}`,
        title: c,
        onclick: () => updateTopicStyle(topic.id, { color: c }),
      }),
    );
  }
  body.append(palette);
  const photoRow = el('div', { class: 'btn-row' }, [
    el('label', { class: 'file-label' }, [
      '🖼️ 사진 넣기',
      el('input', {
        type: 'file',
        accept: 'image/*',
        style: 'display:none',
        onchange: (e) => onNodeImagePick(topic.id, e.target.files[0]),
      }),
    ]),
    topic.imageUrl
      ? el('button', { class: 'ghost', onclick: () => updateTopicStyle(topic.id, { imageUrl: null }) }, '사진 제거')
      : null,
  ]);
  body.append(photoRow);

  // --- 참여 멤버 + 찬성 투표 상태 ---
  body.append(el('div', { class: 'section-title' }, '참여자 / 찬성 투표'));
  const chips = el('div', { class: 'member-chips' });
  for (const m of topic.members) {
    const checked = topic.checks.includes(m);
    chips.append(el('span', { class: `chip ${checked ? 'checked' : ''}` }, [checked ? '✔ ' : '', nameOf(m)]));
  }
  if (topic.members.length === 0) chips.append(el('span', { class: 'chip' }, '아직 참여자 없음'));
  body.append(chips);

  const btnRow = el('div', { class: 'btn-row' });
  if (isMember) {
    btnRow.append(
      el('button', { class: 'ghost', onclick: () => leaveTopic(topic.id) }, '토픽 나가기'),
      el(
        'button',
        { onclick: () => toggleCheck(topic.id) },
        topic.checks.includes(state.me.id) ? '찬성 취소' : '찬성 투표 ✔',
      ),
    );
  } else {
    btnRow.append(el('button', { onclick: () => joinTopic(topic.id) }, '이 토픽에 참여하기'));
  }
  body.append(btnRow);

  // --- 하위 토픽 + LLM 추천 ---
  body.append(el('div', { class: 'section-title' }, '하위 토픽'));
  const subInput = el('input', { placeholder: '하위 토픽 제목', id: 'sub-topic-input' });
  const subRow = el('div', { class: 'btn-row' }, [
    el('button', { onclick: () => addSubtopic(topic.id) }, '추가'),
    el('button', { class: 'ghost', onclick: () => suggestSubtopics(topic.id) }, '🤖 LLM 추천'),
  ]);
  body.append(subInput, subRow, el('div', { id: 'suggest-target' }));

  // --- 의견 목록 ---
  body.append(el('div', { class: 'section-title' }, `의견 (${topic.opinions.length})`));
  for (const op of topic.opinions) body.append(renderOpinion(topic, op));

  // --- 의견 작성 (파일 첨부 포함) ---
  if (isMember) {
    const ta = el('textarea', { placeholder: '의견을 입력하세요...', id: 'opinion-input' });
    const fileInput = el('input', { type: 'file', multiple: 'true', id: 'opinion-files', style: 'display:none' });
    const fileList = el('div', { class: 'attach-preview', id: 'attach-preview' });
    fileInput.addEventListener('change', () => renderAttachPreview(fileInput, fileList));
    const form = el('div', { class: 'opinion-form' }, [
      el('div', { style: 'flex:1' }, [
        ta,
        fileList,
        el('div', { class: 'btn-row' }, [
          el('label', { class: 'file-label' }, ['📎 파일/문서 첨부', fileInput]),
          el('button', { class: 'wide', onclick: () => addOpinion(topic.id, fileInput) }, '의견 등록'),
        ]),
      ]),
    ]);
    body.append(form);
  } else {
    body.append(el('p', { class: 'muted', style: 'font-size:13px' }, '의견/파일을 올리려면 먼저 토픽에 참여하세요.'));
  }
}

function renderAttachPreview(fileInput, container) {
  container.innerHTML = '';
  for (const f of fileInput.files) {
    container.append(el('span', { class: 'attach-chip' }, `${f.name} (${fmtSize(f.size)})`));
  }
}

function renderOpinion(topic, op) {
  const wrap = el('div', { class: 'opinion' });
  wrap.append(
    el('div', { class: 'op-head' }, [
      el('span', {
        class: 'avatar sm',
        style: `background:${colorFor(op.authorId)}`,
      }, initials(nameOf(op.authorId))),
      el('span', { class: 'author' }, nameOf(op.authorId)),
      el('span', { class: 'time' }, new Date(op.createdAt).toLocaleString('ko-KR')),
    ]),
  );
  if (op.content) wrap.append(el('div', { class: 'op-body' }, op.content));

  // 첨부파일
  if (op.attachments && op.attachments.length) {
    const at = el('div', { class: 'attachments' });
    for (const a of op.attachments) {
      const isImg = (a.mime || '').startsWith('image/');
      if (isImg) {
        at.append(
          el('a', { href: a.url, target: '_blank', class: 'attach-img' }, [
            el('img', { src: a.url, alt: a.name }),
          ]),
        );
      } else {
        at.append(
          el('a', { href: a.url, target: '_blank', download: a.name, class: 'attach-file' }, [
            el('span', { class: 'file-ico' }, '📄'),
            el('span', {}, `${a.name}`),
            el('span', { class: 'file-size' }, fmtSize(a.size)),
          ]),
        );
      }
    }
    wrap.append(at);
  }

  // 코멘트
  if (op.comments.length) {
    const cwrap = el('div', { class: 'comments' });
    for (const c of op.comments) {
      cwrap.append(el('div', { class: 'comment' }, [el('span', { class: 'author' }, nameOf(c.authorId)), c.content]));
    }
    wrap.append(cwrap);
  }

  // 코멘트 작성
  if (topic.members.includes(state.me.id)) {
    const input = el('input', { placeholder: '코멘트 달기...' });
    const form = el('div', { class: 'comment-form' }, [
      input,
      el('button', {
        class: 'mini',
        onclick: async () => {
          const content = input.value.trim();
          if (!content) return;
          await api.post(
            `/api/workspaces/${state.workspace.id}/topics/${topic.id}/opinions/${op.id}/comments`,
            { authorId: state.me.id, content },
          );
          input.value = '';
        },
      }, '등록'),
    ]);
    wrap.append(form);
  }
  return wrap;
}

// ---------- 파일 업로드 ----------
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result;
      const base64 = String(res).split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function uploadFile(file) {
  const dataBase64 = await fileToBase64(file);
  return api.post('/api/upload', { name: file.name, mime: file.type, dataBase64 });
}

// ---------- 액션 ----------
async function createWorkspace() {
  const name = $('#new-ws-name').value.trim();
  const hostName = $('#new-host-name').value.trim();
  if (!hostName) return toast('이름을 입력하세요.');
  const data = await api.post('/api/workspaces', { name, hostName });
  state.workspace = data.workspace;
  state.me = data.you;
  enterApp();
}

async function joinWorkspace(id, name) {
  id = (id ?? $('#join-ws-id').value.trim());
  // 링크를 붙여넣은 경우 ws 파라미터 추출
  const m = /[?&]ws=([\w-]+)/.exec(id);
  if (m) id = m[1];
  name = (name ?? $('#join-name').value.trim());
  if (!id || !name) return toast('워크스페이스 ID와 이름을 입력하세요.');
  try {
    const prev = getIdentity(id);
    const data = await api.post(`/api/workspaces/${id}/participants`, {
      name,
      participantId: prev?.participantId, // 재방문이면 기존 신원으로
    });
    state.workspace = data.workspace;
    state.me = data.participant;
    if (data.rejoined) toast('이전 기록으로 다시 입장했습니다.');
    enterApp();
  } catch (err) {
    toast('입장 실패: ' + err.message);
  }
}

async function addRootTopic() {
  const title = $('#new-topic-title').value.trim();
  if (!title) return;
  await api.post(`/api/workspaces/${state.workspace.id}/topics`, { title, createdBy: state.me.id });
  $('#new-topic-title').value = '';
}

async function addSubtopic(parentId) {
  const input = $('#sub-topic-input');
  const title = input.value.trim();
  if (!title) return;
  await api.post(`/api/workspaces/${state.workspace.id}/topics`, { title, createdBy: state.me.id, parentId });
  input.value = '';
}

async function joinTopic(topicId) {
  await api.post(`/api/workspaces/${state.workspace.id}/topics/${topicId}/join`, { participantId: state.me.id });
}
async function leaveTopic(topicId) {
  await api.post(`/api/workspaces/${state.workspace.id}/topics/${topicId}/leave`, { participantId: state.me.id });
}
async function toggleCheck(topicId) {
  await api.post(`/api/workspaces/${state.workspace.id}/topics/${topicId}/check`, { participantId: state.me.id });
}

async function updateTopicStyle(topicId, patch) {
  try {
    await api.patch(`/api/workspaces/${state.workspace.id}/topics/${topicId}`, patch);
  } catch (err) {
    toast('수정 실패: ' + err.message);
  }
}

async function onNodeImagePick(topicId, file) {
  if (!file) return;
  try {
    toast('사진 업로드 중...');
    const att = await uploadFile(file);
    await updateTopicStyle(topicId, { imageUrl: att.url });
  } catch (err) {
    toast('사진 업로드 실패: ' + err.message);
  }
}

async function addOpinion(topicId, fileInput) {
  const ta = $('#opinion-input');
  const content = ta.value.trim();
  const files = fileInput ? [...fileInput.files] : [];
  if (!content && files.length === 0) return toast('의견 또는 파일을 입력하세요.');

  let attachments = [];
  if (files.length) {
    toast(`파일 ${files.length}개 업로드 중...`);
    try {
      attachments = await Promise.all(files.map(uploadFile));
    } catch (err) {
      return toast('파일 업로드 실패: ' + err.message);
    }
  }

  const { analysis } = await api.post(
    `/api/workspaces/${state.workspace.id}/topics/${topicId}/opinions`,
    { authorId: state.me.id, content, attachments },
  );
  ta.value = '';
  if (fileInput) fileInput.value = '';
  const preview = $('#attach-preview');
  if (preview) preview.innerHTML = '';
  if (analysis?.summary) {
    const hasWarn = analysis.results?.some((r) => r.type === 'duplicate' || r.type === 'conflict');
    toast(`🤖 ${analysis.summary}`, hasWarn);
  }
}

async function suggestSubtopics(topicId) {
  const target = $('#suggest-target');
  target.innerHTML = '<div class="suggest-box">🤖 추천 생성 중...</div>';
  try {
    const { suggestions } = await api.get(
      `/api/workspaces/${state.workspace.id}/topics/${topicId}/suggest-subtopics`,
    );
    const box = el('div', { class: 'suggest-box' });
    box.append(el('div', { class: 'suggest-head' }, '추천 하위 토픽'));
    if (!suggestions.length) box.append(el('div', {}, '추천할 내용이 없습니다.'));
    for (const s of suggestions) {
      box.append(
        el('div', { class: 'suggest-item' }, [
          el('span', {}, s),
          el('button', {
            class: 'mini',
            onclick: async () => {
              await api.post(`/api/workspaces/${state.workspace.id}/topics`, {
                title: s, createdBy: state.me.id, parentId: topicId,
              });
              target.innerHTML = '';
            },
          }, '＋ 추가'),
        ]),
      );
    }
    target.innerHTML = '';
    target.append(box);
  } catch (err) {
    target.innerHTML = `<div class="suggest-box">추천 실패: ${err.message}</div>`;
  }
}

// 작은 마크다운 렌더러
function renderMarkdown(md) {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    let t = escape(line);
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
    const listMatch = /^(\s*)-\s+(.*)$/.exec(line);
    if (listMatch) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li style="margin-left:${listMatch[1].length * 8}px">${t.replace(/^\s*-\s+/, '')}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (/^#\s/.test(line)) html += `<h1>${t.replace(/^#\s/, '')}</h1>`;
    else if (/^##\s/.test(line)) html += `<h2>${t.replace(/^##\s/, '')}</h2>`;
    else if (/^###\s/.test(line)) html += `<h3>${t.replace(/^###\s/, '')}</h3>`;
    else if (line.trim() === '') html += '<br/>';
    else html += `<p>${t}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

async function showSummary() {
  const modal = $('#summary-modal');
  const content = $('#summary-content');
  content.innerHTML = '🤖 회의 내용을 정리하는 중...';
  modal.classList.remove('hidden');
  try {
    const { markdown } = await api.get(`/api/workspaces/${state.workspace.id}/summary`);
    content.innerHTML = renderMarkdown(markdown);
  } catch (err) {
    content.textContent = '정리 실패: ' + err.message;
  }
}

// ---------- 이벤트 바인딩 ----------
$('#btn-create-ws').addEventListener('click', createWorkspace);
$('#btn-join-ws').addEventListener('click', () => joinWorkspace());
$('#btn-add-root-topic').addEventListener('click', addRootTopic);
$('#btn-summary').addEventListener('click', showSummary);
$('#btn-close-detail').addEventListener('click', () => {
  state.selectedTopicId = null;
  $('#detail').classList.add('hidden');
});
$('#btn-close-summary').addEventListener('click', () => $('#summary-modal').classList.add('hidden'));
$('#btn-copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(inviteLink());
    toast('초대 링크를 복사했습니다. 붙여넣어 공유하세요!');
  } catch {
    toast('복사 실패. 링크: ' + inviteLink());
  }
});
$('#btn-reset-view').addEventListener('click', () => {
  state.view = { x: 0, y: 0 };
  applyView();
});
$('#btn-invite-join').addEventListener('click', () => {
  const name = $('#invite-name').value.trim();
  if (!name) return toast('이름을 입력하세요.');
  joinWorkspace(window.__inviteWsId, name);
});

setupCanvasPan();

// ---------- 초기 진입 처리 ----------
async function boot() {
  const params = new URLSearchParams(location.search);
  const wsId = params.get('ws');

  // LLM 상태 표시
  api.get('/api/llm-status').then((s) => {
    window.__llmEnabled = s.enabled;
    const info = $('#ws-info');
    if (info && !state.workspace) info.textContent = s.enabled ? '🤖 AI LLM 연동됨' : '🔧 규칙 기반 모드';
  }).catch(() => {});

  if (wsId) {
    // 초대 링크로 접속: 재방문이면 자동 입장, 처음이면 이름만 입력받는 화면
    const prev = getIdentity(wsId);
    try {
      const ws = await api.get(`/api/workspaces/${wsId}`);
      window.__inviteWsId = wsId;
      if (prev) {
        // 이전 기록 있음 → 바로 자동 입장
        await joinWorkspace(wsId, prev.name);
        return;
      }
      // 처음 방문 → 간단 입장 화면
      $('#landing').classList.add('hidden');
      $('#invite').classList.remove('hidden');
      $('#invite-title').textContent = `"${ws.name}" 회의에 초대되었습니다`;
      $('#invite-sub').textContent = `참여자 ${ws.participants.length}명 · 토픽 ${ws.topics.length}개`;
      $('#invite-name').focus();
    } catch {
      toast('워크스페이스를 찾을 수 없습니다.');
    }
  }
}

boot();
