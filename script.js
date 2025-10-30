(function(){
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const state = { data: [], fb:{docRef:null, autosync:false} };

  function sort(){ state.data.sort((a,b)=>(a.term||'').localeCompare(b.term||'', undefined, {sensitivity:'base'})); }
  function render(){
    sort();
    const tbody = $('#tbody');
    const q = ($('#search')?.value||'').toLowerCase();
    const filtered = state.data.filter(it => {
      const hay = (it.term+' '+(it.full_form||'')+' '+(it.definition||'')+' '+(it.context||'')+' '+(it.tags||[]).join(',')).toLowerCase();
      return !q || hay.includes(q);
    });
    $('#stats').textContent = `${filtered.length} of ${state.data.length} items`;
    tbody.innerHTML = filtered.map(it => `<tr>
      <td>${it.term||''}</td><td>${it.full_form||''}</td><td>${it.definition||''}</td>
      <td>${it.context||''}</td><td>${(it.tags||[]).map(t=>`<span class="badge">${t}</span>`).join(' ')}</td>
      <td></td></tr>`).join('');
  }

  // Persistence
  try{ const saved = localStorage.getItem('glossary-data'); if(saved) state.data = JSON.parse(saved);}catch(e){}

  // Firebase compat loader
  async function ensureFirebase(){
    if(!window.firebase){
      await new Promise((res,rej)=>{
        const s1=document.createElement('script');s1.src='https://www.gstatic.com/firebasejs/10.13.1/firebase-app-compat.js';
        s1.onload=()=>{const s2=document.createElement('script');s2.src='https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore-compat.js';s2.onload=res;s2.onerror=rej;document.head.appendChild(s2);};
        s1.onerror=rej;document.head.appendChild(s1);
      });
    }
  }
  async function connectUsing(cfg, path){
    await ensureFirebase();
    const app = firebase.apps?.length ? firebase.app() : firebase.initializeApp(cfg);
    const db = firebase.firestore();
    const [c,d] = path.split('/');
    state.fb.docRef = db.collection(c).doc(d);
    localStorage.setItem('fb-config', JSON.stringify(cfg));
    localStorage.setItem('fb-path', path);
    toast('Connected to Firebase.');
  }
  async function pull(){
    if(!state.fb.docRef) return alert('Connect first');
    const snap = await state.fb.docRef.get();
    const data = snap.data()||{}; const items = Array.isArray(data.items)?data.items:[];
    state.data = items; localStorage.setItem('glossary-data', JSON.stringify(state.data)); render(); toast('Pulled from cloud');
  }
  async function push(){
    if(!state.fb.docRef) return alert('Connect first');
    await state.fb.docRef.set({items: state.data, updatedAt: new Date().toISOString()},{merge:true}); toast('Pushed to cloud');
  }
  function toast(m){ console.log(m); }

  // Wire buttons
  $('#fbConnect')?.addEventListener('click', ()=>{
    const cfgText = $('#fbConfig').value.trim(); const path = $('#fbPath').value.trim();
    if(!cfgText || !path) return alert('Provide config JSON and path');
    try{ const cfg = JSON.parse(cfgText); connectUsing(cfg, path); } catch(e){ alert('Bad JSON: '+e.message); }
  });
  $('#fbPull')?.addEventListener('click', ()=>pull());
  $('#fbPush')?.addEventListener('click', ()=>push());
  $('#fbAuto')?.addEventListener('change', e=>{ state.fb.autosync = e.target.checked; if(state.fb.autosync) push(); });

  // Auto-connect using bundled fb-config.js if present
  window.addEventListener('load', async ()=>{
    try{
      const auto = $('#fbAutoBundle');
      if(window.FB_CONFIG && window.FB_PATH && (auto?.checked !== false)){
        $('#fbConfig').value = JSON.stringify(window.FB_CONFIG, null, 2);
        $('#fbPath').value = window.FB_PATH;
        await connectUsing(window.FB_CONFIG, window.FB_PATH);
        await pull();
        const autoSync = $('#fbAuto'); if(autoSync){ autoSync.checked = true; state.fb.autosync = true; }
      }
    }catch(e){ console.warn(e); }
  });

  // Simple add form
  $('#addForm')?.addEventListener('submit', e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const term = (fd.get('term')||'').trim(); if(!term) return alert('Term required');
    const item = {
      term,
      full_form:(fd.get('full_form')||'').trim(),
      definition:(fd.get('definition')||'').trim(),
      context:(fd.get('context')||'').trim(),
      tags:(fd.get('tags')||'').split(',').map(s=>s.trim()).filter(Boolean)
    };
    state.data.push(item);
    localStorage.setItem('glossary-data', JSON.stringify(state.data));
    render();
    if(state.fb.autosync) push();
    e.target.reset(); $('#addPanel').hidden = true;
  });

  render();
})();