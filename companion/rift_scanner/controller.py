from __future__ import annotations
import base64
import json
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from .storage import Store, IDENTITY, fingerprint, natural_key
from .vision import Feature, VERSION, compare, decode, eligible, extract, finish, preview
from .cloud import Cloud, CredentialStore, CloudError

def settled_files(folder: Path, seen: dict, stable: dict, now: float) -> list[Path]:
    """Only release a natural-order prefix; never pass a still-saving earlier scan."""
    pending=[]
    for file in sorted(folder.iterdir(),key=lambda p:natural_key(p.name)):
        if file.is_symlink() or not file.is_file() or file.suffix.lower() not in ('.jpg','.jpeg','.png','.webp'):
            continue
        stat=file.stat();stamp=[stat.st_size,stat.st_mtime_ns]
        if seen.get(str(file))==stamp:
            stable.pop(str(file),None)
            continue
        last=stable.get(str(file))
        if not last or last[0]!=stamp:
            stable[str(file)]=(stamp,now)
        pending.append((file,stamp))
    ready=[]
    for file,stamp in pending:
        if now-stable[str(file)][1]<2:
            break
        ready.append(file)
    return ready

class Scanner:
    def __init__(self,root: Path,cloud=None):
        self.store=Store(root)
        self.credentials=CredentialStore()
        self.cloud=cloud or Cloud(self.credentials)
        self.executor=ThreadPoolExecutor(max_workers=1,thread_name_prefix='rw-native')
        self.cache: OrderedDict[str,Feature]=OrderedDict()
        self.stop_event=threading.Event()
        self.activity='Ready';self.error='';self.busy=False;self.watching=False
        self.guard=threading.RLock()
        self.watcher=threading.Thread(target=self.watch_loop,daemon=True,name='rw-watch')
        self.watcher.start()

    def job(self,label: str,fn):
        with self.guard:
            if self.busy: raise ValueError('Let the current task finish first')
            self.busy=True;self.error='';self.activity=label
        def work():
            try: fn()
            except Exception as e: self.error=str(e)[:350]
            finally:
                with self.guard: self.busy=False;self.activity='Ready'
        self.executor.submit(work)

    def connect(self,token: str):
        info=self.cloud.request('status',token=token)
        previous=self.store.get('device_id')
        if previous and previous!=info['deviceId']:
            raise ValueError('Use Renew key on the same cloud device entry. Switching device IDs could duplicate earlier batches.')
        self.credentials.save(token)
        self.store.set('device_id',info['deviceId'])
        self.store.set('cloud_batches',info.get('batches',[]))

    def refresh(self):
        manifest=self.cloud.request('manifest')
        previous=self.store.get('device_id')
        if previous and previous!=manifest['deviceId']: raise ValueError('Device identity changed; reconnect the original device')
        self.store.save_catalog(manifest)
        # Cloud ledger replaces previously synchronized local training labels.
        self.store.run('DELETE FROM learned WHERE scan_id IN (SELECT id FROM scans WHERE cloud_id IS NOT NULL)')
        self.index(manifest)

    def feature_path(self,key: str): return self.store.root/'features'/(fingerprint(VERSION+key)+'.npz')

    def cached_feature(self,key: str,data=None) -> Feature:
        hit=self.cache.pop(key,None)
        if hit is not None: self.cache[key]=hit;return hit
        path=self.feature_path(key)
        if path.exists():
            try: feature=Feature.load(path)
            except Exception:
                if data is None: raise
                feature=extract(data);feature.save(path)
        else:
            if data is None: raise ValueError('Reference is not cached')
            feature=extract(data);feature.save(path)
        if len(self.cache)>=48: self.cache.popitem(last=False)
        self.cache[key]=feature
        return feature

    def index(self,manifest=None):
        manifest=manifest or self.store.catalog()
        refs=manifest.get('references',[])
        for n,ref in enumerate(refs):
            if self.stop_event.is_set(): return
            self.activity=f"Preparing reference {n+1:,}/{len(refs):,}"
            key=ref['key'];path=self.feature_path(key)
            try:
                cached=False
                if path.exists():
                    try: self.cached_feature(key);cached=True
                    except Exception: pass
                if not cached:
                    params={'version':manifest['version'],'id':ref['id']}
                    data=self.cloud.request('learned-image' if ref['kind']=='human' else 'reference',params,binary=True)
                    decode(data)
                    (self.store.root/'references'/fingerprint(key)).write_bytes(data)
                    self.cached_feature(key,data)
                self.store.run("INSERT INTO assets VALUES(?,'ready',NULL) ON CONFLICT(key) DO UPDATE SET status='ready',error=NULL",(key,))
            except CloudError as e:
                if e.status in (401,403) or e.status==0:
                    raise
                self.store.run("INSERT INTO assets VALUES(?,'unavailable',?) ON CONFLICT(key) DO UPDATE SET status='unavailable',error=excluded.error",(key,str(e)[:200]))
            except Exception as e:
                self.store.run("INSERT INTO assets VALUES(?,'unavailable',?) ON CONFLICT(key) DO UPDATE SET status='unavailable',error=excluded.error",(key,str(e)[:200]))
        self.store.set('index_updated_at',time.time())

    def add_paths(self,paths: list[Path],batch_id=None):
        batch=self.store.batch(batch_id)
        for path in sorted(paths,key=lambda p:natural_key(p.name)):
            if path.is_symlink() or not path.is_file(): continue
            if path.suffix.lower() not in ('.jpg','.jpeg','.png','.webp'): continue
            before=path.stat()
            if before.st_size>12_000_000: raise ValueError(f'{path.name}: image exceeds 12 MB')
            data=path.read_bytes();after=path.stat()
            if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):
                raise ValueError(f'{path.name}: file is still being written')
            self.store.add_scan(batch['id'],path.name,data,preview(data))
        self.process_pending(batch['id'])

    def pool(self,batch: dict,query_id: str):
        manifest=self.store.catalog(batch['version'])
        cards={c['master_id']:c for c in manifest['cards'] if eligible(c)
               and finish(c['finish'])==batch['finish'] and c['language']==batch['language']}
        groups={}
        for ref in manifest.get('references',[]):
            card=cards.get(ref['masterId'])
            if not card: continue
            groups.setdefault(ref['key'],{'ids':[],'kind':ref['kind']})['ids'].append(card['master_id'])
        for label in self.store.rows('SELECT * FROM learned WHERE scan_id<>?',(query_id,)):
            card=cards.get(label['master_id'])
            if card and json.loads(label['identity'])=={k:card.get(k,'') for k in IDENTITY}:
                groups['local:'+label['scan_id']]={'ids':[card['master_id']],'kind':'human'}
        return cards,groups

    def recognize(self,id: str):
        scan=self.store.scan(id);batch=self.store.batch(scan['batch_id'])
        self.store.run("UPDATE scans SET state='processing',error=NULL WHERE id=?",(id,))
        try:
            data=(self.store.root/'originals'/id).read_bytes()
            feature=self.cached_feature('local:'+id,data)
            cards,groups=self.pool(batch,id)
            best={};examined=0;missing=[];started=time.monotonic()
            # Accuracy-first: compare all cached eligible images, not a color shortlist.
            for key,group in groups.items():
                if self.stop_event.is_set(): raise ValueError('Paused before completion; recheck this draft')
                self.activity=f"Card {scan['sequence']} · detailed comparison {examined+1}/{len(groups)}"
                try:
                    original=None
                    if key.startswith('local:'):
                        original=(self.store.root/'originals'/key.split(':',1)[1]).read_bytes()
                    reference=self.cached_feature(key,original)
                    evidence=compare(feature,reference)
                except Exception:
                    missing.extend(group['ids']);continue
                examined+=1
                if evidence['inliers']<4: continue
                for master in group['ids']:
                    candidate={'masterId':master,'name':cards[master]['card_name'],'evidence':group['kind'],
                               'referenceKey':key,'shared':len(set(group['ids']))>1,**evidence}
                    if master not in best or candidate['score']>best[master]['score']:
                        best[master]=candidate
            candidates=sorted(best.values(),key=lambda c:(c['verified'],c['score'],c['inliers']),reverse=True)[:5]
            reason='No geometrically verified match. Choose the exact printing or rescan.'
            ready=False
            if candidates:
                top=candidates[0]
                covered={i for g in groups.values() for i in g['ids']}
                related_missing=any(c['card_name']==cards[top['masterId']]['card_name'] and
                                   (i not in covered or i in missing) for i,c in cards.items())
                if top['verified'] and top['score']>=.90:
                    if top['shared']: reason='Printings share the same image. Select the exact variant.'
                    elif len(candidates)>1 and top['score']-candidates[1]['score']<.035: reason='Two detailed matches are too close.'
                    elif related_missing: reason='A related printing lacks a usable reference.'
                    else: ready=True;reason='Strong local suggestion. Cloud verification is required before automatic approval.'
            duplicate=bool(self.store.rows("SELECT id FROM scans WHERE id<>? AND hash=? AND state<>'excluded'",(id,scan['hash'])))
            if duplicate: ready=False;reason='Repeated image. Confirm another physical copy before manual approval.'
            detail=dict(version=VERSION,quality=feature.quality,examined=examined,missing=len(missing),
                        elapsedMs=round((time.monotonic()-started)*1000),reason=reason)
            self.store.run('UPDATE scans SET state=?,candidates=?,detail=?,error=NULL WHERE id=?',
                           ('ready' if ready else 'review',json.dumps(candidates),json.dumps(detail),id))
        except Exception as e:
            self.store.run("UPDATE scans SET state='review',error=? WHERE id=?",(str(e)[:250],id))

    def process_pending(self,batch_id=None):
        rows=self.store.rows("SELECT id FROM scans WHERE batch_id=? AND state='queued' ORDER BY sequence",
                             (batch_id or self.store.get('working_batch'),))
        for row in rows: self.recognize(row['id'])

    def recheck(self):
        batch=self.store.batch()
        for row in self.store.rows("SELECT id FROM scans WHERE batch_id=? AND manual=0 AND cloud_id IS NULL AND state<>'excluded' ORDER BY sequence",(batch['id'],)):
            self.recognize(row['id'])

    def sync(self,signatures: dict):
        batch=self.store.batch()
        scans=self.store.rows("SELECT id FROM scans WHERE batch_id=? AND state<>'excluded' ORDER BY sequence",(batch['id'],))
        if not scans: raise ValueError('No scans to synchronize')
        if self.store.rows("SELECT id FROM scans WHERE batch_id=? AND state IN ('queued','processing')",(batch['id'],)):
            raise ValueError('Finish recognition or recheck queued scans before synchronizing')
        created=self.cloud.request('create-batch',body={'localBatchId':batch['id'],'name':batch['name'],
                    'finish':batch['finish'],'language':batch['language'],'condition':batch['condition'],
                    'catalogVersion':batch['version']})
        self.store.run('UPDATE batches SET cloud_id=? WHERE id=?',(created['batch']['id'],batch['id']))
        for n,row in enumerate(scans):
            scan=self.store.scan(row['id'])
            if scan['cloud_id']: continue
            self.activity=f"Synchronizing {n+1}/{len(scans)} · cloud validation"
            legacy=scan['legacy'] or signatures.get(scan['id'])
            if not isinstance(legacy,dict) or legacy.get('algorithm')!='rw-advisory-grid-v1' or len(legacy.get('values',[]))!=192:
                raise ValueError('Browser image signature missing; retry using the local Sync button')
            self.store.run('UPDATE scans SET legacy=? WHERE id=?',(json.dumps(legacy),scan['id']))
            body={'localBatchId':batch['id'],'localScanId':scan['id'],'filename':scan['filename'],
                  'sha256':scan['hash'],'signature':legacy,'catalogVersion':batch['version'],
                  'image':'data:image/jpeg;base64,'+base64.b64encode((self.store.root/'previews'/(scan['id']+'.jpg')).read_bytes()).decode(),
                  'manual':bool(scan['manual']),'masterId':scan['master_id'],
                  'duplicateAcknowledged':bool(scan['duplicate_ack'])}
            result=self.cloud.request('sync-scan',body=body)
            cloud_scan=result['scan']
            self.store.run("UPDATE scans SET state='synced',cloud_status=?,cloud_id=?,error=NULL WHERE id=?",
                           (cloud_scan['status'],cloud_scan['id'],scan['id']))
        self.store.set('last_sync',time.time())

    def set_watch(self,path: str,include_existing=False):
        folder=Path(path).expanduser().resolve(strict=True)
        if not folder.is_dir(): raise ValueError('Choose a scan folder')
        self.store.batch()
        seen={}
        if not include_existing:
            for file in folder.iterdir():
                if file.is_file() and not file.is_symlink():
                    st=file.stat();seen[str(file)]=[st.st_size,st.st_mtime_ns]
        self.store.set('watch_folder',str(folder));self.store.set('watch_seen',seen)
        self.watching=True

    def watch_loop(self):
        stable={}
        while not self.stop_event.wait(1):
            try:
                if not self.watching or self.busy: continue
                folder=Path(self.store.get('watch_folder',''))
                if not folder.is_dir(): self.watching=False;continue
                seen=self.store.get('watch_seen',{})
                ready=settled_files(folder,seen,stable,time.monotonic())
                if ready:
                    batch_id=self.store.batch()['id']
                    def accept(files=ready,target=batch_id):
                        for f in files:
                            try:
                                before=f.stat();stamp=[before.st_size,before.st_mtime_ns]
                                self.add_paths([f],target)
                                stored=self.store.get('watch_seen',{});stored[str(f)]=stamp
                                self.store.set('watch_seen',stored)
                            except Exception as e:
                                self.watching=False;raise ValueError(f'{f.name}: {e}') from e
                    self.job('Receiving Epson files',accept)
            except Exception as e:
                self.error=str(e)[:250];self.watching=False

    def snapshot(self):
        result=self.store.snapshot()
        result.update(busy=self.busy,activity=self.activity,error=self.error,watching=self.watching,
                      nativeVersion=VERSION,indexUpdated=self.store.get('index_updated_at'),
                      lastSync=self.store.get('last_sync'))
        return result

    def close(self):
        self.watching=False;self.stop_event.set()
        self.executor.shutdown(wait=False,cancel_futures=True)
