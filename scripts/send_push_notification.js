const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

console.log('=== SURF BASE: Push Notification Engine Starting ===');

// 1. VAPIDキー読み込み
const vapidPath = path.join(__dirname, '..', 'vapid_keys.json');
if (!fs.existsSync(vapidPath)) {
  console.log('No vapid_keys.json found. Skipping push notification.');
  process.exit(0);
}
const vapidKeys = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));

webpush.setVapidDetails(
  'mailto:surfbase-notify@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// 2. Supabase 設定
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rieomxokhexxdakmjvcr.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_rf6HdD6Kg9Oa44RUvDHnUQ_NNBbiDm1';

async function fetchSubscribersFromSupabase() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/surf_push_subscriptions?select=*`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    });
    if (res.ok) {
      const list = await res.json();
      console.log(`[Supabase] Loaded ${list.length} subscribers successfully.`);
      return list;
    } else {
      console.warn(`[Supabase] Failed to fetch subscribers (status ${res.status})`);
    }
  } catch (e) {
    console.warn('[Supabase] Fetch error:', e.message);
  }
  return [];
}

async function removeExpiredSubscription(endpoint) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/surf_push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    });
    console.log(`[Supabase] Cleaned up expired subscription: ${endpoint.slice(0, 35)}...`);
  } catch (e) {}
}

async function run() {
  // 購読者一覧取得 (Supabase優先、ローカルsubscriptions.jsonフォールバック)
  let subscribers = await fetchSubscribersFromSupabase();

  if (subscribers.length === 0) {
    const subPath = path.join(__dirname, '..', 'subscriptions.json');
    if (fs.existsSync(subPath)) {
      try {
        const localSubs = JSON.parse(fs.readFileSync(subPath, 'utf8'));
        subscribers = localSubs.map(s => ({
          endpoint: s.endpoint,
          p256dh: s.keys?.p256dh,
          auth: s.keys?.auth,
          timing_morning: true,
          timing_evening: true,
          timing_instant: true,
          auto_pickup: true,
          fav_spots: ['suishohama', 'sugahama', 'kounohama']
        }));
      } catch (e) {}
    }
  }

  // 環境変数からの単一購読もサポート
  if (process.env.WEB_PUSH_SUBSCRIPTION) {
    try {
      const envSub = JSON.parse(process.env.WEB_PUSH_SUBSCRIPTION);
      if (!subscribers.some(s => s.endpoint === envSub.endpoint)) {
        subscribers.push({
          endpoint: envSub.endpoint,
          p256dh: envSub.keys?.p256dh,
          auth: envSub.keys?.auth,
          timing_morning: true,
          timing_evening: true,
          timing_instant: true,
          auto_pickup: true,
          fav_spots: ['suishohama', 'sugahama', 'kounohama']
        });
      }
    } catch (e) {}
  }

  if (subscribers.length === 0) {
    console.log('No subscribers registered. Push notification skipped.');
    return;
  }

  // 3. 最新データ読み込み
  const dataPath = path.join(__dirname, '..', 'data.json');
  if (!fs.existsSync(dataPath)) {
    console.log('No data.json found. Skipping.');
    return;
  }
  const surfData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  // スポットルール読み込み
  const rulesPath = path.join(__dirname, '..', 'spot_rules.json');
  const spotRules = fs.existsSync(rulesPath) ? JSON.parse(fs.readFileSync(rulesPath, 'utf8')) : {};

  // 現在のJST時刻
  const now = new Date();
  const jstNow = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60000);
  const curHour = jstNow.getHours();
  const curMin = jstNow.getMinutes();

  // 判定モードの決定 (--timing morning / evening / instant / test)
  const args = process.argv.slice(2);
  let timingMode = 'auto';
  const timingArg = args.find(a => a.startsWith('--timing=') || a === '--test');
  if (timingArg === '--test') {
    timingMode = 'test';
  } else if (timingArg) {
    timingMode = timingArg.split('=')[1];
  } else {
    // 自動判定:
    // JST 8:45〜9:20 -> morning (朝9:00便: 今日＆明日の波予報)
    // JST 19:15〜19:45 -> evening (夜19:30便: 明日の朝イチ確定予報)
    if (curHour === 9 && curMin < 25) {
      timingMode = 'morning';
    } else if (curHour === 19 && curMin >= 15 && curMin <= 45) {
      timingMode = 'evening';
    } else {
      timingMode = 'instant';
    }
  }

  console.log(`Current JST: ${jstNow.toISOString().replace('T', ' ').slice(0, 19)} | Mode: ${timingMode}`);

  // 日付ヘルパー
  const todayM = jstNow.getMonth() + 1;
  const todayD = jstNow.getDate();
  const todayLabel = `${todayM}/${todayD}`;

  const tomorrowObj = new Date(jstNow.getTime() + 24 * 3600 * 1000);
  const tomorrowM = tomorrowObj.getMonth() + 1;
  const tomorrowD = tomorrowObj.getDate();
  const tomorrowLabel = `${tomorrowM}/${tomorrowD}`;

  // スポット評価ヘルパー
  function evaluateForecast(spotKey, item) {
    const rule = spotRules[spotKey];
    if (!rule || !item) return { rate: 'FLAT', size: 'スネ' };

    const wave = item.wave || 0;
    const period = item.period || 5.0;
    const waveDir = item.waveDir || 'N';
    const windDir = item.windDir || 'N';
    const windSpeed = item.windSpeed || 3.0;

    if (wave >= rule.closeoutWave) return { rate: 'CLOSE', size: 'クローズ' };
    if (wave < rule.minPlayWave) return { rate: 'FLAT', size: 'サイズ不足' };

    let sizeStr = '腰〜胸';
    if (wave >= rule.chestHeadWave) sizeStr = '胸〜肩・頭';
    else if (wave >= rule.minPlayWave) sizeStr = '腿〜腰';

    const isOffshore = rule.offshoreWinds.includes(windDir);
    const isGoodWaveDir = rule.bestWaveDirs.includes(waveDir);
    const isGoodPeriod = period >= rule.minPeriod;

    if (isOffshore && isGoodWaveDir && isGoodPeriod) {
      if (period >= rule.bestPeriod - 0.5) return { rate: 'BEST', size: sizeStr };
      return { rate: 'GOOD', size: sizeStr };
    } else if (isOffshore || (windSpeed <= 3.5 && isGoodWaveDir)) {
      return { rate: 'FAIR', size: sizeStr };
    }
    return { rate: 'POOR', size: sizeStr };
  }

  // 履歴管理ファイル（同一通知の重複防止）
  const historyPath = path.join(__dirname, 'notification_history.json');
  let history = { lastMorningDate: '', lastEveningDate: '', instantAlerts: {} };
  if (fs.existsSync(historyPath)) {
    try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch (e) {}
  }

  // ==========================================
  // 各モードのペイロード生成ヘルパー
  // ==========================================
  function generatePayloadForSubscriber(sub) {
    // 購読者のお気に入り設定フィルタ
    const userFavs = new Set(Array.isArray(sub.fav_spots) ? sub.fav_spots : []);
    const isAutoPickup = sub.auto_pickup !== false;

    const isTargetSpot = (key) => {
      if (userFavs.has(key)) return true;
      if (isAutoPickup) return true; // 全ポイント自動ピックアップ
      return false;
    };

    // A. 朝便: 今日これからの波 ＆ 明日の先取り予報
    if (timingMode === 'morning' || (timingMode === 'test' && args.includes('--morning'))) {
      if (!sub.timing_morning && timingMode !== 'test') return null;

      const goodToday = [];
      const goodTomorrow = [];

      for (const [key, spot] of Object.entries(surfData.spots || {})) {
        if (!isTargetSpot(key)) continue;
        const rule = spotRules[key];
        if (!rule || !Array.isArray(spot.hourData)) continue;

        // 今日
        const todayHours = spot.hourData.filter(h => h.dayLabel === todayLabel);
        for (const h of todayHours) {
          const ev = evaluateForecast(key, h);
          if (ev.rate === 'BEST' || ev.rate === 'GOOD') {
            if (!goodToday.some(g => g.key === key)) {
              goodToday.push({ key, name: rule.name, time: h.time, rate: ev.rate, size: ev.size, isFav: userFavs.has(key) });
            }
          }
        }

        // 明日
        const tomorrowHours = spot.hourData.filter(h => h.dayLabel === tomorrowLabel);
        for (const h of tomorrowHours) {
          const ev = evaluateForecast(key, h);
          if (ev.rate === 'BEST' || ev.rate === 'GOOD') {
            if (!goodTomorrow.some(g => g.key === key)) {
              goodTomorrow.push({ key, name: rule.name, time: h.time, rate: ev.rate, size: ev.size, isFav: userFavs.has(key) });
            }
          }
        }
      }

      if (goodToday.length > 0 || goodTomorrow.length > 0 || timingMode === 'test') {
        let body = '';
        if (goodToday.length > 0) {
          const list = goodToday.slice(0, 3).map(g => `${g.name}(${g.size} ${g.rate})`).join(', ');
          body += `【今日】${list}\n`;
        } else {
          body += '【今日】サイズ不足・オンショア気味\n';
        }

        if (goodTomorrow.length > 0) {
          const list = goodTomorrow.slice(0, 3).map(g => `${g.name}(${g.size} ${g.rate})`).join(', ');
          body += `【明日先取り】${list}`;
        } else {
          body += '【明日先取り】サイズ控えめ';
        }

        return {
          title: '🌅 SURF BASE: 今日＆明日の波予報！',
          body,
          url: './index.html',
          tag: 'surf-base-morning-' + todayLabel
        };
      }
      return null;
    }

    // B. 夜便: 明日の朝イチ・日中狙い目予報
    if (timingMode === 'evening' || (timingMode === 'test' && args.includes('--evening'))) {
      if (!sub.timing_evening && timingMode !== 'test') return null;

      const goodTomorrow = [];

      for (const [key, spot] of Object.entries(surfData.spots || {})) {
        if (!isTargetSpot(key)) continue;
        const rule = spotRules[key];
        if (!rule || !Array.isArray(spot.hourData)) continue;

        const tomorrowHours = spot.hourData.filter(h => h.dayLabel === tomorrowLabel);
        for (const h of tomorrowHours) {
          const ev = evaluateForecast(key, h);
          if (ev.rate === 'BEST' || ev.rate === 'GOOD') {
            if (!goodTomorrow.some(g => g.key === key)) {
              goodTomorrow.push({ key, name: rule.name, time: h.time, rate: ev.rate, size: ev.size });
            }
          }
        }
      }

      if (goodTomorrow.length > 0 || timingMode === 'test') {
        const sample = goodTomorrow.slice(0, 4).map(g => `${g.name}: ${g.time}頃 ${g.size}(${g.rate})`).join('\n');
        return {
          title: '🌙 SURF BASE: 明日の狙い目ポイント！',
          body: sample || '明日狙い目のポイントがあります！',
          url: './index.html',
          tag: 'surf-base-evening-' + todayLabel
        };
      }
      return null;
    }

    // C. テスト送信モード
    if (timingMode === 'test') {
      return {
        title: '🏄‍♂️ SURF BASE: テスト通知',
        body: 'Supabase経由のプッシュ通知接続が完了しました！波予報が届きます。',
        url: './index.html',
        tag: 'surf-base-test-' + Date.now()
      };
    }

    // D. 即時サイズアップ速報
    if (timingMode === 'instant') {
      if (!sub.timing_instant) return null;

      const newlyGood = [];
      const alertCutoffTime = Date.now() - 12 * 3600 * 1000;

      for (const [key, spot] of Object.entries(surfData.spots || {})) {
        if (!isTargetSpot(key)) continue;
        const rule = spotRules[key];
        if (!rule || !Array.isArray(spot.hourData) || spot.hourData.length === 0) continue;

        const nearHours = spot.hourData.slice(0, 6);
        for (const h of nearHours) {
          const ev = evaluateForecast(key, h);
          if (ev.rate === 'BEST' || ev.rate === 'GOOD') {
            const lastSent = history.instantAlerts[key] || 0;
            if (lastSent < alertCutoffTime) {
              newlyGood.push({ key, name: rule.name, rate: ev.rate, size: ev.size, time: h.time });
              history.instantAlerts[key] = Date.now();
              break;
            }
          }
        }
      }

      if (newlyGood.length > 0) {
        const names = newlyGood.map(g => `${g.name}(${g.size})`).join(', ');
        return {
          title: '⚡ SURF BASE: サイズアップ速報！',
          body: `【${names}】が${newlyGood[0].rate}予報に上昇しました！🌊`,
          url: './index.html',
          spotKey: newlyGood[0].key,
          tag: 'surf-base-instant-' + newlyGood[0].key
        };
      }
      return null;
    }

    return null;
  }

  // 4. 全購読者へマルチキャスト配信
  let successCount = 0;
  let failCount = 0;
  let sentCount = 0;

  const pushPromises = subscribers.map(async (sub, idx) => {
    const payload = generatePayloadForSubscriber(sub);
    if (!payload) return;

    sentCount++;
    const pushSub = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth
      }
    };

    try {
      const res = await webpush.sendNotification(pushSub, JSON.stringify(payload));
      console.log(`[OK] Sent to subscriber #${idx + 1} (status ${res.statusCode})`);
      successCount++;
    } catch (err) {
      console.warn(`[FAIL] Subscriber #${idx + 1}: ${err.message}`);
      failCount++;
      // 有効期限切れ・無効な購読（410 Gone / 404 Not Found）は自動クリーンアップ
      if (err.statusCode === 410 || err.statusCode === 404) {
        await removeExpiredSubscription(sub.endpoint);
      }
    }
  });

  await Promise.all(pushPromises);

  console.log(`Push summary: ${sentCount} targeted, ${successCount} success, ${failCount} failed.`);

  // 履歴更新
  if (timingMode === 'morning') history.lastMorningDate = todayLabel;
  if (timingMode === 'evening') history.lastEveningDate = todayLabel;
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
}

run().catch(console.error);
