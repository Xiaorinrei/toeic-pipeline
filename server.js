/**
 * server.js
 * Make.com Webhook → 全工程自動実行サーバー
 * biz-toeic990.com | TOEIC SVOMC動画 自動生成パイプライン
 *
 * 全工程:
 *   Make.com → [このサーバー] → Claude台本 → OpenAI TTS → Puppeteer録画
 *   → FFmpeg変換 → Creatomate CDN → Upload-Post 4媒体投稿 → Airtable記録
 *
 * デプロイ: Render.com Web Service
 *   Build:  npm install && node setup-template.js
 *   Start:  node server.js
 */

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');

const { recordVideo }         = require('./record');
const { uploadToCreatomate }  = require('./creatomate-upload');

const app = express();
app.use(express.json());

// ─── 一時ファイル配信（Creatomate がDLするために必要）───
const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
app.use('/files', express.static(OUTPUT_DIR));

// ─── 環境変数 ───
const ENV = {
  claudeApiKey:     process.env.CLAUDE_API_KEY,
  openaiApiKey:     process.env.OPENAI_API_KEY,
  uploadPostApiKey: process.env.UPLOAD_POST_API_KEY,
  airtableApiKey:   process.env.AIRTABLE_API_KEY,
  airtableBaseId:   process.env.AIRTABLE_BASE_ID,
  webhookSecret:    process.env.WEBHOOK_SECRET || 'toeic990secret',
  serverUrl:        process.env.SERVER_URL,       // 例: https://your-app.onrender.com
  port:             process.env.PORT || 3000,
};


// ============================================================
//  /generate  — Make.com から呼ばれるメインエンドポイント
// ============================================================
app.post('/generate', async (req, res) => {
  // 認証
  if (req.headers['x-secret'] !== ENV.webhookSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    record_id, sentence, options, answer, explanation,
    toeic_score, content_type,
  } = req.body;

  // 必須フィールドチェック
  if (!sentence || !answer) {
    return res.status(400).json({ error: 'sentence と answer は必須です' });
  }

  // Make.comのタイムアウト（40秒）を回避するためすぐ202を返す
  res.status(202).json({ status: 'accepted', message: '動画生成開始' });

  // バックグラウンドで全工程実行
  runPipeline({ record_id, sentence, options, answer, explanation, toeic_score, content_type })
    .catch(err => console.error('❌ パイプライン失敗:', err.message));
});


// ============================================================
//  全工程パイプライン
// ============================================================
async function runPipeline(params) {
  const { record_id, sentence, options, answer, explanation, toeic_score, content_type } = params;
  const jobId = crypto.randomBytes(6).toString('hex');

  console.log(`\n▶ [${jobId}] パイプライン開始`);
  console.log(`  問題: ${sentence.slice(0, 60)}...`);

  try {
    // ── Step 1: Claude API で台本生成 ──
    console.log(`\n[1/5] Claude API → 台本生成`);
    const script = await generateScript({ sentence, answer, explanation });

    // ── Step 2: Puppeteer で動画録画 ──
    console.log(`\n[2/5] Puppeteer → 32秒録画`);
    const videoData = buildVideoData(script, { sentence, options, answer });
    const mp4Path   = await recordVideo(videoData, `video_${jobId}`);

    // ── Step 3: Creatomate CDN にアップロード ──
    console.log(`\n[3/5] Creatomate → CDN アップロード`);
    const filename  = path.basename(mp4Path);
    const tempUrl   = `${ENV.serverUrl}/files/${filename}`;
    const cdnUrl    = await uploadToCreatomate(mp4Path, tempUrl);

    // MP4をローカルから削除（CDNに上がったので不要）
    setTimeout(() => {
      try { fs.unlinkSync(mp4Path); } catch(e) {}
    }, 60000); // 1分後に削除

    // ── Step 4: Claude でキャプション生成 ──
    console.log(`\n[4/5] Claude API → キャプション生成`);
    const captions = await generateCaptions(script.hook_text, sentence);

    // ── Step 5: Upload-Post で4媒体投稿 ──
    console.log(`\n[5/5] Upload-Post → 4媒体同時投稿`);
    const postResult = await postToAllPlatforms(cdnUrl, captions);

    // ── Step 6: Airtable にログ記録 ──
    await logToAirtable({ record_id, cdnUrl, postResult, toeic_score, content_type, captions });

    console.log(`\n✅ [${jobId}] 完了! CDN: ${cdnUrl}`);

  } catch (err) {
    console.error(`\n❌ [${jobId}] エラー:`, err.message);
  }
}


// ============================================================
//  Step 1A: Claude API で台本生成
// ============================================================
async function generateScript({ sentence, answer, explanation }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ENV.claudeApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `以下のTOEIC Part5問題の「SVOMC品詞解説動画」用のデータをJSON形式で生成してください。

問題文: ${sentence}
正解: ${answer}
解説: ${explanation || ''}

出力JSON（このキーを必ず含めること）:
{
  "hook_text": "冒頭フック（品詞の重要性を伝える一文。感情を煽らず、知的な気づきを与える）",
  "part_label": "TOEIC PART 5 · 品詞問題",
  "subject_text": "文の主語（英語）",
  "subject_jp": "主語の日本語訳",
  "verb_text": "動詞（英語）",
  "verb_jp": "動詞の日本語訳と種類",
  "complement_text": "正解の語 + ✓",
  "complement_jp": "その品詞の説明",
  "modifier_text": "修飾語（英語・省略可）",
  "modifier_jp": "修飾語の日本語訳",
  "formula": "S + V + C(品詞) → 構造名",
  "why_a": "選択肢Aが不正解の理由（20文字以内）",
  "why_b": "選択肢Bが不正解の理由（20文字以内）",
  "why_c": "選択肢C（正解）の理由（20文字以内）",
  "why_d": "選択肢Dが不正解の理由（20文字以内）"
}`,
      }],
    }),
  });

  const data = await response.json();
  const text = data.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude台本のJSONパース失敗');
  return JSON.parse(match[0]);
}


// ============================================================
//  Step 1B: Claude API でSNSキャプション生成
// ============================================================
async function generateCaptions(hookText, sentence) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ENV.claudeApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `以下のTOEIC解説動画の各SNS用キャプションをJSONで生成してください。
安っぽい煽りは使わず、信頼感・正統派の学習コンテンツとして打ち出すこと。

フック: ${hookText}
サイト: https://biz-toeic990.com

{
  "tiktok": "TikTok用（絵文字少なめ・品格あり・ハッシュタグ5個・URL含む）",
  "instagram": "Instagram用（ハッシュタグ20個・URL含む）",
  "youtube_title": "YouTube Shortsタイトル（30文字以内・SEO最適化）",
  "youtube_description": "YouTube説明文（3行・URL含む）",
  "facebook": "Facebook用（説明的・信頼感・URL含む）"
}`,
      }],
    }),
  });

  const data = await response.json();
  const text = data.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : {
    tiktok: hookText + '\n#TOEIC #英語 #英文法\nhttps://biz-toeic990.com',
    instagram: hookText + '\n#TOEIC #英語\nhttps://biz-toeic990.com',
    youtube_title: 'TOEIC Part5 品詞解説',
    youtube_description: hookText + '\nhttps://biz-toeic990.com',
    facebook: hookText + '\nhttps://biz-toeic990.com',
  };
}


// ============================================================
//  HTMLテンプレートに渡すデータを組み立て
// ============================================================
function buildVideoData(script, { sentence, options, answer }) {
  // optionsは "A.overwhelm B.overwhelming C.overwhelmed D.overwhelmingly" 形式を想定
  const opts = parseOptions(options || '');

  return {
    hook_text:       script.hook_text,
    part_label:      script.part_label || 'TOEIC PART 5 · 品詞問題',
    question:        sentence.replace(/___+/, '___'),
    opt_a: opts.a, opt_b: opts.b, opt_c: opts.c, opt_d: opts.d,
    correct:         answer.toUpperCase(),
    subject_text:    script.subject_text,    subject_jp: script.subject_jp,
    verb_text:       script.verb_text,       verb_jp:    script.verb_jp,
    complement_text: script.complement_text, complement_jp: script.complement_jp,
    modifier_text:   script.modifier_text,   modifier_jp: script.modifier_jp,
    formula:         script.formula,
    why_a: script.why_a, why_b: script.why_b,
    why_c: script.why_c, why_d: script.why_d,
  };
}

function parseOptions(str) {
  const m = str.match(/A[.．](.+?)\s+B[.．](.+?)\s+C[.．](.+?)\s+D[.．](.+)/);
  if (m) return { a: m[1].trim(), b: m[2].trim(), c: m[3].trim(), d: m[4].trim() };
  const parts = str.split(/[,、\n]/).map(s => s.trim()).filter(Boolean);
  return { a: parts[0]||'', b: parts[1]||'', c: parts[2]||'', d: parts[3]||'' };
}


// ============================================================
//  Step 5: Upload-Post.com で4媒体投稿
// ============================================================
async function postToAllPlatforms(videoUrl, captions) {
  const results = {};
  const platforms = [
    { key: 'tiktok',     caption: captions.tiktok },
    { key: 'instagram',  caption: captions.instagram },
    { key: 'youtube',    caption: `${captions.youtube_title}\n\n${captions.youtube_description}` },
    { key: 'facebook',   caption: captions.facebook },
  ];

  for (const { key, caption } of platforms) {
    try {
      const fd = new FormData();
      fd.append('platform[]', key);
      fd.append('file_url', videoUrl);
      fd.append('caption', caption);

      const res = await fetch('https://api.upload-post.com/api/v1/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ENV.uploadPostApiKey}` },
        body: fd,
      });

      const json = await res.json().catch(() => ({}));
      results[key] = res.ok ? 'success' : `failed: ${json.message || res.status}`;
      console.log(`     ${key}: ${results[key]}`);
    } catch (err) {
      results[key] = `error: ${err.message}`;
    }
  }
  return results;
}


// ============================================================
//  Step 6: Airtable にログ記録
// ============================================================
async function logToAirtable({ record_id, cdnUrl, postResult, toeic_score, content_type, captions }) {
  if (!ENV.airtableApiKey || !ENV.airtableBaseId) return;

  try {
    await fetch(`https://api.airtable.com/v0/${ENV.airtableBaseId}/Post%20Log`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ENV.airtableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          posted_at:     new Date().toISOString(),
          question_id:   record_id ? [record_id] : [],
          video_url:     cdnUrl,
          toeic_score:   parseInt(toeic_score) || 0,
          content_type:  content_type || '',
          tiktok_status: postResult.tiktok  || '',
          ig_status:     postResult.instagram || '',
          yt_status:     postResult.youtube  || '',
          fb_status:     postResult.facebook  || '',
          caption:       captions.tiktok || '',
        },
      }),
    });
    console.log('     Airtable記録: 完了');
  } catch (err) {
    console.warn('     Airtable記録エラー（投稿は成功）:', err.message);
  }
}


// ============================================================
//  ヘルスチェック & テスト
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'toeic990-video-pipeline',
    uptime: process.uptime().toFixed(0) + 's',
    env: {
      claudeApiKey:     !!ENV.claudeApiKey,
      uploadPostApiKey: !!ENV.uploadPostApiKey,
      airtableApiKey:   !!ENV.airtableApiKey,
      serverUrl:        ENV.serverUrl || '未設定',
    },
  });
});

// テスト用エンドポイント（本番ではコメントアウト推奨）
app.post('/test', async (req, res) => {
  const sampleData = {
    record_id: 'test',
    sentence: 'The Sunrise Café staff felt ___ by the number of sandwich orders they received on Sunday.',
    options: 'A.overwhelm B.overwhelming C.overwhelmed D.overwhelmingly',
    answer: 'C',
    explanation: 'overwhelmedは感情を表す受動的形容詞。feltの補語として機能する。',
    toeic_score: '700',
    content_type: 'Part5',
  };

  res.json({ status: 'test started', message: 'ログをサーバーコンソールで確認してください' });
  runPipeline(sampleData).catch(console.error);
});


// ============================================================
//  サーバー起動
// ============================================================
app.listen(ENV.port, () => {
  console.log('\n🚀 TOEIC動画生成パイプライン サーバー起動');
  console.log(`   Port: ${ENV.port}`);
  console.log(`   POST /generate  — Make.com Webhook`);
  console.log(`   POST /test      — テスト実行`);
  console.log(`   GET  /health    — ヘルスチェック`);
  console.log(`   GET  /files/*   — 一時動画ファイル配信\n`);
});
