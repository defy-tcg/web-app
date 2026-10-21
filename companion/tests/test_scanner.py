import hashlib
import http.client
import io
import json
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
import numpy as np
from PIL import Image, ImageDraw
from rift_scanner.vision import extract, compare, preview, decode, Feature, VERSION
from rift_scanner.storage import Store, natural_key
from rift_scanner.controller import Scanner, settled_files
from rift_scanner.cloud import Cloud, CredentialStore, CloudError, NoRedirect
from rift_scanner.server import LocalServer

V='a'*64
CARD=dict(master_id='card-a',card_name='Test Card',set_code='OGN',collector_number='001a/298',finish='Foil',language='EN',inventory_eligible='1',inventory_count_weight='1',release_status='released',physical_key='printing-a',image_is_exact='1')
def manifest():
    return dict(protocol=1,deviceId='11111111-1111-1111-1111-111111111111',version=V,cards=[CARD,{**CARD,'master_id':'card-b','card_name':'Other','physical_key':'printing-b'}],references=[])
def picture(seed=7):
    rng=np.random.default_rng(seed);im=Image.new('RGB',(630,880),'#f5f3e5');draw=ImageDraw.Draw(im)
    for _ in range(220):
        x,y=rng.integers(12,610),rng.integers(12,860);r=int(rng.integers(3,14))
        draw.ellipse((x-r,y-r,x+r,y+r),fill=tuple(int(v) for v in rng.integers(0,180,3)))
    out=io.BytesIO();im.save(out,'PNG');return out.getvalue()

class VisionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.bytes=picture();cls.f=extract(cls.bytes)
    def test_detailed_features_retained(self):
        self.assertEqual(self.f.gray.shape,(880,630));self.assertGreater(len(self.f.points),100);self.assertLessEqual(len(self.f.points),1800)
    def test_same_image_geometrically_verified(self):
        result=compare(self.f,self.f);self.assertTrue(result['verified']);self.assertGreater(result['score'],.99);json.dumps(result,allow_nan=False)
    def test_different_artwork_rejected(self): self.assertFalse(compare(self.f,extract(picture(22)))['verified'])
    def test_rotation_identifies(self):
        im=decode(self.bytes).rotate(180);o=io.BytesIO();im.save(o,'PNG');r=compare(extract(o.getvalue()),self.f)
        self.assertTrue(r['verified']);self.assertGreater(r['inliers'],28)
    def test_blank_is_never_verified(self):
        o=io.BytesIO();Image.new('RGB',(630,880),'white').save(o,'PNG');f=extract(o.getvalue());self.assertFalse(compare(f,f)['verified'])
    def test_invalid_and_large_rejected(self):
        for b in [b'bad',b'x'*12000001]:
            with self.assertRaises(ValueError):decode(b)
    def test_cache_roundtrip_without_pickle(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'test.npz';self.f.save(p);again=Feature.load(p);self.assertTrue(compare(self.f,again)['verified'])
    def test_preview_is_jpeg(self): self.assertTrue(preview(self.bytes).startswith(b'\xff\xd8\xff'))

class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.s=Store(Path(self.tmp.name));self.s.save_catalog(manifest());self.b=self.s.new_batch('Foil');self.data=picture();self.p=preview(self.data)
    def tearDown(self):self.s.db.close();self.tmp.cleanup()
    def add(self,name='scan1.png',data=None):return self.s.add_scan(self.b['id'],name,data or self.data,self.p)
    def test_new_batch_working_and_finish_required(self):
        self.assertEqual(self.s.get('working_batch'),self.b['id']);self.assertTrue(self.b['name'].startswith('MAC-'))
        with self.assertRaises(ValueError):self.s.new_batch('')
    def test_exact_duplicate_does_not_create_second_copy(self):
        a=self.add();self.assertEqual(a,self.add('renamed.png'));self.assertEqual(len(self.s.snapshot()['scans']),1)
    def test_natural_order(self):self.assertEqual(sorted(['scan10.jpg','scan2.jpg','scan1.jpg'],key=natural_key),['scan1.jpg','scan2.jpg','scan10.jpg'])
    def test_sequence_and_original_preserved(self):
        a=self.add();b=self.add('scan2.png',picture(8));self.assertEqual([x['sequence'] for x in self.s.snapshot()['scans']],[1,2]);self.assertEqual((self.s.root/'originals'/a).read_bytes(),self.data);self.assertNotEqual(a,b)
    def test_manual_confirmation_replaces_learning(self):
        a=self.add();self.s.select(a,'card-a');self.s.select(a,'card-b');r=self.s.rows('SELECT * FROM learned');self.assertEqual(len(r),1);self.assertEqual(r[0]['master_id'],'card-b')
    def test_excluding_removes_learning(self):
        a=self.add();self.s.select(a,'card-a');self.s.exclude(a);self.assertEqual(self.s.rows('SELECT * FROM learned'),[])
    def test_unavailable_or_wrong_finish_rejected(self):
        a=self.add()
        with self.assertRaises(ValueError):self.s.select(a,'missing')
        self.s.run("UPDATE batches SET finish='Nonfoil' WHERE id=?",(self.b['id'],))
        with self.assertRaises(ValueError):self.s.select(a,'card-a')
    def test_cross_batch_duplicate_needs_ack(self):
        self.add();other=self.s.new_batch('Foil');b=self.s.add_scan(other['id'],'again.png',self.data,self.p)
        with self.assertRaises(ValueError):self.s.select(b,'card-a')
        self.s.select(b,'card-a',True);self.assertEqual(self.s.scan(b)['state'],'manual')
    def test_synced_cannot_be_corrected_locally(self):
        a=self.add();self.s.run('UPDATE scans SET cloud_id=? WHERE id=?',('cloud-a',a))
        with self.assertRaises(ValueError):self.s.select(a,'card-b')
    def test_restart_recovers_processing_draft(self):
        a=self.add();self.s.run("UPDATE scans SET state='processing' WHERE id=?",(a,));other=Store(self.s.root);self.assertEqual(other.scan(a)['state'],'queued');other.db.close()

class FakeCloud:
    def __init__(self):self.calls=[];self.received={};self.fail_after=False
    def request(self,action,params=None,body=None,**kw):
        self.calls.append((action,body))
        if action=='create-batch':return {'batch':{'id':'cloud-batch'}}
        if action=='sync-scan':
            key=body['localScanId'];self.received.setdefault(key,{'id':'cloud-'+key,'status':'approved' if body['manual'] else 'review'})
            if self.fail_after:self.fail_after=False;raise CloudError('Lost response')
            return {'scan':self.received[key]}
        return manifest()

class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.cloud=FakeCloud();self.a=Scanner(Path(self.tmp.name)/'data',self.cloud);self.a.store.save_catalog(manifest());self.b=self.a.store.new_batch('Foil')
    def tearDown(self):self.a.close();self.a.executor.shutdown(wait=True);self.a.store.db.close();self.tmp.cleanup()
    def add(self):
        p=Path(self.tmp.name)/'scan.png';p.write_bytes(picture());self.a.add_paths([p]);return self.a.store.snapshot()['scans'][0]['id']
    def test_missing_reference_remains_review(self):
        id=self.add();self.assertEqual(self.a.store.scan(id)['state'],'review');self.assertEqual(self.cloud.calls,[])
    def test_same_batch_reimport_is_idempotent(self):
        self.add();self.add();self.assertEqual(len(self.a.store.snapshot()['scans']),1)
    def test_local_learning_changes_future_match(self):
        first=self.add();self.a.store.select(first,'card-a');p=Path(self.tmp.name)/'scan2.png';im=decode(picture());im.save(p,'JPEG',quality=92);self.a.add_paths([p]);rows=self.a.store.snapshot()['scans'];self.assertEqual(rows[1]['candidates'][0]['masterId'],'card-a');self.assertEqual(rows[1]['candidates'][0]['evidence'],'human')
    def test_lost_cloud_ack_reuses_identical_id_and_source(self):
        id=self.add();sig={'algorithm':'rw-advisory-grid-v1','values':[100]*192};self.cloud.fail_after=True
        with self.assertRaises(CloudError):self.a.sync({id:sig})
        self.assertIsNone(self.a.store.scan(id)['cloud_id']);self.a.sync({id:sig});self.assertEqual(len(self.cloud.received),1);self.assertEqual(self.a.store.scan(id)['state'],'synced')
    def test_native_ready_not_sent_as_manual_or_autoapproval(self):
        id=self.add();self.a.store.run("UPDATE scans SET state='ready' WHERE id=?",(id,));self.a.sync({id:{'algorithm':'rw-advisory-grid-v1','values':[100]*192}})
        sent=[body for action,body in self.cloud.calls if action=='sync-scan'][0];self.assertFalse(sent['manual']);self.assertNotIn('vision',sent);self.assertEqual(self.a.store.scan(id)['cloud_status'],'review')
    def test_manual_choice_is_explicit(self):
        id=self.add();self.a.store.select(id,'card-a');self.a.sync({id:{'algorithm':'rw-advisory-grid-v1','values':[100]*192}});self.assertEqual(self.a.store.scan(id)['cloud_status'],'approved')
    def test_symlink_is_not_received(self):
        p=Path(self.tmp.name)/'original.png';p.write_bytes(picture());link=Path(self.tmp.name)/'link.png';link.symlink_to(p);self.a.add_paths([link]);self.assertEqual(self.a.store.snapshot()['scans'],[])
    def test_folder_watch_ignores_existing_unless_requested(self):
        folder=Path(self.tmp.name)/'watch';folder.mkdir();p=folder/'one.png';p.write_bytes(picture());self.a.set_watch(str(folder));self.a.watching=False;self.assertIn(str(p),self.a.store.get('watch_seen'));self.assertEqual(p.read_bytes(),picture())

class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.a=Scanner(Path(self.tmp.name),FakeCloud());self.server=LocalServer(self.a);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.port=self.server.server_address[1]
    def tearDown(self):self.server.shutdown();self.server.server_close();self.a.close();self.a.executor.shutdown(wait=True);self.a.store.db.close();self.tmp.cleanup()
    def req(self,path='/api/state',method='GET',body=None,headers=None):
        c=http.client.HTTPConnection('127.0.0.1',self.port);h=headers or {};raw=json.dumps(body) if body is not None else None
        if raw:h={**h,'Content-Type':'application/json'}
        c.request(method,path,raw,h);r=c.getresponse();data=r.read();result=(r.status,dict(r.getheaders()),data);c.close();return result
    def login(self):
        status,h,data=self.req('/session','POST',{'key':self.server.launch_key});self.assertEqual(status,200);return h['Set-Cookie'].split(';')[0],json.loads(data)['csrf']
    def test_anonymous_inventory_forbidden(self):self.assertEqual(self.req()[0],401)
    def test_cross_origin_forbidden(self):self.assertEqual(self.req(headers={'Origin':'https://evil.test'})[0],403)
    def test_dns_rebinding_host_forbidden(self):self.assertEqual(self.req(headers={'Host':'evil.test'})[0],403)
    def test_bad_launch_secret_forbidden(self):self.assertEqual(self.req('/session','POST',{'key':'wrong'})[0],401)
    def test_session_and_csrf_required(self):
        cookie,csrf=self.login();self.assertEqual(self.req(headers={'Cookie':cookie})[0],200)
        self.assertEqual(self.req('/api/action','POST',{'action':'stop-watch'},{'Cookie':cookie})[0],403)
        self.assertEqual(self.req('/api/action','POST',{'action':'stop-watch'},{'Cookie':cookie,'X-RW-CSRF':csrf})[0],200)
    def test_no_image_path_traversal(self):
        cookie,_=self.login();self.assertEqual(self.req('/api/image?id=../../secret',headers={'Cookie':cookie})[0],400)
    def test_plaintext_credential_fallback_refused(self):
        token='rwsc_'+str(uuid.uuid4())+'.'+'a'*43
        with patch('rift_scanner.cloud.sys.platform','linux'):
            with self.assertRaises(ValueError):CredentialStore().save(token)

if __name__=='__main__': unittest.main()


class WatchOrderTests(unittest.TestCase):
    def test_later_file_cannot_pass_unsettled_earlier_file(self):
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root);one=folder/'scan_1.jpg';two=folder/'scan_2.jpg'
            one.write_bytes(b'partial');two.write_bytes(b'complete')
            st=two.stat();stable={str(two):([st.st_size,st.st_mtime_ns],0)}
            self.assertEqual(settled_files(folder,{},stable,10),[])
            self.assertEqual(settled_files(folder,{},stable,12),[one,two])
    def test_changed_file_restarts_stability_timer(self):
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root);one=folder/'scan_1.png';one.write_bytes(b'part');stable={}
            self.assertEqual(settled_files(folder,{},stable,1),[])
            one.write_bytes(b'more bytes')
            self.assertEqual(settled_files(folder,{},stable,4),[])
            self.assertEqual(settled_files(folder,{},stable,6),[one])
    def test_seen_files_do_not_block_new_intake(self):
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root);one=folder/'scan_1.jpg';two=folder/'scan_2.jpg'
            one.write_bytes(b'one');two.write_bytes(b'two');st=one.stat()
            seen={str(one):[st.st_size,st.st_mtime_ns]};stable={}
            settled_files(folder,seen,stable,1)
            self.assertEqual(settled_files(folder,seen,stable,3),[two])
