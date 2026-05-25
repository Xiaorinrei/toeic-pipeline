/**
 * setup-template.js
 * HTMLテンプレートを絶対パスで参照できるように準備するスクリプト
 * Render.com の Build コマンドで実行: node setup-template.js
 */

const fs = require('fs');
const path = require('path');

const templatePath = path.join(__dirname, 'video-template-base.html');
const outputPath   = path.join(__dirname, 'video-template-ready.html');

if (!fs.existsSync(templatePath)) {
  console.error('❌ video-template-base.html が見つかりません');
  process.exit(1);
}

let html = fs.readFileSync(templatePath, 'utf8');

// Google Fontsが読み込めない環境のフォールバック（Render.com のヘッドレス環境用）
html = html.replace(
  '<link href="https://fonts.googleapis.com',
  '<!-- <link href="https://fonts.googleapis.com'
).replace(
  'display=swap" rel="stylesheet">',
  'display=swap" rel="stylesheet"> -->'
);

// フォントをシステムフォントにフォールバック
html = html.replace(
  "font-family: 'Noto Sans JP', sans-serif;",
  "font-family: 'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif;"
);

fs.writeFileSync(outputPath, html, 'utf8');
console.log('✅ video-template-ready.html を生成しました');
console.log('   （Puppeteerはこのファイルを参照します）');
