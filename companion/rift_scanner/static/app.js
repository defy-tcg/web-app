'use strict';
let csrf='',state=null,selected='',filter='all',catalogs={},detailVersion='',uiError='';
const $=id=>document.getElementById(id);
const escapeHTML=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function request(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-RW-CSRF':csrf}:undefined,body:body?JSON.stringify(body):undefined});const value=await r.json();if(!r.ok)throw Error(value.error||'Request failed');return value;}
async function action(action,values={}){uiError='';try{await request('/api/action',{action,...values});await refresh();}catch(e){uiError=e.message;$('error').textContent=e.message;}}
async function refresh(){state=await request('/api/state');render();}
function render(){
 $('notice').textContent=(state.watching?'Watching Epson folder · ':'')+state.activity;
 $('error').textContent=state.error||uiError;
 $('catalogStatus').textContent=`${state.catalogCount.toLocaleString()} catalog records · ${state.connected?'Device connected':'Not connected'} · ${state.nativeVersion}`;
 $('watchStatus').textContent=state.watching?'Folder watching is active. Files are copied only after they stop changing.':'Watching is paused.';
 if(document.activeElement!==$('folder')&&!$('folder').value)$('folder').value=state.watchFolder;
 const old=$('batches').value;
 $('batches').innerHTML='<option value="">Select a batch…</option>'+state.batches.map(b=>`<option value="${b.id}">${escapeHTML(b.name)} · ${b.finish}/${b.language}/${b.condition}</option>`).join('');
 $('batches').value=state.workingBatch||old;
 for(const id of ['connect','refresh','index','newBatch','chooseFolder','watch','recheck','sync','rename'])$(id).disabled=state.busy;
 $('batches').disabled=state.busy;
 const scans=state.scans.filter(s=>filter==='all'||s.state===filter||(filter==='review'&&['queued','processing'].includes(s.state)));
 $('queue').innerHTML=scans.map(s=>`<button data-id="${s.id}"><strong>#${s.sequence} · ${escapeHTML(s.filename)}</strong><small>${escapeHTML(s.state==='synced'?'Cloud: '+s.cloud_status:s.state==='ready'?'Strong match — pending cloud validation':s.state)}</small></button>`).join('')||'<p>No scans in this queue.</p>';
 if(!scans.some(s=>s.id===selected))selected=scans[0]?.id||'';
 const scan=state.scans.find(s=>s.id===selected);
 const key=scan?JSON.stringify([scan.id,scan.state,scan.candidates,scan.error,scan.cloud_status]):'';
 if(key!==detailVersion){detailVersion=key;void renderDetail(scan);}
}
async function renderDetail(scan){
 if(!scan){$('detail').innerHTML='<p>This queue is clear.</p>';return;}
 const batch=state.batches.find(b=>b.id===scan.batch_id);
 let cat=catalogs[batch.version];if(!cat){cat=await request('/api/catalog?version='+encodeURIComponent(batch.version));catalogs[batch.version]=cat;}
 if(selected!==scan.id)return;
 const pool=cat.cards.filter(c=>c.inventory_eligible==='1'&&c.inventory_count_weight==='1'&&c.release_status==='released'&&c.language===batch.language&&(c.finish==='Foil'?'Foil':'Nonfoil')===batch.finish);
 const immutable=!!scan.cloud_id||['processing','queued'].includes(scan.state);
 $('detail').innerHTML=`<div class="photos"><img src="/api/image?id=${scan.id}" alt="Uploaded card front"></div><p>${escapeHTML(scan.error||scan.detail.reason||'Select the exact printing.')}</p><p class="muted">${scan.detail.examined||0} references compared · ${(scan.detail.elapsedMs/1000||0).toFixed(1)} seconds · native evidence, not probability</p>${(scan.candidates||[]).map(c=>`<button class="candidate" data-master="${escapeHTML(c.masterId)}" ${immutable?'disabled':''}><strong>${escapeHTML(c.name)}</strong> · ${c.inliers} aligned points<br><small>Detailed similarity ${c.score.toFixed(3)} · ${c.evidence==='human'?'human example':'catalog image'}</small></button>`).join('')}<label>Search exact printing<input id="cardSearch" type="search" placeholder="Name, set, collector number"></label><label>Exact printing<select id="cardSelect"></select></label><label class="check"><input id="ack" type="checkbox" ${scan.duplicate_ack?'checked':''}>Any repeat image represents another physical copy, not a test upload.</label><div class="row"><button id="approveCard" ${immutable?'disabled':''}>Confirm card & learn</button><button id="excludeCard" ${immutable?'disabled':''}>Exclude</button></div>${scan.cloud_id?'<p>Saved in Warehouse OS. Further corrections and finalization happen there.</p>':''}`;
 function options(query=''){const lower=query.toLowerCase();const matches=pool.filter(c=>`${c.card_name} ${c.set_code} ${c.collector_number} ${c.promo_event||''}`.toLowerCase().includes(lower)).slice(0,150);const existing=pool.find(c=>c.master_id===scan.master_id);if(existing&&!matches.includes(existing))matches.unshift(existing);$('cardSelect').innerHTML='<option value="">Choose exact printing…</option>'+matches.map(c=>`<option value="${escapeHTML(c.master_id)}">${escapeHTML(`${c.card_name} · ${c.set_code} ${c.collector_number} · ${c.printing_type||''} ${c.promo_event||''} ${c.markings||''}`)}</option>`).join('');if(scan.master_id)$('cardSelect').value=scan.master_id;}
 options();$('cardSearch').oninput=e=>options(e.target.value);
 $('detail').querySelectorAll('[data-master]').forEach(button=>button.onclick=()=>{const c=pool.find(c=>c.master_id===button.dataset.master);if(c){options(c.card_name);$('cardSelect').value=c.master_id;}});
 $('approveCard').onclick=()=>action('approve',{id:scan.id,masterId:$('cardSelect').value,ack:$('ack').checked});
 $('excludeCard').onclick=()=>action('exclude',{id:scan.id});
}
$('connect').onclick=()=>{const token=$('token').value;$('token').value='';void action('connect',{token});};
$('refresh').onclick=()=>action('refresh');$('index').onclick=()=>action('index');
$('newBatch').onclick=async()=>{await action('new-batch',{name:$('name').value,finish:$('finish').value,language:$('language').value,condition:$('condition').value});$('name').value='';$('finish').value='';};
$('batches').onchange=e=>action('select-batch',{id:e.target.value});
$('rename').onclick=()=>{const b=state.batches.find(x=>x.id===state.workingBatch);const name=prompt('New batch name',b?.name||'');if(name)void action('rename',{name});};
$('chooseFolder').onclick=async()=>{try{const r=await request('/api/action',{action:'choose-folder'});$('folder').value=r.path;}catch(e){uiError=e.message;$('error').textContent=e.message;}};
$('watch').onclick=()=>action('watch',{path:$('folder').value,includeExisting:$('includeExisting').checked});
$('stopWatch').onclick=()=>action('stop-watch');$('recheck').onclick=()=>action('recheck');
$('queue').onclick=e=>{const b=e.target.closest('[data-id]');if(b){selected=b.dataset.id;detailVersion='';render();}};
$('filters').onclick=e=>{const b=e.target.closest('[data-filter]');if(b){filter=b.dataset.filter;selected='';detailVersion='';$('filters').querySelectorAll('button').forEach(x=>x.classList.toggle('selected',x===b));render();}};
$('sync').onclick=async()=>{
 if(!confirm('Synchronize this draft batch to Warehouse OS? This creates receiving records, not available stock. Unconfirmed scans receive independent cloud verification.'))return;
 $('sync').disabled=true;
 try{const signatures={};for(const scan of state.scans.filter(s=>!s.cloud_id&&s.state!=='excluded')){
 const response=await fetch('/api/image?id='+scan.id+'&original=1');if(!response.ok)throw Error('Local scan unavailable');const bmp=await createImageBitmap(await response.blob());const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,8,8);ctx.drawImage(bmp,0,0,8,8);bmp.close();const rgba=ctx.getImageData(0,0,8,8).data,values=[];for(let i=0;i<rgba.length;i+=4)values.push(rgba[i],rgba[i+1],rgba[i+2]);signatures[scan.id]={algorithm:'rw-advisory-grid-v1',values};}
 await action('sync',{signatures});}catch(e){uiError=e.message;$('error').textContent=e.message;}finally{$('sync').disabled=false;}
};
$('shutdown').onclick=async()=>{if(confirm('Stop the local scanner? All drafts stay saved.')){await action('shutdown');$('notice').textContent='Scanner stopped. Reopen it from the Mac launcher.';}};
(async()=>{try{const key=location.hash.slice(1)||sessionStorage.getItem('rw-launch');if(!key)throw Error('Open this window using the scanner launcher.');const result=await request('/session',{key});csrf=result.csrf;sessionStorage.setItem('rw-launch',key);history.replaceState(null,'','/');await refresh();setInterval(()=>refresh().catch(e=>{$('error').textContent=e.message;}),2000);}catch(e){uiError=e.message;$('error').textContent=e.message;}})();
