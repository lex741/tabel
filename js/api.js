// Слой данных. Два варианта с одинаковым интерфейсом:
//  - CloudApi: Supabase (Postgres + Auth), общий аккаунт на всех устройствах;
//  - LocalApi: localStorage, если Supabase не настроен (для проверки и разработки).
window.DEFAULT_CATEGORIES = [
  { name: 'Работа над таргетом', color: '#3B6FE0' },
  { name: 'Создание контент-плана', color: '#8B4FD0' },
  { name: 'Постинг контента', color: '#E0702E' },
  { name: 'Созвоны', color: '#1F9D7A' },
  { name: 'Обучение', color: '#D4A21C' },
  { name: 'Мелкие оперативные задания', color: '#C9476A' }
];
// Цвета для категорий, которые пользователь добавляет сам
window.EXTRA_COLORS = ['#2C9DB8', '#7A8B2E', '#A0522D', '#5560C9', '#B03FA0', '#4F7A99', '#D2691E', '#3E8E41'];

window.createApi = (cfg) => {
  const hasCloud = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  return hasCloud ? new CloudApi(cfg) : new LocalApi(cfg);
};

function loginToEmail(login, domain) {
  const l = String(login || '').trim().toLowerCase();
  return l.includes('@') ? l : `${l}@${domain}`;
}

/* ===================== Supabase ===================== */
class CloudApi {
  constructor(cfg) {
    this.mode = 'cloud';
    this.cfg = cfg;
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error('Не загрузилась библиотека Supabase. Проверьте подключение к интернету.');
    }
    this.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    this.userId = null;
  }

  async init() {
    const { data } = await this.sb.auth.getSession();
    const s = data && data.session;
    this.userId = s ? s.user.id : null;
    return s ? { login: (s.user.email || '').split('@')[0] } : null;
  }

  async signIn(login, password) {
    const email = loginToEmail(login, this.cfg.LOGIN_EMAIL_DOMAIN || 'tabel.app');
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) {
      const code = error.code || '';
      const raw = error.message || '';
      let msg;
      if (code === 'invalid_credentials' || /Invalid login credentials/i.test(raw)) {
        msg = `Supabase не нашёл пользователя ${email} с таким паролем. Проверьте email и пароль в Authentication → Users.`;
      } else if (code === 'email_not_confirmed' || /not confirmed/i.test(raw)) {
        msg = `Email ${email} не подтверждён. Создайте пользователя заново с галочкой Auto Confirm User.`;
      } else if (/api key|apikey|No API key/i.test(raw) || error.status === 401) {
        msg = 'Supabase отклонил ключ. Проверьте SUPABASE_ANON_KEY в js/config.js: нужен anon public key этого же проекта.';
      } else if (/fetch|network/i.test(raw) || error.status === 0) {
        msg = 'Не удалось достучаться до Supabase. Проверьте SUPABASE_URL в js/config.js и что проект не на паузе.';
      } else {
        msg = `Не удалось войти: ${raw}`;
      }
      throw new Error(msg);
    }
    this.userId = data.user.id;
    return { login: (data.user.email || '').split('@')[0] };
  }

  async signOut() { await this.sb.auth.signOut(); this.userId = null; }

  check(res) {
    if (res.error) {
      if (res.error.code === 'PGRST301' || /JWT/i.test(res.error.message)) throw new Error('Сессия истекла. Войдите заново.');
      throw new Error(res.error.message);
    }
    return res.data;
  }

  // categories
  static cat(r) { return { id: r.id, name: r.name, color: r.color, sort: r.sort, archived: r.archived }; }
  async listCategories() {
    const d = this.check(await this.sb.from('categories').select('*').order('sort').order('created_at'));
    return d.map(CloudApi.cat);
  }
  async addCategory({ name, color, sort }) {
    const d = this.check(await this.sb.from('categories').insert({ user_id: this.userId, name, color, sort: sort || 0 }).select().single());
    return CloudApi.cat(d);
  }
  async updateCategory(id, patch) {
    this.check(await this.sb.from('categories').update(patch).eq('id', id));
  }

  // entries
  static entry(r) {
    return { id: r.id, categoryId: r.category_id || '', note: r.note || '', start: Date.parse(r.started_at), end: r.ended_at ? Date.parse(r.ended_at) : null };
  }
  static row(e) {
    return {
      category_id: e.categoryId || null, note: e.note || '',
      started_at: new Date(e.start).toISOString(), ended_at: e.end ? new Date(e.end).toISOString() : null
    };
  }
  async listEntries(from, to) {
    const out = [];
    const page = 1000;
    for (let i = 0; ; i += page) {
      const d = this.check(await this.sb.from('entries').select('*')
          .gte('started_at', new Date(from).toISOString()).lt('started_at', new Date(to).toISOString())
          .order('started_at').range(i, i + page - 1));
      out.push(...d.map(CloudApi.entry));
      if (d.length < page) break;
    }
    return out;
  }
  async getRunning() {
    const d = this.check(await this.sb.from('entries').select('*').is('ended_at', null).order('started_at', { ascending: false }).limit(1));
    return d.length ? CloudApi.entry(d[0]) : null;
  }
  async addEntry(e) {
    const d = this.check(await this.sb.from('entries').insert({ user_id: this.userId, ...CloudApi.row(e) }).select().single());
    return CloudApi.entry(d);
  }
  async updateEntry(e) { this.check(await this.sb.from('entries').update(CloudApi.row(e)).eq('id', e.id)); }
  async patchEntry(id, { categoryId, note }) {
    this.check(await this.sb.from('entries').update({ category_id: categoryId || null, note: note || '' }).eq('id', id));
  }
  async deleteEntry(id) { this.check(await this.sb.from('entries').delete().eq('id', id)); }

  // daily reports
  async listReports(fromKey, toKeyExcl) {
    const d = this.check(await this.sb.from('day_reports').select('*').gte('day', fromKey).lt('day', toKeyExcl).order('day'));
    return d.map((r) => ({ day: r.day, text: r.body || '', updatedAt: Date.parse(r.updated_at) }));
  }
  async saveReport(day, text) {
    this.check(await this.sb.from('day_reports').upsert(
        { user_id: this.userId, day, body: text, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,day' }
    ));
  }

  // weekly / monthly reviews
  async getReview(kind, periodStart) {
    const d = this.check(await this.sb.from('reviews').select('*').eq('kind', kind).eq('period_start', periodStart).maybeSingle());
    return d ? { text: d.body || '', updatedAt: Date.parse(d.updated_at) } : null;
  }
  async saveReview(kind, periodStart, text) {
    this.check(await this.sb.from('reviews').upsert(
        { user_id: this.userId, kind, period_start: periodStart, body: text, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,kind,period_start' }
    ));
  }
}

/* ===================== localStorage ===================== */
class LocalApi {
  constructor(cfg) {
    this.mode = 'local';
    this.cfg = cfg;
    this.KEY = 'tabel.local.v2';
    this.SKEY = 'tabel.local.session';
  }
  load() {
    try {
      const d = JSON.parse(localStorage.getItem(this.KEY) || 'null');
      if (d) return { categories: d.categories || [], entries: d.entries || [], reports: d.reports || {}, reviews: d.reviews || {} };
    } catch (e) { /* ignore */ }
    return { categories: [], entries: [], reports: {}, reviews: {} };
  }
  save(d) {
    try { localStorage.setItem(this.KEY, JSON.stringify(d)); }
    catch (e) { throw new Error('Браузер не дал сохранить данные (память переполнена или запрещена).'); }
  }
  async init() {
    try { return localStorage.getItem(this.SKEY) ? { login: localStorage.getItem(this.SKEY) } : null; } catch (e) { return null; }
  }
  async signIn(login, password) {
    if (String(login).trim() !== this.cfg.LOCAL_LOGIN || password !== this.cfg.LOCAL_PASSWORD) throw new Error('Неверный логин или пароль.');
    try { localStorage.setItem(this.SKEY, login.trim()); } catch (e) { /* ignore */ }
    return { login: login.trim() };
  }
  async signOut() { try { localStorage.removeItem(this.SKEY); } catch (e) { /* ignore */ } }

  async listCategories() { return this.load().categories.slice().sort((a, b) => a.sort - b.sort); }
  async addCategory({ name, color, sort }) {
    const d = this.load();
    const c = { id: U.uid(), name, color, sort: sort || 0, archived: false };
    d.categories.push(c); this.save(d); return c;
  }
  async updateCategory(id, patch) {
    const d = this.load();
    const c = d.categories.find((x) => x.id === id);
    if (c) Object.assign(c, patch);
    this.save(d);
  }
  async listEntries(from, to) {
    return this.load().entries.filter((e) => e.start >= from && e.start < to).sort((a, b) => a.start - b.start);
  }
  async getRunning() { return this.load().entries.find((e) => !e.end) || null; }
  async addEntry(e) {
    const d = this.load();
    if (!e.end && d.entries.some((x) => !x.end)) throw new Error('Таймер уже запущен.');
    const n = { ...e, id: U.uid() };
    d.entries.push(n); this.save(d); return n;
  }
  async updateEntry(e) {
    const d = this.load();
    const i = d.entries.findIndex((x) => x.id === e.id);
    if (i >= 0) d.entries[i] = { ...e };
    this.save(d);
  }
  async patchEntry(id, patch) {
    const d = this.load();
    const e = d.entries.find((x) => x.id === id);
    if (e) Object.assign(e, patch);
    this.save(d);
  }
  async deleteEntry(id) { const d = this.load(); d.entries = d.entries.filter((x) => x.id !== id); this.save(d); }
  async listReports(fromKey, toKeyExcl) {
    const d = this.load();
    return Object.keys(d.reports).filter((k) => k >= fromKey && k < toKeyExcl).sort()
        .map((k) => ({ day: k, text: d.reports[k].text, updatedAt: d.reports[k].updatedAt }));
  }
  async saveReport(day, text) { const d = this.load(); d.reports[day] = { text, updatedAt: Date.now() }; this.save(d); }
  async getReview(kind, periodStart) { return this.load().reviews[`${kind}:${periodStart}`] || null; }
  async saveReview(kind, periodStart, text) {
    const d = this.load(); d.reviews[`${kind}:${periodStart}`] = { text, updatedAt: Date.now() }; this.save(d);
  }
}
