# Polymer Processing Planner — план расширения до платформы полимерных процессов

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
2. Единое ядро: auth/roles/notes/tasks/reports/editor/search.
3. Отдельные сервисы платформы:
1. `Calendar Service` (tasks/notes/reports/events, ICS/Google sync, reminders),
2. `Notification Service` (in-app + email hooks),
3. `Audit Service` (журнал изменений и действий).
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
2. Отдельный `Calendar Service`:
1. агрегатор событий (`tasks + notes + reports + qualification/doe milestones`),
2. календарный API и фильтры,
3. ICS feed + экспорт в Google/Outlook,
4. reminder pipeline (in-app, далее email/webhook).
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
6. Спроектировать и зафиксировать контракт `Calendar Service`:
1. единая модель `calendar_events`,
2. источники событий и правила синхронизации,
3. API `GET /calendar/events`, `GET /calendar/feed.ics`, `POST /calendar/sync/google`,
4. права доступа на события по owner/process ACL.

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

---

## 10) План внедрения дерева проекта

Цель: ввести единое дерево навигации и структуры работ для всех процессов, без форка текущих сущностей.

### 10.1 Целевая структура дерева
1. `Process` (корень ветки).
2. `Experiment`.
3. `Section` (`Qualification`, `DOE`, `Reports`, `Tasks`, `Journal`).
4. `Node`:
1. qualification step,
2. doe study,
3. run,
4. report,
5. task,
6. note.

### 10.2 Минимальная модель данных (без ломки текущей БД)
1. Добавить таблицу `project_tree_nodes`:
1. `id`, `process_id`, `experiment_id`, `parent_id`,
2. `node_type`, `entity_type`, `entity_id`,
3. `title`, `sort_order`, `is_archived`,
4. `created_at`, `updated_at`.
2. Добавить таблицу `project_tree_state`:
1. `user_id`, `node_id`, `is_collapsed`, `pinned`.
3. Дерево не хранит бизнес-данные сущностей, только ссылки и порядок отображения.

### 10.3 API и роутинг дерева
1. `GET /tree?process_id=&experiment_id=` — отдать срез дерева по ACL.
2. `POST /tree/node` — создать пользовательский узел/группу.
3. `PATCH /tree/node/:id` — переименование/архивация/сортировка.
4. `POST /tree/reorder` — массовое обновление `parent_id/sort_order`.
5. `PATCH /tree/state/:node_id` — состояние раскрытия для пользователя.

### 10.4 Правила синхронизации с текущими сущностями
1. При создании `experiment/doe/run/report/task/note` автоматически добавлять/обновлять узел.
2. При удалении/архивации сущности помечать узел как `is_archived=1`, не удалять физически.
3. Источник истины для данных остается в текущих таблицах (`experiments`, `doe_studies`, `runs`, ...).
4. Узел дерева всегда содержит канонический `href` по текущему роутингу.

### 10.5 UI внедрение (по этапам)
1. Этап 1: read-only дерево в левом сайдбаре страницы эксперимента.
2. Этап 2: drag-and-drop сортировка и пользовательские группы.
3. Этап 3: фильтры по owner/status/date и быстрый поиск внутри дерева.
4. Этап 4: связка с календарем и уведомлениями (узел -> события/дедлайны).

### 10.6 План внедрения по спринтам
1. Sprint 1: схема БД + read-only API + автогенерация узлов для существующих экспериментов.
2. Sprint 2: UI read-only дерево + переходы по каноническим ссылкам + ACL тесты.
3. Sprint 3: reorder/grouping + сохранение state пользователя.
4. Sprint 4: интеграция с `Calendar Service` и задачами (дедлайны из дерева).

### 10.7 Критерии готовности
1. Любой процесс отображается единообразно как дерево без process-specific UI форков.
2. Добавление нового типа процесса не требует изменений в механике дерева.
3. Дерево соблюдает ACL `admin/manager/process_owner/experiment_owner`.
4. Роуты и breadcrumbs строятся от узла дерева к каноническому URL без legacy-ссылок.

---

## 11) Пошаговое внедрение `Calendar Service`

Цель: единый календарь сущностей с персональным и процессным представлением, drag&drop переносом дат и цветовой схемой, совпадающей с заметками.

### 11.1 Scope и UX-контуры
1. Страница пользователя (`/me`):
1. отдельный блок календаря `My Calendar`;
2. показывать только сущности, привязанные к текущему пользователю (owner/assignee).
2. Страница процесса (`/<process_code>`):
1. раскрываемый блок `Process Calendar` (collapsed by default);
2. показывать все сущности пользователей, находящихся в контуре процесса и его подчиненной ответственности.
3. Перенос дат:
1. даты всех поддерживаемых сущностей меняются drag&drop в календаре;
2. изменения сразу пишутся в источник данных сущности;
3. аудит изменения даты обязателен.
4. Цвета:
1. цвета календарных событий строго наследуются из палитры заметок (`entity-experiment`, `entity-qualification_step`, `entity-doe`, `entity-run`, `entity-report`, `entity-task`).

### 11.2 Модель ответственности и доступа
1. Персональный календарь:
1. включает сущности, где пользователь: `owner_user_id`, `assignee_user_id`, либо явный assignment.
2. Процессный календарь:
1. для `admin/manager` — все сущности процесса;
2. для `process owner` — сущности процесса + сущности назначенных/подчиненных пользователей процесса;
3. для остальных — только доступные по текущему ACL сущности процесса.
3. Для поддержки “нижестоящих пользователей” добавить явную модель подчиненности (если ее еще нет):
1. таблица `user_reporting_lines (manager_user_id, member_user_id, process_id NULLABLE, created_at)`;
2. process-scoped и global связи;
3. резолвер `getScopeUsers(actor, processId)`.

### 11.3 Данные и БД (миграции)
1. Добавить таблицу `calendar_events` (агрегатор):
1. `id`, `entity_type`, `entity_id`, `experiment_id`, `process_id`,
2. `owner_user_id`, `assignee_user_id`,
3. `title`, `starts_at`, `ends_at`, `all_day`,
4. `status`, `color_token`, `source_due_field`,
5. `created_at`, `updated_at`.
2. Добавить `due_at` в сущности, где даты еще нет (минимум для стартового охвата):
1. `runs.due_at` (обязательно),
2. при необходимости `qual_steps.due_at`, `doe_studies.due_at`, `reports.target_date`.
3. Привязка владельца `run`:
1. `runs.owner_user_id` заполняется из владельца родительской сущности (приоритет: entity assignee -> experiment owner -> process owner).
4. Индексы:
1. `calendar_events(process_id, starts_at)`,
2. `calendar_events(owner_user_id, starts_at)`,
3. `calendar_events(entity_type, entity_id)` unique.

### 11.4 Сервисный слой и синхронизация
1. Создать `calendar_service.ts`:
1. `upsertEventFromEntity(entityType, entityId)`,
2. `listMyEvents(userId, range)`,
3. `listProcessEvents(processId, actorUserId, range)`,
4. `moveEvent(eventId, nextStart, nextEnd, actorUserId)`.
2. Правило “single source of truth”:
1. календарь хранит проекцию;
2. при переносе меняется дата в исходной сущности (`tasks.due_at`, `runs.due_at`, ...), затем пересчет `calendar_events`.
3. Хуки синхронизации:
1. create/update/delete task/run/doe/report/qualification-step -> `upsert/remove calendar_event`;
2. assignment change -> обновить owner/assignee event.

### 11.5 API
1. `GET /calendar/events?scope=my|process&process_id=&from=&to=&entity_types=`
2. `PATCH /calendar/events/:id/move` body: `{ starts_at, ends_at }`
3. `GET /calendar/feed.ics?scope=my|process&process_id=`
4. `POST /calendar/sync/google` (после MVP)
5. Валидация:
1. actor должен иметь доступ к entity;
2. перенос даты запрещен без прав редактирования исходной сущности.

### 11.6 UI внедрение
1. `/me`:
1. новый card `My Calendar` над таблицей задач;
2. фильтры: entity type, process, owner;
3. drag&drop перенос с optimistic update + rollback on error.
2. `/<process_code>`:
1. collapsible block `Process Calendar` под шапкой процесса;
2. default collapsed;
3. quick legend цветов + фильтр “My team / All visible”.
3. Цветовая карта:
1. вынести в единый конфиг `entityColorMap` из существующих css токенов заметок;
2. календарь и notes используют один источник.
4. Переход к сущности:
1. клик по событию в календаре открывает связанную сущность по каноническому URL;
2. для `task` переход на страницу эксперимента с фокусом на задаче;
3. для `run` переход на страницу конкретного run.

### 11.7 Порядок реализации (по спринтам)
1. Sprint 1 (Backend foundation):
1. миграции (`runs.due_at`, `runs.owner_user_id`, `calendar_events`, optional `user_reporting_lines`);
2. `calendar_service` + sync hooks для `tasks` и `runs`;
3. `GET /calendar/events` + ACL.
2. Sprint 2 (My Calendar MVP):
1. UI календаря на `/me`;
2. drag&drop для `task` и `run`;
3. аудит изменений дат.
3. Sprint 3 (Process Calendar):
1. collapsible календарь на странице процесса;
2. выборка “нижестоящих пользователей” через reporting lines;
3. process filters + performance tuning.
4. Sprint 4 (Coverage expansion):
1. подключение `qualification/doe/report` дат;
2. ICS feed на scope my/process;
3. Google sync и reminders.

### 11.8 Критерии готовности
1. На `/me` видны все сущности пользователя в календаре, с корректными цветами по entity типам.
2. На странице процесса календарь раскрывается и показывает все сущности подчиненного контура по ACL.
3. Drag&drop меняет дату в исходной сущности, а не только в проекции.
4. Для `run` дата и владелец сохраняются и используются в календаре.
5. Цвета календаря и заметок совпадают 1:1 по entity type.

### 11.9 Текущий статус (выполнено в коде)
1. Реализованы оба календарных контура:
1. `My Calendar` на `/me`,
2. `Process Calendar` на `/<process_code>` (collapsible).
2. Подключены сущности:
1. `task`,
2. `run` (DOE),
3. `qual_run` (qualification runs).
3. Реализованы ссылки из календаря:
1. клик по событию открывает popup с метаданными и ссылками на run/task и родительскую сущность;
2. переходы используют канонические маршруты.
4. Перенос дат:
1. одиночный drag переносит одну сущность;
2. group drag переносит только текущую выделенную группу;
3. `Move selected` выполняет массовый перенос по выбранной дате.
5. Выделение:
1. выбор сущностей через `Shift/Cmd/Ctrl + click`,
2. выделение лассо по рамке мышью,
3. снятие выделения по клику в пустую область календаря или кнопкой `Clear selection`.
6. UX/визуал:
1. выбранные сущности подсвечиваются красным бордером на карточке события;
2. в process calendar сохраняется состояние раскрытия блока (`localStorage`).
7. Ограничения текущего состояния:
1. выделение считается по событиям, отрисованным в текущем view;
2. при переключении view/month выделение пересчитывается из видимого набора.
