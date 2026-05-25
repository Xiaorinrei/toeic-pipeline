/**
 * record.js
 * Puppeteerでビデオテンプレートを32秒録画してMP4を出力する
 *
 * 使い方（単体テスト）:
 *   node record.js
 *   → output/test_video.webm + output/test_video.mp4 が生成される
 *
 * server.js から呼ぶ場合:
 *   const { recordVideo } = require('./record');
 *   const mp4Path = await recordVideo(questionData, outputFileName);
 */

const puppeteer  = require('puppeteer-core');
const chromium   = require('@sparticuz/chromium');
const { execSync, exec } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const ffmpegPath = require('ffmpeg-static');

const TEMPLATE_PATH = path.join(__dirname, 'video-template-ready.html');
const OUTPUT_DIR    = path.join(__dirname, 'output');
const VIDEO_DURATION_MS = 32000;  // 32秒

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * メイン録画関数
 * @param {Object} data - 問題データ（URLパラメータに変換する）
 * @param {string} filename - 出力ファイル名（拡張子なし）
 * @returns {string} - MP4ファイルのフルパス
 */
async function recordVideo(data, filename = 'video_' + Date.now()) {
  const webmPath = path.join(OUTPUT_DIR, filename + '.webm');
  const mp4Path  = path.join(OUTPUT_DIR, filename + '.mp4');

  // データをBase64 JSONとしてURLパラメータに変換
  const encodedData = encodeURIComponent(Buffer.from(JSON.stringify(data)).toString('base64'));
  const fileUrl = `file://${TEMPLATE_PATH}?data=${encodedData}&autoplay=1`;

  console.log(`  📹 Puppeteer起動中...`);
  const executablePath = await chromium.executablePath();
  const browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      '--disable-web-security',
      '--allow-file-access-from-files',
      '--window-size=1080,1920',
      '--force-device-scale-factor=1',
    ],
    defaultViewport: { width: 1080, height: 1920 },
    executablePath,
    headless: chromium.headless,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });

  // ページを開く
  await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 30000 });

  // フォント読み込み待ち
  await page.waitForTimeout(800);

  console.log(`  ⏺  録画開始（32秒）...`);

  // Puppeteer v22+ の screencast API で録画
  const recorder = await page.screencast({ path: webmPath });

  // アニメーションを開始
  await page.evaluate(() => {
    if (window.startVideo) window.startVideo();
  });

  // 32秒待機
  await new Promise(resolve => setTimeout(resolve, VIDEO_DURATION_MS + 500));

  await recorder.stop();
  await browser.close();

  console.log(`  ✅ WebM録画完了: ${webmPath}`);

  // FFmpegでWebM → MP4に変換
  const mp4 = await convertToMp4(webmPath, mp4Path);

  // WebMを削除（MP4だけ残す）
  fs.unlinkSync(webmPath);

  return mp4;
}

/**
 * FFmpegでWebM→MP4変換
 */
async function convertToMp4(webmPath, mp4Path) {
  console.log(`  🔄 FFmpeg: WebM → MP4 変換中...`);

  return new Promise((resolve, reject) => {
    const cmd = [
      `"${ffmpegPath}" -y`,
      `-i "${webmPath}"`,
      '-c:v libx264',
      '-preset fast',
      '-crf 23',
      '-pix_fmt yuv420p',
      '-movflags +faststart',
      `-vf "scale=1080:1920"`,
      `"${mp4Path}"`,
    ].join(' ');

    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error('FFmpegエラー:', stderr);
        reject(new Error('FFmpeg変換失敗: ' + err.message));
      } else {
        const size = (fs.statSync(mp4Path).size / 1024 / 1024).toFixed(1);
        console.log(`  ✅ MP4変換完了: ${mp4Path} (${size}MB)`);
        resolve(mp4Path);
      }
    });
  });
}

// ─── 単体テスト用サンプルデータ ───
const sampleData = {
  hook_text:       '品詞がわかると、英文は「理詰め」で解けるようになる',
  part_label:      'TOEIC PART 5 · 品詞問題',
  question:        'The Sunrise Café staff felt ___ by the number of sandwich orders they received on Sunday.',
  opt_a: 'overwhelm', opt_b: 'overwhelming', opt_c: 'overwhelmed', opt_d: 'overwhelmingly',
  correct:         'C',
  subject_text:    'The Sunrise Café staff',   subject_jp: 'サンライズカフェのスタッフは',
  verb_text:       'felt',                      verb_jp:    '〜と感じた（知覚動詞）',
  complement_text: 'overwhelmed ✓',             complement_jp: '形容詞が入る位置',
  modifier_text:   'by the number of...',       modifier_jp: '注文数に（原因）',
  formula:         'S + felt + C（形容詞） → SVC構造',
  why_a: '補語の位置に動詞原形は入らない',
  why_b: '「圧倒する側」。スタッフが圧倒する？逆',
  why_c: '「圧倒された」＝受ける側。felt + 形容詞のCに完璧',
  why_d: '副詞はCの位置に置けない',
  cta_main: 'この解析を、全問題で。毎日、積み上げる。',
};

// 直接実行された場合（テスト）
if (require.main === module) {
  console.log('\n🎬 録画テスト開始');
  recordVideo(sampleData, 'test_video')
    .then(mp4 => {
      console.log(`\n✨ 成功！ MP4: ${mp4}`);
      console.log('   VLCや QuickTimeで確認してください');
    })
    .catch(err => {
      console.error('\n❌ エラー:', err.message);
      process.exit(1);
    });
}

module.exports = { recordVideo };
