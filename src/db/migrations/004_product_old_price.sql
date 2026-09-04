alter table products add column old_price integer;

alter table products add constraint products_old_price_above_price
  check (old_price is null or old_price > price);
