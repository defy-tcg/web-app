"""Loopback-only UI with launch-secret authentication and CSRF protection."""
from __future__ import annotations
import argparse
import fcntl
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import urllib.parse
import webbrowser
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from .controller import Scanner

STATIC=Path(__file__).parent/'static'

class LocalServer(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,scanner,port=0):
        self.scanner=scanner;self.launch_key=secrets.token_urlsafe(32)
        self.session_key=secrets.token_urlsafe(32);self.csrf=secrets.token_urlsafe(32)
        super().__init__(('127.0.0.1',port),Handler)
        self.origin=f'http://127.0.0.1:{self.server_address[1]}'

class Handler(BaseHTTPRequestHandler):
    server: LocalServer
    def log_message(self,*args): pass  # Never log keys, image bodies or private paths.
    def reply(self,status,body,content_type='application/json',headers=None):
        raw=(json.dumps(body,allow_nan=False).encode() if content_type=='application/json' else body)
        self.send_response(status)
        self.send_header('Content-Type',content_type)
        self.send_header('Content-Length',str(len(raw)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        for k,v in (headers or {}).items(): self.send_header(k,v)
        self.end_headers();self.wfile.write(raw)
    def safe_request(self):
        if self.headers.get('Host')!=self.server.origin.removeprefix('http://'): return False
        origin=self.headers.get('Origin')
        return not origin or origin==self.server.origin
    def authenticated(self):
        try:
            cookie=SimpleCookie(self.headers.get('Cookie',''))
            return hmac.compare_digest(cookie['rw_session'].value,self.server.session_key)
        except (KeyError,ValueError): return False
    def do_GET(self):
        if not self.safe_request(): return self.reply(403,{'error':'Local origin required'})
        url=urllib.parse.urlsplit(self.path);query=urllib.parse.parse_qs(url.query)
        static={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}
        if url.path in static:
            file=STATIC/static[url.path];kind={'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8'}[file.suffix[1:]]
            return self.reply(200,file.read_bytes(),kind)
        if not self.authenticated(): return self.reply(401,{'error':'Open the scanner from its launcher'})
        try:
            if url.path=='/api/state': return self.reply(200,self.server.scanner.snapshot())
            if url.path=='/api/catalog':
                version=query.get('version',[None])[0]
                return self.reply(200,self.server.scanner.store.catalog(version))
            if url.path=='/api/image':
                id=query.get('id',[''])[0]
                if not re.fullmatch(r'[0-9a-f-]{36}',id): raise ValueError('Invalid image ID')
                self.server.scanner.store.scan(id)
                root=self.server.scanner.store.root
                if query.get('original')==['1']:
                    data=(root/'originals'/id).read_bytes()
                    kind='image/png' if data.startswith(b'\x89PNG') else 'image/webp' if data[:4]==b'RIFF' else 'image/jpeg'
                else: data=(root/'previews'/(id+'.jpg')).read_bytes();kind='image/jpeg'
                return self.reply(200,data,kind)
            return self.reply(404,{'error':'Not found'})
        except Exception as e: return self.reply(400,{'error':str(e)[:350]})
    def do_POST(self):
        if not self.safe_request(): return self.reply(403,{'error':'Local origin required'})
        if self.headers.get('Content-Type','').split(';')[0]!='application/json': return self.reply(415,{'error':'JSON required'})
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=500_000: return self.reply(413,{'error':'Request too large'})
            data=json.loads(self.rfile.read(size))
            if not isinstance(data,dict): raise ValueError('Invalid request')
            if self.path=='/session':
                if not hmac.compare_digest(str(data.get('key','')),self.server.launch_key):
                    return self.reply(401,{'error':'Launch the scanner again'})
                return self.reply(200,{'csrf':self.server.csrf},headers={
                    'Set-Cookie':f'rw_session={self.server.session_key}; HttpOnly; SameSite=Strict; Path=/'})
            if not self.authenticated() or not hmac.compare_digest(self.headers.get('X-RW-CSRF',''),self.server.csrf):
                return self.reply(403,{'error':'Local session required'})
            app=self.server.scanner
            if self.path!='/api/action': return self.reply(404,{'error':'Not found'})
            action=data.get('action')
            if action=='stop-watch': app.watching=False;return self.reply(200,{'ok':True})
            if action=='shutdown':
                self.reply(200,{'ok':True});app.close()
                threading.Thread(target=self.server.shutdown,daemon=True).start();return
            if app.busy: raise ValueError('Let the current task finish first')
            if action=='connect': app.job('Connecting device',lambda:app.connect(str(data.get('token','')).strip()))
            elif action=='refresh': app.job('Downloading saved catalog',app.refresh)
            elif action=='index': app.job('Resuming reference preparation',app.index)
            elif action=='new-batch':
                app.watching=False
                batch=app.store.new_batch(str(data.get('finish','')),str(data.get('language','EN')),str(data.get('condition','NM')),str(data.get('name','')))
                return self.reply(200,batch)
            elif action=='select-batch':
                app.watching=False;app.store.batch(str(data['id']));app.store.set('working_batch',data['id'])
            elif action=='rename':
                batch=app.store.batch();name=str(data.get('name','')).strip()
                if batch['cloud_id']: raise ValueError('Rename synchronized batches in Warehouse OS')
                if not name or len(name)>250: raise ValueError('Use a name of 1–250 characters')
                app.store.run('UPDATE batches SET name=? WHERE id=?',(name,batch['id']))
            elif action=='approve': app.store.select(str(data['id']),str(data['masterId']),data.get('ack') is True)
            elif action=='exclude': app.store.exclude(str(data['id']))
            elif action=='recheck': app.job('Rechecking local drafts',lambda:(app.process_pending(),app.recheck()))
            elif action=='sync':
                app.watching=False
                signatures=data.get('signatures',{})
                if not isinstance(signatures,dict): raise ValueError('Invalid signatures')
                app.job('Synchronizing draft batch',lambda:app.sync(signatures))
            elif action=='choose-folder':
                if sys.platform!='darwin': raise ValueError('Enter a folder path on this test system')
                result=subprocess.run(['osascript','-e','POSIX path of (choose folder with prompt "Choose the Epson scan output folder")'],capture_output=True,text=True,timeout=120)
                if result.returncode: raise ValueError('Folder selection cancelled')
                return self.reply(200,{'path':result.stdout.strip()})
            elif action=='watch': app.set_watch(str(data.get('path','')),data.get('includeExisting') is True)
            else: raise ValueError('Unknown scanner action')
            return self.reply(200,{'ok':True})
        except Exception as e: return self.reply(400,{'error':str(e)[:350]})

def main():
    parser=argparse.ArgumentParser(description='Native Rift Warehouse scanning companion')
    parser.add_argument('--data-dir',type=Path,default=Path.home()/'Library/Application Support/Rift Warehouse Scanner/data')
    parser.add_argument('--no-browser',action='store_true')
    args=parser.parse_args();os.umask(0o077)
    args.data_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
    lock=(args.data_dir/'scanner.lock').open('a')
    try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        instance=args.data_dir/'instance.json'
        if instance.exists() and not args.no_browser: webbrowser.open(json.loads(instance.read_text())['url'])
        return
    app=Scanner(args.data_dir);server=LocalServer(app)
    url=server.origin+'/#'+server.launch_key
    instance=args.data_dir/'instance.json';instance.write_text(json.dumps({'url':url}));instance.chmod(0o600)
    print('Rift Warehouse Scanner is running locally. Close it with Stop scanner in the interface.',flush=True)
    if not args.no_browser: webbrowser.open(url)
    try: server.serve_forever(poll_interval=.3)
    except KeyboardInterrupt: pass
    finally:
        app.close();server.server_close();instance.unlink(missing_ok=True);lock.close()

if __name__=='__main__': main()
