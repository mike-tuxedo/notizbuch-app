#!/usr/bin/env python3
"""Setzt die Prototyp-Seiten zusammen: _src/*.html + shared.css/js/icons -> ../*.html (eigenständig, inline)."""
import pathlib
import re

src = pathlib.Path(__file__).parent
out = src.parent
css = (src / "shared.css").read_text()
js = (src / "shared.js").read_text()
icons = (src / "icons.svg").read_text()

SCREENS = [
    ("index", "Hauptansicht"),
    ("seiten", "Seitenübersicht"),
    ("einstellungen", "Einstellungen"),
    ("teilen", "Teilen"),
    ("states", "States & Tokens"),
]


def icon(m):
    return f'<svg class="i" aria-hidden="true"><use href="#i-{m.group(1)}"/></svg>'


def nav(current, extra=""):
    links = "".join(
        f'<a href="{name}.html"{" aria-current=page" if name == current else ""}>{label}</a>'
        for name, label in SCREENS
    )
    return (
        '<nav class="proto" aria-label="Prototyp-Navigation"><strong>Prototyp</strong>'
        + links
        + f'<span class="push"></span>{extra}'
        + '<button data-theme-toggle>{{i:theme}} Hell / Dunkel</button></nav>'
    )


for name, _ in SCREENS:
    html = (src / f"{name}.html").read_text()
    extra = re.search(r"<!--@NAVEXTRA(.*?)-->", html, re.S)
    html = re.sub(r"<!--@NAVEXTRA.*?-->", "", html, flags=re.S)
    html = html.replace("/*@CSS*/", css).replace("/*@JS*/", js)
    html = html.replace("<!--@ICONS-->", icons)
    html = html.replace("<!--@NAV-->", nav(name, extra.group(1).strip() if extra else ""))
    html = re.sub(r"\{\{i:([a-z]+)\}\}", icon, html)
    (out / f"{name}.html").write_text(html)
    print("ok", name)
