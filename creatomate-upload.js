/**
 * creatomate-upload.js
 * ローカルのMP4ファイルをCreatomate経由でCDN URLに変換する
 *
 * 役割：
 *   1. ExpressサーバーからMP4を一時的に公開URL化
 *   2. CreatomateにそのURLを渡してMP4を再処理（CDNホスティング）
 *   3. CreatomateのCDN URLを返す（Upload-Post.comがここからDLする）
 *
 * 使い方:
 *   const { uploadToCreatomate } = require('./creatomate-upload');
 *   const cdnUrl = await uploadToCreatomate(mp4FilePath, tempServerUrl);
 */

const fs   = require('fs');
const path = require('path');

const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;
const POLL_INTERVAL_MS   = 5000;
const MAX_WAIT_MS        = 300000; // 5分

/**
 * MP4をCreatomateに送ってCDN URLを取得
 * @param {string} mp4Path - ローカルのMP4ファイルパス
 * @param {string} tempUrl - そのMP4にアクセスできる一時的な公開URL（自サーバー）
 * @returns {string} - CreatomateのCDN URL
 */
async function uploadToCreatomate(mp4Path, tempUrl) {
  console.log(`  📤 Creatomate へ動画を送信中...`);
  console.log(`     ソースURL: ${tempUrl}`);

  // Creatomateに「このURLの動画を処理してCDNに置いてくれ」と頼む
  // 最もシンプルな構成：入力動画をそのままMP4として出力
  const response = await fetch('https://api.creatomate.com/v1/renders', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CREATOMATE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // テンプレートを使わず直接composition指定
      output_format: 'mp4',
      width:  1080,
      height: 1920,
      frame_rate: 30,
      duration: 32,
      elements: [
        {
          type: 'video',
          source: tempUrl,          // 自サーバーから動画を取得
          width: '100%',
          height: '100%',
          x: '50%',
          y: '50%',
          x_anchor: '50%',
          y_anchor: '50%',
          fit: 'cover',
          duration: 32,
        }
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Creatomate送信エラー: ${JSON.stringify(err)}`);
  }

  const result = await response.json();
  const renders = Array.isArray(result) ? result : [result];
  const renderId = renders[0].id;

  console.log(`     Render ID: ${renderId}`);

  // 完成を待機
  const cdnUrl = await pollForCompletion(renderId);
  console.log(`  ✅ Creatomate CDN URL: ${cdnUrl}`);
  return cdnUrl;
}

/**
 * レンダリング完了待機（ポーリング）
 */
async function pollForCompletion(renderId) {
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const res = await fetch(`https://api.creatomate.com/v1/renders/${renderId}`, {
      headers: { 'Authorization': `Bearer ${CREATOMATE_API_KEY}` },
    });

    if (!res.ok) throw new Error(`ステータス確認エラー: ${res.status}`);

    const render = await res.json();
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r     状態: ${render.status.padEnd(12)} (${elapsed}秒経過)`);

    if (render.status === 'succeeded') {
      process.stdout.write('\n');
      return render.url;
    }
    if (render.status === 'failed') {
      throw new Error(`Creatomateレンダリング失敗: ${render.error_message}`);
    }
  }

  throw new Error('Creatomateタイムアウト（5分）');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { uploadToCreatomate };
