# Техническое задание для Astra: AxiomPilotCode V1.0 (production candidate)

Ты — ведущий инженер по системному ПО, AI inference, coding agents, Windows CLI, UX терминальных интерфейсов и качеству production-кода. Не создавай демонстрацию или декоративный прототип. Твоя задача — разработать **реальный, тестируемый, открытый AxiomPilotCode V1.0**, сначала для Windows x64 и NVIDIA CUDA, расширяемый до Linux/macOS. Если работа не помещается в одну сессию, выполняй её по этапам и сохраняй функционирующий репозиторий после каждого этапа. Не выдавай непроверенный функционал за готовый.

## Исходные условия
- Репозиторий CLI: https://github.com/zaoastronaftik-bit/axiom-pilot-code
- Отдельный сайт: https://github.com/zaoastronaftik-bit/axiom-pilot-code.PAGES
- Уже существует Node.js ESM CLI-прототип 0.1.0: src/cli.js, src/agent.js, src/backend.js, src/tools.js, src/storage.js, src/updater.js; есть тесты, команда pilotcode, стриминг OpenAI-compatible API, поддержка LM Studio на http://127.0.0.1:1234/v1, read/write/command tool calls с запросом подтверждения, Fast/Deep на **одной выбранной модели**, сессии и slash-команды. ОБЯЗАТЕЛЬНО сначала изучи существующий исходный код, тесты, README, лицензии, текущий статус GitHub и не уничтожай работающее.
- Компьютер разработки: Windows, NVIDIA RTX 4070 SUPER (12 ГБ VRAM), Intel i5-14400F, 32 ГБ RAM. Базовый smoke-test — Qwen класса 7–9B с GGUF Q4_K_M. Большие модели не должны автоматически выгружать машину в swap.
- Продукт open source; npm global install `npm install -g axiom-pilot-code` (публиковать npm лишь при явном разрешении владельца). Команда `pilotcode`.
- Не требуется аккаунт или интернет для базовой локальной работы. Будущая авторизация через отдельный Axiom API, НЕ Supabase Auth. Данные и модели локальны по умолчанию. Сайт пока на GitHub Pages, сервер разрабатывается отдельно.

## Принципы качества
1. Реализуй реальные функции, не заглушки. Не создавай фальшивые логи, fake benchmarks, поддельные "GPU ready" статусы или hardcoded success. Помечай экспериментальные части явно.
2. Используй готовый open-source **llama.cpp** как вычислительное ядро, не переписывай CUDA/математику. Создай **Axiom Runtime Manager** — отдельный управляющий слой над готовым бинарным runtime. В V1 допускается скачать подходящую опубликованную совместимую сборку, проверив SHA256, лицензию, архитектуру и источник. Не маскируй стороннее ПО как написанное нами.
3. **Не распространяй LM Studio без права**, не переименовывай/не скрывай чужую закрытую программу, не меняй чужие бинарники. LM Studio API/официальный headless-режим — отдельный внешний backend по выбору пользователя. Установка сторонних runtime и моделей требует явного согласия, показывает размер, источник, путь, лицензию и возможность удаления.
4. Выбирай минимум зависимостей, строгую типизацию TS с type-check, понятные интерфейсы, атомарные операции с диском, структурированные ошибки, корреляционные ID логов, модульные и интеграционные тесты. Запрещены скрытый shell, silent telemetry, неожиданные автозапуски и отправка исходников в облако.
5. UX — быстрый лаконичный терминал, не шумный баннер/ASCII-арт в каждом ответе. Светлая/тёмная темы TUI опционально, изначально качественный контраст. Стриминг ответа без flicker; Ctrl+C отменяет генерацию, а не уничтожает проект.

## A. Рабочее ядро агента
- CLI REPL и неинтерактивный `pilotcode run "task"`, exit codes, `--cwd`, `--model`, `--backend`, `--json`, `--help`, `--version`.
- Управление проектами и сессиями: `/help`, `/model`, `/models`, `/mode fast|deep`, `/status`, `/resume`, `/sessions`, `/new`, `/compact`, `/clear`, `/config`, `/doctor`, `/update`, `/exit`, `/permissions`, `/undo`, `/diff`, `/plan`. Сообщай о реально реализованных командах; поддержи историю терминального ввода.
- Один выбранный LLM в Fast и Deep. Deep — планирование и verify-loop; Fast — компактный цикл. Никакого скрытого переключения на облачную модель. Token/time/tool budgets, stop criteria, отмена, retry/backoff по временным ошибкам.
- Tool calling через OpenAI-compatible function tools (обработка streaming tool_calls с разнесёнными SSE chunks, malformed JSON, пустых аргументов, отсутствия поддерживаемых tools). Фолбэк при моделях без tool calling с явным предупреждением и безопасным механизмом structured output; ни в коем случае не исполнять произвольный текст модели как shell.
- Контракт инструментов: list_files, read_file с line-ranges и ограничениями размера, grep/search (ripgrep при наличии, fallback), edit_file / apply_patch с контекстом и сохранением переносов строк, create_file, run_command с stdout/stderr, timeout, kill process tree, parse diagnostics, git status/diff; обнаружение корня проекта.
- Предотвращение path traversal, symlink-escape, race, доступа к секретам по умолчанию (.env, *.pem, ssh keys, tokens), ограничение размера, безопасное чтение в UTF-8. Запись и shell требуют разрешения, в пользовательском интерфейсе показываются рабочая папка, diff и команда; grant once/this session/deny. Никакого обхода подтверждений.
- Atomic file replace и backups, undo/rollback для изменений агента (не обещать полную транзакционность внешнего shell). Не стирать незакоммиченные пользовательские изменения. Логи аудита действий без раскрытия секретов.
- Надёжное сохранение сессий и project memory в локальном каталоге пользователя: версионирование схемы, atomic writes, recovery от битых сессий, редактируемые project instructions `AGENTS.md`/эквивалент.

## B. Axiom Context Engine
- Быстрое сканирование структуры репозитория с respect `.gitignore`, glob exclusions, лимитами на файлы/байты, бинарники и кодировки.
- Поиск символов/импортов (tree-sitter опционален только если реально интегрирован) и cheap lexical retrieval + deterministic reranking. Начни с простого интерпретируемого retrieval, не делай «векторную магию» без benchmarks.
- Context budget и prompt compaction; показывай пользователю какие файлы прочитаны. Не подсовывай секреты или гигабайтные логи. Project memory должна быть редактируемой, не самозаполняться личной информацией без запроса.

## C. Axiom Verify
- Обнаружение стека: package.json, pytest, cargo, go, dotnet, tsconfig и др. Предложение соответствующих тестов/линтера/сборки, не запускать опасные скрипты без согласия.
- Компактные ошибки компиляции и тестов с путём, строкой, типом, dedup; итеративное исправление max N, time budget и критерии окончания; отчёт что проверено, что нет, что не удалось.
- CI fixtures для Node/TypeScript, Python, и минимальных проектов с намеренной ошибкой; запрет fake pass.

## D. Axiom Runtime Manager
- Два runtime backend-а на старте: Native llama.cpp и External OpenAI-compatible (LM Studio/Ollama/кастомный URL). Автовыбор только с понятным объяснением и user override. Backend contract для дальнейших интеграций.
- Native: установка проверенной версии `llama-server` под Windows x64 CUDA, безопасный запуск subprocess без shell-инъекции, stdout/stderr, PID/port, readiness, health, stop/graceful kill, очистка stale pid, no hidden services, stop after CLI exit по опции.
- Расчёт offload/ctx по VRAM с реальным измерением; GPU auto-detection через доступные системные API, диагностические сообщения при fallback to CPU, предупреждения OOM. Флаг override пользователя. Никаких гарантий полной загрузки 27B на 12GB.
- Модельный менеджер: `models search` (официальный/доверенный source), download с resume/HTTP range, временный .part, checksum, manifest, license/source/provenance, progress bytes/s, cancel, storage directory, list/import/remove/verify, metadata GGUF. Не собирать произвольные URL моделей в неизвестные системные пути; защититься от zip-slip и неподписанных executable.
- Размеры скачиваний и источники показывать до установки, user opt-in на фоновую работу, обновление/удаление без побочных эффектов.
- Windows 11 + NVIDIA 12GB integration smoke test обязателен. Linux/macOS как архитектурная цель, не объявлять полноценной поддержкой без проверок.

## E. Axiom AutoTune и производительность
- Выбор CPU/GPU/ctx/parallelism и оптимального inference runtime на основании конкретного оборудования, VRAM и реального health-check. Предсказания размера памяти отмечены приблизительными.
- Первичный performance calibration на 1–2 небольших примерах (opt-in): TTFT, prefill, tokens/sec, RAM/VRAM, длина контекста, swap/offload, зависания. Сохраняй результаты локально; профили настроек в JSON.
- Веди clear recommendations: «эта модель слишком велика», «GPU offload=...», «ctx лучше ...», без фиктивных приростов.

## F. AxiomBench
- Воспроизводимый локальный runner с JSONL заданиями, версионируемыми fixtures, seed, моделью/квантом/backend/ctx/prompt и hardware metadata.
- Метрики: successful tasks, tests passed, total wall clock, tool failures, tool-call syntax validity, tokens/sec, memory, user acceptance (если известна). Сравнение baseline модели через простой API и агента при фиксированных условиях. Обязательное разделение train/eval для предотвращения утечки.
- Дай 20–30 проверяемых тестовых coding scenarios для smoke, плюс структуру для 100+; benchmark не должен выдумывать статистику, если задача не запускалась.

## G. AxiomTune: начало исследований, НЕ обязательное обучение при установке
- Отдельный opt-in experimental workspace `training/` с Python окружением и документацией QLoRA/PEFT/TRL/Unsloth на поддерживаемых обучающих чекпойнтах (не считай скачанный GGUF обучаемым исходником).
- Первое направление: tool calling, edit discipline, error recovery на лицензированных данных. Структура JSONL, validator train/eval split, dedup, license/PII filters, фиксация baseline и сравнения. Нужны реальные training scripts с параметрами для 12GB VRAM, безопасными defaults, контроль OOM, checkpoints/resume.
- Реальный LoRA export/adapters и путь к inference-совместимому формату, проверка качества до/после; **не обещать** прирост до измерений.
- Не собирать и не выгружать проекты пользователей для обучения без отдельного informed opt-in. Не включать эксперименты автоматически.

## H. Распространение и качество
- npm глобальная установка команды pilotcode; отдельно осмысленный installer runtime. SemVer, автообновления с проверками и rollback, release notes, HTTPS only, integrity, GitHub Actions CI Windows/Linux (macOS если покрыто), unit/integration/e2e tests, npm pack --dry-run.
- Готовый README на русском и английском: quickstart до первого результата, установка локальной модели, работа без LM Studio, режим External LM Studio, troubleshooting, VRAM, безопасность, лицензии, демонстрация реальных команд.
- Лицензия и NOTICE для зависимостей/бинарников; SBOM при возможности, dependabot/security scan, dependency pinning, секреты не в Git.
- Product UX: terminal onboarding `pilotcode doctor`, guide for model download, suggestions by VRAM tiers, first coding task in <5 min **после загрузки** модели; понятный consent before >GB downloads.
- Никаких логинов для локального использования. Опциональную авторизацию Axiom реализуй через **реальный Device Code Flow** с независимо разрабатываемым API; не делай фиктивный OAuth. Не делай paywall на native inference.
- **Интеграция V1 с сайтом/сервером:** backend в репозитории сайта `zaoastronaftik-bit/axiom-pilot-code.PAGES/server` предоставляет `POST /api/device?action=start` → `{deviceCode,userCode,verificationUri,expiresIn,interval}`, `POST /api/device?action=poll` → HTTP 202 pending или `{status:"authorized",accessToken:"axiom_cli_..."}`, `GET /api/cli` с `Authorization: Bearer <CLI token>` для проверки токена и тарифа. В браузере пользователь входит в Axiom Account и отдельно подтверждает код через `POST /api/device?action=approve`; никакого автоматического подтверждения. CLI должен показывать короткий код и открывать `verificationUri` только с согласия пользователя, опрашивать не чаще чем `interval`, соблюдать таймаут 10 минут, отмену и остановку, хранить полученный токен в OS secret store (Windows Credential Manager/DPAPI; не в обычном файле проекта), уметь `/login`, `/logout`, `/whoami`, а базовые локальные функции работать офлайн без входа. Перед объявлением готовности проверь реальный backend с тестовым аккаунтом, а не просто наличие эндпоинтов. Backend пока является release candidate — API может быть скорректирован, поэтому согласовывай формат и ошибки с его текущим кодом. Реализуй возможность отзывать CLI-токены на сервере и в интерфейсе аккаунта; не оставляй секреты бессрочно действующими. Без подключённой базы и HTTPS API показывай честное «сервис временно недоступен», а не симулируй вход.

## Процесс и результат
1. Начни с аудита текущего репо, существующих ошибок и рисков; перечисли честный scope, архитектуру, ADR и фазовый план без произвольного переписывания.
2. Сразу реализуй минимальный vertical slice native inference end-to-end: installer/runtime process -> model -> chat completion -> tool call -> workspace edit -> verify -> persist session. Затем расширяй компоненты.
3. Пиши исходники и тесты в реальный репозиторий, показывай diffs, запускай `npm test`, `npm run check`, smoke и Windows CI. Если нет доступа к GPU или интернету, явно укажи непроверенное; не придумывай успешные benchmarks.
4. Сделай security review: threat model, supply-chain artifacts, RCE boundaries, command approvals, symlink/path traversal, secrets, cancellation, OOM.
5. Заверши release readiness matrix: feature | implemented | tested | limitations, воспроизводимые команды, CHANGELOG, список известных проблем, и план от beta к V1. Называй **V1.0 только когда критерии пройдены**; если нет — честно пометь candidate и объясни блокеры.

## Критерии приёмки
- Чистая установка на Windows 11 x64, Node 22+, без предварительного LM Studio; native CUDA runtime реально поднимает 7–9B GGUF в поддерживаемой квантизации на 12GB GPU после явного согласия на скачивание.
- Безопасно открывает локальный проект, спрашивает разрешение перед записью/командой, меняет файл, показывает diff, запускает проверку, сохраняет и восстанавливает сессию.
- Стабильно реагирует на неправильный tool-call JSON, отсутствующую модель, потерю API, OOM, отмену пользователем, закрытие процесса и невалидные пути без порчи проекта.
- Fast и Deep используют ровно одну выбранную модель и один backend без скрытых сетевых fallback; конфиденциальные файлы по умолчанию не покидают устройство.
- AxiomBench реально запускал baseline и агент на тех же фиксированных задачах; любые заявления об улучшениях подтверждаются результатами и машиной тестирования.
- Документация, лицензии, CI и npm паковка работают; опубликованы только реально готовые features, а не макеты.

**Приоритет по ресурсам: надёжный native runtime и безопасный coding loop > context/verify > autotune/model hub > benchmark > отдельные эксперименты AxiomTune. Не жертвуй безопасностью, законностью или воспроизводимостью ради слова V1.**
