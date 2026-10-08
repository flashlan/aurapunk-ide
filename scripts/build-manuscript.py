#!/usr/bin/env python3
"""Consolida docs/livro/*.md e docs/livro-en/*.md em manuscritos para KDP."""
from pathlib import Path

ORDER = [
    "00-indice.md",
    "01-introducao.md",
    "02-nocoes-vibe-coding.md",
    "03-instalacao-configuracao.md",
    "04-tour-interface.md",
    "05-cards-kanban.md",
    "06-pipelines.md",
    "07-git-workspaces.md",
    "08-projeto-saas.md",
    "09-publicacao-kdp.md",
    "10-vibe-coding-setup.md",
    "11-arquitetura-spec-driven.md",
    "12-contrato-de-tipos.md",
    "13-engineering-loop.md",
    "14-orquestracao.md",
    "15-ancoragem-imagens.md",
    "17-agentes.md",
    "18-configuracoes.md",
    "19-resolucao-problemas.md",
    "apendice-comandos.md",
    "16-agradecimentos.md",
]

def build(livro_dir, title):
    LIVRO = Path(livro_dir)
    OUT = LIVRO / "manuscript.md"
    parts = [title]
    for name in ORDER:
        p = LIVRO / name
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8")
        text = text.replace("](/images/livro/", "](../images/livro/")
        parts.append(text.rstrip() + "\n\n---\n\n")
    OUT.write_text("".join(parts), encoding="utf-8")
    print(f"escrito {OUT} ({OUT.stat().st_size} bytes, {len(parts)-1} caps)")

build("docs/livro", """# Manual Moderno de Vibe Coding

### Uso pratico do Aurapunk IDE — do `npx` ao SaaS em producao

**Subtitulo:** *Manual pratico da interface do Aurapunk IDE, com um projeto-guia SaaS (AssinaFacil).*

> Manuscrito gerado a partir de `docs/livro/*.md` (branch `vk/1f98-livre-vibo-kanba`).
> Regras externas (precos KDP) verificadas em ago/2026 — revalide antes de publicar.

---

""")

build("docs/livro-en", """# Modern Vibe Coding Manual

### Practical use of Aurapunk IDE — from `npx` to a production SaaS

**Subtitle:** *A practical interface guide for Aurapunk IDE, with the guided SaaS project AssinaFacil.*

> Manuscript generated from `docs/livro-en/*.md` (branch `vk/1f98-livre-vibo-kanba`).
> External KDP rules verified Aug/2026 — revalidate before publishing.

---

""")

# --- EPUB generation (Kobo/Google Play/KDP) ---
import subprocess, shutil
if shutil.which("pandoc"):
    for src, dst, cover, title, lang in [
        ("docs/livro/manuscript.md", "docs/livro/manuscript.epub", "docs/images/livro/capa-pt.jpg", "Aurapunk IDE", "pt-BR"),
        ("docs/livro-en/manuscript.md", "docs/livro-en/manuscript.epub", "docs/images/livro/capa-en.jpg", "Aurapunk IDE", "en-US"),
    ]:
        cmd = [
            "pandoc", src, "-o", dst,
            "--resource-path=.:docs/livro:docs",
            "--metadata", f"title={title}",
            "--metadata", "author=Evertone L. Kozloski",
            "--metadata", f"lang={lang}",
        ]
        if Path(cover).exists():
            cmd += [f"--epub-cover-image={cover}"]
        try:
            subprocess.run(cmd, check=True)
            print(f"epub {dst} ({Path(dst).stat().st_size} bytes)")
        except subprocess.CalledProcessError as e:
            print(f"pandoc falhou para {src}: {e}")
else:
    print("pandoc nao encontrado — pulei EPUB. Instale com: brew install pandoc")
