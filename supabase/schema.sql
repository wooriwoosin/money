create extension if not exists pgcrypto with schema extensions;

create table if not exists app_users (
  id            bigint generated always as identity primary key,
  username      text unique not null,
  password_hash text not null,
  role          text default 'user',
  name          text,
  created_at    timestamptz default now()
);

create table if not exists app_sessions (
  token      text primary key,
  username   text not null references app_users(username) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

create table if not exists payments (
  id            bigint generated always as identity primary key,
  pay_date      date not null,
  bank          text,
  account_no    text,
  amount        bigint default 0,
  payee         text,
  rrn           text,
  phone         text,
  bank_memo     text,
  sangbu        text,
  source        text,
  customer_name text,
  created_at    timestamptz default now()
);

create index if not exists idx_payments_acc  on payments (account_no);
create index if not exists idx_payments_date on payments (pay_date);

alter table app_users    enable row level security;
alter table app_sessions enable row level security;
alter table payments     enable row level security;

revoke all on app_users    from anon, authenticated;
revoke all on app_sessions from anon, authenticated;
revoke all on payments     from anon, authenticated;

create or replace function app_check_session(p_token text)
returns text language sql security definer set search_path = public, extensions as $$
  select username from app_sessions where token = p_token and expires_at > now();
$$;

create or replace function app_login(p_username text, p_password text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_user app_users; v_token text;
begin
  select * into v_user from app_users where username = p_username;
  if v_user.id is null
     or v_user.password_hash <> crypt(p_password, v_user.password_hash) then
    return json_build_object('ok', false, 'error', '아이디 또는 비밀번호가 틀렸습니다.');
  end if;
  v_token := encode(gen_random_bytes(24), 'hex');
  insert into app_sessions(token, username, expires_at)
    values (v_token, v_user.username, now() + interval '8 hours');
  delete from app_sessions where expires_at < now();
  return json_build_object('ok', true, 'token', v_token, 'username', v_user.username);
end $$;

create or replace function app_save_payments(p_token text, p_payments jsonb, p_pay_date date)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_user text; v_count int;
begin
  v_user := app_check_session(p_token);
  if v_user is null then
    return json_build_object('ok', false, 'error', '세션이 만료됐습니다. 다시 로그인해주세요.');
  end if;
  insert into payments (pay_date, bank, account_no, amount, payee, rrn, phone, bank_memo, sangbu, source, customer_name)
  select
    p_pay_date,
    e->>'은행',
    regexp_replace(coalesce(e->>'계좌번호', e->>'계좌', ''), '[-\s]', '', 'g'),
    coalesce((e->>'금액')::bigint, 0),
    e->>'수취인',
    e->>'주민번호',
    e->>'연락처',
    coalesce(nullif(e->>'받는분통장표시', ''), '인터넷사은금'),
    e->>'상부점',
    e->>'소스',
    coalesce(nullif(e->>'고객명', ''), e->>'수취인')
  from jsonb_array_elements(p_payments) as e;
  get diagnostics v_count = row_count;
  return json_build_object('ok', true, 'saved', v_count);
end $$;

create or replace function app_save_bank(p_token text, p_rows jsonb)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_user text; v_count int;
begin
  v_user := app_check_session(p_token);
  if v_user is null then
    return json_build_object('ok', false, 'error', '세션이 만료됐습니다. 다시 로그인해주세요.');
  end if;
  insert into payments (pay_date, bank, account_no, amount, payee, rrn, phone, bank_memo, sangbu, source, customer_name)
  select
    nullif(e->>'date', '')::date,
    e->>'bank',
    regexp_replace(coalesce(e->>'acc', ''), '[-\s]', '', 'g'),
    coalesce((e->>'amt')::bigint, 0),
    e->>'name',
    '', '',
    coalesce(nullif(e->>'bankMemo', ''), '인터넷사은금'),
    e->>'sangbu',
    '은행파일',
    ''
  from jsonb_array_elements(p_rows) as e
  where nullif(e->>'date', '') is not null;
  get diagnostics v_count = row_count;
  return json_build_object('ok', true, 'saved', v_count);
end $$;

create or replace function app_find_by_accounts(p_token text, p_accounts text[])
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_user text; v_rows json;
        v_cut date := ((now() at time zone 'Asia/Seoul')::date - interval '24 months')::date;
begin
  v_user := app_check_session(p_token);
  if v_user is null then
    return json_build_object('ok', false, 'error', '세션이 만료됐습니다. 다시 로그인해주세요.');
  end if;
  select coalesce(json_agg(t), '[]'::json) into v_rows from (
    select to_char(pay_date, 'YYYY-MM-DD') as date,
           account_no as acc, amount as amt, payee as name,
           customer_name as "custName", sangbu, bank
    from payments
    where account_no = any(p_accounts) and pay_date >= v_cut
  ) t;
  return json_build_object('ok', true, 'rows', v_rows);
end $$;

create or replace function app_get_history(p_token text, p_page int default 1, p_keyword text default '')
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_user text; v_size int := 50; v_total int; v_rows json; v_offset int;
begin
  v_user := app_check_session(p_token);
  if v_user is null then
    return json_build_object('ok', false, 'error', '세션이 만료됐습니다. 다시 로그인해주세요.');
  end if;
  v_offset := (greatest(p_page, 1) - 1) * v_size;

  select count(*) into v_total from payments
  where p_keyword = ''
     or payee ilike '%'||p_keyword||'%'
     or account_no ilike '%'||p_keyword||'%'
     or sangbu ilike '%'||p_keyword||'%'
     or customer_name ilike '%'||p_keyword||'%';

  select coalesce(json_agg(t), '[]'::json) into v_rows from (
    select to_char(pay_date, 'YYYY-MM-DD') as "입금일자",
           bank as "은행", account_no as "계좌번호", amount as "금액",
           payee as "수취인", rrn as "주민번호", phone as "연락처",
           bank_memo as "통장표시", sangbu as "상부점", source as "소스",
           customer_name as "고객명",
           to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') as "등록일시"
    from payments
    where p_keyword = ''
       or payee ilike '%'||p_keyword||'%'
       or account_no ilike '%'||p_keyword||'%'
       or sangbu ilike '%'||p_keyword||'%'
       or customer_name ilike '%'||p_keyword||'%'
    order by pay_date desc, id desc
    limit v_size offset v_offset
  ) t;

  return json_build_object('ok', true, 'total', v_total, 'page', p_page,
    'pageSize', v_size, 'totalPages', ceil(v_total::numeric / v_size), 'rows', v_rows);
end $$;

create or replace function app_get_stats(p_token text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_user text; v_amt bigint; v_cnt int; v_by_date json; v_by_sangbu json;
        v_cut date := ((now() at time zone 'Asia/Seoul')::date - interval '1 month')::date;
begin
  v_user := app_check_session(p_token);
  if v_user is null then
    return json_build_object('ok', false, 'error', '세션이 만료됐습니다. 다시 로그인해주세요.');
  end if;
  select coalesce(sum(amount), 0), count(*) into v_amt, v_cnt
    from payments where pay_date >= v_cut;
  select coalesce(json_object_agg(d, amt), '{}'::json) into v_by_date from (
    select to_char(pay_date, 'YYYY-MM-DD') d, sum(amount) amt
    from payments where pay_date >= v_cut group by 1) x;
  select coalesce(json_object_agg(s, amt), '{}'::json) into v_by_sangbu from (
    select coalesce(nullif(sangbu, ''), '기타') s, sum(amount) amt
    from payments where pay_date >= v_cut group by 1) y;
  return json_build_object('ok', true, 'totalAmt', v_amt, 'totalCnt', v_cnt,
    'byDate', v_by_date, 'bySangbu', v_by_sangbu);
end $$;

grant execute on function app_login(text, text)               to anon;
grant execute on function app_save_payments(text, jsonb, date) to anon;
grant execute on function app_save_bank(text, jsonb)           to anon;
grant execute on function app_find_by_accounts(text, text[])   to anon;
grant execute on function app_get_history(text, int, text)     to anon;
grant execute on function app_get_stats(text)                  to anon;

insert into app_users (username, password_hash, role, name)
values ('admin', crypt('wavenet2024!', gen_salt('bf')), 'admin', '관리자')
on conflict (username) do nothing;
