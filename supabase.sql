create table if not exists public.gratitude_messages (
  id   text primary key,
  name text not null,
  text text not null,
  t    bigint not null
);

create index if not exists gratitude_messages_t_idx on public.gratitude_messages (t);

alter table public.gratitude_messages enable row level security;

drop policy if exists gratitude_read on public.gratitude_messages;
create policy gratitude_read on public.gratitude_messages
  for select to anon, authenticated using (true);

drop policy if exists gratitude_insert on public.gratitude_messages;
create policy gratitude_insert on public.gratitude_messages
  for insert to anon, authenticated with check (
    char_length(name) between 1 and 20
    and char_length(text) between 1 and 40
  );

grant select, insert on public.gratitude_messages to anon, authenticated;
