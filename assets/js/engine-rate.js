/* ============================================================
   引擎二 · 方案测算保险费率（输入保险方案 → 输出保险费率）
   ------------------------------------------------------------
   调用 Open-Meteo Archive API（真实再分析气象，无需密钥、CORS 友好）
   回测多年期望赔付率 → Bootstrap 费率区间；输出 ULR 与校准建议。
   升级：支持「多责任合计」(同县同作物多灾种逐年叠加封顶100%得合计ULR，
   校准至 70%-75%)；数据源标注；样本量置信度提示。
   数据真实可溯源，非模拟；最终以精算报备与监管批复为准。
   ============================================================ */
(function () {
  'use strict';
  var KB = window.AGRI_KB;
  var EXPENSE = 0.15;   // 费用率 15%
  var RISKLOAD = 0.10;  // 风险附加 10%
  var TARGET_ULR = [0.70, 0.75]; // 终极赔付率目标带（合计）

  // 模块级：分段赔付比例表（[阈值, 赔付%]）
  var curRatio = [];
  var curRatio2 = [];
  // 模块级：线性赔付参数（起赔点 a / 全赔点 f；frost/drought 为 low 方向 a>f）
  var curLinear = { a: null, f: null, peril: null };
  var curLinear2 = { a: null, f: null, peril: null };

  // 各灾种线性默认参数 [起赔点, 全赔点]；与阶梯 DEFS 起赔档对齐，全赔点≈最强一档
  var LINEAR_DEFS = {
    rainy: [3, 7],      // 连续降水日数（high）
    storm: [50, 150],   // 单日降水 mm（high）
    frost: [0, -5],     // 最低气温 ℃（low）
    heat: [35, 45],     // 最高气温 ℃（high）
    drought: [40, 5],   // 累计降水 mm（low）
    wind: [13.8, 24]    // 最大风速 m/s（high）
  };
  var LINEAR_UNIT = { rainy: '日', storm: 'mm', frost: '℃', heat: '℃', drought: 'mm', wind: 'm/s' };

  // 线性赔付：V 相对起赔 a → 全赔 f 连续折算，封顶 100%
  function linearPayout(V, a, f, dir) {
    if (a === f) return 0;
    var t = dir === 'low' ? (a - V) / (a - f) : (V - a) / (f - a);
    return Math.max(0, Math.min(1, t));
  }
  // 统一取赔付：linear 走连续折算，step 走分档查表
  function payLookup(S, V, dir) {
    if (S.paytype === 'linear') return (S.linA == null || S.linF == null) ? 0 : linearPayout(V, S.linA, S.linF, dir);
    return lookup(S.ratio, V, dir);
  }

  function pct(x, d) { return (x * 100).toFixed(d === undefined ? 2 : d) + '%'; }

  /* ---------- 初始化表单 ---------- */
  function initForm() {
    var sel = document.getElementById('rt-city');
    KB.cities.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.lat + ',' + c.lon + ',' + c.z;
      o.textContent = c.n + '（' + c.p + '）';
      sel.appendChild(o);
    });
    var cs = document.getElementById('rt-crop');
    Object.keys(KB.crops).forEach(function (k) {
      var o = document.createElement('option'); o.value = k; o.textContent = KB.crops[k].name; cs.appendChild(o);
    });
    var pl = document.getElementById('rt-peril');
    PERILS.forEach(function (p) {
      var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; pl.appendChild(o);
    });
    var pl2 = document.getElementById('rt-peril2');
    if (pl2) { pl2.innerHTML = '<option value="">— 不添加 —</option>'; PERILS.forEach(function (p) { var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; pl2.appendChild(o); }); }
    document.getElementById('rt-sum').value = 400;
    document.getElementById('rt-years').value = '20';
    document.getElementById('rt-m1').value = 7; document.getElementById('rt-d1').value = 1;
    document.getElementById('rt-m2').value = 10; document.getElementById('rt-d2').value = 15;
    buildRatioEditor(curRatio, DEFS[peril], 'rt-ratio');
    // 方案类型切换（阶梯↔线性）
    var pt = document.getElementById('rt-paytype');
    if (pt) pt.addEventListener('change', applyPayType);
    // 保险费率 = 纯风险损失率 ÷ 成本比例（自动联动）
    var costI = document.getElementById('rt-cost'), preI = document.getElementById('rt-prerate');
    function syncPrerate() {
      var t = parseFloat(document.getElementById('rt-trial').value) || 0;
      var c = parseFloat((costI && costI.value) || 0) || 0;
      if (preI) preI.value = (t > 0 && c > 0) ? (t / c * 100).toFixed(2) : '';
    }
    var trialI = document.getElementById('rt-trial');
    if (trialI) trialI.addEventListener('input', syncPrerate);
    if (costI) costI.addEventListener('input', syncPrerate);
    ensureLinear(curLinear, peril, 'rt-linear');
    syncPrerate();
    applyPayType();
    bindPeril();
    pl.addEventListener('change', bindPeril);
    if (pl2) { pl2.addEventListener('change', bindPeril2); }
    var multi = document.getElementById('rt-multi');
    if (multi) multi.addEventListener('change', toggleMulti);
    document.getElementById('rt-run').addEventListener('click', runBacktest);
    document.getElementById('rt-reset').addEventListener('click', resetForm);
    bindPresets();
  }

  var PERILS = [['drought', '干旱/降水亏缺'], ['frost', '低温霜冻'], ['heat', '高温热害'], ['rainy', '连阴雨渍涝'], ['storm', '暴雨洪涝'], ['wind', '大风倒伏']];

  // 不同灾害的动态参数提示
  function bindPeril() {
    var peril = document.getElementById('rt-peril').value;
    var box = document.getElementById('rt-peril-params');
    var extra = peril === 'rainy'
      ? '<label class="rt-l">起赔连续日数 <input id="rt-minrun" type="number" value="3" min="1" step="1" class="rt-i"></label>'
      : '';
    box.innerHTML = extra + '<div class="rt-hint">' + HINTS[peril] + '</div>';
    buildRatioEditor(curRatio, DEFS[peril], 'rt-ratio');
    ensureLinear(curLinear, peril, 'rt-linear');
  }
  function bindPeril2() {
    var p2 = document.getElementById('rt-peril2');
    if (!p2 || !p2.value) { curRatio2 = []; renderRatioEditor(curRatio2, 'rt-ratio2'); return; }
    buildRatioEditor(curRatio2, DEFS[p2.value], 'rt-ratio2');
    ensureLinear(curLinear2, p2.value, 'rt-linear2');
  }
  function toggleMulti() {
    var on = document.getElementById('rt-multi').checked;
    var box = document.getElementById('rt-multi-box');
    if (box) box.style.display = on ? 'block' : 'none';
    if (on) bindPeril2();
  }

  var HINTS = {
    rainy: '连阴雨：窗口内<b>最长连续降水(≥1mm)日数</b>达「起赔日数」即触发；按连续日数查分段赔付；可多次事故累积封顶。',
    storm: '暴雨：窗口内<b>单日最大降水(mm)</b>越阈值触发；按强度查分段赔付。',
    frost: '低温：窗口内<b>最低气温(℃)</b>越低越赔（阈值取负值，如 0 / -2 / -4）。',
    heat: '高温：窗口内<b>最高气温(℃)</b>越阈值触发；按强度查分段赔付。',
    drought: '干旱：窗口内<b>累计降水(mm)</b>越低越赔（阈值如 40 / 20 / 5）。',
    wind: '大风：窗口内<b>最大风速(m/s)</b>越阈值触发（13.8≈7级）。'
  };
  var DEFS = {
    rainy: [['3', 10], ['5', 20], ['7', 30]],
    storm: [['50', 10], ['100', 20]],
    frost: [['-1', 10], ['-3', 20], ['-5', 30]],
    heat: [['35', 10], ['37', 20], ['39', 30]],
    drought: [['40', 10], ['20', 20], ['5', 30]],
    wind: [['13.8', 10], ['17', 20], ['20.8', 30]]
  };

  function buildRatioEditor(arr, pairs, boxId) {
    // 复制默认到目标数组
    arr.length = 0;
    pairs.forEach(function (p) { arr.push([String(p[0]), Number(p[1])]); });
    renderRatioEditor(arr, boxId);
  }
  function renderRatioEditor(arr, boxId) {
    var box = document.getElementById(boxId);
    if (!box) return;
    var html = '<div class="rt-re-head">分段赔付比例表（触发阈值 → 赔付占保额比例%）</div>';
    arr.forEach(function (row, i) {
      html += '<div class="rt-re-row"><input class="rt-i rt-k" data-i="' + i + '" value="' + row[0] + '">' +
        '<span class="rt-arrow">→</span><input class="rt-i rt-v" data-i="' + i + '" value="' + row[1] + '"><span>%</span>' +
        '<button class="rt-del" data-i="' + i + '">×</button></div>';
    });
    html += '<button class="rt-add" data-add="' + boxId + '">+ 添加一行</button>';
    box.innerHTML = html;
    box.querySelectorAll('.rt-k,.rt-v').forEach(function (el) {
      el.addEventListener('input', function () {
        var i = +el.dataset.i;
        arr[i][el.classList.contains('rt-k') ? 0 : 1] = el.classList.contains('rt-k') ? el.value : (+el.value || 0);
      });
    });
    box.querySelectorAll('.rt-del').forEach(function (el) {
      el.addEventListener('click', function () { arr.splice(+el.dataset.i, 1); renderRatioEditor(arr, boxId); });
    });
    box.querySelectorAll('.rt-add').forEach(function (el) {
      el.addEventListener('click', function () { arr.push(['0', 10]); renderRatioEditor(arr, boxId); });
    });
  }

  /* ---------- 方案类型：阶梯型（分档查表）/ 线性理赔阈值（起赔→全赔连续折算） ---------- */
  function getPayType() {
    var pt = document.getElementById('rt-paytype');
    return (pt && pt.value) === 'linear' ? 'linear' : 'step';
  }
  function applyPayType() {
    var linear = getPayType() === 'linear';
    [['rt-ratio-box', 'rt-linear-box'], ['rt-ratio2-box', 'rt-linear2-box']].forEach(function (pair) {
      var b = document.getElementById(pair[0]), l = document.getElementById(pair[1]);
      if (b) b.style.display = linear ? 'none' : '';
      if (l) l.style.display = linear ? '' : 'none';
    });
  }
  function ensureLinear(L, peril, boxId) {
    if (L.peril !== peril || L.a == null || L.f == null) {
      var d = LINEAR_DEFS[peril] || [0, 1];
      L.a = d[0]; L.f = d[1]; L.peril = peril;
    }
    renderLinearEditor(L, peril, boxId);
  }
  function renderLinearEditor(L, peril, boxId) {
    var box = document.getElementById(boxId);
    if (!box) return;
    var dir = (peril === 'frost' || peril === 'drought') ? 'low' : 'high';
    var unit = LINEAR_UNIT[peril] || '';
    var op = dir === 'low' ? '≤' : '≥';
    var rows = ''; // 起赔→全赔均匀 5 档采样展示
    for (var i = 0; i < 5; i++) {
      var v = L.a + (L.f - L.a) * i / 4;
      var p = linearPayout(v, L.a, L.f, dir) * 100;
      rows += '<tr><td>' + op + ' ' + (Math.round(v * 10) / 10) + ' ' + unit + '</td><td>' + (Math.round(p * 10) / 10) + '%</td></tr>';
    }
    box.innerHTML =
      '<div class="rt-re-row"><span>起赔点</span><input class="rt-i rt-la" value="' + L.a + '">' +
      '<span class="rt-arrow">→</span><span>全赔点</span><input class="rt-i rt-lf" value="' + L.f + '"><span>' + unit + '</span></div>' +
      '<div class="rt-hint">赔付比例 = |' + (dir === 'low' ? '起赔点−实际值' : '实际值−起赔点') + '| ÷ |起赔点−全赔点| × 100%，' +
      (dir === 'low' ? '越低越赔' : '越高越赔') + '；连续线性折算、封顶 100%</div>' +
      '<table class="claimtb" style="margin-top:6px"><thead><tr><th>指数值（' + unit + '）</th><th>赔付比例（线性采样）</th></tr></thead><tbody>' + rows + '</tbody></table>';
    var la = box.querySelector('.rt-la'), lf = box.querySelector('.rt-lf');
    function upd() {
      var a = parseFloat(la.value), f = parseFloat(lf.value);
      if (isNaN(a) || isNaN(f) || a === f) return;
      L.a = a; L.f = f;
      renderLinearEditor(L, peril, boxId);
    }
    if (la) la.addEventListener('change', upd);
    if (lf) lf.addEventListener('change', upd);
  }

  /* ---------- 由引擎一方案载入 ---------- */
  function loadFromScheme(scheme) {
    var S = scheme.combo ? scheme.combo : scheme.primary ? { primary: scheme.primary } : scheme;
    var p1 = scheme.combo ? scheme.combo.primary : scheme.primary;
    var p2 = scheme.combo ? scheme.combo.secondary : null;
    document.getElementById('rt-crop').value = scheme.crop;
    document.getElementById('rt-peril').value = p1.peril;
    document.getElementById('rt-m1').value = p1.window[0]; document.getElementById('rt-d1').value = p1.window[1];
    document.getElementById('rt-m2').value = p1.window[2]; document.getElementById('rt-d2').value = p1.window[3];
    document.getElementById('rt-sum').value = scheme.sumInsured;
    var city = KB.cities.filter(function (c) { return c.z === scheme.zone; })[0] || KB.cities[0];
    document.getElementById('rt-city').value = city.lat + ',' + city.lon + ',' + city.z;
    bindPeril();
    buildRatioEditor(curRatio, Object.keys(p1.ratio).map(function (k) { return [k, Math.round(p1.ratio[k] * 100)]; }), 'rt-ratio');
    var pt = document.getElementById('rt-paytype');
    if (pt) pt.value = scheme.paytype === 'linear' ? 'linear' : 'step';
    ensureLinear(curLinear, p1.peril, 'rt-linear');
    applyPayType();
    var multi = document.getElementById('rt-multi');
    if (p2 && multi) {
      multi.checked = true; toggleMulti();
      document.getElementById('rt-peril2').value = p2.peril;
      buildRatioEditor(curRatio2, Object.keys(p2.ratio).map(function (k) { return [k, Math.round(p2.ratio[k] * 100)]; }), 'rt-ratio2');
      ensureLinear(curLinear2, p2.peril, 'rt-linear2');
    } else if (multi) { multi.checked = false; toggleMulti(); }
  }

  /* ---------- 读数 ---------- */
  function readScheme() {
    var cv = (document.getElementById('rt-city').value || '').split(',');
    var lat = parseFloat(document.getElementById('rt-lat').value) || +cv[0];
    var lon = parseFloat(document.getElementById('rt-lon').value) || +cv[1];
    var peril = document.getElementById('rt-peril').value;
    var ratio = {}; curRatio.forEach(function (r) { ratio[r[0]] = (+r[1] || 0) / 100; });
    var multi = document.getElementById('rt-multi') && document.getElementById('rt-multi').checked;
    var peril2 = multi ? (document.getElementById('rt-peril2').value || '') : '';
    var ratio2 = {}; if (peril2) { curRatio2.forEach(function (r) { ratio2[r[0]] = (+r[1] || 0) / 100; }); }
    return {
      lat: lat, lon: lon, crop: document.getElementById('rt-crop').value,
      peril: peril, peril2: peril2, multi: multi,
      paytype: getPayType(),
      linA: curLinear.a, linF: curLinear.f,
      linA2: curLinear2.a, linF2: curLinear2.f,
      trial: parseFloat(document.getElementById('rt-trial').value) || 0,
      cost: parseFloat((document.getElementById('rt-cost') || {}).value) || 75,
      m1: +document.getElementById('rt-m1').value, d1: +document.getElementById('rt-d1').value,
      m2: +document.getElementById('rt-m2').value, d2: +document.getElementById('rt-d2').value,
      sum: +document.getElementById('rt-sum').value || 400,
      years: +document.getElementById('rt-years').value || 20,
      minRun: +(document.getElementById('rt-minrun') ? document.getElementById('rt-minrun').value : 3),
      ratio: ratio, ratio2: ratio2,
      dir: (peril === 'frost' || peril === 'drought') ? 'low' : 'high',
      dir2: (peril2 === 'frost' || peril2 === 'drought') ? 'low' : 'high',
      source: (document.getElementById('rt-source') && document.getElementById('rt-source').value) || 'openmeteo',
      proxy: !!(document.getElementById('rt-proxy') && document.getElementById('rt-proxy').checked),
      precipFactor: parseFloat((document.getElementById('rt-pfac') || {}).value) || 1.0,
      yieldArr: parseYield((document.getElementById('rt-yield') || {}).value || '')
    };
  }

  // 解析历史单产序列（逗号/空格/换行分隔，逐年，与回测年序同序）
  function parseYield(t) {
    if (!t) return [];
    return t.split(/[\s,，]+/).map(function (x) { return parseFloat(x); })
      .filter(function (x) { return !isNaN(x); });
  }

  /* ---------- 气象取数（Open-Meteo Archive，逐年） ---------- */
  async function fetchYear(lat, lon, y) {
    var url = 'https://archive-api.open-meteo.com/v1/archive?latitude=' + lat + '&longitude=' + lon +
      '&start_date=' + y + '-01-01&end_date=' + y + '-12-31' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&timezone=Asia%2FShanghai';
    var r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json();
    return j.daily;
  }

  function windowIdx(time, m1, d1, m2, d2) {
    var out = [];
    for (var i = 0; i < time.length; i++) {
      var md = time[i].slice(5);
      var mm = +md.slice(0, 2), dd = +md.slice(3, 5);
      if (m2 >= m1) {
        if ((mm > m1 || (mm === m1 && dd >= d1)) && (mm < m2 || (mm === m2 && dd <= d2))) out.push(i);
      } else {
        if ((mm > m1 || (mm === m1 && dd >= d1)) || (mm < m2 || (mm === m2 && dd <= d2))) out.push(i);
      }
    }
    return out;
  }

  function triggerRatio(peril, daily, idx, S) {
    if (!idx.length) return 0;
    if (peril === 'rainy') {
      var precip = idx.map(function (i) { return daily.precipitation_sum[i] == null ? 0 : daily.precipitation_sum[i]; });
      var ratio = 0, run = 0;
      for (var i = 0; i <= precip.length; i++) {
        if (i < precip.length && precip[i] >= 1) { run++; }
        else { if (run >= S.minRun) ratio += payLookup(S, run, 'high'); run = 0; }
      }
      return Math.min(1, ratio);
    }
    if (peril === 'storm') {
      var p2 = idx.map(function (i) { return daily.precipitation_sum[i] == null ? 0 : daily.precipitation_sum[i]; });
      return payLookup(S, Math.max.apply(null, p2), 'high');
    }
    if (peril === 'frost') {
      var tmin = idx.map(function (i) { return daily.temperature_2m_min[i]; }).filter(function (v) { return v != null; });
      if (!tmin.length) return 0;
      return payLookup(S, Math.min.apply(null, tmin), 'low');
    }
    if (peril === 'heat') {
      var tmax = idx.map(function (i) { return daily.temperature_2m_max[i]; }).filter(function (v) { return v != null; });
      if (!tmax.length) return 0;
      return payLookup(S, Math.max.apply(null, tmax), 'high');
    }
    if (peril === 'drought') {
      var cum = idx.reduce(function (a, i) { return a + (daily.precipitation_sum[i] == null ? 0 : daily.precipitation_sum[i]); }, 0);
      return payLookup(S, cum, 'low');
    }
    if (peril === 'wind') {
      var wind = idx.map(function (i) { return (daily.wind_speed_10m_max[i] == null ? 0 : daily.wind_speed_10m_max[i]) / 3.6; });
      if (!wind.length) return 0;
      return payLookup(S, Math.max.apply(null, wind), 'high');
    }
    return 0;
  }

  function lookup(ratio, V, dir) {
    var keys = Object.keys(ratio).map(Number);
    var valid = dir === 'high' ? keys.filter(function (k) { return V >= k; }) : keys.filter(function (k) { return V <= k; });
    if (!valid.length) return 0;
    var k = dir === 'high' ? Math.max.apply(null, valid) : Math.min.apply(null, valid);
    return ratio[k] || 0;
  }

  /* ---------- 本地气象缓存（试点县预下载，断网/秒开优先） ---------- */
  var _manifest = null, _countyCache = {};
  async function getManifest() {
    if (_manifest) return _manifest;
    try { var r = await fetch('assets/data/counties.json'); _manifest = await r.json(); }
    catch (e) { _manifest = { counties: [] }; }
    return _manifest;
  }
  function nearestCached(lat, lon) {
    if (!_manifest || !_manifest.counties.length) return null;
    var best = null, bd = 1e9;
    _manifest.counties.forEach(function (c) {
      if (!c.file) return; // 仅匹配已打包本地逐日气象的县；未打包(file 为空)走在线回测
      var d = Math.hypot(c.lat - lat, c.lon - lon);
      if (d < bd) { bd = d; best = c; }
    });
    return bd <= 0.6 ? best : null; // 0.6°≈60km 内匹配最近缓存县
  }
  async function loadCounty(c) {
    if (_countyCache[c.adcode]) return _countyCache[c.adcode];
    var j = await (await fetch('assets/data/' + c.file)).json();
    _countyCache[c.adcode] = j;
    return j;
  }
  async function fetchYearCached(lat, lon, y, onSrc) {
    var m = await getManifest();
    var c = nearestCached(lat, lon);
    if (c && c.file && y >= c.from && y <= c.to) {
      try {
        var j = await loadCounty(c);
      var time = [], tmax = [], tmin = [], prcp = [], wind = [];
      for (var i = 0; i < j.time.length; i++) {
        if (+j.time[i].slice(0, 4) === y) {
          time.push(j.time[i]); tmax.push(j.tmax[i]); tmin.push(j.tmin[i]); prcp.push(j.prcp[i]); wind.push(j.wind[i]);
        }
      }
      if (time.length && onSrc) onSrc(c.name + '（本地缓存 ' + c.from + '–' + c.to + '）');
        return { time: time, temperature_2m_max: tmax, temperature_2m_min: tmin, precipitation_sum: prcp, wind_speed_10m_max: wind };
      } catch (e) {
        // 本地缓存缺失/损坏 → 退回在线回测，不阻断主流程
      }
    }
    return fetchYear(lat, lon, y);
  }

  /* ---------- 无站点近似标定：多格点均值 + 降水偏差校正 ---------- */
  var PROXY_OFFSETS = [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]];
  async function getDaily(lat, lon, y, S, onSrc) {
    if (S.proxy) {
      var arrs = [];
      for (var k = 0; k < PROXY_OFFSETS.length; k++) {
        var d = await fetchYearCached(lat + PROXY_OFFSETS[k][0], lon + PROXY_OFFSETS[k][1], y);
        arrs.push(Calibrate.normDaily(d));
      }
      var merged = Calibrate.countyMean(arrs);
      if (onSrc) onSrc('县域多格点均值（ERA5 5 点）');
      return Calibrate.correctDaily(merged, S.precipFactor);
    }
    var d0 = await fetchYearCached(lat, lon, y, onSrc);
    return Calibrate.correctDaily(Calibrate.normDaily(d0), S.precipFactor);
  }

  /* ---------- 回测主流程 ---------- */
  async function runBacktest() {
    var S = readScheme();
    if (isNaN(S.lat) || isNaN(S.lon)) {
      var prog0 = document.getElementById('rt-prog');
      if (prog0) { prog0.style.display = 'block'; prog0.innerHTML = '<div class="prog-err">经纬度无效，请先在「县区/市」下拉或地图选县填入坐标，再运行回测。</div>'; }
      return;
    }
    var out = document.getElementById('rate-out');
    var prog = document.getElementById('rt-prog');
    var y0 = 2026 - S.years, y1 = 2025;
    out.style.display = 'none';
    prog.style.display = 'block';
    prog.innerHTML = '<div class="prog-t">正在拉取真实历史气象（' + (S.source === 'openmeteo' ? 'Open-Meteo Archive/ERA5' : '气象源') + '，' + S.years + '年）…</div><div class="prog-bar"><i id="rt-bar"></i></div><div class="prog-s" id="rt-prog-s"></div>';
    var barEl = document.getElementById('rt-bar');
    var stEl = document.getElementById('rt-prog-s');

    var R;
    try {
      R = await compute(S, function (done, total, label) {
        stEl.textContent = label || ('回测中… ' + done + ' / ' + total + ' 年');
        barEl.style.width = Math.round(done / total * 100) + '%';
      });
    } catch (e) {
      prog.innerHTML = '<div class="prog-err">气象数据拉取失败：' + e.message + '<br>请确认网络可访问 archive-api.open-meteo.com（需 https 环境）；试点县可优先用本地缓存。可稍后重试。</div>';
      return;
    }
    barEl.style.width = '100%'; stEl.textContent = '回测完成';
    renderResult(R, S);
  }

  /* ---------- 回测计算核心（引擎二 UI 与方案设计器共用） ---------- */
  async function compute(S, onProg) {
    var y0 = 2026 - S.years, y1 = 2025;
    var dailyYears = [], usedSrc = '', annualIndex = [];
    for (var y = y0; y <= y1; y++) {
      var srcLabel = '';
      var daily = await getDaily(S.lat, S.lon, y, S, function (s) { srcLabel = s; });
      dailyYears.push({ y: y, daily: daily });
      if (srcLabel && !usedSrc) usedSrc = srcLabel;
      if (!srcLabel) await sleep(220); // 本地缓存无需限速
      if (onProg) onProg(y - y0 + 1, S.years, srcLabel ? ('本地缓存：' + srcLabel) : ('回测中… ' + (y - y0 + 1) + ' / ' + S.years + ' 年'));
      var W = windowIdx(daily.time, S.m1, S.d1, S.m2, S.d2);
      annualIndex.push(Calibrate.rawIndex(S.peril, daily, W, S.minRun));
    }
    var annual1 = dailyYears.map(function (dy) {
      var W = windowIdx(dy.daily.time, S.m1, S.d1, S.m2, S.d2);
      return triggerRatio(S.peril, dy.daily, W,
        { ratio: S.ratio, minRun: S.minRun, paytype: S.paytype, linA: S.linA, linF: S.linF });
    });
    var opt = { peril2: null, annual2: null, mean2: null };
    if (S.multi && S.peril2) {
      opt.peril2 = S.peril2;
      opt.annual2 = dailyYears.map(function (dy) {
        return triggerRatio(S.peril2, dy.daily, windowIdx(dy.daily.time, S.m1, S.d1, S.m2, S.d2),
          { ratio: S.ratio2, minRun: S.minRun, paytype: S.paytype, linA: S.linA2, linF: S.linF2 });
      });
      opt.mean2 = opt.annual2.reduce(function (a, b) { return a + b; }, 0) / opt.annual2.length;
    }
    var combined = opt.annual2 ? annual1.map(function (a, i) { return Math.min(1, a + opt.annual2[i]); }) : annual1;
    var mean1 = annual1.reduce(function (a, b) { return a + b; }, 0) / annual1.length;
    S._usedSrc = usedSrc;
    var res = analyze(combined, S, { mean1: mean1, mean2: opt.mean2, multi: !!opt.annual2 });
    res.annual1 = annual1; res.annual2 = opt.annual2; res.combined = combined; res.mean1 = mean1; res.usedSrc = usedSrc;
    // 无站点近似标定：分位阈值 + （若有单产）指数-产量 R² 与最优阈值
    if (annualIndex.length) {
      var sug = Calibrate.suggestStrike(annualIndex, S.dir);
      if (S.yieldArr && S.yieldArr.length >= 3) {
        var fit = Calibrate.fitIndexYield(annualIndex, S.yieldArr);
        var opt2 = Calibrate.optimizeStrike(annualIndex, S.yieldArr, S.dir);
        res.calib = { used: true, fit: fit, opt: opt2, sug: sug };
      } else {
        res.calib = { used: false, fit: null, opt: null, sug: sug };
      }
    }
    return res;
  }

  function analyze(annual, S, extra) {
    var n = annual.length;
    var mean = annual.reduce(function (a, b) { return a + b; }, 0) / n;
    var B = 2000, samples = [];
    for (var b = 0; b < B; b++) {
      var s = 0;
      for (var k = 0; k < n; k++) s += annual[Math.floor(Math.random() * n)];
      samples.push(s / n);
    }
    samples.sort(function (a, c) { return a - c; });
    var lo = samples[Math.floor(B * 0.025)], hi = samples[Math.floor(B * 0.975)];
    var triggerYears = annual.filter(function (x) { return x > 0; }).length;
    var maxR = Math.max.apply(null, annual);
    var load = EXPENSE + RISKLOAD;
    var pureLo = lo, pureHi = hi, pureMean = mean;
    var rateLo = pureLo * (1 + load), rateHi = pureHi * (1 + load), rateMean = pureMean * (1 + load);
    // 定价口径：保险费率(小数) = 纯风险损失率 ÷ 成本比例；ULR = 回测均值 ÷ 定价保险费率
    var prerate = (S.trial > 0 && S.cost > 0) ? S.trial / S.cost : null;
    var ulr = prerate != null ? (pureMean / prerate) : null;
    // 合计 ULR 目标带 70-75%；单责也参考但宽松
    var verdict = ulr == null ? 'na'
      : (ulr >= TARGET_ULR[0] && ulr <= TARGET_ULR[1]) ? 'pass'
        : ulr < TARGET_ULR[0] ? 'rich' : 'refix';
    return {
      n: n, mean: pureMean, lo: pureLo, hi: pureHi,
      rateLo: rateLo, rateHi: rateHi, rateMean: rateMean, load: load,
      triggerYears: triggerYears, maxR: maxR, years: annual,
      ulr: ulr, prerate: prerate, trial: S.trial, cost: S.cost, verdict: verdict, sum: S.sum, extra: extra || {}
    };
  }

  function renderResult(R, S) {
    var out = document.getElementById('rate-out');
    var perilCN = { drought: '干旱', frost: '低温霜冻', heat: '高温热害', rainy: '连阴雨', storm: '暴雨', wind: '大风' };
    var perilCN1 = perilCN[S.peril];
    var multiTag = (R.extra.multi) ? '（多责任合计 · ' + perilCN1 + '+' + perilCN[S.peril2] + '）' : '';
    var verdictMap = {
      pass: ['通过 · 维持', '当前试算费率与阈值基本成立，合计 ULR 落 70%-75% 可持续区间。'],
      rich: ['费率偏高 · 可让利', '合计 ULR 低于 70%，初版费率偏厚，可适度下调或放宽阈值以提升农户获得感。'],
      refix: ['严重偏低 · 须重定价', '合计 ULR 远超 75%，初版费率严重低估真实风险，须收紧阈值+提费率，或改累计赔付结构。'],
      na: ['—', '未填纯风险损失率目标，下方仅给回测费率区间。']
    };
    var v = verdictMap[R.verdict];
    var calibBlock = renderCalib(R, S);

    var payStruct = '<div class="rb-sub">赔付结构：' + (S.paytype === 'linear'
      ? '线性理赔阈值——起赔 ' + S.linA + ' → 全赔 ' + S.linF + ' ' + (LINEAR_UNIT[S.peril] || '') + '，区间内连续线性折算、封顶 100%'
      : '阶梯型理赔阈值——分档查表（' + Object.keys(S.ratio).length + ' 档）') + '</div>';

    var perPeril = R.extra.multi
      ? '<div class="rb-sub">分责期望年赔付率：主害 ' + pct(R.extra.mean1) + ' ｜ 次害 ' + pct(R.extra.mean2) + ' ｜ 合计(封顶100%) ' + pct(R.mean) + '</div>'
      : '';

    var html =
      '<div class="res-head">费率回测结果 · ' + KB.crops[S.crop].name + ' · ' + perilCN1 + multiTag + '</div>' +
      payStruct +
      '<div class="kpi-row">' +
        kpi('期望年赔付率（纯风险损失率）', pct(R.mean), '多年历史均值，占保额比例') +
        kpi('纯费率 Bootstrap 区间', pct(R.lo) + '~' + pct(R.hi), '95% 置信区间（2000 次重抽样）') +
        kpi('建议综合费率', pct(R.rateMean), '含费用率15%+风险附加10%') +
        kpi('建议综合费率区间', pct(R.rateLo) + '~' + pct(R.rateHi), '抗大灾尾部') +
      '</div>' +
      '<div class="kpi-row">' +
        kpi('触发年数 / 总年', R.triggerYears + ' / ' + R.n, '历史期出险频率') +
        kpi('最重赔付年强度', pct(R.maxR), '封顶前最大年赔付率') +
        (R.prerate != null ? kpi('定价保险费率', pct(R.prerate), '纯风险损失率 ' + S.trial + '% ÷ 成本比例 ' + S.cost + '%') : kpi('定价保险费率', '—', '填纯风险损失率后计算')) +
        (R.ulr != null ? kpi('ULR（对定价保险费率）', pct(R.ulr, 0), '合计目标带 ' + pct(TARGET_ULR[0], 0) + '~' + pct(TARGET_ULR[1], 0)) : kpi('ULR', '—', '填纯风险损失率后计算')) +
        kpi('结论', v[0], v[1]) +
      '</div>' +
      perPeril +
      calibBlock +
      '<div class="res-block"><div class="rb-h">逐年赔付率（历史回测，占保额比例）</div>' +
        '<div class="rb-b"><canvas id="rt-chart" width="760" height="240"></canvas>' +
        '<div class="note-sm">横轴为年份（' + (2026 - S.years) + '–2025），纵轴为当年触发赔付率；红色虚线为期望年赔付率。</div></div></div>' +
      '<div class="res-block"><div class="rb-h">校准建议</div><div class="rb-b">' + calibrate(R, S) + '</div></div>' +
      '<div class="note-sm">数据真实可溯源（' + (S._usedSrc || 'Open-Meteo/ERA5 再分析') + '，约25km网格，非模拟）；精算报备须以试点县国家气象站/省气候中心观测标定。最终费率与阈值以试点县历史数据标定、精算报备与监管批复为准。主体区分：阳光财险≠阳光农互。</div>';
    out.innerHTML = html;
    out.style.display = 'block';
    progHide();
    drawChart(R, S);
  }

  function progHide() { var p = document.getElementById('rt-prog'); if (p) p.style.display = 'none'; }

  function kpi(t, v, s) {
    return '<div class="kpi"><div class="kpi-t">' + t + '</div><div class="kpi-v">' + v + '</div><div class="kpi-s">' + s + '</div></div>';
  }

  function renderCalib(R, S) {
    if (!R.calib) return '';
    var c = R.calib, dir = S.dir, unit = (LINEAR_UNIT[S.peril] || '');
    var proxyTxt = S.proxy
      ? '已启用（县域多格点均值 ERA5 5 点 + 降水偏差校正因子 ' + S.precipFactor + '）'
      : '未启用（单点 ERA5 约 25km）';
    var h = '<div class="res-block"><div class="rb-h">无站点近似标定 · 基差风险校验</div><div class="rb-b">';
    h += '<div class="rb-sub">数据近似：' + proxyTxt + '。未接国家气象站（CIMISS）/省气候中心，本结果为<b>近似标定</b>，最终以站点观测 + 降尺度为准。</div>';
    if (c.sug) {
      h += '<div class="rb-sub">分位阈值建议（可复现锚，' + (dir === 'low' ? '越低越赔' : '越高越赔') + '）：'
        + ' P5=' + c.sug.p5.toFixed(1) + unit + ' ｜ P10=' + c.sug.p10.toFixed(1) + unit
        + ' ｜ P25=' + c.sug.p25.toFixed(1) + unit + ' ｜ 中位=' + c.sug.median.toFixed(1) + unit + '</div>';
    }
    if (c.used && c.fit) {
      var r2 = c.fit.r2, ok = r2 >= 0.35;
      h += '<div class="rb-sub">指数-产量相关性：R² = <b>' + r2.toFixed(3) + '</b>（n=' + c.fit.n + '）'
        + (ok ? '，<span style="color:#2e9b8b">≥0.35 商业可接受（Nature 2025 基准）</span>'
              : '，<span style="color:#c0392b">未达 0.35，基差偏大，须站点标定/换指数</span>') + '</div>';
      if (c.opt) h += '<div class="rb-sub">最大 R² 最优阈值（扫描 strike）：<b>' + c.opt.strike.toFixed(1) + unit
        + '</b>（R²=' + c.opt.r2.toFixed(3) + '）。可将该值作触发阈值初值，替代通用默认档。</div>';
    } else {
      h += '<div class="rb-sub">未提供历史单产序列，无法实测指数-产量 R²。填入逐年单产（CSV）即可启用基差校验与最优阈值标定。</div>';
    }
    h += '</div></div>';
    return h;
  }

  function calibrate(R, S) {
    var arr = [];
    if (R.verdict === 'refix') {
      arr.push('① <b>收紧触发阈值</b>：连阴雨起赔 3→5 日、暴雨 50→80mm、低温 -2→-4℃、累计降水档上移，直接压低期望赔付率；');
      arr.push('② <b>优化物候窗口</b>：确认窗口已卡在作物最怕灾时点，剔除边缘低风险时段；');
      arr.push('③ <b>改累计赔付结构</b>：多事故改为"累计封顶"而非简单取大，平滑尾部；');
    } else if (R.verdict === 'rich') {
      arr.push('① <b>费率可适度下调/放宽阈值</b>：合计 ULR<70% 说明初版偏厚，可让利提升农户获得感，或扩展保障责任；');
    } else if (R.verdict === 'pass') {
      arr.push('① 当前阈值与费率基本成立，可进入小步试点；');
    }
    if (R.extra.multi) {
      arr.push('④ <b>多责合计口径</b>：已按"逐年两责叠加封顶 100%"回测，合计 ULR 须落在 <b>70%-75%</b>；若偏离，整体平移阈值/费率，勿对单责机械平分风险；');
    } else {
      arr.push('④ <b>多责合计提醒</b>：若同县同作物多责任同时承保，应在本引擎勾选「多责任合计」逐年叠加(封顶100%)校准，使合计 ULR 落 70%-75%；');
    }
    arr.push('⑤ 费率建议取 Bootstrap 区间上限附近以覆盖大灾尾部；样本量 ' + R.n + ' 年，置信度随年数上升。');
    return arr.join('<br>');
  }

  function drawChart(R, S) {
    var cv = document.getElementById('rt-chart'); if (!cv) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height, padL = 42, padB = 28, padT = 12, padR = 12;
    ctx.clearRect(0, 0, W, H);
    var data = R.years, n = data.length;
    var maxV = Math.max(R.mean, Math.max.apply(null, data), 0.05) * 1.15;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    ctx.strokeStyle = '#cdd6e0'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H - padB); ctx.lineTo(W - padR, H - padB); ctx.stroke();
    ctx.fillStyle = '#5b6b7b'; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
    for (var g = 0; g <= 4; g++) {
      var yy = padT + plotH * g / 4;
      ctx.fillText((maxV * (4 - g) / 4 * 100).toFixed(0) + '%', padL - 6, yy + 4);
      ctx.strokeStyle = '#eef2f7'; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    }
    var bw = plotW / n;
    for (var i = 0; i < n; i++) {
      var v = data[i];
      var bh = v / maxV * plotH;
      var x = padL + i * bw + bw * 0.18, y = H - padB - bh, w = bw * 0.64;
      ctx.fillStyle = v > 0 ? '#e0792e' : '#bcd0c4';
      ctx.fillRect(x, y, w, bh);
    }
    var ey = H - padB - R.mean / maxV * plotH;
    ctx.strokeStyle = '#c0392b'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(padL, ey); ctx.lineTo(W - padR, ey); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#5b6b7b'; ctx.textAlign = 'center';
    var y0 = 2026 - n;
    [0, Math.floor(n / 2), n - 1].forEach(function (i) {
      ctx.fillText((y0 + i), padL + i * bw + bw / 2, H - padB + 16);
    });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function resetForm() {
    document.getElementById('rt-lat').value = '';
    document.getElementById('rt-lon').value = '';
    document.getElementById('rt-trial').value = '';
    document.getElementById('rate-out').style.display = 'none';
    document.getElementById('rt-prog').style.display = 'none';
  }

  function bindPresets() {
    function fill(lat, lon, z, crop, peril, m1, d1, m2, d2, sum, trial, ratioPairs) {
      document.getElementById('rt-city').value = lat + ',' + lon + ',' + z;
      document.getElementById('rt-crop').value = crop;
      document.getElementById('rt-peril').value = peril;
      document.getElementById('rt-m1').value = m1; document.getElementById('rt-d1').value = d1;
      document.getElementById('rt-m2').value = m2; document.getElementById('rt-d2').value = d2;
      document.getElementById('rt-sum').value = sum;
      document.getElementById('rt-trial').value = trial;
      bindPeril(); buildRatioEditor(curRatio, ratioPairs, 'rt-ratio');
      var multi = document.getElementById('rt-multi'); if (multi) { multi.checked = false; toggleMulti(); }
    }
    document.getElementById('preset-jiande').addEventListener('click', function () {
      fill(29.47, 119.28, 'yangtze', 'rice', 'rainy', 9, 21, 11, 15, 400, 5, [['3', 10], ['5', 20], ['7', 30]]); switchTab('rate');
    });
    document.getElementById('preset-gaotang').addEventListener('click', function () {
      fill(36.86, 116.23, 'huanghuai', 'corn', 'heat', 6, 15, 8, 20, 400, 5, [['35', 10], ['37', 20], ['39', 30]]); switchTab('rate');
    });
    document.getElementById('preset-zhoukou').addEventListener('click', function () {
      fill(33.63, 114.65, 'huanghuai', 'wheat', 'frost', 3, 15, 5, 5, 400, 5, [['0', 10], ['-2', 20], ['-4', 30]]); switchTab('rate');
    });
  }

  /* ---------- 阈值灵敏度分析（一次性取数，逐变体重算；对标 ParameterPro trigger validation） ---------- */
  async function sensitivity(S, variants) {
    var y0 = 2026 - S.years, y1 = 2025;
    var dailyYears = [];
    for (var y = y0; y <= y1; y++) dailyYears.push({ y: y, daily: await fetchYearCached(S.lat, S.lon, y) });
    var load = EXPENSE + RISKLOAD;
    return variants.map(function (v) {
      var annual = dailyYears.map(function (dy) {
        return triggerRatio(S.peril, dy.daily, windowIdx(dy.daily.time, S.m1, S.d1, S.m2, S.d2),
          { ratio: v.ratio, minRun: v.minRun,
            paytype: v.linear ? 'linear' : S.paytype,
            linA: v.linear ? v.linear.a : S.linA, linF: v.linear ? v.linear.f : S.linF });
      });
      var n = annual.length;
      var mean = annual.reduce(function (a, b) { return a + b; }, 0) / n;
      var ty = annual.filter(function (x) { return x > 0; }).length;
      var maxR = Math.max.apply(null, annual);
      var rate = mean * (1 + load);
      var cost = S.cost || 75;
      var ulr = (S.trial > 0 && cost > 0) ? mean / (S.trial / cost) : null;
      return { label: v.label, mean: mean, rate: rate, ulr: ulr, triggerYears: ty, n: n, maxR: maxR };
    });
  }

  window.RateEngine = {
    init: initForm, loadFromScheme: loadFromScheme,
    fetchYear: fetchYear, fetchYearCached: fetchYearCached,
    compute: compute, sensitivity: sensitivity,
    windowIdx: windowIdx, triggerRatio: triggerRatio,
    linearPayout: linearPayout, payLookup: payLookup, LINEAR_DEFS: LINEAR_DEFS,
    hasLocal: function (lat, lon) { return nearestCached(lat, lon); },
    EXPENSE: EXPENSE, RISKLOAD: RISKLOAD, TARGET_ULR: TARGET_ULR
  };
})();
