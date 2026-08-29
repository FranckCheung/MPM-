/* 软考中项本地学习系统 —— 前端主逻辑 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));
  const LS = 'ruanKaoStudy';

  const state = {
    courses: [],
    byId: {},
    groups: [],
    pages: [],
    progress: {},
    currentId: null,
    subs: [],
    subIdx: -1,
    filter: 'all',
    keyword: '',
    searchSeq: 0,
    noteSeq: 0,
    bookRendered: -1,
    noteRendered: -1,
  };

  const prefs = Object.assign({
    theme: 'dark',
    drawer: false,
    tab: 'book',
    collapsed: {},
    subFollow: true,
    subClickSeek: true,
    subFs: 14,
    rate: 1,
    syncPage: true,
    bookZoom: 1,
    autoNext: true,
  }, readLS(LS + '.prefs', {}));

  function readLS(k, d) {
    try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; }
  }
  function writeLS(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 忽略 */ }
  }
  function savePrefs() { writeLS(LS + '.prefs', prefs); }

  let video = $('#video');

  /* ================= 启动 ================= */
  init();

  // 全局错误可视化：任何脚本异常都显式提示，便于排查
  window.addEventListener('error', (e) => {
    const t = $('#toast');
    if (t) {
      t.textContent = '脚本错误: ' + (e.message || e.error || '未知');
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 6000);
    }
    console.error(e.error || e.message);
  });

  async function init() {
    applyTheme(prefs.theme);
    bindEvents();
    applySubFontSize(prefs.subFs);
    $('#rate').value = String(prefs.rate);
    $('#subFollow').checked = prefs.subFollow;
    $('#subClickSeek').checked = prefs.subClickSeek;
    $('#syncPage').checked = prefs.syncPage;
    $('#autoNext').checked = prefs.autoNext;

    // 必须通过本地服务访问（file:// 下 fetch 会被浏览器拦截）
    if (location.protocol === 'file:') {
      $('#courseList').innerHTML =
        '<div class="sub-empty">请通过本地服务访问本页面<br>例如 http://127.0.0.1:8765<br>（不要直接双击打开 html 文件）</div>';
      return;
    }

    let c, p, g;
    try {
      const [rc, rp, rg] = await Promise.all([
        fetch('/api/courses'),
        fetch('/api/pages'),
        fetch('/api/progress'),
      ]);
      if (!rc.ok) throw new Error('课程索引加载失败: HTTP ' + rc.status);
      c = await rc.json();
      p = rp.ok ? await rp.json() : [];
      g = rg.ok ? await rg.json() : {};
    } catch (err) {
      $('#courseList').innerHTML =
        '<div class="sub-empty">数据加载失败：' + escHtml(err.message) +
        '<br>请确认服务已启动 (http://127.0.0.1:8765)</div>';
      return;
    }

    state.courses = c.courses || [];
    state.groups = c.groups || [];
    state.pages = p || [];
    state.progress = g || {};
    state.courses.forEach((x) => { state.byId[x.id] = x; });

    $('#bookTotal').textContent = state.pages.length;
    $('#noteTotal').textContent = state.pages.length;
    $('#stTotal').textContent = state.courses.length;

    renderList();
    updateStats();

    // 索引为空（原始资料未就绪）时提前返回，避免后续取 courses[0] 崩溃
    if (!state.courses.length) {
      $('#courseList').innerHTML =
        '<div class="sub-empty">未检测到课程索引<br>' +
        '请先运行 <code>python study/build_index.py</code> 生成<br>' +
        '（视频 / 字幕 / 教材等原始资料需自备，不随仓库分发）</div>';
      return;
    }

    const last = readLS(LS + '.last', null);
    const start = (last && state.byId[last]) ? last : state.courses[0].id;
    state.currentId = start;
    writeLS(LS + '.last', start);
    // 启动时不自动设置 video.src，避免浏览器为未播放视频分配媒体缓冲
    // 仅高亮课程、同步右侧页码，等用户点击课程或播放按钮再真正加载视频
    $$('.item').forEach((e) => e.classList.toggle('active', e.dataset.id === start));
    const startCourse = state.byId[start];
    if (startCourse) {
      $('#curNo').textContent = startCourse.no;
      $('#curTitle').textContent = startCourse.title;
    }
    if (startCourse) {
      const saved = state.progress[start];
      const page = saved && saved.page ? saved.page : autoLocatePage(startCourse);
      // 启动时不加载课本扫描件和页码笔记，避免初始化阶段就占用大量内存/解码大图片
      // 仅记录目标页码；等用户打开右侧抽屉时再真正加载
      state.bookPage = page;
      state.notePage = page;
      $('#bookPage').value = page;
      $('#notePage').value = page;
      updateMarkBtn();
    }
    if (prefs.drawer) openDrawer(prefs.tab);
  }

  /* ================= 左侧课程清单 ================= */
  // 学习状态定义（只认播放行为，不采信历史 status 脏标记）：
  //   待开始 todo     —— 视频从未播放过（无记录或播放位置为 0）
  //   学习中 learning —— 播放过，但尚未完整播放结束
  //   已完成 done     —— 视频完整播放结束（ended 触发）或手动标记完成
  // finished 是独立标记位：历史数据里没有该字段，会自动回落到按播放位置判定，
  // 从而把过去"没播过却被标 done"的记录纠正为 待开始/学习中。
  function statusOf(id) {
    const p = state.progress[id];
    if (!p) return 'todo';                        // 无进度记录 = 从未播放
    if (p.finished) return 'done';                // 完整播放结束 / 手动标记完成
    if ((p.position || 0) > 0) return 'learning'; // 播过但没播完
    return 'todo';
  }

  function pctOf(id) {
    const p = state.progress[id];
    if (!p || !p.duration) return 0;
    return Math.min(100, Math.round((p.position / p.duration) * 100));
  }

  function matchFilter(id) {
    if (state.filter === 'all') return true;
    const st = statusOf(id);
    if (state.filter === 'todo') return st === 'todo';
    if (state.filter === 'learning') return st === 'learning';
    if (state.filter === 'done') return st === 'done';
    return true;
  }

  function matchKeyword(c) {
    if (!state.keyword) return true;
    return (c.full + ' ' + c.chapter + ' ' + c.lesson).toLowerCase().indexOf(state.keyword.toLowerCase()) >= 0;
  }

  function renderList() {
    const box = $('#courseList');
    box.innerHTML = '';
    state.groups.forEach((g) => {
      const items = g.items.map((id) => state.byId[id]).filter(Boolean);
      const visible = items.filter((c) => matchFilter(c.id) && matchKeyword(c));
      if (!visible.length && state.filter !== 'all') return;
      if (!visible.length && state.keyword) return;

      const gEl = document.createElement('div');
      gEl.className = 'group' + (prefs.collapsed[g.key] ? ' collapsed' : '');
      const head = document.createElement('div');
      head.className = 'group-head';
      // 显示「已完成数 / 视频总数」：原先用的是筛选后可见数，会被误读成已完成数
      const doneCount = items.filter((c) => statusOf(c.id) === 'done').length;
      head.innerHTML = '<span class="gh-arrow">▼</span><span class="gh-name"></span>' +
        '<span class="gh-count" title="已完成 / 视频总数">✓ ' + doneCount + '/' + items.length + '</span>';
      head.querySelector('.gh-name').textContent = g.name;
      head.onclick = () => {
        gEl.classList.toggle('collapsed');
        prefs.collapsed[g.key] = gEl.classList.contains('collapsed');
        savePrefs();
      };
      gEl.appendChild(head);

      const wrap = document.createElement('div');
      wrap.className = 'group-items';
      visible.forEach((c) => wrap.appendChild(renderItem(c)));
      gEl.appendChild(wrap);
      box.appendChild(gEl);
    });
    if (!box.children.length) {
      box.innerHTML = '<div class="sub-empty">无匹配课程</div>';
    }
  }

  function renderItem(c) {
    const st = statusOf(c.id);
    const el = document.createElement('div');
    el.className = 'item' + (c.id === state.currentId ? ' active' : '');
    el.dataset.id = c.id;
    el.innerHTML =
      '<span class="dot ' + st + '"></span>' +
      '<span class="no">' + c.no + '</span>' +
      '<span class="t"><span class="nm">' + escHtml(c.title) + '</span>' +
      '<span class="pg"><i style="width:' + pctOf(c.id) + '%"></i></span></span>';
    el.onclick = () => loadCourse(c.id, { autoplay: false });
    return el;
  }

  function updateStats() {
    let done = 0, learning = 0, todo = 0;
    state.courses.forEach((c) => {
      const s = statusOf(c.id);
      if (s === 'done') done++; else if (s === 'learning') learning++; else todo++;
    });
    $('#stDone').textContent = done;
    $('#stDoing').textContent = learning;
    $('#stTodo').textContent = todo;
  }

  function refreshItem(id) {
    const el = $('.item[data-id="' + id + '"]');
    if (!el) return;
    const st = statusOf(id);
    el.querySelector('.dot').className = 'dot ' + st;
    const pg = el.querySelector('.pg i');
    if (pg) pg.style.width = pctOf(id) + '%';
  }

  /* ================= 课程加载 ================= */
  let saveTimer = null;
  function loadCourse(id, opts) {
    const c = state.byId[id];
    if (!c) return;
    state.currentId = id;
    writeLS(LS + '.last', id);

    $('#curNo').textContent = c.no;
    $('#curTitle').textContent = c.title;
    const mask = $('#emptyMask');
    if (mask) mask.style.display = 'none';
    $$('.item').forEach((e) => e.classList.toggle('active', e.dataset.id === id));

    // 彻底释放上一个视频的媒体缓冲与解码器，避免切换课程时内存暴涨
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.parentNode.removeChild(video);
    }
    const container = $('.player-wrap');
    const newVideo = document.createElement('video');
    newVideo.id = 'video';
    newVideo.controls = true;
    newVideo.preload = 'none';
    newVideo.playsInline = true;
    newVideo.style.width = '100%';
    newVideo.style.height = '100%';
    newVideo.style.display = 'block';
    newVideo.style.background = '#000';
    container.insertBefore(newVideo, container.firstChild);
    video = newVideo;
    bindVideoEvents(video);

    video.src = '/' + encodeURI(c.video);
    video.playbackRate = prefs.rate;

    loadSubtitles(c);
    updateMarkBtn();

    // 断点续播
    const saved = state.progress[id];
    state.resumeAt = (saved && saved.position > 5) ? saved.position : 0;
    if (state.resumeAt) {
      $('#resumeTip').textContent = '将从 ' + fmt(state.resumeAt) + ' 处续播';
    } else {
      $('#resumeTip').textContent = '';
    }

    // 课本/笔记页码：优先用记忆的页码，否则自动定位
    let page = saved && saved.page ? saved.page : autoLocatePage(c);
    state.bookPage = page;
    state.notePage = prefs.syncPage ? page : (state.notePage || page);
    $('#bookPage').value = state.bookPage;
    $('#notePage').value = state.notePage;
    // 抽屉未打开时不加载扫描件/笔记，避免切换课程时持续占用内存
    const drawerOpen = $('#drawer').classList.contains('open');
    if (drawerOpen) {
      if (prefs.tab === 'book') setBookPage(state.bookPage, false);
      else if (prefs.tab === 'note') setNotePage(state.notePage, false);
      else if (prefs.tab === 'kp') loadKp(c);
    }
  }

  /* ================= 字幕 ================= */
  const TS_RE = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s?(.*)$/;

  function loadSubtitles(c) {
    state.subs = [];
    state.subIdx = -1;
    const body = $('#subBody');
    if (!c.transcript) {
      body.innerHTML = '<div class="sub-empty">本节无字幕文件</div>';
      $('#subCount').textContent = '';
      return;
    }
    fetch('/' + encodeURI(c.transcript))
      .then((r) => r.text())
      .then((txt) => {
        const lines = txt.split(/\r?\n/);
        const subs = [];
        for (let i = 0; i < lines.length; i++) {
          const m = TS_RE.exec(lines[i].trim());
          if (m) {
            const time = m[3]
              ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])
              : (+m[1]) * 60 + (+m[2]);
            const text = m[4].trim();
            if (text) subs.push({ t: time, text: text });
          }
        }
        state.subs = subs;
        $('#subCount').textContent = subs.length + ' 句';
        if (!subs.length) {
          body.innerHTML = '<div class="sub-empty">字幕中未找到时间轴</div>';
          return;
        }
        body.innerHTML = '';
        subs.forEach((s, i) => {
          const row = document.createElement('div');
          row.className = 'sub-line';
          row.dataset.i = i;
          row.innerHTML = '<span class="ts">' + fmt(s.t) + '</span>' + escHtml(s.text);
          if (prefs.subClickSeek) {
            row.onclick = () => { if (video) { video.currentTime = s.t; video.play(); } };
          }
          body.appendChild(row);
        });
        syncSubtitle(false);
      })
      .catch(() => { body.innerHTML = '<div class="sub-empty">字幕加载失败</div>'; });
  }

  function syncSubtitle(scroll) {
    const subs = state.subs;
    if (!subs.length) return;
    const t = video.currentTime;
    let lo = 0, hi = subs.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (subs[mid].t <= t) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx === state.subIdx) return;
    const rows = $('#subBody').children;
    if (state.subIdx >= 0 && rows[state.subIdx]) rows[state.subIdx].classList.remove('on');
    state.subIdx = idx;
    if (idx >= 0 && rows[idx]) {
      rows[idx].classList.add('on');
      if (scroll !== false && prefs.subFollow) {
        const r = rows[idx];
        const body = $('#subBody');
        // 当前句置顶：减去容器上内边距，使高亮行稳定停在滚动区第一行
        const padTop = parseFloat(getComputedStyle(body).paddingTop) || 0;
        body.scrollTop = Math.max(0, r.offsetTop - padTop);
      }
    }
  }

  /* ================= 视频事件 ================= */
  bindVideoEvents(video);

  let lastSave = 0;
  function bindVideoEvents(v) {
    v.addEventListener('loadedmetadata', () => {
      if (state.resumeAt && v.duration > state.resumeAt + 3) {
        v.currentTime = state.resumeAt;
        toast('已恢复到 ' + fmt(state.resumeAt) + ' 续播');
      }
      state.resumeAt = 0;
      $('#resumeTip').textContent = '';
    });
    v.addEventListener('timeupdate', () => {
      syncSubtitle();
      const now = Date.now();
      // 播放中 8 秒保存一次即可，pause/ended 会立即保存
      if (now - lastSave > 8000) { lastSave = now; saveProgress(); }
    });
    v.addEventListener('pause', saveProgress);
    v.addEventListener('ended', () => {
      saveProgress(true);
      if (prefs.autoNext) gotoCourse(1);
    });
    v.addEventListener('ratechange', () => {
      prefs.rate = v.playbackRate;
      savePrefs();
    });
  }

  function saveProgress(forceDone) {
    if (!state.currentId) return;
    const id = state.currentId;
    const p = state.progress[id] || {};
    const dur = video.duration || p.duration || 0;
    const pos = video.currentTime || 0;
    // finished：完整播完过一次（ended）或用户手动标记完成
    const finished = forceDone ? true : !!p.finished;
    state.progress[id] = {
      position: pos,
      duration: dur,
      status: finished ? 'done' : (pos > 0 ? 'learning' : 'todo'),
      finished: finished,
      page: getBookPage(),
      updatedAt: new Date().toISOString(),
    };
    sendProgress(id, state.progress[id]);
    refreshItem(id);
    updateStats();
  }

  function sendProgress(id, obj) {
    const payload = JSON.stringify({
      id: id,
      position: obj.position,
      duration: obj.duration,
      status: obj.status,
      finished: !!obj.finished,
      page: obj.page,
    });
    try {
      navigator.sendBeacon('/api/progress', new Blob([payload], { type: 'application/json' }));
    } catch (e) {
      fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  }

  /* ================= 课本 / 笔记 页码 ================= */
  function clampPage(n) {
    return Math.max(1, Math.min(state.pages.length || 1, parseInt(n, 10) || 1));
  }

  /* ================= 课本面板 ================= */
  function getBookPage() {
    return clampPage($('#bookPage').value);
  }

  function renderBook(n) {
    const view = $('#bookView');
    const pg = state.pages.find((p) => p.page === n);
    if (!pg) { view.innerHTML = '<div class="loading">无该页</div>'; state.bookRendered = -1; return; }
    if (state.bookRendered === n) return; // 同页已渲染，避免重复加载大扫描件
    // decoding="async" + loading="lazy"：把图片解码放到非主线程，避免大扫描件阻塞渲染并减少峰值内存
    view.innerHTML = '<img id="bookImg" alt="page ' + n + '" loading="lazy" decoding="async" src="/' + encodeURI(pg.img) + '">';
    state.bookRendered = n;
    applyZoom();
  }

  function setBookPage(n, remember) {
    n = clampPage(n);
    state.bookPage = n;
    $('#bookPage').value = n;
    // 与页码笔记联动：同步开启时笔记页码跟随课本，切到笔记面板即为同一页
    if (prefs.syncPage) {
      state.notePage = n;
      $('#notePage').value = n;
      if (prefs.tab === 'note') renderNote(n);
    }
    if (prefs.tab === 'book') renderBook(n);
    if (remember) saveProgress();
  }
  function applyZoom() {
    const img = $('#bookImg');
    if (img) {
      img.style.width = (prefs.bookZoom * 100) + '%';
    }
    $('#bookZoomTxt').textContent = Math.round(prefs.bookZoom * 100) + '%';
  }

  /* ================= 笔记面板 ================= */
  function getNotePage() {
    return clampPage($('#notePage').value);
  }

  function renderNote(n) {
    const view = $('#noteView');
    const pg = state.pages.find((p) => p.page === n);
    if (!pg) { view.innerHTML = '<div class="loading">无该页</div>'; state.noteRendered = -1; return; }
    if (state.noteRendered === n) return; // 同页已渲染
    view.innerHTML = '<div class="loading">加载中…</div>';
    const seq = ++state.noteSeq;
    fetch('/' + encodeURI(pg.md))
      .then((r) => r.text())
      .then((md) => {
        if (seq !== state.noteSeq) return; // 已有更新的请求，丢弃过期结果
        view.innerHTML = MD.render(md);
        view.scrollTop = 0;
        state.noteRendered = n;
      })
      .catch(() => {
        if (seq === state.noteSeq) view.innerHTML = '<div class="loading">笔记加载失败</div>';
      });
  }

  function setNotePage(n, remember) {
    n = clampPage(n);
    state.notePage = n;
    $('#notePage').value = n;
    // 与课本扫描件联动：同步开启时课本页码跟随笔记，切到课本面板即为同一页
    if (prefs.syncPage) {
      state.bookPage = n;
      $('#bookPage').value = n;
      if (prefs.tab === 'book') renderBook(n);
    }
    if (prefs.tab === 'note') renderNote(n);
    if (remember) saveProgress();
  }

  function noteSearch(kw) {
    kw = (kw || '').trim();
    const box = $('#searchResults');
    if (!kw) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const seq = ++state.searchSeq;
    const hits = [];
    const low = kw.toLowerCase();
    for (let i = 0; i < state.pages.length; i++) {
      const t = state.pages[i].text;
      const idx = t.toLowerCase().indexOf(low);
      if (idx >= 0) {
        hits.push({ page: state.pages[i].page, text: t, idx: idx });
        if (hits.length >= 60) break;
      }
    }
    if (seq !== state.searchSeq) return;
    box.classList.remove('hidden');
    if (!hits.length) { box.innerHTML = '<div class="sr-item">未匹配到结果</div>'; return; }
    box.innerHTML = '';
    hits.forEach((h) => {
      const start = Math.max(0, h.idx - 14);
      const snippet = (start > 0 ? '…' : '') + h.text.slice(start, h.idx + kw.length + 18).replace(/\s+/g, ' ');
      const div = document.createElement('div');
      div.className = 'sr-item';
      div.innerHTML = '<span class="sp">P' + h.page + '</span>' +
        escHtml(snippet).replace(escHtml(kw), '<mark>' + escHtml(kw) + '</mark>');
      // 同步开启时只需驱动课本页码，笔记会随之联动到同一页
      div.onclick = () => {
        if (prefs.syncPage) setBookPage(h.page, true);
        else setNotePage(h.page, true);
      };
      box.appendChild(div);
    });
  }

  function autoLocatePage(c) {
    // 从课程标题抽取关键词（去首尾序号），在全书文本中检索出现最多的页码
    let kw = (c.lesson || c.title || '')
      .replace(/^\d+/, '')            // 去前导章号，如 "01"
      .replace(/\d{1,2}$/, '')        // 去尾部小节号，如 "01"
      .trim();
    if (kw.length < 3) kw = (c.chapter || '').replace(/^\d+/, '').trim();
    if (kw.length < 2) return 1;
    const low = kw.toLowerCase();
    const score = {};
    for (let i = 0; i < state.pages.length; i++) {
      const t = state.pages[i].text.toLowerCase();
      let pos = t.indexOf(low), cnt = 0;
      while (pos >= 0) { cnt++; if (cnt > 6) break; pos = t.indexOf(low, pos + low.length); }
      if (cnt) score[state.pages[i].page] = cnt;
    }
    let best = 1, bestN = 0;
    Object.keys(score).forEach((p) => {
      const weight = score[p] + (parseInt(p) / 10000); // 略偏好靠前的页
      if (weight > bestN) { bestN = weight; best = parseInt(p); }
    });
    return bestN ? best : 1;
  }

  /* ================= 知识点面板 ================= */
  function loadKp(c) {
    const view = $('#kpView');
    $('#kpTitle').textContent = '知识点 · ' + (c ? c.title : '');
    if (!c || !c.kp) { view.innerHTML = '<div class="loading">本节无知识点文档</div>'; return; }
    view.innerHTML = '<div class="loading">加载中…</div>';
    fetch('/' + encodeURI(c.kp))
      .then((r) => r.text())
      .then((md) => { view.innerHTML = MD.render(md); view.scrollTop = 0; })
      .catch(() => { view.innerHTML = '<div class="loading">知识点加载失败</div>'; });
  }

  /* ================= 抽屉 / 面板 ================= */
  function openDrawer(tab) {
    if (tab) prefs.tab = tab;
    const layout = $('#layout');
    layout.classList.add('drawer-open');
    $('#drawer').classList.add('open');
    const btn = $('.rail-btn[data-panel="' + prefs.tab + '"]');
    $$('.rail-btn').forEach((b) => b.classList.remove('on'));
    if (btn) btn.classList.add('on');
    $$('.drawer-tabs button[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === prefs.tab));
    $$('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.p !== prefs.tab));
    loadPanel(prefs.tab);
    prefs.drawer = true; savePrefs();
  }

  function loadPanel(tab) {
    const c = state.byId[state.currentId];
    if (!c) return;
    if (tab === 'book') {
      setBookPage(getBookPage(), false);
    } else if (tab === 'note') {
      // 联动核心：同步开启时以课本当前页为准，保证"课本第 N 页 → 笔记也是第 N 页"
      setNotePage(prefs.syncPage ? getBookPage() : getNotePage(), false);
    } else if (tab === 'kp') {
      if (!$('#kpView').querySelector('.md')) loadKp(c);
    }
  }
  function closeDrawer() {
    $('#layout').classList.remove('drawer-open');
    $('#drawer').classList.remove('open');
    $$('.rail-btn').forEach((b) => b.classList.remove('on'));
    prefs.drawer = false; savePrefs();
  }

  /* ================= 导航 ================= */
  function courseOrder() { return state.courses.map((c) => c.id); }
  function gotoCourse(delta) {
    const order = courseOrder();
    const i = order.indexOf(state.currentId);
    const ni = i + delta;
    if (ni < 0 || ni >= order.length) { if (delta > 0) toast('已经是最后一节'); return; }
    loadCourse(order[ni], { autoplay: false });
  }

  function updateMarkBtn() {
    const btn = $('#markBtn');
    const c = state.byId[state.currentId];
    if (!c) return;
    const st = statusOf(c.id);
    if (st === 'done') { btn.textContent = '↺ 取消完成'; btn.classList.add('is-done'); }
    else { btn.textContent = '✓ 标记完成'; btn.classList.remove('is-done'); }
  }

  function toggleDone() {
    const id = state.currentId;
    const p = state.progress[id] || {};
    const nowDone = statusOf(id) !== 'done';
    // 手动标记/取消只改 finished 标记位，不伪造播放进度，避免出现"没播过却已完成"
    p.finished = nowDone;
    p.status = nowDone ? 'done' : 'learning';
    if (!p.position) p.position = video.currentTime || 0;
    if (!p.duration) p.duration = video.duration || 0;
    p.page = getBookPage();
    state.progress[id] = p;
    sendProgress(id, p);
    refreshItem(id); updateStats(); updateMarkBtn();
    toast(nowDone ? '已标记完成' : '已取消完成');
  }

  /* ================= 工具 ================= */
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(s / 60), sec = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function applyTheme(t) {
    document.body.classList.toggle('light', t === 'light');
  }
  function applySubFontSize(px) {
    document.documentElement.style.setProperty('--sub-fs', px + 'px');
  }
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  /* ================= 事件绑定 ================= */
  function bindEvents() {
    $('#search').addEventListener('input', (e) => { state.keyword = e.target.value; renderList(); });
    $$('#filters button').forEach((b) => b.addEventListener('click', () => {
      $$('#filters button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      state.filter = b.dataset.f;
      renderList();
    }));
    $('#expandAll').onclick = () => { state.groups.forEach((g) => prefs.collapsed[g.key] = false); savePrefs(); renderList(); };
    $('#collapseAll').onclick = () => { state.groups.forEach((g) => prefs.collapsed[g.key] = true); savePrefs(); renderList(); };

    $('#prevBtn').onclick = () => gotoCourse(-1);
    $('#nextBtn').onclick = () => gotoCourse(1);
    $('#markBtn').onclick = toggleDone;
    $('#rate').onchange = (e) => { video.playbackRate = parseFloat(e.target.value); prefs.rate = video.playbackRate; savePrefs(); };
    $('#autoNext').onchange = (e) => { prefs.autoNext = e.target.checked; savePrefs(); };

    $('#subFollow').onchange = (e) => { prefs.subFollow = e.target.checked; savePrefs(); };
    $('#subClickSeek').onchange = (e) => {
      prefs.subClickSeek = e.target.checked; savePrefs();
      loadSubtitles(state.byId[state.currentId]);
    };
    $('#fontUp').onclick = () => { prefs.subFs = Math.min(26, prefs.subFs + 2); applySubFontSize(prefs.subFs); savePrefs(); };
    $('#fontDown').onclick = () => { prefs.subFs = Math.max(11, prefs.subFs - 2); applySubFontSize(prefs.subFs); savePrefs(); };

    $$('.rail-btn').forEach((b) => b.onclick = () => {
      const p = b.dataset.panel;
      if (p === 'close') { closeDrawer(); return; }
      const isOpen = $('#drawer').classList.contains('open') && prefs.tab === p;
      if (isOpen) closeDrawer();
      else openDrawer(p);
    });
    $$('.drawer-tabs button[data-t]').forEach((b) => b.onclick = () => openDrawer(b.dataset.t));
    $('#drawerClose').onclick = closeDrawer;

    $('#bookPrev').onclick = () => setBookPage(getBookPage() - 1, true);
    $('#bookNext').onclick = () => setBookPage(getBookPage() + 1, true);
    $('#bookPage').onchange = (e) => setBookPage(e.target.value, true);
    $('#bookZoomIn').onclick = () => { prefs.bookZoom = Math.min(3, prefs.bookZoom + 0.15); applyZoom(); savePrefs(); };
    $('#bookZoomOut').onclick = () => { prefs.bookZoom = Math.max(0.4, prefs.bookZoom - 0.15); applyZoom(); savePrefs(); };
    $('#bookFit').onclick = () => { prefs.bookZoom = 1; applyZoom(); savePrefs(); };

    $('#notePrev').onclick = () => setNotePage(getNotePage() - 1, true);
    $('#noteNext').onclick = () => setNotePage(getNotePage() + 1, true);
    $('#notePage').onchange = (e) => setNotePage(e.target.value, true);
    $('#syncPage').onchange = (e) => {
      prefs.syncPage = e.target.checked; savePrefs();
      if (prefs.syncPage) setNotePage(getBookPage(), true);
    };
    $('#noteSearch').addEventListener('input', (e) => noteSearch(e.target.value));
    $('#noteSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') noteSearch(e.target.value); });
    $('#noteLocate').onclick = () => {
      const c = state.byId[state.currentId];
      if (!c) return;
      const pg = autoLocatePage(c);
      setBookPage(pg, true); // 同步开启时笔记自动跟随到同一页
      toast('已定位到页码 P' + pg);
    };
    $('#kpReload').onclick = () => loadKp(state.byId[state.currentId]);

    $('#themeBtn').onclick = () => {
      prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
      applyTheme(prefs.theme); savePrefs();
    };

    // 课本/笔记同步翻页（当同步开启时）
    window.addEventListener('beforeunload', () => { if (state.currentId) saveProgress(); });

    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === ' ') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); video.currentTime = Math.min(video.duration || 9e9, video.currentTime + 5); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); }
      else if (e.key.toLowerCase() === 'j') { video.currentTime = Math.max(0, video.currentTime - 10); }
      else if (e.key.toLowerCase() === 'l') { video.currentTime = Math.min(video.duration || 9e9, video.currentTime + 10); }
      else if (e.key.toLowerCase() === 'k') { video.paused ? video.play() : video.pause(); }
      else if (e.key.toLowerCase() === 'n') { gotoCourse(1); }
      else if (e.key.toLowerCase() === 'p') { gotoCourse(-1); }
    });
  }
})();
