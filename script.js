// v5: auto-sort + delete undo + copy + CSV import/export + multi-tags + optional Firebase sync
(function(){
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  // Back-compat: Convert legacy {category: "..."} into {tags: ["..."]}
  function normalizeItem(item){
    const copy = {...item};
    if(!Array.isArray(copy.tags)){
      const src = (copy.category || copy.tags || '').toString();
      const tags = src.split(',').map(t => t.trim()).filter(Boolean);
      copy.tags = tags;
    } else {
      copy.tags = copy.tags.map(t => (t||'').toString().trim()).filter(Boolean);
    }
    // keep category field for CSV export (comma-joined)
    copy.category = copy.tags.join(', ');
    return copy;
  }

  const state = {
    data: (window.GLOSSARY_DATA || []).map(normalizeItem),
    q: '',
    tag: '',
    edit: false,
    dark: (localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark',
    lastDeleted: null, // {item, index}
    fb: { app:null, db:null, docRef:null, autosync:false, connected:false, authed:false }
  };

  function sortMaster(){
    state.data.sort((a,b)=> (a.term||'').localeCompare(b.term||'', undefined, {sensitivity:'base'}));
  }
  function saveLocal(){ localStorage.setItem('glossary-data', JSON.stringify(state.data)); }
  function save(){ sortMaster(); saveLocal(); if(state.fb.autosync) pushToCloud().catch(()=>{}); }
  function applyTheme(){ document.documentElement.classList.toggle('dark', state.dark); localStorage.setItem('theme', state.dark ? 'dark' : 'light'); }

  function allTags(){
    const set = new Set();
    state.data.forEach(d => (d.tags||[]).forEach(t => set.add(t)));
    return Array.from(set).sort((a,b)=>a.localeCompare(b, undefined, {sensitivity:'base'}));
  }
  function initTagFilter(){
    const tags = allTags();
    const sel = $('#tagFilter');
    sel.querySelectorAll('option:not(:first-child)').forEach(o=>o.remove());
    tags.forEach(t => { const opt = document.createElement('option'); opt.value = t; opt.textContent = t; sel.appendChild(opt); });
  }

  function hi(text, q){
    if(!text) return '';
    if(!q) return text;
    try{
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(' + escaped.split(/\s+/).filter(Boolean).join('|') + ')', 'ig');
      return String(text).replace(re, '<mark>$1</mark>');
    }catch(e){ return text; }
  }

  function badgesHTML(tags, q){
    const arr = (tags||[]);
    if(!arr.length) return '';
    return '<div class="badges">' + arr.map(t => `<span class="badge">${hi(t, q)}</span>`).join('') + '</div>';
  }

  function rowText(item){
    const parts = [
      item.term || '',
      item.full_form ? ` — ${item.full_form}` : '',
      item.definition ? `: ${item.definition}` : '',
      item.context ? ` (Use: ${item.context})` : '',
      (item.tags && item.tags.length) ? ` [${item.tags.join('; ')}]` : ''
    ];
    return parts.join('');
  }

  function showToast(msg, undoFn){
    const el = $('#toast');
    el.innerHTML = msg + (undoFn ? ` <button class="btn inline-btn" id="undoBtn">Undo</button>` : '');
    el.hidden = false;
    let timer = setTimeout(()=> { el.hidden = true; }, 5000);
    if(undoFn){
      $('#undoBtn').onclick = ()=>{ clearTimeout(timer); el.hidden = true; undoFn(); };
    }
  }

  function render(){
    sortMaster();
    const tbody = $('#tbody');
    const q = state.q.trim().toLowerCase();
    const tag = state.tag;

    const filtered = state.data.filter(item => {
      const hay = (item.term + ' ' + (item.full_form||'') + ' ' + (item.definition||'') + ' ' + (item.context||'') + ' ' + (item.category||'')).toLowerCase();
      const matchesQ = q ? hay.includes(q) : true;
      const matchesTag = tag ? (item.tags||[]).includes(tag) : true;
      return matchesQ && matchesTag;
    });

    $('#stats').textContent = `${filtered.length} of ${state.data.length} items`;

    tbody.innerHTML = filtered.map((item, i) => {
      const t = state.edit ? 'contenteditable="true" class="editable"' : '';
      return `<tr>
        <td data-label="Term / Abbreviation"><div class="term" ${t} data-key="term">${hi(item.term, state.q)}</div></td>
        <td data-label="Full Form"><div ${t} data-key="full_form">${hi(item.full_form||'', state.q)}</div></td>
        <td data-label="Definition"><div ${t} data-key="definition">${hi(item.definition||'', state.q)}</div></td>
        <td data-label="Typical Use / Context"><div ${t} data-key="context">${hi(item.context||'', state.q)}</div></td>
        <td data-label="Tags">${badgesHTML(item.tags, state.q)}</td>
        <td class="actions-col" data-label="Actions">
          <button class="btn btn-ghost copy" data-index="${i}" title="Copy row">Copy</button>
          <button class="btn btn-danger delete" data-index="${i}" title="Delete row">Delete</button>
        </td>
      </tr>`;
    }).join('');

    document.body.classList.toggle('editing', state.edit);

    if(state.edit){
      // Save on blur for editable fields
      $$('#tbody [contenteditable]').forEach((el) => {
        el.addEventListener('blur', () => {
          const row = el.closest('tr');
          const key = el.dataset.key;
          const idx = Array.from($('#tbody').children).indexOf(row);
          const visible = filtered[idx];
          if(!visible) return;
          const newVal = el.textContent.trim();
          visible[key] = newVal;
          if(key === 'term'){ /* keep sorted */ }
          save();
          initTagFilter();
          render();
        });
      });
    }

    // Wire copy/delete
    $$('#tbody .copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        const item = filtered[idx];
        const text = rowText(item);
        navigator.clipboard.writeText(text).then(()=>{
          btn.textContent = 'Copied!';
          setTimeout(()=> btn.textContent = 'Copy', 1000);
        }).catch(()=> alert('Copy failed — clipboard access blocked?'));
      });
    });

    $$('#tbody .delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        const item = filtered[idx];
        if(!item) return;
        const iMaster = state.data.findIndex(d => d.term === item.term && (d.full_form||'') === (item.full_form||''));
        if(iMaster >= 0){
          const removed = state.data.splice(iMaster, 1)[0];
          state.lastDeleted = { item: removed, index: iMaster };
          save();
          initTagFilter();
          render();
          showToast(`Deleted “${removed.term}”.`, () => {
            // Undo
            const { item, index } = state.lastDeleted || {};
            if(item){
              state.data.splice(index, 0, item);
              state.lastDeleted = null;
              save();
              initTagFilter();
              render();
            }
          });
        }
      });
    });
  }

  // Load persisted data if any, then normalize and sort
  (function loadPersisted(){
    try{
      const saved = localStorage.getItem('glossary-data');
      if(saved){
        const arr = JSON.parse(saved);
        if(Array.isArray(arr) && arr.length) state.data = arr.map(normalizeItem);
      }
    }catch(e){}
    sortMaster();
  })();

  // Controls
  $('#search').addEventListener('input', (e)=>{ state.q = e.target.value; render(); });
  $('#tagFilter').addEventListener('change', (e)=>{ state.tag = e.target.value; render(); });
  $('#toggleTheme').addEventListener('click', ()=>{ state.dark = !state.dark; applyTheme(); });

  // JSON Export
  $('#exportBtn').addEventListener('click', (e)=>{
    e.preventDefault();
    const blob = new Blob([JSON.stringify(state.data, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'glossary-data.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  // CSV Export (category = comma-joined tags for back-compat)
  function toCSV(arr){
    const headers = ['term','full_form','definition','context','category'];
    const escape = (s) => {
      if(s == null) return '';
      const str = String(s);
      if(/[",\n]/.test(str)){ return '"' + str.replace(/"/g,'""') + '"'; }
      return str;
    };
    const rows = [headers.join(',')].concat(arr.map(o => {
      const cat = (o.tags||[]).join(', ');
      return [o.term, o.full_form||'', o.definition||'', o.context||'', cat].map(escape).join(',');
    }));
    return rows.join('\n');
  }
  $('#exportCsvBtn').addEventListener('click', ()=>{
    const csv = toCSV(state.data);
    const blob = new Blob([csv], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'glossary-data.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  // CSV Import
  $('#importCsvBtn').addEventListener('click', ()=> $('#csvFile').click());
  $('#csvFile').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const text = reader.result;
        const rows = text.split(/\r?\n/).filter(r => r.trim().length);
        if(rows.length < 2){ alert('CSV appears empty.'); return; }
        const header = rows[0].split(',').map(h => h.trim().toLowerCase());
        const wanted = ['term','full_form','definition','context','category'];
        const idx = wanted.map(w => header.indexOf(w));
        if(idx.some(i => i < 0)){ alert('CSV must include headers: term, full_form, definition, context, category'); return; }

        function parseCSVLine(line){
          const out = [];
          let cur = '', inQuotes = false;
          for(let i=0;i<line.length;i++){
            const ch = line[i];
            if(inQuotes){
              if(ch === '"'){
                if(i+1 < line.length && line[i+1] === '"'){ cur += '"'; i++; }
                else { inQuotes = false; }
              } else { cur += ch; }
            } else {
              if(ch === '"'){ inQuotes = true; }
              else if(ch === ','){ out.push(cur); cur = ''; }
              else { cur += ch; }
            }
          }
          out.push(cur);
          return out;
        }

        const imported = rows.slice(1).map(r => parseCSVLine(r));
        let added = 0, updated = 0;
        imported.forEach(cols => {
          if(!cols.length) return;
          const obj = {};
          ['term','full_form','definition','context','category'].forEach((key, j) => {
            const pos = idx[j];
            obj[key] = pos >= 0 ? (cols[pos] || '').trim() : '';
          });
          if(!obj.term) return;
          const item = normalizeItem(obj);
          const existingIdx = state.data.findIndex(d => (d.term||'').toLowerCase() === item.term.toLowerCase());
          if(existingIdx >= 0){
            state.data[existingIdx] = {...state.data[existingIdx], ...item};
            updated++;
          } else {
            state.data.push(item);
            added++;
          }
        });
        save();
        initTagFilter();
        render();
        alert(`Import complete: ${added} added, ${updated} updated.`);
      }catch(err){
        alert('Failed to import CSV: ' + err.message);
      }finally{ e.target.value = ''; }
    };
    reader.readAsText(file);
  });

  // Edit mode
  $('#editMode').addEventListener('change', (e)=>{ state.edit = e.target.checked; render(); });

  // Add panel
  const addPanel = $('#addPanel');
  $('#showAdd').addEventListener('click', ()=>{
    addPanel.hidden = !addPanel.hidden;
    if(!addPanel.hidden) $('#addForm [name="term"]').focus();
  });
  $('#cancelAdd').addEventListener('click', ()=>{ addPanel.hidden = true; });

  $('#addForm').addEventListener('submit', (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const term = (fd.get('term')||'').trim();
    const full_form = (fd.get('full_form')||'').trim();
    const definition = (fd.get('definition')||'').trim();
    const context = (fd.get('context')||'').trim();
    const tags = (fd.get('tags')||'').split(',').map(s=>s.trim()).filter(Boolean);

    if(!term){ alert('Please enter a Term / Abbreviation'); return; }

    const exists = state.data.some(d => (d.term||'').toLowerCase() === term.toLowerCase());
    if(exists && !confirm('This term already exists. Add anyway?')) return;

    state.data.push({ term, full_form, definition, context, tags, category: tags.join(', ') });
    save();
    initTagFilter();
    e.target.reset();
    addPanel.hidden = true;
    render();
    state.q = term;
    $('#search').value = term;
    render();
  });

  // Theme + filters init
  applyTheme();
  initTagFilter();
  render();

  // --- Firebase (optional) ---
  async function loadFirebase(){
    if(state.fb.connected) return;
    await new Promise((resolve, reject) => {
      const s1 = document.createElement('script');
      s1.src = 'https://www.gstatic.com/firebasejs/10.13.1/firebase-app-compat.js';
      s1.onload = () => {
        const s2 = document.createElement('script');
        s2.src = 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore-compat.js';
        s2.onload = resolve;
        s2.onerror = reject;
        document.head.appendChild(s2);
      };
      s1.onerror = reject;
      document.head.appendChild(s1);
    });
    state.fb.connected = true;
  }

  function connectFirebase(){
    const cfgText = $('#fbConfig').value.trim();
    const path = $('#fbPath').value.trim();
    if(!cfgText || !path){ alert('Please provide Firebase Config JSON and Firestore path.'); return; }
    try{
      const cfg = JSON.parse(cfgText);
      state.fb.app = firebase.apps?.length ? firebase.app() : firebase.initializeApp(cfg);
      state.fb.db = firebase.firestore();
      const [col, doc] = path.split('/');
      if(!col || !doc) throw new Error('Path must be collection/docId');
      state.fb.docRef = state.fb.db.collection(col).doc(doc);
      showToast('Firebase connected.');
    }catch(e){
      alert('Failed to initialize Firebase: ' + e.message);
    }
  }

  async function anonLogin(){
    if(!state.fb.app){ alert('Connect Firebase first.'); return; }
    try{
      // Using Firestore without explicit auth (allow rules) or via anonymous sign-in not covered by compat bundle here;
      // If your project requires auth, enable anonymous auth in Firebase Console and include auth compat.
      state.fb.authed = true;
      showToast('Proceeding without explicit auth (ensure your Firestore rules allow access).');
    }catch(e){
      alert('Auth error: ' + e.message);
    }
  }

  async function pullFromCloud(){
    if(!state.fb.docRef){ alert('Connect Firebase first.'); return; }
    try{
      const snap = await state.fb.docRef.get();
      if(!snap.exists){ alert('No cloud document found at this path.'); return; }
      const data = snap.data() || {};
      const arr = Array.isArray(data.items) ? data.items.map(normalizeItem) : [];
      if(!arr.length){ alert('Cloud document has no items.'); return; }
      state.data = arr;
      save();
      initTagFilter();
      render();
      showToast('Pulled from cloud.');
    }catch(e){ alert('Pull failed: ' + e.message); }
  }

  async function pushToCloud(){
    if(!state.fb.docRef) return Promise.reject(new Error('Connect Firebase first.'));
    try{
      const payload = { items: state.data, updatedAt: new Date().toISOString() };
      await state.fb.docRef.set(payload, { merge: true });
      showToast('Pushed to cloud.');
    }catch(e){ alert('Push failed: ' + e.message); }
  }

  // Wire cloud buttons
  $('#fbConnect').addEventListener('click', async ()=>{ try{ await loadFirebase(); connectFirebase(); }catch(e){ alert('Firebase load failed: ' + e.message); } });
  $('#fbAnon').addEventListener('click', anonLogin);
  $('#fbPull').addEventListener('click', pullFromCloud);
  $('#fbPush').addEventListener('click', pushToCloud);
  $('#fbAuto').addEventListener('change', (e)=>{ state.fb.autosync = e.target.checked; if(state.fb.autosync) pushToCloud().catch(()=>{}); });

})();