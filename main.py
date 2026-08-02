import os
import time
import requests
from google import genai
from google.genai import types
from google.genai import errors as genai_errors

# GitHub Secretsから環境変数を取得
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
NOTION_API_KEY = os.environ.get("NOTION_API_KEY")
NOTION_DATABASE_ID = os.environ.get("NOTION_DATABASE_ID")

# 使用モデル(無料枠あり)。詰まった場合は自動でフォールバックする
MODELS = [
    os.environ.get("GEMINI_MODEL", "gemini-3.6-flash"),
    "gemini-3.5-flash-lite",  # 高速・低コストの予備モデル
]

# 最新のGeminiクライアント初期化
client = genai.Client(api_key=GEMINI_API_KEY)

def generate_article():
    prompt = """
    あなたはビジネスパーソン向けの英語トレーナーです。
    「英語の構造化(SVOC・品詞の理解)や瞬発力」をテーマに、
    note向けのブログ記事(タイトル、本文、ハッシュタグ)を日本語で作成してください。
    出力は以下のJSON形式で行ってください。
    {
        "title": "記事のタイトル",
        "body": "記事の本文",
        "tags": "ハッシュタグ(例: #英語学習 #TOEIC)"
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
                        # JSONだけを返させる(コードブロック混入を防ぐ)
                        response_mime_type="application/json",
                    ),
                )
                print(f"✅ モデル {model} で生成に成功しました")
                return response.text
            except genai_errors.APIError as e:
                last_error = e
                if e.code == 429:
                    # レート制限: 少し待ってリトライ
                    wait = 20 * (attempt + 1)
                    print(f"⚠️ {model} がレート制限(429)。{wait}秒待って再試行します...")
                    time.sleep(wait)
                else:
                    print(f"⚠️ {model} でエラー: {e.code}。次のモデルを試します...")
                    break
        else:
            print(f"⚠️ {model} はリトライ上限に達しました。次のモデルを試します...")
    raise RuntimeError(f"すべてのモデルで生成に失敗しました: {last_error}")

def save_to_notion(title, body, tags):
    url = "https://api.notion.com/v1/pages"
    headers = {
        "Authorization": f"Bearer {NOTION_API_KEY}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
    }
    # Notionの1ブロックあたり2000文字制限に対応して本文を分割
    full_text = f"{body}\n\n{tags}"
    children = [
        {
            "object": "block",
            "paragraph": {"rich_text": [{"text": {"content": chunk}}]},
        }
        for chunk in [full_text[i:i + 1900] for i in range(0, len(full_text), 1900)]
    ]
    data = {
        "parent": {"database_id": NOTION_DATABASE_ID},
        "properties": {
            "名前": {"title": [{"text": {"content": title}}]},
        },
        "children": children,
    }
    response = requests.post(url, headers=headers, json=data)
    if response.status_code == 200:
        print("✅ Notionへの保存が成功しました!")
    else:
        print(f"❌ エラーが発生しました: {response.status_code}")
        print(response.text)

if __name__ == "__main__":
    import json
    import re

    print("Geminiで記事を生成中...")
    raw_text = generate_article()

    cleaned_text = re.sub(r'```json\n|\n```', '', raw_text).strip()

    try:
        article_data = json.loads(cleaned_text)
        title = article_data.get("title", "無題のnote記事")
        body = article_data.get("body", "本文が生成されませんでした。")
        tags = article_data.get("tags", "")
        if isinstance(tags, list):  # モデルがリストで返した場合に対応
            tags = " ".join(tags)

        print("Notionへ保存中...")
        save_to_notion(title, body, tags)

    except json.JSONDecodeError:
        print("❌ JSONの解析に失敗しました。Geminiの出力形式を確認してください。")
        print("Raw Output:\n", raw_text)
