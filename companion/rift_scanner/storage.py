"""Durable local drafts. No local row is warehouse stock."""
from __future__ import annotations
import hashlib
import json
import re
import sqlite3
import threading
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from .vision import VERSION, eligible, finish

IDENTITY = ('master_id','card_name','set_code','collector_number','finish','language',
            'printing_type','promo_event','markings','physical_key')

def natural_key(value: str):
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r'(\d+)', value)]

def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()

class Store:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        root.chmod(0o700)
        for name in ('originals','previews','features','references'):
            (root/name).mkdir(exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(root/'drafts.sqlite', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS catalogs(version TEXT PRIMARY KEY,payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS assets(key TEXT PRIMARY KEY,status TEXT NOT NULL,error TEXT);
          CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,name TEXT NOT NULL,finish TEXT NOT NULL,
            language TEXT NOT NULL,condition TEXT NOT NULL,version TEXT NOT NULL,created_at TEXT NOT NULL,
            cloud_id TEXT,closed INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS scans(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES batches(id),
            sequence INTEGER NOT NULL,filename TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,
            candidates TEXT NOT NULL DEFAULT '[]',detail TEXT NOT NULL DEFAULT '{}',master_id TEXT,
            manual INTEGER NOT NULL DEFAULT 0,duplicate_ack INTEGER NOT NULL DEFAULT 0,
            cloud_status TEXT,cloud_id TEXT,error TEXT,legacy TEXT,
            UNIQUE(batch_id,sequence),UNIQUE(batch_id,hash));
          CREATE TABLE IF NOT EXISTS learned(scan_id TEXT PRIMARY KEY REFERENCES scans(id),master_id TEXT NOT NULL,
            identity TEXT NOT NULL,finish TEXT NOT NULL,language TEXT NOT NULL);
        ''')
        self.db.commit()
        # Interrupted extraction is retryable. Upload IDs are already durable.
        self.db.execute("UPDATE scans SET state='queued' WHERE state='processing'")
        self.db.commit()

    def rows(self, sql: str, params=()) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, params).fetchall()]

    def run(self, sql: str, params=()) -> None:
        with self.lock, self.db:
            self.db.execute(sql, params)

    def get(self, key: str, default=None):
        rows = self.rows('SELECT value FROM settings WHERE key=?',(key,))
        return json.loads(rows[0]['value']) if rows else default

    def set(self,key: str,value) -> None:
        self.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                 (key,json.dumps(value)))

    def catalog(self,version=None) -> dict:
        version = version or self.get('active_catalog')
        rows = self.rows('SELECT payload FROM catalogs WHERE version=?',(version,))
        if not rows:
            raise ValueError('Download the Mastersheet once before receiving cards')
        return json.loads(rows[0]['payload'])

    def save_catalog(self,manifest: dict) -> None:
        version, cards = manifest.get('version',''), manifest.get('cards',[])
        if not re.fullmatch(r'[a-f0-9]{64}',version) or not 0<len(cards)<=15000:
            raise ValueError('Invalid catalog manifest')
        ids = [c.get('master_id') for c in cards]
        if len(set(ids)) != len(ids) or not all(isinstance(i,str) and i for i in ids):
            raise ValueError('Invalid catalog identities')
        self.run('INSERT INTO catalogs VALUES(?,?) ON CONFLICT(version) DO UPDATE SET payload=excluded.payload',
                 (version,json.dumps(manifest)))
        self.set('active_catalog',version)

    def new_batch(self,finish_value: str,language='EN',condition='NM',name='') -> dict:
        if finish_value not in ('Foil','Nonfoil') or condition not in ('NM','LP','MP','HP','DMG'):
            raise ValueError('Choose foil/non-foil and a valid condition')
        if language not in ('EN','SC','KR','FR'):
            raise ValueError('Choose a supported language')
        catalog = self.catalog()
        now = datetime.now(ZoneInfo('America/Los_Angeles'))
        day=now.strftime('%Y%m%d')
        number=len(self.rows('SELECT id FROM batches WHERE created_at LIKE ?',(now.strftime('%Y-%m-%d')+'%',)))+1
        name=name.strip() or f"MAC-{day}-{'F' if finish_value=='Foil' else 'NF'}-{number:03d}"
        if len(name)>250:
            raise ValueError('Batch name is too long')
        row = dict(id=str(uuid.uuid4()),name=name,finish=finish_value,language=language,
                   condition=condition,version=catalog['version'],created_at=now.isoformat())
        self.run('INSERT INTO batches(id,name,finish,language,condition,version,created_at) VALUES(?,?,?,?,?,?,?)',
                 tuple(row.values()))
        self.set('working_batch',row['id'])
        return self.batch(row['id'])

    def batch(self,id=None) -> dict:
        rows=self.rows('SELECT * FROM batches WHERE id=?',(id or self.get('working_batch'),))
        if not rows:
            raise ValueError('Create or choose a working batch')
        return rows[0]

    def scan(self,id: str) -> dict:
        rows=self.rows('SELECT * FROM scans WHERE id=?',(id,))
        if not rows: raise ValueError('Scan not found')
        r=rows[0]
        for key in ('candidates','detail','legacy'):
            r[key]=json.loads(r[key]) if r[key] else None
        return r

    def add_scan(self,batch_id: str,filename: str,data: bytes,preview_bytes: bytes) -> str:
        batch=self.batch(batch_id)
        if batch['closed']:
            raise ValueError('Batch is closed for receiving')
        digest=hashlib.sha256(data).hexdigest()
        with self.lock:
            exists=self.rows('SELECT id FROM scans WHERE batch_id=? AND hash=?',(batch_id,digest))
            if exists: return exists[0]['id']
            seq=self.rows('SELECT count(*) n FROM scans WHERE batch_id=?',(batch_id,))[0]['n']+1
            if seq>500: raise ValueError('Create another batch after 500 scans')
            id=str(uuid.uuid4())
            # Immutable source bytes; never modify the Epson's source file.
            (self.root/'originals'/id).write_bytes(data)
            (self.root/'previews'/(id+'.jpg')).write_bytes(preview_bytes)
            self.run('INSERT INTO scans(id,batch_id,sequence,filename,hash,state) VALUES(?,?,?,?,?,?)',
                     (id,batch_id,seq,Path(filename).name[:250],digest,'queued'))
        return id

    def select(self,id: str,master_id: str,ack=False) -> None:
        scan=self.scan(id);batch=self.batch(scan['batch_id'])
        if scan['cloud_id']:
            raise ValueError('This scan is synchronized. Correct it in Warehouse OS.')
        cards=self.catalog(batch['version'])['cards']
        card=next((c for c in cards if c['master_id']==master_id),None)
        if not card or not eligible(card) or finish(card['finish'])!=batch['finish'] or card['language']!=batch['language']:
            raise ValueError('Select an eligible exact printing for this finish and language')
        duplicates=self.rows("SELECT id FROM scans WHERE hash=? AND id<>? AND state<>'excluded'",(scan['hash'],id))
        if duplicates and not ack: raise ValueError('Confirm that this is another physical copy, not a repeat test')
        identity={k:card.get(k,'') for k in IDENTITY}
        with self.lock,self.db:
            self.db.execute("UPDATE scans SET state='manual',master_id=?,manual=1,duplicate_ack=?,error=NULL WHERE id=?",(master_id,int(bool(ack)),id))
            self.db.execute('INSERT INTO learned VALUES(?,?,?,?,?) ON CONFLICT(scan_id) DO UPDATE SET master_id=excluded.master_id,identity=excluded.identity,finish=excluded.finish,language=excluded.language',
                            (id,master_id,json.dumps(identity),batch['finish'],batch['language']))

    def exclude(self,id: str) -> None:
        if self.scan(id)['cloud_id']: raise ValueError('Correct synchronized cards in Warehouse OS')
        with self.lock,self.db:
            self.db.execute("UPDATE scans SET state='excluded',manual=0 WHERE id=?",(id,))
            self.db.execute('DELETE FROM learned WHERE scan_id=?',(id,))

    def snapshot(self) -> dict:
        batches=self.rows('SELECT * FROM batches ORDER BY created_at DESC')
        selected=self.get('working_batch')
        scans=self.rows('SELECT * FROM scans WHERE batch_id=? ORDER BY sequence',(selected,))
        for r in scans:
            r['candidates']=json.loads(r['candidates']);r['detail']=json.loads(r['detail'])
            r.pop('legacy',None)
        try: catalog=self.catalog()
        except ValueError: catalog={'cards':[]}
        return dict(batches=batches,workingBatch=selected,scans=scans,
                    catalogVersion=self.get('active_catalog'),catalogCount=len(catalog['cards']),
                    watchFolder=self.get('watch_folder',''),connected=bool(self.get('device_id')))
