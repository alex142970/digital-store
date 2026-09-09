alter table products add column in_stock boolean not null default false;

update products p
set in_stock = exists (
  select 1 from license_keys k
  where k.sku = p.sku and k.allocated_order_id is null and k.order_id is null
);

create index products_in_stock_idx on products (in_stock, price, sku);

create or replace function catalog_emit(target_sku text, target_kind text) returns void as $$
begin
  if target_kind = 'stock' then
    update products p
    set in_stock = exists (
      select 1 from license_keys k
      where k.sku = p.sku and k.allocated_order_id is null and k.order_id is null
    )
    where p.sku = target_sku
      and p.in_stock is distinct from exists (
        select 1 from license_keys k
        where k.sku = p.sku and k.allocated_order_id is null and k.order_id is null
      );
  end if;

  insert into catalog_events (sku, kind) values (target_sku, target_kind);
  perform pg_notify('catalog', target_sku);
end;
$$ language plpgsql;
