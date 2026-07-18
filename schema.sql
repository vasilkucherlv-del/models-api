-- Розширення для швидкого пошуку по підрядку
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Таблиця сумісності: одна модель = один рядок, прив'язаний до SKU товару
CREATE TABLE IF NOT EXISTS compatibility (
  id         BIGSERIAL PRIMARY KEY,
  sku        TEXT NOT NULL,            -- артикул твого товару
  brand      TEXT NOT NULL,            -- бренд техніки (Bosch, Siemens, ...)
  model      TEXT NOT NULL,            -- модель як показувати (з рисками/пробілами)
  model_norm TEXT NOT NULL,            -- нормалізована для пошуку (великі, лише A-Z0-9)
  UNIQUE (sku, model_norm)             -- захист від дублів у межах товару
);

-- Індустріальний код моделі (для 3-колонкових таблиць): показ другим рядком + пошук.
ALTER TABLE compatibility ADD COLUMN IF NOT EXISTS code      TEXT NOT NULL DEFAULT '';
ALTER TABLE compatibility ADD COLUMN IF NOT EXISTS code_norm TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_comp_code_trgm
  ON compatibility USING gin (code_norm gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_comp_sku
  ON compatibility (sku);

-- GIN-індекс по триграмах: дає швидкий пошук LIKE '%...%'
CREATE INDEX IF NOT EXISTS idx_comp_model_trgm
  ON compatibility USING gin (model_norm gin_trgm_ops);

-- Лог пошукових запитів сайту (аналітика: топ запитів і запити без результатів).
CREATE TABLE IF NOT EXISTS search_log (
  id         BIGSERIAL PRIMARY KEY,
  q          TEXT NOT NULL,               -- як ввів користувач
  q_norm     TEXT NOT NULL,               -- нижній регістр, згорнуті пробіли (для групування)
  hits       INTEGER NOT NULL DEFAULT 0,  -- скільки знайшлось
  source     TEXT NOT NULL DEFAULT 'site',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_slog_created ON search_log (created_at);
CREATE INDEX IF NOT EXISTS idx_slog_qnorm   ON search_log (q_norm);

-- Опрацьовані запити «без результатів» (натиснув «опрацьовано» — більше не показувати).
CREATE TABLE IF NOT EXISTS search_dismissed (
  q_norm     TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
