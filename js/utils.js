// Общие функции: даты, форматирование, CSV.
window.U = (() => {
  const DAY = 86400000;
  const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const DOW_LONG = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
  const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const MON_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MON_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  };

  // durations
  const hm = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return `${Math.floor(m / 60)}:${pad(m % 60)}`; };
  const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
  const dec = (ms) => (ms / 3600000).toFixed(2);

  // dates (local time)
  const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addDays = (ts, n) => { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); };
  const mondayOf = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const monthStart = (ts) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
  const addMonths = (ts, n) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); };
  const dowIndex = (ts) => (new Date(ts).getDay() + 6) % 7;
  const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const parseDayKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const timeStr = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const parseLocal = (dateStr, timeStrV) => {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const [h, mi] = timeStrV.split(':').map(Number);
    return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  };
  const dayLong = (ts) => { const d = new Date(ts); return `${d.getDate()} ${MON_GEN[d.getMonth()]}`; };
  const dayShort = (ts) => { const d = new Date(ts); return `${d.getDate()} ${MON_SHORT[d.getMonth()]}`; };
  const weekLabel = (ws) => {
    const a = new Date(ws), b = new Date(addDays(ws, 6));
    const left = a.getMonth() === b.getMonth() ? `${a.getDate()}` : `${a.getDate()} ${MON_SHORT[a.getMonth()]}`;
    return `${left}–${b.getDate()} ${MON_SHORT[b.getMonth()]} ${b.getFullYear()}`;
  };
  const monthLabel = (ms) => { const d = new Date(ms); return `${MON_NOM[d.getMonth()]} ${d.getFullYear()}`; };
  const relDayName = (ts, now = Date.now()) => {
    const t = startOfDay(now), d = startOfDay(ts);
    if (d === t) return 'Сегодня';
    if (d === addDays(t, -1)) return 'Вчера';
    return DOW_LONG[dowIndex(ts)];
  };

  // weeks of a month as Monday-based segments clipped to the month
  const monthWeeks = (ms) => {
    const end = addMonths(ms, 1);
    const out = [];
    let a = ms;
    while (a < end) {
      const b = Math.min(addDays(mondayOf(a), 7), end);
      out.push({ from: a, to: b });
      a = b;
    }
    return out;
  };

  const debounce = (fn, wait) => {
    let t = null;
    const d = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, wait); };
    d.flush = (...args) => { if (t) { clearTimeout(t); t = null; fn(...args); } };
    d.pending = () => t !== null;
    return d;
  };

  const csv = (rows) => '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const downloadText = (filename, text, mime = 'text/csv;charset=utf-8') => {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  return {
    DAY, DOW, DOW_LONG, MON_SHORT, MON_GEN, MON_NOM,
    pad, esc, uid, hm, hms, dec,
    startOfDay, addDays, mondayOf, monthStart, addMonths, dowIndex, dayKey, parseDayKey, timeStr, parseLocal,
    dayLong, dayShort, weekLabel, monthLabel, relDayName, monthWeeks,
    debounce, csv, downloadText, cssVar
  };
})();
