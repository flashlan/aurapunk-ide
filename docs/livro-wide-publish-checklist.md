# Livro "Aurapunk IDE" — Publicação Ampla (Kobo + Google Play Livros) antes da Amazon

Estratégia **wide-first**: publique primeiro em **Kobo Writing Life** e **Google Play Livros** com preço baixo para **forçar a Amazon a igualar**. O KDP só entra depois como *price-follower*. Se seguir esta ordem, **NÃO entre no KDP Select** (exige exclusividade 90 dias).

Os manuscritos já estão prontos: `docs/livro/manuscript.md` (PT) e `docs/livro-en/manuscript.md` (EN). A capa `docs/images/livro/capa-ebook.png` (1600×2560, RGB) serve nos três.

## 0. Preparação (uma vez)

- [ ] `scripts/build-manuscript.py` gerou `manuscript.md` PT e EN (já feito; rode `python3 scripts/build-manuscript.py` após cada edição)
- [ ] Gerar **EPUB** a partir de cada `manuscript.md` (Kobo e Google aceitam EPUB; KDP também aceita):
  ```bash
  brew install pandoc   # se não tiver
  # PT
  pandoc docs/livro/manuscript.md -o docs/livro/manuscript.epub \
    --metadata title="Manual Moderno de Vibe Coding — Aurapunk IDE" \
    --epub-cover-image=docs/images/livro/capa-ebook.png
  # EN
  pandoc docs/livro-en/manuscript.md -o docs/livro-en/manuscript.epub \
    --metadata title="Modern Vibe Coding Manual — Aurapunk IDE" \
    --epub-cover-image=docs/images/livro/capa-ebook.png
  ```
  Sem pandoc, use a mesma conversão no **Calibre** (Add books → Convert) ou suba o EPUB gerado pelo `Kindle Create` — Kobo/Google aceitam.
- [ ] Capa: `capa-ebook.png` 1600×2560, menos de 50 MB, RGB, título legível em thumbnail 100×160. Google recomenda sem bordas brancas; Kobo aceita igual ao KDP.
- [ ] ISBN: **Kobo** oferece ISBN grátis (use o dele); **Google Play** não exige ISBN; **Amazon** pode usar o gratuito do KDP — o mesmo livro terá ISBNs diferentes por loja, normal em wide.

## 1. Kobo Writing Life (kobo.com/writinglife)

Cada idioma é um livro separado. Faça duas vezes: PT e EN.

- [ ] Criar/logar em [kobo.com/writinglife](https://www.kobo.com/writinglife) → completar perfil fiscal e conta bancária
- [ ] **Create new eBook** → Upload `manuscript.epub` (PT ou EN)
- [ ] Capa: upload `capa-ebook.png` (ou deixe o Kobo usar a do EPUB)
- [ ] Metadados: copie do rascunho em `docs/livro-vibe-kanban-amazon-checklist.md` §6 (título PT: *Manual Moderno de Vibe Coding — Aurapunk IDE: Uso prático do Aurapunk IDE: do npx ao SaaS*; EN: *Modern Vibe Coding Manual — Aurapunk IDE*)
  - Título / Subtítulo / Autor / Descrição (até 4.000 chars) / 3 categorias / 7 keywords
  - Série: não
  - Idioma: Português / English
- [ ] **Preço (o ponto da estratégia):** defina **baixo para forçar a Amazon**
  - PT: **R$ 9,90** (ou R$ 14,90) / EN: **US$ 1.99** (ou US$ 0.99)
  - Territórios: Worldwide
  - Royalty Kobo: 70% acima de US$ 2.99; 45% abaixo — aceite 45% no Kobo para forçar a Amazon a 35%
- [ ] Direitos: confirme que detém todo conteúdo (texto + imagens)
- [ ] DRM: **Não** (deixe desmarcado — wide sem DRM vende mais)
- [ ] Publicar → Kobo leva 24–72h para indexar. Guarde a URL da loja.

## 2. Google Play Livros (Parceiros) (play.google.com/books/publish)

Mesma lógica: dois livros, PT e EN.

- [ ] Criar/logar em [play.google.com/books/publish](https://play.google.com/books/publish) → perfil fiscal (Google Payments)
- [ ] **Add new book** → Upload `manuscript.epub` (PT ou EN)
- [ ] Capa: Google extrai do EPUB; se pedir, envie `capa-ebook.png`
- [ ] Metadados: mesmo título/descrição/categorias do Kobo
- [ ] **Preço:** use **exatamente o mesmo** do Kobo (R$ 9,90 / US$ 1.99) — o Google permite US$ 0.99 sem travar royalty (52% fixo, sem faixa de 70%)
- [ ] Disponibilidade: Worldwide, sem pré-venda (ou com, se quiser)
- [ ] Publicar → Google indexa em 24–72h. Guarde a URL.

> Espere **as duas lojas indexadas** (busque o título no Kobo e no Google) antes de ir à Amazon. A prova de que estão vivas é o link público — ela é sua alavanca de preço.

## 3. Amazon KDP como price-follower (kdp.amazon.com)

Agora suba com **o mesmo preço baixo** — você controla, não espera o *price match* automático.

- [ ] Logar em [kdp.amazon.com](https://kdp.amazon.com) → **Create** eBook para PT e EN (dois listings)
- [ ] Upload: o **mesmo** `manuscript.epub` (ou o EPUB que a Amazon gerar via Kindle Previewer) + `capa-ebook.png`
- [ ] Metadados: mesmos do Kobo/Google (título, subtítulo, descrição 4.000 chars, 3 categorias, 7×50 keywords)
- [ ] **Direitos e preço:** selecione
  - Royalty: **35%** (porque < US$ 2,99 você não tem 70%)
  - Preço: **igual ao Kobo/Google** (US$ 1.99 / R$ 9,90) em todos os marketplaces
  - **KDP Select: NÃO** (deixe desmarcado — você já está no Kobo/Google)
  - Territórios: All territories
- [ ] Publicar → KDP analisa em até 72h. Se a Amazon tentar *price match* abaixo do que você já colocou, ela não precisa — já está baixo.

## 4. Pós-lançamento wide

- [ ] Conferir as 3 páginas de produto (Kobo, Google, Amazon PT e EN) — título, capa, descrição
- [ ] Criar páginas de autor: **Kobo Author**, **Google Play Author**, **Amazon Author Central**
- [ ] Pedir reviews aos primeiros leitores (manda o link do Kobo/Google, não só Amazon)
- [ ] Monitorar: se alguma loja baixar mais, **iguale manualmente** nas outras (não espere algoritmo)
- [ ] Ao fim de 90 dias, reavalie: manter wide ou fechar Kobo/Google e entrar no KDP Select para ganhar KU + 70% no Brasil (decisão reversível)

## Ferramentas neste repo

- `scripts/build-manuscript.py` — gera `docs/livro/manuscript.md` e `docs/livro-en/manuscript.md`
- `docs/images/livro/capa-ebook.png` — capa KDP/Kobo/Google (1600×2560)
- `docs/livro-vibe-kanban-amazon-checklist.md` — checklist KDP (§6 com metadados PT prontos)
- **Este arquivo** — checklist wide-first

Sem `pandoc`, gere o EPUB no **Calibre** ou no **Kindle Create** (export EPUB) e use o mesmo arquivo nas três lojas.

## Fontes oficiais

- [Kobo Writing Life — Help](https://kobo.com/writinglife/help)
- [Google Play Books Partner Help](https://support.google.com/books/partner)
- [KDP Pricing & Royalties](https://kdp.amazon.com/help/topic/G200644210) (para entender o porquê de 35% abaixo de US$ 2,99)
