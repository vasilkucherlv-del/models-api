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
