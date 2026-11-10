/* =========================================================
   夸克影音索引 · 评分与评论（云端共享 · Appwrite Cloud 免费套餐）
   数据库 jzs（多站点共用，本站 recipe_id 一律带 qmi: 前缀隔离）：
     ratings  集合：recipe_id / voter_id / stars（每人每条一票，可改）
     comments 集合：recipe_id / name / body
   访客首次评分/评论时创建匿名会话，票权绑定会话用户，
   前端不含任何密钥，只需公开的 Project ID。
   对外暴露 window.JZSCommunity：
     getStats(id)        读取某条目的 { avg, count, comments }
     decorateCards(root) 填充行内的 [data-rate] 占位
     renderDialog(id, container) 渲染详情弹窗内的评分评论区
   数据就绪后派发 'jzs-stats' 事件，供页面刷新行内评分与排序
   ========================================================= */

(function () {
  'use strict';

  /* Appwrite Cloud 项目 ID 与 API 端点（控制台项目概览/设置页获取；
     Project ID 是公开信息、非密钥。端点形如 https://sgp.cloud.appwrite.io/v1） */
  const PROJECT_ID = '6af2c92a00134f1f4cf5';
  const ENDPOINT = 'https://sgp.cloud.appwrite.io/v1';
  const DB_ID = 'jzs';
  const configured = !!PROJECT_ID;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (str) => String(str).replace(/[&<>"]/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[s]));

  const stats = {};
  let serviceState = configured ? 'loading' : 'off'; // off | loading | ready | error
  let statsPromise = null;

  /* 匿名会话：首次写入时创建，保存在本机；票权绑定会话用户 */
  let session = null; // { userId, secret, expire }
  const localMine = {};
  try {
    session = JSON.parse(localStorage.getItem('jzs-session') || 'null');
    Object.assign(localMine, JSON.parse(localStorage.getItem('jzs-my-ratings') || '{}'));
  } catch (e) { /* ignore */ }

  function saveMine(id, stars) {
    localMine[id] = stars;
    try { localStorage.setItem('jzs-my-ratings', JSON.stringify(localMine)); } catch (e) { /* ignore */ }
  }

  function getStats(id) {
    return stats[id] || { avg: 0, count: 0, comments: 0 };
  }

  function starsHTML(avg, extraClass) {
    const pct = Math.max(0, Math.min(5, avg)) / 5 * 100;
    return `<span class="stars ${extraClass || ''}" role="img" aria-label="平均 ${avg} 星（满分 5 星）"><span class="stars-bg" aria-hidden="true">★★★★★</span><span class="stars-fg" aria-hidden="true" style="width:${pct}%">★★★★★</span></span>`;
  }

  function fmtDate(t) {
    const d = new Date(t);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /* ---------------- Appwrite REST 客户端 ---------------- */
  function apiError(res, data) {
    let msg = '服务暂时不可用';
    if (res.status === 429) msg = '操作太频繁，请稍后再试';
    else if (data && data.message) msg = '提交未被接受，请检查内容后重试';
    return Object.assign(new Error(msg), { status: res.status, type: data && data.type });
  }

  async function ensureSession() {
    if (session && session.secret && session.expire && new Date(session.expire).getTime() > Date.now() + 60000) {
      return session;
    }
    const res = await fetch(ENDPOINT + '/account/sessions/anonymous', {
      method: 'POST',
      headers: { 'X-Appwrite-Project': PROJECT_ID, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw apiError(res, data);
    /* 会话令牌在 X-Fallback-Cookies 响应头里（跨域场景，Appwrite 已 CORS 暴露该头），
       值是完整 base64 串；X-Appwrite-Session 必须原样传它，服务端自行解码。
       响应体的 secret 字段为空，不能用。 */
    let secret = '';
    try {
      const fb = res.headers.get('X-Fallback-Cookies');
      if (fb) secret = JSON.parse(fb)['a_session_' + PROJECT_ID] || '';
    } catch (e) { /* ignore */ }
    if (!secret) secret = data.secret || '';
    session = { userId: data.userId, secret, expire: data.expire };
    try { localStorage.setItem('jzs-session', JSON.stringify(session)); } catch (e) { /* ignore */ }
    return session;
  }

  async function aw(path, options) {
    const opts = options || {};
    const headers = { 'X-Appwrite-Project': PROJECT_ID, 'Content-Type': 'application/json' };
    if (opts.auth) {
      const s = await ensureSession();
      headers['X-Appwrite-Session'] = s.secret;
    }
    const res = await fetch(ENDPOINT + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401 && opts.auth && !opts._retried) {
      /* 会话在服务端已失效：重建一次匿名会话再试 */
      session = null;
      try { localStorage.removeItem('jzs-session'); } catch (e) { /* ignore */ }
      return aw(path, Object.assign({}, opts, { _retried: true }));
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw apiError(res, data);
    return data;
  }

  /* 查询（Appwrite v2.x 用 JSON 对象：method + attribute/values，序列化为 queries[] 参数） */
  const qEqual = (attr, val) => ({ method: 'equal', attribute: attr, values: [val] });
  const qOrderDesc = (attr) => ({ method: 'orderDesc', attribute: attr });
  const qLimit = (n) => ({ method: 'limit', values: [n] });
  const qOffset = (n) => ({ method: 'offset', values: [n] });
  const qSelect = (attrs) => ({ method: 'select', values: attrs });

  function docsPath(col, queries) {
    const qs = (queries || []).map((x) => 'queries[]=' + encodeURIComponent(JSON.stringify(x))).join('&');
    return `/databases/${DB_ID}/collections/${col}/documents` + (qs ? '?' + qs : '');
  }
  const docPath = (col, docId) => `/databases/${DB_ID}/collections/${col}/documents/${encodeURIComponent(docId)}`;

  /* 分页拉取整表（只取需要的字段，站点规模小，上限 5000 条） */
  async function listAll(col, selectAttrs) {
    const out = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const data = await aw(docsPath(col, [qSelect(selectAttrs), qLimit(100), qOffset(offset)]));
      const docs = (data && data.documents) || [];
      out.push(...docs);
      if (docs.length < 100) break;
    }
    return out;
  }

  function applyCache() {
    try {
      const cache = JSON.parse(localStorage.getItem('jzs-stats-cache') || 'null');
      if (cache && cache.stats && Date.now() - cache.t < 10 * 60 * 1000) {
        Object.keys(stats).forEach((k) => delete stats[k]);
        Object.assign(stats, cache.stats);
        serviceState = 'ready';
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  async function loadStats(force) {
    if (!configured) return;
    if (statsPromise && !force) return statsPromise;
    statsPromise = (async () => {
      try {
        const [ratings, comments] = await Promise.all([
          listAll('ratings', ['recipe_id', 'stars']),
          listAll('comments', ['recipe_id']),
        ]);
        const next = {};
        ratings.forEach((d) => {
          const s = next[d.recipe_id] || (next[d.recipe_id] = { sum: 0, count: 0, comments: 0 });
          s.sum += Number(d.stars) || 0;
          s.count += 1;
        });
        comments.forEach((d) => {
          const s = next[d.recipe_id] || (next[d.recipe_id] = { sum: 0, count: 0, comments: 0 });
          s.comments += 1;
        });
        Object.keys(stats).forEach((k) => delete stats[k]);
        Object.keys(next).forEach((id) => {
          const s = next[id];
          stats[id] = { avg: s.count ? Math.round(s.sum / s.count * 10) / 10 : 0, count: s.count, comments: s.comments };
        });
        serviceState = 'ready';
        try { localStorage.setItem('jzs-stats-cache', JSON.stringify({ t: Date.now(), stats })); } catch (e) { /* ignore */ }
      } catch (e) {
        /* 有缓存时继续展示旧数据；写入失败会在提交处单独提示 */
        if (serviceState !== 'ready') serviceState = 'error';
      }
      window.dispatchEvent(new CustomEvent('jzs-stats'));
    })();
    return statsPromise;
  }

  /* ---------------- 卡片装饰 ---------------- */
  function decorateCards(root) {
    $$('[data-rate]', root || document).forEach((el) => {
      const id = el.getAttribute('data-rate');
      if (serviceState !== 'ready') { el.innerHTML = ''; return; }
      const s = getStats(id);
      if (s.count > 0) {
        el.innerHTML = `${starsHTML(s.avg)}<b>${s.avg.toFixed(1)}</b><span>(${s.count})</span><span class="cm-sep">·</span><span>评论 ${s.comments}</span>`;
      } else {
        el.innerHTML = '<span class="no-rate">暂无评分</span>';
      }
    });
  }

  /* ---------------- 弹窗评分评论区 ---------------- */
  function commentItemHTML(c) {
    return `
      <article class="cm-item">
        <header><b>${esc(c.name)}</b><time>${fmtDate(c.created_at)}</time></header>
        <p>${esc(c.body)}</p>
      </article>`;
  }

  function summaryHTML(s) {
    return `
      <div class="cm-avg"><b>${s.count ? s.avg.toFixed(1) : '–'}</b><span>/ 5</span></div>
      ${starsHTML(s.avg, 'stars-lg')}
      <span class="cm-count">${s.count} 人评分 · ${s.comments} 条评论</span>`;
  }

  function pickerHTML(mine) {
    return [1, 2, 3, 4, 5].map((n) =>
      `<button type="button" data-stars="${n}" class="${n <= mine ? 'on' : ''}" aria-label="评 ${n} 星" aria-pressed="${n === mine}">★</button>`
    ).join('');
  }

  async function renderDialog(id, container) {
    if (!container) return;
    if (serviceState === 'off') { container.hidden = true; return; }
    container.hidden = false;
    container.innerHTML = '<h3>评分与评论</h3><p class="cm-note">正在加载…</p>';

    let comments;
    let mine = localMine[id] || 0;
    try {
      const tasks = [
        loadStats(),
        aw(docsPath('comments', [qEqual('recipe_id', id), qOrderDesc('$createdAt'), qLimit(100)])),
      ];
      /* 已有会话时顺带核对“我的评分”，清缓存也不丢 */
      if (session && session.secret) {
        tasks.push(
          ensureSession()
            .then((s) => aw(docsPath('ratings', [qEqual('recipe_id', id), qEqual('voter_id', s.userId), qLimit(1)]), { auth: true }))
            .catch(() => null)
        );
      }
      const results = await Promise.all(tasks);
      comments = ((results[1] && results[1].documents) || []).map((d) => ({ name: d.name, body: d.body, created_at: d.$createdAt }));
      const mineDoc = results[2] && results[2].documents && results[2].documents[0];
      if (mineDoc) { mine = Number(mineDoc.stars) || mine; saveMine(id, mine); }
    } catch (e) {
      container.innerHTML = `<h3>评分与评论</h3><p class="cm-note">评分服务暂时不可用。<button type="button" class="cm-retry">重试</button></p>`;
      $('.cm-retry', container).addEventListener('click', () => renderDialog(id, container));
      return;
    }
    if (!container.isConnected) return; // 弹窗已切换条目

    let savedName = '';
    try { savedName = localStorage.getItem('jzs-name') || ''; } catch (e) { /* ignore */ }

    container.innerHTML = `
      <h3>评分与评论</h3>
      <div class="cm-summary" data-cm-summary>${summaryHTML(getStats(id))}</div>
      <div class="cm-mine">
        <span class="cm-mine-label">我的评分</span>
        <div class="cm-pick" data-cm-pick role="group" aria-label="为这个条目打分">${pickerHTML(mine)}</div>
        <span class="cm-mine-note" data-cm-mine-note>${mine ? `已评 ${mine} 星，点击星星可修改` : '点击星星即可评分'}</span>
      </div>
      <form class="cm-form" data-cm-form>
        <input type="text" name="name" maxlength="20" placeholder="你的昵称（可选，20 字以内）" value="${esc(savedName)}" autocomplete="nickname">
        <textarea name="text" required maxlength="500" rows="3" placeholder="说说这个资源：画质、内容、版本，或你的观看心得…"></textarea>
        <div class="cm-form-foot">
          <span class="cm-form-msg" data-cm-msg role="status"></span>
          <button class="btn" type="submit">发布评论</button>
        </div>
      </form>
      <div class="cm-list">
        <h4 data-cm-list-title>评论（${getStats(id).comments}）</h4>
        <div data-cm-list>${comments.length ? comments.map(commentItemHTML).join('') : '<p class="cm-empty">还没有评论，来写第一条吧。</p>'}</div>
      </div>`;

    const summaryEl = $('[data-cm-summary]', container);
    const pickEl = $('[data-cm-pick]', container);
    const mineNote = $('[data-cm-mine-note]', container);
    const form = $('[data-cm-form]', container);
    const msgEl = $('[data-cm-msg]', container);
    const listEl = $('[data-cm-list]', container);
    const listTitle = $('[data-cm-list-title]', container);

    function refreshSummary() {
      summaryEl.innerHTML = summaryHTML(getStats(id));
      listTitle.textContent = `评论（${getStats(id).comments}）`;
    }

    function setMsg(text, kind) {
      msgEl.textContent = text;
      msgEl.className = 'cm-form-msg' + (kind ? ' ' + kind : '');
    }

    /* 星级打分：一人一票，存在则改，不存在则建 */
    pickEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-stars]');
      if (!btn) return;
      const n = Number(btn.getAttribute('data-stars'));
      $$('button', pickEl).forEach((b) => { b.disabled = true; });
      try {
        const s = await ensureSession();
        const perms = [`read("any")`, `update("user:${s.userId}")`, `delete("user:${s.userId}")`];
        const found = await aw(docsPath('ratings', [qEqual('recipe_id', id), qEqual('voter_id', s.userId), qLimit(1)]), { auth: true });
        if (found.documents && found.documents.length) {
          await aw(docPath('ratings', found.documents[0].$id), { method: 'PATCH', auth: true, body: { data: { stars: n } } });
        } else {
          try {
            await aw(docsPath('ratings'), {
              method: 'POST', auth: true,
              body: { documentId: 'unique()', data: { recipe_id: id, voter_id: s.userId, stars: n }, permissions: perms },
            });
          } catch (err) {
            /* 唯一索引冲突（连点竞态）：改为更新已有票 */
            if (err.status === 409) {
              const again = await aw(docsPath('ratings', [qEqual('recipe_id', id), qEqual('voter_id', s.userId), qLimit(1)]), { auth: true });
              if (again.documents && again.documents.length) {
                await aw(docPath('ratings', again.documents[0].$id), { method: 'PATCH', auth: true, body: { data: { stars: n } } });
              } else { throw err; }
            } else { throw err; }
          }
        }
        saveMine(id, n);
        mine = n;
        await loadStats(true);
        pickEl.innerHTML = pickerHTML(mine);
        mineNote.textContent = `已评 ${mine} 星，点击星星可修改`;
        refreshSummary();
      } catch (err) {
        mineNote.textContent = err.message || '评分失败，请稍后再试';
        $$('button', pickEl).forEach((b) => { b.disabled = false; });
      }
    });
    /* 悬停预览 */
    pickEl.addEventListener('mouseover', (e) => {
      const btn = e.target.closest('[data-stars]');
      if (!btn) return;
      const n = Number(btn.getAttribute('data-stars'));
      $$('button', pickEl).forEach((b) => b.classList.toggle('on', Number(b.getAttribute('data-stars')) <= n));
    });
    pickEl.addEventListener('mouseleave', () => {
      $$('button', pickEl).forEach((b) => b.classList.toggle('on', Number(b.getAttribute('data-stars')) <= mine));
    });

    /* 发表评论 */
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = form.elements.name;
      const textInput = form.elements.text;
      const text = textInput.value.trim();
      if (!text) { setMsg('先写点什么再发布吧', 'err'); textInput.focus(); return; }
      const submitBtn = $('button[type="submit"]', form);
      submitBtn.disabled = true;
      setMsg('正在发布…');
      try {
        const name = nameInput.value.trim() || '匿名访客';
        const doc = await aw(docsPath('comments'), {
          method: 'POST', auth: true,
          body: { documentId: 'unique()', data: { recipe_id: id, name, body: text }, permissions: [`read("any")`] },
        });
        try { localStorage.setItem('jzs-name', nameInput.value.trim()); } catch (err2) { /* ignore */ }
        if (doc) {
          comments = [{ name: doc.name, body: doc.body, created_at: doc.$createdAt }].concat(comments);
          listEl.innerHTML = comments.map(commentItemHTML).join('');
        }
        stats[id] = Object.assign({}, getStats(id), { comments: getStats(id).comments + 1 });
        textInput.value = '';
        refreshSummary();
        setMsg('评论已发布', 'ok');
        window.dispatchEvent(new CustomEvent('jzs-stats'));
      } catch (err) {
        setMsg(err.message || '发布失败，请稍后再试', 'err');
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  window.JZSCommunity = { getStats, decorateCards, renderDialog };

  document.addEventListener('DOMContentLoaded', () => {
    if (!configured) return;
    if (applyCache()) {
      decorateCards(document);
      window.dispatchEvent(new CustomEvent('jzs-stats'));
    }
    loadStats().then(() => decorateCards(document));
  });
})();