/**
 * server.js
 * 軽量Webhookサーバー（Render.com Free プラン）
 *
 * Make.com からデータを受け取り、GitHub Actions をキックするだけ。
 * 録画・変換・投稿はすべて GitHub Actions 側で実行。
 */

const express = require('express');
const app     = express();
app.use(express.json());

const ENV = {
  webhookSecret: process.env.WEBHOOK_SECRET || 'toeic990secret',
  githubToken:   process.env.GITHUB_TOKEN,
  githubRepo:    'Xiaorinrei/toeic-pipeline',
  port:          process.env.PORT || 3000,
};


// ─── /generate ───────────────────────────────────────────
app.post('/generate', async (req, res) => {
  if (req.headers['x-secret'] !== ENV.webhookSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { record_id, sentence, options, answer, explanation, toeic_score, content_type } = req.body;

  if (!sentence || !answer) {
    return res.status(400).json({ error: 'sentence と answer は必須です' });
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${ENV.githubRepo}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ENV.githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event_type: 'generate-video',
          client_payload: { record_id, sentence, options, answer, explanation, toeic_score, content_type },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`GitHub API: ${response.status} - ${err}`);
    }

    console.log(`✅ GitHub Actions 起動: ${sentence.slice(0, 40)}...`);
    res.status(202).json({ status: 'accepted', message: 'GitHub Actions で動画生成開始' });

  } catch (err) {
    console.error('❌ GitHub Actions 起動失敗:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── /health ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'toeic990-video-pipeline',
    uptime:  process.uptime().toFixed(0) + 's',
    env: {
      webhookSecret: !!ENV.webhookSecret,
      githubToken:   !!ENV.githubToken,
    },
  });
});


// ─── 起動 ─────────────────────────────────────────────────
app.listen(ENV.port, () => {
  console.log('\n🚀 Webhook Server 起動');
  console.log(`   Port: ${ENV.port}`);
  console.log(`   POST /generate  — Make.com Webhook → GitHub Actions`);
  console.log(`   GET  /health    — ヘルスチェック\n`);
});
