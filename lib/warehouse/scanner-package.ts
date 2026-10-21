import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
export const SCANNER_PACKAGE_FILES = [
  '.gitignore','AGENTS.md','README.md','VALIDATION.md','Install.command','Start Scanner.command','requirements.txt',
  'rift_scanner/__init__.py','rift_scanner/cloud.py','rift_scanner/controller.py','rift_scanner/server.py',
  'rift_scanner/storage.py','rift_scanner/vision.py','rift_scanner/static/app.js','rift_scanner/static/index.html','rift_scanner/static/style.css','tests/test_scanner.py',
] as const;
function crc32(bytes: Buffer): number { let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let b=0;b<8;b++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0; }
/** Minimal deterministic ZIP writer for the explicitly enumerated public source. */
export function scannerZip(files: {name:string;bytes:Buffer}[]):Buffer {
 const entries:Buffer[]=[];const central:Buffer[]=[];let offset=0;
 for(const file of files){
  if(!SCANNER_PACKAGE_FILES.includes(file.name as typeof SCANNER_PACKAGE_FILES[number]))throw new Error('Unlisted source file.');
  const name=Buffer.from('Rift Warehouse Scanner/'+file.name);const bytes=file.bytes;if(bytes.length>1_000_000)throw new Error('Unexpected source size.');
  const packed=deflateRawSync(bytes,{level:9});const crc=crc32(bytes);const header=Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(23892,12);
  header.writeUInt32LE(crc,14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);
  const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(0x314,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(8,10);record.writeUInt16LE(23892,14);
  record.writeUInt32LE(crc,16);record.writeUInt32LE(packed.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(name.length,28);
  record.writeUInt32LE(((file.name.endsWith('.command')?0o100755:0o100644)<<16)>>>0,38);record.writeUInt32LE(offset,42);
  entries.push(header,name,packed);central.push(record,name);offset+=header.length+name.length+packed.length;
 }
 const directory=Buffer.concat(central);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...entries,directory,end]);
}
export async function buildScannerPackage(){const root=path.join(process.cwd(),'companion');const files=await Promise.all(SCANNER_PACKAGE_FILES.map(async name=>({name,bytes:await readFile(path.join(root,name))})));return scannerZip(files);}
