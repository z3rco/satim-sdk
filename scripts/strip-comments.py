#!/usr/bin/env python3
"""Strip every comment from TypeScript/JavaScript source.

A regex cannot do this correctly: this codebase contains `//` inside string
literals (`"https://cib.satim.dz"`), `/*`-shaped text inside regex literals
(`/^0\\d+(\\.0?\\d+)*$/`), and real division (`parsed / 100`). A naive strip
turns a URL into a truncated line or eats half a regex.

So this scans character by character with a small state machine that knows
when it is inside a string, a template literal (including `${...}`
interpolation), a regex literal, or a comment. Only `//` line comments and
`/* */` block comments are removed; everything else is emitted verbatim.

Usage:
    strip-comments.py <path>...            # dry run: report per file
    strip-comments.py --in-place <path>... # rewrite the files
    strip-comments.py --selftest           # run built-in correctness checks

Paths may be files or directories; directories are searched for *.ts.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Keywords after which a `/` begins a regex literal rather than division.
REGEX_PRECEDING_KEYWORDS = {
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "do", "else", "yield", "await", "case", "default", "throw",
}
# Punctuation after which a `/` begins a regex (an expression is expected).
REGEX_PRECEDING_PUNCT = set("([{,;:=!&|?+-~^<>*%") | {"}"}
WORD_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$")


def _last_significant(out: list[str]) -> tuple[str, str]:
    """Return (last non-space emitted char, trailing identifier it ends)."""
    j = len(out) - 1
    while j >= 0 and out[j] in " \t\r\n":
        j -= 1
    if j < 0:
        return "", ""
    c = out[j]
    if c in WORD_CHARS:
        k = j
        while k >= 0 and out[k] in WORD_CHARS:
            k -= 1
        return c, "".join(out[k + 1:j + 1])
    return c, ""


def _regex_allowed(out: list[str]) -> bool:
    c, word = _last_significant(out)
    if c == "":
        return True
    if c in REGEX_PRECEDING_PUNCT:
        return True
    if c in WORD_CHARS:
        return word in REGEX_PRECEDING_KEYWORDS  # keyword -> regex, else division
    return False  # after ')', ']', '.' etc. -> division / value context


def strip_comments(src: str) -> tuple[str, int]:
    """Return (source without comments, number of comments removed)."""
    out: list[str] = []
    i, n = 0, len(src)
    removed = 0
    # Stack of frames: {"t": "code"|"tmpl", "interp": bool, "depth": int}.
    # `code` frames pushed by `${` track brace depth to find the closing `}`.
    stack = [{"t": "code", "interp": False, "depth": 0}]

    while i < n:
        frame = stack[-1]
        c = src[i]

        if frame["t"] == "tmpl":
            if c == "\\" and i + 1 < n:
                out.append(c); out.append(src[i + 1]); i += 2; continue
            if c == "`":
                out.append(c); i += 1; stack.pop(); continue
            if c == "$" and i + 1 < n and src[i + 1] == "{":
                out.append("$"); out.append("{"); i += 2
                stack.append({"t": "code", "interp": True, "depth": 0}); continue
            out.append(c); i += 1; continue

        # frame["t"] == "code"
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            i += 2
            while i < n and src[i] != "\n":
                i += 1
            removed += 1
            continue

        if c == "/" and i + 1 < n and src[i + 1] == "*":
            end = src.find("*/", i + 2)
            i = n if end == -1 else end + 2
            removed += 1
            continue

        if c == "/" and _regex_allowed(out):
            out.append(c); i += 1
            in_class = False
            while i < n:
                ch = src[i]
                if ch == "\\" and i + 1 < n:
                    out.append(ch); out.append(src[i + 1]); i += 2; continue
                out.append(ch); i += 1
                if ch == "[":
                    in_class = True
                elif ch == "]":
                    in_class = False
                elif ch == "/" and not in_class:
                    break
                elif ch == "\n":
                    break  # malformed; bail rather than run away
            while i < n and (src[i].isalpha() or src[i] == "$"):
                out.append(src[i]); i += 1  # regex flags
            continue

        if c in ("'", '"'):
            out.append(c); i += 1
            while i < n:
                ch = src[i]
                if ch == "\\" and i + 1 < n:
                    out.append(ch); out.append(src[i + 1]); i += 2; continue
                out.append(ch); i += 1
                if ch == c or ch == "\n":
                    break
            continue

        if c == "`":
            out.append(c); i += 1
            stack.append({"t": "tmpl", "interp": False, "depth": 0}); continue

        if c == "{" and frame["interp"]:
            frame["depth"] += 1; out.append(c); i += 1; continue

        if c == "}" and frame["interp"]:
            if frame["depth"] == 0:
                out.append(c); i += 1; stack.pop(); continue  # closes ${...}
            frame["depth"] -= 1; out.append(c); i += 1; continue

        out.append(c); i += 1

    return "".join(out), removed


def tidy(text: str) -> str:
    """Trim trailing whitespace and collapse runs of blank lines to one."""
    lines = [ln.rstrip() for ln in text.split("\n")]
    result: list[str] = []
    blank = False
    for ln in lines:
        if ln == "":
            if not blank and result:
                result.append("")
            blank = True
        else:
            result.append(ln)
            blank = False
    while result and result[-1] == "":
        result.pop()
    return "\n".join(result) + "\n"


def iter_targets(paths: list[str]) -> list[Path]:
    files: list[Path] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            files.extend(sorted(p.rglob("*.ts")))
        elif p.is_file():
            files.append(p)
        else:
            print(f"  skip (not found): {raw}", file=sys.stderr)
    return files


SELFTESTS = [
    # (input, must appear verbatim in output, must NOT appear in output)
    ('const u = "https://cib.satim.dz/x"; // trailing', '"https://cib.satim.dz/x"', "trailing"),
    ("const re = /^0\\d+(\\.0?\\d+)*$/; // ip", "/^0\\d+(\\.0?\\d+)*$/", "ip"),
    ("const x = parsed / 100; /* half */", "parsed / 100", "half"),
    ("return /ab\\/cd/.test(s); // c", "/ab\\/cd/", "// c"),
    ("const t = `a ${b // no\n} c`;", "${b", None),  # // inside interp is a real comment
    ("const s = 'it // is not a comment';", "'it // is not a comment'", None),
    ("/** doc */\nexport const y = 1;", "export const y = 1;", "doc"),
    ("const a = b/*x*/+c;", "b+c", "x"),
    ("const p = { pattern: /[a-z]+/gi }; // f", "/[a-z]+/gi", "// f"),
]


def selftest() -> int:
    failures = 0
    for src, must, must_not in SELFTESTS:
        out, _ = strip_comments(src)
        ok = (must in out) and (must_not is None or must_not not in out)
        print(("  ok   " if ok else "  FAIL ") + repr(src)[:60])
        if not ok:
            failures += 1
            print("        ->", repr(out))
    print(f"\n{len(SELFTESTS) - failures}/{len(SELFTESTS)} passed")
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    in_place = "--in-place" in argv
    paths = [a for a in argv if not a.startswith("--")]
    if not paths:
        print("usage: strip-comments.py [--in-place|--selftest] <path>...", file=sys.stderr)
        return 2

    total_removed = 0
    for f in iter_targets(paths):
        original = f.read_text()
        stripped, removed = strip_comments(original)
        stripped = tidy(stripped)
        total_removed += removed
        saved = len(original) - len(stripped)
        print(f"  {f}: {removed} comments removed, {saved} bytes")
        if in_place and stripped != original:
            f.write_text(stripped)
    print(f"\n{total_removed} comments removed" + ("" if in_place else " (dry run, pass --in-place to apply)"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
