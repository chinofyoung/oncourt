-- Read-only in this slice: the public browse pages aggregate ratings and
-- render review text. The write path (leaving a review after a completed
-- booking) belongs to the player dashboard slice.
--
-- booking_id is UNIQUE, which both enforces one review per booking and gives
-- that FK its required index for free.
--
-- FK delete behavior deliberately mirrors bookings: booking_id is NO ACTION
-- because a booking is a financial record that must not vanish, while
-- branch_id and player_id CASCADE like every table above them. Consequence:
-- deleting a booking that has a review raises 23503. Pinned by a test.
--
-- branch_id is denormalized off booking -> court -> branch because every read
-- in this slice aggregates by branch.
--
-- No denormalized rating column on branches: the aggregate is cheap at this
-- scale, and a cached column needs trigger machinery this slice would not test.
create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings (id),
  branch_id uuid not null references branches (id) on delete cascade,
  player_id uuid not null references profiles (id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  body text,
  created_at timestamptz not null default now()
);

create index if not exists reviews_branch_id_idx on reviews (branch_id);
create index if not exists reviews_player_id_idx on reviews (player_id);

-- Deny-by-default, like every other table: the publishable key ships in the
-- browser and must never reach this table. Do NOT add policies, and do NOT
-- use `force row level security` (it would subject the owner role to those
-- non-existent policies and break the app).
alter table reviews enable row level security;
