#!/usr/bin/env python3
# Clean myaccount.txt into accounts.json (email -> ordered password candidates).
# Fixes: missing colon, empty password, placeholder passwords, invalid emails,
# case-dedup of emails, trailing-space passwords. Never prints credentials.
import json
import re
import sys
from collections import OrderedDict

SRC = "/home/a3ca4608227d/test/myaccount.txt"
OUT_JSON = "/home/a3ca4608227d/test/vc-login/accounts.json"
OUT_CLEAN = "/home/a3ca4608227d/test/vc-login/myaccount-clean.txt"
OUT_REPORT = "/home/a3ca4608227d/test/vc-login/clean-report.txt"

EMAIL_RE = re.compile(r"^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$")
PLACEHOLDER_RE = re.compile(r"\[NOT_SAVED\]|\[UNKNOWN OR V?\d*\]|^NULL$|^DECRYPT ERR\.?$|^Decrypt err\.$", re.I)
MOJIBAKE_RE = re.compile(r"[\ufffd\u00C0-\u00FF\u0400-\u04FF]{2,}|\u00C0\u00AE|\u00C3")

lines = open(SRC, encoding="utf-8", errors="replace").read().splitlines()

accounts = OrderedDict()   # email -> OrderedDict(password -> {n, lines})
problems = []

for i, ln in enumerate(lines, 1):
    raw = ln.rstrip("\r")
    if not raw.strip():
        continue
    if ":" not in raw:
        problems.append(("no-colon", i, raw))
        continue
    email_raw, pw = raw.split(":", 1)
    email = email_raw.strip().lower()

    if not EMAIL_RE.match(email):
        problems.append(("invalid-email", i, f"{email_raw}::{pw}"))
        continue

    pw_stripped = pw.strip()
    if pw_stripped == "":
        problems.append(("empty-password", i, email))
        continue
    if PLACEHOLDER_RE.match(pw_stripped):
        problems.append(("placeholder", i, email))
        continue
    if pw != pw_stripped:
        problems.append(("whitespace-pw", i, email))
        pw = pw_stripped

    acc = accounts.setdefault(email, OrderedDict())
    if pw not in acc:
        acc[pw] = {"n": len(acc) + 1, "lines": []}
    acc[pw]["lines"].append(i)

for i, ln in enumerate(lines, 1):
    if ":" not in ln:
        continue
    email, pw = ln.split(":", 1)
    email = email.strip().lower()
    if email in accounts and pw in accounts[email]:
        # line numbers already recorded via first pass; nothing to do
        pass

# build outputs
clean_lines = []
payload = []
mojibake_notes = []
for email, pws in accounts.items():
    cands = []
    for pw, meta in pws.items():
        cands.append(pw)
        clean_lines.append(f"{email}:{pw}")
        if MOJIBAKE_RE.search(pw):
            mojibake_notes.append(f"line {meta['lines']}: {email} password may be mojibake -> {pw!r}")
    payload.append({"email": email, "passwords": cands, "pw_count": len(cands)})

json.dump(payload, open(OUT_JSON, "w"), ensure_ascii=False, indent=1)
open(OUT_CLEAN, "w").write("\n".join(clean_lines) + "\n")

rep = []
rep.append(f"source lines       : {len(lines)}")
rep.append(f"accounts (unique)  : {len(accounts)}")
rep.append(f"candidate entries  : {len(clean_lines)}")
from collections import Counter
kinds = Counter(k for k, *_ in problems)
rep.append(f"problems dropped    : {sum(kinds.values())} -> {dict(kinds)}")
rep.append("")
rep.append("problem detail (email only):")
seen = set()
for k, i, detail in problems:
    if k in ("no-colon", "invalid-email"):
        em = detail.split("::")[0]
    else:
        em = detail
    key = (k, em)
    if key in seen:
        continue
    seen.add(key)
    rep.append(f"  l.{i:>4} {k:<15} {em}")
rep.append("")
rep.append("mojibake password candidates (kept, verify by hand):")
rep.extend("  " + m for m in mojibake_notes[:60])
open(OUT_REPORT, "w").write("\n".join(rep) + "\n")

print(f"accounts: {len(accounts)} | candidate entries: {len(clean_lines)} | dropped problems: {sum(kinds.values())}")
print("report:", OUT_REPORT)
