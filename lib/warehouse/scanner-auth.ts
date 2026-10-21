import { neon } from '@neondatabase/serverless';
import { issueScannerKey, matchesScannerKey, parseScannerKey, scannerId, SCANNER_TOKEN_DAYS } from './scanner-policy.ts';
import { initializeWarehouse } from './store.ts';
export type ScannerDevice = {id:string; name:string; owner_id:string; owner_email:string; expires_at:string; revoked_at:string|null; created_at:string};
function db() { const url=process.env.WAREHOUSE_DATABASE_URL||process.env.DATABASE_URL;if(!url)throw new Error('Warehouse database is not configured.');return neon(url); }
let init:Promise<void>|undefined;
export async function initializeScannerDevices() {
  if(!init)init=(async()=>{await initializeWarehouse();const sql=db();await sql`CREATE TABLE IF NOT EXISTS rift_warehouse.scanner_devices (
    id uuid PRIMARY KEY, name text NOT NULL, owner_id text NOT NULL, owner_email text NOT NULL,
    token_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL, revoked_at timestamptz)`;})().catch(e=>{init=undefined;throw e;});
  return init;
}
export async function listScannerDevices(owner:string) {
  await initializeScannerDevices();const sql=db();return sql`SELECT id,name,created_at,expires_at,revoked_at FROM rift_warehouse.scanner_devices WHERE owner_id=${owner} ORDER BY created_at DESC`;
}
export async function createScannerDevice(owner:string,email:string,name:string,renewId?:string) {
  if(!name.trim()||name.length>80)throw new Error('Use a device name of 1–80 characters.');
  await initializeScannerDevices();const sql=db();
  if(!renewId){const count=await sql`SELECT count(*) AS count FROM rift_warehouse.scanner_devices WHERE owner_id=${owner} AND revoked_at IS NULL AND expires_at>now()`;if(Number(count[0].count)>=10)throw new Error('Revoke or renew an existing scanner connection first.');}
  const issued=issueScannerKey(renewId?scannerId(renewId):undefined);
  const expires=new Date(Date.now()+SCANNER_TOKEN_DAYS*86400000).toISOString();
  if(renewId){const rows=await sql`UPDATE rift_warehouse.scanner_devices SET token_hash=${issued.hash},name=${name.trim()},expires_at=${expires}::timestamptz,revoked_at=NULL WHERE id=${issued.id}::uuid AND owner_id=${owner} RETURNING id`;if(!rows.length)throw new Error('Device not found.');}
  else await sql`INSERT INTO rift_warehouse.scanner_devices(id,name,owner_id,owner_email,token_hash,expires_at) VALUES(${issued.id}::uuid,${name.trim()},${owner},${email},${issued.hash},${expires}::timestamptz)`;
  return {id:issued.id,token:issued.token,expiresAt:expires};
}
export async function revokeScannerDevice(owner:string,id:string) {
  scannerId(id);await initializeScannerDevices();const sql=db();
  await sql`UPDATE rift_warehouse.scanner_devices SET revoked_at=now() WHERE id=${id}::uuid AND owner_id=${owner}`;
}
export async function authenticateScanner(header:string|null,allowed:(email:string)=>boolean):Promise<ScannerDevice|null> {
  const parsed=parseScannerKey(header);if(!parsed)return null;
  await initializeScannerDevices();const sql=db();const rows=await sql`SELECT * FROM rift_warehouse.scanner_devices WHERE id=${parsed.id}::uuid AND revoked_at IS NULL AND expires_at>now()`;
  const device=rows[0];if(!device||!allowed(String(device.owner_email))||!matchesScannerKey(parsed.token,String(device.token_hash)))return null;
  return {id:String(device.id),name:String(device.name),owner_id:String(device.owner_id),owner_email:String(device.owner_email),expires_at:String(device.expires_at),revoked_at:null,created_at:String(device.created_at)};
}
