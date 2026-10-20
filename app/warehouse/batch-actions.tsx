'use client';
/* eslint-disable @next/next/no-img-element -- Warehouse photos use authenticated scan endpoints. */
import { useState } from 'react';
import { formatAddress, type Batch, type Unit } from '@/lib/warehouse/model';
import './batch-actions.css';

export function BatchRename({ batch, busy, rename }: { batch: Batch; busy: boolean; rename: (name: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(batch.name);
  return <div className="rw-batch-name"><strong>{batch.name}</strong>{batch.code && <small>Batch code: {batch.code}</small>}
    {!editing ? <button disabled={busy} onClick={() => { setName(batch.name); setEditing(true); }}>Rename batch</button> :
      <form className="rw-form" onSubmit={e => { e.preventDefault(); void rename(name).then(saved => { if (saved) setEditing(false); }); }}>
        <label>New batch name<input maxLength={250} required value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
        <button disabled={busy || !name.trim()}>Save batch name</button>
        <button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel rename</button>
      </form>}
  </div>;
}
export function WarehousePhoto({ unit, compact = false }: { unit: Unit; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  const url = `/api/warehouse?image=${encodeURIComponent(unit.scanId)}`;
  return failed ? <span className="rw-photo-unavailable">Photo unavailable · {unit.serial}</span> :
    <a className={compact ? 'rw-unit-photo' : 'rw-batch-photo'} href={url} target="_blank" rel="noreferrer" title={`Open scan of ${unit.card.card_name}`}>
      <img loading="lazy" decoding="async" src={url} width={compact ? 48 : 128} height={compact ? 67 : 179}
        alt={`Scan of ${unit.card.card_name} · ${unit.serial}`} onError={() => setFailed(true)} />
    </a>;
}
export function BatchPutaway({ batches, units, batchId, busy, select, confirm }: {
  batches: Batch[]; units: Unit[]; batchId: string; busy: boolean;
  select: (id: string) => void; confirm: (id: string, serials: string[]) => void;
}) {
  const finalized = [...batches].reverse().filter(b => b.status === 'finalized');
  const selected = finalized.find(b => b.id === batchId) || finalized.find(b => units.some(u => u.batchId === b.id && u.status === 'awaiting_putaway')) || finalized[0];
  const copies = units.filter(u => u.batchId === selected?.id).sort((a,b) => a.serial.localeCompare(b.serial));
  const pending = copies.filter(u => u.status === 'awaiting_putaway');
  return <section className="rw-panel rw-batch-putaway"><div className="rw-section-title"><div><h2>Batch putaway</h2>
    <p className="rw-note">Check the scan photos and assigned locations, then confirm the whole batch once.</p></div></div>
    <div className="rw-form"><label className="grow">Putaway batch<select value={selected?.id || ''} disabled={busy || !finalized.length} onChange={e => select(e.target.value)}>
      {!finalized.length && <option value="">No finalized batches yet</option>}
      {finalized.map(b => <option key={b.id} value={b.id}>{b.name} · {units.filter(u => u.batchId === b.id && u.status === 'awaiting_putaway').length} awaiting putaway</option>)}
    </select></label>
    <button className="primary" disabled={busy || !selected || !pending.length} onClick={() => {
      if (selected && window.confirm(`Confirm all ${pending.length} awaiting-putaway cards in ${selected.name} are physically placed at the locations shown? Already available, reserved, shipped, or quarantined cards will not change.`))
        confirm(selected.id, pending.map(u => u.serial));
    }}>Confirm entire batch putaway{pending.length ? ` (${pending.length})` : ''}</button></div>
    {selected && <p role="status" className="rw-note">{pending.length ? `${pending.length} cards awaiting putaway` : 'No cards in this batch are awaiting putaway'} · {copies.length} total copies. Only awaiting-putaway cards are confirmed.</p>}
    <div className="rw-putaway-photos">{copies.map(unit => <article key={unit.serial} className="rw-putaway-card">
      <WarehousePhoto unit={unit}/><strong>{unit.card.card_name}</strong><small>{unit.card.set_code} {unit.card.collector_number} · {unit.card.finish}/{unit.card.language}/{unit.condition}</small>
      <code>{unit.serial}</code><code>{formatAddress(unit.address)}</code><span className="rw-badge">{unit.status === 'available' ? 'Put away · available' : unit.status.replaceAll('_',' ')}</span>
    </article>)}</div>
    {!selected && <p className="rw-note">Finalize a reviewed batch to see its photos and placement instructions here.</p>}
  </section>;
}
