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
  openOpinionTopicId: null,
  subParentId: null,
  notifications: [], // 내가 참여한 토픽의 새 의견/답글 알림
  socket: null,
  view: { x: 0, y: 0, scale: 1 }, // 캔버스 패닝 오프셋 + 확대/축소 배율
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
  async del(path) {
    const res = await fetch(path, { method: 'DELETE' });
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
      break;
    case 'opinion_added': {
      mergeTopic(event.topic);
      if (event.opinion.authorId !== state.me?.id) {
        toast(`💬 ${nameOf(event.opinion.authorId)}님이 "${event.topic.title}"에 의견을 남겼습니다.`, true);
        // 내가 참여(멤버)한 토픽이면 알림에 추가
        maybeNotify(event.topic, `💬 ${nameOf(event.opinion.authorId)}님의 새 의견`, event.topicId);
      }
      renderCanvas();
      if (state.openOpinionTopicId === event.topicId) renderOpinionSide();
      break;
    }
    case 'comment_added': {
      const topic = state.workspace.topics.find((t) => t.id === event.topicId);
      const op = topic?.opinions.find((o) => o.id === event.opinionId);
      if (op && !op.comments.find((c) => c.id === event.comment.id)) op.comments.push(event.comment);
      if (event.comment.authorId !== state.me?.id) {
        toast(`↩️ ${nameOf(event.comment.authorId)}님의 답글`);
        if (topic) maybeNotify(topic, `↩️ ${nameOf(event.comment.authorId)}님의 답글`, event.topicId);
      }
      if (state.openOpinionTopicId === event.topicId) renderOpinionSide();
      break;
    }
    case 'topic_deleted': {
      const ids = new Set(event.deletedIds || [event.topicId]);
      state.workspace.topics = state.workspace.topics.filter((t) => !ids.has(t.id));
      if (ids.has(state.openOpinionTopicId)) $('#op-side').classList.add('hidden');
      renderCanvas();
      break;
    }
    case 'opinion_deleted': {
      mergeTopic(event.topic);
      renderCanvas();
      if (state.openOpinionTopicId === event.topicId) renderOpinionSide();
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

// ---------- 알림: 내가 참여한 토픽의 새 의견/답글 ----------
function maybeNotify(topic, message, topicId) {
  // 내가 이 토픽의 멤버(참여자)일 때만 알림
  if (!topic || !topic.members?.includes(state.me?.id)) return;
  state.notifications.unshift({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    topicId,
    topicTitle: topic.title,
    message,
    at: new Date().toISOString(),
  });
  if (state.notifications.length > 30) state.notifications.length = 30;
  renderNotifications();
}

function renderNotifications() {
  const panel = $('#noti-panel');
  const list = $('#noti-list');
  const count = $('#noti-count');
  if (!panel) return;
  if (state.notifications.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  count.textContent = state.notifications.length;
  list.innerHTML = '';
  for (const n of state.notifications) {
    const time = new Date(n.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    list.append(
      el('li', {
        class: 'noti-item',
        title: '클릭하면 해당 토픽으로 이동',
        onclick: () => openOpinionSide(n.topicId), // 사이드바 바로가기(의견 보기)
      }, [
        el('div', { class: 'noti-msg' }, n.message),
        el('div', { class: 'noti-meta' }, `"${n.topicTitle}" · ${time}`),
      ]),
    );
  }
}

function clearNotifications() {
  state.notifications = [];
  renderNotifications();
}

// ---------- 렌더링: Miro 스타일 캔버스 ----------
// 토픽 깊이(루트=0) 계산
function topicDepth(topic, byId) {
  let d = 0, cur = topic;
  const guard = new Set();
  while (cur && cur.parentId && !guard.has(cur.id)) {
    guard.add(cur.id);
    cur = byId.get(cur.parentId);
    d += 1;
  }
  return d;
}

// 깊이에 따른 타원 노드 크기 (최상위가 가장 크고 하위로 갈수록 작아짐)
function topicSize(depth) {
  const w = Math.max(120, 210 - depth * 34);
  const h = Math.max(70, 120 - depth * 18);
  return { w, h };
}

function centerOf(t, byId) {
  const { w, h } = topicSize(topicDepth(t, byId));
  return { cx: (t.x || 0) + w / 2, cy: (t.y || 0) + h / 2, w, h };
}

function renderCanvas() {
  const nodesLayer = $('#nodes');
  const edges = $('#edges');
  nodesLayer.innerHTML = '';
  edges.innerHTML = '';

  const topics = state.workspace.topics;
  const byId = new Map(topics.map((t) => [t.id, t]));
  const svgNS = 'http://www.w3.org/2000/svg';
  let maxX = 0, maxY = 0;

  // --- 토픽 부모-자식 엣지 ---
  for (const t of topics) {
    const c = centerOf(t, byId);
    maxX = Math.max(maxX, (t.x || 0) + c.w + 300);
    maxY = Math.max(maxY, (t.y || 0) + c.h + 300);
    if (!t.parentId) continue;
    const p = byId.get(t.parentId);
    if (!p) continue;
    const pc = centerOf(p, byId);
    const mx = (pc.cx + c.cx) / 2;
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('class', 'edge');
    path.setAttribute('d', `M ${pc.cx} ${pc.cy} C ${mx} ${pc.cy}, ${mx} ${c.cy}, ${c.cx} ${c.cy}`);
    edges.append(path);
  }

  edges.setAttribute('width', maxX + 200);
  edges.setAttribute('height', maxY + 200);

  if (topics.length === 0) {
    nodesLayer.append(el('div', { class: 'empty-hint' }, '아직 안건이 없습니다. 왼쪽에서 최상위 안건을 추가하세요.'));
  }

  // --- 토픽 노드 (계층적 타원형) ---
  for (const t of topics) {
    const depth = topicDepth(t, byId);
    const { w, h } = topicSize(depth);
    const node = el('div', {
      class: `node depth-${Math.min(depth, 3)} ${t.status}`,
      style: `left:${t.x || 0}px; top:${t.y || 0}px; width:${w}px; height:${h}px; --node-color:${t.color || '#6b5cff'}`,
      'data-id': t.id,
    });
    if (t.imageUrl) node.append(el('div', { class: 'node-img', style: `background-image:url('${t.imageUrl}')` }));
    const meta = el('div', { class: 'node-meta' }, [
      el('span', { class: 'meta-badge' }, `👤 ${t.members.length}`),
      el('span', { class: 'meta-badge' }, `💬 ${t.opinions.length}`),
      el('span', { class: `meta-badge ${t.members.length && t.checks.length === t.members.length ? 'done' : ''}` }, `✔ ${t.checks.length}/${t.members.length}`),
    ]);
    node.append(el('div', { class: 'node-inner' }, [
      el('div', { class: 'node-title' }, (t.status === 'decided' ? '✅ ' : '') + t.title),
      meta,
    ]));
    // 삭제 버튼 (hover 시 표시)
    node.append(el('button', {
      class: 'node-del',
      title: '토픽 삭제',
      onpointerdown: (e) => e.stopPropagation(),
      onclick: (e) => { e.stopPropagation(); deleteTopic(t); },
    }, '✕'));
    // hover 시 하단 액션 버튼들: 의견 보기 + 하위 토픽 생성
    node.append(el('div', { class: 'node-actions' }, [
      el('button', {
        class: 'node-act-btn op',
        title: '의견 보기',
        onpointerdown: (e) => e.stopPropagation(),
        onclick: (e) => { e.stopPropagation(); openOpinionSide(t.id); },
      }, `💬 ${t.opinions.length}`),
      el('button', {
        class: 'node-act-btn sub',
        title: '하위 토픽 생성',
        onpointerdown: (e) => e.stopPropagation(),
        onclick: (e) => { e.stopPropagation(); createChildTopic(t); },
      }, '＋ 하위'),
    ]));

    makeDraggable(node, t);
    nodesLayer.append(node);
  }

  applyView();
}

// 캔버스 패닝 적용
function applyView() {
  const vp = $('#viewport');
  if (vp) vp.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`;
  const ind = $('#zoom-indicator');
  if (ind) ind.textContent = Math.round(state.view.scale * 100) + '%';
}

const MIN_SCALE = 0.3, MAX_SCALE = 2.5;

// 특정 화면 좌표(cx, cy)를 기준점으로 줌 (마우스 커서 위치 유지)
function zoomAt(cx, cy, factor) {
  const canvas = $('#canvas');
  const rect = canvas.getBoundingClientRect();
  const px = cx - rect.left;
  const py = cy - rect.top;
  const oldScale = state.view.scale;
  let newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * factor));
  if (newScale === oldScale) return;
  // 커서 아래 지점이 고정되도록 오프셋 보정
  state.view.x = px - ((px - state.view.x) / oldScale) * newScale;
  state.view.y = py - ((py - state.view.y) / oldScale) * newScale;
  state.view.scale = newScale;
  applyView();
}

// 화면 중앙 기준 줌 (버튼용)
function zoomByButton(factor) {
  const canvas = $('#canvas');
  const rect = canvas.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
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
    // 줌 배율을 반영해 실제 캔버스 좌표로 이동량 환산
    const dx = (e.clientX - startX) / state.view.scale;
    const dy = (e.clientY - startY) / state.view.scale;
    if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 3) moved = true;
    topic.x = origX + dx;
    topic.y = origY + dy;
    // 위치 변경을 캔버스 전체에 반영 (연결선·의견 노드 동기화).
    // 노드 DOM이 교체되어도 포인터 추적은 window에 걸려 있어 드래그가 유지된다.
    renderCanvas();
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
      openTopicPage(topic.id); // 이동 없으면 클릭 → 문서 페이지로 이동
    }
  };
  node.addEventListener('pointerdown', onDown);
}

// 토픽 문서 페이지로 이동 (Notion 스타일 상세/문서 편집)
function openTopicPage(topicId) {
  location.href = `/topic.html?ws=${state.workspace.id}&topic=${topicId}`;
}

// 하위 토픽 생성: 사이드바 패널을 열어 입력받는다.
function createChildTopic(parent) {
  state.subParentId = parent.id;
  $('#subtopic-panel').classList.remove('hidden');
  $('#sub-parent-name').textContent = parent.title;
  const input = $('#side-sub-title');
  input.value = '';
  input.focus();
}

async function submitSubtopic() {
  const parentId = state.subParentId;
  if (!parentId) return;
  const input = $('#side-sub-title');
  const title = input.value.trim();
  if (!title) return toast('하위 토픽 제목을 입력하세요.');
  // 유사 토픽 확인 절차
  const ok = await confirmTopicCreation(title);
  if (!ok) return;
  try {
    await api.post(`/api/workspaces/${state.workspace.id}/topics`, {
      title,
      createdBy: state.me.id,
      parentId,
    });
    toast(`하위 토픽 "${title}"을 추가했습니다.`);
    input.value = '';
    // 연속 추가 가능하도록 패널 유지
  } catch (err) {
    toast('하위 토픽 생성 실패: ' + err.message);
  }
}

function cancelSubtopic() {
  state.subParentId = null;
  $('#subtopic-panel').classList.add('hidden');
}

// LLM으로 유사 토픽을 검사하고, 있으면 모달로 확인받는다.
// 반환: true(생성 진행) / false(취소)
async function confirmTopicCreation(title, excludeId = null) {
  let similar = [];
  try {
    const r = await api.post(`/api/workspaces/${state.workspace.id}/topics/similar`, { title, excludeId });
    similar = r.similar || [];
  } catch {
    // 유사 검사 실패 시에는 생성을 막지 않는다.
    return true;
  }
  if (!similar.length) return true;

  // 유사 토픽 목록을 보여주는 확인 모달
  return new Promise((resolve) => {
    const modal = $('#similar-modal');
    const list = $('#similar-list');
    list.innerHTML = '';
    for (const s of similar) {
      list.append(el('div', { class: 'similar-item' }, [
        el('div', { class: 'similar-title' }, [
          el('span', { class: `status-dot ${s.status || 'open'}` }),
          s.title,
        ]),
        s.reason ? el('div', { class: 'similar-reason' }, s.reason) : null,
      ]));
    }
    modal.classList.remove('hidden');

    const cleanup = () => {
      modal.classList.add('hidden');
      $('#btn-similar-confirm').onclick = null;
      $('#btn-similar-cancel').onclick = null;
    };
    $('#btn-similar-confirm').onclick = () => { cleanup(); resolve(true); };
    $('#btn-similar-cancel').onclick = () => { cleanup(); resolve(false); };
  });
}

// 토픽 삭제 (하위 토픽 포함)
async function deleteTopic(topic) {
  const children = state.workspace.topics.filter((t) => t.parentId === topic.id);
  const msg = children.length
    ? `"${topic.title}" 토픽과 하위 토픽 ${children.length}개 이상을 모두 삭제할까요?`
    : `"${topic.title}" 토픽을 삭제할까요?`;
  if (!confirm(msg)) return;
  try {
    const { deletedIds } = await api.del(`/api/workspaces/${state.workspace.id}/topics/${topic.id}`);
    const ids = new Set(deletedIds);
    state.workspace.topics = state.workspace.topics.filter((t) => !ids.has(t.id));
    renderCanvas();
    toast('토픽을 삭제했습니다.');
  } catch (err) {
    toast('삭제 실패: ' + err.message);
  }
}

// 의견 삭제
async function deleteOpinion(topicId, opinionId) {
  if (!confirm('이 의견을 삭제할까요?')) return;
  try {
    const topic = await api.del(`/api/workspaces/${state.workspace.id}/topics/${topicId}/opinions/${opinionId}`);
    mergeTopic(topic);
    renderCanvas();
    toast('의견을 삭제했습니다.');
  } catch (err) {
    toast('삭제 실패: ' + err.message);
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

  // 마우스 휠로 확대/축소 (커서 위치 기준)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false });
}

// ---------- 의견 사이드 패널 (메인 캔버스) ----------
// 토픽의 "의견 보기" 버튼을 누르면 오른쪽에서 의견 카드가 내려온다. (읽기 전용 요약)
function openOpinionSide(topicId) {
  const topic = state.workspace.topics.find((t) => t.id === topicId);
  if (!topic) return;
  state.openOpinionTopicId = topicId;
  const side = $('#op-side');
  side.classList.remove('hidden');
  $('#op-side-title').textContent = topic.title;
  $('#op-side-sub').textContent = `${topic.status === 'decided' ? '✅ 완료' : '🕓 논의 중'} · 의견 ${topic.opinions.length}개`;
  $('#btn-open-topic').onclick = () => openTopicPage(topicId);
  renderOpinionSide();
}

function renderOpinionSide() {
  const topic = state.workspace.topics.find((t) => t.id === state.openOpinionTopicId);
  const body = $('#op-side-body');
  if (!topic) { $('#op-side').classList.add('hidden'); return; }
  $('#op-side-sub').textContent = `${topic.status === 'decided' ? '✅ 완료' : '🕓 논의 중'} · 의견 ${topic.opinions.length}개`;
  body.innerHTML = '';
  if (topic.opinions.length === 0) {
    body.append(el('p', { class: 'muted', style: 'font-size:13px' }, '아직 의견이 없습니다. 토픽 페이지에서 의견을 남겨보세요.'));
  }
  topic.opinions.forEach((op, i) => {
    const card = el('div', { class: 'op-slide-card', style: `--i:${i}` });
    card.append(el('div', { class: 'op-slide-head' }, [
      el('span', { class: 'avatar sm', style: `background:${colorFor(op.authorId)}` }, initials(nameOf(op.authorId))),
      el('span', { class: 'author' }, nameOf(op.authorId)),
      el('span', { class: 'time' }, new Date(op.createdAt).toLocaleString('ko-KR')),
    ]));
    if (op.title) card.append(el('div', { class: 'op-slide-title' }, op.title));
    if (op.content) card.append(el('div', { class: 'op-slide-body', html: renderMarkdown(op.content) }));
    if (op.attachments?.length) {
      const at = el('div', { class: 'attachments' });
      for (const a of op.attachments) {
        if ((a.mime || '').startsWith('image/')) at.append(el('a', { href: a.url, target: '_blank', class: 'attach-img' }, [el('img', { src: a.url, alt: a.name })]));
        else at.append(el('a', { href: a.url, target: '_blank', download: a.name, class: 'attach-file' }, [el('span', {}, '📄'), el('span', {}, a.name), el('span', { class: 'file-size' }, fmtSize(a.size))]));
      }
      card.append(at);
    }
    if (op.comments.length) card.append(el('div', { class: 'op-slide-replies' }, `💬 답글 ${op.comments.length}`));
    body.append(card);
  });
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
  const ok = await confirmTopicCreation(title);
  if (!ok) return;
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
$('#btn-side-add-sub').addEventListener('click', submitSubtopic);
$('#btn-side-cancel-sub').addEventListener('click', cancelSubtopic);
$('#btn-clear-noti')?.addEventListener('click', clearNotifications);
$('#side-sub-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitSubtopic(); });
$('#btn-summary').addEventListener('click', showSummary);
$('#btn-close-opside').addEventListener('click', () => {
  state.openOpinionTopicId = null;
  $('#op-side').classList.add('hidden');
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
  state.view = { x: 0, y: 0, scale: 1 };
  applyView();
});
$('#btn-zoom-in')?.addEventListener('click', () => zoomByButton(1.2));
$('#btn-zoom-out')?.addEventListener('click', () => zoomByButton(1 / 1.2));
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
