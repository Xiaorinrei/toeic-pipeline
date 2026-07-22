import os
import requests
from google import genai

# GitHub Secretsから環境変数を取得
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
NOTION_API_KEY = os.environ.get("NOTION_API_KEY")
NOTION_DATABASE_ID = os.environ.get("NOTION_DATABASE_ID")

# Geminiクライアントの初期化
client = genai.Client(api_key=GEMINI_API_KEY)

def generate_article():
    prompt = """
    あなたはビジネスパーソン向けの英語トレーナーです。
    「英語の構造化（SVOC・品詞の理解）や瞬発力」をテーマに、
    note向けのブログ記事（タイトル、本文、ハッシュタグ）を日本語で作成してください。
    出力は以下のJSON形式で行ってください。
    {
        "title": "記事のタイトル",
        "body": "記事の本文",
        "tags": "ハッシュタグ（例: #英語学習 #TOEIC）"
    }
    """
    response = client.models.generate_content(
        model="gemini-1.5-flash",
        contents=prompt,
    )
    return response.text

def save_to_notion(title, body, tags):
    url = "https://api.notion.com/v1/pages"
    headers = {
        "Authorization": f"Bearer {NOTION_API_KEY}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
    }
    data = {
        "parent": {"database_id": NOTION_DATABASE_ID},
        "properties": {
            "名前": {"title": [{"text": {"content": title}}]},
        },
        "children": [{
            "object": "block",
            "paragraph": {"rich_text": [{"text": {"content": f"{body}\n\n{tags}"}}]},
        }],
    }
    response = requests.post(url, headers=headers, json=data)
    if response.status_code == 200:
        print("✅ Notionへの保存が成功しました！")
    else:
        print(f"❌ エラーが発生しました: {response.status_code}")
        print(response.text)

if __name__ == "__main__":
    import json
    import re
    
    # 記事を生成
    print("Geminiで記事を生成中...")
    raw_text = generate_article()
    
    # Markdownのコードブロック表記(```json)を取り除く処理
    cleaned_text = re.sub(r'```json\n|\n```', '', raw_text).strip()
    
    try:
        # JSONとして読み込む
        article_data = json.loads(cleaned_text)
        title = article_data.get("title", "無題のnote記事")
        body = article_data.get("body", "本文が生成されませんでした。")
        tags = article_data.get("tags", "")
        
        # Notionへ保存
        print("Notionへ保存中...")
        save_to_notion(title, body, tags)
        
    except json.JSONDecodeError:
        print("❌ JSONの解析に失敗しました。Geminiの出力形式を確認してください。")
        print("Raw Output:\n", raw_text)
