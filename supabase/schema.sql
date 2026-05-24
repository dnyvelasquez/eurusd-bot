-- SPX500 Bot — Tabla de licencias
-- Ejecutar en: Neon Dashboard → SQL Editor

create table public.licenses (
  id            uuid        primary key default gen_random_uuid(),
  license_key   uuid        unique not null default gen_random_uuid(),
  owner_name    text        not null,
  mt5_account   bigint      not null,
  allowed_mode  text        not null default 'demo'
                            check (allowed_mode in ('demo', 'live', 'both')),
  active        boolean     not null default true,
  expires_at    timestamptz,
  notes         text,
  created_at    timestamptz not null default now()
);


-- ─────────────────────────────────────────────────────────────────────────────
-- INSERTAR UNA LICENCIA PARA UN FAMILIAR
-- ─────────────────────────────────────────────────────────────────────────────
-- insert into public.licenses (owner_name, mt5_account, allowed_mode, notes)
-- values ('Nombre Familiar', 123456789, 'demo', 'Cuenta demo para pruebas');
--
-- Luego copia el valor de license_key generado y dáselo en el .env:
-- LICENSE_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
