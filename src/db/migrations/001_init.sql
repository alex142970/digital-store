create table products (
  sku      text primary key,
  name     text    not null,
  type     text    not null check (type in ('topup', 'key', 'subscription', 'giftcard')),
  price    integer not null check (price > 0),
  currency text    not null default 'RUB',
  image    text
);

create table orders (
  id         text        primary key,
  sku        text        not null references products (sku),
  amount     integer     not null check (amount >= 0),
  discount   integer     not null default 0 check (discount >= 0),
  promo_code text,
  status     text        not null default 'created'
               check (status in ('created', 'paid', 'delivering', 'delivered',
                                 'payment_failed', 'out_of_stock', 'delivery_failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_discount_within_amount check (discount <= amount)
);

create index orders_unfinished_idx on orders (updated_at)
  where status in ('paid', 'delivering', 'out_of_stock', 'delivery_failed');

create function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger orders_updated_at before update on orders
  for each row execute function set_updated_at();

create table license_keys (
  id        bigserial   primary key,
  sku       text        not null references products (sku),
  code      text        not null unique,
  order_id  text        references orders (id),
  issued_at timestamptz,
  constraint license_keys_issued_consistent check ((order_id is null) = (issued_at is null))
);

create unique index license_keys_one_order_idx on license_keys (order_id)
  where order_id is not null;

create index license_keys_available_idx on license_keys (sku, id)
  where order_id is null;

create table deliveries (
  order_id     text        primary key references orders (id),
  key_id       bigint      not null unique references license_keys (id),
  provider     text        not null,
  request_id   text        not null unique,
  code         text        not null,
  delivered_at timestamptz not null default now()
);

create table webhook_events (
  event_id    text        primary key,
  order_id    text        not null,
  status      text        not null check (status in ('paid', 'failed')),
  occurred_at timestamptz not null,
  payload     jsonb       not null,
  received_at timestamptz not null default now(),
  applied_at  timestamptz
);

create index webhook_events_pending_idx on webhook_events (order_id, occurred_at)
  where applied_at is null;

create index webhook_events_order_idx on webhook_events (order_id, occurred_at);

create table promocodes (
  code       text    primary key,
  type       text    not null check (type in ('percent', 'amount')),
  value      integer not null check (value > 0),
  currency   text,
  max_uses   integer not null check (max_uses > 0),
  used_count integer not null default 0 check (used_count >= 0),
  constraint promocodes_limit check (used_count <= max_uses),
  constraint promocodes_percent_range check (type <> 'percent' or value <= 100)
);

create table promocode_uses (
  order_id text        primary key references orders (id),
  code     text        not null references promocodes (code),
  used_at  timestamptz not null default now()
);

create index promocode_uses_code_idx on promocode_uses (code);
