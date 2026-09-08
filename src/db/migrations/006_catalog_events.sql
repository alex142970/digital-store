create table catalog_events (
  id          bigserial   primary key,
  sku         text        not null references products (sku) on delete cascade,
  kind        text        not null check (kind in ('price', 'stock')),
  occurred_at timestamptz not null default now()
);

create index catalog_events_occurred_idx on catalog_events (occurred_at);

create function catalog_emit(target_sku text, target_kind text) returns void as $$
begin
  insert into catalog_events (sku, kind) values (target_sku, target_kind);
  perform pg_notify('catalog', target_sku);
end;
$$ language plpgsql;

create function catalog_price_changed() returns trigger as $$
begin
  perform catalog_emit(new.sku, 'price');
  return null;
end;
$$ language plpgsql;

create trigger products_price_notify
  after update of price, old_price on products
  for each row
  when (old.price is distinct from new.price or old.old_price is distinct from new.old_price)
  execute function catalog_price_changed();

create function catalog_stock_inserted() returns trigger as $$
declare
  row record;
begin
  for row in
    select distinct sku from new_table
    where allocated_order_id is null and order_id is null
  loop
    perform catalog_emit(row.sku, 'stock');
  end loop;

  return null;
end;
$$ language plpgsql;

create function catalog_stock_deleted() returns trigger as $$
declare
  row record;
begin
  for row in
    select distinct sku from old_table
    where allocated_order_id is null and order_id is null
  loop
    perform catalog_emit(row.sku, 'stock');
  end loop;

  return null;
end;
$$ language plpgsql;

create function catalog_stock_updated() returns trigger as $$
declare
  row record;
begin
  for row in
    select distinct sku from (
      select o.sku
      from old_table o
      join new_table n on n.id = o.id
      where (o.allocated_order_id is null and o.order_id is null)
              is distinct from (n.allocated_order_id is null and n.order_id is null)
         or o.sku is distinct from n.sku
      union
      select n.sku
      from old_table o
      join new_table n on n.id = o.id
      where (o.allocated_order_id is null and o.order_id is null)
              is distinct from (n.allocated_order_id is null and n.order_id is null)
         or o.sku is distinct from n.sku
    ) changed
  loop
    perform catalog_emit(row.sku, 'stock');
  end loop;

  return null;
end;
$$ language plpgsql;

create trigger license_keys_stock_insert
  after insert on license_keys
  referencing new table as new_table
  for each statement
  execute function catalog_stock_inserted();

create trigger license_keys_stock_delete
  after delete on license_keys
  referencing old table as old_table
  for each statement
  execute function catalog_stock_deleted();

create trigger license_keys_stock_update
  after update on license_keys
  referencing old table as old_table new table as new_table
  for each statement
  execute function catalog_stock_updated();
