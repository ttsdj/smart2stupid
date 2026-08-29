// smart2stupid 前端（零构建，原生 JS + EventSource）
'use strict';

const TOKEN = new URLSearchParams(location.search).get('token') || '';
const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  task: null, // 当前任务会话（服务端视图）
  es: null, // 执行流 EventSource
  smartEs: null, // smart 调用日志 EventSource
  execFinished: false,
  reviewPoll: null, // 审核状态轮询定时器
};

/* ---------- 基础工具 ---------- */

function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 4000);
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
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 微型 markdown 渲染器：标题/表格/列表/复选框/引用/粗体/行内代码/分隔线。 */
function miniMarkdown(md) {
  let html = '';
  const lines = String(md || '').split('\n');
  let i = 0;
  let inTable = false;
  const inline = (s) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\*([^*]+)\*/g, '<i>$1</i>');
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      html += '<pre>' + escapeHtml(buf.join('\n')) + '</pre>';
      i += 1;
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      if (inTable) { html += '</table>'; inTable = false; }
      const n = h[1].length;
      html += `<h${n}>${inline(h[2])}</h${n}>`;
      i += 1;
      continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      const cells = line.split('|').slice(1, -1);
      if (!inTable && lines[i + 1] && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        html += '<table><tr>' + cells.map((c) => '<th>' + inline(c.trim()) + '</th>').join('') + '</tr>';
        inTable = true;
        i += 2;
        continue;
      }
      if (inTable) {
        html += '<tr>' + cells.map((c) => '<td>' + inline(c.trim()) + '</td>').join('') + '</tr>';
        i += 1;
        continue;
      }
    }
    if (inTable) { html += '</table>'; inTable = false; }
    if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) {
      const done = /\[[xX]\]/.test(line);
      const text = line.replace(/^\s*[-*]\s+\[[ xX]\]\s+/, '');
      html += `<li class="checkbox ${done ? 'done' : ''}">${done ? '☑' : '☐'} ${inline(text)}</li>`;
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>';
      i += 1;
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      html += '<li>' + inline(line.replace(/^\s*\d+\.\s+/, '')) + '</li>';
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      html += '<blockquote>' + inline(line.replace(/^\s*>\s?/, '')) + '</blockquote>';
      i += 1;
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      html += '<hr>';
      i += 1;
      continue;
    }
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    html += '<p>' + inline(line) + '</p>';
    i += 1;
  }
  if (inTable) html += '</table>';
  return html;
}

/* ---------- 视图切换 ---------- */

const STEPS = ['view-new', 'view-clarify', 'view-review', 'view-exec'];

function showStep(n) {
  STEPS.forEach((id, idx) => $(id).classList.toggle('hidden', idx !== n));
  document.querySelectorAll('#progress .step').forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle('active', s === n);
    el.classList.toggle('done', s < n);
  });
}

/* ---------- 启动 ---------- */

async function boot() {
  try {
    state.config = await api('/api/config');
  } catch (e) {
    toast('加载配置失败：' + e.message, 'error');
    return;
  }
  // provider 下拉
  const selP = $('sel-provider');
  selP.innerHTML = '';
  for (const p of state.config.providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.id}（${p.modelName}）${p.type === 'playwright-web-chat' ? ' ⚠️易碎' : ''}`;
    if (p.id === state.config.smart.provider) opt.selected = true;
    selP.appendChild(opt);
  }
  selP.onchange = () => {
    const fragile = state.config.providers.find((p) => p.id === selP.value)?.type === 'playwright-web-chat';
    if (fragile) {
      toast('浏览器自动化 provider：依赖网页 DOM、易碎，且可能违反站点 ToS，风险自担', 'error');
    }
  };
  // executor 下拉 + 检测状态
  const selE = $('sel-executor');
  selE.innerHTML = '';
  const statusBits = [];
  for (const e of state.config.executors) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.label + (e.detected.ok ? ' ✓' : ' ✗ 未装');
    if (e.id === state.config.stupid.executor) opt.selected = true;
    selE.appendChild(opt);
    if (!e.detected.ok) {
      statusBits.push(`<b>${e.label}</b> 未安装：${escapeHtml(e.detected.installHint || '')}`);
    } else if (e.detected.note) {
      statusBits.push(`ℹ️ <b>${e.label}</b>：${escapeHtml(e.detected.note)}`);
    }
  }
  $('executor-status').innerHTML = statusBits.length
    ? '⚠️ ' + statusBits.join('<br>⚠️ ')
    : '全部 executor 可用 ✓';
  $('exec-model').value = state.config.stupid.model;
  $('new-workdir').value = localStorage.getItem('s2s.workdir') || '';
  loadTasks();
  $('btn-create').disabled = false;
}

async function loadTasks() {
  const list = $('task-list');
  try {
    const tasks = await api('/api/tasks');
    if (tasks.length === 0) {
      list.innerHTML = '<li class="hint">暂无任务</li>';
      return;
    }
    list.innerHTML = '';
    for (const t of tasks) {
      const li = document.createElement('li');
      const title = document.createElement('span');
      title.className = 't-title';
      title.textContent = t.rootPrompt.split('\n')[0].slice(0, 60);
      const badge = document.createElement('span');
      badge.className = 'badge ' + t.phase;
      badge.textContent = { clarify: '追问中', review: '待执行', executing: '执行中', reviewing: '审核中', reviewed: '已审核', completed: '已完成', failed: '失败', cancelled: '已取消' }[t.phase] || t.phase;
      li.appendChild(title);
      li.appendChild(badge);
      li.onclick = () => resumeTask(t.taskId);
      list.appendChild(li);
    }
  } catch (e) {
    list.innerHTML = '<li class="hint">加载失败：' + escapeHtml(e.message) + '</li>';
  }
}

async function resumeTask(taskId) {
  try {
    state.task = await api('/api/tasks/' + taskId);
    if (state.task.phase === 'clarify') showClarify();
    else if (state.task.phase === 'review') showReview();
    else showExec(true);
  } catch (e) {
    toast('恢复任务失败：' + e.message, 'error');
  }
}

/* ---------- ① 新任务 ---------- */

$('btn-checkdir').onclick = async () => {
  const r = $('dir-check-result');
  try {
    const res = await api('/api/fs/check?path=' + encodeURIComponent($('new-workdir').value));
    r.textContent = res.ok ? `✓ 目录可用（realpath: ${res.realpath}）` : '✗ ' + res.error;
    r.style.color = res.ok ? 'var(--green)' : 'var(--red)';
  } catch (e) {
    r.textContent = '✗ ' + e.message;
    r.style.color = 'var(--red)';
  }
};

$('btn-create').onclick = async () => {
  const prompt = $('new-prompt').value.trim();
  const workdir = $('new-workdir').value.trim();
  if (!prompt || !workdir) return toast('提示词与工作目录不能为空', 'error');
  const btn = $('btn-create');
  btn.disabled = true;
  btn.textContent = 'smart 模型建树中…';
  try {
    const session = await api('/api/tasks', {
      method: 'POST',
      body: { prompt, workdir, providerId: $('sel-provider').value },
    });
    localStorage.setItem('s2s.workdir', session.workdir);
    state.task = session;
    toast('设计树已生成，开始追问', 'ok');
    showClarify();
  } catch (e) {
    toast('创建任务失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '创建任务，开始追问 →';
  }
};

$('btn-refresh-tasks').onclick = loadTasks;

/* ---------- smart 调用日志（实时） ---------- */

const SMART_PHASE_LABEL = { build_tree: '建树', evolve: '追问演进', brief: '生成brief', review: '验收审核', fix: '修正指令' };

function appendSmartLog(ev) {
  if (ev.type !== 'smart_log') return;
  const ts = (ev.ts || '').slice(11, 19);
  const phase = SMART_PHASE_LABEL[ev.phase] || ev.phase || '?';
  const line = `[${ts}] [${phase}] ${ev.text || ''}\n`;
  for (const id of ['smart-log-clarify', 'smart-log-exec']) {
    const el = $(id);
    el.textContent += line;
    el.scrollTop = el.scrollHeight;
  }
}

function subscribeSmartLog(taskId) {
  if (state.smartEs) state.smartEs.close();
  if (!taskId) return;
  const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/smart-stream?token=${encodeURIComponent(TOKEN)}`);
  state.smartEs = es;
  es.onmessage = (msg) => {
    try {
      appendSmartLog(JSON.parse(msg.data));
    } catch {
      // 忽略坏帧
    }
  };
  // 自动展开日志面板（有新调用活动时）
  es.onopen = () => {
    const wrap = $('smart-log-wrap-clarify');
    if (wrap && !wrap.open) wrap.open = true;
  };
}

/* ---------- ② 追问澄清 ---------- */

function answeredNodes() {
  return Object.values(state.task.tree.nodes).filter((n) => n.status === 'answered');
}

function showClarify() {
  showStep(1);
  const t = state.task;
  subscribeSmartLog(t.taskId);
  $('clarify-title').textContent = t.phase === 'review' ? '追问已收敛' : `追问澄清（第 ${t.round} 轮后）`;
  $('clarify-meta').textContent = `任务 ${t.taskId} · provider ${t.providerId}（${t.providerModel || '?'}）· 工作目录 ${t.workdir}`;
  renderRound();
  // 已决决策
  const answered = answeredNodes();
  $('answered-count').textContent = answered.length;
  $('answered-list').innerHTML = answered
    .map((n) => `<div class="qa"><div class="q">${escapeHtml(n.question)}</div><div class="a">${escapeHtml(n.answer || '')}</div></div>`)
    .join('');
}

function renderRound() {
  const t = state.task;
  const frontier = (t.frontier || [])
    .map((id) => t.tree.nodes[id])
    .filter(Boolean);
  $('round-loading').classList.add('hidden');
  const box = $('round-questions');
  if (frontier.length === 0) {
    box.innerHTML = '<div class="hint">前沿已空。</div>';
    return;
  }
  box.innerHTML = frontier
    .map(
      (n) => `
    <div class="q-card" data-id="${escapeHtml(n.id)}">
      <div class="q-head">
        <span class="q-title">${escapeHtml(n.question)}</span>
        <span class="q-id">${escapeHtml(n.id)}</span>
      </div>
      ${n.recommended ? `<div class="q-recommended">💡 推荐答案：${escapeHtml(n.recommended)} <button class="btn-fill" data-fill="${escapeHtml(n.id)}">填入</button></div>` : ''}
      <textarea data-answer="${escapeHtml(n.id)}" rows="2" placeholder="你的答案（可留空，留空进入下一轮再问）"></textarea>
    </div>`,
    )
    .join('');
  box.querySelectorAll('.btn-fill').forEach((b) => {
    b.onclick = () => {
      const n = state.task.tree.nodes[b.dataset.fill];
      if (n) box.querySelector(`textarea[data-answer="${CSS.escape(b.dataset.fill)}"]`).value = n.recommended || '';
    };
  });
  // 逃生舱始终可用；达到轮次上限时加提示
  $('btn-force-converge').classList.remove('hidden');
  if (t.maxRoundsReached) {
    box.insertAdjacentHTML('afterbegin', '<div class="hint" style="color:var(--yellow)">已达追问轮次上限，可继续回答或点「跳过追问」直接生成 brief。</div>');
  }
}

$('btn-submit-round').onclick = async () => {
  const answers = {};
  document.querySelectorAll('#round-questions textarea').forEach((ta) => {
    const v = ta.value.trim();
    if (v) answers[ta.dataset.answer] = v;
  });
  if (Object.keys(answers).length === 0) return toast('至少回答一个问题（或点「跳过追问」）', 'error');
  $('round-loading').classList.remove('hidden');
  const btn = $('btn-submit-round');
  btn.disabled = true;
  try {
    const res = await api(`/api/tasks/${state.task.taskId}/round`, { method: 'POST', body: { answers } });
    state.task = res;
    if (res.converged) {
      toast('追问收敛，brief 已生成', 'ok');
      showReview();
    } else {
      showClarify();
    }
  } catch (e) {
    toast('提交失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    $('round-loading').classList.add('hidden');
  }
};

$('btn-force-converge').onclick = async () => {
  const btn = $('btn-force-converge');
  btn.disabled = true;
  $('round-loading').classList.remove('hidden');
  try {
    state.task = await api(`/api/tasks/${state.task.taskId}/force-converge`, { method: 'POST' });
    toast('已强制收敛生成 brief', 'ok');
    showReview();
  } catch (e) {
    toast('收敛失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    $('round-loading').classList.add('hidden');
  }
};

/* ---------- ③ brief 审阅 ---------- */

function showReview() {
  showStep(2);
  const t = state.task;
  $('review-meta').textContent = `任务 ${t.taskId} · ${t.workdir}`;
  $('brief-render').innerHTML = miniMarkdown(t.briefMd || '');
  $('brief-editor').value = t.briefMd || '';
  $('brief-editor').classList.add('hidden');
  $('brief-render').classList.remove('hidden');
  $('btn-edit-brief').classList.remove('hidden');
  $('btn-save-brief').classList.add('hidden');
}

$('btn-edit-brief').onclick = () => {
  $('brief-render').classList.add('hidden');
  $('brief-editor').classList.remove('hidden');
  $('btn-edit-brief').classList.add('hidden');
  $('btn-save-brief').classList.remove('hidden');
};

$('btn-save-brief').onclick = async () => {
  try {
    state.task = await api(`/api/tasks/${state.task.taskId}/brief`, {
      method: 'POST',
      body: { md: $('brief-editor').value },
    });
    toast('brief 已保存', 'ok');
    showReview();
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
};

$('btn-confirm-exec').onclick = () => showExec(false);

/* ---------- ④ 执行监控 ---------- */

async function showExec(resuming) {
  showStep(3);
  const t = state.task;
  state.execFinished = false;
  stopReviewPoll();
  subscribeSmartLog(t.taskId);
  $('exec-meta').textContent = `任务 ${t.taskId} · 工作目录 ${t.workdir}`;
  $('exec-status').textContent = '—';
  $('exec-status').className = 'exec-status';
  $('exec-log').textContent = '';
  $('exec-tools').innerHTML = '';
  $('exec-stderr').textContent = '';
  $('exec-stderr-wrap').classList.add('hidden');
  $('exec-result').classList.add('hidden');
  $('btn-cancel-exec').classList.remove('hidden');
  $('btn-exec-done').classList.add('hidden');
  $('review-panel').classList.add('hidden');

  // dry-run 预览
  try {
    const prev = await api('/api/execute/preview', {
      method: 'POST',
      body: { taskId: t.taskId, executorId: $('sel-executor').value, model: $('exec-model').value },
    });
    const cmdStr = [prev.command, ...prev.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    $('exec-preview').innerHTML =
      '<div class="hint">即将执行（dry-run 预览）' +
      (prev.useStdin ? ' · prompt 超长经 stdin 注入' : '') +
      '</div><div class="cmd">' + escapeHtml(cmdStr) + '</div>';
  } catch (e) {
    $('exec-preview').innerHTML = '<div class="hint" style="color:var(--red)">预览失败：' + escapeHtml(e.message) + '</div>';
  }

  if (resuming) {
    if (t.phase === 'reviewing') {
      // 审核进行中：重放历史执行流 + 启动审核轮询
      subscribeStream(t.taskId, true);
      $('btn-cancel-exec').classList.add('hidden');
      showReviewPanel('reviewing');
      startReviewPoll();
      return;
    }
    if (t.phase === 'reviewed') {
      subscribeStream(t.taskId, true);
      $('btn-cancel-exec').classList.add('hidden');
      renderReview();
      return;
    }
    if (t.phase !== 'executing') {
      // 终态历史执行：从落盘日志重放
      subscribeStream(t.taskId, true);
      if (t.iterations?.length) renderReview(); // 终态但有迭代记录 → 展示审核面板（含无审核报告情况）
      return;
    }
  }

  try {
    await api('/api/execute/start', {
      method: 'POST',
      body: { taskId: t.taskId, executorId: $('sel-executor').value, model: $('exec-model').value },
    });
    subscribeStream(t.taskId, false);
  } catch (e) {
    toast('启动执行失败：' + e.message, 'error');
    $('exec-status').textContent = '启动失败：' + e.message;
    $('exec-status').className = 'exec-status failed';
    $('btn-cancel-exec').classList.add('hidden');
  }
}

/* ---------- 审核面板 ---------- */

function showReviewPanel(mode) {
  $('review-panel').classList.remove('hidden');
  const st = $('review-state');
  if (mode === 'reviewing') {
    st.innerHTML = '<span class="loading">🤔 smart 模型审核执行结果中…</span>';
  }
}

function stopReviewPoll() {
  if (state.reviewPoll) {
    clearInterval(state.reviewPoll);
    state.reviewPoll = null;
  }
}

function startReviewPoll() {
  stopReviewPoll();
  state.reviewPoll = setInterval(async () => {
    try {
      const t = await api('/api/tasks/' + state.task.taskId);
      state.task = t;
      if (t.phase === 'reviewed') {
        stopReviewPoll();
        renderReview();
      }
    } catch (e) {
      // 轮询失败忽略，下一轮再试
    }
  }, 2000);
}

function renderReview() {
  stopReviewPoll();
  const t = state.task;
  const last = (t.iterations || [])[t.iterations.length - 1];
  $('review-panel').classList.remove('hidden');

  // 迭代历史行
  const hist = (t.iterations || [])
    .map((it) => {
      const v = it.review ? it.review.verdict : it.reviewStatus === 'unavailable' ? '不可用' : '—';
      return `第${it.index}轮 ${it.status}${it.review || it.reviewStatus ? ' · ' + v : ''}`;
    })
    .join(' ｜ ');
  $('review-history').textContent = '迭代历史：' + (hist || '无');

  if (!last) {
    $('review-verdict').textContent = '';
    $('review-state').textContent = '该任务执行于审核功能上线前，无审核报告。';
    $('review-items').querySelector('tbody').innerHTML = '';
    $('review-summary').innerHTML = '';
    $('review-fixes').innerHTML = '';
    $('btn-review-iterate').classList.add('hidden');
    $('btn-review-finish').classList.remove('hidden');
    $('btn-review-retry').classList.add('hidden');
    return;
  }

  const review = last.review;
  $('review-state').textContent = last.reviewStatus === 'unavailable'
    ? '⚠️ 审核不可用：' + (last.reviewError || '模型调用失败') + '（可重试审核或结束任务）'
    : '';

  const verdictEl = $('review-verdict');
  if (review) {
    verdictEl.className = 'verdict ' + review.verdict;
    verdictEl.textContent = { pass: '✓ 通过', partial: '◐ 部分通过', fail: '✗ 未通过' }[review.verdict] || review.verdict;
    const tbody = $('review-items').querySelector('tbody');
    tbody.innerHTML = (review.items || [])
      .map(
        (it) => `<tr>
          <td>${escapeHtml(it.criterion)}</td>
          <td class="item-status ${it.status}">${{ pass: '✓', fail: '✗', unknown: '?' }[it.status] || it.status}</td>
          <td>${escapeHtml(it.issue || '')}<div class="evidence">${escapeHtml(it.evidence || '')}</div></td>
        </tr>`,
      )
      .join('');
    $('review-summary').innerHTML = miniMarkdown(review.summary || '');
    $('review-fixes').innerHTML = (review.fixSuggestions || []).length
      ? '<div class="hint">修复建议：</div><ul>' + review.fixSuggestions.map((s) => '<li>' + escapeHtml(s) + '</li>').join('') + '</ul>'
      : '';
  } else {
    verdictEl.className = 'verdict';
    verdictEl.textContent = '无审核报告';
    $('review-items').querySelector('tbody').innerHTML = '';
    $('review-summary').innerHTML = '';
    $('review-fixes').innerHTML = '';
  }

  // 按钮显隐
  const canIterate = review && t.phase === 'reviewed' && !t.maxIterationsReached;
  $('btn-review-iterate').classList.toggle('hidden', !canIterate);
  $('btn-review-iterate').disabled = false;
  $('btn-review-iterate').textContent = '生成修正指令并重跑 →';
  $('btn-review-finish').classList.toggle('hidden', t.phase !== 'reviewed');
  $('btn-review-retry').classList.toggle('hidden', last.reviewStatus !== 'unavailable' || t.phase !== 'reviewed');
  if (t.maxIterationsReached && t.phase === 'reviewed') {
    $('review-history').textContent += '（已达迭代上限）';
  }
}

$('btn-review-iterate').onclick = async () => {
  const btn = $('btn-review-iterate');
  btn.disabled = true;
  btn.textContent = '生成修正指令中…';
  try {
    const res = await api(`/api/tasks/${state.task.taskId}/iterate`, {
      method: 'POST',
      body: { executorId: $('sel-executor').value, model: $('exec-model').value },
    });
    state.task = res;
    toast('修正指令已生成，开始第 ' + res.iteration + ' 轮执行', 'ok');
    // 回到执行中 UI：清空日志区，重新订阅执行流
    $('review-panel').classList.add('hidden');
    $('exec-status').textContent = '—';
    $('exec-status').className = 'exec-status';
    $('exec-log').textContent = '';
    $('exec-tools').innerHTML = '';
    $('exec-result').classList.add('hidden');
    $('btn-cancel-exec').classList.remove('hidden');
    state.execFinished = false;
    subscribeStream(state.task.taskId, false);
  } catch (e) {
    toast('迭代启动失败：' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = '生成修正指令并重跑 →';
  }
};

$('btn-review-finish').onclick = async () => {
  try {
    state.task = await api(`/api/tasks/${state.task.taskId}/finish`, { method: 'POST' });
    toast('任务已结束：' + state.task.phase, 'ok');
    $('review-panel').classList.add('hidden');
    $('btn-exec-done').classList.remove('hidden');
    loadTasks();
  } catch (e) {
    toast('结束失败：' + e.message, 'error');
  }
};

$('btn-review-retry').onclick = async () => {
  try {
    $('review-state').innerHTML = '<span class="loading">🤔 重试审核中…</span>';
    state.task = await api(`/api/tasks/${state.task.taskId}/review/retry`, { method: 'POST' });
    renderReview();
  } catch (e) {
    toast('重试失败：' + e.message, 'error');
  }
};

function subscribeStream(taskId, historyOnly) {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/execute/stream?taskId=${encodeURIComponent(taskId)}&token=${encodeURIComponent(TOKEN)}`);
  state.es = es;
  es.onmessage = (msg) => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch {
      return;
    }
    handleExecEvent(ev);
  };
  es.onerror = () => {
    if (historyOnly) es.close();
  };
}

const TOOL_COLORS = {};
function handleExecEvent(ev) {
  if (ev.type === 'status') {
    const el = $('exec-status');
    el.className = 'exec-status ' + ev.status;
    el.textContent =
      { starting: '⏳ 启动中…', running: '▶ 执行中…', completed: '✅ 执行完成', failed: '❌ 执行失败', cancelled: '⏹ 已取消', timeout: '⏱ 执行超时' }[ev.status] ||
      ev.status;
    if (ev.message) el.textContent += ' — ' + ev.message;
    if (['completed', 'failed', 'cancelled', 'timeout'].includes(ev.status)) {
      state.execFinished = true;
      $('btn-cancel-exec').classList.add('hidden');
      if (state.es) state.es.close();
      if (state.task.reviewEnabled) {
        // 自动审核进行中：显示审核面板并轮询状态
        showReviewPanel('reviewing');
        startReviewPoll();
      } else {
        $('btn-exec-done').classList.remove('hidden');
      }
    }
    return;
  }
  if (ev.type === 'stdout') {
    const log = $('exec-log');
    log.textContent += ev.text;
    if (!ev.text.endsWith('\n')) log.textContent += '\n';
    log.scrollTop = log.scrollHeight;
    return;
  }
  if (ev.type === 'stderr') {
    $('exec-stderr-wrap').classList.remove('hidden');
    $('exec-stderr').textContent += ev.text + '\n';
    return;
  }
  if (ev.type === 'tool_use') {
    const tools = $('exec-tools');
    const span = document.createElement('span');
    span.className = 'tool';
    span.textContent = ev.tool;
    span.title = ev.input ? JSON.stringify(ev.input).slice(0, 500) : '';
    tools.appendChild(span);
    return;
  }
  if (ev.type === 'result') {
    const r = $('exec-result');
    r.classList.remove('hidden');
    r.textContent = ev.text;
    return;
  }
  // meta 事件忽略
}

$('btn-cancel-exec').onclick = async () => {
  try {
    await api('/api/execute/cancel', { method: 'POST', body: { taskId: state.task.taskId } });
    toast('已发送取消信号', 'ok');
  } catch (e) {
    toast('取消失败：' + e.message, 'error');
  }
};

$('btn-exec-done').onclick = () => {
  loadTasks();
  showReview();
};

/* ---------- 入口 ---------- */
boot();
