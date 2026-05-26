/**
 * pipeline.js
 * GitHub Actions上で実行される全工程スクリプト
 *
 * 工程:
 *   payload.json 読み込み
 *   → Claude API: 台本生成
 *   → Puppeteer: 32秒録画
 *   → FFmpeg: WebM→MP4変換 + BGM合成
 *   → Creatomate: CDNアップロード
 *   → Upload-Post: 4媒体投稿
 *   → Airtable: ログ記録
 */

const puppeteer = require('puppeteer');
const { exec }  = require('child_process');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');

// ─── 設定 ───────────────────────────────────────────────
const TEMPLATE_PATH     = path.join(__dirname, 'video-template-ready.html');
const OUTPUT_DIR        = path.join(__dirname, 'output');
const BGM_PATH          = path.join(__dirname, 'bgm.mp3');
const VIDEO_DURATION_MS = 32000;

const ENV = {
  claudeApiKey:      process.env.CLAUDE_API_KEY,
  creatomateApiKey:  process.env.CREATOMATE_API_KEY,
  uploadPostApiKey:  process.env.UPLOAD_POST_API_KEY,
  airtableApiKey:    process.env.AIRTABLE_API_KEY,
  airtableBaseId:    process.env.AIRTABLE_BASE_ID,
  serverUrl:         process.env.SERVER_URL,
};

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── メイン ─────────────────────────────────────────────
async function main() {
  // payload.json から問題データ読み込み
  const params = JSON.parse(fs.readFileSync('payload.json', 'utf8'));
  const { record_id, sentence, options, answer, explanation, toeic_score, content_type } = params;
  const jobId = crypto.randomBytes(6).toString('hex');

  console.log(`\n▶ [${jobId}] パイプライン開始`);
  console.log(`  問題: ${sentence?.slice(0, 60)}...`);

  // Step 1: Claude → 台本
  console.log('\n[1/5] Claude API → 台本生成');
  const script = await generateScript({ sentence, answer, explanation });

  // Step 2: Puppeteer → 録画
  console.log('\n[2/5] Puppeteer → 32秒録画');
  const videoData = buildVideoData(script, { sentence, options, answer });
  const rawMp4 = await recordVideo(videoData, `video_${jobId}`);

  // Step 3: BGM合成
  console.log('\n[3/5] FFmpeg → BGM合成');
  const finalMp4 = await addBgm(rawMp4, rawMp4.replace('.mp4', '_bgm.mp4'));

  // Step 4: Creatomate → CDN
  console.log('\n[4/5] Creatomate → CDNアップロード');
  const cdnUrl = await uploadToCreatomate(finalMp4);

  // Step 5: Claude → キャプション生成 + Upload-Post → 投稿
  console.log('\n[5/5] Claude → キャプション + Upload-Post → 4媒体投稿');
  const captions   = await generateCaptions(script.hook_text, sentence);
  const postResult = await postToAllPlatforms(cdnUrl, captions);

  // Step 6: Airtable → ログ
  await logToAirtable({ record_id, cdnUrl, postResult, toeic_score, content_type, captions });

  console.log(`\n✅ [${jobId}] 完了! CDN: ${cdnUrl}`);
}


// ─── Step 1: Claude 台本生成 ─────────────────────────────
async function generateScript({ sentence, answer, explanation }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
  "hook_text": "冒頭フック（品詞の重要性を伝える一文）",
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

  const data  = await res.json();
  const text  = data.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude台本のJSONパース失敗');
  return JSON.parse(match[0]);
}


// ─── Step 2: Puppeteer 録画 ──────────────────────────────
async function recordVideo(data, filename) {
  const webmPath = path.join(OUTPUT_DIR, filename + '.webm');
  const mp4Path  = path.join(OUTPUT_DIR, filename + '.mp4');

  const encodedData = encodeURIComponent(Buffer.from(JSON.stringify(data)).toString('base64'));
  const fileUrl     = `file://${TEMPLATE_PATH}?data=${encodedData}&autoplay=1`;

  console.log('  📹 Puppeteer起動中...');
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--allow-file-access-from-files',
      '--window-size=1080,1920',
    ],
    defaultViewport: { width: 1080, height: 1920 },
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
  await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise(r => setTimeout(r, 800));

  console.log('  ⏺  録画開始（32秒）...');
  const recorder = await page.screencast({ path: webmPath });

  await page.evaluate(() => { if (window.startVideo) window.startVideo(); });
  await new Promise(r => setTimeout(r, VIDEO_DURATION_MS + 500));

  await recorder.stop();
  await browser.close();
  console.log(`  ✅ 録画完了`);

  // WebM → MP4
  await convertToMp4(webmPath, mp4Path);
  fs.unlinkSync(webmPath);
  return mp4Path;
}

function convertToMp4(webmPath, mp4Path) {
  console.log('  🔄 FFmpeg: WebM → MP4...');
  return new Promise((resolve, reject) => {
    const cmd = [
      'ffmpeg -y',
      `-i "${webmPath}"`,
      '-c:v libx264 -preset fast -crf 23',
      '-pix_fmt yuv420p -movflags +faststart',
      `-vf "scale=1080:1920"`,
      `"${mp4Path}"`,
    ].join(' ');
    exec(cmd, (err, _out, stderr) => {
      if (err) { console.error(stderr); reject(err); }
      else { console.log('  ✅ MP4変換完了'); resolve(mp4Path); }
    });
  });
}


// ─── Step 3: BGM合成 ─────────────────────────────────────
async function addBgm(videoPath, outputPath) {
  if (!fs.existsSync(BGM_PATH)) {
    console.log('  ℹ️  bgm.mp3 なし → BGMなしで続行');
    return videoPath;
  }

  console.log('  🎵 BGM合成中...');
  return new Promise((resolve) => {
    const cmd = [
      'ffmpeg -y',
      `-i "${videoPath}"`,
      `-i "${BGM_PATH}"`,
      '-filter_complex "[1:a]volume=0.12,afade=t=in:ss=0:d=2,afade=t=out:st=29:d=3[bgm];[bgm]amix=inputs=1:duration=first[aout]"',
      '-map 0:v -map "[aout]"',
      '-c:v copy -c:a aac -b:a 128k -shortest',
      `"${outputPath}"`,
    ].join(' ');
    exec(cmd, (err) => {
      if (err) {
        console.warn('  ⚠️  BGM合成失敗。BGMなしで続行');
        resolve(videoPath);
      } else {
        fs.unlinkSync(videoPath);
        console.log('  ✅ BGM合成完了');
        resolve(outputPath);
      }
    });
  });
}


// ─── Step 4: transfer.sh に一時アップロード → 公開URL取得 ──
async function uploadToCreatomate(mp4Path) {
  console.log(`  📤 transfer.sh にアップロード中...`);

  const filename   = path.basename(mp4Path);
  const fileBuffer = fs.readFileSync(mp4Path);

  const res = await fetch(`https://transfer.sh/${encodeURIComponent(filename)}`, {
    method: 'PUT',
    body: fileBuffer,
    headers: {
      'Content-Type': 'video/mp4',
      'Max-Days': '3',
    },
  });

  if (!res.ok) throw new Error(`transfer.sh: ${res.status} ${await res.text()}`);
  const url = (await res.text()).trim();
  console.log(`  ✅ 公開URL: ${url}`);
  return url;
}


// ─── Step 5A: Claude キャプション生成 ───────────────────
async function generateCaptions(hookText, sentence) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
正統派・信頼感重視。安っぽい煽りなし。

フック: ${hookText}
サイト: https://biz-toeic990.com

{
  "tiktok": "TikTok用（絵文字少なめ・ハッシュタグ5個・URL含む）",
  "instagram": "Instagram用（ハッシュタグ20個・URL含む）",
  "youtube_title": "YouTube Shortsタイトル（30文字以内）",
  "youtube_description": "YouTube説明文（3行・URL含む）",
  "facebook": "Facebook用（説明的・URL含む）"
}`,
      }],
    }),
  });
  const data  = await res.json();
  const text  = data.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : {
    tiktok:              hookText + '\n#TOEIC #英語\nhttps://biz-toeic990.com',
    instagram:           hookText + '\n#TOEIC #英語\nhttps://biz-toeic990.com',
    youtube_title:       'TOEIC Part5 品詞解説',
    youtube_description: hookText + '\nhttps://biz-toeic990.com',
    facebook:            hookText + '\nhttps://biz-toeic990.com',
  };
}


// ─── Step 5B: Upload-Post 4媒体投稿 ─────────────────────
async function postToAllPlatforms(videoUrl, captions) {
  const results   = {};
  const platforms = [
    { key: 'tiktok',    caption: captions.tiktok },
    { key: 'instagram', caption: captions.instagram },
    { key: 'youtube',   caption: `${captions.youtube_title}\n\n${captions.youtube_description}` },
    { key: 'facebook',  caption: captions.facebook },
  ];
  for (const { key, caption } of platforms) {
    try {
      const fd = new FormData();
      fd.append('platform[]', key);
      fd.append('file_url', videoUrl);
      fd.append('caption', caption);
      const res  = await fetch('https://api.upload-post.com/api/v1/upload', {
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


// ─── Step 6: Airtable ログ記録 ───────────────────────────
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
          tiktok_status: postResult.tiktok    || '',
          ig_status:     postResult.instagram  || '',
          yt_status:     postResult.youtube    || '',
          fb_status:     postResult.facebook   || '',
          caption:       captions.tiktok       || '',
        },
      }),
    });
    console.log('     Airtable記録: 完了');
  } catch (err) {
    console.warn('     Airtable記録エラー:', err.message);
  }
}


// ─── ヘルパー ────────────────────────────────────────────
function buildVideoData(script, { sentence, options, answer }) {
  const opts = parseOptions(options || '');
  return {
    hook_text:       script.hook_text,
    part_label:      script.part_label || 'TOEIC PART 5 · 品詞問題',
    question:        sentence.replace(/___+/, '___'),
    opt_a: opts.a, opt_b: opts.b, opt_c: opts.c, opt_d: opts.d,
    correct:         answer.toUpperCase(),
    subject_text:    script.subject_text,    subject_jp:    script.subject_jp,
    verb_text:       script.verb_text,       verb_jp:       script.verb_jp,
    complement_text: script.complement_text, complement_jp: script.complement_jp,
    modifier_text:   script.modifier_text,   modifier_jp:   script.modifier_jp,
    formula:         script.formula,
    why_a: script.why_a, why_b: script.why_b,
    why_c: script.why_c, why_d: script.why_d,
  };
}

function parseOptions(str) {
  // オブジェクト形式 {"A": "...", "B": "...", ...} の場合
  if (str && typeof str === 'object') {
    return {
      a: str.A || str.a || '',
      b: str.B || str.b || '',
      c: str.C || str.c || '',
      d: str.D || str.d || '',
    };
  }
  // 文字列形式の場合
  if (!str || typeof str !== 'string') return { a: '', b: '', c: '', d: '' };
  const m = str.match(/A[.．](.+?)\s+B[.．](.+?)\s+C[.．](.+?)\s+D[.．](.+)/);
  if (m) return { a: m[1].trim(), b: m[2].trim(), c: m[3].trim(), d: m[4].trim() };
  const parts = str.split(/[,、\n]/).map(s => s.trim()).filter(Boolean);
  return { a: parts[0]||'', b: parts[1]||'', c: parts[2]||'', d: parts[3]||'' };
}


// ─── 実行 ────────────────────────────────────────────────
main().catch(err => {
  console.error('\n❌ パイプライン失敗:', err.message);
  process.exit(1);
});
