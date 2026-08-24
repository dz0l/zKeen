# zKeen UI

[English](README.md)

Панель управления **XKeen** / **Mihomo** для устройств с Entware (основной сценарий - Keenetic).

## Требования

- Основной сценарий: Keenetic с Entware (используется `opkg` и ожидается структура путей/зависимостей как в Entware).
 *- Теоретически можно и на других устройствах с Entware, а также на Linux-ПК - **если** доступны совместимые бинарники/архитектура и есть запись в* `/opt`*. На неподдерживаемых платформах установка может не взлететь автоматически.*
- ~ **15 МБ** свободно на разделе `/opt`

```sh
opkg update
opkg install curl ca-certificates
```

## Установка (stable)

по SSH:

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/dz0l/zKeen/main/install.sh)"
```

Скрипт установит **zkeen-ui**, при необходимости - **XKeen** и **Mihomo**.

Панель: `http://<IP_или_хост>:7220`

Если вы запускаете через Keenetic и используете policy routing: после установки добавьте устройства в **политику XKeen** в веб-интерфейсе Keenetic. На других роутерах/ПК настройте аналогичные правила маршрутизации/политик для трафика (NAT / Policy routing) согласно вашей платформе.

## Beta (тестовые сборки)

**beta** (GitHub Pre-release). Stable (**Latest**).

```sh
# перейти на beta
sh -c "$(curl -fsSL https://raw.githubusercontent.com/dz0l/zKeen/main/install.sh)" -- beta
```

**Канал запоминается** в `/opt/etc/xkeen/zkeen-ui.channel`. Дальнейшие обновления без смены канала остаются на beta:

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/dz0l/zKeen/main/install.sh)" -- --update
```

Вернуться на stable:

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/dz0l/zKeen/main/install.sh)" -- --stable
# или сразу обновить до Latest:
sh -c "$(curl -fsSL https://raw.githubusercontent.com/dz0l/zKeen/main/install.sh)" -- --update --stable
```

Проверка:

```sh
cat /opt/etc/xkeen/zkeen-ui.channel   # beta | stable
zkeen-ui -v
```

для тестеров:

- Beta может содержать незавершённые изменения; перед тестом желателен бэкап `/opt/etc/mihomo/config.yaml`.
- Обновление из панели (**Настройки -> Обновления**) ориентируется на stable (Latest). Для beta используйте команды по SSH.
- Список pre-release: [Releases](https://github.com/dz0l/zKeen/releases)



## Скриншоты

*в процессе*



## Обновление

В панели (stable): **Настройки -> Обновления -> zkeen-ui**

Или по SSH (учитывает сохранённый канал `stable` / `beta`):

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/dz0l/zKeen/main/install.sh)" -- --update
```



## Удаление

```sh
/opt/etc/init.d/S99zkeen-ui stop
rm -f /opt/sbin/zkeen-ui /opt/etc/init.d/S99zkeen-ui
rm -f /opt/etc/xkeen/zkeen-ui.json
rm -f /opt/etc/xkeen/zkeen-ui.channel
```

Конфиги Mihomo (`/opt/etc/mihomo`) и XKeen скрипт не удаляет.

## Команды

```sh
zkeen-ui -v                 # версия
zkeen-ui -p 8080            # порт (по умолчанию 7220)
/opt/etc/init.d/S99zkeen-ui start|stop|restart|status
zkeen-ui reset-password     # сброс пароля панели
```
