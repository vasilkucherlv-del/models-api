# Lartek — API сумісних моделей

Серверна частина для блоку «Сумісні моделі»: база сумісності + пошук.
Повного списку моделей у сторінці немає — фронтенд тягне дані звідси (пошук + прев'ю),
тож список захищений від копіювання й сторінки лишаються легкими.

## Файли
- `server.js` — API (пошук, прев'ю, імпорт), CORS, обмеження частоти
- `db.js` — підключення до Postgres + нормалізація коду моделі
- `schema.sql` — таблиця `compatibility` + індекси (вкл. триграмний для швидкого пошуку)
- `import-csv.js` — масовий імпорт із CSV (`sku,brand,model`)
- `sample.csv` — приклад даних (тестовий товар `DEMO123`)
- `.env.example` — приклад змінних оточення

## Деплой на Railway
1. Залий цю папку в GitHub-репозиторій (або `railway up` із папки).
2. На Railway: **New Project → Deploy from GitHub repo** (або додай сервіс у проєкт `pacific-victory`).
3. Додай базу: **New → Database → PostgreSQL**. Railway створить змінну `DATABASE_URL`.
   - Якщо сервіс її не бачить автоматично — у Variables сервісу додай `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`.
4. У Variables сервісу додай свій секрет: `IMPORT_KEY=<довгий_випадковий_рядок>`.
5. **Deploy.** При старті сервер сам створює таблицю (виконує `schema.sql`).
6. **Settings → Networking → Generate Domain** — отримаєш публічний URL API (далі `API_URL`).

## Завантаження даних
**Масово (початкове наповнення):** підготуй CSV із колонками `sku,brand,model` і запусти локально,
підставивши публічний `DATABASE_URL` із Railway (вкладка Postgres → Connect → Public Network):
```
DATABASE_URL="postgres://...railway..." node import-csv.js data.csv
```
**По одному товару (через API):**
```
curl -X POST "$API_URL/api/import" \
  -H "Content-Type: application/json" \
  -H "X-Import-Key: <твій IMPORT_KEY>" \
  -d '{"sku":"АРТИКУЛ","replace":true,"models":[{"brand":"Bosch","model":"SMV68IX00D/01"}]}'
```
`replace:true` спершу чистить старі моделі цього товару; прибери його, щоб лише додавати.

## Ендпойнти
- `GET /health` → `ok`
- `GET /api/models?sku=АРТИКУЛ&q=SMV68` → `{ "items":[{brand,model}] }`
  - закоротко: `{ "tooShort":true, "min":3 }`
  - забагато збігів: `{ "tooMany":true, "cap":40 }`
- `GET /api/preview?sku=АРТИКУЛ` → `{ "total":N, "items":[...] }` (невеликий список + кількість)
- `POST /api/import` (заголовок `X-Import-Key`) → `{ "sku":..., "processed":N }`

## Під'єднання компонента
У фронтенді заміни вбудовані масиви на запити:
- прев'ю при завантаженні: `GET $API_URL/api/preview?sku=<АРТИКУЛ>`
- пошук при вводі: `GET $API_URL/api/models?sku=<АРТИКУЛ>&q=<ввід>`

`<АРТИКУЛ>` бери з картки товару (наприклад, із `data-sku` у блоці).
Нормалізація пошуку у фронтенді має збігатися з серверною: великі літери, лише `A-Z0-9`.

## Налаштування (Variables)
- `MIN_CHARS` — мінімум символів для пошуку (за замовч. 3)
- `RESULT_CAP` — стеля видачі, далі «уточніть» (за замовч. 40)
- `PREVIEW_LIMIT` — розмір прев'ю (за замовч. 12)

Домени, з яких дозволено звертатись до API, задані в `server.js` (масив `ALLOWED`):
`lartek.com.ua` і `komplektom.com.ua` (з `www`). Додай інші за потреби.
