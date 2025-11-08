// script.js — all-in-one wiring for your current index.html

(function () {
  // ---------- Helpers ----------
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const LS = {
    DATA: 'glossary-data',
    THEME: 'glossary-theme',
    FB_CFG: 'fb-config',
    FB_PATH: 'fb-path'
  };

  const state = {
    data: [],
    fb: { docRef: null, autosync: false }
  };

  const norm = (s) =>
    (s || '')
      .toString()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '');

  const unique = (arr) => Array.from(new Set(arr));

  function toast(m) { console.log(m); }

  // ---------- Persistence (local) ----------
  function loadLocal() {
    try {
      const saved = localStorage.getItem(LS.DATA);
      if (saved) state.data = JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse localStorage data', e);
    }
  }
  function saveLocal() {
    try {
      localStorage.setItem(LS.DATA, JSON.stringify(state.data));
    } catch {}
  }

  // ---------- CSV ----------
  function toCSV(rows) {
    const header = ['term', 'full_form', 'definition', 'context', 'tags'];
    const esc = (s) => {
      s = (s ?? '').toString();
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    rows.forEach((r) => {
      const tags = Array.isArray(r.tags) ? r.tags.join(',') : (r.tags || '');
      lines.push(
        [r.term, r.full_form, r.definition, r.context, tags].map(esc).join(',')
      );
    });
    return lines.join('\n');
  }

  // Quote-safe CSV → objects
  function parseCSV(text) {
    const lines = text.split(/\r?\n/);
    // drop empty trailing lines
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) return [];

    const headerLine = lines.shift();
    const headers = headerLine
      .split(',')
      .map((h) => h.trim().toLowerCase());

    const col = (name) => headers.indexOf(name);
    const iTerm = col('term');
    const iFull = col('full_form');
    const iDef = col('definition');
    const iCtx = col('context');
    const iTags = col('tags');

    if (iTerm < 0 || iDef < 0) {
      throw new Error('CSV must include headers: term,definition[,full_form,context,tags]');
    }

    const parseLine = (line) => {
      const out = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (inQ && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQ = !inQ;
          }
        } else if (c === ',' && !inQ) {
          out.push(cur);
          cur = '';
        } else {
          cur += c;
        }
      }
      out.push(cur);
      return out;
    };

    return lines
      .map((ln) => {
        if (!ln.trim()) return null;
        const parts = parseLine(ln);
        const term = (parts[iTerm] || '').trim();
        const definition = (parts[iDef] || '').trim();
        if (!term || !definition) return null;
        const full_form = (parts[iFull] || '').trim();
        const context = (parts[iCtx] || '').trim();
        const tags = (parts[iTags] || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        return { term, full_form, definition, context, tags };
      })
      .filter(Boolean);
  }

  function download(filename, text, mime = 'text/plain') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- Firebase (compat) ----------
  async function ensureFirebaseCompat() {
    if (window.firebase?.firestore) return;
    await new Promise((res, rej) => {
      const s1 = document.createElement('script');
      s1.src = 'https://www.gstatic.com/firebasejs/10.13.1/firebase-app-compat.js';
      s1.onload = () => {
        const s2 = document.createElement('script');
        s2.src = 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore-compat.js';
        s2.onload = res;
        s2.onerror = rej;
        document.head.appendChild(s2);
      };
      s1.onerror = rej;
      document.head.appendChild(s1);
    });
  }

  async function fbConnect(cfg, path) {
    await ensureFirebaseCompat();
    const app = firebase.apps?.length ? firebase.app() : firebase.initializeApp(cfg);
    const db = firebase.firestore(app);
    const [col, doc] = path.split('/');
    state.fb.docRef = db.collection(col).doc(doc);
    localStorage.setItem(LS.FB_CFG, JSON.stringify(cfg));
    localStorage.setItem(LS.FB_PATH, path);
    toast('Connected to Firebase');
  }

  async function fbPull() {
    if (!state.fb.docRef) return alert('Connect first');
    const snap = await state.fb.docRef.get();
    const data = snap.data() || {};
    const items = Array.isArray(data.items) ? data.items : [];
    state.data = items;
    saveLocal();
    render();
    toast('Pulled from cloud');
  }

  async function fbPush() {
    if (!state.fb.docRef) return alert('Connect first');
    await state.fb.docRef.set(
      { items: state.data, updatedAt: new Date().toISOString() },
      { merge: true }
    );
    toast('Pushed to cloud');
  }

  // ---------- UI: Render & Filters ----------
  function currentQuery() {
    return ($('#search')?.value || '').trim();
  }
  function currentTag() {
    return $('#tagFilter')?.value || '';
  }

  function getAllTags(data) {
    return unique(
      data.flatMap((it) => (Array.isArray(it.tags) ? it.tags : (it.tags ? [it.tags] : [])))
    ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  function populateTagFilter() {
    const sel = $('#tagFilter');
    if (!sel) return;
    const prev = sel.value;
    const tags = getAllTags(state.data);
    sel.innerHTML = '<option value="">All tags</option>' + tags.map(t => `<option value="${t}">${t}</option>`).join('');
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  }

  function applyFilters(rows) {
    const q = norm(currentQuery());
    const tag = currentTag();
    return rows.filter((it) => {
      const hay = (
        (it.term || '') + ' ' +
        (it.full_form || '') + ' ' +
        (it.definition || '') + ' ' +
        (it.context || '') + ' ' +
        (Array.isArray(it.tags) ? it.tags.join(',') : (it.tags || ''))
      );
      const textHit = !q || norm(hay).includes(q);
      const tagHit = !tag || (Array.isArray(it.tags) ? it.tags.includes(tag) : it.tags === tag);
      return textHit && tagHit;
    });
  }

  function sortData(rows) {
    return rows.sort((a, b) =>
      (a.term || '').localeCompare(b.term || '', undefined, { sensitivity: 'base' })
    );
  }

  function render() {
    populateTagFilter();

    const tbody = $('#tbody');
    if (!tbody) return;

    const filtered = sortData(applyFilters([...state.data]));
    $('#stats').textContent = `${filtered.length} of ${state.data.length} items`;

    tbody.innerHTML = filtered
      .map((it, idx) => {
        const tagBadges = (Array.isArray(it.tags) ? it.tags : (it.tags ? [it.tags] : []))
          .map((t) => `<span class="badge">${t}</span>`)
          .join(' ');
        return `<tr data-idx="${idx}">
          <td>${escapeHtml(it.term || '')}</td>
          <td>${escapeHtml(it.full_form || '')}</td>
          <td>${escapeHtml(it.definition || '')}</td>
          <td>${escapeHtml(it.context || '')}</td>
          <td>${tagBadges}</td>
          <td></td>
        </tr>`;
      })
      .join('');
  }

  function escapeHtml(s) {
    return (s || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // ---------- Theme ----------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t; // hook for CSS if you want
    localStorage.setItem(LS.THEME, t);
  }
  function toggleTheme() {
    const cur = localStorage.getItem(LS.THEME) || 'light';
    applyTheme(cur === 'light' ? 'dark' : 'light');
  }
  function initTheme() {
    applyTheme(localStorage.getItem(LS.THEME) || 'light');
  }

  // ---------- Add Form Panel ----------
  function showAddPanel(show) {
    const panel = $('#addPanel');
    if (panel) panel.hidden = !show;
  }

  function handleAddSubmit(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const item = {
      term: (fd.get('term') || '').trim(),
      full_form: (fd.get('full_form') || '').trim(),
      definition: (fd.get('definition') || '').trim(),
      context: (fd.get('context') || '').trim(),
      tags: (fd.get('tags') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    };
    if (!item.term) return alert('Term required');

    state.data.push(item);
    saveLocal();
    render();
    if (state.fb.autosync) fbPush();
    e.target.reset();
    showAddPanel(false);
  }

  // ---------- Boot ----------
  window.addEventListener('DOMContentLoaded', async () => {
    // Initial local state
    loadLocal();
    initTheme();
    render();

    // Search & tag filter
    $('#search')?.addEventListener('input', render);
    $('#tagFilter')?.addEventListener('change', render);

    // Theme toggle
    $('#toggleTheme')?.addEventListener('click', toggleTheme);

    // Add panel show/hide
    $('#showAdd')?.addEventListener('click', () => showAddPanel(true));
    $('#cancelAdd')?.addEventListener('click', () => showAddPanel(false));
    $('#addForm')?.addEventListener('submit', handleAddSubmit);

    // Export JSON
    $('#exportBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      download('glossary.json', JSON.stringify(state.data, null, 2), 'application/json');
    });

    // Export CSV
    $('#exportCsvBtn')?.addEventListener('click', () => {
      download('glossary.csv', toCSV(state.data), 'text/csv');
    });

    // Import CSV
    $('#importCsvBtn')?.addEventListener('click', () => $('#csvFile')?.click());
    $('#csvFile')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const rows = parseCSV(text);
        state.data = [...rows, ...state.data];
        saveLocal();
        render();
        if (state.fb.autosync) fbPush();
        alert(`Imported ${rows.length} items.`);
      } catch (err) {
        console.error(err);
        alert(`CSV import failed: ${err.message}`);
      } finally {
        e.target.value = '';
      }
    });

    // Firebase buttons
    $('#fbConnect')?.addEventListener('click', async () => {
      const cfgText = $('#fbConfig')?.value.trim();
      const path = $('#fbPath')?.value.trim();
      if (!cfgText || !path) return alert('Provide config JSON and path');
      try {
        const cfg = JSON.parse(cfgText);
        await fbConnect(cfg, path);
        alert('Connected.');
      } catch (e) {
        alert('Bad JSON or Firebase error: ' + e.message);
      }
    });
    $('#fbPull')?.addEventListener('click', () => fbPull());
    $('#fbPush')?.addEventListener('click', () => fbPush());
    $('#fbAuto')?.addEventListener('change', (e) => {
      state.fb.autosync = !!e.target.checked;
      if (state.fb.autosync) fbPush();
    });

    // Auto-connect using bundled fb-config.js if present
    try {
      const auto = $('#fbAutoBundle');
      if (window.FB_CONFIG && window.FB_PATH && (auto?.checked !== false)) {
        $('#fbConfig').value = JSON.stringify(window.FB_CONFIG, null, 2);
        $('#fbPath').value = window.FB_PATH;
        await fbConnect(window.FB_CONFIG, window.FB_PATH);
        await fbPull();
        const autoSync = $('#fbAuto');
        if (autoSync) {
          autoSync.checked = true;
          state.fb.autosync = true;
        }
      }
    } catch (e) {
      console.warn('Auto-connect failed:', e);
    }

    console.log('script.js initialized ✅');
  });
})();
