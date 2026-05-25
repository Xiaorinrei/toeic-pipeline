# Make.com シナリオ設定ガイド
## biz-toeic990.com｜TOEIC動画 自動生成パイプライン

---

## 概要

Make.com が毎日9時に起動し、Airtable から問題データを取得して
Render.com のサーバーに送るだけ。あとは全部サーバーが自動でやってくれる。

```
Make.com (スケジュール起動)
  └─ Airtable: 未投稿の問題を1件取得
  └─ HTTP: Render.com /generate にデータを送信
       └─ [server.js が全部やる]
            ├─ Claude API → 台本生成
            ├─ Puppeteer → 32秒録画
            ├─ FFmpeg → MP4変換
            ├─ Creatomate → CDNアップロード
            ├─ Upload-Post → 4媒体投稿
            └─ Airtable → ログ記録
```

---

## Make.com モジュール設定（全3ステップ）

### Module 1: Schedule（スケジュールトリガー）

| 設定項目 | 値 |
|---|---|
| Run scenario | Every Day |
| Time | 09:00 |
| Timezone | Asia/Tokyo |

---

### Module 2: Airtable - Search Records（問題取得）

**接続設定:**
- Connection: Airtable（APIキーで接続）
- Base: `TOEIC 自動化管理`
- Table: `Questions`

**Filter設定:**
```
WHERE status = "未投稿"
LIMIT 1
SORT BY created_at ASC（古いものから順番に投稿）
```

**マッピング（右パネルで設定）:**
| Airtableフィールド | 使用目的 |
|---|---|
| record_id | 投稿後に「投稿済み」フラグを立てるため |
| sentence | 問題文 |
| options | 選択肢（A.xxx B.xxx形式） |
| answer | 正解（A/B/C/D） |
| explanation | 日本語解説 |
| toeic_score | 難易度スコア |
| content_type | Part5 / Vocabulary など |

---

### Module 3: HTTP - Make a Request（サーバーに送信）

| 設定項目 | 値 |
|---|---|
| URL | `https://YOUR-APP.onrender.com/generate` |
| Method | POST |
| Body Type | JSON |
| Content-Type | application/json |

**Headersに追加:**
| キー | 値 |
|---|---|
| x-secret | `toeic990secret`（環境変数 WEBHOOK_SECRET と一致させる） |

**Body（JSON）:**
```json
{
  "record_id":    "{{2.id}}",
  "sentence":     "{{2.sentence}}",
  "options":      "{{2.options}}",
  "answer":       "{{2.answer}}",
  "explanation":  "{{2.explanation}}",
  "toeic_score":  "{{2.toeic_score}}",
  "content_type": "{{2.content_type}}"
}
```

> ※ `{{2.xxx}}` はModule 2（Airtable）の出力データ

---

### Module 4（オプション）: Airtable - Update Record（フラグ更新）

投稿が完了したら Airtable の `status` を `未投稿` → `投稿済み` に更新。

| 設定項目 | 値 |
|---|---|
| Connection | Airtable |
| Base | `TOEIC 自動化管理` |
| Table | `Questions` |
| Record ID | `{{2.id}}` |
| Fields → status | `投稿済み` |
| Fields → posted_date | `{{now}}` |

---

## Render.com デプロイ手順

### 1. GitHubにコードをプッシュ

```bash
# toeic-video-pipeline フォルダで実行
cd toeic-video-pipeline
git init
git add .
git commit -m "初回コミット: TOEIC動画生成パイプライン"
git remote add origin https://github.com/あなたのユーザー名/toeic-pipeline.git
git push -u origin main
```

### 2. Render.com でWeb Serviceを作成

1. [render.com](https://render.com) でアカウント登録
2. ダッシュボード → **New** → **Web Service**
3. GitHubリポジトリを接続
4. 以下を設定:

| 設定項目 | 値 |
|---|---|
| Name | toeic990-pipeline |
| Region | Oregon (US West) |
| Branch | main |
| Runtime | Node |
| Build Command | `npm install && node setup-template.js` |
| Start Command | `node server.js` |
| Instance Type | Free（最初はこれでOK） |

### 3. 環境変数を設定（Render.com → Environment）

| 変数名 | 値 | 取得場所 |
|---|---|---|
| `CLAUDE_API_KEY` | sk-ant-... | console.anthropic.com |
| `OPENAI_API_KEY` | sk-... | platform.openai.com |
| `CREATOMATE_API_KEY` | ... | creatomate.com → Settings |
| `UPLOAD_POST_API_KEY` | ... | upload-post.com → Dashboard |
| `AIRTABLE_API_KEY` | pat... | airtable.com → Account |
| `AIRTABLE_BASE_ID` | app... | AirtableのURLから取得 |
| `WEBHOOK_SECRET` | toeic990secret | 任意の文字列（Make.comと一致させる） |
| `SERVER_URL` | https://your-app.onrender.com | デプロイ後に確認してから設定 |

### 4. デプロイ確認

デプロイ完了後、以下のURLにアクセス:
```
https://your-app.onrender.com/health
```

以下のようなJSONが返れば成功:
```json
{
  "status": "ok",
  "service": "toeic990-video-pipeline",
  "uptime": "42s"
}
```

---

## 動作テスト

### ローカルでテスト
```bash
# record.js 単体テスト（Puppeteer録画確認）
node record.js
# → output/test_video.mp4 が生成される
```

### サーバーのテストエンドポイント
```bash
curl -X POST https://your-app.onrender.com/test
# サーバーのログを確認して全工程が動くか確認
```

---

## Airtable テーブル設計

### テーブル①: Questions（問題データ）

| フィールド名 | タイプ | 説明 |
|---|---|---|
| sentence | Long Text | TOEIC問題文（___を使う） |
| options | Long Text | A.xxx B.xxx C.xxx D.xxx 形式 |
| answer | Single Line | 正解記号（A/B/C/D） |
| explanation | Long Text | 日本語解説 |
| toeic_score | Number | 難易度スコア（500/600/700/800/900） |
| content_type | Single Select | Part5 / Part7 / Vocabulary / Preposition / Business |
| status | Single Select | 未投稿 / 投稿済み / スキップ |
| posted_date | Date | 投稿日（自動記録） |

### テーブル②: Post Log（投稿ログ）

| フィールド名 | タイプ | 説明 |
|---|---|---|
| posted_at | Date/Time | 投稿日時 |
| question_id | Link → Questions | 問題とのリンク |
| video_url | URL | Creatomate CDN URL |
| toeic_score | Number | 難易度 |
| content_type | Single Select | コンテンツ種別 |
| tiktok_status | Single Select | success / failed |
| ig_status | Single Select | success / failed |
| yt_status | Single Select | success / failed |
| fb_status | Single Select | success / failed |
| caption | Long Text | 使用したキャプション |

---

## よくあるエラーと対処

| エラー | 原因 | 対処 |
|---|---|---|
| Puppeteerがクラッシュ | メモリ不足 | Render.comを有料プラン($7/月)に変更 |
| FFmpegが見つからない | システムにFFmpegが入っていない | Render.comのビルドコマンドに`apt-get install -y ffmpeg`を追加 |
| Creatomateタイムアウト | 動画処理が5分以上かかる | 通常2分以内。ネットワーク問題の場合は再実行 |
| Upload-Postが失敗 | SNSアカウントの連携切れ | upload-post.comでアカウント再連携 |

---

*biz-toeic990.com | TOEIC動画自動生成パイプライン*
*最終更新: 2026-05-25*
