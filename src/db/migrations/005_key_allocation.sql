alter table license_keys add column allocated_order_id text;

alter table orders add column reservation_expires_at timestamptz;

alter table orders add column failure_code text;

create temporary table mismatched_issues on commit drop as
select k.id as key_id, k.code, o.id as order_id
from license_keys k
join orders o on o.id = k.order_id
where o.sku <> k.sku;

delete from provider_issues p using mismatched_issues m where p.code = m.code;

delete from deliveries d using mismatched_issues m where d.order_id = m.order_id;

update orders o
set status = 'delivery_failed',
    failure_code = 'key_product_mismatch',
    failure_reason = 'issued key did not belong to the ordered product'
from mismatched_issues m
where o.id = m.order_id;

update license_keys k
set order_id = null, issued_at = null
from mismatched_issues m
where k.id = m.key_id;

update license_keys set allocated_order_id = order_id where order_id is not null;

update license_keys k
set allocated_order_id = pick.order_id
from (
  select free.id as key_id, waiting.id as order_id
  from (
    select o.id, o.sku,
           row_number() over (partition by o.sku order by o.created_at) as seat
    from orders o
    where o.status in ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
      and not exists (select 1 from license_keys k2 where k2.allocated_order_id = o.id)
  ) waiting
  join (
    select id, sku,
           row_number() over (partition by sku order by id) as seat
    from license_keys
    where allocated_order_id is null and order_id is null
  ) free on free.sku = waiting.sku and free.seat = waiting.seat
) pick
where k.id = pick.key_id;

update orders
set reservation_expires_at = now()
where status = 'created' and reservation_expires_at is null;

alter table orders add constraint orders_id_sku_unique unique (id, sku);

alter table license_keys
  add constraint license_keys_allocation_fk
  foreign key (allocated_order_id, sku) references orders (id, sku);

create unique index license_keys_allocation_idx
  on license_keys (allocated_order_id)
  where allocated_order_id is not null;

alter table license_keys
  add constraint license_keys_issue_requires_allocation
  check (order_id is null or (allocated_order_id is not null and order_id = allocated_order_id));

drop index if exists license_keys_available_idx;

create index license_keys_free_idx
  on license_keys (sku, id)
  where allocated_order_id is null and order_id is null;

create index orders_reservation_idx
  on orders (reservation_expires_at)
  where status = 'created';
