'use strict';

/**
 * 宝くじ当選番号 自動更新スクリプト
 * 楽天宝くじ（直近10回分）から最新結果を取得し、web/auto-update-data.js を更新します。
 *
 * 使用方法:
 *   node updater/fetch-results.js
 *
 * Windowsタスクスケジューラでの自動実行:
 *   run-update.bat を毎週金曜 23:00 に実行するよう設定してください。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SOURCES = {
  loto7: 'https://takarakuji.rakuten.co.jp/backnumber/loto7/lastresults/',
  loto6: 'https://takarakuji.rakuten.co.jp/backnumber/loto6/lastresults/',
};

// ローカルは web/ サブフォルダ構成、GitHub Actions はルート直下構成に対応
const webDir     = path.join(__dirname, '..', 'web');
const OUTPUT_PATH = fs.existsSync(webDir)
  ? path.join(webDir, 'auto-update-data.js')
  : path.join(__dirname, '..', 'auto-update-data.js');
const LOG_PATH    = path.join(__dirname, 'update.log');

function log(msg) {
  const line = `[${new Date().toLocaleString('ja-JP')}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n', 'utf8'); } catch {}
}

function fetchHtml(url, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('リダイレクトが多すぎます'));
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en-US;q=0.9',
        'Accept-Encoding': 'identity',
      },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        res.resume();
        const nextUrl = loc.startsWith('http') ? loc : new URL(loc, url).href;
        return fetchHtml(nextUrl, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('タイムアウト')); });
  });
}

/**
 * HTML から直近10回分の抽選結果をパース
 * 構造: <tr><td><span>第0670回</span>2026/03/27</td><td><ul class="loto-popup-number"><li>3</li>...</ul></td><td><ul class="loto-popup-number num-bonus"><li>15</li>...</ul></td></tr>
 */
function parseResults(html) {
  const results = [];

  // tbody 内の各 tr を抽出
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return results;

  const rowPattern = /<tr>([\s\S]*?)<\/tr>/g;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(tbodyMatch[1])) !== null) {
    const row = rowMatch[1];

    // セルを分割
    const cells = [];
    const cellPattern = /<td>([\s\S]*?)<\/td>/g;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(row)) !== null) cells.push(cellMatch[1]);
    if (cells.length < 3) continue;

    // 回号: 第0670回 → 670
    const roundMatch = cells[0].match(/第0*(\d+)回/);
    // 日付: 2026/03/27 → 2026-03-27
    const dateMatch = cells[0].match(/(\d{4})\/(\d{2})\/(\d{2})/);
    if (!roundMatch || !dateMatch) continue;

    const round = parseInt(roundMatch[1], 10);
    const date  = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;

    // 本数字（num-bonus クラスなしの ul 内 li）
    const mainSection = cells[1].replace(/<ul[^>]*class="[^"]*num-bonus[^"]*"[^>]*>[\s\S]*?<\/ul>/g, '');
    const mainNums = [...mainSection.matchAll(/<li>(\d+)<\/li>/g)].map(m => parseInt(m[1], 10));

    // ボーナス数字（num-bonus クラスの ul 内 li）
    const bonusNums = [...cells[2].matchAll(/<li>(\d+)<\/li>/g)].map(m => parseInt(m[1], 10));

    if (mainNums.length === 0 || bonusNums.length === 0) continue;

    const entry = { round, date, main: mainNums };
    entry.bonus = bonusNums[0];
    if (bonusNums.length >= 2) entry.bonus2 = bonusNums[1];

    results.push(entry);
  }

  return results;
}

async function main() {
  log('========== 宝くじ自動更新 開始 ==========');

  const data = { loto6: [], loto7: [] };
  let hasError = false;

  for (const [game, url] of Object.entries(SOURCES)) {
    try {
      log(`${game}: フェッチ中... ${url}`);
      const html = await fetchHtml(url);
      const results = parseResults(html);

      if (results.length === 0) {
        log(`${game}: 警告 - 結果が0件でした（HTMLの構造が変わった可能性があります）`);
        hasError = true;
        continue;
      }

      data[game] = results;
      log(`${game}: ${results.length}件取得 (最新: 第${results[0].round}回 ${results[0].date})`);
    } catch (err) {
      log(`${game}: エラー - ${err.message}`);
      hasError = true;
    }
  }

  // どちらかのデータが取得できた場合のみ出力ファイルを更新
  if (data.loto6.length > 0 || data.loto7.length > 0) {
    const timestamp = new Date().toISOString();
    const content =
`// 自動更新データ — 最終更新: ${timestamp}
// このファイルは updater/fetch-results.js によって自動生成されます。手動編集しないでください。
/* global window */
window.AUTO_UPDATE_LOTO6 = ${JSON.stringify(data.loto6, null, 2)};
window.AUTO_UPDATE_LOTO7 = ${JSON.stringify(data.loto7, null, 2)};
window.AUTO_UPDATE_TIMESTAMP = '${timestamp}';
`;
    fs.writeFileSync(OUTPUT_PATH, content, 'utf8');
    log(`出力完了: ${OUTPUT_PATH}`);
  } else {
    log('警告: すべてのゲームでデータ取得に失敗したため、ファイルを更新しませんでした。');
  }

  log(`========== 完了 ${hasError ? '(一部エラーあり)' : '(正常)'} ==========`);
  process.exit(hasError ? 1 : 0);
}

main().catch(err => {
  log(`致命的エラー: ${err.message}`);
  process.exit(1);
});
