// ── Config ────────────────────────────────────────────
let SB_URL=localStorage.getItem('sb_url')||'';
let SB_KEY=localStorage.getItem('sb_key')||'';

// ── Utils ─────────────────────────────────────────────
const uid=()=>Math.random().toString(36).slice(2,11);
const $=id=>document.getElementById(id);
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// Parse an ISO date string safely (avoid UTC vs local timezone issues)
function parseDate(iso){if(!iso)return null;const[y,m,d]=iso.split('-').map(Number);return new Date(y,m-1,d)}
// "Sep 12" for pill switcher
const fmtS=iso=>{const d=parseDate(iso);if(!d)return'';return`${MONTHS[d.getMonth()]} ${d.getDate()}`};
// "Mon Sep 12" for pill switcher — compact, no comma
const fmtSW=iso=>{const d=parseDate(iso);if(!d)return'';return`${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`};
// "Monday, Sep 12" for hero
const fmtHero=iso=>{const d=parseDate(iso);if(!d)return'';const full=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];return`${full[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`};
const fmtT=t=>{if(!t)return'';const[h,m]=t.split(':');const hr=parseInt(h);return`${hr%12||12}:${m} ${hr>=12?'PM':'AM'}`};

// Resequence all day dates from trip.startDate keeping them consecutive
function resequenceDates(trip){
  if(!trip.startDate||!trip.days.length)return;
  const base=parseDate(trip.startDate);
  trip.days.forEach((day,i)=>{
    const d=new Date(base);d.setDate(base.getDate()+i);
    day.date=d.toISOString().slice(0,10);
  });
  // auto-update endDate to match last day
  trip.endDate=trip.days[trip.days.length-1].date;
}
let _tt;
function toast(msg,d=2200){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(_tt);_tt=setTimeout(()=>el.classList.remove('show'),d)}

// ── DB ────────────────────────────────────────────────
// ── Supabase sync ─────────────────────────────────────
// We store the entire trips JSON as one row in a simple key/value table.
// This requires a one-time SQL setup (see setup wizard, step 2b addendum).


async function sbFetch(path, method='GET', body=null, extraHeaders={}){
  if(!SB_URL||!SB_KEY)return{ok:false,data:null,err:'No credentials'};
  try{
    const headers={
      'apikey':SB_KEY,
      'Authorization':`Bearer ${SB_KEY}`,
      'Content-Type':'application/json',
      ...extraHeaders
    };
    const opts={method,headers};
    if(body)opts.body=JSON.stringify(body);
    const r=await fetch(`${SB_URL}/rest/v1/${path}`,opts);
    const txt=await r.text();
    const data=txt?JSON.parse(txt):null;
    if(!r.ok){console.warn('[Sync] HTTP',r.status,path,txt);return{ok:false,data,err:r.status};}
    return{ok:true,data};
  }catch(e){console.warn('[Sync] fetch error',e);return{ok:false,data:null,err:e.message};}
}

// Upload a file to Supabase Storage, return permanent public URL or null
async function uploadToStorage(file, pathNoExt){
  if(!SB_URL||!SB_KEY)return null;
  // Ensure the path has the right file extension
  const ext=file.name.split('.').pop()||'bin';
  const path=pathNoExt.includes('.')?pathNoExt:`${pathNoExt}.${ext}`;
  try{
    const r=await fetch(`${SB_URL}/storage/v1/object/trip-media/${path}`,{
      method:'POST',
      headers:{
        'apikey':SB_KEY,
        'Authorization':`Bearer ${SB_KEY}`,
        'Content-Type':file.type||'application/octet-stream',
        'x-upsert':'true'
      },
      body:file
    });
    const txt=await r.text();
    if(!r.ok){console.warn('[Storage] Upload failed',r.status,txt);return null;}
    const publicUrl=`${SB_URL}/storage/v1/object/public/trip-media/${path}`;
    console.log('[Storage] Uploaded →',publicUrl);
    return publicUrl;
  }catch(e){console.warn('[Storage] Upload error',e);return null;}
}

// Upload and return URL — uses permanent URL if Supabase available, else local blob
async function uploadFile(file, storagePath){
  const permanentUrl=await uploadToStorage(file, storagePath);
  if(permanentUrl)return{url:permanentUrl, blob:null};
  // offline fallback
  return{url:null, blob:URL.createObjectURL(file)};
}

const DB={
  _d:null,
  get data(){return this._d||(this._d=this._load())},
  _load(){
    try{return JSON.parse(localStorage.getItem('trips_v3')||'{"trips":[]}')}
    catch{return{trips:[]}}
  },
  save(immediate=false){
    localStorage.setItem('trips_v3',JSON.stringify(this._d));
    if(immediate)return this._doPush();
    this._pushRemote();
    return Promise.resolve();
  },
  _pushTimer:null,
  _pushRemote(){
    clearTimeout(this._pushTimer);
    this._pushTimer=setTimeout(()=>this._doPush(),1000);
  },
  async _doPush(){
    if(!SB_URL||!SB_KEY){console.log('[Sync] No credentials, skip push');return;}
    const val=JSON.stringify(this._d);
    // Upsert: INSERT + ON CONFLICT update
    const res=await sbFetch('app_data','POST',
      {key:'trips_v3',value:val},
      {'Prefer':'resolution=merge-duplicates,return=minimal'}
    );
    if(res.ok)console.log('[Sync] Push OK');
    else console.warn('[Sync] Push failed',res.err);
  },
  async syncFromRemote(){
    if(!SB_URL||!SB_KEY){console.log('[Sync] No credentials');return false;}
    console.log('[Sync] Pulling from',SB_URL);
    const res=await sbFetch('app_data?key=eq.trips_v3&select=value','GET');
    if(!res.ok){console.warn('[Sync] Pull failed',res.err);return false;}
    const rows=res.data;
    console.log('[Sync] Got rows:',rows?.length);
    if(!rows||!rows.length){
      // No remote data yet — push local data up
      console.log('[Sync] No remote row, seeding from local');
      await this._doPush();
      return false;
    }
    try{
      const remote=JSON.parse(rows[0].value);
      if(remote&&remote.trips){
        this._d=remote;
        localStorage.setItem('trips_v3',JSON.stringify(remote));
        console.log('[Sync] Pulled',remote.trips.length,'trips');
        return true;
      }
    }catch(e){console.warn('[Sync] Parse error',e);}
    return false;
  }
};
const blobs={};

// Seed demo
if(!DB.data.trips.length){
  DB.data.trips=[{id:'demo1',name:'Kyoto & Tokyo',emoji:'🏯',startDate:'2025-09-12',endDate:'2025-09-22',coverUrl:'',
    files:[],
    checklist:[
      {id:'tc1',text:'Book flights',done:true,dayId:null},
      {id:'tc2',text:'Travel insurance',done:false,dayId:null},
      {id:'tc3',text:'JR Pass — buy before departure',done:false,dayId:null}
    ],
    days:[
      {id:'d1',title:'Arrival & Arashiyama',date:'2025-09-12',heroUrl:'',mapPdfUrl:'',
        activities:[
          {id:'a1',name:'Check in to Ryokan',timeStart:'15:00',timeEnd:'',notes:'Bring passport.',details:'Nishiyama Ryokan, 3 Chome-338 Gion. Quiet hours 10pm. Yukata provided.',files:[],links:[{id:'l1',label:'Booking.com',url:'https://booking.com'}]},
          {id:'a2',name:'Bamboo Grove Walk',timeStart:'17:30',timeEnd:'19:00',notes:'Golden hour is magical.',details:'Sagano Bamboo Forest, Ukyo Ward. Free entry. Can get crowded midday — go late afternoon for best light.',files:[],links:[]}
        ],
        checklist:[{id:'c1',text:'Pack yen in small bills',done:false},{id:'c2',text:'Download offline Google Maps',done:true},{id:'c3',text:'Confirm ryokan check-in time',done:false}]
      },
      {id:'d2',title:'Fushimi Inari Day',date:'2025-09-13',heroUrl:'',mapPdfUrl:'',
        activities:[
          {id:'a3',name:'Fushimi Inari Shrine',timeStart:'07:00',timeEnd:'09:30',notes:'Leave before 8am.',details:'Free entry 24/7. Full hike to the summit (Yotsusuji) is about 2 hours round trip. Bring water.',files:[],links:[]},
          {id:'a4',name:'Nishiki Market',timeStart:'11:30',timeEnd:'13:00',notes:'Try pickled vegetables.',details:'Nicknamed "Kyoto\'s Kitchen". About 100 stalls. Best fresh tofu at the stall near the Teramachi end.',files:[],links:[]}
        ],
        checklist:[{id:'c4',text:'Comfortable walking shoes',done:false},{id:'c5',text:'Buy an omamori charm',done:false}]
      },
      {id:'d3',title:'Shinkansen to Tokyo',date:'2025-09-14',heroUrl:'',mapPdfUrl:'',
        activities:[
          {id:'a5',name:'Morning at Philosopher\'s Path',timeStart:'08:00',timeEnd:'10:00',notes:'Quiet canal walk.',details:'2km stone path along the Biwa Canal. Cherry blossoms in spring, beautiful foliage in fall.',files:[],links:[]},
          {id:'a6',name:'Shinkansen to Shibuya',timeStart:'13:20',timeEnd:'15:50',notes:'Nozomi train.',details:'Kyoto → Tokyo Nozomi 36. Platform 14. Non-reserved car 3 or 4 is usually fine.',files:[],links:[]}
        ],
        checklist:[{id:'c6',text:'Book Shinkansen tickets',done:true},{id:'c7',text:'Pack bag the night before',done:false}]
      }
    ]
  }];
  DB.save();
}
// Ensure all trips have consecutive dates and required arrays
DB.data.trips.forEach(t=>{
  resequenceDates(t);
  if(!t.files)t.files=[];
  if(!t.checklist)t.checklist=[];
});

// Pull latest data from Supabase on load (non-blocking — renders local first, then updates if remote is different)
(async()=>{
  const synced=await DB.syncFromRemote();
  if(synced){
    DB.data.trips.forEach(t=>{resequenceDates(t);if(!t.files)t.files=[];if(!t.checklist)t.checklist=[];});
    renderTrips();
    toast('✓ Synced');
  }
})();

// ── Screens ───────────────────────────────────────────
let tripId=null,dayIdx=0;
function showScreen(id){document.querySelectorAll('.screen').forEach(s=>{s.classList.toggle('hidden',s.id!==id);s.classList.remove('back')})}
function pushScreen(id){document.querySelectorAll('.screen').forEach(s=>{if(s.id===id){s.classList.remove('hidden','back')}else if(!s.classList.contains('hidden')){s.classList.add('back');s.classList.remove('hidden')}})}
function popScreen(){document.querySelectorAll('.screen').forEach(s=>{if(s.classList.contains('back')){s.classList.remove('back','hidden')}else if(!s.classList.contains('hidden')){s.classList.add('hidden')}})}

// ── Sheets ────────────────────────────────────────────
let activeSheet=null,ctx={};
function openSheet(id,c={}){
  ctx=c;$('bd').classList.add('open');$(id).classList.add('open');activeSheet=id;
  setTimeout(()=>{const i=$(id).querySelector('input,textarea');if(i&&!c.nf)i.focus()},350);
}
function closeSheet(){if(!activeSheet)return;$('bd').classList.remove('open');$(activeSheet).classList.remove('open');activeSheet=null}
$('bd').addEventListener('click',closeSheet);

// ── Setup ─────────────────────────────────────────────
$('btn-setup').addEventListener('click',()=>$('setup').classList.remove('hidden'));
$('sql-copy').addEventListener('click',function(){
  const txt=this.innerText.replace(/Tap to copy|Copied ✓/g,'').trim();
  navigator.clipboard.writeText(txt).then(()=>{this.classList.add('copied');setTimeout(()=>this.classList.remove('copied'),2200)});
});
$('sw-done').addEventListener('click',async()=>{
  const url=$('sw-url').value.trim(),key=$('sw-key').value.trim();
  if(url&&key){
    SB_URL=url;SB_KEY=key;
    localStorage.setItem('sb_url',url);localStorage.setItem('sb_key',key);
    toast('Connecting…');
    // Try to pull first; if nothing there, push local data up
    const synced=await DB.syncFromRemote();
    if(synced){
      DB.data.trips.forEach(t=>{resequenceDates(t);if(!t.files)t.files=[];if(!t.checklist)t.checklist=[];});
      renderTrips();
      toast('✓ Synced from cloud!');
    } else {
      toast('✓ Connected — data uploaded');
    }
  }
  $('setup').classList.add('hidden');
});
$('sw-skip').addEventListener('click',()=>$('setup').classList.add('hidden'));
if(SB_URL)$('sw-url').value=SB_URL;
if(SB_KEY)$('sw-key').value=SB_KEY;

// ── Trips list ────────────────────────────────────────
function renderTrips(){
  const{trips}=DB.data;
  const today=new Date().toISOString().slice(0,10);
  const up=trips.filter(t=>!t.endDate||t.endDate>=today);
  const past=trips.filter(t=>t.endDate&&t.endDate<today);
  $('trips-count').textContent=`${trips.length} trip${trips.length!==1?'s':''}`;
  $('t-upcoming').innerHTML='';$('t-past').innerHTML='';
  $('t-empty').style.display=trips.length?'none':'';
  const render=(list,el,lbl,isPast)=>{
    if(!list.length)return;
    const h=document.createElement('div');h.className='sec-h';h.textContent=lbl;el.appendChild(h);
    const grid=document.createElement('div');grid.className='trips-grid';
    list.forEach((t,i)=>grid.appendChild(makeTripCard(t,i,isPast)));
    el.appendChild(grid);
  };
  render(up,$('t-upcoming'),'Upcoming',false);
  render(past,$('t-past'),'Past trips',true);
}
function makeTripCard(t,i,isPast=false){
  const el=document.createElement('div');
  el.className='trip-card ai'+(isPast?' past':'');
  el.style.animationDelay=`${i*.06}s`;
  // always derive end date from last day if we have days
  const effEnd=t.days.length?t.days[t.days.length-1].date:t.endDate;
  const ds=t.startDate&&effEnd?`${fmtS(t.startDate)} – ${fmtS(effEnd)}`:(t.startDate?fmtS(t.startDate):'');
  const heroSrc=blobs['tc_'+t.id]||t.coverUrl;
  el.innerHTML=`${heroSrc?`<img class="trip-hero" src="${heroSrc}" alt="" loading="lazy">`:`<div class="trip-hero-ph">${t.emoji||'✈️'}</div>`}
    <div class="trip-body">
      <div class="trip-name">${t.name}</div>
      <div class="trip-meta">${ds?`<span>${ds}</span><span class="dot-sep"></span>`:''}<span>${t.days.length} day${t.days.length!==1?'s':''}</span></div>
      <div class="trip-badge"><svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="5" r="2.5"/><path d="M10 10c0-2.2-1.8-4-4-4S2 7.8 2 10"/></svg>${t.days.length} day${t.days.length!==1?'s':''} planned</div>
    </div>`;
  el.addEventListener('click',()=>openTrip(t.id));return el;
}

// New / Edit trip sheet
const openNewTrip=()=>{
  $('sh-trip-title').textContent='New Trip';$('sh-trip-sub').textContent='Where are you headed?';
  $('t-name').value='';$('t-s').value='';$('t-e').value='';$('tc-file').value='';
  $('tc-prev').style.display='none';$('tc-upload').style.display='';
  openSheet('sh-trip',{isNew:true});
};
$('btn-new-trip').addEventListener('click',openNewTrip);
$('fab').addEventListener('click',openNewTrip);
$('tc-file').addEventListener('change',function(){if(!this.files[0])return;$('tc-img').src=URL.createObjectURL(this.files[0]);$('tc-prev').style.display='';$('tc-upload').style.display='none'});
$('tc-clear').addEventListener('click',()=>{$('tc-file').value='';$('tc-prev').style.display='none';$('tc-upload').style.display=''});
$('trip-cancel').addEventListener('click',closeSheet);
$('trip-save').addEventListener('click',async()=>{
  const name=$('t-name').value.trim();if(!name){$('t-name').focus();return}
  const id=uid();
  const trip={id,name,startDate:$('t-s').value,endDate:$('t-e').value,coverUrl:'',emoji:'✈️',files:[],checklist:[],days:[]};
  DB.data.trips.unshift(trip);
  DB.save();closeSheet();setTimeout(renderTrips,220);
  if($('tc-file').files[0]){
    const f=$('tc-file').files[0];
    const {url,blob}=await uploadFile(f,`cover/${id}_${Date.now()}`);
    if(url){trip.coverUrl=url;DB.save(true).then(renderTrips);}
    else blobs['tc_'+id]=blob;
  }
});

// ── Edit trip sheet (dates + day management) ──────────
$('btn-edit-trip').addEventListener('click',()=>{
  const trip=getTrip();if(!trip)return;
  $('et-name').value=trip.name;
  $('et-s').value=trip.startDate||'';
  $('et-emoji').textContent=trip.emoji||'✈️';
  $('emoji-picker').style.display='none';
  // show existing cover if any
  const existingCover=blobs['tc_'+trip.id]||trip.coverUrl;
  if(existingCover){$('etc-img').src=existingCover;$('etc-prev').style.display='';$('etc-upload').style.display='none';}
  else{$('etc-file').value='';$('etc-prev').style.display='none';$('etc-upload').style.display='';}
  renderDayManageList(trip);
  openSheet('sh-edit-trip',{nf:true});
});
$('etc-file').addEventListener('change',function(){
  if(!this.files[0])return;
  $('etc-img').src=URL.createObjectURL(this.files[0]);
  $('etc-prev').style.display='';$('etc-upload').style.display='none';
});
$('etc-clear').addEventListener('click',()=>{
  $('etc-file').value='';$('etc-prev').style.display='none';$('etc-upload').style.display='';
});

// Emoji picker
const EMOJIS=['✈️','🏖️','🏔️','🗼','🗽','🏯','🌍','🌎','🌏','🚂','🚢','🏝️','🎡','🏕️','🌋','🗺️','🧳','🎒','🛕','⛩️','🏛️','🎭','🍜','🍣','🥘','🍷','🎿','🤿','🏄','🚵','🎸','🎪'];
const picker=$('emoji-picker');
EMOJIS.forEach(e=>{
  const btn=document.createElement('button');
  btn.textContent=e;
  btn.style.cssText='font-size:22px;background:none;border:none;cursor:pointer;width:36px;height:36px;border-radius:8px;transition:background .1s;display:flex;align-items:center;justify-content:center';
  btn.addEventListener('mouseenter',()=>btn.style.background='var(--bg3)');
  btn.addEventListener('mouseleave',()=>btn.style.background='none');
  btn.addEventListener('click',()=>{
    $('et-emoji').textContent=e;
    picker.style.display='none';
    $('et-emoji').style.borderColor='transparent';
  });
  picker.appendChild(btn);
});
$('et-emoji').addEventListener('click',()=>{
  const open=picker.style.display==='flex';
  picker.style.display=open?'none':'flex';
  $('et-emoji').style.borderColor=open?'transparent':'var(--accent)';
});
function renderDayManageList(trip){
  const list=$('day-manage-list');list.innerHTML='';
  trip.days.forEach((d,i)=>buildManageRow(list,trip,d,i));
}

function buildManageRow(list,trip,d,i){
  const row=document.createElement('div');row.className='day-manage-row';
  row.dataset.idx=i;
  const dateLabel=d.date?fmtSW(d.date):'';
  row.innerHTML=`
    <div class="day-manage-handle"><span></span><span></span><span></span></div>
    <div class="day-manage-num">${i+1}</div>
    <div class="day-manage-title">${d.title||`Day ${i+1}`}</div>
    <span class="day-manage-date">${dateLabel}</span>
    <button class="day-manage-del">✕</button>`;
  list.appendChild(row);

  // Delete
  row.querySelector('.day-manage-del').addEventListener('click',()=>{
    if(!confirm(`Remove "${d.title||'Day '+(i+1)}"? All activities will be deleted.`))return;
    trip.days.splice(i,1);
    resequenceDates(trip);
    DB.save();
    if(dayIdx>=trip.days.length)dayIdx=Math.max(0,trip.days.length-1);
    renderDayManageList(trip);renderTrip();
  });

  // Drag — pointer events so it works on both touch and mouse
  const handle=row.querySelector('.day-manage-handle');
  handle.addEventListener('pointerdown',e=>{
    e.preventDefault();
    startDrag(e,row,list,trip);
  });
}

function startDrag(startEv,row,list,trip){
  let dragIdx=parseInt(row.dataset.idx);
  let overIdx=dragIdx;
  const rowH=row.getBoundingClientRect().height;

  // Ghost — a visual clone that follows the pointer
  const ghost=row.cloneNode(true);
  ghost.style.cssText=`position:fixed;left:${row.getBoundingClientRect().left}px;top:${row.getBoundingClientRect().top}px;width:${row.getBoundingClientRect().width}px;z-index:9999;opacity:.92;box-shadow:0 8px 24px rgba(0,0,0,.18);border-radius:var(--r-sm);background:var(--card);pointer-events:none;transition:none`;
  document.body.appendChild(ghost);
  row.classList.add('dragging');

  const offsetY=startEv.clientY-row.getBoundingClientRect().top;

  function onMove(e){
    const y=e.clientY||e.touches?.[0]?.clientY||0;
    ghost.style.top=(y-offsetY)+'px';

    // Find which row we're over
    const rows=[...list.querySelectorAll('.day-manage-row:not(.dragging)')];
    let newOver=overIdx;
    rows.forEach(r=>{
      const rect=r.getBoundingClientRect();
      const mid=rect.top+rect.height/2;
      if(y>rect.top&&y<rect.bottom){
        newOver=parseInt(r.dataset.idx);
      }
    });
    if(newOver!==overIdx){
      list.querySelectorAll('.day-manage-row').forEach(r=>r.classList.remove('drag-over'));
      const targetRow=list.querySelector(`.day-manage-row[data-idx="${newOver}"]`);
      if(targetRow)targetRow.classList.add('drag-over');
      overIdx=newOver;
    }
  }

  function onEnd(){
    document.removeEventListener('pointermove',onMove);
    document.removeEventListener('pointerup',onEnd);
    document.removeEventListener('pointercancel',onEnd);
    ghost.remove();
    row.classList.remove('dragging');
    list.querySelectorAll('.day-manage-row').forEach(r=>r.classList.remove('drag-over'));

    if(overIdx!==dragIdx){
      // Reorder: move the day content (not dates) to new index
      const [moved]=trip.days.splice(dragIdx,1);
      trip.days.splice(overIdx,0,moved);
      // Resequence dates so Day 1 is still the start date, Day 2 is +1, etc.
      resequenceDates(trip);
      DB.save();
      // Stay on the moved day's new position
      dayIdx=overIdx;
      renderDayManageList(trip);
      renderTrip();
      setTimeout(()=>{
        scrollToDay(dayIdx);
      },80);
    }
  }

  document.addEventListener('pointermove',onMove,{passive:true});
  document.addEventListener('pointerup',onEnd);
  document.addEventListener('pointercancel',onEnd);
}
$('edit-trip-cancel').addEventListener('click',closeSheet);

$('btn-delete-trip').addEventListener('click',()=>{
  const trip=getTrip();if(!trip)return;
  if(!confirm(`Delete "${trip.name}"? This will permanently remove the trip and all its days.`))return;
  DB.data.trips=DB.data.trips.filter(t=>t.id!==trip.id);
  DB.save();
  closeSheet();
  popScreen();
  setTimeout(renderTrips,60);
  toast('Trip deleted');
});
$('edit-trip-save').addEventListener('click',()=>{
  const trip=getTrip();if(!trip)return;
  const name=$('et-name').value.trim();
  if(name)trip.name=name;
  trip.emoji=$('et-emoji').textContent||trip.emoji;
  // save cover photo if changed
  if($('etc-file').files[0]){
    const f=$('etc-file').files[0];
    uploadFile(f,`cover/${trip.id}_${Date.now()}`).then(({url,blob})=>{
      if(url){trip.coverUrl=url;DB.save(true).then(renderTrips);}
      else blobs['tc_'+trip.id]=blob;
    });
  }
  const newStart=$('et-s').value;
  if(newStart&&newStart!==trip.startDate){trip.startDate=newStart;resequenceDates(trip);}
  else if(newStart){trip.startDate=newStart;}
  DB.save();
  $('trip-nav-t').textContent=trip.name;
  renderTrip();closeSheet();setTimeout(renderTrips,100);toast('Trip updated');
});

// ── Trip detail ───────────────────────────────────────
function openTrip(id){
  tripId=id;dayIdx=0;
  pushScreen('s-trip');
  // Reset scroll immediately before render to prevent flash of wrong position
  const vp=$('d-vp');if(vp)vp.scrollLeft=0;
  renderTrip();
}
function getTrip(){return DB.data.trips.find(t=>t.id===tripId)}
function renderTrip(){
  const trip=getTrip();if(!trip)return;
  $('trip-nav-t').textContent=trip.name;
  renderSwitcher(trip);renderTrack(trip);
}
function renderSwitcher(trip){
  const pills=$('d-pills'),dots=$('d-dots');pills.innerHTML='';dots.innerHTML='';
  trip.days.forEach((d,i)=>{
    const p=document.createElement('button');p.className='day-pill'+(i===dayIdx?' active':'');
    // Show "Mon Sep 12" if date known, else "Day N"
    p.textContent=d.date?fmtSW(d.date):`Day ${i+1}`;
    p.onclick=()=>goDay(i);pills.appendChild(p);
    const dot=document.createElement('div');dot.className='day-dot'+(i===dayIdx?' active':'');dots.appendChild(dot);
  });
}
function resizeClInps(root){root.querySelectorAll('textarea.cl-inp').forEach(ta=>{ta.style.height='0';ta.style.height=ta.scrollHeight+'px'});}
function renderTrack(trip){
  const track=$('d-track'),nd=$('no-days');track.innerHTML='';
  if(!trip.days.length){nd.style.display='';return}nd.style.display='none';
  trip.days.forEach((day,i)=>track.appendChild(makeDayCard(day,i,trip)));
  resizeClInps(track);
  // Wait for layout then scroll instantly to active day
  setTimeout(()=>scrollToDay(dayIdx,true),50);
}

function makeDayCard(day,di,trip){
  const el=document.createElement('div');
  el.className='day-card'+(di===dayIdx?' active-col':'');
  el.id=`dc-${di}`;
  const allActs=[...day.activities].sort((a,b)=>{
    const as=a.timeStart,bs=b.timeStart;
    if(!as&&!bs)return 0;if(!as)return 1;if(!bs)return -1;return as.localeCompare(bs);
  });
  const timed=allActs.filter(a=>a.timeStart);
  const untimed=allActs.filter(a=>!a.timeStart);
  const activitiesHtml=[
    ...timed.map(a=>actHtml(a,trip)),
    ...(untimed.length&&timed.length?['<div class="unscheduled-sep">Unscheduled</div>']:[]),
    ...untimed.map(a=>actHtml(a,trip))
  ].join('');
  const heroSrc=blobs['dh_'+day.id]||day.heroUrl||'';
  el.innerHTML=`
    <div class="day-sticky-bar" id="dsb-${di}">
      <div class="day-sticky-title">${day.title||'Day '+(di+1)}</div>
      <div class="day-sticky-date">${day.date?fmtHero(day.date):''}</div>
    </div>
    <div class="day-hero" id="dh-area-${di}">
      ${heroSrc?`<img src="${heroSrc}" alt="">`:`<div style="width:100%;height:100%"></div>`}
      <div class="hero-ov"></div>
      <div class="hero-photo-hint">${heroSrc?'':''}</div>
      <div class="hero-content">
        <div class="hero-label" id="hl-${di}"><span style="opacity:.6;text-transform:uppercase;letter-spacing:.8px;font-size:11px">Day ${di+1}</span>${day.date?`<br>${fmtHero(day.date)}`:''}</div>
        <input class="hero-title-inp" value="${(day.title||'').replace(/"/g,'&quot;')}" placeholder="Name this day..." data-did="${day.id}">
      </div>
      <button class="hero-drag" data-di="${di}" title="Drag to reorder day">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="4" x2="12" y2="4"/><line x1="2" y1="7" x2="12" y2="7"/><line x1="2" y1="10" x2="12" y2="10"/></svg>
      </button>
      <input type="file" accept="image/*" class="hero-file" id="hf-${di}">
    </div>
    <div class="day-content">
      <div class="d-sec">
        <div class="d-sec-t">Plan</div>
        <div class="acts-wrap" data-did="${day.id}">
          ${activitiesHtml}
          <button class="add-act" data-did="${day.id}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg>Add Activity
          </button>
        </div>
      </div>
      <div class="d-sec">
        <div class="d-sec-t">Map</div>
        ${(()=>{
          const mp=mapPrevHtml(day);
          if(mp)return`<div class="map-card"><div class="map-prev" id="mp-${day.id}" style="cursor:pointer" data-act="open-map" data-did="${day.id}">${mp}</div><div class="map-foot"><span class="map-lbl">Day ${di+1} map</span><div style="display:flex;gap:12px"><button class="map-btn" data-act="del-map" data-did="${day.id}" data-di="${di}">Remove</button><button class="map-btn" data-act="change-map" data-did="${day.id}" data-di="${di}">Change map</button></div></div></div>`;
          return`<div class="map-empty-row" data-did="${day.id}" data-di="${di}"><div class="map-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polygon points="1,6 1,22 8,18 16,22 23,18 23,2 16,6 8,2"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg></div><span class="map-empty-lbl"></span><span class="map-empty-add">+ Add Map</span></div>`;
        })()}
      </div>
        <div class="d-sec" style="margin-bottom:20px">
        <div class="d-sec-t">Ideas & Checklist</div>
        <div class="checklist" data-did="${day.id}">
          ${day.checklist.map(c=>clHtml(c)).join('')}
          <div class="cl-add" data-did="${day.id}">
            <div class="cl-add-icon"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg></div>
            <span class="cl-add-text">Add item</span>
          </div>
        </div>
      </div>
    </div>`;
  bindCard(el,day,di,trip);return el;
}

function showMapViewer(src){
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.93);display:flex;align-items:center;justify-content:center;overflow:auto;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y pinch-zoom';
  const img=document.createElement('img');
  img.src=src;
  img.style.cssText='max-width:100%;max-height:100%;object-fit:contain;display:block;touch-action:pan-x pan-y pinch-zoom';
  const closeBtn=document.createElement('button');
  closeBtn.innerHTML='<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="12" y2="12"/><line x1="12" y1="2" x2="2" y2="12"/></svg>';
  closeBtn.style.cssText='position:fixed;top:16px;right:16px;z-index:10000;background:rgba(0,0,0,.55);color:#fff;border:none;border-radius:50%;width:36px;height:36px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0';
  closeBtn.querySelector('svg').style.cssText='width:14px;height:14px';
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  document.body.appendChild(closeBtn);
  const close=()=>{overlay.remove();closeBtn.remove();};
  closeBtn.addEventListener('click',close);
  overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
  document.addEventListener('keydown',function esc(e){if(e.key==='Escape'){close();document.removeEventListener('keydown',esc);}});
}

function mapPrevHtml(day){
  const b=blobs['map_'+day.id];
  if(b)return blobs['map_t_'+day.id]==='img'?`<img src="${b}" alt="map">`:`<iframe src="${b}"></iframe>`;
  if(day.mapPdfUrl){
    const isImg=/\.(jpe?g|png|gif|webp)$/i.test(day.mapPdfUrl);
    return isImg?`<img src="${day.mapPdfUrl}" alt="map">`:`<iframe src="${day.mapPdfUrl}"></iframe>`;
  }
  return null;
}

// Build a custom smart time widget — type 430 → 4:30 PM, fluid tab-less flow
function makeTimeWidget(val24, aid, field){
  let h='', m='', ampm='PM';
  if(val24){
    const [hh,mm]=val24.split(':').map(Number);
    const h12=hh%12||12;
    h=String(h12); m=String(mm).padStart(2,'0'); ampm=hh>=12?'PM':'AM';
  }
  const empty=!val24;
  return`<div class="time-smart${empty?'':' has-value'}" data-aid="${aid}" data-field="${field}">
    ${empty
      ?`<span class="time-placeholder">––:–– ––</span>`
      :`<input class="time-seg ts-h" maxlength="2" inputmode="numeric" value="${h}" placeholder="–" data-aid="${aid}" data-field="${field}">
       <span class="time-sep">:</span>
       <input class="time-seg ts-m" maxlength="2" inputmode="numeric" value="${m}" placeholder="––" data-aid="${aid}" data-field="${field}">
       <button class="time-ampm ts-ap" data-aid="${aid}" data-field="${field}">${ampm}</button>`
    }
  </div>`;
}

// Wire up the smart time widget inputs
function bindTimeWidget(widget, aid, field, day, di){
  const hInp=widget.querySelector('.ts-h');
  const mInp=widget.querySelector('.ts-m');
  const apBtn=widget.querySelector('.ts-ap');
  if(!hInp||!mInp||!apBtn)return;

  function saveWidget(){
    const hVal=hInp.value.trim();
    if(!hVal)return; // hour is the only required field
    const h=parseInt(hVal)||0;
    const m=parseInt(mInp.value.trim())||0; // default to 0 if empty
    const isPM=apBtn.textContent==='PM';
    let h24=h%12+(isPM?12:0);
    if(h24===24)h24=12;
    const val24=`${String(h24).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    const a=findAct(day,aid);if(!a)return;
    if(a[field]===val24)return;
    a[field]=val24;DB.save();refreshCard(di);
  }

  let hBuf='';
  hInp.addEventListener('keydown',e=>{
    if(e.key>='0'&&e.key<='9'){
      e.preventDefault();
      hBuf+=e.key;
      const n=parseInt(hBuf);
      if(hBuf.length===2||(hBuf.length===1&&n>1)){
        hInp.value=String(Math.min(Math.max(n,1),12));
        hBuf='';
        if(!mInp.value.trim())mInp.value='00';
        mInp.focus();mInp.select();
      } else {
        hInp.value=hBuf;
      }
    } else if(e.key==='Backspace'||e.key==='Delete'){
      if(field==='timeEnd'){
        const a=findAct(day,aid);if(a){a.timeEnd='';DB.save();refreshCard(di);}
      } else {hBuf='';hInp.value='';}
    } else if(e.key==='Tab'||e.key==='ArrowRight'){
      e.preventDefault();
      if(!mInp.value.trim())mInp.value='00';
      mInp.focus();mInp.select();
    }
  });
  hInp.addEventListener('blur',e=>{
    const n=parseInt(hInp.value)||0;
    if(n){
      hInp.value=String(Math.min(Math.max(n,1),12));
      if(!mInp.value.trim())mInp.value='00';
      // Don't save+re-render if focus is just moving to another part of this widget
      if(e.relatedTarget!==mInp&&e.relatedTarget!==apBtn)saveWidget();
    }
    hBuf='';
  });

  let mBuf='';
  mInp.addEventListener('keydown',e=>{
    if(e.key>='0'&&e.key<='9'){
      e.preventDefault();
      mBuf+=e.key;
      const n=parseInt(mBuf);
      if(mBuf.length===2||(mBuf.length===1&&n>5)){
        mInp.value=String(Math.min(n,59)).padStart(2,'0');
        mBuf='';
        apBtn.focus();
        saveWidget();
      } else {
        mInp.value=mBuf;
      }
    } else if(e.key==='Backspace'||e.key==='Delete'){
      if(field==='timeEnd'){
        const a=findAct(day,aid);if(a){a.timeEnd='';DB.save();refreshCard(di);}
      } else {mBuf='';mInp.value='';}
    } else if(e.key==='Tab'||e.key==='ArrowRight'){
      e.preventDefault();apBtn.focus();
    } else if(e.key==='ArrowLeft'){
      e.preventDefault();hInp.focus();hInp.select();
    }
  });
  mInp.addEventListener('blur',()=>{
    const raw=mInp.value.trim();
    if(!raw){mInp.value='00';}
    else if(raw.length===1){
      const d=parseInt(raw)||0;
      // 1–5: tens place (4→40); 6–9: ones place (6→06)
      mInp.value=String(Math.min(d<=5?d*10:d,59)).padStart(2,'0');
    } else {
      const n=parseInt(raw);
      if(!isNaN(n))mInp.value=String(Math.min(Math.max(n,0),59)).padStart(2,'0');
    }
    mBuf='';
    saveWidget();
  });

  // AM/PM toggle on click or A/P keypress
  apBtn.addEventListener('click',()=>{
    apBtn.textContent=apBtn.textContent==='PM'?'AM':'PM';
    saveWidget();
  });
  apBtn.addEventListener('keydown',e=>{
    if(e.key==='a'||e.key==='A'){apBtn.textContent='AM';saveWidget();}
    else if(e.key==='p'||e.key==='P'){apBtn.textContent='PM';saveWidget();}
    else if(e.key==='Tab'||e.key==='Enter'){saveWidget();}
  });
}

function actHtml(a, trip){
  // Time badges — only show if time is set, nothing if not
  const hasTime=!!a.timeStart;
  const timeBadgeHtml=hasTime
    ?`<div class="act-time-col"><button class="act-time-badge" data-aid="${a.id}">${fmtT(a.timeStart)}</button>${a.timeEnd?`<button class="act-time-badge end-time" data-aid="${a.id}">→ ${fmtT(a.timeEnd)}</button>`:''}</div>`
    :``;

  const previewNotes=a.notes?`<div class="act-notes-preview">${a.notes}</div>`:'';

  const filesList=(a.files||a.images||[]);
  // An entry is either a permanent https:// URL or a local uid string
  const isPermanentUrl=v=>typeof v==='string'&&v.startsWith('http');
  const getImgSrc=v=>isPermanentUrl(v)?v:(blobs['img_'+v]||v);
  const isImgEntry=v=>{
    if(isPermanentUrl(v))return/\.(jpe?g|png|gif|webp|heic|avif)/i.test(v);
    return/\.(jpe?g|png|gif|webp|heic|avif)$/i.test(blobs['fname_'+v]||'')||(!blobs['fname_'+v]&&!!blobs['img_'+v]);
  };
  const getFileName=v=>{
    if(isPermanentUrl(v))return decodeURIComponent(v.split('/').pop().replace(/^\d+_/,''));
    return blobs['fname_'+v]||'File';
  };
  const imgThumbsHtml=filesList.filter(v=>isImgEntry(v)).map(v=>`<img class="act-img" src="${getImgSrc(v)}" alt="" data-fid="${v}">`).join('');
  const fileRowsHtml=filesList.filter(v=>!isImgEntry(v)).map(v=>{
    const fname=getFileName(v);
    const isPdf=/\.pdf$/i.test(fname),isDoc=/\.(doc|docx)$/i.test(fname);
    const ic=isPdf?'pdf':isDoc?'doc':'other';
    const icon=isPdf?'📄':isDoc?'📝':'📎';
    const href=isPermanentUrl(v)?v:(blobs['img_'+v]||'#');
    return`<a class="act-attach-row" href="${href}" target="_blank" rel="noopener" data-fid="${v}"><div class="act-attach-icon ${ic}">${icon}</div><span class="act-attach-name">${fname}</span><button class="act-attach-del" data-fid="${v}" data-type="file" onclick="event.preventDefault();event.stopPropagation()">✕</button></a>`;
  }).join('');
  const linkRowsHtml=(a.links||[]).map(l=>`<a class="act-attach-row" href="${l.url}" target="_blank" rel="noopener"><div class="act-attach-icon link"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 3H3a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1V8"/><path d="M9 2h3v3M8 6l4-4"/></svg></div><span class="act-attach-name">${l.label||l.url}</span><button class="act-attach-del" data-lid="${l.id}" data-aid="${a.id}" data-type="link" onclick="event.preventDefault();event.stopPropagation()">✕</button></a>`).join('');
  const hasItems=imgThumbsHtml||fileRowsHtml||linkRowsHtml;

  const dayOpts=(trip?.days||[]).map((d,i)=>`<option value="${d.id}">${d.date?fmtSW(d.date):'Day '+(i+1)} — ${d.title||'Untitled'}</option>`).join('');

  return`<div class="act-card" data-aid="${a.id}"${!a.timeStart?' data-untimed="1"':''}>
    <div class="act-hdr">
      ${timeBadgeHtml}
      <div class="act-body">
        <input class="act-title-inp" value="${(a.name||'').replace(/"/g,'&quot;')}" placeholder="Activity name" data-aid="${a.id}" readonly>
        ${previewNotes}
      </div>
      <div class="act-chev"><svg viewBox="0 0 11 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,1 9,9 2,17"/></svg></div>
    </div>
    <div class="act-exp">
      <div class="act-time-editor">
        <div class="time-editor-label">Time</div>
        <div class="time-row">
          <div class="time-inp-wrap">
            <span class="time-inp-lbl">Start</span>
            ${makeTimeWidget(a.timeStart, a.id, 'timeStart')}
          </div>
          <div class="time-inp-wrap">
            <span class="time-inp-lbl">End</span>
            ${makeTimeWidget(a.timeEnd, a.id, 'timeEnd')}
          </div>
          ${(a.timeStart||a.timeEnd)?`<button class="time-clear" data-aid="${a.id}" data-act="clear-time" title="Clear times"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg></button>`:`<div style="width:34px;flex-shrink:0"></div>`}
        </div>
      </div>
      <div class="act-move-row">
        <span class="act-move-lbl">Day</span>
        <select class="act-move-sel" data-aid="${a.id}">${dayOpts}</select>
        <button class="act-move-btn" data-aid="${a.id}" data-act="move-day" style="display:none">Move</button>
      </div>
      <div class="act-detail-wrap">
        <div class="act-detail-label">Quick note</div>
        <textarea class="act-detail-inp" style="min-height:44px" data-field="notes" data-aid="${a.id}" placeholder="Short reminder visible on the card...">${a.notes||''}</textarea>
      </div>
      <div class="act-detail-wrap" style="padding-top:0">
        <div class="act-detail-label">Full description</div>
        <textarea class="act-detail-inp" data-field="details" data-aid="${a.id}" placeholder="Address, booking info, opening hours, anything...">${a.details||''}</textarea>
      </div>
      <div class="act-attachments">
        <div class="act-attach-add-row">
          <label class="act-attach-btn"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="1" y="3" width="14" height="10" rx="2"/><circle cx="8" cy="8" r="2.5"/></svg>Add file / photo<input type="file" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" class="act-file-input" data-aid="${a.id}" multiple></label>
          <button class="act-attach-btn" data-act="link" data-aid="${a.id}"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 3H3a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1V8"/><path d="M9 2h3v3M8 6l4-4"/></svg>Add link</button>
        </div>
        ${hasItems?`<div class="act-attach-items">${imgThumbsHtml?`<div class="act-img-thumbs">${imgThumbsHtml}</div>`:''}${fileRowsHtml}${linkRowsHtml}</div>`:''}
      </div>
      <div class="act-btns">
        <div class="act-btns-del-row" style="border-top:1px solid var(--sep2);padding-top:8px;margin-top:0">
          <button class="act-del" data-act="del" data-aid="${a.id}"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="2,3.5 12,3.5"/><path d="M5.5 3.5V2.5h3v1M4 3.5l.7 8h4.6l.7-8"/></svg>Remove</button>
        </div>
      </div>
    </div>
  </div>`;
}

function clHtml(c, fromTrip=false){
  const badge=fromTrip?`<span style="font-size:10px;color:var(--text4);background:var(--bg3);padding:2px 6px;border-radius:4px;flex-shrink:0;white-space:nowrap">Trip idea</span>`:'';
  const del=fromTrip?'':`<button class="cl-del" aria-label="Delete">✕</button>`;
  return`<div class="cl-item${fromTrip?' trip-cl-item':''}" data-id="${c.id}"${fromTrip?' data-from-trip="1"':''}>
    <div class="cl-circle${c.done?' done':''}"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1.5,6 4.5,9 10.5,3"/></svg></div>
    <textarea class="cl-inp${c.done?' done':''}" placeholder="Add item..." data-id="${c.id}" rows="1"${fromTrip?' readonly':''}>${c.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
    ${badge}${del}
  </div>`;
}

function bindCard(el,day,di,trip){
  // Sticky title bar — appears when hero scrolls out of view
  const stickyBar=el.querySelector(`#dsb-${di}`);
  el.addEventListener('scroll',()=>{
    const heroH=el.querySelector('.day-hero')?.offsetHeight||200;
    stickyBar.classList.toggle('visible', el.scrollTop > heroH - 20);
  },{passive:true});

  // Hero title
  let tt;el.querySelector('.hero-title-inp').addEventListener('input',function(){
    clearTimeout(tt);tt=setTimeout(()=>{
      day.title=this.value;DB.save();renderSwitcher(getTrip());
      // keep sticky bar in sync
      const sb=el.querySelector(`#dsb-${di} .day-sticky-title`);
      if(sb)sb.textContent=this.value||'Day '+(di+1);
    },500);
  });

  // Hero area click = pick photo
  el.querySelector(`#dh-area-${di}`).addEventListener('click',e=>{
    if(e.target.closest('.hero-drag')||e.target.closest('.hero-title-inp'))return;
    const heroSrc=blobs['dh_'+day.id]||day.heroUrl||'';
    if(heroSrc){openSheet('sh-hero-photo',{did:day.id,di});}
    else{el.querySelector(`#hf-${di}`).click();}
  });
  el.querySelector(`#hf-${di}`).addEventListener('change',async function(){
    if(!this.files[0])return;
    closeSheet();
    const f=this.files[0];
    const path=`hero/${day.id}_${Date.now()}`;
    const {url,blob}=await uploadFile(f,path);
    if(url){day.heroUrl=url;await DB.save(true);}
    else blobs['dh_'+day.id]=blob;
    refreshCard(di);
  });

  // Hero drag handle → reorder columns
  el.querySelector('.hero-drag').addEventListener('pointerdown',e=>{
    e.preventDefault(); e.stopPropagation();
    startColDrag(e, di);
  });

  // Activity header toggle (avoid textareas/buttons; title input is readonly so click falls through)
  el.querySelectorAll('.act-hdr').forEach(h=>{
    h.addEventListener('click',e=>{
      if(e.target.tagName==='TEXTAREA'||e.target.tagName==='BUTTON'||e.target.closest('.act-time-col'))return;
      // If already expanded and clicking directly on the title, just focus it for editing
      const card=h.closest('.act-card');
      if(e.target.classList.contains('act-title-inp')&&card.querySelector('.act-exp')?.classList.contains('open')){
        e.target.focus();return;
      }
      const exp=card.querySelector('.act-exp'),chev=card.querySelector('.act-chev');
      const was=exp.classList.contains('open');
      // Close all open panels and restore readonly on their titles
      el.querySelectorAll('.act-exp.open').forEach(x=>{
        x.classList.remove('open');
        x.closest('.act-card')?.querySelector('.act-title-inp')?.setAttribute('readonly','');
      });
      el.querySelectorAll('.act-chev.open').forEach(x=>x.classList.remove('open'));
      if(!was){
        exp.classList.add('open');chev.classList.add('open');
        card.querySelector('.act-title-inp')?.removeAttribute('readonly');
      }
    });
  });

  // Time badges in header toggle expanded; if opening, focus the time input
  el.querySelectorAll('.act-time-col .act-time-badge').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const card=btn.closest('.act-card'),exp=card.querySelector('.act-exp'),chev=card.querySelector('.act-chev');
      const was=exp.classList.contains('open');
      el.querySelectorAll('.act-exp.open').forEach(x=>{x.classList.remove('open');x.closest('.act-card')?.querySelector('.act-title-inp')?.setAttribute('readonly','');});
      el.querySelectorAll('.act-chev.open').forEach(x=>x.classList.remove('open'));
      if(!was){
        exp.classList.add('open');chev.classList.add('open');
        card.querySelector('.act-title-inp')?.removeAttribute('readonly');
        setTimeout(()=>exp.querySelector('.time-native')?.focus(),200);
      }
    });
  });

  // Activity title
  el.querySelectorAll('.act-title-inp').forEach(inp=>{
    let t;inp.addEventListener('input',function(){
      clearTimeout(t);t=setTimeout(()=>{const a=findAct(day,this.dataset.aid);if(a){a.name=this.value;DB.save()}},500);
    });
  });

  // ── Smart time widgets ────────────────────────────────
  el.querySelectorAll('.time-smart').forEach(widget=>{
    const aid=widget.dataset.aid, field=widget.dataset.field;

    // Clicking the placeholder activates the widget and starts editing
    const placeholder=widget.querySelector('.time-placeholder');
    if(placeholder){
      widget.addEventListener('click',()=>{
        // Replace placeholder with live inputs, default PM
        widget.innerHTML=`
          <input class="time-seg ts-h" maxlength="2" inputmode="numeric" value="" placeholder="–" data-aid="${aid}" data-field="${field}">
          <span class="time-sep">:</span>
          <input class="time-seg ts-m" maxlength="2" inputmode="numeric" value="" placeholder="––" data-aid="${aid}" data-field="${field}">
          <button class="time-ampm ts-ap" data-aid="${aid}" data-field="${field}">PM</button>`;
        bindTimeWidget(widget, aid, field, day, di);
        widget.querySelector('.ts-h').focus();
      });
      return;
    }
    bindTimeWidget(widget, aid, field, day, di);
  });

  // Clear times
  el.querySelectorAll('[data-act="clear-time"]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const a=findAct(day,btn.dataset.aid);if(!a)return;
      a.timeStart='';a.timeEnd='';DB.save();refreshCard(di);
    });
  });

  // Notes & Details textarea (auto-resize + save)
  el.querySelectorAll('.act-detail-inp').forEach(ta=>{
    const resize=()=>{ta.style.height='0';ta.style.height=ta.scrollHeight+'px'};resize();
    let t;ta.addEventListener('input',function(){
      resize();
      clearTimeout(t);t=setTimeout(()=>{
        const a=findAct(day,this.dataset.aid);
        if(a){
          a[this.dataset.field]=this.value;
          DB.save();
          // Keep notes preview in header in sync without full re-render
          if(this.dataset.field==='notes'){
            const card=this.closest('.act-card');
            const body=card?.querySelector('.act-body');
            if(body){
              let preview=body.querySelector('.act-notes-preview');
              if(this.value){
                if(!preview){preview=document.createElement('div');preview.className='act-notes-preview';body.appendChild(preview);}
                preview.textContent=this.value;
              } else if(preview){preview.remove();}
            }
          }
        }
      },500);
    });
  });

  // Move activity to another day
  el.querySelectorAll('[data-act="move-day"]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const sel=el.querySelector(`.act-move-sel[data-aid="${btn.dataset.aid}"]`);
      if(!sel)return;
      const targetDayId=sel.value;
      const trip=getTrip();if(!trip)return;
      const targetDay=trip.days.find(d=>d.id===targetDayId);
      if(!targetDay||targetDayId===day.id)return;
      const act=findAct(day,btn.dataset.aid);if(!act)return;
      // Move: remove from current day, add to target day
      day.activities=day.activities.filter(a=>a.id!==act.id);
      targetDay.activities.push(act);
      DB.save();
      refreshCard(di);
      const targetDi=trip.days.indexOf(targetDay);
      if(targetDi>=0)refreshCard(targetDi);
      toast(`Moved to ${targetDay.date?fmtSW(targetDay.date):'Day '+(targetDi+1)}`);
    });
  });

  // Set move-to-day selects to current day by default, show Move btn only when different day chosen
  el.querySelectorAll('.act-move-sel').forEach(sel=>{
    sel.value=day.id;
    const btn=sel.closest('.act-move-row')?.querySelector('.act-move-btn');
    sel.addEventListener('change',()=>{
      if(btn)btn.style.display=sel.value!==day.id?'':'none';
    });
  });

  // Add activity
  el.querySelectorAll('.add-act').forEach(btn=>{
    btn.addEventListener('click',()=>{
      $('a-name').value='';$('a-notes').value='';$('a-details').value='';
      resetActSheet();
      openSheet('sh-act',{did:day.id,di});
      // Wire smart time widgets for the sheet
      wireSheetTimeWidget('a-time-widget', v=>{pendingActStart=v;});
      wireSheetTimeWidget('a-time-end-widget', v=>{pendingActEnd=v;});
    });
  });

  // Add file/photo
  el.querySelectorAll('.act-file-input').forEach(inp=>{
    inp.addEventListener('change',async function(){
      const act=findAct(day,this.dataset.aid);if(!act)return;
      if(!act.files)act.files=act.images||[];
      for(const f of Array.from(this.files)){
        const id=uid();
        const path=`activity/${act.id}/${id}_${f.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
        const {url,blob}=await uploadFile(f,path);
        if(url){act.files.push(url);}
        else{blobs['img_'+id]=blob;blobs['fname_'+id]=f.name;act.files.push(id);}
      }
      await DB.save(true);refreshCard(di);
    });
  });

  // Image thumbnail tap → view/remove sheet
  el.querySelectorAll('.act-img').forEach(img=>{
    img.addEventListener('click',()=>{
      openSheet('sh-act-img',{aid:img.closest('.act-card')?.dataset.aid,fid:img.dataset.fid,src:img.src,di});
    });
  });

  // Unified delete for files and links
  el.querySelectorAll('.act-attach-del').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.preventDefault();e.stopPropagation();
      const card=btn.closest('.act-card');
      const act=findAct(day,card?.dataset.aid);if(!act)return;
      if(btn.dataset.type==='file'){
        if(!act.files)act.files=act.images||[];
        act.files=act.files.filter(id=>id!==btn.dataset.fid);
      } else {
        act.links=act.links.filter(l=>l.id!==btn.dataset.lid);
      }
      DB.save();refreshCard(di);
    });
  });

  // Add link button (now inside act-attachments)
  el.querySelectorAll('[data-act="link"]').forEach(btn=>{
    btn.addEventListener('click',()=>{$('l-label').value='';$('l-url').value='';openSheet('sh-link',{aid:btn.dataset.aid,did:day.id,di})});
  });

  // Delete activity
  el.querySelectorAll('[data-act="del"]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      if(!confirm('Remove this activity?'))return;
      day.activities=day.activities.filter(a=>a.id!==btn.dataset.aid);DB.save();refreshCard(di);
    });
  });

  // Drag to reorder unscheduled activities
  el.querySelectorAll('.act-card[data-untimed]').forEach(card=>{
    card.addEventListener('pointerdown',e=>{
      if(card.querySelector('.act-exp')?.classList.contains('open'))return;
      if(e.target.tagName==='TEXTAREA'||e.target.tagName==='BUTTON'||e.target.tagName==='SELECT'||e.target.tagName==='A'||e.target.closest('.act-time-col'))return;
      const startY=e.clientY,startX=e.clientX;
      const cardRect=card.getBoundingClientRect();
      const offsetY=startY-cardRect.top;
      const actsWrap=el.querySelector('.acts-wrap');
      let dragMode=false,ghost=null,indicator=null;

      const getInsertBeforeAid=y=>{
        for(const c of actsWrap.querySelectorAll('.act-card[data-untimed]')){
          if(c===card)continue;
          const r=c.getBoundingClientRect();
          if(y<r.top+r.height/2)return c.dataset.aid;
        }
        return null;
      };

      const enterDrag=()=>{
        dragMode=true;
        document.body.style.userSelect='none';
        ghost=card.cloneNode(true);
        ghost.style.cssText=`position:fixed;left:${cardRect.left}px;top:${cardRect.top}px;width:${cardRect.width}px;z-index:9999;opacity:.88;box-shadow:0 8px 28px rgba(0,0,0,.22);border-radius:var(--r);pointer-events:none`;
        document.body.appendChild(ghost);
        card.style.opacity='0.25';
        indicator=document.createElement('div');
        indicator.style.cssText='position:absolute;left:0;right:0;height:2px;background:var(--accent);border-radius:2px;pointer-events:none;z-index:100;display:none';
        actsWrap.style.position='relative';
        actsWrap.appendChild(indicator);
      };

      const onMove=ev=>{
        if(!dragMode){
          if(Math.abs(ev.clientY-startY)>18||Math.abs(ev.clientX-startX)>18)enterDrag();
          return;
        }
        ghost.style.top=(ev.clientY-offsetY)+'px';
        const wrapRect=actsWrap.getBoundingClientRect();
        const insertBeforeAid=getInsertBeforeAid(ev.clientY);
        const untimedCards=[...actsWrap.querySelectorAll('.act-card[data-untimed]')];
        if(insertBeforeAid){
          const c=actsWrap.querySelector(`.act-card[data-aid="${insertBeforeAid}"]`);
          indicator.style.display='block';
          indicator.style.top=(c.getBoundingClientRect().top-wrapRect.top-1)+'px';
        } else {
          const last=untimedCards[untimedCards.length-1];
          if(last&&last!==card){
            indicator.style.display='block';
            indicator.style.top=(last.getBoundingClientRect().bottom-wrapRect.top+1)+'px';
          } else {indicator.style.display='none';}
        }
      };

      const onEnd=ev=>{
        document.removeEventListener('pointermove',onMove);
        document.removeEventListener('pointerup',onEnd);
        document.removeEventListener('pointercancel',onEnd);
        document.body.style.userSelect='';
        card.style.opacity='';
        if(!dragMode)return; // no drag — let the click event fire naturally and expand via act-hdr handler
        // Drag completed: swallow the click that follows pointerup, then reorder
        document.addEventListener('click',ev2=>ev2.stopPropagation(),{once:true,capture:true});
        ghost.remove();indicator.remove();
        const insertBeforeAid=getInsertBeforeAid(ev.clientY);
        const actIdx=day.activities.findIndex(a=>a.id===card.dataset.aid);
        if(actIdx<0)return;
        const [movedAct]=day.activities.splice(actIdx,1);
        if(insertBeforeAid){
          const targetIdx=day.activities.findIndex(a=>a.id===insertBeforeAid);
          day.activities.splice(targetIdx>=0?targetIdx:day.activities.length,0,movedAct);
        } else {day.activities.push(movedAct);}
        DB.save();refreshCard(di);
      };

      document.addEventListener('pointermove',onMove,{passive:true});
      document.addEventListener('pointerup',onEnd);
      document.addEventListener('pointercancel',onEnd);
    });
  });

  // Map — empty row and "Change map" button open the upload sheet
  el.querySelectorAll('[data-act="change-map"],.map-empty-row').forEach(btn=>{
    btn.addEventListener('click',()=>{$('map-file').value='';$('map-prev').innerHTML='';$('map-prev').style.display='none';openSheet('sh-map',{did:day.id,di})});
  });

  // Map — open fullscreen viewer
  el.querySelectorAll('[data-act="open-map"]').forEach(prev=>{
    prev.addEventListener('click',()=>{
      const img=prev.querySelector('img'),iframe=prev.querySelector('iframe');
      if(img){showMapViewer(img.src);}
      else if(iframe){window.open(iframe.src,'_blank','noopener');}
    });
  });

  // Map — remove
  el.querySelectorAll('[data-act="del-map"]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      if(!confirm('Remove this map?'))return;
      const trip=getTrip(),d=trip.days.find(x=>x.id===btn.dataset.did);if(!d)return;
      d.mapPdfUrl='';delete blobs['map_'+d.id];delete blobs['map_t_'+d.id];
      DB.save();refreshCard(parseInt(btn.dataset.di));
    });
  });

  // Checklist toggle — handles both day items and trip-level assigned items
  el.querySelectorAll('.cl-item').forEach(item=>{
    const circle=item.querySelector('.cl-circle'),inp=item.querySelector('.cl-inp');
    const fromTrip=item.dataset.fromTrip==='1';
    const findItem=()=>fromTrip
      ?(trip.checklist||[]).find(x=>x.id===item.dataset.id)
      :day.checklist.find(x=>x.id===item.dataset.id);

    circle.addEventListener('click',()=>{
      const c=findItem();if(!c)return;
      c.done=!c.done;DB.save();circle.classList.toggle('done',c.done);inp.classList.toggle('done',c.done);
    });
    if(!fromTrip){
      const resize=()=>{inp.style.height='0';inp.style.height=inp.scrollHeight+'px'};
      let t;inp.addEventListener('input',function(){
        resize();clearTimeout(t);t=setTimeout(()=>{const c=findItem();if(c){c.text=this.value;DB.save()}},600);
      });
      inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();inp.blur()}});
      const delBtn=item.querySelector('.cl-del');
      if(delBtn)delBtn.addEventListener('click',e=>{
        e.stopPropagation();day.checklist=day.checklist.filter(c=>c.id!==item.dataset.id);DB.save();
        item.style.overflow='hidden';item.style.transition='max-height .2s,opacity .2s';item.style.maxHeight=item.scrollHeight+'px';
        requestAnimationFrame(()=>{item.style.maxHeight='0';item.style.opacity='0'});
        setTimeout(()=>item.remove(),230);
      });
    }
  });

  // Add checklist item
  el.querySelectorAll('.cl-add').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const row=document.createElement('div');row.className='cl-item';
      row.innerHTML=`<div class="cl-circle" style="margin-top:1px"></div><textarea class="cl-inp" placeholder="Add an idea or task..." rows="1"></textarea><button class="cl-del" style="opacity:1;margin-top:-4px">✕</button>`;
      const cl=btn.closest('.checklist');cl.insertBefore(row,btn);
      const i=row.querySelector('textarea');i.focus();
      const resize=()=>{i.style.height='0';i.style.height=i.scrollHeight+'px'};
      i.addEventListener('input',resize);
      const commit=()=>{const txt=i.value.trim();if(txt){day.checklist.push({id:uid(),text:txt,done:false});DB.save();refreshCard(di)}else row.remove()};
      i.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();i.blur()}if(e.key==='Escape')row.remove()});
      i.addEventListener('blur',commit);
      row.querySelector('.cl-del').addEventListener('click',()=>row.remove());
    });
  });
}

function findAct(day,aid){return day.activities.find(a=>a.id===aid)}
function refreshCard(di){
  const trip=getTrip();if(!trip)return;
  const old=$(`dc-${di}`),day=trip.days[di];if(!old||!day)return;
  // remember which activity panel was open before rebuild
  const openActId=old.querySelector('.act-exp.open')?.closest('.act-card')?.dataset.aid||null;
  const newCard=makeDayCard(day,di,trip);
  $('d-track').replaceChild(newCard,old);
  resizeClInps(newCard);
  // re-open the same activity panel after rebuild
  if(openActId){
    const restoredCard=newCard.querySelector(`.act-card[data-aid="${openActId}"]`);
    if(restoredCard){
      restoredCard.querySelector('.act-exp')?.classList.add('open');
      restoredCard.querySelector('.act-chev')?.classList.add('open');
    }
  }
}

// ── Navigation ────────────────────────────────────────
let programmaticScroll=false;

function getCardWidth(){
  const vp=$('d-vp');
  if(!vp)return 380;
  // Try rendered card first (most reliable)
  const card=vp.querySelector('.day-card');
  if(card&&card.offsetWidth>1)return card.offsetWidth;
  // Fall back to viewport width on mobile, col-w on desktop
  if(window.innerWidth<700)return window.innerWidth;
  return 380; // --col-w default
}

function scrollToDay(i, instant=false){
  const vp=$('d-vp');if(!vp)return;
  programmaticScroll=true;
  clearTimeout(scrollEndTimer); // prevent scroll listener from firing during our scroll
  const w=getCardWidth();
  const target=i*w;
  if(instant||true){ // always use instant — smooth scroll fights with scroll-snap
    vp.scrollLeft=target;
  } else {
    vp.scrollTo({left:target,behavior:'smooth'});
  }
  setTimeout(()=>{programmaticScroll=false;},150);
}

function goDay(i){
  const trip=getTrip();if(!trip||i<0||i>=trip.days.length)return;
  dayIdx=i;
  document.querySelectorAll('.day-pill').forEach((p,j)=>p.classList.toggle('active',j===i));
  document.querySelectorAll('.day-dot').forEach((d,j)=>d.classList.toggle('active',j===i));
  document.querySelectorAll('.day-card').forEach((c,j)=>c.classList.toggle('active-col',j===i));
  const pill=$('d-pills').querySelectorAll('.day-pill')[i];
  if(pill)pill.scrollIntoView({behavior:'smooth',inline:'center',block:'nearest'});
  // Set scrollLeft directly — no animation, no race with scroll-snap
  scrollToDay(i,true);
}

// Sync pill/dot when user manually swipes
let scrollEndTimer;
$('d-vp').addEventListener('scroll',()=>{
  if(programmaticScroll)return;
  clearTimeout(scrollEndTimer);
  scrollEndTimer=setTimeout(()=>{
    const vp=$('d-vp');
    const w=getCardWidth();
    if(w===0)return;
    const i=Math.round(vp.scrollLeft/w);
    const trip=getTrip();
    if(!trip)return;
    const clamped=Math.min(Math.max(i,0),trip.days.length-1);
    if(clamped!==dayIdx){
      dayIdx=clamped;
      document.querySelectorAll('.day-pill').forEach((p,j)=>p.classList.toggle('active',j===clamped));
      document.querySelectorAll('.day-dot').forEach((d,j)=>d.classList.toggle('active',j===clamped));
      document.querySelectorAll('.day-card').forEach((c,j)=>c.classList.toggle('active-col',j===clamped));
      const pill=$('d-pills').querySelectorAll('.day-pill')[clamped];
      if(pill)pill.scrollIntoView({behavior:'smooth',inline:'center',block:'nearest'});
    }
  },120);
},{passive:true});

$('btn-back').addEventListener('click',()=>{popScreen();setTimeout(renderTrips,60)});

// ── Trip Files & Ideas Screen ─────────────────────────
let tripFilesId=null;

$('btn-trip-files').addEventListener('click',()=>{
  tripFilesId=tripId;
  const trip=getTrip();if(!trip)return;
  $('tripfiles-nav-t').textContent=trip.name;
  $('s-tripfiles').classList.remove('hidden');
  renderTripFiles(trip);
  renderTripChecklist(trip);
});
$('btn-back-tf').addEventListener('click',()=>{
  $('s-tripfiles').classList.add('hidden');
});

// Tab switching removed — files and checklist are now stacked on one page

function getTripById(id){return DB.data.trips.find(t=>t.id===id)}
function getTripFiles(){return getTripById(tripFilesId||tripId)}

// ── Render trip files list ──
function renderTripFiles(trip){
  if(!trip.files)trip.files=[];
  const list=$('trip-files-list');list.innerHTML='';
  trip.files.forEach((f,i)=>{
    const card=document.createElement('div');card.className='file-card';
    const isPdf=f.name.toLowerCase().endsWith('.pdf');
    const isImg=/\.(jpe?g|png|gif|webp|heic)$/i.test(f.name);
    const icon=isPdf?'📄':isImg?'🖼️':'📎';
    const iconClass=isPdf?'pdf':isImg?'img':'doc';
    card.innerHTML=`
      <div class="file-icon ${iconClass}">${icon}</div>
      <div class="file-info">
        <div class="file-name">${f.name}</div>
        <div class="file-size">${f.size||''}</div>
      </div>
      <button class="file-del" data-idx="${i}" aria-label="Delete">✕</button>`;
    // Click to open — use permanent URL if available, else local blob
    card.addEventListener('click',e=>{
      if(e.target.closest('.file-del'))return;
      const openUrl=f.url||blobs['tripfile_'+tripId+'_'+i];
      if(openUrl)window.open(openUrl,'_blank');
    });
    card.querySelector('.file-del').addEventListener('click',e=>{
      e.stopPropagation();
      trip.files.splice(i,1);
      DB.save();renderTripFiles(trip);
    });
    list.appendChild(card);
  });
}

// File upload
$('trip-file-input').addEventListener('change',async function(){
  if(!this.files.length)return;
  const trip=getTripFiles();if(!trip)return;
  if(!trip.files)trip.files=[];
  for(const f of Array.from(this.files)){
    const sizeStr=f.size>1024*1024?(f.size/1024/1024).toFixed(1)+' MB':(f.size/1024).toFixed(0)+' KB';
    const idx=trip.files.length;
    const path=`tripfile/${tripId}/${Date.now()}_${f.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    const {url,blob}=await uploadFile(f,path);
    trip.files.push({name:f.name,size:sizeStr,url:url||null});
    if(blob)blobs[`tripfile_${tripId}_${idx}`]=blob;
  }
  await DB.save(true);renderTripFiles(trip);
  this.value='';
});

// ── Trip-level checklist ──
function renderTripChecklist(trip){
  if(!trip.checklist)trip.checklist=[];
  const cl=$('trip-checklist');cl.innerHTML='';

  trip.checklist.forEach((item,i)=>{
    const row=document.createElement('div');row.className='cl-item cl-item-global';
    const dayLabel=item.dayId?getDayLabel(trip,item.dayId):'';
    row.innerHTML=`
      <div class="cl-circle${item.done?' done':''}">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1.5,6 4.5,9 10.5,3"/></svg>
      </div>
      <textarea class="cl-inp${item.done?' done':''}" placeholder="Add item..." data-idx="${i}" rows="1">${item.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
      <button class="cl-assign${item.dayId?' assigned':''}" data-idx="${i}" title="${item.dayId?'Assigned to '+dayLabel:'Move to a day'}">
        ${item.dayId?'📅 '+dayLabel:'Move to Day →'}
      </button>
      <button class="cl-del" aria-label="Delete">✕</button>`;

    // Toggle done
    const circle=row.querySelector('.cl-circle');
    const inp=row.querySelector('.cl-inp');
    circle.addEventListener('click',()=>{
      item.done=!item.done;DB.save();
      circle.classList.toggle('done',item.done);
      inp.classList.toggle('done',item.done);
    });
    // Edit text
    inp.addEventListener('keydown',e=>{if(e.key==='Enter')e.preventDefault()});
    let t;inp.addEventListener('input',function(){
      resize();clearTimeout(t);t=setTimeout(()=>{item.text=this.value;DB.save()},600);
    });
    // Assign to day
    row.querySelector('.cl-assign').addEventListener('click',()=>{
      showAssignDayPicker(trip,item,()=>renderTripChecklist(trip));
    });
    // Delete
    row.querySelector('.cl-del').addEventListener('click',()=>{
      trip.checklist.splice(i,1);DB.save();renderTripChecklist(trip);
    });
    cl.appendChild(row);
    const inp2=row.querySelector('textarea.cl-inp');if(inp2){inp2.style.height='0';inp2.style.height=inp2.scrollHeight+'px';}
  });

  // Add item row
  const addRow=document.createElement('div');addRow.className='cl-add';
  addRow.innerHTML=`<div class="cl-add-icon"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg></div><span class="cl-add-text">Add idea or task</span>`;
  addRow.addEventListener('click',()=>{
    const row=document.createElement('div');row.className='cl-item';
    row.innerHTML=`<div class="cl-circle" style="margin-top:1px"></div><textarea class="cl-inp" placeholder="Add an idea or task..." rows="1"></textarea><button class="cl-del" style="opacity:1;margin-top:-4px">✕</button>`;
    cl.insertBefore(row,addRow);
    const inp=row.querySelector('textarea');inp.focus();
    const resizeNew=()=>{inp.style.height='0';inp.style.height=inp.scrollHeight+'px'};
    inp.addEventListener('input',resizeNew);
    const commit=()=>{
      const text=inp.value.trim();
      if(text){trip.checklist.push({id:uid(),text,done:false,dayId:null});DB.save();renderTripChecklist(trip);}
      else row.remove();
    };
    inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();inp.blur();}if(e.key==='Escape')row.remove();});
    inp.addEventListener('blur',commit);
    row.querySelector('.cl-del').addEventListener('click',()=>row.remove());
  });
  cl.appendChild(addRow);
}

function getDayLabel(trip,dayId){
  const d=trip.days.find(x=>x.id===dayId);if(!d)return'?';
  return d.date?fmtSW(d.date):`Day ${trip.days.indexOf(d)+1}`;
}

// Small inline popover to pick which day to assign a checklist item to
function showAssignDayPicker(trip,item,onDone){
  // Build a small sheet-like overlay with day options
  const existing=$('assign-day-sheet');if(existing)existing.remove();
  const sheet=document.createElement('div');
  sheet.id='assign-day-sheet';
  sheet.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:300;background:var(--bg2);border-radius:20px 20px 0 0;padding:0 0 calc(var(--sb) + 16px);transform:translateY(0);max-height:70vh;overflow-y:auto;box-shadow:0 -4px 32px rgba(0,0,0,.18)';
  const opts=trip.days.map((d,i)=>`
    <div class="cl-item" data-did="${d.id}" style="cursor:pointer">
      <div class="day-manage-num" style="display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--accent-light);color:var(--accent);font-size:12px;font-weight:500;flex-shrink:0">${i+1}</div>
      <div style="flex:1;font-size:15px;color:var(--text1)">${d.date?fmtSW(d.date):'Day '+(i+1)} — ${d.title||'Untitled'}</div>
      ${item.dayId===d.id?'<span style="color:var(--accent);font-size:13px">✓</span>':''}
    </div>`).join('');
  sheet.innerHTML=`
    <div style="width:36px;height:4px;border-radius:2px;background:var(--bg4);margin:10px auto 0"></div>
    <div style="font-family:var(--fd);font-size:18px;font-weight:400;padding:12px 20px 8px;letter-spacing:-.3px">Assign to a day</div>
    <div class="checklist" style="margin:0 16px 8px">${opts}</div>
    <div style="padding:4px 16px">
      <button style="width:100%;padding:11px;background:var(--bg3);color:var(--text2);border:none;border-radius:var(--r-sm);font-size:15px;cursor:pointer;font-family:var(--fb)" id="assign-remove-btn">${item.dayId?'Remove from day':'Cancel'}</button>
    </div>`;
  document.body.appendChild(sheet);

  // Backdrop
  const bd=document.createElement('div');
  bd.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:299;backdrop-filter:blur(3px)';
  document.body.appendChild(bd);

  const close=()=>{sheet.remove();bd.remove()};
  bd.addEventListener('click',close);
  sheet.querySelector('#assign-remove-btn').addEventListener('click',()=>{
    item.dayId=null;DB.save();onDone();close();
  });
  sheet.querySelectorAll('[data-did]').forEach(row=>{
    row.addEventListener('click',()=>{
      const targetDay=trip.days.find(d=>d.id===row.dataset.did);
      if(!targetDay){close();return;}
      // MOVE: remove from trip.checklist, add as regular day checklist item
      trip.checklist=trip.checklist.filter(c=>c.id!==item.id);
      if(!targetDay.checklist)targetDay.checklist=[];
      targetDay.checklist.push({id:item.id,text:item.text,done:item.done});
      DB.save();
      onDone();
      close();
      toast(`Moved to ${getDayLabel(trip,targetDay.id)}`);
      const di=trip.days.indexOf(targetDay);
      if(di>=0)setTimeout(()=>refreshCard(di),80);
    });
  });
}

// ── Drag-to-reorder day columns directly ─────────────
function startColDrag(startEv, fromIdx){
  const trip=getTrip();if(!trip||trip.days.length<2)return;
  const vp=$('d-vp');
  const track=$('d-track');

  // Temporarily disable scroll-snap so our drag takes over
  vp.style.scrollSnapType='none';
  vp.style.overflow='hidden';

  const allCards=[...track.querySelectorAll('.day-card')];
  const cardW=allCards[0].getBoundingClientRect().width;
  const startX=startEv.clientX;
  let currentX=startX;
  let toIdx=fromIdx;

  // Dim the source card
  allCards[fromIdx].classList.add('col-dragging');

  // Record starting scroll so we can offset
  const scrollStart=vp.scrollLeft;

  function onMove(e){
    currentX=e.clientX;
    const dx=currentX-startX;

    // Visually shift the dragging card
    allCards[fromIdx].style.transform=`translateX(${dx}px)`;
    allCards[fromIdx].style.transition='none';
    allCards[fromIdx].style.zIndex='10';
    allCards[fromIdx].style.position='relative';

    // Determine which slot we've dragged into
    const newIdx=Math.min(Math.max(Math.round(fromIdx + dx/cardW), 0), trip.days.length-1);
    if(newIdx!==toIdx){
      // Clear old highlight
      allCards.forEach(c=>c.classList.remove('col-drag-before','col-drag-after'));
      toIdx=newIdx;
      if(toIdx!==fromIdx){
        const target=allCards[toIdx];
        target.classList.add(toIdx>fromIdx?'col-drag-after':'col-drag-before');
      }
    }
  }

  function onEnd(){
    document.removeEventListener('pointermove',onMove);
    document.removeEventListener('pointerup',onEnd);
    document.removeEventListener('pointercancel',onEnd);

    // Reset card style
    allCards[fromIdx].style.transform='';
    allCards[fromIdx].style.transition='';
    allCards[fromIdx].style.zIndex='';
    allCards[fromIdx].style.position='';
    allCards[fromIdx].classList.remove('col-dragging');
    allCards.forEach(c=>c.classList.remove('col-drag-before','col-drag-after'));

    // Re-enable scroll
    vp.style.scrollSnapType='';
    vp.style.overflow='';

    if(toIdx!==fromIdx){
      // Reorder content in trip.days
      const [moved]=trip.days.splice(fromIdx,1);
      trip.days.splice(toIdx,0,moved);
      resequenceDates(trip);
      DB.save();
      dayIdx=toIdx;
      renderTrip();
      // Scroll to the moved card
      setTimeout(()=>{
        scrollToDay(dayIdx);
      },60);
    }
  }

  document.addEventListener('pointermove',onMove,{passive:true});
  document.addEventListener('pointerup',onEnd);
  document.addEventListener('pointercancel',onEnd);
}

// ── Add day before / after ────────────────────────────
function addDay(prepend){
  const trip=getTrip();if(!trip)return;
  const id=uid();
  const dayNum=prepend?1:trip.days.length+1;
  const newDay={id,title:`Day ${dayNum}`,date:'',heroUrl:'',mapPdfUrl:'',activities:[],checklist:[]};
  if(prepend){
    trip.days.unshift(newDay);
    dayIdx=0;
    // if trip has a start date, push it back one day
    if(trip.startDate){
      const d=parseDate(trip.startDate);d.setDate(d.getDate()-1);
      trip.startDate=d.toISOString().slice(0,10);
    }
  } else {
    trip.days.push(newDay);
    dayIdx=trip.days.length-1;
  }
  // resequence all dates from startDate
  resequenceDates(trip);
  DB.save();
  renderTrip();
  setTimeout(()=>{
    scrollToDay(dayIdx);
  },80);
  toast(prepend?'Day added to the start':'Day added to the end');
}

$('btn-day-prepend').addEventListener('click',()=>addDay(true));
$('btn-day-append').addEventListener('click',()=>addDay(false));

// Save activity
// New activity sheet — file previews + temporary pending links
let pendingActFiles=[];  // [{id, name, blobUrl}]
let pendingActLinks=[];  // [{id, label, url}]
let pendingActStart='';  // 24h string e.g. "14:30"
let pendingActEnd='';

function resetActSheet(){
  // Revoke any pending file blob URLs to avoid memory leaks
  pendingActFiles.forEach(f=>{
    if(blobs['img_'+f.id]){URL.revokeObjectURL(blobs['img_'+f.id]);delete blobs['img_'+f.id];}
    delete blobs['fname_'+f.id];
  });
  $('a-name').value='';$('a-notes').value='';$('a-details').value='';
  $('a-files').value='';
  $('a-files-preview').innerHTML='';
  $('a-links-preview').innerHTML='';
  pendingActFiles=[];pendingActLinks=[];
  pendingActStart='';pendingActEnd='';
  // Reset time widgets to placeholder state
  const sw=$('a-time-widget'),ew=$('a-time-end-widget');
  if(sw)sw.innerHTML='<span class="time-placeholder">––:–– ––</span>';
  if(ew)ew.innerHTML='<span class="time-placeholder">––:–– ––</span>';
}

// Wire the sheet time widgets — called each time the sheet opens
function wireSheetTimeWidget(widgetId, onSave){
  const widget=$(widgetId);if(!widget)return;
  const placeholder=widget.querySelector('.time-placeholder');
  if(placeholder){
    widget.addEventListener('click',function handler(){
      widget.removeEventListener('click',handler);
      widget.innerHTML=`
        <input class="time-seg ts-h" maxlength="2" inputmode="numeric" value="" placeholder="–">
        <span class="time-sep">:</span>
        <input class="time-seg ts-m" maxlength="2" inputmode="numeric" value="" placeholder="––">
        <button class="time-ampm ts-ap">PM</button>`;
      bindSheetTimeWidget(widget, onSave);
      widget.querySelector('.ts-h').focus();
    },{once:true});
  }
}

function bindSheetTimeWidget(widget, onSave){
  const hInp=widget.querySelector('.ts-h');
  const mInp=widget.querySelector('.ts-m');
  const apBtn=widget.querySelector('.ts-ap');
  if(!hInp||!mInp||!apBtn)return;

  function save(){
    const hv=hInp.value.trim();
    if(!hv)return; // hour is the only required field
    const h=parseInt(hv)||0,m=parseInt(mInp.value.trim())||0;
    const isPM=apBtn.textContent==='PM';
    let h24=h%12+(isPM?12:0);
    if(h24===24)h24=12;
    onSave(`${String(h24).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
  }

  let hBuf='';
  hInp.addEventListener('keydown',e=>{
    if(e.key>='0'&&e.key<='9'){
      e.preventDefault();hBuf+=e.key;
      const n=parseInt(hBuf);
      if(hBuf.length===2||(hBuf.length===1&&n>1)){
        hInp.value=String(Math.min(Math.max(n,1),12));hBuf='';
        if(!mInp.value.trim())mInp.value='00';
        mInp.focus();mInp.select();
      } else hInp.value=hBuf;
    } else if(e.key==='Backspace'){hBuf='';hInp.value='';}
    else if(e.key==='Tab'||e.key==='ArrowRight'){e.preventDefault();if(!mInp.value.trim())mInp.value='00';mInp.focus();mInp.select();}
  });
  hInp.addEventListener('blur',e=>{
    const n=parseInt(hInp.value)||0;
    if(n){
      hInp.value=String(Math.min(Math.max(n,1),12));
      if(!mInp.value.trim())mInp.value='00';
      if(e.relatedTarget!==mInp&&e.relatedTarget!==apBtn)save();
    }
    hBuf='';
  });

  let mBuf='';
  mInp.addEventListener('keydown',e=>{
    if(e.key>='0'&&e.key<='9'){
      e.preventDefault();mBuf+=e.key;
      const n=parseInt(mBuf);
      if(mBuf.length===2||(mBuf.length===1&&n>5)){
        mInp.value=String(Math.min(n,59)).padStart(2,'0');mBuf='';
        apBtn.focus();save();
      } else mInp.value=mBuf;
    } else if(e.key==='Backspace'){mBuf='';mInp.value='';}
    else if(e.key==='Tab'||e.key==='ArrowRight'){e.preventDefault();apBtn.focus();}
    else if(e.key==='ArrowLeft'){e.preventDefault();hInp.focus();hInp.select();}
  });
  mInp.addEventListener('blur',()=>{
    const raw=mInp.value.trim();
    if(!raw){mInp.value='00';}
    else if(raw.length===1){
      const d=parseInt(raw)||0;
      mInp.value=String(Math.min(d<=5?d*10:d,59)).padStart(2,'0');
    } else {
      const n=parseInt(raw);
      if(!isNaN(n))mInp.value=String(Math.min(Math.max(n,0),59)).padStart(2,'0');
    }
    mBuf='';save();
  });

  apBtn.addEventListener('click',()=>{apBtn.textContent=apBtn.textContent==='PM'?'AM':'PM';save();});
  apBtn.addEventListener('keydown',e=>{
    if(e.key==='a'||e.key==='A'){apBtn.textContent='AM';save();}
    else if(e.key==='p'||e.key==='P'){apBtn.textContent='PM';save();}
    else if(e.key==='Tab'||e.key==='Enter')save();
  });
}

$('a-files').addEventListener('change',async function(){
  for(const f of Array.from(this.files)){
    const id=uid();
    // Store locally for preview while uploading
    const blobUrl=URL.createObjectURL(f);
    blobs['img_'+id]=blobUrl;blobs['fname_'+id]=f.name;
    pendingActFiles.push({id,name:f.name,file:f,url:null});
    const row=document.createElement('div');
    row.className='act-attach-row';row.dataset.fid=id;
    const isPdf=/\.pdf$/i.test(f.name),isDoc=/\.(doc|docx)$/i.test(f.name);
    const ic=isPdf?'pdf':isDoc?'doc':'other';
    const icon=isPdf?'📄':isDoc?'📝':'📎';
    row.innerHTML=`<div class="act-attach-icon ${ic}">${icon}</div><span class="act-attach-name">${f.name}</span><button type="button" class="act-attach-del" style="margin-left:auto">✕</button>`;
    row.querySelector('.act-attach-del').addEventListener('click',()=>{
      pendingActFiles=pendingActFiles.filter(x=>x.id!==id);row.remove();
    });
    $('a-files-preview').appendChild(row);
  }
  this.value='';
});

$('a-add-link-btn').addEventListener('click',()=>{
  $('l-label').value='';$('l-url').value='';
  openSheet('sh-link',{fromNewAct:true});
});

$('act-cancel').addEventListener('click',()=>{resetActSheet();closeSheet();});

$('act-save').addEventListener('click',async()=>{
  const name=$('a-name').value.trim();if(!name){$('a-name').focus();return}
  const trip=getTrip(),day=trip.days.find(d=>d.id===ctx.did);if(!day)return;
  // Upload any pending files to storage
  const fileRefs=[];
  for(const pf of pendingActFiles){
    if(pf.file){
      const path=`activity/new/${pf.id}_${pf.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
      const {url}=await uploadFile(pf.file,path);
      fileRefs.push(url||pf.id);
    } else fileRefs.push(pf.id);
  }
  const links=pendingActLinks.map(l=>({...l}));
  day.activities.push({id:uid(),name,timeStart:pendingActStart,timeEnd:pendingActEnd,notes:$('a-notes').value.trim(),details:$('a-details').value.trim(),files:fileRefs,links});
  DB.save();resetActSheet();closeSheet();setTimeout(()=>refreshCard(ctx.di!=null?ctx.di:dayIdx),300);
});

// Save link
$('link-cancel').addEventListener('click',closeSheet);
$('link-save').addEventListener('click',()=>{
  const url=$('l-url').value.trim();if(!url){$('l-url').focus();return}
  const label=$('l-label').value.trim()||url;
  // If called from new-activity sheet, add to pending list and go back
  if(ctx.fromNewAct){
    const id=uid();
    pendingActLinks.push({id,label,url});
    const row=document.createElement('div');
    row.className='act-attach-row';
    row.innerHTML=`<div class="act-attach-icon link"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 3H3a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1V8"/><path d="M9 2h3v3M8 6l4-4"/></svg></div><span class="act-attach-name">${label}</span><button type="button" class="act-attach-del" style="margin-left:auto">✕</button>`;
    row.querySelector('.act-attach-del').addEventListener('click',()=>{pendingActLinks=pendingActLinks.filter(l=>l.id!==id);row.remove();});
    $('a-links-preview').appendChild(row);
    closeSheet();openSheet('sh-act',{...ctx,fromNewAct:false});
    return;
  }
  const trip=getTrip();
  for(const d of trip.days){const a=d.activities.find(x=>x.id===ctx.aid);if(a){a.links.push({id:uid(),label,url});DB.save();closeSheet();setTimeout(()=>refreshCard(ctx.di!=null?ctx.di:dayIdx),300);return}}
});

// Map
$('map-file').addEventListener('change',function(){
  if(!this.files[0])return;
  const f=this.files[0],isImg=f.type.startsWith('image/'),url=URL.createObjectURL(f);
  const p=$('map-prev');
  p.innerHTML=isImg
    ?`<img src="${url}" style="width:100%;border-radius:10px;display:block">`
    :`<div class="f-prev-pdf"><div class="f-prev-pdf-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 1.5h6.5L13 5v9.5H3z"/><line x1="5.5" y1="7" x2="10.5" y2="7"/><line x1="5.5" y1="9.5" x2="10.5" y2="9.5"/></svg></div><div><div style="font-size:14px;font-weight:500;color:var(--text1)">${f.name}</div><div style="font-size:12px;color:var(--text3)">${(f.size/1024/1024).toFixed(1)} MB</div></div></div>`;
  p.style.display='';
});
$('map-cancel').addEventListener('click',closeSheet);
$('map-save').addEventListener('click',async()=>{
  const f=$('map-file').files[0];if(!f){closeSheet();return}
  const trip=getTrip(),day=trip.days.find(d=>d.id===ctx.did);if(!day)return;
  const path=`map/${day.id}_${Date.now()}_${f.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
  const {url,blob}=await uploadFile(f,path);
  if(url){
    day.mapPdfUrl=url;
    await DB.save(true);
  } else {
    blobs['map_'+day.id]=blob;
    blobs['map_t_'+day.id]=f.type.startsWith('image/')?'img':'pdf';
  }
  DB.save();closeSheet();setTimeout(()=>refreshCard(ctx.di!=null?ctx.di:dayIdx),300);
});

// ── Activity image sheet ──────────────────────────────
$('act-img-view').addEventListener('click',()=>{
  const src=ctx.src;closeSheet();
  if(src)showMapViewer(src);
});
$('act-img-remove').addEventListener('click',()=>{
  const trip=getTrip();if(!trip)return;
  const di=ctx.di,aid=ctx.aid,fid=ctx.fid;
  const day=trip.days[di];if(!day)return;
  const act=day.activities.find(a=>a.id===aid);if(!act)return;
  if(!act.files)act.files=act.images||[];
  act.files=act.files.filter(f=>f!==fid);
  DB.save();closeSheet();refreshCard(di);
});

// ── Hero photo sheet ──────────────────────────────────
$('hero-photo-replace').addEventListener('click',()=>{
  const di=ctx.di!=null?ctx.di:dayIdx;
  document.querySelector(`#hf-${di}`)?.click();
});
$('hero-photo-remove').addEventListener('click',()=>{
  const trip=getTrip(),day=trip?.days.find(d=>d.id===ctx.did);if(!day)return;
  day.heroUrl='';delete blobs['dh_'+day.id];
  DB.save();closeSheet();
  setTimeout(()=>refreshCard(ctx.di!=null?ctx.di:dayIdx),300);
});

// ── Service Worker ────────────────────────────────────
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));

// ── Init ──────────────────────────────────────────────
const firstRun=!localStorage.getItem('seen');
if(firstRun){localStorage.setItem('seen','1');$('setup').classList.remove('hidden')}
showScreen('s-trips');renderTrips();