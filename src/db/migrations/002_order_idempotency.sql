alter table orders add column idempotency_key text;
alter table orders add column failure_reason text;

create unique index orders_idempotency_key_idx on orders (idempotency_key)
  where idempotency_key is not null;
