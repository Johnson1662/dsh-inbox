#!/usr/bin/env python3
"""Telegram 来源：Telethon 用户会话 → stdout 一行一个信封（NDJSON）。

这一路只负责"把看见的东西交上来"：不做判断、不摘要、不截断正文。
stdout 只放信封，一个字节的日志都不许混进去；日志一律走 stderr。

环境变量（supervisor 注入的 PERSONAL_CONTEXT_SOURCE_*；手工单独跑时也认 PERSONAL_CONTEXT_TELEGRAM_* 同名变量）：
  PERSONAL_CONTEXT_STATE_DIR           状态目录；水位存 <state>/watermarks/telegram.json
  PERSONAL_CONTEXT_SOURCE_SESSION      会话文件（没有扩展名时补 .session）
  PERSONAL_CONTEXT_SOURCE_API_ID       api_id
  PERSONAL_CONTEXT_SOURCE_API_HASH     api_hash
  PERSONAL_CONTEXT_SOURCE_INTERVAL_MS  轮询间隔，默认 8000
  PERSONAL_CONTEXT_SOURCE_BACKFILL     首轮回溯条数，默认 0 = 只从当前最新开始，不补历史
  PERSONAL_CONTEXT_SOURCE_PROXY        代理，形如 socks5://host:port
  PERSONAL_CONTEXT_SOURCE_CHATS        逗号分隔的 chat（数字 id 或 @username），空 = 全部 dialogs
  PERSONAL_CONTEXT_SOURCE_PYTHON       指定解释器（可选；不给就自己探）
  PERSONAL_CONTEXT_SOURCE_ONCE         1 = 只跑一轮就退出（真机验活用；和 PERSONAL_CONTEXT_SOURCE_BACKFILL=1 搭配能看到一行）

退出码：SIGTERM / SIGINT 干净退出 0；任何配置或环境问题打印中文错误并退出 1。
"""

import asyncio
import json
import os
import signal
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

# 一轮最多消化多少条：装不下就下一轮接着取，水位只推进到已发出的最后一条，不跳号。
MAX_PER_ROUND = 200

# 探 Telethon 时找哪些位置：venv 目录名 × 常见 Python 路径
VENV_DIRS = ('.venv', 'venv', 'env')
PYTHON_NAMES = ('python3', 'python')
SEARCH_ROOTS = (
    '~/.dsh',
    '~/PersonalAgent',
    '~/Dev/PersonalAgent',
    '~/Development/PersonalAgent',
    '~/Projects/PersonalAgent',
    '~/personal-agent',
)
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', 'site-packages', 'dist', 'build', '.mypy_cache'}
MAX_DEPTH = 8


def log(message):
    print(f"telegram: {message}", file=sys.stderr, flush=True)


def die(message):
    """清晰的失败：打印中文原因，退出 1。绝不把 import 崩栈丢给用户。"""
    print(f"telegram: {message}", file=sys.stderr, flush=True)
    sys.exit(1)


# ---------------------------------------------------------------- 解释器探测


def has_telethon(python):
    try:
        done = subprocess.run(
            [python, '-c', 'import telethon'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0


def resolve_interpreter(path, seen):
    """候选路径 → 可执行文件的绝对路径；不可用或已见过就返回 None。

    用 abspath 而不是 realpath 做身份：venv 里的 python3 是指向系统 python 的
    软链，realpath 会把两个解释器抹成同一个，venv 就永远轮不到。
    """
    try:
        found = os.path.abspath(os.path.expanduser(str(path)))
    except (OSError, ValueError):
        return None
    if found in seen or not os.path.isfile(found) or not os.access(found, os.X_OK):
        return None
    seen.add(found)
    return found


def is_venv(dirpath):
    """认 pyvenv.cfg 而不是目录名：venv 叫什么都有可能（.venv / venv / 项目自定义名）。"""
    return os.path.exists(os.path.join(dirpath, 'pyvenv.cfg')) or os.path.basename(dirpath) in VENV_DIRS


def venv_interpreters(venv_dir, seen):
    """一个 venv 里能用的解释器，按 PYTHON_NAMES 的顺序。"""
    for name in PYTHON_NAMES:
        found = resolve_interpreter(os.path.join(venv_dir, 'bin', name), seen)
        if found:
            yield found


def find_venvs(root):
    """在搜索根下找 venv 目录；深度封顶，噪音目录不进。"""
    base = os.path.expanduser(root)
    if not os.path.isdir(base):
        return
    for dirpath, dirnames, _ in os.walk(base):
        if dirpath[len(base):].count(os.sep) >= MAX_DEPTH:
            dirnames[:] = []
            continue
        if is_venv(dirpath):
            dirnames[:] = []
            yield dirpath
            continue
        dirnames[:] = [name for name in dirnames
                       if name not in SKIP_DIRS and (name in VENV_DIRS or not name.startswith('.'))]


def candidate_pythons():
    """按"最可能装过 Telethon"的顺序列出候选解释器。"""
    seen = set()
    current = resolve_interpreter(sys.executable, seen)
    if current:
        yield current
    for root in SEARCH_ROOTS:
        for venv in find_venvs(root):
            yield from venv_interpreters(venv, seen)


def override_interpreter():
    """PERSONAL_CONTEXT_SOURCE_PYTHON 显式指定的解释器；没给就是 None。"""
    raw = os.environ.get('PERSONAL_CONTEXT_SOURCE_PYTHON') or os.environ.get('PERSONAL_CONTEXT_TELEGRAM_PYTHON')
    return os.path.expanduser(raw) if raw else None


def interpreter_with_telethon():
    """除当前解释器之外，第一个能 import telethon 的候选；没有就是 None。"""
    for python in candidate_pythons():
        if os.path.abspath(python) == os.path.abspath(sys.executable):
            continue
        if has_telethon(python):
            return python
    return None


def ensure_telethon():
    """确保当前解释器能 import telethon；能换就 os.execv 换过去，换不了就退出 1。"""
    if has_telethon(sys.executable):
        return

    override = override_interpreter()
    if override:
        if not has_telethon(override):
            die(f'PERSONAL_CONTEXT_SOURCE_PYTHON={override} 里没有 telethon。先 `{override} -m pip install telethon`，或换个解释器。')
        reexec(override)

    # 已经换过一次还不行：别再换，避免 exec 死循环
    if os.environ.get('PERSONAL_CONTEXT_SOURCE_PYTHON_PROBED') == '1':
        die(f'解释器 {sys.executable} 仍然没有 telethon。请 `{sys.executable} -m pip install telethon`。')

    log(f'当前解释器 {sys.executable} 没有 telethon，开始找带 telethon 的解释器')
    found = interpreter_with_telethon()
    if found:
        log(f'改用 {found} 重新执行')
        reexec(found)

    die(
        '找不到装了 telethon 的 Python 解释器。请任选一种办法：\n'
        '  1) 用 PERSONAL_CONTEXT_SOURCE_PYTHON=/path/to/python3 指定一个装过 telethon 的解释器\n'
        '  2) 给当前解释器装依赖：python3 -m pip install telethon\n'
        '  3) 在 ~/.dsh 或 PersonalAgent 下建一个 venv 并装上 telethon'
    )


def reexec(python):
    """换成找到的解释器继续跑同一个脚本；带标记，避免无限 exec。"""
    env = dict(os.environ)
    env['PERSONAL_CONTEXT_SOURCE_PYTHON_PROBED'] = '1'
    log(f'exec {python} {os.path.abspath(__file__)}')
    try:
        os.execve(python, [python, os.path.abspath(__file__), *sys.argv[1:]], env)
    except OSError as error:
        die(f'换成 {python} 失败：{error}')
    die('换了却没能重新执行，放弃')  # 理论上到不了


# ---------------------------------------------------------------- 配置


def env(name, default=None):
    """PERSONAL_CONTEXT_SOURCE_X 优先；没走 supervisor（手工跑）时认 PERSONAL_CONTEXT_TELEGRAM_X。"""
    for key in (f'PERSONAL_CONTEXT_SOURCE_{name}', f'PERSONAL_CONTEXT_TELEGRAM_{name}'):
        value = os.environ.get(key)
        if value is not None and value != '':
            return value
    return default


def env_int(name, default, minimum=0):
    raw = env(name)
    if raw is None:
        return default
    try:
        value = int(str(raw).strip())
    except ValueError:
        die(f'{name} 必须是整数，现在是 {raw!r}')
    if value < minimum:
        die(f'{name} 不能小于 {minimum}，现在是 {value}')
    return value


TRUE_WORDS = {'1', 'true', 'yes', 'on'}


def env_bool(name, default=False):
    raw = env(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in TRUE_WORDS


def parse_proxy(raw):
    """socks5://host:port → Telethon 的 proxy 字典。"""
    if not raw:
        return None
    text = raw if '://' in raw else f'socks5://{raw}'
    parts = urlsplit(text)
    scheme = (parts.scheme or '').lower()
    if scheme not in ('socks5', 'socks4', 'http'):
        die(f'PERSONAL_CONTEXT_SOURCE_PROXY 的协议只支持 socks5 / socks4 / http，现在是 {scheme!r}')
    if not parts.hostname or not parts.port:
        die(f'PERSONAL_CONTEXT_SOURCE_PROXY 要写成 scheme://host:port，现在是 {raw!r}')
    proxy = {'proxy_type': scheme, 'addr': parts.hostname, 'port': parts.port, 'rdns': True}
    if parts.username:
        proxy['username'] = parts.username
        proxy['password'] = parts.password or ''
    return proxy


def require_credentials():
    """api_id / api_hash / session 三件套：缺一个就点名退出，不猜。"""
    api_id = env('API_ID')
    api_hash = env('API_HASH')
    session = env('SESSION')
    missing = [name for name, value in (('PERSONAL_CONTEXT_SOURCE_API_ID', api_id),
                                        ('PERSONAL_CONTEXT_SOURCE_API_HASH', api_hash),
                                        ('PERSONAL_CONTEXT_SOURCE_SESSION', session)) if not value]
    if missing:
        die(f'缺少 Telegram 凭据：{", ".join(missing)}（写进 <stateDir>/sources.env）')
    try:
        api_id = int(str(api_id).strip())
    except ValueError:
        die(f'PERSONAL_CONTEXT_SOURCE_API_ID 必须是整数，现在是 {api_id!r}')
    return api_id, api_hash, session


def session_file(session):
    """展开 ~ 并补 .session 后缀（Telethon 会自己加，显式补上才好写日志）。"""
    path = os.path.expanduser(session)
    return path if Path(path).suffix else path + '.session'


def resolve_state_dir():
    """supervisor 给的是 PERSONAL_CONTEXT_STATE_DIR；PERSONAL_CONTEXT_SOURCE_STATE_DIR 留给配置里显式写 stateDir 的情况。"""
    raw = env('STATE_DIR') or os.environ.get('PERSONAL_CONTEXT_STATE_DIR') or '~/.dsh/state/personal-context'
    return Path(os.path.expanduser(raw))


def parse_chats(raw):
    """'a, @b ,c' → ['a', '@b', 'c']；空值就是空列表（= 全部会话）。"""
    return [item.strip() for item in (raw or '').split(',') if item.strip()]


def load_config():
    api_id, api_hash, session = require_credentials()
    return {
        'api_id': api_id,
        'api_hash': api_hash,
        'session': session_file(session),
        'interval': env_int('INTERVAL_MS', 8000, minimum=200),
        'backfill': env_int('BACKFILL', 0),
        'once': env_bool('ONCE', False),
        'proxy': parse_proxy(env('PROXY')),
        'chats': parse_chats(env('CHATS', '')),
        'state_dir': resolve_state_dir(),
    }


# ---------------------------------------------------------------- 水位


class Watermarks:
    """每个 chat 一个 msg_id 水位，落在 <state>/watermarks/telegram.json。

    写坏了不算致命：读不出来就当空的（顶多多采一轮，队列按 id 去重）。
    """

    def __init__(self, path):
        self.path = Path(path)
        self.data = {}
        try:
            if self.path.exists():
                loaded = json.loads(self.path.read_text('utf-8'))
                if isinstance(loaded, dict):
                    self.data = loaded
                else:
                    log('水位文件不是对象，忽略')
        except (OSError, ValueError) as error:
            log(f'水位文件读不出来，当作空的：{error}')

    def get(self, chat_id):
        value = self.data.get(str(chat_id))
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.lstrip('-').isdigit():
            return int(value)
        return None

    def set(self, chat_id, msg_id):
        if msg_id is None:
            return
        self.data[str(chat_id)] = int(msg_id)
        self.save()

    def save(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(self.path.name + '.tmp')
            tmp.write_text(json.dumps(self.data, indent=2, sort_keys=True) + '\n', 'utf-8')
            os.replace(tmp, self.path)
        except OSError as error:
            log(f'水位写不进去（继续跑，下一轮可能重采）：{error}')


# ---------------------------------------------------------------- 采集


def display_name(entity, fallback=''):
    if entity is None:
        return fallback
    first = getattr(entity, 'first_name', None) or ''
    last = getattr(entity, 'last_name', None) or ''
    full = ' '.join(part for part in (first, last) if part).strip()
    return full or getattr(entity, 'title', None) or getattr(entity, 'username', None) or fallback


def chat_title(entity):
    return getattr(entity, 'title', None) or display_name(entity)


def peer_id(entity):
    from telethon import utils
    return str(utils.get_peer_id(entity))


async def resolve_targets(client, cfg):
    """PERSONAL_CONTEXT_SOURCE_CHATS 有值就只盯这几个 chat；没有就全部 dialogs。"""
    if not cfg['chats']:
        async for dialog in client.iter_dialogs():
            yield dialog.entity, dialog.name or chat_title(dialog.entity)
        return
    for item in cfg['chats']:
        key = int(item) if item.lstrip('-').isdigit() else item
        try:
            entity = await client.get_entity(key)
        except Exception as error:  # noqa: BLE001 —— 一个 chat 解析不了不影响别的
            log(f'chat {item} 解析不了，跳过：{type(error).__name__}: {error}')
            continue
        yield entity, chat_title(entity)


async def sender_name(message, cache):
    sender_id = getattr(message, 'sender_id', None)
    if sender_id is not None and sender_id in cache:
        return cache[sender_id]
    try:
        sender = await message.get_sender()
    except Exception:  # noqa: BLE001 —— 拿不到名字就用 id 顶上，不能因此丢消息
        sender = None
    name = display_name(sender, '' if sender_id is None else str(sender_id))
    if sender_id is not None:
        cache[sender_id] = name
    return name


async def emit(message, chat, cache):
    when = getattr(message, 'date', None)
    envelope = {
        'id': f'telegram:{message.chat_id}:{message.id}',
        'source': 'telegram',
        # 信封要求带时区；Telethon 给的是 aware 的 UTC
        'at': when.isoformat() if when is not None else datetime.now(timezone.utc).isoformat(),
        'actor': 'self' if getattr(message, 'out', False) else 'other',
        'text': message.text or '',
        'meta': {
            'chat': chat,
            'chat_id': str(message.chat_id),
            'sender': await sender_name(message, cache),
            'sender_id': '' if getattr(message, 'sender_id', None) is None else str(message.sender_id),
        },
    }
    print(json.dumps(envelope, ensure_ascii=False), flush=True)


async def emit_all(messages, chat, cache):
    """逐条发；单条发不出去只丢这一条，不能让一个坏消息把整个 chat 卡住。"""
    sent = 0
    for message in messages:
        try:
            await emit(message, chat, cache)
            sent += 1
        except Exception as error:  # noqa: BLE001
            log(f'{chat}: 消息 {getattr(message, "id", "?")} 发不出去，跳过：{type(error).__name__}: {error}')
    return sent


async def latest_id(client, entity):
    try:
        messages = await client.get_messages(entity, limit=1)
    except Exception as error:  # noqa: BLE001
        log(f'取最新消息失败：{type(error).__name__}: {error}')
        return None
    return messages[0].id if messages else 0


async def poll_chat(client, cfg, watermarks, entity, chat):
    """取一个 chat 的新消息。返回本轮发出去的条数。"""
    key = peer_id(entity)
    since = watermarks.get(key)
    cache = {}

    if since is None:
        # 第一次见这个 chat：默认不回溯历史，水位直接设到当前最新
        if cfg['backfill'] > 0:
            try:
                messages = await client.get_messages(entity, limit=cfg['backfill'])
            except Exception as error:  # noqa: BLE001
                log(f'{chat}: 回填失败：{type(error).__name__}: {error}')
                return 0
            messages = sorted(messages, key=lambda item: item.id)
            sent = await emit_all(messages, chat, cache)
            if messages:
                watermarks.set(key, messages[-1].id)
            else:
                watermarks.set(key, await latest_id(client, entity))
            log(f'{chat}: 首次回填 {sent} 条')
            return sent

        watermark = await latest_id(client, entity)
        if watermark is None:
            return 0
        watermarks.set(key, watermark)
        log(f'{chat}: 首轮不回溯历史，水位设到 {watermark}')
        return 0

    try:
        pending = []
        async for message in client.iter_messages(entity, min_id=since, reverse=True, limit=MAX_PER_ROUND):
            pending.append(message)
    except Exception as error:  # noqa: BLE001
        log(f'{chat}: 拉消息失败：{type(error).__name__}: {error}')
        return 0

    sent = await emit_all(pending, chat, cache)
    if pending:
        watermarks.set(key, pending[-1].id)
    if len(pending) >= MAX_PER_ROUND:
        log(f'{chat}: 一轮上限 {MAX_PER_ROUND} 条，剩下的下一轮继续')
    return sent


async def poll_once(client, cfg, watermarks):
    total = 0
    seen = 0
    async for entity, chat in resolve_targets(client, cfg):
        seen += 1
        total += await poll_chat(client, cfg, watermarks, entity, chat)
    return total, seen


# ---------------------------------------------------------------- 主循环


async def run(cfg):
    from telethon import TelegramClient

    try:
        client = TelegramClient(cfg['session'], cfg['api_id'], cfg['api_hash'], proxy=cfg['proxy'])
    except ImportError as error:
        # 指定了代理但没装 python-socks 之类
        die(f'代理参数用不了，缺依赖：{error}\n  装上：python3 -m pip install "telethon[proxy]"')

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))

    try:
        await client.connect()
    except Exception as error:  # noqa: BLE001
        die(f'连不上 Telegram：{type(error).__name__}: {error}')

    if not await client.is_user_authorized():
        await client.disconnect()
        die(f'会话未授权：{cfg["session"]}。先用这个会话文件手工登录一次，再交回来。')

    me = await client.get_me()
    log(f'已连接：{display_name(me, str(getattr(me, "id", "?")))} (@{getattr(me, "username", None) or "-"})')
    log(f'会话文件：{cfg["session"]}')
    log(f'状态目录：{cfg["state_dir"]}')
    log(f'间隔 {cfg["interval"]}ms，回填 {cfg["backfill"]} 条，'
        f'代理 {"无" if not cfg["proxy"] else cfg["proxy"]["addr"] + ":" + str(cfg["proxy"]["port"])}，'
        f'chats {"全部 dialogs" if not cfg["chats"] else "、".join(cfg["chats"])}')
    if cfg['once']:
        log('PERSONAL_CONTEXT_SOURCE_ONCE=1：只跑一轮')

    watermarks = Watermarks(cfg['state_dir'] / 'watermarks' / 'telegram.json')

    while not stop.is_set():
        try:
            count, chats = await poll_once(client, cfg, watermarks)
            if count:
                log(f'一轮：{chats} 个 chat，发出 {count} 条')
        except Exception as error:  # noqa: BLE001 —— 一轮失败不退出，下一轮再来
            log(f'这一轮失败：{type(error).__name__}: {error}')
        if cfg['once']:
            log('PERSONAL_CONTEXT_SOURCE_ONCE=1：跑完一轮就走')
            break
        try:
            await asyncio.wait_for(stop.wait(), timeout=cfg['interval'] / 1000)
        except asyncio.TimeoutError:
            pass

    log('收到退出信号，断开连接' if stop.is_set() else '跑完了，断开连接')
    try:
        await client.disconnect()
    except Exception as error:  # noqa: BLE001
        log(f'断开时出错（不影响退出）：{error}')
    return 0


def main():
    ensure_telethon()
    import telethon

    log(f'python：{sys.executable}')
    log(f'telethon：{getattr(telethon, "__version__", "?")}')
    cfg = load_config()
    try:
        code = asyncio.run(run(cfg))
    except KeyboardInterrupt:
        code = 0
    return code


if __name__ == '__main__':
    sys.exit(main())
