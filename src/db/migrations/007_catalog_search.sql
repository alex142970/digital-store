create extension if not exists pg_trgm;

alter table products
  add column search_text text
  generated always as (lower(name || ' ' || sku || ' ' || type)) stored;

create index products_search_idx on products using gin (search_text gin_trgm_ops);

create index products_price_idx on products (price, sku);

create index license_keys_free_by_sku_idx on license_keys (sku)
  where allocated_order_id is null and order_id is null;
