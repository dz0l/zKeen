# zKeen UI

Панель управления XKeen / Mihomo для роутеров Keenetic с Entware.

## Возможности

- Управление proxy-группами и узлами
- Редактор config.yaml с валидацией
- Быстрые настройки (Core, DNS, Sniffer, Providers, Geo)
- GUI для создания групп и per-IP политик
- Бэкапы конфигурации
- Обновления mihomo, xkeen, zkeen-ui
- Safe / Expert режимы работы
- Mobile-first интерфейс

## Требования

- Роутер Keenetic с установленным Entware
- Не менее **15 МБ** свободного места на разделе Entware
- Установленный `curl`

Флаги установки:

```sh
sh install.sh --install-xkeen    # установить XKeen без запроса (если отсутствует)
sh install.sh --skip-xkeen-check # пропустить проверку XKeen/Mihomo
```

## Установка

```sh
curl -fsSL https://raw.githubusercontent.com/dz0l/zKeen/main/install.sh | sh
```

Скрипт выполнит:
1. Проверку XKeen и Mihomo (предложит установку XKeen при необходимости)
2. Проверку архитектуры (aarch64 / mipsle)
3. Проверку свободного места
4. Проверку доступности репозитория
5. Загрузку бинарника `zkeen-ui`
6. Создание init-скрипта `S99zkeen-ui`
7. Шаблон `/opt/etc/mihomo/config.yaml` (если отсутствует)
8. Запуск панели на порту `7220`

После установки панель доступна: `http://<IP роутера>:7220`

## Обновление

Через панель: **Настройки → Обновления → zkeen-ui**

Или через SSH:

```sh
curl -fsSL https://raw.githubusercontent.com/dz0l/zKeen/main/install.sh | sh -s -- --update
```

## Удаление

```sh
/opt/etc/init.d/S99zkeen-ui stop
rm -f /opt/sbin/zkeen-ui /opt/etc/init.d/S99zkeen-ui
rm -f /opt/etc/xkeen/zkeen-ui.json
```

## Команды

```sh
zkeen-ui                    # запуск на порту 7220
zkeen-ui -p 8080            # запуск на порту 8080
zkeen-ui create-init        # создать init-скрипт
zkeen-ui start              # запустить сервис
zkeen-ui stop               # остановить сервис
zkeen-ui restart            # перезапустить
zkeen-ui status             # статус сервиса
zkeen-ui reset-password     # сбросить пароль
zkeen-ui -v                 # версия
```
