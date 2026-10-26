-- Additive baseline, 2026-10-25. The existing public, Shopify, account, and
-- retired scanner schemas are unchanged. Apply on an isolated branch first.
CREATE SCHEMA IF NOT EXISTS defy_bulk;
CREATE TABLE IF NOT EXISTS defy_bulk.warehouses (
  id uuid PRIMARY KEY, owner_id text NOT NULL, workspace text NOT NULL
    CHECK (workspace IN ('riftbound','mtg','pokemon')), name text NOT NULL,
  ack_sequence bigint NOT NULL DEFAULT 0 CHECK (ack_sequence >= 0),
  last_synced_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS defy_bulk.events (
  warehouse_id uuid NOT NULL REFERENCES defy_bulk.warehouses(id),
  sequence bigint NOT NULL CHECK (sequence > 0), event_hash text NOT NULL,
  event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(warehouse_id, sequence)
);
CREATE INDEX IF NOT EXISTS bulk_events_entity_idx ON defy_bulk.events(warehouse_id,(event->>'entityId'),sequence DESC);
CREATE TABLE IF NOT EXISTS defy_bulk.copies (
  warehouse_id uuid NOT NULL REFERENCES defy_bulk.warehouses(id), copy_id text NOT NULL,
  sequence bigint NOT NULL, data jsonb, deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(warehouse_id,copy_id)
);
CREATE INDEX IF NOT EXISTS bulk_copies_status_idx ON defy_bulk.copies(warehouse_id,deleted,((data->>'available')::boolean));
CREATE TABLE IF NOT EXISTS defy_bulk.orders (
  warehouse_id uuid NOT NULL REFERENCES defy_bulk.warehouses(id), order_id text NOT NULL,
  sequence bigint NOT NULL, data jsonb, deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(warehouse_id,order_id)
);
CREATE INDEX IF NOT EXISTS bulk_orders_status_idx ON defy_bulk.orders(warehouse_id,deleted,(data->>'status'));
CREATE TABLE IF NOT EXISTS defy_bulk.commands (
  id uuid PRIMARY KEY, warehouse_id uuid NOT NULL REFERENCES defy_bulk.warehouses(id),
  actor_id text NOT NULL, body_hash text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','rejected')),
  message text NOT NULL DEFAULT 'Waiting for Warehouse Manager.', receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bulk_commands_pending_idx ON defy_bulk.commands(warehouse_id,status,created_at);
CREATE TABLE IF NOT EXISTS defy_bulk.holds (
  warehouse_id uuid NOT NULL, copy_id text NOT NULL,
  command_id uuid NOT NULL REFERENCES defy_bulk.commands(id),
  PRIMARY KEY(warehouse_id,copy_id)
);
CREATE TABLE IF NOT EXISTS defy_bulk.sales (
  id text PRIMARY KEY, warehouse_id uuid NOT NULL REFERENCES defy_bulk.warehouses(id),
  command_id uuid NOT NULL UNIQUE REFERENCES defy_bulk.commands(id),
  native_order_id text,
  sold_at timestamptz NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE defy_bulk.sales ADD COLUMN IF NOT EXISTS native_order_id text;
CREATE INDEX IF NOT EXISTS bulk_sales_date_idx ON defy_bulk.sales(sold_at DESC,id);
CREATE UNIQUE INDEX IF NOT EXISTS bulk_native_order_sale_unique ON defy_bulk.sales(warehouse_id,native_order_id) WHERE native_order_id IS NOT NULL;

-- Fulfillment timestamps are never sales dates. A shipped native order remains
-- unpriced unless an actual recorded sale matches its exact command and copies.
CREATE OR REPLACE VIEW defy_bulk.unpriced_native_orders AS
  SELECT o.warehouse_id,o.order_id,o.data,o.updated_at
  FROM defy_bulk.orders o
  WHERE NOT o.deleted AND o.data->>'status'='shipped' AND jsonb_array_length(o.data->'copyIds')>0
    AND NOT EXISTS (SELECT 1 FROM defy_bulk.sales s WHERE s.warehouse_id=o.warehouse_id AND s.native_order_id=o.order_id)
    AND NOT EXISTS (
      SELECT 1 FROM defy_bulk.commands c JOIN defy_bulk.sales s ON s.command_id=c.id AND s.warehouse_id=c.warehouse_id
      WHERE c.warehouse_id=o.warehouse_id AND c.id::text=o.data->>'storeCommandId'
        AND c.payload->>'kind'='sale' AND c.status='applied'
        AND ARRAY(SELECT value FROM jsonb_array_elements_text(o.data->'copyIds') ORDER BY value)
          = ARRAY(SELECT value->>'copyId' FROM jsonb_array_elements(c.payload->'copies') ORDER BY value->>'copyId')
    );

CREATE OR REPLACE FUNCTION defy_bulk.queue_command(p_actor text,p_body jsonb,p_hash text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  w defy_bulk.warehouses%ROWTYPE; old defy_bulk.commands%ROWTYPE;
  c defy_bulk.copies%ROWTYPE; line jsonb; snapshots jsonb := '[]'::jsonb;
  fail text; cid uuid := (p_body->>'requestId')::uuid;
BEGIN
  -- Serialize a source's projection, command holds, and receipts together.
  PERFORM pg_advisory_xact_lock(hashtext('defy-bulk:'||(p_body->>'warehouseId')));
  SELECT * INTO w FROM defy_bulk.warehouses WHERE id=(p_body->>'warehouseId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='bulk:warehouse_missing'; END IF;
  SELECT * INTO old FROM defy_bulk.commands WHERE id=cid;
  IF FOUND THEN
    IF old.body_hash<>p_hash OR old.actor_id<>p_actor OR old.warehouse_id<>w.id THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='bulk:request_conflict';
    END IF;
    RETURN jsonb_build_object('id',old.id,'status',old.status,'message',old.message);
  END IF;
  IF (SELECT count(*) FROM defy_bulk.commands WHERE warehouse_id=w.id AND status='pending')>=500 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='bulk:queue_full';
  END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(p_body->'copies') LOOP
    SELECT * INTO c FROM defy_bulk.copies WHERE warehouse_id=w.id AND copy_id=line->>'copyId';
    IF NOT FOUND OR c.deleted OR c.data->>'fingerprint' IS DISTINCT FROM line->>'expectedFingerprint'
      OR c.data->>'available' IS DISTINCT FROM 'true' THEN
      fail := 'A selected card changed or is unavailable. Refresh inventory and select again.'; EXIT;
    END IF;
    IF EXISTS(SELECT 1 FROM defy_bulk.holds WHERE warehouse_id=w.id AND copy_id=c.copy_id) THEN
      fail := 'A selected card already has a pending action. Wait for Warehouse Manager.'; EXIT;
    END IF;
    snapshots := snapshots||jsonb_build_array(jsonb_build_object('copyId',c.copy_id,'sequence',c.sequence,'data',c.data));
  END LOOP;
  INSERT INTO defy_bulk.commands(id,warehouse_id,actor_id,body_hash,payload,status,message)
    VALUES(cid,w.id,p_actor,p_hash,p_body||jsonb_build_object('snapshots',snapshots),
      CASE WHEN fail IS NULL THEN 'pending' ELSE 'rejected' END,
      COALESCE(fail,'Waiting for Warehouse Manager to confirm the selected cards.'));
  IF fail IS NULL THEN
    INSERT INTO defy_bulk.holds(warehouse_id,copy_id,command_id)
      SELECT w.id,value->>'copyId',cid FROM jsonb_array_elements(p_body->'copies');
  END IF;
  RETURN jsonb_build_object('id',cid,'status',CASE WHEN fail IS NULL THEN 'pending' ELSE 'rejected' END,
    'message',COALESCE(fail,'Waiting for Warehouse Manager to confirm the selected cards.'));
END $$;

-- Recording an existing native fulfillment order's actual proceeds is financial
-- only. Its immutable receipt uses the command journal but is never sent to Mac.
CREATE OR REPLACE FUNCTION defy_bulk.record_order_sale(p_actor text,p_body jsonb,p_hash text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  wid uuid := (p_body->>'warehouseId')::uuid; cid uuid := (p_body->>'requestId')::uuid;
  oid text := p_body->>'orderId'; old defy_bulk.commands%ROWTYPE; ord defy_bulk.orders%ROWTYPE;
  linked defy_bulk.commands%ROWTYPE; fail text; sale jsonb := p_body->'sale'; invoice jsonb;
  subtotal bigint; discount bigint; tax bigint; costs bigint; unknowncost boolean;
  copies integer; saleid text; number text; item jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('defy-bulk:'||wid::text));
  PERFORM 1 FROM defy_bulk.warehouses WHERE id=wid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='bulk:order_warehouse_missing'; END IF;
  SELECT * INTO old FROM defy_bulk.commands WHERE id=cid;
  IF FOUND THEN
    IF old.body_hash<>p_hash OR old.actor_id<>p_actor OR old.warehouse_id<>wid OR old.payload->>'kind' IS DISTINCT FROM 'record_order_sale' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='bulk:request_conflict';
    END IF;
    SELECT data INTO invoice FROM defy_bulk.sales WHERE command_id=old.id;
    RETURN jsonb_build_object('id',old.id,'status',old.status,'message',old.message,'saleId',invoice->>'id','saleNumber',invoice->>'saleNumber');
  END IF;
  SELECT * INTO ord FROM defy_bulk.orders WHERE warehouse_id=wid AND order_id=oid FOR UPDATE;
  IF NOT FOUND OR ord.deleted THEN
    fail := 'This native order is no longer available. Refresh the order list.';
  ELSIF ord.data->>'status'<>'shipped' OR jsonb_array_length(ord.data->'copyIds')=0 THEN
    fail := 'Only a shipped native order containing physical copies can have its amount recorded here.';
  ELSIF ord.data->>'fingerprint' IS DISTINCT FROM p_body->>'expectedFingerprint'
    OR ARRAY(SELECT value FROM jsonb_array_elements_text(ord.data->'copyIds') ORDER BY value)
      <> ARRAY(SELECT value FROM jsonb_array_elements_text(p_body->'copyIds') ORDER BY value) THEN
    fail := 'This native order changed after you reviewed it. Refresh and review its current copies.';
  ELSIF EXISTS(SELECT 1 FROM defy_bulk.sales WHERE warehouse_id=wid AND native_order_id=oid) THEN
    fail := 'An amount has already been recorded for this native order. Refresh to view the existing sale.';
  ELSE
    SELECT * INTO linked FROM defy_bulk.commands c
      WHERE c.warehouse_id=wid AND c.id::text=ord.data->>'storeCommandId' AND c.payload->>'kind'='sale'
        AND ARRAY(SELECT value FROM jsonb_array_elements_text(ord.data->'copyIds') ORDER BY value)
          = ARRAY(SELECT value->>'copyId' FROM jsonb_array_elements(c.payload->'copies') ORDER BY value->>'copyId');
    IF FOUND AND (linked.status<>'rejected' OR EXISTS(SELECT 1 FROM defy_bulk.sales WHERE command_id=linked.id)) THEN
      fail := CASE WHEN linked.status='pending' THEN 'A priced Store OS sale is already waiting for Warehouse Manager confirmation. Wait for that request to finish.'
        ELSE 'This native order already has a priced Store OS sale. Refresh to view the existing sale.' END;
    END IF;
  END IF;
  INSERT INTO defy_bulk.commands(id,warehouse_id,actor_id,body_hash,payload,status,message)
    VALUES(cid,wid,p_actor,p_hash,p_body||jsonb_build_object('kind','record_order_sale'),
      CASE WHEN fail IS NULL THEN 'applied' ELSE 'rejected' END,
      COALESCE(fail,'Actual native order amount recorded. Physical stock was not changed.'));
  IF fail IS NOT NULL THEN
    RETURN jsonb_build_object('id',cid,'status','rejected','message',fail);
  END IF;
  subtotal := (sale->>'subtotalCents')::bigint; discount := (sale->>'discountCents')::bigint;
  tax := (sale->>'taxCents')::bigint; costs := (sale->>'totalCostCents')::bigint; unknowncost := costs IS NULL;
  copies := jsonb_array_length(ord.data->'copyIds'); saleid := 'bulk-order:'||wid::text||':'||oid;
  number := 'BW-N-'||upper(left(replace(cid::text,'-',''),12));
  item := jsonb_build_object('id',saleid||':total','saleId',saleid,'productId',NULL,
    'productName','Native order '||COALESCE(NULLIF(ord.data->>'reference',''),oid),'sku','',
    'quantity',copies,'unitPriceCents',NULL,'unitCostCents',NULL,
    'lineSubtotalCents',subtotal,'lineCostCents',COALESCE(costs,0),'discountCents',discount,'taxCents',tax,
    'costIncomplete',unknowncost,'aggregate',true,'inventorySource','bulk_warehouse',
    'warehouseId',wid,'nativeOrderId',oid,'copyIds',ord.data->'copyIds');
  invoice := jsonb_build_object('id',saleid,'saleNumber',number,'channel',sale->>'channel','paymentMethod',sale->>'paymentMethod',
    'subtotalCents',subtotal,'discountCents',discount,'taxCents',tax,'totalCents',subtotal-discount+tax,
    'cogsCents',COALESCE(costs,0),'costIncomplete',unknowncost,'itemsCount',copies,'note',p_body->>'note',
    'soldAt',sale->>'soldAt','inventorySource','bulk_warehouse','items',jsonb_build_array(item),
    'warehouseId',wid,'nativeOrderId',oid,'nativeOrderSequence',ord.sequence,'nativeOrderSnapshot',ord.data);
  INSERT INTO defy_bulk.sales(id,warehouse_id,command_id,native_order_id,sold_at,data)
    VALUES(saleid,wid,cid,oid,(sale->>'soldAt')::timestamptz,invoice);
  RETURN jsonb_build_object('id',cid,'status','applied','saleId',saleid,'saleNumber',number,
    'message','Actual native order amount recorded. Physical stock was not changed.');
END $$;

CREATE OR REPLACE FUNCTION defy_bulk.apply_sync(p_owner text,p_body jsonb,p_hashes jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  wid uuid := (p_body->>'warehouseId')::uuid; w defy_bulk.warehouses%ROWTYPE;
  cmd defy_bulk.commands%ROWTYPE; e jsonb; r jsonb; snapshot jsonb; observed jsonb;
  seq bigint; ack bigint; hash text; previous text; receiptseq bigint;
  matched boolean; allmatched boolean; idx integer; amount integer; cost integer;
  costs bigint; totalcopies integer; subtotal integer; discount integer; tax integer;
  unitprice integer; unknowncost boolean; lines jsonb; sale jsonb; saleid text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('defy-bulk:'||wid::text));
  INSERT INTO defy_bulk.warehouses(id,owner_id,workspace,name)
    VALUES(wid,p_owner,p_body->>'workspace',p_body->>'name') ON CONFLICT(id) DO NOTHING;
  SELECT * INTO w FROM defy_bulk.warehouses WHERE id=wid FOR UPDATE;
  -- This deployment is one store. Every approved native account can operate
  -- the same persisted warehouse; switching staff never creates another stock pool.
  IF w.workspace<>p_body->>'workspace' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='bulk:source_conflict';
  END IF;
  ack := w.ack_sequence;
  IF (p_body->>'after')::bigint>ack THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='bulk:sequence_gap';
  END IF;
  idx := 0;
  FOR e IN SELECT value FROM jsonb_array_elements(p_body->'events') LOOP
    seq := (e->>'sequence')::bigint; hash := p_hashes->>idx; idx := idx+1;
    IF seq<=ack THEN
      SELECT event_hash INTO previous FROM defy_bulk.events WHERE warehouse_id=wid AND sequence=seq;
      IF previous IS DISTINCT FROM hash THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='bulk:replay_conflict';
      END IF;
      CONTINUE;
    END IF;
    IF seq<>ack+1 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='bulk:sequence_gap'; END IF;
    INSERT INTO defy_bulk.events(warehouse_id,sequence,event_hash,event) VALUES(wid,seq,hash,e||jsonb_build_object('_actorId',p_owner));
    IF e->>'kind' IN ('copy','delete') THEN
      INSERT INTO defy_bulk.copies(warehouse_id,copy_id,sequence,data,deleted)
        VALUES(wid,e->>'entityId',seq,e->'data',e->>'kind'='delete')
        ON CONFLICT(warehouse_id,copy_id) DO UPDATE SET sequence=EXCLUDED.sequence,
          data=EXCLUDED.data,deleted=EXCLUDED.deleted,updated_at=now();
    ELSIF e->>'kind' IN ('order','order_delete') THEN
      INSERT INTO defy_bulk.orders(warehouse_id,order_id,sequence,data,deleted)
        VALUES(wid,e->>'entityId',seq,e->'data',e->>'kind'='order_delete')
        ON CONFLICT(warehouse_id,order_id) DO UPDATE SET sequence=EXCLUDED.sequence,
          data=EXCLUDED.data,deleted=EXCLUDED.deleted,updated_at=now();
    ELSE
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='bulk:unsupported_event';
    END IF;
    ack := seq;
  END LOOP;
  UPDATE defy_bulk.warehouses SET ack_sequence=ack,name=p_body->>'name',last_synced_at=now() WHERE id=wid;
  FOR r IN SELECT value FROM jsonb_array_elements(p_body->'receipts') LOOP
    SELECT * INTO cmd FROM defy_bulk.commands WHERE id=(r->>'commandId')::uuid AND warehouse_id=wid FOR UPDATE;
    IF NOT FOUND OR COALESCE(cmd.payload->>'kind','') NOT IN ('remove','sale') THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='bulk:unknown_receipt'; END IF;
    IF cmd.receipt IS NOT NULL AND cmd.receipt<>r THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='bulk:receipt_conflict';
    END IF;
    IF cmd.status='rejected' AND cmd.receipt IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='bulk:unexpected_receipt';
    END IF;
    UPDATE defy_bulk.commands SET receipt=r WHERE id=cmd.id;
  END LOOP;
  FOR cmd IN SELECT * FROM defy_bulk.commands WHERE warehouse_id=wid AND status='pending' AND receipt IS NOT NULL ORDER BY created_at,id FOR UPDATE LOOP
    r := cmd.receipt; receiptseq := (r->>'appliedSequence')::bigint;
    IF receiptseq>ack THEN CONTINUE; END IF;
    IF r->>'status'='rejected' THEN
      UPDATE defy_bulk.commands SET status='rejected',message=COALESCE(NULLIF(r->>'message',''),'Warehouse Manager rejected the changed card selection.'),updated_at=now() WHERE id=cmd.id;
      DELETE FROM defy_bulk.holds WHERE command_id=cmd.id;
      CONTINUE;
    END IF;
    allmatched := receiptseq>0;
    FOR snapshot IN SELECT value FROM jsonb_array_elements(cmd.payload->'snapshots') LOOP
      SELECT event INTO observed FROM defy_bulk.events WHERE warehouse_id=wid
        AND event->>'entityId'=snapshot->>'copyId' AND event->>'kind' IN ('copy','delete') AND sequence<=(receiptseq)
        AND sequence>(snapshot->>'sequence')::bigint ORDER BY sequence DESC LIMIT 1;
      matched := FOUND AND (observed->>'kind'='delete' OR observed->'data'->>'available'='false');
      allmatched := allmatched AND COALESCE(matched,false);
    END LOOP;
    IF NOT allmatched THEN
      UPDATE defy_bulk.commands SET message='Waiting for the matching stock update from Warehouse Manager.' WHERE id=cmd.id;
      CONTINUE;
    END IF;
    IF cmd.payload->>'kind'='sale' THEN
      sale := cmd.payload->'sale'; totalcopies := jsonb_array_length(cmd.payload->'snapshots');
      unitprice := (sale->>'unitPriceCents')::integer; subtotal := unitprice*totalcopies;
      discount := (sale->>'discountCents')::integer; tax := (sale->>'taxCents')::integer;
      costs := 0; unknowncost := false; lines := '[]'::jsonb; idx := 0; saleid := 'bulk:'||cmd.id::text;
      FOR snapshot IN SELECT value FROM jsonb_array_elements(cmd.payload->'snapshots') LOOP
        cost := COALESCE((sale->>'unitCostCents')::integer,(snapshot->'data'->>'costCents')::integer);
        IF cost IS NULL THEN unknowncost := true; END IF;
        costs := costs+COALESCE(cost,0);
        amount := discount/totalcopies+CASE WHEN idx<(discount%totalcopies) THEN 1 ELSE 0 END;
        lines := lines||jsonb_build_array(jsonb_build_object(
          'id',saleid||':'||md5(snapshot->>'copyId'),'saleId',saleid,'productId',NULL,
          'warehouseId',wid,'copyId',snapshot->>'copyId','productName',snapshot->'data'->>'name',
          'sku',snapshot->'data'->>'sku','quantity',1,'unitPriceCents',unitprice,
          'unitCostCents',COALESCE(cost,0),'costIncomplete',cost IS NULL,
          'discountCents',amount,'taxCents',tax/totalcopies+CASE WHEN idx<(tax%totalcopies) THEN 1 ELSE 0 END,
          'inventorySource','bulk_warehouse'));
        idx := idx+1;
      END LOOP;
      INSERT INTO defy_bulk.sales(id,warehouse_id,command_id,sold_at,data) VALUES(saleid,wid,cmd.id,(sale->>'soldAt')::timestamptz,
        jsonb_build_object('id',saleid,'saleNumber','BW-'||upper(left(cmd.id::text,8)),
          'channel',sale->>'channel','paymentMethod',sale->>'paymentMethod','subtotalCents',subtotal,
          'discountCents',discount,'taxCents',tax,'totalCents',subtotal-discount+tax,
          'cogsCents',costs,'itemsCount',totalcopies,'note',cmd.payload->>'note','soldAt',sale->>'soldAt',
          'inventorySource','bulk_warehouse','costIncomplete',unknowncost,'items',lines))
        ON CONFLICT(command_id) DO NOTHING;
    END IF;
    UPDATE defy_bulk.commands SET status='applied',message=COALESCE(NULLIF(r->>'message',''),'Confirmed by Warehouse Manager.'),updated_at=now() WHERE id=cmd.id;
    DELETE FROM defy_bulk.holds WHERE command_id=cmd.id;
  END LOOP;
  RETURN jsonb_build_object('ackSequence',ack,'serverTime',now(),
    'commands',COALESCE((SELECT jsonb_agg(item ORDER BY created_at,id) FROM (
      SELECT id,created_at,(payload-'snapshots'-'requestId')||jsonb_build_object('id',id) AS item
      FROM defy_bulk.commands WHERE warehouse_id=wid AND status='pending' AND receipt IS NULL ORDER BY created_at,id LIMIT 20) pending),'[]'::jsonb),
    'receipts',COALESCE((SELECT jsonb_agg(jsonb_build_object('commandId',id,'status',status)) FROM defy_bulk.commands
      WHERE warehouse_id=wid AND receipt IS NOT NULL AND id IN (SELECT (value->>'commandId')::uuid FROM jsonb_array_elements(p_body->'receipts'))),'[]'::jsonb));
END $$;

-- These functions are invoked only by authenticated server handlers, never by
-- browser/Data API roles. Keep the database owner's existing privileges.
REVOKE ALL ON SCHEMA defy_bulk FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA defy_bulk FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA defy_bulk FROM PUBLIC;
