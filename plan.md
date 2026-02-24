# IM Planner — план расширения до платформы полимерных процессов

## 1) Цель
Сделать из текущего сервиса (литье под давлением) модульную платформу для:
1. планирования литья,
2. планирования масштабирования,
3. других полимерных процессов,
с единым UX редактирования отчетов, заметок, задач и ролей.

Ключевая идея: добавить внешний уровень контекста (`Процесс/Тип процесса`) над экспериментами, не ломая текущую структуру.

---

## 2) Текущее состояние (база уже есть)

### Реализовано
1. Аутентификация и роли (`admin/manager/engineer/operator`).
2. Владельцы экспериментов + ACL.
3. Статусы экспериментов и UI страницы эксперимента.
4. Отчеты: подпись, отзыв подписи, read-only подписанных.
5. Report Editor на Tiptap (WYSIWYG), `content_md/html/json`, автосейв, PDF-экспорт (печать).
6. Notes/Journal: drawer + отдельная страница, фильтры, rail, версионирование заметок, чеклисты.
7. Run-роуты вложены под эксперимент + legacy-redirect.
8. Новый доменный уровень `Process Type + Process`:
1. таблицы `process_types`, `processes`,
2. привязка `experiments.process_id`,
3. fallback-миграция на `Injection Default Process`.
9. ACL процесса:
1. `Process Owner` видит/управляет экспериментами процесса,
2. `Experiment Owner` сохраняет роль владельца и подписи отчетов.
10. Канонический роутинг:
1. список процессов: `/`,
2. страница процесса: `/<process_route_code>`,
3. эксперимент: `/<process_route_code>/<experiment_id>`,
4. совместимость со старыми `/experiments/:id` через redirect/rewrite.
11. Настройки процесса (admin-only) перенесены на страницу процесса (popup):
1. `route_code`,
2. `owner_user_id`.

### Что дожать в текущем контуре
1. Полная стабилизация popup notes-редактора (одинаковое поведение с report editor).
2. Финальный проход по UX журнала/заметок (плотность, мобилка, фильтры).
3. Финальный проход по ссылкам/навигации (убрать остатки legacy href в шаблонах, где уместно).

---

## 3) Целевая доменная модель (новый уровень вложенности)

## 3.1 Новая иерархия
1. `Process Program` (опционально, верхний контейнер компании/направления).
2. `Process Type` (обязательный внешний слой): `Injection`, `Scale-up`, `Extrusion`, `Compounding`, ...
3. `Process` (конкретный процесс/инициатива, с ответственным за процесс).
4. `Experiment` (как сейчас).
5. Сущности эксперимента (`Qualification`, `DOE`, `Run`, `Task`, `Report`, `Notes`).

Минимум для первого этапа: ввести `Process Type + Process` и привязать к ним эксперименты. Статус: выполнено.

## 3.2 Роли и ответственность (расширение)
1. `Process Owner` — новый уровень ответственности.
2. `Experiment Owner` — остается.
3. `Entity Assignee` — остается (шаги/DOE/другие сущности).
4. Правила прав:
1. `Process Owner` видит/управляет всем в процессе.
2. `Experiment Owner` управляет экспериментом и подписывает отчеты по его сущностям.
3. Назначения по сущностям создают автозадачи и уведомления.

---

## 4) Архитектурные принципы для масштабирования
1. Feature modules: каждый процесс подключает свои блоки (параметры, шаги, шаблоны отчетов) как модуль.
2. Единое ядро: auth/roles/notes/tasks/reports/editor/calendar/search.
3. Общий Report Editor: один Tiptap-движок и одна тулбар-логика для всех типов процессов.
4. Типизированные entity metadata: расширения через `entity_type + schema`, без копипаста таблиц.
5. Совместимость по роутам: старые URL продолжают работать через redirect/compat слой.

---

## 5) Интегрированный roadmap (с учетом текущего плана)

## Wave A — стабилизация текущего ядра (короткий горизонт)
1. Привести popup notes editor к паритету с report editor (форматирование/фокус/выделение/таблицы/формулы).
2. Journal V2:
1. календарный режим (MVP),
2. единые фильтры `text + date + entity_type`,
3. UI истории версий заметок.
3. Report Editor stabilization:
1. регрессия реальных кейсов,
2. print-стили PDF,
3. фиксация канона хранения (`content_md`).

## Wave B — доменный слой `Process Type + Process` (главный шаг масштабирования)
1. БД:
1. `process_types`,
2. `processes` (`owner_user_id`, статус, метаданные),
3. связь `experiments.process_id`.
2. UI/навигация:
1. выбор процесса и типа процесса,
2. фильтры/группировка на home/list страницах,
3. карточка процесса.
3. Роли:
1. добавить `process_owner` права,
2. матрица доступа `admin/manager/process_owner/experiment_owner`.
4. Миграция:
1. создать default `Process Type = Injection`,
2. существующие эксперименты привязать к default process,
3. сохранить старые маршруты через redirect.

## Wave C — мультипроцессность и модульные шаблоны
1. Процессные шаблоны:
1. структура этапов,
2. обязательные поля,
3. шаблоны отчетов.
2. Подключить второй процессный модуль (например, `Scale-up`) без форка ядра.
3. Унифицировать report blocks по типам процессов.

## Wave D — общесистемные функции
1. Экспорт данных: CSV/ZIP/XLSX.
2. Пользовательский календарь (`tasks + notes + reports`) + ICS/Google.
3. Глобальный поиск + расширенный аудит.
4. Основа внутренних сообщений (поверх текущих notifications).

---

## 6) План миграции без боли
1. Сначала расширяем схему БД, не ломая текущие таблицы.
2. Вводим fallback-контекст `Injection Default Process`.
3. Переводим UI поэтапно: список -> карточка эксперимента -> отчеты -> заметки.
4. Legacy routes держим минимум 1 релиз.
5. На каждом шаге — миграционные скрипты + smoke tests.

---

## 7) Что делаем следующим спринтом (конкретно)
1. Завершить стабилизацию notes popup editor до полной паритетности с report editor.
2. Довести process UI до production-режима:
1. CRUD процессов (минимум create/archive),
2. защита от конфликтов `route_code` в UI с понятной ошибкой,
3. фильтры/поиск по процессам на главной.
3. Унифицировать все внутренние ссылки на канонические `/<process>/<experiment_id>` без лишних редиректов.
4. Добавить тесты роутинга:
1. `/<process_code>` -> process page,
2. `/<process_code>/<id>` -> experiment page,
3. legacy `/experiments/:id` -> canonical redirect.
5. Завершить стабилизацию report/notes editor (toolbar parity + data sidebar в report editor).

---

## 8) Критерии успеха
1. Новый процесс можно создать без изменения ядра редактора/заметок/задач.
2. Для нового типа процесса переиспользуются те же report editing функции.
3. Есть явный `Process Owner` и прозрачная матрица прав.
4. Старые эксперименты продолжают работать без ручного вмешательства.

---

## 9) План внедрения модуля `Compounding (Twin-Screw Extrusion)`

### 9.1 Stage A — Qualification pack (6 исследований)
1. `RTD / Residence Time Stability`
1. входы: базовый профиль `T`, `rpm`, `throughput`;
1. измерения: RTD/tracer, стабилизация torque/pressure, `MFR_g_10min`;
1. выход: минимальный purge/стабилизация и стабильный режим.
2. `SME Map / Energy Window`
1. факторы: `rpm × throughput`;
1. измерения: torque, rpm, throughput, melt temp, die pressure;
1. выход: окно SME без деградации и с достаточной дисперсией.
3. `Melt Temperature / Thermal History Map`
1. факторы: barrel profile (реперные зоны), rpm, throughput;
1. измерения: melt temp (у головы), die pressure;
1. выход: границы перегрева/недоплава.
4. `Feeding / Side-Feeder Qualification`
1. факторы: feed rate ratio, feeder speed;
1. измерения: массовая доля наполнителя, вариация во времени, агломераты;
1. выход: стабильная подача без пульсаций/забивов.
5. `Degassing / Moisture Control`
1. факторы: vacuum, barrel temps, throughput;
1. измерения: влажность гранулы, пористость, вспенивание, летучие/запах;
1. выход: режим с управляемой влагой без пузырей.
6. `Dispersion / Mixing Quality Check`
1. быстрые метрики QC (микроскопия/прочность/цвет/FTIR proxy);
1. выход: критерий `ok dispersion` как gate для DOE.

### 9.2 Stage B — DOE baseline (минимальный шум)
1. Core-факторы:
1. `throughput_kg_h`,
1. `screw_rpm`,
1. `head_temp_c`,
1. `mid_temp_c`,
1. `feed_ratio_filler_pct` (если наполнитель в дизайне).
2. Дополнительные факторы (по необходимости):
1. `vacuum_mbar` или `vent_on`,
1. `die_temp_c`,
1. `side_feeder_rpm`,
1. `water_injection_g_min` или `moisture_target_pct`.
3. Стандартные outputs:
1. `torque_pct`,
1. `melt_temp_c`,
1. `die_pressure_bar`,
1. `SME_kJ_kg` (derived/reporting),
1. `strand_stability_score` и/или `defect_tags`,
1. `pellet_moisture_pct`,
1. `MFR_g_10min` (или `viscosity_proxy`, при необходимости),
1. `bulk_density_g_cm3`.

### 9.3 Ограничения и правила
1. Не использовать 8 отдельных зон цилиндра как отдельные DOE-факторы.
2. Использовать 1-2 реперные зоны (`mid/head`) или сдвиг профиля.
3. Qualification формирует базовую точку + ограничения (`max pressure`, `max melt temp`, `min degassing`) перед DOE.

### 9.4 Внедрение в системе (порядок)
1. Домен/seed:
1. `process_type = compounding`,
1. default process `route_code = compounding`,
1. общий seed параметров input/output для compounding.
2. Qualification:
1. process-specific 6-step definitions для `compounding`,
1. автоматическое применение pack по `process_type_code`,
1. process-specific UI шага квалификации:
1. для `Injection` — специализированные экраны Scientific Molding,
1. для `Compounding` — независимый универсальный редактор шага (runs + fields) без injection-специфики.
3. DOE:
1. process-specific default active factors для `compounding`,
1. единый engine генерации дизайнов без форка ядра,
1. process-specific default active outputs (измеряемые поля),
1. fallback анализа: если `analysis_run_values` пусты, читать из `run_values` по `code`.
4. Тесты:
1. smoke на process routing (`/<route_code>` + `/<route_code>/<id>`),
1. интеграционный тест `compounding`: qualification pack + default DOE factors,
1. проверка DOE analysis на тестовых данных compounding.

### 9.5 Критерий завершения Stage A/B
1. Новый experiment в процессе `compounding` получает свой qualification pack автоматически.
2. Новый DOE в `compounding` получает корректный baseline факторов без ручной настройки.
3. DOE analysis работает на едином модуле для всех процессов и не зависит от ручного переноса тестовых значений между таблицами.
4. Все legacy/injection сценарии и текущие тесты проходят без регрессии.

### 9.6 Добавление процесса `Coating`
1. Добавлен `process_type = coating` и default process `route_code = coating`.
2. Добавлен process-specific Qualification pack (6 шагов):
1. Rheology Window,
1. Wetting / Surface Energy Check,
1. Coat Weight Calibration,
1. Drying / Curing Window,
1. Adhesion Qualification,
1. Barrier / Functional Check.
3. Qualification для `coating` изолирована от injection UI и использует независимый generic step editor.
4. DOE engine остается общий:
1. process-specific default factors для `coating`,
1. process-specific default active outputs для `coating`,
1. общий модуль анализа + fallback `analysis_run_values -> run_values`.
5. Создан demo experiment `Coating` с заполненными Qualification/DOE данными.
