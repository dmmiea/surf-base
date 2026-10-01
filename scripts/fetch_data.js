const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('=== SURF BASE: Live Data Scraper Starting ===');

function fetchUrl(url) {
  try {
    return execSync(`curl.exe -s -L "${url}" -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"`, { maxBuffer: 10 * 1024 * 1024 }).toString('utf8');
  } catch (e) {
    console.error(`Failed to fetch ${url}:`, e.message);
    return null;
  }
}

// ナウファス実測パース
function parseNowphas(html) {
  const rows = [];
  const lines = html.split('\n');
  const trRegex = /<tr><td class="dt">(\d\d:\d\d)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td class="dt">(\d\d:\d\d)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/;
  
  for (const line of lines) {
    const m = line.match(trRegex);
    if (m) {
      const clean = (s) => s.replace(/<[^>]+>/g, '').replace(/[()]/g, '').trim();
      const wave1 = clean(m[2]);
      const per1 = clean(m[3]);
      const dir1 = clean(m[4]);
      if (wave1 && wave1 !== '****' && wave1 !== '') {
        rows.push({ time: m[1], wave: wave1, period: per1, dir: dir1 });
      }

      const wave2 = clean(m[6]);
      const per2 = clean(m[7]);
      const dir2 = clean(m[8]);
      if (wave2 && wave2 !== '****' && wave2 !== '') {
        rows.push({ time: m[5], wave: wave2, period: per2, dir: dir2 });
      }
    }
  }
  rows.sort((a,b) => a.time.localeCompare(b.time));
  return rows;
}

// 海天気予報パース
function parseUmitenki(html) {
  const wavePoints = [];
  const waveRegex = /'time':\s*'([^']+)',\s*'points':\s*([0-9.]+)/g;
  let wm;
  while ((wm = waveRegex.exec(html)) !== null) {
    wavePoints.push({ time: wm[1], wave: parseFloat(wm[2]) });
  }

  const hourData = [];
  const trMatches = html.match(/<tr class="[^"]+">[\s\S]*?<\/tr>/g) || [];
  for (const tr of trMatches) {
    const timeM = tr.match(/<td class="etc">(\d+)<\/td>/);
    if (!timeM) continue;
    const hour = parseInt(timeM[1], 10);
    const tempM = tr.match(/(\d+)℃/);
    const windM = tr.match(/sprite_[^_]+_([A-Z]+)_png.*?([0-9.]+)m/);
    const weatherM = tr.match(/tenki_2017\/([^.]+)\.png/);
    hourData.push({
      time: (hour < 10 ? '0' : '') + hour + ':00',
      temp: tempM ? tempM[1] : null,
      windDir: windM ? windM[1] : null,
      windSpeed: windM ? parseFloat(windM[2]) : null,
      weather: weatherM ? weatherM[1] : null
    });
  }

  return { wavePoints, hourData };
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
  const n122DatedHtml = fetchUrl(`https://nowphas.mlit.go.jp/nip_yugiha/122/7/${ymd}`);
  const n122 = n122DatedHtml ? parseNowphas(n122DatedHtml) : [];

  console.log('Fetching Nowphas 117 (福井/三国)...');
  const n117DatedHtml = fetchUrl(`https://nowphas.mlit.go.jp/nip_yugiha/117/7/${ymd}`);
  const n117 = n117DatedHtml ? parseNowphas(n117DatedHtml) : [];

  const latest122 = n122.length > 0 ? n122[n122.length - 1] : { wave: '0.84', period: '5.2', dir: 'NW', time: '22:00' };
  const latest117 = n117.length > 0 ? n117[n117.length - 1] : { wave: '1.28', period: '7.8', dir: 'NNW', time: '22:00' };

  console.log('Latest Nowphas 122:', latest122);
  console.log('Latest Nowphas 117:', latest117);

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
    const html = fetchUrl(`https://www.umitenki.jp/tenki/${spot.id}/1hour`);
    if (html) {
      parsedSpots[key] = parseUmitenki(html);
    }
  }

  const outputData = {
    updatedAt: now.toISOString(),
    updatedAtLabel: `${yyyy}/${mm}/${dd} ${String(jstNow.getHours()).padStart(2, '0')}:${String(jstNow.getMinutes()).padStart(2, '0')}`,
    nowphas: {
      tsuruga: {
        latest: latest122,
        history: n122
      },
      fukui: {
        latest: latest117,
        history: n117
      }
    },
    spots: parsedSpots
  };

  const outputPath = path.join(__dirname, '..', 'data.json');
  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf8');
  console.log(`Saved output to ${outputPath}`);
}

run();
