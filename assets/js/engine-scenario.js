/* ============================================================
   需求场景工作台（把工具嵌进阳光财险农险合伙人的真实业务动作）
   ------------------------------------------------------------
   s1 遴选/应标创新点  → 路由引擎一(场景化输出)
   s2 县域特色险种立项  → 路由引擎一(场景化输出)
   s3 财政补贴与农户封顶测算 → 专项计算器
   s4 基差风险评级与治理   → 专项计算器
   s5 区域连片巨灾指数     → 多县真实气象回测聚合
   s6 传统农险 vs 指数保险 决策对照 → 对照表
   ============================================================ */
(function () {
  'use strict';
  var KB = window.AGRI_KB;
  var RE = window.RateEngine;

  /* ---------- 场景卡片 + 路由 ---------- */
  function initCards() {
    var box = document.getElementById('scenario-cards');
    if (!box) return;
    KB.scenarios.forEach(function (s) {
      var card = document.createElement('div');
      card.className = 'scard';
      card.innerHTML = '<div class="sc-name">' + s.name + '</div>' +
        '<div class="sc-scene">' + s.scene + '</div>' +
        '<div class="sc-out">产出：' + s.out + '</div>' +
        '<div class="sc-go">' + (s.route === 'reverse' ? '去反推方案 →' : '打开测算器 →') + '</div>';
      card.addEventListener('click', function () { route(s); });
      box.appendChild(card);
    });
  }

  function route(s) {
    if (s.route === 'reverse') { prefillReverse(s.key); return; }
    // 显示对应测算面板
    document.querySelectorAll('.sc-panel').forEach(function (p) { p.style.display = 'none'; });
    var map = { s3: 'sc-s3', s4: 'sc-s4', s5: 'sc-s5', s6: 'sc-s6' };
    var el = document.getElementById(map[s.key]);
    if (el) el.style.display = 'block';
    window.switchTab('scenario');
  }

  // s1/s2 预填引擎一并发场景化反推
  function prefillReverse(key) {
    var presets = {
      s1: { crop: 'corn', zone: 'northeast', peril: 'frost', peril2: '', sum: 400, paytype: 'step' },
      s2: { crop: 'citrus', zone: 'south', peril: 'frost', peril2: 'storm', sum: 400, paytype: 'step' }
    };
    var p = presets[key];
    document.getElementById('rv-crop').value = p.crop;
    document.getElementById('rv-zone').value = p.zone;
    // 勾选主要灾害（可多选）
    var box = document.getElementById('rv-perils');
    if (box) box.querySelectorAll('input[type="checkbox"]').forEach(function (inp) {
      inp.checked = (inp.value === p.peril) || (p.peril2 && inp.value === p.peril2);
    });
    var pt = document.getElementById('rv-paytype'); if (pt) pt.value = p.paytype || 'step';
    document.getElementById('rv-sum').value = p.sum;
    window.__scn = key;
    window.switchTab('reverse');
    document.getElementById('reverse-empty').style.display = 'none';
    window.ReverseEngine.render(key);
  }

  /* ---------- 面板静态结构 ---------- */
  function buildPanels() {
    var stage = document.getElementById('sc-stage');
    if (!stage) return;
    stage.innerHTML =
      // S3 财政补贴封顶
      '<div class="sc-panel" id="sc-s3"><div class="sc-ph">财政补贴与农户端费率封顶测算</div>' +
      '<div class="sc-sub">给定保额、纯费率、费用率与各级财政补贴比例，倒推综合费率、各级分担与农户自缴，判断是否超封顶。</div>' +
      '<div class="calc-grid">' +
        fld('单位保额（元/亩）', '<input id="s3-sum" type="number" value="400" min="50" step="50">') +
        fld('纯费率（%，待引擎二回测）', '<input id="s3-pure" type="number" value="5" min="0" step="0.5">') +
        fld('费用率（%）', '<input id="s3-exp" type="number" value="15" min="0" step="1">') +
        fld('风险附加（%）', '<input id="s3-risk" type="number" value="10" min="0" step="1">') +
        fld('中央补贴（%保费）', '<input id="s3-c" type="number" value="0" min="0" step="5">') +
        fld('省级补贴（%保费）', '<input id="s3-p" type="number" value="30" min="0" step="5">') +
        fld('市/县补贴（%保费）', '<input id="s3-l" type="number" value="20" min="0" step="5">') +
        fld('农户端封顶（%保费）', '<input id="s3-cap" type="number" value="2" min="0" step="0.5">') +
      '</div>' +
      '<div class="btn-row"><button class="btn primary" id="s3-run">测算</button></div>' +
      '<div id="s3-out"></div></div>' +
      // S4 基差风险评级
      '<div class="sc-panel" id="sc-s4"><div class="sc-ph">基差风险评级与治理</div>' +
      '<div class="sc-sub">"指数触发但农户没受灾"是指数保险最大 objections；立项/应标前自评基差等级与治理手段。</div>' +
      '<div class="calc-grid">' +
        fld('作物', '<select id="s4-crop"></select>') +
        fld('指数/灾害', '<select id="s4-peril"></select>') +
        fld('县域数据可得性', '<select id="s4-data"><option value="0">好（多站+卫星网格）</option><option value="0.5" selected>中（单站）</option><option value="1">差（缺站）</option></select>') +
        fld('遥感校验校准', '<select id="s4-rs"><option value="0" selected>已做</option><option value="1.5">未做</option></select>') +
        fld('农时物候卡准', '<select id="s4-pheno"><option value="0" selected>已卡准</option><option value="1.5">未卡准</option></select>') +
      '</div>' +
      '<div class="btn-row"><button class="btn primary" id="s4-run">评级</button></div>' +
      '<div id="s4-out"></div></div>' +
      // S5 区域连片巨灾
      '<div class="sc-panel" id="sc-s5"><div class="sc-ph">区域连片巨灾指数（多县真实气象回测聚合）</div>' +
      '<div class="sc-sub">用于巨灾债券或中农再对接：选≤4个县，回测"≥K县同一年触发"的巨灾频率与 ULR。限时 10 年 × ≤4 县。</div>' +
      '<div class="calc-grid">' +
        '<div class="fld" style="grid-column:1/3"><label>选择县区（勾选≤4个）</label><div id="s5-counties" class="county-chk"></div></div>' +
        fld('保险责任', '<select id="s5-peril"></select>') +
        fld('≥K 县同触发', '<select id="s5-k"><option value="2">≥2 县</option><option value="3">≥3 县</option></select>') +
        fld('起止（月/日）', '<div class="row4"><input id="s5-m1" type="number" value="5" min="1" max="12"><input id="s5-d1" type="number" value="20" min="1" max="31"><input id="s5-m2" type="number" value="6" min="1" max="12"><input id="s5-d2" type="number" value="20" min="1" max="31"></div>') +
        fld('试算费率（%保费）', '<input id="s5-trial" type="number" value="5" min="0" step="0.5">') +
        fld('历史年数', '<select id="s5-years"><option value="10" selected>10 年</option></select>') +
      '</div>' +
      '<div id="s5-ratio"></div>' +
      '<div class="btn-row"><button class="btn primary" id="s5-run">运行区域回测</button></div>' +
      '<div id="s5-prog" style="display:none"></div><div id="s5-out"></div></div>' +
      // S6 决策对照
      '<div class="sc-panel" id="sc-s6"><div class="sc-ph">传统农险 vs 天气指数保险 · 决策对照</div>' +
      '<div class="sc-sub">向领导汇报"该不该做指数化"的六维依据与判定规则。</div>' +
      '<div id="s6-out"></div></div>';

    // 填充 S4/S5 下拉
    fillSelect('s4-crop', KB.crops, function (k, v) { return v.name + '（' + v.cat + '）'; });
    fillSelect('s4-peril', { drought: '干旱/降水亏缺', frost: '低温霜冻', heat: '高温热害', rainy: '连阴雨渍涝', storm: '暴雨洪涝', wind: '大风倒伏' });
    fillSelect('s5-peril', { drought: '干旱/降水亏缺', frost: '低温霜冻', heat: '高温热害', rainy: '连阴雨渍涝', storm: '暴雨洪涝', wind: '大风倒伏' });
    buildCountyChecks();
    bindCalc();
    renderDecision();
  }

  function fld(label, html) { return '<div class="fld"><label>' + label + '</label>' + html + '</div>'; }
  function fillSelect(id, obj, fmt) {
    var s = document.getElementById(id); if (!s) return;
    Object.keys(obj).forEach(function (k) {
      var o = document.createElement('option'); o.value = k;
      o.textContent = fmt ? fmt(k, obj[k]) : obj[k]; s.appendChild(o);
    });
  }
  function buildCountyChecks() {
    var box = document.getElementById('s5-counties'); if (!box) return;
    var byProv = {};
    KB.cities.forEach(function (c) { (byProv[c.p] = byProv[c.p] || []).push(c); });
    Object.keys(byProv).forEach(function (p) {
      var g = document.createElement('div'); g.className = 'cc-group';
      g.innerHTML = '<div class="cc-prov">' + p + '</div>';
      byProv[p].forEach(function (c) {
        var id = 's5c_' + c.lat + '_' + c.lon;
        g.innerHTML += '<label class="cc-i"><input type="checkbox" class="s5c" data-lat="' + c.lat + '" data-lon="' + c.lon + '" data-n="' + c.n + '"> ' + c.n + '</label>';
      });
      box.appendChild(g);
    });
    box.querySelectorAll('.s5c').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var sel = box.querySelectorAll('.s5c:checked');
        if (sel.length > 4) { cb.checked = false; alert('最多勾选 4 个县'); }
      });
    });
  }

  /* ---------- 绑定计算按钮 ---------- */
  function bindCalc() {
    document.getElementById('s3-run').addEventListener('click', calcSubsidy);
    document.getElementById('s4-run').addEventListener('click', calcBasis);
    document.getElementById('s5-run').addEventListener('click', calcCatastrophe);
  }

  /* ===== S3 财政补贴封顶测算 ===== */
  function calcSubsidy() {
    var sum = +document.getElementById('s3-sum').value || 400;
    var pure = (+document.getElementById('s3-pure').value || 0) / 100;
    var exp = (+document.getElementById('s3-exp').value || 0) / 100;
    var risk = (+document.getElementById('s3-risk').value || 0) / 100;
    var c = +document.getElementById('s3-c').value || 0;
    var p = +document.getElementById('s3-p').value || 0;
    var l = +document.getElementById('s3-l').value || 0;
    var cap = (+document.getElementById('s3-cap').value || 0) / 100;
    var out = document.getElementById('s3-out');
    var subFrac = (c + p + l) / 100;
    if (subFrac > 1) { out.innerHTML = '<div class="prog-err">各级补贴合计超过 100%，请检查补贴比例。</div>'; out.style.display = 'block'; return; }
    var compFrac = pure * (1 + exp + risk);
    var farmerFrac = compFrac * (1 - subFrac);
    var over = farmerFrac > cap;
    var effFarmer = over ? cap : farmerFrac;
    var gap = over ? (farmerFrac - cap) : 0;
    var totalSub = subFrac + gap; // 含封顶缺口补足
    var pct = function (x) { return (x * 100).toFixed(2) + '%'; };
    var html =
      '<div class="kpi-row">' +
        kpi('综合费率', pct(compFrac), '纯费率×(1+费用率+风险附加)') +
        kpi('农户自缴（实际封顶内）', pct(effFarmer), over ? '已封顶，超出部分转财政' : '未超封顶') +
        kpi('农户自缴金额', (sum * effFarmer).toFixed(1) + ' 元/亩', '保额 × 农户自缴比例') +
        kpi('财政总负担', pct(totalSub), '各级补贴 + 封顶缺口补足') +
      '</div>' +
      '<div class="kpi-row" style="margin-top:10px">' +
        kpi('中央补贴', pct(compFrac * c / 100), c + '% × 综合费率') +
        kpi('省级补贴', pct(compFrac * p / 100), p + '% × 综合费率') +
        kpi('市/县补贴', pct(compFrac * l / 100), l + '% × 综合费率') +
        kpi('是否超农户封顶', over ? '超 · 已补足' : '未超', over ? '缺口 ' + pct(gap) + ' 由财政承担' : '农户端可控') +
      '</div>' +
      '<div class="note-sm">注：补贴比例按"占保费比例"口径；农户端封顶常见 1.5%-2%（政策性）。纯费率须由引擎二以试点县真实气象回测得到，此处为占位输入。最终以财政承受能力与监管批复为准。</div>';
    out.innerHTML = html; out.style.display = 'block';
  }

  /* ===== S4 基差风险评级 ===== */
  function calcBasis() {
    var peril = document.getElementById('s4-peril').value;
    var base = { low: 1, mid: 2, high: 3 }[KB.basisBase[peril]] || 2;
    var data = +document.getElementById('s4-data').value;
    var rs = +document.getElementById('s4-rs').value;
    var pheno = +document.getElementById('s4-pheno').value;
    // 数据/遥感/农时按"基线0、缺失才加罚"计分，避免常规操作把中基差误判为低
    var score = base + data + rs + pheno;
    score = Math.max(1, Math.min(5, score));
    var level = score <= 1 ? '低' : score <= 3 ? '中' : '高';
    var cls = level === '低' ? 'lv-low' : level === '中' ? 'lv-mid' : 'lv-high';
    var gov = [];
    if (level === '高') {
      gov.push('强烈建议先以"指数+产量双触发"过渡（突破纯指数边界须监管同意，标注于报备材料）；');
      gov.push('引入遥感校验赔付：以 NDVI/降水反演校验指数是否对应实际受灾，抑制"该赔未赔"；');
      gov.push('组建共保体/引入再保分散系统性基差；提高起赔线、收窄边缘赔付段；');
    } else if (level === '中') {
      gov.push('网格化 + 卫星遥感校准：县域用多站/ERA5 网格(25km)插值，并以县站观测标定；');
      gov.push('卡准农时物候 + 分段赔付设起赔与封顶；灾年附遥感佐证降低争议；');
    } else {
      gov.push('基差基本可控：维持农时物候精准匹配 + 地面站校验；');
      gov.push('可作为优先指数化推广品类，理赔争议低、农户获得感强。');
    }
    if (rs === 1) gov.push('当前未做遥感校验——基差显著偏高，务必补上（纯指数边界下遥感仅作校验/校准）。');
    if (pheno === 1) gov.push('当前未卡准农时物候——这是基差最大来源，必须重做物候窗口匹配。');
    var html =
      '<div class="basis-box"><div class="basis-lv ' + cls + '">基差风险等级：' + level + '</div>' +
      '<div class="basis-score">评分 ' + score + '/5（固有 ' + base + ' + 数据 ' + data + ' + 遥感 ' + rs + ' + 农时 ' + pheno + '）</div>' +
      '<div class="basis-gov"><b>治理手段清单</b><br>' + gov.map(function (g) { return '· ' + g; }).join('<br>') + '</div>' +
      '<div class="note-sm">基差治理主轴是农时物候精准匹配；纯天气指数触发，遥感仅作设计期校验/校准与对农户、监管的直观佐证。</div></div>';
    document.getElementById('s4-out').innerHTML = html;
  }

  /* ===== S5 区域连片巨灾 ===== */
  var SDEFS = {
    rainy: [['3', 10], ['5', 20], ['7', 30]], storm: [['50', 10], ['100', 20]],
    frost: [['-1', 10], ['-3', 20], ['-5', 30]], heat: [['35', 10], ['37', 20], ['39', 30]],
    drought: [['40', 10], ['20', 20], ['5', 30]], wind: [['13.8', 10], ['17', 20], ['20.8', 30]]
  };
  function calcCatastrophe() {
    var checked = Array.prototype.slice.call(document.querySelectorAll('.s5c:checked'));
    if (checked.length < 2) { document.getElementById('s5-out').innerHTML = '<div class="prog-err">请至少勾选 2 个县。</div>'; return; }
    var peril = document.getElementById('s5-peril').value;
    var K = +document.getElementById('s5-k').value;
    var m1 = +document.getElementById('s5-m1').value, d1 = +document.getElementById('s5-d1').value;
    var m2 = +document.getElementById('s5-m2').value, d2 = +document.getElementById('s5-d2').value;
    var trial = (+document.getElementById('s5-trial').value) || 0;
    var years = +document.getElementById('s5-years').value;
    var ratio = {}; SDEFS[peril].forEach(function (p) { ratio[p[0]] = (+p[1]) / 100; });
    var dir = (peril === 'frost' || peril === 'drought') ? 'low' : 'high';
    var counties = checked.map(function (c) { return { n: c.dataset.n, lat: +c.dataset.lat, lon: +c.dataset.lon }; });
    var prog = document.getElementById('s5-prog');
    prog.style.display = 'block';
    prog.innerHTML = '<div class="prog-t">区域回测中（' + counties.length + '县 × ' + years + '年 真实气象）…</div><div class="prog-bar"><i id="s5-bar"></i></div><div class="prog-s" id="s5-ps"></div>';
    var bar = document.getElementById('s5-bar'), ps = document.getElementById('s5-ps');
    (async function () {
      var annualByCounty = [];
      var total = counties.length * years, done = 0;
      for (var ci = 0; ci < counties.length; ci++) {
        var arr = [];
        for (var y = 2026 - years; y <= 2025; y++) {
          try {
            var daily = await RE.fetchYear(counties[ci].lat, counties[ci].lon, y);
            var idx = RE.windowIdx(daily.time, m1, d1, m2, d2);
            arr.push(RE.triggerRatio(peril, daily, idx, { ratio: ratio, minRun: 3 }));
          } catch (e) { arr.push(0); }
          done++; bar.style.width = Math.round(done / total * 100) + '%';
          if (ps) ps.textContent = counties[ci].n + ' ' + y;
          await sleep(200);
        }
        annualByCounty.push(arr);
      }
      // 区域巨灾年：≥K 县同年触发(>0)
      var region = [];
      for (var y2 = 0; y2 < years; y2++) {
        var trig = annualByCounty.filter(function (a) { return a[y2] > 0; }).length;
        region.push(trig >= K ? 1 : 0);
      }
      var mean = region.reduce(function (a, b) { return a + b; }, 0) / region.length;
      var catYears = region.filter(function (x) { return x > 0; }).length;
      var ulr = trial > 0 ? (mean / (trial / 100)) : null;
      var verdict = ulr == null ? '' : (ulr >= 0.70 && ulr <= 0.75) ? '<span class="lv-low">ULR 落 70-75% 可持续带</span>' :
        ulr < 0.70 ? '<span class="lv-mid">ULR<70%，区域触发偏稀，可放宽/提质</span>' : '<span class="lv-high">ULR>75%，触发过频，须收紧阈值</span>';
      var pct = function (x) { return (x * 100).toFixed(1) + '%'; };
      var html =
        '<div class="kpi-row">' +
          kpi('区域巨灾触发频率', pct(mean), '≥' + K + '县同年触发 占比') +
          kpi('巨灾年数 / 总年', catYears + ' / ' + years, '历史期区域连片灾频率') +
          kpi('ULR（对试算保费）', ulr != null ? (ulr * 100).toFixed(0) + '%' : '—', '目标带 70-75%') +
          kpi('适用建议', K + '县连片', '适合巨灾债券/中农再对接') +
        '</div>' +
        '<div class="basis-gov">' + verdict + '<br>区域指数以"连片触发"平滑单县基差；阈值建议取单县 DEFS 略收紧，确保区域触发与真实连片灾一致。</div>' +
        '<div class="note-sm">数据真实可溯源（Open-Meteo/ERA5 约25km网格）；精算报备须以省气候中心/县站观测标定。最终以监管批复为准。</div>';
      document.getElementById('s5-out').innerHTML = html;
      prog.style.display = 'none';
    })();
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ===== S6 决策对照 ===== */
  function renderDecision() {
    var box = document.getElementById('s6-out'); if (!box) return;
    var rows = KB.decisionCompare.map(function (d) {
      return '<tr><td>' + d.dim + '</td><td>' + d.trad + '</td><td class="' + (d.wiiWin ? 'win' : 'lose') + '">' + d.wii + '</td></tr>';
    }).join('');
    box.innerHTML =
      '<table class="decision"><tr><th>维度</th><th>传统农险</th><th>天气指数保险</th></tr>' + rows + '</table>' +
      '<div class="basis-gov"><b>判定规则（建议做指数化）：</b><br>' +
      '· 基差可控（低温/高温/连阴雨/暴雨等指数与产量相关性高、空间异质小）+ 定损成本高/理赔时效要求高 → 优先指数化；<br>' +
      '· 大风/冰雹等站点难测、空间异质大 → 基差高，先做"指数+产量双触发"过渡或暂缓；<br>' +
      '· 财政杠杆诉求强（低定损成本撬动更高保障）→ 指数化更优。</div>';
  }

  function kpi(t, v, s) {
    return '<div class="kpi"><div class="kpi-t">' + t + '</div><div class="kpi-v">' + v + '</div><div class="kpi-s">' + s + '</div></div>';
  }

  window.Scenarios = {
    init: function () { initCards(); buildPanels(); }
  };
})();
