create table provider_issues (
  provider   text        not null,
  request_id text        not null,
  code       text        not null,
  issued_at  timestamptz not null default now(),
  primary key (provider, request_id)
);

create table delivery_attempts (
  id         bigserial   primary key,
  order_id   text        not null references orders (id) on delete cascade,
  provider   text        not null,
  request_id text        not null,
  outcome    text        not null check (outcome in ('issued', 'out_of_stock', 'refused', 'unknown')),
  detail     text,
  created_at timestamptz not null default now()
);

create index delivery_attempts_order_idx on delivery_attempts (order_id, created_at);
