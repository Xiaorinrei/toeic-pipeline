import os
import re
import json
import time
import requests
from google import genai
from google.genai import types
from google.genai import errors as genai_errors

# ------------------------------------------------------------
# 環境変数(GitHub Secrets)
# ------------------------------------------------------------
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
NOTION_API_KEY = os.environ.get("NOTION_API_KEY")
NOTION_DATABASE_ID = os.environ.get("NOTION_DATABASE_ID")

# サムネ下部に入れるブランド表記(任意。Secretで上書き可)
NOTE_BRAND = os.environ.get("NOTE_BRAND", "note / TOEIC学習 log")

# 使用モデル(無料枠あり)。詰まったら順にフォールバック
MODELS = [
    os.environ.get("GEMINI_MODEL", "gemini-3.6-flash"),
    "gemini-3.5-flash-lite",
]

# Notion APIバージョン
NOTION_VERSION_STABLE = "2022-06-28"   # ページ作成(枯れていて確実)
NOTION_VERSION_UPLOAD = "2026-03-11"   # ファイルアップロード用

client = genai.Client(api_key=GEMINI_API_KEY)


# ------------------------------------------------------------
# 1. 記事生成
# ------------------------------------------------------------
def generate_article():
    prompt = """
    あなたはビジネスパーソン向けの英語トレーナー兼、note編集者です。
    「英語の構造化(SVOC・品詞の理解)や瞬発力」をテーマに、
    noteにそのまま公開できる完成度の日本語ブログ記事を作成してください。

    本文の条件:
    - 1500〜2000字程度
    - Markdownで書く。見出しは「## 」を使い、3〜4個立てる
    - 具体例や箇条書き(「- 」)を適度に入れて読みやすくする
    - 導入(共感)→ 本論(解説)→ まとめ(行動提案)の流れにする

    出力は必ず次のJSON形式のみで返してください(前後に説明文やコードブロックは不要):
    {
        "title": "記事のタイトル(30字前後、読みたくなるもの)",
        "body": "記事の本文(Markdown)",
        "tags": "ハッシュタグ(例: #英語学習 #TOEIC #ビジネス英語)"
    }
    """
    last_error = None
    for model in MODELS:
        for attempt in range(3):
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                    ),
                )
                print(f"✅ モデル {model} で生成に成功しました")
                return response.text
            except genai_errors.APIError as e:
                last_error = e
                if e.code == 429:
                    wait = 20 * (attempt + 1)
                    print(f"⚠️ {model} がレート制限(429)。{wait}秒待って再試行します...")
                    time.sleep(wait)
                else:
                    print(f"⚠️ {model} でエラー: {e.code}。次のモデルを試します...")
                    break
        else:
            print(f"⚠️ {model} はリトライ上限に達しました。次のモデルを試します...")
    raise RuntimeError(f"すべてのモデルで生成に失敗しました: {last_error}")


# ------------------------------------------------------------
# 2. Markdown本文 → Notionブロックへ変換
# ------------------------------------------------------------
def _rich_text(text):
    """**太字** を解釈しつつ rich_text 配列を作る(2000字ごとに分割)"""
    segments = []
    # **bold** で分割
    parts = re.split(r"(\*\*[^*]+\*\*)", text)
    for part in parts:
        if not part:
            continue
        bold = part.startswith("**") and part.endswith("**")
        content = part[2:-2] if bold else part
        # 2000字制限に対応
        for i in range(0, len(content), 1900):
            chunk = content[i:i + 1900]
            segments.append({
                "type": "text",
                "text": {"content": chunk},
                "annotations": {"bold": bold},
            })
    if not segments:
        segments = [{"type": "text", "text": {"content": ""}}]
    return segments


def markdown_to_blocks(body):
    """Markdown文字列をNotionブロックのリストに変換"""
    blocks = []
    for raw_line in body.split("\n"):
        line = raw_line.rstrip()
        if not line.strip():
            continue

        # 見出し
        m = re.match(r"^(#{1,3})\s+(.*)$", line)
        if m:
            level = len(m.group(1))
            key = {1: "heading_1", 2: "heading_2", 3: "heading_3"}[level]
            blocks.append({
                "object": "block",
                "type": key,
                key: {"rich_text": _rich_text(m.group(2).strip())},
            })
            continue

        # 箇条書き(- / *)
        m = re.match(r"^[-*]\s+(.*)$", line)
        if m:
            blocks.append({
                "object": "block",
                "type": "bulleted_list_item",
                "bulleted_list_item": {"rich_text": _rich_text(m.group(1).strip())},
            })
            continue

        # 番号付きリスト(1. 2. ...)
        m = re.match(r"^\d+\.\s+(.*)$", line)
        if m:
            blocks.append({
                "object": "block",
                "type": "numbered_list_item",
                "numbered_list_item": {"rich_text": _rich_text(m.group(1).strip())},
            })
            continue

        # 通常の段落
        blocks.append({
            "object": "block",
            "type": "paragraph",
            "paragraph": {"rich_text": _rich_text(line.strip())},
        })
    return blocks


# ------------------------------------------------------------
# 3. サムネイル画像(テンプレート型)を生成
# ------------------------------------------------------------
def _find_japanese_font():
    candidates = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Bold.otf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
        "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    # 見つからなければGoogleフォントからNoto Sans JPを取得
    try:
        url = ("https://github.com/googlefonts/noto-cjk/raw/main/Sans/"
               "OTF/Japanese/NotoSansJP-Bold.otf")
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        path = "/tmp/NotoSansJP-Bold.otf"
        with open(path, "wb") as f:
            f.write(r.content)
        return path
    except Exception as e:
        print(f"⚠️ 日本語フォントが見つかりませんでした: {e}")
        return None


def _wrap_by_width(text, font, max_width, draw):
    lines, cur = [], ""
    for ch in text:
        test = cur + ch
        if draw.textlength(test, font=font) <= max_width:
            cur = test
        else:
            if cur:
                lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


def make_thumbnail(title, label, out_path="thumbnail.png"):
    """1280x670のnote向けサムネを生成。成功でパス、失敗でNoneを返す"""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("⚠️ Pillow未インストールのためサムネ生成をスキップします")
        return None

    font_path = _find_japanese_font()
    if not font_path:
        return None

    W, H = 1280, 670
    # --- 背景グラデーション(濃紺→ティール) ---
    top_color = (23, 37, 84)      # deep indigo
    bottom_color = (13, 71, 82)   # dark teal
    img = Image.new("RGB", (W, H), top_color)
    draw = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        r = int(top_color[0] + (bottom_color[0] - top_color[0]) * t)
        g = int(top_color[1] + (bottom_color[1] - top_color[1]) * t)
        b = int(top_color[2] + (bottom_color[2] - top_color[2]) * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b))

    accent = (56, 189, 248)  # sky blue
    margin = 90

    # --- 左端のアクセントバー ---
    draw.rectangle([0, 0, 14, H], fill=accent)

    def load(size):
        return ImageFont.truetype(font_path, size)

    # --- カテゴリラベル(チップ) ---
    label = (label or "英語学習").strip()
    label_font = load(30)
    lw = draw.textlength(label, font=label_font)
    chip_pad = 22
    chip_h = 58
    draw.rounded_rectangle(
        [margin, 78, margin + lw + chip_pad * 2, 78 + chip_h],
        radius=12, fill=accent,
    )
    draw.text((margin + chip_pad, 78 + (chip_h - 30) // 2 - 4),
              label, font=label_font, fill=(10, 25, 47))

    # --- タイトル(自動フィット) ---
    title_area_w = W - margin * 2
    title_area_h = 300
    chosen_size, chosen_lines = 40, [title]
    for size in range(78, 38, -4):
        f = load(size)
        lines = _wrap_by_width(title, f, title_area_w, draw)
        line_h = int(size * 1.35)
        if len(lines) <= 5 and len(lines) * line_h <= title_area_h:
            chosen_size, chosen_lines = size, lines
            break
    else:
        f = load(40)
        chosen_size = 40
        chosen_lines = _wrap_by_width(title, f, title_area_w, draw)[:5]

    title_font = load(chosen_size)
    line_h = int(chosen_size * 1.35)
    total_h = len(chosen_lines) * line_h
    y = 210 + (title_area_h - total_h) // 2
    for line in chosen_lines:
        draw.text((margin, y), line, font=title_font, fill=(255, 255, 255))
        y += line_h

    # --- タイトル下のアクセント線 ---
    draw.rectangle([margin, y + 14, margin + 120, y + 22], fill=accent)

    # --- フッター(ブランド) ---
    brand_font = load(28)
    draw.text((margin, H - 78), NOTE_BRAND, font=brand_font, fill=(148, 163, 184))

    img.save(out_path)
    print(f"✅ サムネイルを生成しました: {out_path}")
    return out_path


# ------------------------------------------------------------
# 4. NotionへPNGをアップロード → file_upload id を返す
# ------------------------------------------------------------
def upload_image_to_notion(image_path):
    try:
        # (1) アップロード枠を作成
        create = requests.post(
            "https://api.notion.com/v1/file_uploads",
            headers={
                "Authorization": f"Bearer {NOTION_API_KEY}",
                "Notion-Version": NOTION_VERSION_UPLOAD,
                "Content-Type": "application/json",
            },
            json={
                "mode": "single_part",
                "filename": os.path.basename(image_path),
                "content_type": "image/png",
            },
            timeout=30,
        )
        create.raise_for_status()
        info = create.json()
        upload_id = info["id"]
        upload_url = info.get("upload_url",
                              f"https://api.notion.com/v1/file_uploads/{upload_id}/send")

        # (2) バイト送信(multipart/form-data)
        with open(image_path, "rb") as f:
            send = requests.post(
                upload_url,
                headers={
                    "Authorization": f"Bearer {NOTION_API_KEY}",
                    "Notion-Version": NOTION_VERSION_UPLOAD,
                },
                files={"file": (os.path.basename(image_path), f, "image/png")},
                timeout=60,
            )
        send.raise_for_status()
        print("✅ サムネイルをNotionにアップロードしました")
        return upload_id
    except Exception as e:
        print(f"⚠️ サムネイルのアップロードに失敗しました(記事保存は続行します): {e}")
        return None


# ------------------------------------------------------------
# 5. Notionページ作成
# ------------------------------------------------------------
def _notion_post_with_retry(url, headers, data, max_attempts=5):
    """一時的な混雑(429/5xx/529)は待って自動リトライする"""
    transient = {429, 500, 502, 503, 504, 529}
    last = None
    for attempt in range(max_attempts):
        resp = requests.post(url, headers=headers, json=data)
        last = resp
        if resp.status_code == 200:
            return resp
        if resp.status_code in transient:
            wait = 5 * (attempt + 1)
            print(f"⚠️ Notionが混雑({resp.status_code})。{wait}秒待って再試行します"
                  f"({attempt + 1}/{max_attempts})...")
            time.sleep(wait)
            continue
        # それ以外(400番台など)はリトライしても無駄なので即返す
        return resp
    return last


def save_to_notion(title, body, tags, thumb_upload_id=None):
    url = "https://api.notion.com/v1/pages"
    children = []

    # 先頭にサムネ画像を配置
    if thumb_upload_id:
        children.append({
            "object": "block",
            "type": "image",
            "image": {
                "type": "file_upload",
                "file_upload": {"id": thumb_upload_id},
            },
        })

    # 本文(Markdown→ブロック)
    children.extend(markdown_to_blocks(body))

    # タグ
    if tags:
        children.append({
            "object": "block",
            "type": "paragraph",
            "paragraph": {"rich_text": _rich_text(tags)},
        })

    data = {
        "parent": {"database_id": NOTION_DATABASE_ID},
        "properties": {
            "名前": {"title": [{"text": {"content": title}}]},
        },
        "children": children,
    }

    # サムネを含む場合は新バージョン、失敗時は画像なしで確実に保存
    version = NOTION_VERSION_UPLOAD if thumb_upload_id else NOTION_VERSION_STABLE
    resp = _notion_post_with_retry(url, {
        "Authorization": f"Bearer {NOTION_API_KEY}",
        "Content-Type": "application/json",
        "Notion-Version": version,
    }, data)

    if resp.status_code == 200:
        print("✅ Notionへの保存が成功しました!")
        return

    print(f"⚠️ 保存に失敗({resp.status_code})。画像なしで再試行します...")
    print(resp.text)
    # 画像ブロックを外して再試行(混雑時もリトライ)
    data["children"] = markdown_to_blocks(body)
    if tags:
        data["children"].append({
            "object": "block",
            "type": "paragraph",
            "paragraph": {"rich_text": _rich_text(tags)},
        })
    retry = _notion_post_with_retry(url, {
        "Authorization": f"Bearer {NOTION_API_KEY}",
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION_STABLE,
    }, data)
    if retry.status_code == 200:
        print("✅ Notionへの保存が成功しました(画像なし)!")
    else:
        print(f"❌ エラーが発生しました: {retry.status_code}")
        print(retry.text)


# ------------------------------------------------------------
# メイン
# ------------------------------------------------------------
if __name__ == "__main__":
    print("Geminiで記事を生成中...")
    raw_text = generate_article()

    cleaned_text = re.sub(r'```json\n|\n```', '', raw_text).strip()

    try:
        article_data = json.loads(cleaned_text)
        title = article_data.get("title", "無題のnote記事")
        body = article_data.get("body", "本文が生成されませんでした。")
        tags = article_data.get("tags", "")
        if isinstance(tags, list):
            tags = " ".join(tags)

        # ラベル = 先頭のハッシュタグ(なければ英語学習)
        label = "英語学習"
        m = re.search(r"#(\S+)", tags or "")
        if m:
            label = m.group(1)

        print("サムネイルを生成中...")
        thumb_path = make_thumbnail(title, label)
        thumb_id = upload_image_to_notion(thumb_path) if thumb_path else None

        print("Notionへ保存中...")
        save_to_notion(title, body, tags, thumb_upload_id=thumb_id)

    except json.JSONDecodeError:
        print("❌ JSONの解析に失敗しました。Geminiの出力形式を確認してください。")
        print("Raw Output:\n", raw_text)
