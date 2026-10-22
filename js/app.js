// Табель рабочего времени — интерфейс.
// Страницы: #/tracker (таймер и отчёт за день), #/archive (прошлые дни),
// #/reviews (итоги недели и месяца), #/results (диаграммы по категориям).
(() => {
  const cfg = window.TABEL_CONFIG || {};
  const DAY = U.DAY;
  const root = document.getElementById('root');

  const A = {
    user: null,
    cats: [],
    running: null,
    tick: null,          // per-page 1s updater
    cleanup: [],         // per-page teardown
    editingId: null,
    pendingDelete: null,
    openDays: new Set(),
    dirty: false,        // unsaved text in a report field
    addTarget: null      // select that asked for a new category
  };
  let api = null;
  let runChain = Promise.resolve(); // writes to the running entry go one after another
  const queueRun = (fn) => (runChain = runChain.catch(() => {}).then(fn));

  /* ---------------- small helpers ---------------- */
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#8E9AA6');

  let toastT = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3500);
  }

  async function guard(fn) {
    try { return await fn(); }
    catch (e) {
      const msg = (e && e.message) || 'Что-то пошло не так.';
      if (/Сессия истекла/.test(msg)) { A.user = null; renderLogin(msg); return undefined; }
      toast(msg.startsWith('Failed to fetch') ? 'Нет соединения с сервером. Проверьте интернет.' : msg);
      return undefined;
    }
  }

  const catById = (id) => A.cats.find((c) => c.id === id) || null;
  const catName = (id) => (catById(id) ? catById(id).name : 'Без категории');
  const catColor = (id) => (catById(id) ? safeColor(catById(id).color) : '#8E9AA6');
  const activeCats = () => A.cats.filter((c) => !c.archived);
  const durOf = (e, now) => Math.max(0, (e.end || now) - e.start);

  function catOptions(selected) {
    const list = activeCats().slice();
    const sel = catById(selected);
    if (sel && sel.archived) list.push(sel);
    let html = list.map((c) => `<option value="${c.id}">${U.esc(c.name)}</option>`).join('');
    if (!selected) html = '<option value="" disabled>Выберите категорию</option>' + html;
    return html + '<option value="__add">+ Добавить категорию…</option>';
  }
  function fillCatSelect(sel, value) {
    sel.innerHTML = catOptions(value);
    const v = catById(value) ? value : (activeCats()[0] ? activeCats()[0].id : '');
    sel.value = v;
    sel.dataset.prev = v;
  }

  function totalsByCat(entries, now) {
    const m = new Map();
    for (const e of entries) m.set(e.categoryId || '', (m.get(e.categoryId || '') || 0) + durOf(e, now));
    return m;
  }
  // category ids in display order: active categories, then others that have time
  function orderedIds(totals, includeZero) {
    const ids = A.cats.filter((c) => (includeZero && !c.archived) || (totals.get(c.id) || 0) > 0).map((c) => c.id);
    if ((totals.get('') || 0) > 0) ids.push('');
    return ids;
  }

  function breakdownHtml(totals, sum, emptyText) {
    const ids = orderedIds(totals, false).sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0));
    if (!ids.length) return `<span class="muted" style="font-size:14px">${emptyText}</span>`;
    return ids.map((id) => {
      const ms = totals.get(id) || 0;
      const pct = sum ? ms / sum * 100 : 0;
      return `<div class="bk-row"><div class="bk-top"><span class="n"><span class="sw" style="background:${catColor(id)}"></span><span>${U.esc(catName(id))}</span></span><span class="h">${U.hm(ms)} · ${Math.round(pct)}%</span></div><div class="track"><div style="width:${pct}%;background:${catColor(id)}"></div></div></div>`;
    }).join('');
  }

  /* ---------------- routing ---------------- */
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, qs] = h.split('?');
    return { path: path || 'tracker', q: new URLSearchParams(qs || '') };
  }
  function teardown() {
    for (const f of A.cleanup) { try { f(); } catch (e) { /* ignore */ } }
    A.cleanup = []; A.tick = null;
  }
  let routing = false;
  async function route() {
    if (!A.user) return;
    if (routing) return;
    routing = true;
    try {
      teardown();
      const { path, q } = parseHash();
      $$('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.page === path));
      const pages = { tracker: pageTracker, archive: pageArchive, reviews: pageReviews, results: pageResults };
      await guard(() => (pages[path] || pageTracker)(q));
    } finally { routing = false; }
  }
  window.addEventListener('hashchange', () => { A.editingId = null; A.pendingDelete = null; A.dirty = false; route(); });

  // pick up changes made on other devices
  function canRefresh() {
    const a = document.activeElement;
    if (a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false;
    if (A.editingId || A.dirty || $('#catDialog')?.open) return false;
    return true;
  }
  async function softRefresh() {
    if (!A.user || !canRefresh()) return;
    await guard(loadCats);
    route();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') softRefresh(); });
  setInterval(() => { if (document.visibilityState === 'visible') softRefresh(); }, 120000);
  setInterval(() => { if (A.tick) A.tick(); }, 1000);

  /* ---------------- boot & auth ---------------- */
  async function boot() {
    try { api = window.createApi(cfg); }
    catch (e) { root.innerHTML = `<div class="login wrap"><div class="login-card"><h1>Ошибка запуска</h1><p>${U.esc(e.message)}</p></div></div>`; return; }
    const u = await api.init().catch(() => null);
    if (u) { A.user = u; await afterLogin(); } else renderLogin();
  }

  function renderLogin(message) {
    teardown();
    root.innerHTML = `
      <div class="login wrap">
        <form class="login-card" id="loginForm" novalidate>
          <div style="display:grid;gap:4px">
            <h1>Табель</h1>
            <p>Войдите, чтобы вести учёт времени. Аккаунт общий для всех ваших устройств.</p>
          </div>
          ${api.mode === 'local' ? '<p class="warn">Локальный режим: Supabase не настроен, данные хранятся только в этом браузере.</p>' : ''}
          <label class="field"><span class="label">Логин</span><input id="lLogin" autocomplete="username" required autofocus></label>
          <label class="field"><span class="label">Пароль</span><input id="lPass" type="password" autocomplete="current-password" required></label>
          <div class="form-err" id="lErr">${U.esc(message || '')}</div>
          <button class="btn" type="submit" id="lBtn">Войти</button>
        </form>
      </div>`;
    $('#loginForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const login = $('#lLogin').value.trim(), pass = $('#lPass').value;
      if (!login || !pass) { $('#lErr').textContent = 'Введите логин и пароль.'; return; }
      $('#lBtn').disabled = true; $('#lErr').textContent = '';
      try { A.user = await api.signIn(login, pass); await afterLogin(); }
      catch (e) { $('#lErr').textContent = e.message || 'Не удалось войти.'; $('#lBtn').disabled = false; }
    });
  }

  async function afterLogin() {
    renderShell();
    const ok = await guard(loadCats);
    if (ok === undefined && !A.user) return;
    if (!location.hash) location.hash = '#/tracker';
    else route();
  }

  async function loadCats() {
    let cats = await api.listCategories();
    if (!cats.length) {
      for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
        await api.addCategory({ ...DEFAULT_CATEGORIES[i], sort: i });
      }
      cats = await api.listCategories();
    }
    A.cats = cats;
    return true;
  }

  function renderShell() {
    root.innerHTML = `
      <header class="bar"><div class="wrap">
        <span class="brand">Табель</span>
        <nav class="nav">
          <a href="#/tracker" data-page="tracker">Трекер</a>
          <a href="#/archive" data-page="archive">Архив дней</a>
          <a href="#/reviews" data-page="reviews">Итоги недели и месяца</a>
          <a href="#/results" data-page="results">Результаты</a>
        </nav>
        <div class="who">
          ${api.mode === 'local' ? '<span class="mode-pill" title="Данные хранятся только в этом браузере">локально</span>' : ''}
          <span>${U.esc(A.user.login)}</span>
          <button class="link-btn" id="logout">Выйти</button>
        </div>
      </div></header>
      <main class="wrap" id="view"></main>
      <dialog id="catDialog" style="border:1px solid var(--line);border-radius:14px;background:var(--surface);color:var(--ink);padding:20px;width:min(420px,calc(100% - 32px))">
        <form id="catForm" method="dialog" style="display:grid;gap:12px">
          <h2 style="margin:0;font-family:var(--display);font-weight:500;font-size:16px">Новая категория</h2>
          <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end">
            <label class="field"><span class="label">Название</span><input id="ncName" maxlength="60" autocomplete="off" required></label>
            <label class="field"><span class="label">Цвет</span><input id="ncColor" type="color"></label>
          </div>
          <div class="form-err" id="ncErr"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn ghost" type="button" id="ncCancel">Отмена</button>
            <button class="btn" type="submit" id="ncSave">Добавить</button>
          </div>
        </form>
      </dialog>`;
    $('#logout').addEventListener('click', async () => {
      await guard(() => api.signOut());
      A.user = null; teardown(); location.hash = ''; renderLogin();
    });
    $('#ncCancel').addEventListener('click', () => { $('#catDialog').close(); });
    $('#catDialog').addEventListener('close', () => { A.addTarget = null; });
    $('#catForm').addEventListener('submit', onAddCategory);
  }

  /* ---------------- categories ---------------- */
  function nextColor() {
    const used = new Set(A.cats.map((c) => c.color.toLowerCase()));
    return EXTRA_COLORS.find((c) => !used.has(c.toLowerCase())) || EXTRA_COLORS[A.cats.length % EXTRA_COLORS.length];
  }
  function openCatDialog(targetSelectId) {
    A.addTarget = targetSelectId;
    $('#ncName').value = ''; $('#ncColor').value = nextColor(); $('#ncErr').textContent = '';
    const d = $('#catDialog');
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    setTimeout(() => $('#ncName').focus(), 0);
  }
  async function onAddCategory(ev) {
    ev.preventDefault();
    const name = $('#ncName').value.trim();
    if (!name) { $('#ncErr').textContent = 'Введите название.'; return; }
    if (A.cats.some((c) => c.name.toLowerCase() === name.toLowerCase())) { $('#ncErr').textContent = 'Такая категория уже есть.'; return; }
    $('#ncSave').disabled = true;
    const target = A.addTarget;
    const cat = await guard(() => api.addCategory({ name, color: $('#ncColor').value, sort: A.cats.length }));
    $('#ncSave').disabled = false;
    if (!cat) return;
    A.cats.push(cat);
    $('#catDialog').close();
    $$('select.cat-select').forEach((s) => fillCatSelect(s, s.id === target ? cat.id : s.value));
    const t = target && document.getElementById(target);
    if (t) t.dispatchEvent(new Event('change', { bubbles: true }));
    const list = $('#catList'); if (list) list.innerHTML = catManageHtml();
    toast(`Категория «${name}» добавлена`);
  }
  // "+ Добавить категорию…" in any category select
  document.addEventListener('change', (ev) => {
    const s = ev.target;
    if (!(s instanceof HTMLSelectElement) || !s.classList.contains('cat-select')) return;
    if (s.value === '__add') {
      ev.stopImmediatePropagation();
      s.value = s.dataset.prev || '';
      openCatDialog(s.id);
      return;
    }
    s.dataset.prev = s.value;
  }, true);

  function catManageHtml() {
    return A.cats.map((c) => `<div class="catrow${c.archived ? ' hidden-cat' : ''}">
      <input type="color" value="${safeColor(c.color)}" data-cat-color="${c.id}" aria-label="Цвет категории ${U.esc(c.name)}">
      <span class="nm" title="${U.esc(c.name)}">${U.esc(c.name)}</span>
      <button class="mini" data-act="cat-toggle" data-id="${c.id}">${c.archived ? 'Вернуть' : 'Скрыть'}</button>
    </div>`).join('');
  }

  /* ---------------- entries (shared by tracker and archive) ---------------- */
  function entryRow(e, now) {
    const live = !e.end;
    if (A.editingId === e.id && !live) return editRow(e);
    const endTxt = live ? 'сейчас' : U.timeStr(e.end);
    const plus = !live && U.startOfDay(e.end) !== U.startOfDay(e.start) ? '<sup>+1</sup>' : '';
    const acts = live
      ? '<span class="mini" style="cursor:default">идёт <span class="rec-dot"></span></span>'
      : A.pendingDelete === e.id
        ? `<button class="mini danger" data-act="del-yes" data-id="${e.id}">Удалить?</button><button class="mini" data-act="del-no">Отмена</button>`
        : `<button class="mini" data-act="edit" data-id="${e.id}">Изменить</button><button class="mini" data-act="del" data-id="${e.id}">Удалить</button>`;
    return `<div class="entry${live ? ' live' : ''}">
      <span class="rng">${U.timeStr(e.start)}–${endTxt}${plus}</span>
      <div class="what"><div class="cat"><span class="sw" style="background:${catColor(e.categoryId)}"></span>${U.esc(catName(e.categoryId))}</div>${e.note ? `<div class="note">${U.esc(e.note)}</div>` : ''}</div>
      <span class="dur"${live ? ' data-live-dur' : ''}>${U.hm(durOf(e, now))}</span>
      <div class="acts">${acts}</div>
    </div>`;
  }
  function editRow(e) {
    return `<form class="edit-form" data-edit-id="${e.id}">
      <label class="field f-date"><span class="label">Дата</span><input type="date" id="eDate" value="${U.dayKey(e.start)}" required></label>
      <label class="field"><span class="label">С</span><input type="time" id="eFrom" value="${U.timeStr(e.start)}" required></label>
      <label class="field"><span class="label">До</span><input type="time" id="eTo" value="${U.timeStr(e.end)}" required></label>
      <label class="field f-cat"><span class="label">Категория</span><select id="eCat" class="cat-select" data-init="${e.categoryId}"></select></label>
      <label class="field f-note"><span class="label">Комментарий</span><input type="text" id="eNote" maxlength="200" value="${U.esc(e.note)}" autocomplete="off"></label>
      <div class="row-btns"><button class="btn sm" type="submit">Сохранить</button><button class="btn ghost sm" type="button" data-act="edit-cancel">Отмена</button><span class="form-err" id="editErr"></span></div>
    </form>`;
  }
  function initEditSelect() {
    const s = $('#eCat');
    if (s) fillCatSelect(s, s.dataset.init);
  }

  function readRange(dateV, fromV, toV) {
    if (!dateV || !fromV || !toV) return { err: 'Заполните дату и время.' };
    const start = U.parseLocal(dateV, fromV);
    let end = U.parseLocal(dateV, toV);
    if (end < start) end += DAY; // 22:00–01:30 переходит через полночь
    if (end - start > 16 * 3600000) return { err: 'Отрезок длиннее 16 часов. Проверьте время.' };
    if (end > Date.now() + 60000) return { err: 'Время окончания ещё не наступило.' };
    return { start, end };
  }

  // shared click actions; each page passes its own reload function via A.reload
  root.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, id = b.dataset.id;
    if (act === 'edit') { A.editingId = id; A.pendingDelete = null; await A.reload(); initEditSelect(); }
    else if (act === 'edit-cancel') { A.editingId = null; await A.reload(); }
    else if (act === 'del') { A.pendingDelete = id; await A.reload(); }
    else if (act === 'del-no') { A.pendingDelete = null; await A.reload(); }
    else if (act === 'del-yes') {
      A.pendingDelete = null;
      const ok = await guard(async () => { await api.deleteEntry(id); return true; });
      if (ok) toast('Запись удалена');
      await A.reload();
    }
    else if (act === 'cat-toggle') {
      const c = catById(id); if (!c) return;
      if (!c.archived && activeCats().length <= 1) { toast('Нужна хотя бы одна активная категория.'); return; }
      const ok = await guard(async () => { await api.updateCategory(id, { archived: !c.archived }); return true; });
      if (ok) { c.archived = !c.archived; await A.reload(); }
    }
  });
  root.addEventListener('submit', async (ev) => {
    const f = ev.target.closest('form[data-edit-id]');
    if (!f) return;
    ev.preventDefault();
    const r = readRange($('#eDate').value, $('#eFrom').value, $('#eTo').value);
    if (r.err) { $('#editErr').textContent = r.err; return; }
    const catId = $('#eCat').value;
    if (!catById(catId)) { $('#editErr').textContent = 'Выберите категорию.'; return; }
    const entry = { id: f.dataset.editId, start: r.start, end: r.end, categoryId: catId, note: $('#eNote').value.trim() };
    const ok = await guard(async () => { await api.updateEntry(entry); return true; });
    if (ok) { A.editingId = null; toast('Сохранено'); await A.reload(); }
  });
  // category color change from the manage list
  root.addEventListener('change', async (ev) => {
    const inp = ev.target.closest('[data-cat-color]');
    if (!inp) return;
    const c = catById(inp.dataset.catColor); if (!c) return;
    const color = inp.value;
    const ok = await guard(async () => { await api.updateCategory(c.id, { color }); return true; });
    if (ok) { c.color = color; await A.reload(); }
  });

  // autosaving text field for daily reports and reviews
  function bindAutosave(textarea, stateEl, saveFn) {
    const show = (cls, text) => { stateEl.className = 'save-state ' + cls; stateEl.textContent = text; };
    let last = textarea.value;
    const doSave = async () => {
      const v = textarea.value;
      if (v === last) { A.dirty = false; return; }
      show('', 'Сохраняю…');
      try { await saveFn(v); last = v; A.dirty = textarea.value !== last; show('ok', `Сохранено в ${U.timeStr(Date.now())}`); }
      catch (e) { show('err', 'Не сохранилось. Текст остался в поле, попробуйте ещё раз.'); }
    };
    const deb = U.debounce(doSave, 1200);
    textarea.addEventListener('input', () => { A.dirty = true; show('', 'Есть несохранённые изменения'); deb(); });
    textarea.addEventListener('blur', () => deb.flush());
    A.cleanup.push(() => deb.flush());
    return { saveNow: () => { deb.flush(); return doSave(); } };
  }

  /* ---------------- page: tracker ---------------- */
  async function pageTracker() {
    const view = $('#view');
    const now0 = Date.now();
    const today = U.startOfDay(now0);
    const ws = U.mondayOf(now0);
    const [weekEntries, running, reps, banners] = await Promise.all([
      api.listEntries(ws, U.addDays(ws, 7)),
      api.getRunning(),
      api.listReports(U.dayKey(today), U.dayKey(U.addDays(today, 1))),
      reviewBanners(now0)
    ]);
    A.running = running;
    const closed = weekEntries.filter((e) => e.end);
    const report = reps[0] ? reps[0].text : '';

    const keep = {
      cat: $('#tCat') ? $('#tCat').value : '',
      note: $('#tNote') && !running ? $('#tNote').value : '',
      manualOpen: $('#manualForm') ? !$('#manualForm').hidden : false,
      m: $('#manualForm') ? { d: $('#mDate').value, f: $('#mFrom').value, t: $('#mTo').value, c: $('#mCat').value, n: $('#mNote').value } : null
    };

    const withLive = () => (A.running ? closed.concat([A.running]) : closed);
    const todayList = () => withLive().filter((e) => U.startOfDay(e.start) === today).sort((a, b) => b.start - a.start);

    view.innerHTML = `
      ${banners.map((b) => `<div class="banner"><span>${U.esc(b.text)}</span><a href="${b.href}">${b.cta}</a></div>`).join('')}
      <section class="clock${running ? ' running' : ''}" id="clock" aria-label="Таймер">
        <div class="clock-row">
          <div class="dial"><div class="t num" id="dial">0:00:00</div><div class="since" id="since"></div></div>
          <div class="fields">
            <label class="field"><span class="label">Над чем работаете</span><select id="tCat" class="cat-select"></select></label>
            <label class="field"><span class="label">Комментарий</span><input id="tNote" type="text" maxlength="200" placeholder="Необязательно: что именно делаете" autocomplete="off"></label>
          </div>
          <button class="go" id="go"><span class="ico"></span><span id="goText">${running ? 'Стоп' : 'Старт'}</span></button>
        </div>
        <div class="warn" id="longWarn" hidden></div>
        <div class="manual">
          <div><button class="link-btn" id="toggleManual" aria-expanded="false">+ Добавить время вручную</button></div>
          <form class="manual-form" id="manualForm" hidden>
            <label class="field f-date"><span class="label">Дата</span><input type="date" id="mDate" required></label>
            <label class="field"><span class="label">С</span><input type="time" id="mFrom" required></label>
            <label class="field"><span class="label">До</span><input type="time" id="mTo" required></label>
            <label class="field f-cat"><span class="label">Категория</span><select id="mCat" class="cat-select"></select></label>
            <label class="field f-note"><span class="label">Комментарий</span><input type="text" id="mNote" maxlength="200" autocomplete="off"></label>
            <button class="btn" type="submit">Добавить</button>
          </form>
          <div class="form-err" id="manualErr"></div>
        </div>
      </section>

      <div class="cols">
        <div class="stack">
          <section class="panel">
            <div class="panel-head"><h2>Сегодня, ${U.dayLong(today)}</h2><span class="num" style="font-weight:700" id="todayTotal"></span></div>
            <div class="entries" id="todayList"></div>
          </section>
          <section class="panel">
            <div class="panel-head">
              <h2><label for="dayReport">Что было сделано за рабочий день</label></h2>
              <span class="save-state" id="repState">${reps[0] ? `Сохранено в ${U.timeStr(reps[0].updatedAt)}` : ''}</span>
            </div>
            <textarea id="dayReport" class="input" placeholder="Коротко по пунктам: что сделано, что сдвинулось, что перенесено на завтра.">${U.esc(report)}</textarea>
            <div style="display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap">
              <span class="muted" style="font-size:13px">Сохраняется автоматически. Прошлые дни лежат в <a class="link-btn" href="#/archive" style="padding:0">архиве</a>.</span>
              <button class="btn ghost sm" id="repSave">Сохранить</button>
            </div>
          </section>
        </div>
        <div class="stack">
          <section class="panel">
            <div class="big">
              <div class="stat"><span class="label">Сегодня</span><span class="v" id="sToday">0:00</span><span class="s" id="sTodayDec"></span></div>
              <div class="stat"><span class="label">Эта неделя</span><span class="v" id="sWeek">0:00</span><span class="s" id="sWeekDec"></span></div>
            </div>
            <div class="bk"><span class="label">Сегодня по категориям</span><div class="bk" id="bkToday"></div></div>
            <div class="bk"><span class="label">Неделя по категориям</span><div class="bk" id="bkWeek"></div></div>
            <a class="link-btn" style="padding:0;justify-self:start" href="#/reviews?kind=week&start=${U.dayKey(ws)}">Итоги недели →</a>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Категории</h2><button class="link-btn" id="addCatBtn">+ Добавить</button></div>
            <div class="catlist" id="catList">${catManageHtml()}</div>
            <span class="muted" style="font-size:13px">Скрытая категория пропадает из выпадающих списков, но её время остаётся в итогах.</span>
          </section>
        </div>
      </div>`;

    // timer fields
    fillCatSelect($('#tCat'), running ? running.categoryId : keep.cat);
    $('#tNote').value = running ? running.note : keep.note;
    fillCatSelect($('#mCat'), keep.m ? keep.m.c : $('#tCat').value);
    if (keep.manualOpen) toggleManual(true);
    if (keep.m) { $('#mDate').value = keep.m.d; $('#mFrom').value = keep.m.f; $('#mTo').value = keep.m.t; $('#mNote').value = keep.m.n; }

    const drawToday = () => {
      const now = Date.now();
      const list = todayList();
      $('#todayList').innerHTML = list.length
        ? list.map((e) => entryRow(e, now)).join('')
        : '<div class="empty"><strong>Сегодня записей пока нет</strong>Выберите категорию и нажмите «Старт», или добавьте отрезок вручную.</div>';
      initEditSelect();
    };
    const drawStats = () => {
      const now = Date.now();
      const all = withLive();
      const tList = all.filter((e) => U.startOfDay(e.start) === today);
      const wList = all.filter((e) => e.start >= ws);
      const tSum = tList.reduce((s, e) => s + durOf(e, now), 0);
      const wSum = wList.reduce((s, e) => s + durOf(e, now), 0);
      $('#sToday').textContent = U.hm(tSum); $('#sTodayDec').textContent = `${U.dec(tSum)} ч`;
      $('#sWeek').textContent = U.hm(wSum); $('#sWeekDec').textContent = `${U.dec(wSum)} ч`;
      $('#todayTotal').textContent = tSum ? U.hm(tSum) : '';
      $('#bkToday').innerHTML = breakdownHtml(totalsByCat(tList, now), tSum, 'Появится после первой записи.');
      $('#bkWeek').innerHTML = breakdownHtml(totalsByCat(wList, now), wSum, 'На этой неделе пока пусто.');
    };
    const drawClock = () => {
      const now = Date.now();
      const r = A.running;
      $('#clock').classList.toggle('running', !!r);
      $('#goText').textContent = r ? 'Стоп' : 'Старт';
      $('#go').setAttribute('aria-label', r ? 'Остановить таймер' : 'Запустить таймер');
      if (r) {
        const ms = now - r.start;
        $('#dial').textContent = U.hms(ms);
        const other = U.startOfDay(r.start) !== U.startOfDay(now) ? `, ${U.dayShort(r.start)}` : '';
        $('#since').innerHTML = `<span class="rec-dot"></span> идёт с ${U.timeStr(r.start)}${other}`;
        const w = $('#longWarn');
        if (ms > 12 * 3600000) { w.hidden = false; w.textContent = `Таймер идёт уже ${U.hm(ms)}. Если забыли остановить, нажмите «Стоп» и поправьте время окончания в записи.`; }
        else w.hidden = true;
        $$('[data-live-dur]').forEach((el) => { el.textContent = U.hm(ms); });
      } else {
        $('#dial').textContent = '0:00:00';
        $('#since').textContent = 'Таймер остановлен';
        $('#longWarn').hidden = true;
      }
    };

    drawToday(); drawStats(); drawClock();
    A.tick = () => { drawClock(); drawStats(); };
    A.reload = async () => { teardown(); await pageTracker(); };

    // start / stop
    let busy = false;
    $('#go').addEventListener('click', async () => {
      if (busy) return; busy = true; $('#go').disabled = true;
      await queueRun(() => guard(async () => {
        if (A.running) {
          const done = { ...A.running, end: Date.now(), note: $('#tNote').value.trim(), categoryId: catById($('#tCat').value) ? $('#tCat').value : A.running.categoryId };
          await api.updateEntry(done);
          A.running = null;
          toast(`Записано ${U.hm(done.end - done.start)} · ${catName(done.categoryId)}`);
          $('#tNote').value = '';
        } else {
          const catId = $('#tCat').value;
          if (!catById(catId)) { toast('Выберите, над чем работаете.'); return; }
          const existing = await api.getRunning();
          if (existing) { toast('Таймер уже запущен на другом устройстве.'); return; }
          await api.addEntry({ categoryId: catId, note: $('#tNote').value.trim(), start: Date.now(), end: null });
        }
      }));
      busy = false;
      await A.reload();
    });
    // change category / comment of the running entry (touches only these two fields)
    const patchRunning = () => queueRun(async () => {
      if (!A.running || busy) return;
      const catId = $('#tCat').value;
      if (!catById(catId)) return;
      const patch = { categoryId: catId, note: $('#tNote').value.trim() };
      if (patch.categoryId === A.running.categoryId && patch.note === A.running.note) return;
      const ok = await guard(async () => { await api.patchEntry(A.running.id, patch); return true; });
      if (ok && A.running) { A.running = { ...A.running, ...patch }; drawToday(); drawStats(); }
    });
    $('#tCat').addEventListener('change', patchRunning);
    $('#tNote').addEventListener('change', patchRunning);
    $('#tNote').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!A.running) $('#go').click(); else $('#tNote').blur(); } });

    // manual entry
    function toggleManual(force) {
      const f = $('#manualForm');
      f.hidden = force !== undefined ? !force : !f.hidden;
      $('#toggleManual').setAttribute('aria-expanded', String(!f.hidden));
      $('#toggleManual').textContent = f.hidden ? '+ Добавить время вручную' : '− Скрыть ручной ввод';
      if (!f.hidden && !$('#mDate').value) $('#mDate').value = U.dayKey(Date.now());
    }
    $('#toggleManual').addEventListener('click', () => { toggleManual(); $('#manualErr').textContent = ''; });
    $('#manualForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const r = readRange($('#mDate').value, $('#mFrom').value, $('#mTo').value);
      $('#manualErr').textContent = r.err || '';
      if (r.err) return;
      const catId = $('#mCat').value;
      if (!catById(catId)) { $('#manualErr').textContent = 'Выберите категорию.'; return; }
      const ok = await guard(async () => { await api.addEntry({ categoryId: catId, note: $('#mNote').value.trim(), start: r.start, end: r.end }); return true; });
      if (ok) {
        toast(`Добавлено ${U.hm(r.end - r.start)} · ${catName(catId)}`);
        $('#mNote').value = ''; $('#mFrom').value = ''; $('#mTo').value = '';
        await A.reload();
      }
    });

    $('#addCatBtn').addEventListener('click', () => openCatDialog(null));

    // daily report
    const rep = bindAutosave($('#dayReport'), $('#repState'), (text) => api.saveReport(U.dayKey(today), text));
    $('#repSave').addEventListener('click', () => rep.saveNow());
  }

  async function reviewBanners(now) {
    const out = [];
    const dow = U.dowIndex(now);
    const ws = U.mondayOf(now);
    const ms = U.monthStart(now);
    const dom = new Date(now).getDate();
    const daysLeft = Math.round((U.addMonths(ms, 1) - U.startOfDay(now)) / DAY);
    const missing = async (kind, startTs) => { const r = await api.getReview(kind, U.dayKey(startTs)); return !r || !r.text.trim(); };
    const hadWork = async (from, to) => (await api.listEntries(from, to)).length > 0;

    if (dow >= 4 && await missing('week', ws)) {
      out.push({ text: `Рабочая неделя ${U.weekLabel(ws)} заканчивается. Подведите итоги недели.`, href: `#/reviews?kind=week&start=${U.dayKey(ws)}`, cta: 'Итоги недели →' });
    } else if (dow <= 1) {
      const pws = U.addDays(ws, -7);
      if (await missing('week', pws) && await hadWork(pws, ws)) {
        out.push({ text: `Итоги прошлой недели (${U.weekLabel(pws)}) не заполнены.`, href: `#/reviews?kind=week&start=${U.dayKey(pws)}`, cta: 'Заполнить →' });
      }
    }
    if (daysLeft <= 2 && await missing('month', ms)) {
      out.push({ text: `${U.monthLabel(ms)} заканчивается. Подведите итоги месяца.`, href: `#/reviews?kind=month&start=${U.dayKey(ms)}`, cta: 'Итоги месяца →' });
    } else if (dom <= 5) {
      const pms = U.addMonths(ms, -1);
      if (await missing('month', pms) && await hadWork(pms, ms)) {
        out.push({ text: `Итоги месяца за ${U.monthLabel(pms).toLowerCase()} не заполнены.`, href: `#/reviews?kind=month&start=${U.dayKey(pms)}`, cta: 'Заполнить →' });
      }
    }
    return out;
  }

  /* ---------------- page: archive ---------------- */
  async function pageArchive(q) {
    const view = $('#view');
    const now = Date.now();
    const mParam = q.get('m');
    const ms = mParam && /^\d{4}-\d{2}$/.test(mParam) ? U.parseDayKey(mParam + '-01') : U.monthStart(now);
    const me = U.addMonths(ms, 1);
    const [entries, reports] = await Promise.all([
      api.listEntries(ms, me),
      api.listReports(U.dayKey(ms), U.dayKey(me))
    ]);
    const repMap = new Map(reports.map((r) => [r.day, r]));
    const byDay = new Map();
    for (const e of entries) { const k = U.dayKey(e.start); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(e); }
    for (const r of reports) if (r.text.trim() && !byDay.has(r.day)) byDay.set(r.day, []);
    const days = [...byDay.keys()].sort().reverse();
    const monthSum = entries.reduce((s, e) => s + durOf(e, now), 0);
    const mKey = (t) => U.dayKey(t).slice(0, 7);
    const isCurrent = ms === U.monthStart(now);

    // group days into weeks
    const weeks = new Map();
    for (const k of days) { const w = U.mondayOf(U.parseDayKey(k)); if (!weeks.has(w)) weeks.set(w, []); weeks.get(w).push(k); }

    let html = `
      <div class="page-head">
        <div><h1>Архив дней</h1><span class="muted">${U.monthLabel(ms)}: ${U.hm(monthSum)} (${U.dec(monthSum)} ч), рабочих дней: ${[...byDay.values()].filter((l) => l.length).length}</span></div>
        <div class="periodnav">
          <a class="icon-btn" href="#/archive?m=${mKey(U.addMonths(ms, -1))}" aria-label="Предыдущий месяц" style="text-decoration:none;color:inherit">‹</a>
          <span class="pl">${U.monthLabel(ms)}</span>
          <a class="icon-btn" href="#/archive?m=${mKey(me)}" aria-label="Следующий месяц" style="text-decoration:none;color:inherit">›</a>
          ${isCurrent ? '' : `<a class="link-btn" href="#/archive">Текущий</a>`}
          <a class="link-btn" href="#/reviews?kind=month&start=${U.dayKey(ms)}">Итоги месяца →</a>
        </div>
      </div>`;
    if (!days.length) html += '<div class="panel"><div class="empty"><strong>В этом месяце записей нет</strong>Дни появятся здесь, как только вы запишете время или отчёт.</div></div>';

    for (const [w, keys] of weeks) {
      const wEntries = keys.flatMap((k) => byDay.get(k));
      const wSum = wEntries.reduce((s, e) => s + durOf(e, now), 0);
      html += `<div class="weekhead"><span class="label">Неделя ${U.weekLabel(w)} · ${U.hm(wSum)}</span><a class="link-btn" href="#/reviews?kind=week&start=${U.dayKey(w)}">Итоги недели →</a></div>`;
      for (const k of keys) {
        const list = byDay.get(k).slice().sort((a, b) => a.start - b.start);
        const sum = list.reduce((s, e) => s + durOf(e, now), 0);
        const totals = totalsByCat(list, now);
        const chips = orderedIds(totals, false).map((id) => `<span class="chip"><span class="sw" style="background:${catColor(id)}"></span>${U.esc(catName(id))} <b>${U.hm(totals.get(id))}</b></span>`).join('');
        const rep = repMap.get(k);
        const ts = U.parseDayKey(k);
        const open = A.openDays.has(k) || list.some((e) => e.id === A.editingId || e.id === A.pendingDelete);
        html += `<details class="daycard" data-day="${k}"${open ? ' open' : ''}>
          <summary>
            <div class="dh"><span class="d"><span class="caret">›</span>${U.relDayName(ts, now)}, ${U.dayLong(ts)}</span><span class="t">${U.hm(sum)}</span></div>
            ${chips ? `<div class="chips">${chips}</div>` : ''}
            ${rep && rep.text.trim() ? `<div class="report-text">${U.esc(rep.text)}</div>` : '<div class="muted" style="font-size:14px">Отчёт за день не заполнен</div>'}
          </summary>
          <div class="body">
            <div class="entries">${list.map((e) => entryRow(e, now)).join('') || '<span class="muted">Записей времени нет.</span>'}</div>
            <div class="field">
              <span class="label">Что было сделано за рабочий день</span>
              <textarea class="input arch-report" data-day="${k}">${U.esc(rep ? rep.text : '')}</textarea>
              <span class="save-state" data-state-for="${k}"></span>
            </div>
          </div>
        </details>`;
      }
    }
    view.innerHTML = html;
    initEditSelect();
    A.reload = async () => { teardown(); await pageArchive(q); };

    $$('.daycard').forEach((d) => d.addEventListener('toggle', () => { if (d.open) A.openDays.add(d.dataset.day); else A.openDays.delete(d.dataset.day); }));
    $$('.arch-report').forEach((t) => {
      const day = t.dataset.day;
      bindAutosave(t, $(`[data-state-for="${day}"]`), (text) => api.saveReport(day, text));
    });
  }

  /* ---------------- page: weekly / monthly reviews ---------------- */
  function periodFrom(q, defKind) {
    const now = Date.now();
    const kind = ['week', 'month', 'year', 'all'].includes(q.get('kind') || q.get('p')) ? (q.get('kind') || q.get('p')) : defKind;
    const s = q.get('start');
    const base = s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? U.parseDayKey(s) : now;
    if (kind === 'week') { const a = U.mondayOf(base); return { kind, from: a, to: U.addDays(a, 7), label: U.weekLabel(a) }; }
    if (kind === 'month') { const a = U.monthStart(base); return { kind, from: a, to: U.addMonths(a, 1), label: U.monthLabel(a) }; }
    if (kind === 'year') { const y = new Date(base).getFullYear(); return { kind, from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime(), label: `${y} год` }; }
    return { kind: 'all', from: new Date(2000, 0, 1).getTime(), to: U.addDays(U.startOfDay(now), 1), label: 'Всё время' };
  }
  function shiftPeriod(p, dir) {
    if (p.kind === 'week') return U.addDays(p.from, 7 * dir);
    if (p.kind === 'month') return U.addMonths(p.from, dir);
    if (p.kind === 'year') return new Date(new Date(p.from).getFullYear() + dir, 0, 1).getTime();
    return p.from;
  }

  async function pageReviews(q) {
    const view = $('#view');
    const now = Date.now();
    const p = periodFrom(q, 'week');
    if (p.kind !== 'week' && p.kind !== 'month') { location.hash = '#/reviews?kind=week'; return; }
    const startKey = U.dayKey(p.from);
    const [entries, reports, review] = await Promise.all([
      api.listEntries(p.from, p.to),
      api.listReports(startKey, U.dayKey(p.to)),
      api.getReview(p.kind, startKey)
    ]);

    // columns: days of the week, or Monday-based weeks of the month
    const cols = p.kind === 'week'
      ? Array.from({ length: 7 }, (_, i) => { const d = U.addDays(p.from, i); return { from: d, to: U.addDays(d, 1), head: U.DOW[i], sub: String(new Date(d).getDate()) }; })
      : U.monthWeeks(p.from).map((w, i) => ({ ...w, head: `Нед. ${i + 1}`, sub: `${new Date(w.from).getDate()}–${new Date(U.addDays(w.to, -1)).getDate()}` }));
    const totals = totalsByCat(entries, now);
    const sum = entries.reduce((s, e) => s + durOf(e, now), 0);
    const ids = orderedIds(totals, true);
    const cell = (catId, c) => entries.filter((e) => (e.categoryId || '') === catId && e.start >= c.from && e.start < c.to).reduce((s, e) => s + durOf(e, now), 0);
    const colSum = (c) => entries.filter((e) => e.start >= c.from && e.start < c.to).reduce((s, e) => s + durOf(e, now), 0);
    const workDays = new Set(entries.map((e) => U.dayKey(e.start))).size;
    const usedCats = orderedIds(totals, false).length;
    const top = orderedIds(totals, false).sort((a, b) => totals.get(b) - totals.get(a))[0];

    const tableRows = ids.map((id) => {
      const t = totals.get(id) || 0;
      return `<tr>
        <td><span class="catcell"><span class="sw" style="background:${catColor(id)}"></span>${U.esc(catName(id))}</span></td>
        ${cols.map((c) => { const v = cell(id, c); return `<td class="${v ? '' : 'zero'}">${v ? U.hm(v) : '—'}</td>`; }).join('')}
        <td class="tot${t ? '' : ' zero'}">${t ? U.hm(t) : '—'}</td>
        <td class="${t ? '' : 'zero'}">${U.dec(t)}</td>
        <td class="${t ? '' : 'zero'}">${sum ? Math.round(t / sum * 100) : 0}%</td>
      </tr>`;
    }).join('');

    const kindWord = p.kind === 'week' ? 'недели' : 'месяца';
    const reportItems = reports.filter((r) => r.text.trim());
    view.innerHTML = `
      <div class="page-head">
        <div style="display:grid;gap:8px">
          <h1>Итоги ${kindWord}</h1>
          <div class="seg" role="tablist">
            <button class="${p.kind === 'week' ? 'on' : ''}" data-kind="week">Неделя</button>
            <button class="${p.kind === 'month' ? 'on' : ''}" data-kind="month">Месяц</button>
          </div>
        </div>
        <div class="periodnav">
          <button class="icon-btn" id="prevP" aria-label="Назад">‹</button>
          <span class="pl">${p.label}</span>
          <button class="icon-btn" id="nextP" aria-label="Вперёд">›</button>
        </div>
      </div>

      <div class="stats4">
        <div class="stat"><span class="label">Всего</span><span class="v">${U.hm(sum)}</span><span class="s">${U.dec(sum)} ч</span></div>
        <div class="stat"><span class="label">Рабочих дней</span><span class="v">${workDays}</span><span class="s">с записями времени</span></div>
        <div class="stat"><span class="label">В среднем за день</span><span class="v">${U.hm(workDays ? sum / workDays : 0)}</span><span class="s">${U.dec(workDays ? sum / workDays : 0)} ч</span></div>
        <div class="stat"><span class="label">Больше всего</span><span class="v" style="font-size:16px;font-family:var(--body);line-height:1.3">${top !== undefined ? U.esc(catName(top)) : '—'}</span><span class="s">${top !== undefined ? `${U.hm(totals.get(top))} · ${Math.round(totals.get(top) / sum * 100)}%` : `категорий: ${usedCats}`}</span></div>
      </div>

      <section class="panel">
        <div class="panel-head"><h2>Время по категориям</h2><button class="link-btn" id="csvBtn">Скачать CSV</button></div>
        <div class="table-wrap">
          <table class="sheet">
            <thead><tr><th>Категория</th>${cols.map((c) => `<th>${c.head}<small>${c.sub}</small></th>`).join('')}<th>Итого</th><th>Часы</th><th>Доля</th></tr></thead>
            <tbody>${tableRows}</tbody>
            <tfoot><tr><td>Всего</td>${cols.map((c) => { const v = colSum(c); return `<td>${v ? U.hm(v) : '—'}</td>`; }).join('')}<td>${U.hm(sum)}</td><td>${U.dec(sum)}</td><td>${sum ? '100%' : '—'}</td></tr></tfoot>
          </table>
        </div>
      </section>

      <div class="cols">
        <section class="panel">
          <div class="panel-head">
            <h2><label for="reviewText">${p.kind === 'week' ? 'Ревью недели' : 'Ревью месяца'}: что было сделано</label></h2>
            <span class="save-state" id="revState">${review && review.updatedAt ? `Сохранено ${U.dayShort(review.updatedAt)} в ${U.timeStr(review.updatedAt)}` : ''}</span>
          </div>
          <textarea id="reviewText" class="input" style="min-height:220px" placeholder="Главные результаты ${kindWord}. Что получилось, что нет и почему. Куда ушло больше всего времени и оправдано ли это. Что меняем в следующем периоде.">${U.esc(review ? review.text : '')}</textarea>
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
            <span class="muted" style="font-size:13px">Сохраняется автоматически. Отчёты по дням справа помогают ничего не забыть.</span>
            <button class="btn ghost sm" id="revSave">Сохранить</button>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Отчёты по дням</h2><span class="label">${reportItems.length} дн.</span></div>
          <div class="reports">${reportItems.length ? reportItems.map((r) => {
            const ts = U.parseDayKey(r.day);
            const dSum = entries.filter((e) => U.dayKey(e.start) === r.day).reduce((s, e) => s + durOf(e, now), 0);
            return `<div class="report-item"><div class="d">${U.DOW[U.dowIndex(ts)]}, ${U.dayShort(ts)}<small>${U.hm(dSum)}</small></div><div class="report-text">${U.esc(r.text)}</div></div>`;
          }).join('') : '<span class="muted" style="font-size:14px">За этот период отчётов за день нет.</span>'}</div>
        </section>
      </div>`;

    A.reload = async () => { teardown(); await pageReviews(q); };
    $$('.seg button').forEach((b) => b.addEventListener('click', () => { location.hash = `#/reviews?kind=${b.dataset.kind}&start=${U.dayKey(p.from)}`; }));
    $('#prevP').addEventListener('click', () => { location.hash = `#/reviews?kind=${p.kind}&start=${U.dayKey(shiftPeriod(p, -1))}`; });
    $('#nextP').addEventListener('click', () => { location.hash = `#/reviews?kind=${p.kind}&start=${U.dayKey(shiftPeriod(p, 1))}`; });
    const rv = bindAutosave($('#reviewText'), $('#revState'), (text) => api.saveReview(p.kind, startKey, text));
    $('#revSave').addEventListener('click', () => rv.saveNow());
    $('#csvBtn').addEventListener('click', () => {
      const rows = [['Категория', ...cols.map((c) => `${c.head} ${c.sub}`), 'Итого (ч:мм)', 'Часы', 'Доля, %']];
      for (const id of ids) {
        const t = totals.get(id) || 0;
        rows.push([catName(id), ...cols.map((c) => U.dec(cell(id, c))), U.hm(t), U.dec(t), sum ? Math.round(t / sum * 100) : 0]);
      }
      rows.push(['Всего', ...cols.map((c) => U.dec(colSum(c))), U.hm(sum), U.dec(sum), sum ? 100 : 0]);
      U.downloadText(`itogi-${p.kind === 'week' ? 'nedeli' : 'mesyaca'}-${startKey}.csv`, U.csv(rows));
    });
  }

  /* ---------------- page: results (charts) ---------------- */
  async function pageResults(q) {
    const view = $('#view');
    const now = Date.now();
    const p = periodFrom(q, 'month');
    const entries = await api.listEntries(p.from, p.to);
    const totals = totalsByCat(entries, now);
    const sum = entries.reduce((s, e) => s + durOf(e, now), 0);
    const ids = orderedIds(totals, false).sort((a, b) => totals.get(b) - totals.get(a));

    // buckets for the stacked chart: days for week/month, months for year/all
    let buckets = [];
    if (p.kind === 'week' || p.kind === 'month') {
      for (let d = p.from; d < p.to; d = U.addDays(d, 1)) buckets.push({ from: d, to: U.addDays(d, 1), label: p.kind === 'week' ? `${U.DOW[U.dowIndex(d)]} ${new Date(d).getDate()}` : String(new Date(d).getDate()) });
    } else {
      let a = p.kind === 'all' && entries.length ? U.monthStart(entries[0].start) : p.from;
      const end = p.kind === 'all' ? U.addMonths(U.monthStart(now), 1) : p.to;
      for (; a < end; a = U.addMonths(a, 1)) buckets.push({ from: a, to: U.addMonths(a, 1), label: `${U.MON_SHORT[new Date(a).getMonth()]} ${String(new Date(a).getFullYear()).slice(2)}` });
    }

    const tabs = [['week', 'Неделя'], ['month', 'Месяц'], ['year', 'Год'], ['all', 'Всё время']];
    view.innerHTML = `
      <div class="page-head">
        <div style="display:grid;gap:8px">
          <h1>Результаты</h1>
          <div class="seg">${tabs.map(([k, l]) => `<button class="${p.kind === k ? 'on' : ''}" data-p="${k}">${l}</button>`).join('')}</div>
        </div>
        <div class="periodnav"${p.kind === 'all' ? ' hidden' : ''}>
          <button class="icon-btn" id="prevP" aria-label="Назад">‹</button>
          <span class="pl">${p.label}</span>
          <button class="icon-btn" id="nextP" aria-label="Вперёд">›</button>
        </div>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>Распределение времени по категориям · ${p.label}</h2><span class="num" style="font-weight:700">${U.hm(sum)} · ${U.dec(sum)} ч</span></div>
        ${sum ? `<div class="charts">
          <div class="donut-box"><canvas id="donut" aria-label="Кольцевая диаграмма времени по категориям" role="img"></canvas>
            <div class="donut-center"><span class="label">всего</span><span class="v">${U.hm(sum)}</span></div></div>
          <div class="table-wrap"><table class="sheet" style="min-width:0">
            <thead><tr><th>Категория</th><th>Ч:ММ</th><th>Часы</th><th>Доля</th></tr></thead>
            <tbody>${ids.map((id) => `<tr><td><span class="catcell"><span class="sw" style="background:${catColor(id)}"></span>${U.esc(catName(id))}</span></td><td>${U.hm(totals.get(id))}</td><td>${U.dec(totals.get(id))}</td><td>${(totals.get(id) / sum * 100).toFixed(1)}%</td></tr>`).join('')}</tbody>
            <tfoot><tr><td>Всего</td><td>${U.hm(sum)}</td><td>${U.dec(sum)}</td><td>100%</td></tr></tfoot>
          </table></div>
        </div>` : '<div class="empty"><strong>За этот период времени нет</strong>Выберите другой период или запишите время на странице «Трекер».</div>'}
      </section>
      ${sum ? `<section class="panel">
        <div class="panel-head"><h2>${p.kind === 'week' || p.kind === 'month' ? 'Часы по дням' : 'Часы по месяцам'}</h2></div>
        <div class="bar-box"><canvas id="bars" aria-label="Столбчатая диаграмма часов по категориям" role="img"></canvas></div>
      </section>` : ''}`;

    A.reload = async () => { teardown(); await pageResults(q); };
    $$('.seg button').forEach((b) => b.addEventListener('click', () => { location.hash = `#/results?p=${b.dataset.p}&start=${U.dayKey(p.kind === 'all' ? now : p.from)}`; }));
    if ($('#prevP')) {
      $('#prevP').addEventListener('click', () => { location.hash = `#/results?p=${p.kind}&start=${U.dayKey(shiftPeriod(p, -1))}`; });
      $('#nextP').addEventListener('click', () => { location.hash = `#/results?p=${p.kind}&start=${U.dayKey(shiftPeriod(p, 1))}`; });
    }
    if (!sum) return;
    if (!window.Chart) { toast('Не загрузилась библиотека диаграмм. Таблица показана без графиков.'); return; }

    const ink = U.cssVar('--ink'), muted = U.cssVar('--muted'), line = U.cssVar('--line'), surface = U.cssVar('--surface');
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = muted;

    const donut = new Chart($('#donut'), {
      type: 'doughnut',
      data: {
        labels: ids.map(catName),
        datasets: [{ data: ids.map((id) => +(totals.get(id) / 3600000).toFixed(2)), backgroundColor: ids.map(catColor), borderColor: surface, borderWidth: 2 }]
      },
      options: {
        cutout: '62%', maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => ` ${c.label}: ${U.hm(c.raw * 3600000)} (${(c.raw * 3600000 / sum * 100).toFixed(1)}%)` } }
        }
      }
    });
    const bars = new Chart($('#bars'), {
      type: 'bar',
      data: {
        labels: buckets.map((b) => b.label),
        datasets: ids.map((id) => ({
          label: catName(id),
          backgroundColor: catColor(id),
          borderRadius: 3,
          data: buckets.map((b) => +(entries.filter((e) => (e.categoryId || '') === id && e.start >= b.from && e.start < b.to).reduce((s, e) => s + durOf(e, now), 0) / 3600000).toFixed(2))
        }))
      },
      options: {
        maintainAspectRatio: false,
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: muted } },
          y: { stacked: true, beginAtZero: true, grid: { color: line }, ticks: { color: muted }, title: { display: true, text: 'часы', color: muted } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { color: ink, boxWidth: 12, boxHeight: 12, usePointStyle: true, pointStyle: 'rectRounded' } },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${U.hm(c.raw * 3600000)}` } }
        }
      }
    });
    A.cleanup.push(() => { donut.destroy(); bars.destroy(); });
  }

  boot();
})();
