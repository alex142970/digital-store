alter table products add column featured boolean not null default false;

update products set featured = true where sku not like 'BULK-%';

create index products_featured_idx on products (featured, price) where featured;
