"""Scoped device key; no cloud password or database credential on the Mac."""
from __future__ import annotations
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = 'https://defy-store-os.vercel.app'
SERVICE = 'com.defytcg.rift-warehouse-scanner'
TOKEN_PATTERN = r'rwsc_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}'

class CloudError(Exception):
    def __init__(self,message: str,status=0):
        super().__init__(message);self.status=status

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        raise CloudError('Unexpected redirect. Check the Warehouse OS connection.',code)

class CredentialStore:
    """macOS Keychain only. Never silently falls back to plaintext files."""
    def __init__(self): self.memory: str|None=None
    def get(self) -> str|None:
        if self.memory: return self.memory
        if sys.platform!='darwin': return None
        from keyring.backends.macOS import Keyring
        return Keyring().get_password(SERVICE,BASE_URL)
    def save(self,token: str) -> None:
        if not re.fullmatch(TOKEN_PATTERN,token): raise ValueError('Invalid scanner device key')
        if sys.platform!='darwin':
            raise ValueError('Persistent device-key storage is supported on macOS Keychain only')
        from keyring.backends.macOS import Keyring
        Keyring().set_password(SERVICE,BASE_URL,token)
        self.memory=token
    def forget(self) -> None:
        if sys.platform=='darwin':
            from keyring.backends.macOS import Keyring
            try: Keyring().delete_password(SERVICE,BASE_URL)
            except Exception: pass
        self.memory=None

class Cloud:
    def __init__(self,credentials: CredentialStore, opener=None):
        self.credentials=credentials
        self.opener=opener or urllib.request.build_opener(NoRedirect())
    def request(self,action: str,params: dict|None=None,body: dict|None=None, binary=False,token=None):
        params={'action':action,**(params or {})}
        key=token or self.credentials.get()
        if not key: raise CloudError('Connect a scanner key from Warehouse OS first',401)
        url=BASE_URL+'/api/warehouse-companion?'+urllib.parse.urlencode(params)
        headers={'Authorization':'Bearer '+key,'Accept':'application/json','User-Agent':'RiftScanner/0.1.0'}
        data=None
        if body is not None:
            data=json.dumps(body,allow_nan=False).encode();headers['Content-Type']='application/json'
        req=urllib.request.Request(url,data=data,headers=headers)
        try:
            with self.opener.open(req,timeout=330 if body is not None else 35) as response:
                limit=3_500_000 if binary else 12_000_000
                result=response.read(limit+1)
                if len(result)>limit: raise CloudError('Cloud response exceeded safe size')
                content_type=response.headers.get('Content-Type','')
                if binary:
                    if not content_type.startswith('image/'): raise CloudError('Expected a reference image')
                    return result
                if 'application/json' not in content_type: raise CloudError('Cloud API unavailable; sign-in or deployment needs attention')
                return json.loads(result)
        except urllib.error.HTTPError as e:
            try: message=json.loads(e.read(2000)).get('error','Cloud request failed')
            except Exception: message='Cloud request failed'
            raise CloudError(message,e.code) from None
        except (urllib.error.URLError,TimeoutError,OSError):
            raise CloudError('Connection interrupted. Local drafts are safe; retry synchronization.') from None
