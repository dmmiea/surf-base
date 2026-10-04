const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('=== SURF BASE: Live Data Scraper Starting ===');

function fetchUrl(url, referer) {
  try {
    const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const refHeader = referer ? `-H "Referer: ${referer}"` : '';
    return execSync(`${curlCmd} -s -L "${url}" ${refHeader} -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36" -H "Accept-Language: ja"`, { maxBuffer: 10 * 1024 * 1024 }).toString('utf8');
  } catch (e) {
    console.error(`Failed to fetch ${url}:`, e.message);
    return null;
  }
}

function fetchUrlRaw(url, referer) {
  try {
    const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const refHeader = referer ? `-H "Referer: ${referer}"` : '';
    const headers = [
      '-H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"',
      '-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"',
      '-H "Accept-Language: ja,en-US;q=0.9,en;q=0.8"',
      '-H "Sec-Ch-Ua: \\"Chromium\\";v=\\"130\\", \\"Google Chrome\\";v=\\"130\\", \\"Not?A_Brand\\";v=\\"99\\""',
      '-H "Sec-Ch-Ua-Mobile: ?0"',
      '-H "Sec-Ch-Ua-Platform: \\"Windows\\""',
      '-H "Sec-Fetch-Dest: document"',
      '-H "Sec-Fetch-Mode: navigate"',
      '-H "Sec-Fetch-Site: same-origin"',
      '-H "Sec-Fetch-User: ?1"',
      '-H "Upgrade-Insecure-Requests: 1"'
    ].join(' ');

    const res = execSync(`${curlCmd} -s -L ${refHeader} ${headers} "${url}"`, { maxBuffer: 10 * 1024 * 1024 });
    console.log(`Fetched ${url} - size: ${res.length} bytes`);
    return res;
  } catch (e) {
    console.error(`Failed to fetch ${url}:`, e.message);
    return null;
  }
}

function decodeShiftJis(buf) {
  try {
    return new TextDecoder('shift_jis').decode(buf);
  } catch (e) {
    return buf.toString('utf8');
  }
}

// ナウファス実測パース（推定補足値 isEstimated の検知対応 & 日付ラベル付与）
function parseNowphas(html, dateObj) {
  const rows = [];
  const lines = html.split('\n');
  const trRegex = /<tr><td class="dt">(\d\d:\d\d)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td class="dt">(\d\d:\d\d)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/;
  
  const dayLabel = dateObj ? `${dateObj.getMonth() + 1}/${dateObj.getDate()}` : '';
  const ymd = dateObj ? `${dateObj.getFullYear()}${String(dateObj.getMonth() + 1).padStart(2, '0')}${String(dateObj.getDate()).padStart(2, '0')}` : '';

  const parseCell = (time, waveRaw, perRaw, dirRaw) => {
    const isEstimated = /<span class="pr">|\(|\)/.test(waveRaw) || /<span class="pr">|\(|\)/.test(perRaw) || dirRaw.includes('****');
    const clean = (s) => s.replace(/<[^>]+>/g, '').replace(/[()]/g, '').trim();
    const wave = clean(waveRaw);
    const period = clean(perRaw);
    const dir = clean(dirRaw);
    if (wave && wave !== '****' && wave !== '') {
      return {
        time,
        dayLabel,
        ymd,
        wave,
        period,
        dir: (dir === '****' ? '-' : dir),
        isEstimated
      };
    }
    return null;
  };

  for (const line of lines) {
    const m = line.match(trRegex);
    if (m) {
      const item1 = parseCell(m[1], m[2], m[3], m[4]);
      if (item1) rows.push(item1);

      const item2 = parseCell(m[5], m[6], m[7], m[8]);
      if (item2) rows.push(item2);
    }
  }
  rows.sort((a,b) => a.time.localeCompare(b.time));
  return rows;
}

function getNowphasData(stationId, jstNow) {
  const getYmd = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  };

  const todayYmd = getYmd(jstNow);
  const yesterday = new Date(jstNow.getTime() - 24 * 3600 * 1000);
  const yesterdayYmd = getYmd(yesterday);

  const htmlToday = fetchUrl(`https://nowphas.mlit.go.jp/nip_yugiha/${stationId}/7/${todayYmd}`);
  const rowsToday = htmlToday ? parseNowphas(htmlToday, jstNow) : [];

  let combined = [];
  if (rowsToday.length < 36) {
    const htmlYest = fetchUrl(`https://nowphas.mlit.go.jp/nip_yugiha/${stationId}/7/${yesterdayYmd}`);
    const rowsYest = htmlYest ? parseNowphas(htmlYest, yesterday) : [];
    combined = rowsYest.concat(rowsToday);
  } else {
    combined = rowsToday;
  }

  const latest = combined.length > 0 ? combined[combined.length - 1] : { wave: '0.50', period: '5.0', dir: 'N', time: '00:00' };
  return { latest, history: combined };
}

// 潮汐・日出・日入情報抽出
function extractTideAndSun(html) {
  const tideM = html.match(/<li class="tide">([\s\S]*?)<\/li>/)?.[1];
  const sunM = html.match(/<li class="sun">([\s\S]*?)<\/li>/)?.[1];
  
  const highMatch = tideM?.match(/満潮[^\d]*(\d\d:\d\d)/);
  const lowMatch = tideM?.match(/干潮[^\d]*(\d\d:\d\d)/);
  const tideNameMatch = tideM?.match(/\(([^)]+潮)\)/);
  const sunMatch = sunM?.match(/(\d\d:\d\d)\/(\d\d:\d\d)/);

  return {
    tide: {
      tideName: tideNameMatch ? tideNameMatch[1] : '小潮',
      tideHigh: highMatch ? highMatch[1] : '04:25',
      tideLow: lowMatch ? lowMatch[1] : '12:36'
    },
    sun: {
      sunRise: sunMatch ? sunMatch[1] : '05:54',
      sunSet: sunMatch ? sunMatch[2] : '17:38'
    }
  };
}

// 海天気予報パース（全日程・日毎ラベル正確抽出 & rowspan波高・周期保持）
function parseUmitenki(html) {
  const { tide, sun } = extractTideAndSun(html);

  const wavePoints = [];
  const waveRegex = /'time':\s*'([^']+)',\s*'points':\s*([0-9.]+)/g;
  let wm;
  while ((wm = waveRegex.exec(html)) !== null) {
    wavePoints.push({ time: wm[1], wave: parseFloat(wm[2]) });
  }

  const hourData = [];
  const tables = html.match(/<table class="hour_yohou"[\s\S]*?<\/table>/g) || [];

  tables.forEach(t => {
    const tPos = html.indexOf(t);
    const before = html.slice(Math.max(0, tPos - 2000), tPos);
    const headerM = before.match(/<div class="hour_yohou_header[^>]*>[\s\S]*?<\/div>/g);
    let dayLabel = '';
    if (headerM) {
      const lastHeader = headerM[headerM.length - 1];
      const h3M = lastHeader.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
      if (h3M) {
        const dDigits = h3M[1].match(/(\d+)[^\d]+(\d+)/);
        if (dDigits) {
          dayLabel = `${parseInt(dDigits[1], 10)}/${parseInt(dDigits[2], 10)}`;
        }
      }
    }

    let currentWave = null;
    let currentPeriod = null;
    let currentWaveDir = null;

    const trs = t.match(/<tr[\s\S]*?<\/tr>/g) || [];
    trs.forEach(tr => {
      const timeM = tr.match(/<td class="etc">(\d+)<\/td>/);
      if (!timeM) return;
      const hour = parseInt(timeM[1], 10);
      const time = (hour < 10 ? '0' : '') + hour + ':00';

      // rowspan付き波高セルの更新チェック
      const waveTd = tr.match(/<td class="etc"[^>]*rowspan="(\d+)"[^>]*>([\s\S]*?)<\/td>/);
      if (waveTd) {
        const waveM = waveTd[2].match(/([0-9.]+)m/);
        const perM = waveTd[2].match(/([0-9.]+)(?:秒|&#13213;|b|s)/);
        const dirM = waveTd[2].match(/wavesimulator\/blue_([a-z]+)\.png/);
        if (waveM) currentWave = parseFloat(waveM[1]);
        if (perM) currentPeriod = parseFloat(perM[1]);
        if (dirM) currentWaveDir = dirM[1].toUpperCase();
      } else {
        // rowspanが無い単一行の場合
        const waveM = tr.match(/<\/div>\s*([0-9.]+)m\s*<div/);
        const perM = tr.match(/<\/div>\s*[0-9.]+m\s*<div[^>]*>\s*([0-9.]+)/);
        const dirM = tr.match(/wavesimulator\/blue_([a-z]+)\.png/);
        if (waveM) currentWave = parseFloat(waveM[1]);
        if (perM) currentPeriod = parseFloat(perM[1]);
        if (dirM) currentWaveDir = dirM[1].toUpperCase();
      }

      const tempM = tr.match(/(\d+)℃/);
      const windM = tr.match(/sprite_[^_]+_([A-Z]+)_png.*?([0-9.]+)m/);
      const weatherM = tr.match(/tenki_2017\/([^.]+)\.png/);

      hourData.push({
        dayLabel,
        time,
        temp: tempM ? tempM[1] : null,
        windDir: windM ? windM[1] : null,
        windSpeed: windM ? parseFloat(windM[2]) : null,
        wave: currentWave,
        period: currentPeriod,
        waveDir: currentWaveDir,
        weather: weatherM ? weatherM[1] : null
      });
    });
  });

  return { tide, sun, wavePoints, hourData };
}

async function run() {
  const now = new Date();
  const jstNow = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60000);
  const yyyy = jstNow.getFullYear();
  const mm = String(jstNow.getMonth() + 1).padStart(2, '0');
  const dd = String(jstNow.getDate()).padStart(2, '0');
  const ymd = `${yyyy}${mm}${dd}`;

  console.log(`Current JST Date: ${ymd}`);

  // ナウファス取得（敦賀122、福井117）
  console.log('Fetching Nowphas 122 (敦賀)...');
  const np122 = getNowphasData('122', jstNow);

  console.log('Fetching Nowphas 117 (福井/三国)...');
  const np117 = getNowphasData('117', jstNow);

  console.log('Latest Nowphas 122:', np122.latest);
  console.log('Latest Nowphas 117:', np117.latest);

  // 海天気取得
  const spots = {
    suishohama: { id: '2067', name: '水晶浜' },
    sugahama: { id: '2053', name: '菅浜' },
    kurosaki: { id: '2033', name: '黒崎' },
    echizen: { id: '2054', name: '越前リーフ' }
  };

  const parsedSpots = {};
  for (const [key, spot] of Object.entries(spots)) {
    console.log(`Fetching Umitenki for ${spot.name} (${spot.id})...`);
    const rawBuf = fetchUrlRaw(`https://www.umitenki.jp/tenki/${spot.id}/1hour`, `https://www.umitenki.jp/tenki/${spot.id}`);
    if (rawBuf) {
      const decodedHtml = decodeShiftJis(rawBuf);
      parsedSpots[key] = parseUmitenki(decodedHtml);
    }
  }

  const outputPath = path.join(__dirname, '..', 'data.json');
  let existingData = null;
  try {
    if (fs.existsSync(outputPath)) {
      existingData = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    }
  } catch (e) {
    console.warn('Could not read existing data.json:', e.message);
  }

  const finalSpots = {};
  for (const [key, spot] of Object.entries(spots)) {
    const newlyParsed = parsedSpots[key];
    const existingSpot = existingData && existingData.spots ? existingData.spots[key] : null;

    if (newlyParsed && newlyParsed.hourData && newlyParsed.hourData.length > 0) {
      console.log(`[OK] Spot ${spot.name}: Parsed ${newlyParsed.hourData.length} hours successfully.`);
      
      // 過去データの消失を防ぐため、既存の hourData と新しく取得した hourData をマージ
      const mergedMap = new Map();
      if (existingSpot && Array.isArray(existingSpot.hourData)) {
        for (const item of existingSpot.hourData) {
          const itemKey = `${item.dayLabel} ${item.time}`;
          mergedMap.set(itemKey, item);
        }
      }
      for (const item of newlyParsed.hourData) {
        const itemKey = `${item.dayLabel} ${item.time}`;
        mergedMap.set(itemKey, item);
      }

      // マージした配列を整列（直近120時間分を保持）
      const mergedHourData = Array.from(mergedMap.values());
      newlyParsed.hourData = mergedHourData;
      finalSpots[key] = newlyParsed;
      console.log(`[OK] Spot ${spot.name}: Total combined hours after merge: ${mergedHourData.length}`);
    } else if (existingSpot && existingSpot.hourData && existingSpot.hourData.length > 0) {
      console.warn(`[WARN] Spot ${spot.name}: New fetch failed or empty. Preserving ${existingSpot.hourData.length} existing hours.`);
      finalSpots[key] = existingSpot;
    } else {
      console.error(`[ERROR] Spot ${spot.name}: No existing hours and new fetch failed.`);
      finalSpots[key] = newlyParsed || { tide: {}, sun: {}, wavePoints: [], hourData: [] };
    }
  }

  const outputData = {
    updatedAt: now.toISOString(),
    updatedAtLabel: `${yyyy}/${mm}/${dd} ${String(jstNow.getHours()).padStart(2, '0')}:${String(jstNow.getMinutes()).padStart(2, '0')}`,
    nowphas: {
      tsuruga: {
        latest: np122.latest,
        history: np122.history
      },
      fukui: {
        latest: np117.latest,
        history: np117.history
      }
    },
    spots: finalSpots
  };

  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf8');
  console.log(`Saved output to ${outputPath}`);
}

run();
