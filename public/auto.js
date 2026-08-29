// smart2stupid agent 对话时间线：把 auto 闭环渲染成 codex ↔ claude 的回合式对话。
'use strict';

const TOKEN = new URLSearchParams(location.search).get('token') || '';
const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  taskId: null,
  es: { auto: null, smart: null, exec: null },
  timelineEmpty: true,
};

const PHASE_LABEL = { build_tree: '建树', evolve: '追问', brief: '生成brief', review: '审核', fix: '修正' };

function toast(msg, kind = '') {
  const t = $('auto-status');
  t.textContent = msg;
  t.style.color = kind === 'error' ? 'var(--red)' : 'var(--dim)';
}

async function api(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(path + sep + 'token=' + encodeURIComponent(TOKEN), {
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': TOKEN, ...(opts.headers || {}) },
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const tl = $('timeline');

function clearTimeline() {
  tl.innerHTML = '';
  state.timelineEmpty = true;
}

function firstBubble() {
  if (state.timelineEmpty) {
    tl.innerHTML = '';
    state.timelineEmpty = false;
  }
}

function tsOf(t) {
  return (t || '').slice(11, 19);
}

function appendDivider(text) {
  firstBubble();
  const el = document.createElement('div');
  el.className = 'tl-divider';
  el.textContent = text;
  tl.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function appendBubble(who, head, bodyHtml, bodyClass) {
  firstBubble();
  const el = document.createElement('div');
  el.className = 'bubble ' + who;
  el.innerHTML = `<div class="head">${head}</div><div class="body ${bodyClass || ''}">${bodyHtml}</div>`;
  tl.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return el;
}

/* ---------- 里程碑（auto 通道） ---------- */

function onMilestone(ev) {
  switch (ev.event) {
    case 'started':
      toast(`运行中：${ev.smart} → ${ev.stupid}，上限 ${ev.maxIterations} 轮`);
      appendDivider(`🚀 启动：smart=${ev.smart} · stupid=${ev.stupid} · 工作目录 ${ev.workdir}`);
      break;
    case 'task_created':
      state.taskId = ev.taskId;
      subscribeTaskStreams(ev.taskId);
      appendDivider(`📄 任务创建：${ev.taskId}`);
      break;
    case 'phase': {
      const label = { plan: '🧠 smart 出 plan（自问自答）', exec: `🔧 第 ${ev.iteration} 轮执行`, review: `🧠 第 ${ev.iteration} 轮审核`, fix: `🔁 第 ${ev.iteration} 轮修正` }[ev.phase];
      appendDivider(label);
      break;
    }
    case 'verdict': {
      if (ev.verdict) {
        const banner = document.createElement('div');
        banner.className = 'verdict-banner ' + ev.verdict;
        banner.textContent = { pass: '✅ 验收通过', partial: '◐ 部分通过', fail: '❌ 未通过' }[ev.verdict] || ev.verdict;
        firstBubble();
        tl.appendChild(banner);
      }
      break;
    }
    case 'done': {
      toast('闭环结束：' + (ev.verdict ?? '不可用'));
      appendDivider(`🏁 完成 · verdict=${ev.verdict ?? '不可用'} · ${ev.iterations} 轮 · ${ev.finalPhase}`);
      $('btn-auto-start').disabled = false;
      break;
    }
  }
}

/* ---------- codex（smart 通道） ---------- */

function onSmartLog(ev) {
  const phase = PHASE_LABEL[ev.phase] || ev.phase || '?';
  const time = `<span class="ts">${tsOf(ev.ts)}</span>`;
  const head = `<span class="who">🧠 codex</span><span class="tag">${phase} · ${ev.stream}</span>${time}`;
  if (ev.stream === 'cmd') {
    appendBubble('codex', head, escapeHtml(ev.text), 'cmd');
  } else if (ev.stream === 'stderr') {
    appendBubble('codex', head, escapeHtml(ev.text), 'stderr');
  } else {
    // stdout / info：模型回复原文（截断过长）
    const text = ev.text.length > 4000 ? ev.text.slice(0, 4000) + '\n…(截断)…' : ev.text;
    appendBubble('codex', head, escapeHtml(text), '');
  }
}

/* ---------- claude（exec 通道） ---------- */

function onExecEvent(ev) {
  const time = `<span class="ts">${tsOf(new Date().toISOString())}</span>`;
  if (ev.type === 'status') {
    const label = { starting: '启动', running: '运行中', completed: '完成', failed: '失败', cancelled: '取消', timeout: '超时' }[ev.status] || ev.status;
    const chip = `<span class="status-chip ${ev.status}">${label}${ev.exitCode !== undefined ? ' (' + ev.exitCode + ')' : ''}</span>`;
    firstBubble();
    const el = document.createElement('div');
    el.className = 'bubble claude';
    el.innerHTML = `<div class="head"><span class="who">🔧 claude</span><span class="tag">状态</span>${time}</div><div class="body">${chip}${ev.message ? ' ' + escapeHtml(ev.message) : ''}</div>`;
    tl.appendChild(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  if (ev.type === 'tool_use') {
    appendBubble('claude', `<span class="who">🔧 claude</span><span class="tag">工具调用</span>${time}`, `<span class="tool-chip">🔨 ${escapeHtml(ev.tool)}</span>${ev.input ? '<div>' + escapeHtml(JSON.stringify(ev.input).slice(0, 300)) + '</div>' : ''}`, '');
    return;
  }
  if (ev.type === 'result') {
    appendBubble('claude', `<span class="who">🔧 claude</span><span class="tag">结果</span>${time}`, escapeHtml(String(ev.text).slice(0, 2000)), 'result');
    return;
  }
  if (ev.type === 'stderr') {
    appendBubble('claude', `<span class="who">🔧 claude</span><span class="tag">stderr</span>${time}`, escapeHtml(ev.text), 'stderr');
    return;
  }
  if (ev.type === 'stdout') {
    appendBubble('claude', `<span class="who">🔧 claude</span><span class="tag">输出</span>${time}`, escapeHtml(ev.text), '');
    return;
  }
}

/* ---------- SSE 订阅 ---------- */

function subscribe(url, handler) {
  const es = new EventSource(url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN));
  es.onmessage = (m) => {
    try {
      handler(JSON.parse(m.data));
    } catch {
      // 忽略坏帧
    }
  };
  return es;
}

function subscribeTaskStreams(taskId) {
  if (state.es.smart) state.es.smart.close();
  if (state.es.exec) state.es.exec.close();
  state.es.smart = subscribe(`/api/tasks/${taskId}/smart-stream`, onSmartLog);
  state.es.exec = subscribe(`/api/execute/stream?taskId=${taskId}`, onExecEvent);
}

/* ---------- 启动 ---------- */

async function boot() {
  try {
    state.config = await api('/api/config');
  } catch (e) {
    toast('加载配置失败：' + e.message, 'error');
    return;
  }
  const selSmart = $('auto-smart');
  selSmart.innerHTML = '';
  for (const p of state.config.providers) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.id}（${p.modelName}）`;
    if (p.id === state.config.smart.provider) o.selected = true;
    selSmart.appendChild(o);
  }
  const selStupid = $('auto-stupid');
  selStupid.innerHTML = '';
  for (const e of state.config.executors) {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = e.label + (e.detected.ok ? ' ✓' : ' ✗');
    if (e.id === state.config.stupid.executor) o.selected = true;
    selStupid.appendChild(o);
  }
  $('auto-workdir').value = localStorage.getItem('s2s.auto.workdir') || '';
  $('btn-auto-start').disabled = false;
}

$('btn-auto-start').onclick = async () => {
  const prompt = $('auto-prompt').value.trim();
  const workdir = $('auto-workdir').value.trim();
  if (!prompt || !workdir) return toast('任务描述和工作目录不能为空', 'error');
  const btn = $('btn-auto-start');
  btn.disabled = true;
  clearTimeline();
  if (state.es.auto) state.es.auto.close();
  state.es.auto = subscribe('/api/auto/stream', onMilestone);
  try {
    await api('/api/auto/start', {
      method: 'POST',
      body: { prompt, workdir, smart: $('auto-smart').value, stupid: $('auto-stupid').value },
    });
    localStorage.setItem('s2s.auto.workdir', workdir);
    toast('已启动，等待时间线…');
  } catch (e) {
    toast('启动失败：' + e.message, 'error');
    btn.disabled = false;
  }
};

boot();
