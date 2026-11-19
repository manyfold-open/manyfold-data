#!/usr/bin/env python3
"""Stdlib-only SQLite self-learning memory CLI for the Manyfold Data guide.

Stores user and room preferences, per-speaker language settings, missing-dataset
demand logs, and user feedback under ~/.cache/mfd/memory.sqlite3 (overridable
via MFD_MEMORY_DB or --db).
"""

import argparse
import os
import re
import sqlite3
import sys
import time
import unicodedata

DEFAULT_DB = os.path.expanduser('~/.cache/mfd/memory.sqlite3')
ENV_DB = 'MFD_MEMORY_DB'
APP_LABEL = 'Manyfold Data'
MAX_MEMORIES_PER_SCOPE = 50
VALID_LANGS = ('zh-Hant', 'zh-Hans', 'en')
VALID_FEEDBACK_KINDS = ('correction', 'closed', 'outdated', 'praise', 'bug', 'other')

_INVISIBLE_RE = re.compile(r'[\u200b-\u200f\u202a-\u202e\u2060\ufeff]')
_INJECTION_PATTERNS = (
    re.compile(
        r'\b(?:ignore|disregard|forget|override|bypass|skip|drop|reset|overwrite)\b'
        r'.{0,48}\b(?:previous|prior|above|all|any|your|system|core|safety|existing|original)?'
        r'\s*(?:instructions?|rules?|prompts?|constraints?|guidelines?|directives?|policies?|policy)\b',
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(
        r'\b(?:new|updated|override|replace)\s+(?:system\s+)?(?:prompt|instructions?|rules?|role)\b',
        re.IGNORECASE,
    ),
    re.compile(
        r'\b(?:you\s+are\s+now|from\s+now\s+on\s+you\s+are|'
        r'act\s+as\s+(?:an?\s+)?(?:unrestricted|admin|root|developer|hacker|dan|evil|system)|'
        r'pretend\s+(?:to\s+be|you\s+are)|jailbreak|do\s+anything\s+now)\b',
        re.IGNORECASE,
    ),
    re.compile(
        r'\b(?:reveal|show|print|dump|leak|expose|output|repeat)\b'
        r'.{0,36}\b(?:system\s*prompt|instructions?|rules?|api\s*key|secrets?|tokens?|'
        r'env(?:ironment)?\s*variables?|passwords?|credentials?)\b',
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(
        r'\b(?:execute|run|invoke|eval)\s+(?:shell|bash|zsh|sh|curl|wget|python3?|command|script)\b',
        re.IGNORECASE,
    ),
    re.compile(r'(?:;\s*(?:rm|cat|curl|wget|bash|sh|python3?)\b|\$\([^)]+\)|`[^`]+`)', re.IGNORECASE),
    re.compile(
        r'<\s*/?\s*(?:system|instruction|instructions|prompt|assistant|developer|tool|context|penny-message)\b',
        re.IGNORECASE,
    ),
    re.compile(
        r'\[(?:channel message context|recent channel messages|new message|system|'
        r'agent updates|internal hint|no_reply)\]',
        re.IGNORECASE,
    ),
    re.compile(
        r'\b(?:gateway_verdict|actor_token|sender_id|chat_id|reply_to_message_id)\s*:',
        re.IGNORECASE,
    ),
    re.compile(
        r'(?:忽略|无视|無視|忘记|忘記|覆盖|覆蓋|绕过|繞過|跳过|跳過|取消|重置)'
        r'.{0,24}(?:之前|以前|以上|上面|所有|全部|系统|系統|原有|原本|原先|一切)?'
        r'(?:的)?(?:指令|规则|規則|设定|設定|提示词|提示詞|提示|限制|原则|原則|安全)',
        re.DOTALL,
    ),
    re.compile(
        r'(?:新的|修改|更改|替换|替換)(?:系统|系統)?(?:指令|规则|規則|设定|設定|提示词|提示詞)',
    ),
    re.compile(
        r'(?:你现在是|你現在是|从现在起你是|從現在起你是|假装你是|假裝你是|'
        r'扮演(?:一个|一個)?(?:无限制|無限制|系统|系統|管理员|管理員))',
    ),
    re.compile(
        r'(?:泄露|洩漏|输出|輸出|打印|说出|說出|透露|显示|顯示)'
        r'.{0,24}(?:系统提示|系統提示|提示词|提示詞|指令|规则|規則|密钥|密鑰|密码|密碼|环境变量|環境變數|令牌|token)',
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(
        r'(?:执行|執行|运行|運行).{0,16}(?:命令|脚本|腳本|代码|代碼|shell|bash)',
        re.IGNORECASE,
    ),
)


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def clean_inline(text):
    return ' '.join(str(text).split()).strip()


def validate_safe_text(text, field='value', max_len=300, allow_spaces=True):
    if text is None:
        raise ValueError(f'{field} is required')
    raw = str(text)
    if '\x00' in raw:
        raise ValueError(f'rejected unsafe {field}: null byte not allowed')
    for ch in raw:
        code = ord(ch)
        if code < 32 and ch not in ('\t', '\n', '\r'):
            raise ValueError(f'rejected unsafe {field}: control character not allowed')
        if code == 127:
            raise ValueError(f'rejected unsafe {field}: control character not allowed')
    normalized = _INVISIBLE_RE.sub('', unicodedata.normalize('NFKC', raw))
    collapsed = clean_inline(normalized)
    if not collapsed:
        raise ValueError(f'{field} must not be empty')
    if len(collapsed) > max_len:
        raise ValueError(f'{field} exceeds {max_len} characters')
    if not allow_spaces and any(c.isspace() for c in raw.strip()):
        raise ValueError(f'{field} must not contain whitespace')
    for pat in _INJECTION_PATTERNS:
        if pat.search(normalized) or pat.search(collapsed):
            raise ValueError(f'rejected rule-override or prompt-injection payload in {field}')
    return clean_inline(_INVISIBLE_RE.sub('', raw))


def validate_id(value, field='id'):
    cleaned = validate_safe_text(value, field=field, max_len=160, allow_spaces=False)
    if '\n' in str(value) or '\r' in str(value):
        raise ValueError(f'{field} must be single-line')
    return cleaned


def validate_key(key):
    cleaned = validate_safe_text(key, field='key', max_len=64, allow_spaces=False)
    if '\n' in str(key) or '\r' in str(key):
        raise ValueError('key must be single-line')
    return cleaned


def db_path(explicit=None):
    return os.path.expanduser(explicit or os.environ.get(ENV_DB) or DEFAULT_DB)


def connect(path):
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, mode=0o700, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA busy_timeout = 5000')
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS memories (
            scope TEXT NOT NULL CHECK(scope IN ('user', 'room')),
            scope_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            is_private INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (scope, scope_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope, scope_id, is_private);

        CREATE TABLE IF NOT EXISTS langs (
            scope TEXT NOT NULL CHECK(scope IN ('user', 'room')),
            scope_id TEXT NOT NULL,
            lang TEXT NOT NULL CHECK(lang IN ('zh-Hant', 'zh-Hans', 'en')),
            updated_at TEXT NOT NULL,
            PRIMARY KEY (scope, scope_id)
        );

        CREATE TABLE IF NOT EXISTS demands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query TEXT NOT NULL,
            norm_query TEXT NOT NULL,
            user_id TEXT,
            room_id TEXT,
            note TEXT,
            count INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_demands_norm ON demands (norm_query);

        CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            target TEXT,
            text TEXT NOT NULL,
            user_id TEXT,
            room_id TEXT,
            created_at TEXT NOT NULL
        );
        """
    )
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return conn


def cmd_remember(conn, args):
    scope_id = validate_id(args.id, field='id')
    key = validate_key(args.key)
    value = validate_safe_text(args.value, field='value', max_len=300)
    is_private = 1 if args.private else 0
    ts = now_iso()
    with conn:
        conn.execute(
            """
            INSERT INTO memories (scope, scope_id, key, value, is_private, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, scope_id, key) DO UPDATE SET
                value = excluded.value,
                is_private = excluded.is_private,
                updated_at = excluded.updated_at
            """,
            (args.scope, scope_id, key, value, is_private, ts, ts),
        )
        rows = conn.execute(
            'SELECT key FROM memories WHERE scope = ? AND scope_id = ? ORDER BY updated_at DESC, key ASC',
            (args.scope, scope_id),
        ).fetchall()
        if len(rows) > MAX_MEMORIES_PER_SCOPE:
            for old in rows[MAX_MEMORIES_PER_SCOPE:]:
                conn.execute(
                    'DELETE FROM memories WHERE scope = ? AND scope_id = ? AND key = ?',
                    (args.scope, scope_id, old['key']),
                )
    tag = ' [private]' if is_private else ''
    print(f'REMEMBERED {args.scope} {scope_id} {key}={value}{tag}')


def cmd_recall(conn, args):
    user_id = validate_id(args.user, field='user') if args.user else None
    room_id = validate_id(args.room, field='room') if args.room else None
    if not user_id and not room_id:
        raise ValueError('pass at least one of --user or --room')
    # Fail closed: if --room is present and --chat-type is omitted, treat as group
    # so DM-private notes can never leak into a shared room.
    chat_type = args.chat_type or ('group' if room_id else 'dm')

    lines = []
    if chat_type == 'group':
        if room_id:
            lang_row = conn.execute(
                "SELECT lang FROM langs WHERE scope = 'room' AND scope_id = ?",
                (room_id,),
            ).fetchone()
            if lang_row:
                lines.append(f"[lang] room: {lang_row['lang']}")
            rows = conn.execute(
                "SELECT key, value FROM memories WHERE scope = 'room' AND scope_id = ? AND is_private = 0 ORDER BY updated_at DESC, key ASC",
                (room_id,),
            ).fetchall()
            for r in rows:
                lines.append(f"[room] {r['key']}: {clean_inline(r['value'])}")
        if user_id:
            lang_row = conn.execute(
                "SELECT lang FROM langs WHERE scope = 'user' AND scope_id = ?",
                (user_id,),
            ).fetchone()
            if lang_row:
                lines.append(f"[lang] user: {lang_row['lang']}")
            rows = conn.execute(
                "SELECT key, value FROM memories WHERE scope = 'user' AND scope_id = ? AND is_private = 0 ORDER BY updated_at DESC, key ASC",
                (user_id,),
            ).fetchall()
            for r in rows:
                lines.append(f"[user] {r['key']}: {clean_inline(r['value'])}")
    else:
        if user_id:
            lang_row = conn.execute(
                "SELECT lang FROM langs WHERE scope = 'user' AND scope_id = ?",
                (user_id,),
            ).fetchone()
            if lang_row:
                lines.append(f"[lang] user: {lang_row['lang']}")
            rows = conn.execute(
                "SELECT key, value, is_private FROM memories WHERE scope = 'user' AND scope_id = ? ORDER BY updated_at DESC, key ASC",
                (user_id,),
            ).fetchall()
            for r in rows:
                priv = ', private' if r['is_private'] else ''
                lines.append(f"[user{priv}] {r['key']}: {clean_inline(r['value'])}")
        if room_id:
            rows = conn.execute(
                "SELECT key, value, is_private FROM memories WHERE scope = 'room' AND scope_id = ? ORDER BY updated_at DESC, key ASC",
                (room_id,),
            ).fetchall()
            for r in rows:
                priv = ', private' if r['is_private'] else ''
                lines.append(f"[room{priv}] {r['key']}: {clean_inline(r['value'])}")

    if not lines:
        print('NO_MEMORIES')
    else:
        print('\n'.join(lines))


def cmd_forget(conn, args):
    scope_id = validate_id(args.id, field='id')
    if not args.all and not args.key:
        raise ValueError('pass --key <k> or --all')
    chat_type = args.chat_type or ('group' if args.scope == 'room' else 'dm')
    privacy_clause = ' AND is_private = 0' if chat_type == 'group' else ''
    with conn:
        if args.all:
            cur = conn.execute(
                f'DELETE FROM memories WHERE scope = ? AND scope_id = ?{privacy_clause}',
                (args.scope, scope_id),
            )
        else:
            key = validate_key(args.key)
            cur = conn.execute(
                f'DELETE FROM memories WHERE scope = ? AND scope_id = ? AND key = ?{privacy_clause}',
                (args.scope, scope_id, key),
            )
    if cur.rowcount:
        print(f'FORGOT {cur.rowcount}')
    else:
        print('NOT_FOUND')


def cmd_demand(conn, args):
    if args.list:
        rows = conn.execute(
            'SELECT query, count, updated_at FROM demands ORDER BY count DESC, updated_at DESC LIMIT ?',
            (args.limit,),
        ).fetchall()
        if not rows:
            print('NO_DEMANDS')
            return
        for r in rows:
            print(f"- {clean_inline(r['query'])} (count={r['count']}, last={r['updated_at'][:10]})")
        return

    raw_query = args.query or args.positional_query
    query = validate_safe_text(raw_query, field='query', max_len=200)
    norm = ' '.join(unicodedata.normalize('NFKC', query).lower().split())
    user_id = validate_id(args.user, field='user') if args.user else None
    room_id = validate_id(args.room, field='room') if args.room else None
    note = validate_safe_text(args.note, field='note', max_len=200) if args.note else None
    ts = now_iso()
    with conn:
        conn.execute(
            """
            INSERT INTO demands (query, norm_query, user_id, room_id, note, count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(norm_query) DO UPDATE SET
                count = demands.count + 1,
                note = COALESCE(excluded.note, demands.note),
                updated_at = excluded.updated_at
            """,
            (query, norm, user_id, room_id, note, ts, ts),
        )
        row = conn.execute('SELECT count FROM demands WHERE norm_query = ?', (norm,)).fetchone()
    print(f"LOGGED_DEMAND {query} (count={row['count']})")


def cmd_lang(conn, args):
    user_id = validate_id(args.user, field='user') if args.user else None
    room_id = validate_id(args.room, field='room') if args.room else None
    if not user_id and not room_id:
        raise ValueError('pass --user <uid> or --room <rid>')

    if args.set_lang:
        scope, scope_id = ('user', user_id) if user_id else ('room', room_id)
        ts = now_iso()
        with conn:
            conn.execute(
                """
                INSERT INTO langs (scope, scope_id, lang, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(scope, scope_id) DO UPDATE SET
                    lang = excluded.lang,
                    updated_at = excluded.updated_at
                """,
                (scope, scope_id, args.set_lang, ts),
            )
        print(f'LANG_SET {scope} {scope_id} {args.set_lang}')
        return

    if user_id:
        row = conn.execute(
            "SELECT lang FROM langs WHERE scope = 'user' AND scope_id = ?",
            (user_id,),
        ).fetchone()
        if row:
            print(row['lang'])
            return
    if room_id:
        row = conn.execute(
            "SELECT lang FROM langs WHERE scope = 'room' AND scope_id = ?",
            (room_id,),
        ).fetchone()
        if row:
            print(row['lang'])
            return
    print('UNKNOWN')


def cmd_feedback(conn, args):
    if args.list:
        rows = conn.execute(
            'SELECT id, kind, target, text, created_at FROM feedback ORDER BY id DESC LIMIT ?',
            (args.limit,),
        ).fetchall()
        if not rows:
            print('NO_FEEDBACK')
            return
        for r in rows:
            tgt = f" [{clean_inline(r['target'])}]" if r['target'] else ''
            print(f"- #{r['id']} {r['kind']}{tgt}: {clean_inline(r['text'])} ({r['created_at'][:10]})")
        return

    raw_text = args.text or args.positional_text
    text = validate_safe_text(raw_text, field='text', max_len=300)
    target = validate_safe_text(args.target, field='target', max_len=120) if args.target else None
    user_id = validate_id(args.user, field='user') if args.user else None
    room_id = validate_id(args.room, field='room') if args.room else None
    ts = now_iso()
    with conn:
        cur = conn.execute(
            'INSERT INTO feedback (kind, target, text, user_id, room_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            (args.kind, target, text, user_id, room_id, ts),
        )
    print(f'LOGGED_FEEDBACK {args.kind} {cur.lastrowid}')


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--db', default=argparse.SUPPRESS, help='override sqlite3 path')

    ap = argparse.ArgumentParser(description=f'{APP_LABEL} self-learning memory CLI')
    ap.add_argument('--db', default=None, help='override sqlite3 path')
    sub = ap.add_subparsers(dest='cmd', required=True)

    s = sub.add_parser('remember', parents=[common])
    s.add_argument('--scope', choices=['user', 'room'], required=True)
    s.add_argument('--id', required=True)
    s.add_argument('--key', required=True)
    s.add_argument('--value', required=True)
    s.add_argument('--private', action='store_true')
    s.set_defaults(fn=cmd_remember)

    s = sub.add_parser('recall', parents=[common])
    s.add_argument('--user')
    s.add_argument('--room')
    s.add_argument('--chat-type', choices=['dm', 'group'], default=None)
    s.set_defaults(fn=cmd_recall)

    s = sub.add_parser('forget', parents=[common])
    s.add_argument('--scope', choices=['user', 'room'], required=True)
    s.add_argument('--id', required=True)
    s.add_argument('--key')
    s.add_argument('--all', action='store_true')
    s.add_argument('--chat-type', choices=['dm', 'group'], default=None)
    s.set_defaults(fn=cmd_forget)

    s = sub.add_parser('demand', parents=[common])
    s.add_argument('positional_query', nargs='?')
    s.add_argument('--query')
    s.add_argument('--user')
    s.add_argument('--room')
    s.add_argument('--note')
    s.add_argument('--list', action='store_true')
    s.add_argument('--limit', type=int, default=10)
    s.set_defaults(fn=cmd_demand)

    s = sub.add_parser('lang', parents=[common])
    s.add_argument('--user')
    s.add_argument('--room')
    s.add_argument('--set', dest='set_lang', choices=list(VALID_LANGS))
    s.set_defaults(fn=cmd_lang)

    s = sub.add_parser('feedback', parents=[common])
    s.add_argument('positional_text', nargs='?')
    s.add_argument('--text')
    s.add_argument('--kind', choices=list(VALID_FEEDBACK_KINDS), default='other')
    s.add_argument('--target')
    s.add_argument('--user')
    s.add_argument('--room')
    s.add_argument('--list', action='store_true')
    s.add_argument('--limit', type=int, default=10)
    s.set_defaults(fn=cmd_feedback)

    return ap


def main(argv=None):
    ap = build_parser()
    args = ap.parse_args(argv)
    try:
        path = db_path(getattr(args, 'db', None))
        conn = connect(path)
        try:
            args.fn(conn, args)
        finally:
            conn.close()
    except ValueError as err:
        print(f'ERROR: {err}', file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
