#!/usr/bin/env python3
"""Small, local-first mirror demo with a Telegram command.

The server never downloads or rewrites the target site.  It only stores a
validated http(s) URL and the browser opens that URL in a sandboxed iframe.
That keeps the demo useful for a course project without turning it into an
open reverse proxy.
"""

from __future__ import annotations

import json
import os
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

BASE_DIR = Path(__file__).resolve().parent
STATE_PATH = Path(os.environ.get("MIRROR_STATE_FILE", BASE_DIR / "mirror_state.json"))
PORT = int(os.environ.get("PORT", "3000"))
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
PUBLIC_HOST = os.environ.get("PUBLIC_HOST", "localhost")

STATE_LOCK = threading.Lock()
STATE: dict[str, Any] = {"url": "", "updated_at": None}


def load_state() -> None:
    """Restore the last target when the hosting process restarts."""
    global STATE
    try:
        loaded = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if isinstance(loaded, dict) and isinstance(loaded.get("url", ""), str):
            STATE = {
                "url": loaded.get("url", ""),
                "updated_at": loaded.get("updated_at"),
            }
    except (FileNotFoundError, OSError, ValueError):
        pass


def save_state() -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = STATE_PATH.with_suffix(".tmp")
    temporary_path.write_text(json.dumps(STATE, ensure_ascii=False), encoding="utf-8")
    temporary_path.replace(STATE_PATH)


def validate_target(raw_url: str) -> str:
    """Accept only ordinary web URLs; never accept credentials or script URLs."""
    target = raw_url.strip().strip("<>")
    if len(target) > 2048:
        raise ValueError("Ссылка слишком длинная (максимум 2048 символов).")

    parsed = urlsplit(target)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise ValueError("Нужна ссылка, начинающаяся с http:// или https://.")
    if not parsed.netloc or not parsed.hostname:
        raise ValueError("В ссылке не найден адрес сайта.")
    if parsed.username or parsed.password:
        raise ValueError("Ссылки с логином и паролем запрещены.")

    # Rebuild a canonical form without a fragment. Fragments never reach a
    # server and can otherwise make the stored value needlessly confusing.
    clean = parsed._replace(fragment="").geturl()
    return clean


def current_target() -> str:
    with STATE_LOCK:
        return str(STATE.get("url", ""))


def set_target(target: str) -> None:
    with STATE_LOCK:
        STATE["url"] = target
        STATE["updated_at"] = int(time.time())
        save_state()


def clear_target() -> None:
    with STATE_LOCK:
        STATE["url"] = ""
        STATE["updated_at"] = int(time.time())
        save_state()


def mirror_url() -> str:
    return PUBLIC_BASE_URL or f"http://{PUBLIC_HOST}:{PORT}/"


class MirrorRequestHandler(SimpleHTTPRequestHandler):
    """Serve only the small frontend and the read-only target endpoint."""

    # SimpleHTTPRequestHandler uses this directory for the three frontend
    # files. No external site is fetched by this process.
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        path = urlsplit(self.path).path
        if path == "/api/target":
            with STATE_LOCK:
                payload = {"url": STATE.get("url", ""), "updated_at": STATE.get("updated_at")}
            self._send_json(payload)
            return

        if path == "/api/health":
            self._send_json({"ok": True})
            return

        # Keep the public surface intentionally small. In particular, do not
        # expose main.py, the state file, or the repository's .git directory.
        if path not in {"/", "/index.html", "/styles.css", "/script.js"}:
            self.send_error(404)
            return

        super().do_GET()

    def log_message(self, format: str, *args: Any) -> None:
        # Keep hosting logs readable and avoid printing potentially long URLs.
        print(f"[web] {self.address_string()} - {format % args}")


class TelegramBot:
    """Minimal Telegram Bot API long-poller using only the Python stdlib."""

    def __init__(self, token: str, allowed_chat_ids: set[int]) -> None:
        self.api_url = f"https://api.telegram.org/bot{token}/"
        self.allowed_chat_ids = allowed_chat_ids
        self.stopped = threading.Event()

    def api_call(self, method: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        data = json.dumps(payload or {}).encode("utf-8")
        request = Request(
            self.api_url + method,
            data=data,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=40) as response:
            result = json.loads(response.read().decode("utf-8"))
        if not result.get("ok"):
            raise RuntimeError(result.get("description", "Telegram API error"))
        return result

    def send_message(self, chat_id: int, text: str) -> None:
        self.api_call("sendMessage", {"chat_id": chat_id, "text": text})

    def is_allowed(self, chat_id: int) -> bool:
        # An allowlist can be enabled on BotHost; an empty list is convenient
        # for a private course bot during local testing.
        return not self.allowed_chat_ids or chat_id in self.allowed_chat_ids

    def handle_message(self, message: dict[str, Any]) -> None:
        chat = message.get("chat", {})
        chat_id = chat.get("id")
        text = message.get("text", "")
        if not isinstance(chat_id, int) or not isinstance(text, str):
            return
        if not self.is_allowed(chat_id):
            self.send_message(chat_id, "У этого чата нет доступа к зеркалу.")
            return

        parts = text.strip().split(maxsplit=1)
        command = parts[0].split("@", 1)[0].lower() if parts else ""
        argument = parts[1].strip() if len(parts) == 2 else ""

        if command in {"/start", "/help"}:
            self.send_message(
                chat_id,
                "Команды зеркала:\n"
                "/mirror <ссылка> — установить тестовую страницу\n"
                "/show — показать текущую ссылку\n"
                "/clear — очистить зеркало",
            )
            return

        if command in {"/mirror", "/setmirror"}:
            if not argument:
                self.send_message(chat_id, "Формат: /mirror https://example.test/page")
                return
            try:
                target = validate_target(argument)
            except ValueError as error:
                self.send_message(chat_id, str(error))
                return

            set_target(target)
            self.send_message(chat_id, f"Готово. Зеркало открыто:\n{mirror_url()}\n\nТестовая ссылка: {target}")
            return

        if command == "/show":
            target = current_target()
            if target:
                self.send_message(chat_id, f"Текущая ссылка:\n{target}\n\nЗеркало: {mirror_url()}")
            else:
                self.send_message(chat_id, "Ссылка ещё не установлена. Используйте /mirror <ссылка>.")
            return

        if command == "/clear":
            clear_target()
            self.send_message(chat_id, "Ссылка очищена. Зеркало снова ждёт команду /mirror <ссылка>.")

    def run(self) -> None:
        try:
            self.api_call("deleteWebhook", {"drop_pending_updates": False})
        except (HTTPError, URLError, OSError, RuntimeError) as error:
            print(f"[bot] не удалось подготовить polling: {error}")

        offset: int | None = None
        while not self.stopped.is_set():
            try:
                payload: dict[str, Any] = {"timeout": 25, "allowed_updates": ["message"]}
                if offset is not None:
                    payload["offset"] = offset
                result = self.api_call("getUpdates", payload)
                for update in result.get("result", []):
                    offset = int(update["update_id"]) + 1
                    try:
                        self.handle_message(update.get("message", {}))
                    except (HTTPError, URLError, OSError, RuntimeError) as error:
                        print(f"[bot] ошибка обработки сообщения: {error}")
            except (HTTPError, URLError, OSError, TimeoutError, ValueError, RuntimeError) as error:
                print(f"[bot] polling: {error}; повтор через 3 секунды")
                self.stopped.wait(3)


def parse_allowed_chat_ids() -> set[int]:
    raw = os.environ.get("BOT_ALLOWED_CHAT_IDS", "")
    values: set[int] = set()
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        try:
            values.add(int(item))
        except ValueError:
            print(f"[config] пропущен некорректный chat id: {item!r}")
    return values


def main() -> None:
    load_state()

    bot_token = os.environ.get("BOT_TOKEN", "").strip()
    if bot_token:
        bot = TelegramBot(bot_token, parse_allowed_chat_ids())
        threading.Thread(target=bot.run, name="telegram-polling", daemon=True).start()
        print("[bot] polling запущен")
    else:
        print("[bot] BOT_TOKEN не задан — веб-сервер запущен без Telegram-бота")

    server = ThreadingHTTPServer(("0.0.0.0", PORT), MirrorRequestHandler)
    print(f"[web] зеркало доступно на http://0.0.0.0:{PORT}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[web] остановка")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
