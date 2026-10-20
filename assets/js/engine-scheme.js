/* ============================================================
   方案设计器（聚合"反推" + "费率校准" → 一份可交付的天气指数保险方案）
   ------------------------------------------------------------
   输入：县(优先本地缓存) / 作物 / 主害 / 次害(可选) / 物候窗口 / 保额 / 承保面积 / 试算费率 / 场景
   流程：ReverseEngine.propose 反推方案 → RateEngine.compute 真实气象回测校准 → 组装完整方案
   输出：结构化天气指数保险方案(可导出JSON / 打印)；含指数设计、费率、基差治理、合规锚定。
   ============================================================ */
(function () {
  'use strict';
  var KB = window.AGRI_KB;
  var PERIL_CN = { drought: '干旱/降水亏缺', frost: '低温霜冻', heat: '高温热害', rainy: '连阴雨渍涝', storm: '暴雨洪涝', wind: '大风倒伏' };
  var PERILS = [['drought', '干旱/降水亏缺'], ['frost', '低温霜冻'], ['heat', '高温热害'], ['rainy', '连阴雨渍涝'], ['storm', '暴雨洪涝'], ['wind', '大风倒伏']];
  var COMPLIANCE = [
    '金发〔2024〕35号《关于加快农业保险高质量发展的指导意见》（"双精准"：精准投保理赔）',
    '银保监规〔2023〕4号《农业保险精算规定（试行）》（费率测算与费用率上限）',
    '银保监规〔2022〕4号《农业保险承保理赔管理办法》（定损理赔时效）'
  ];
  var SRC_NOTE = 'Open-Meteo/ERA5 再分析（约25km网格，免费可溯源）作初算；精算报备须以试点县国家气象站/省气候中心观测标定。';

  function pct(x, d) { return (x * 100).toFixed(d === undefined ? 2 : d) + '%'; }
  function fmtMD(m, d) { return m + '月' + d + '日'; }

  // 由县经纬度反推气候带（与 KB.zones 键对齐；作物.zone 是描述性串不能直接当键）
  // 六带：south 华南 / yangtze 长江中下游 / huanghuai 黄淮海 / southwest 西南 / northwest 西北 / northeast 东北
  function zoneFromCoord(lat, lon) {
    if (lat < 26 && lon > 100) return 'south';                 // 粤桂闽琼
    if (lon < 108) return lat >= 32 ? 'northwest' : 'southwest'; // 甘宁新 vs 川渝云贵
    if (lat >= 40 && lon >= 118) return 'northeast';           // 黑吉辽蒙东
    if (lat >= 33 && lon >= 108) return 'huanghuai';           // 鲁豫冀皖苏北
    return 'yangtze';                                          // 长江中下游
  }

  function fmtNum(x) { return (Math.round(x * 100) / 100).toString(); }

  // 方案类型中文名（阶梯型理赔阈值 / 线性理赔阈值）——原调用处未定义会 ReferenceError，补上
  function payTypeName(t) { return t === 'linear' ? '线性理赔阈值' : '阶梯型理赔阈值'; }

  // 赔付函数「设计依据与校准口径」注（放在分段/线性赔付函数表正下方，逐条呼应三点硬要求）：
  // ①按方案类型专属设计 ②严格用目标县前 N 年逐日历史气象建模 ③回测纯风险损失率对齐预计目标
  function designBasisNote(f, calib, R) {
    var y0 = 2026 - R.n;
    var devNow = Math.abs(R.mean - calib.target) / calib.target;
    var ok = devNow <= 0.05;
    return '<div class="note-sm"><b>设计依据与校准口径（三项硬要求逐条对应）</b><br>' +
      '① <b>方案类型专属</b>：按「' + payTypeName(f.payType) + '」生成赔付函数' +
      (f.payType === 'linear' ? '——触发→封顶区间内连续线性折算，无档位跳变；' : '——落入档位按固定比例一次性赔付，不叠加；') + '<br>' +
      '② <b>历史建模口径</b>：触发/封顶阈值严格按 ' + f.countyName + ' 前 ' + R.n + ' 年（' + y0 + '–2025）逐日历史气象建模回测' +
      '（⭐试点县用本地站点缓存，其余县域 ERA5 再分析网格），逐年赔付率均值即回测纯风险损失率；<br>' +
      '③ <b>纯风险损失率对齐</b>：回测 <b>' + pct(R.mean) + '</b>，与预计纯风险损失率 ' + f.ulr + '% 偏差 ' + pct(devNow, 1) +
      (ok ? '，≤5% 达标——本表阈值与定价可直接采用。' : '，已达可行域内最贴近值——可调整物候窗口或切换方案类型后重新设计。') +
      ' 逐年赔付明细见「三、费率回测」。</div>';
  }

  // 由基准 ratio 映射生成"起赔阈值"变体（保持分段赔付档位与步长，仅平移起赔线）
  // high 方向：阈值越大越难触发；low 方向：阈值越小(越负)越难触发
  function variantRatios(base, t0list, dir, unit) {
    var keys = Object.keys(base).map(Number).sort(function (a, b) { return a - b; });
    var pay = keys.map(function (k) { return base[k]; }); // 升序键对应赔付档
    var n = keys.length, step = keys[1] - keys[0];
    return t0list.map(function (t0) {
      var r = {};
      for (var i = 0; i < n; i++) {
        var k = dir === 'high' ? t0 + step * i : t0 - step * i;
        r[k] = dir === 'high' ? pay[i] : pay[n - 1 - i];
      }
      return { ratio: r, label: (dir === 'high' ? '≥' : '≤') + fmtNum(t0) + unit };
    });
  }

  // 构造 per-peril 阈值扫描变体（对标 ParameterPro 的 trigger definition & validation）
  function buildSweep(f, scheme) {
    var dir = scheme.primary.indexDir, unit = scheme.primary.indexUnit, base = scheme.primary.ratio;
    if (f.peril === 'rainy') {
      return [3, 4, 5, 7].map(function (d) {
        return { label: '起赔 ' + d + ' 日', ratio: base, minRun: d, unit: '连续降水日数' };
      });
    }
    var t0map = {
      heat: [33, 35, 37], frost: [-3, -1], storm: [30, 50, 70],
      wind: [11, 13.8, 17], drought: [20, 40]
    };
    var t0list = t0map[f.peril] || [Object.keys(base).map(Number).sort(function (a, b) { return a - b; })[0]];
    return variantRatios(base, t0list, dir, unit).map(function (v) {
      return { label: v.label, ratio: v.ratio, minRun: undefined, unit: unit };
    });
  }

  function init() {
    var cs = document.getElementById('sd-crop');
    if (!cs) return;
    Object.keys(KB.crops).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = KB.crops[k].name; cs.appendChild(o); });
    var pl = document.getElementById('sd-peril');
    PERILS.forEach(function (p) { var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; pl.appendChild(o); });
    var pl2 = document.getElementById('sd-peril2');
    pl2.innerHTML = '<option value="">— 不添加次害 —</option>';
    PERILS.forEach(function (p) { var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; pl2.appendChild(o); });

    // 缓存县下拉
    fetch('assets/data/counties.json').then(function (r) { return r.json(); }).then(function (j) {
      var sel = document.getElementById('sd-county');
      if (!sel) return;
      (j.counties || []).forEach(function (c) {
        var o = document.createElement('option');
        o.value = c.lat + ',' + c.lon + ',' + c.name;
        o.textContent = c.name + '（' + c.prov + '·' + c.city + '）';
        sel.appendChild(o);
      });
    }).catch(function () { });

    document.getElementById('sd-go').addEventListener('click', run);
    document.getElementById('sd-reset').addEventListener('click', function () {
      document.getElementById('scheme-out').style.display = 'none';
      document.getElementById('scheme-out').innerHTML = '';
    });
  }

  function readForm() {
    var cv = (document.getElementById('sd-county').value || '').split(',');
    var lat = parseFloat(document.getElementById('sd-lat').value) || +cv[0];
    var lon = parseFloat(document.getElementById('sd-lon').value) || +cv[1];
    var countyName = (document.getElementById('sd-county').value || '').split(',')[2] || (lat ? (lat.toFixed(2) + ',' + lon.toFixed(2)) : '—');
    var crop = document.getElementById('sd-crop').value;
    var peril = document.getElementById('sd-peril').value;
    var peril2 = document.getElementById('sd-peril2').value || '';
    var sum = parseFloat(document.getElementById('sd-sum').value) || 400;
    var area = parseFloat(document.getElementById('sd-area').value) || 0; // 万亩
    var trial = parseFloat(document.getElementById('sd-trial').value) || 0;
    var scenario = document.getElementById('sd-scenario').value || '';
    var m1 = +document.getElementById('sd-m1').value, d1 = +document.getElementById('sd-d1').value;
    var m2 = +document.getElementById('sd-m2').value, d2 = +document.getElementById('sd-d2').value;
    return { lat: lat, lon: lon, countyName: countyName, crop: crop, peril: peril, peril2: peril2,
      sum: sum, area: area, trial: trial, scenario: scenario, m1: m1, d1: d1, m2: m2, d2: d2 };
  }

  function showErr(msg) {
    var out = document.getElementById('scheme-out');
    if (out) { out.style.display = 'block'; out.innerHTML = '<div class="warn" style="margin:0">' + msg + '</div>'; }
  }
  async function run() {
    var f = readForm();
    if (!f.crop) { showErr('请选择作物'); return; }
    if (!f.peril) { showErr('请选择主害风险'); return; }
    if (!(f.lat && f.lon)) { showErr('请选择或手动输入目标县的经纬度（可在地图上选县，或用面板顶部下拉选县）。'); return; }
    if (!(f.m1 >= 1 && f.m1 <= 12 && f.d1 >= 1 && f.d1 <= 31 && f.m2 >= 1 && f.m2 <= 12 && f.d2 >= 1 && f.d2 <= 31)) {
      showErr('保险期间月/日填写不合法：月份 1–12，日期 1–31。'); return;
    }
    var out = document.getElementById('scheme-out');
    out.style.display = 'block';
    out.innerHTML = '<div class="prog-t">正在设计完整方案（反推 + 真实气象回测校准）…<div class="prog-bar"><i class="spin"></i></div></div>';

    // 1) 反推方案（zoneKey 由县经纬度反推，作物.zone 是描述性串不可直接当键）
    var zoneKey = zoneFromCoord(f.lat, f.lon) || 'yangtze';
    var scheme = window.ReverseEngine.propose({
      cropKey: f.crop, zoneKey: zoneKey, peril: f.peril, peril2: f.peril2, sum: f.sum
    });
    // 覆盖物候窗口为用户设定
    scheme.primary.window = [f.m1, f.d1, f.m2, f.d2];
    if (scheme.combo) scheme.combo.secondary.window = [f.m1, f.d1, f.m2, f.d2];

    // 2) 真实气象回测校准
    var S = {
      lat: f.lat, lon: f.lon, crop: f.crop, peril: f.peril,
      peril2: f.peril2, multi: !!f.peril2,
      m1: f.m1, d1: f.d1, m2: f.m2, d2: f.d2,
      sum: f.sum, trial: f.trial, years: 20, minRun: 3,
      ratio: scheme.primary.ratio,
      ratio2: scheme.combo ? scheme.combo.secondary.ratio : {},
      dir: (f.peril === 'frost' || f.peril === 'drought') ? 'low' : 'high',
      dir2: (f.peril2 === 'frost' || f.peril2 === 'drought') ? 'low' : 'high',
      source: 'openmeteo'
    };
    var R;
    try { R = await window.RateEngine.compute(S); }
    catch (e) { out.innerHTML = '<div class="prog-err">气象回测失败：' + e.message + '</div>'; return; }

    // 2.5) 阈值灵敏度分析（一次性取数、逐变体重算，对标 ParameterPro trigger validation）
    var sweep = buildSweep(f, scheme);
    var sens;
    try { sens = await window.RateEngine.sensitivity(S, sweep); }
    catch (e) { sens = null; }

    // 3) 组装完整方案
    renderScheme(f, scheme, R, sens, out);
  }

  function renderScheme(f, scheme, R, sens, out) {
    var perilCN1 = PERIL_CN[f.peril];
    var perilCN2 = f.peril2 ? PERIL_CN[f.peril2] : '';
    var idx = scheme.primary.indexName;
    var verdictMap = {
      pass: ['通过 · 维持', '当前试算费率与阈值基本成立，合计 ULR 落 70%-75% 可持续区间。'],
      rich: ['费率偏高 · 可让利', '合计 ULR 低于 70%，初版费率偏厚，可适度下调或放宽阈值提升农户获得感。'],
      refix: ['严重偏低 · 须重定价', '合计 ULR 远超 75%，初版费率严重低估真实风险，须收紧阈值+提费率后再报备。'],
      na: ['—', '未填试算费率，下方仅给纯费率区间。']
    };
    var v = verdictMap[R.verdict];
    var zoneName = KB.crops[f.crop].zone || '—';

    // 市场同类产品锚点（取经所得，仅作参照非我司定值）
    var mref = (KB.marketRefs || []).filter(function (r) { return r.peril === f.peril; });
    var mrefHtml = mref.length ? mref.map(function (r) {
      var rows = [
        ['产品/机构', '<b>' + r.name + '</b> · ' + r.org + ' · ' + r.region + '（' + r.year + '）'],
        ['保险责任', r.liability || '—'],
        ['指数', r.index],
        ['触发/理赔阈值', r.triggerParam]
      ];
      return '<div class="refrow"><table class="reftb">' +
        rows.map(function (row) {
          return '<tr><th>' + row[0] + '</th><td>' + row[1] + '</td></tr>';
        }).join('') +
        '</table><span class="note-sm">' + r.note + ' 来源：' + r.src + '</span></div>';
    }).join('') : '';

    // 再保与风险分散 / 灾前风险减量
    var reinsHtml = [
      '① <b>系统性巨灾用再保分散</b>：县域连片巨灾（如整片黄淮海烂场雨）同频赔付，须通过中国农业再保险共同体(中农再)或国际再保(Swiss Re/Munich Re)转嫁尾部风险；',
      '② <b>ULR 是再保定价锚</b>：本方案合计 ULR ' + (R.ulr != null ? pct(R.ulr, 0) : '—') + '，超 75% 须先收紧阈值+提费率，否则再保成本陡增；',
      '③ <b>多责任/多县区组合对冲</b>：选空间相关性低的县区与灾因组合，平滑组合波动，降低再保资本占用；',
      '④ <b>衍生品/ILS 可选</b>：价格+气象复合型风险（如松江"水稻高温指数保险+衍生品"）可叠加天气衍生品或巨灾债券转移容量。'
    ].join('<br>');
    var riskWarn = (f.peril === 'rainy') ? '起赔日数-1' : '阈值约90%';
    var tech = KB.agriTech ? KB.agriTech[f.peril] : null;
    var techActs = tech ? tech.acts : [];
    var riskHtml = [
      '① <b>灾前预警阈值</b>：' + (tech ? tech.warn : '将触发线前移至"临近触发"预警') + '，提前向农户推送防范；',
      '② <b>减损农技（灾前）</b>：' + (techActs.length ? techActs.join('；') + '。' : (scheme.primary.phenoNote || '')) + ' 把"事后赔付"变为"灾前少损"；',
      '③ <b>自动理赔闭环</b>：触发即赔、免现场定损（对标辛集梨"理赔触发告知书一键生成"），理赔时效缩至 T+0~T+3；',
      '④ <b>遥感协同佐证</b>：NDVI/降水反演作灾前监测与灾后果园/地块级佐证，降基差争议。'
    ].join('<br>');

    // 农业知识卡：品种关键气象指标 + 主害敏感生育期 + 本区气候基准（固化知识，直接呈现）
    var clim = KB.cropClim ? KB.cropClim[f.crop] : null;
    var pheno = (KB.crops[f.crop].phenology || []).filter(function (p) { return (p.vul || []).indexOf(f.peril) >= 0; });
    var agroHtml = '<div class="rb-sub">农业知识卡 · 品种生长期与灾害特点（农艺参考值 · 非我司定值）</div>';
    if (clim) {
      agroHtml += '<table class="mini"><tr><th>关键气象指标</th><th>参考值</th></tr>'
        + '<tr><td>≥10℃活动积温</td><td>' + clim.gdd + ' ℃·d</td></tr>'
        + '<tr><td>全生育期</td><td>' + clim.days + ' 天</td></tr>'
        + '<tr><td>适宜温度</td><td>' + clim.temp + ' ℃</td></tr>'
        + '<tr><td>关键期需水</td><td>' + clim.water + ' mm</td></tr>'
        + '<tr><td>播期 / 收期</td><td>' + clim.sow + ' / ' + clim.harvest + '</td></tr>'
        + (clim.note ? '<tr><td>备注</td><td>' + clim.note + '</td></tr>' : '')
        + '</table>';
    }
    if (pheno.length) {
      agroHtml += '<div class="rb-sub">主害「' + perilCN1 + '」敏感生育期</div><table class="mini"><tr><th>生育阶段</th><th>月份</th><th>灾害机理</th></tr>'
        + pheno.map(function (p) { return '<tr><td>' + p.name + '</td><td>' + p.m[0] + '–' + p.m[1] + '月</td><td>' + (p.note || '—') + '</td></tr>'; }).join('')
        + '</table>';
    }
    var band = KB.climBands ? KB.climBands[zoneFromCoord(f.lat, f.lon)] : null;
    if (band) {
      agroHtml += '<div class="note-sm">本区常年气候基准（背景参照）：年均温 ' + band.tat + '℃｜年降水 ' + band.rain + 'mm｜≥10℃积温 ' + band.gdd + '℃·d｜无霜期 ' + band.frostfree + '天</div>';
    }

    var sensRows = sens ? sens.map(function (row) {
      return '<tr><td>' + row.label + '</td><td>' + pct(row.mean) + '</td><td>' + pct(row.rate) + '</td><td>' + (row.ulr != null ? pct(row.ulr, 0) : '—') + '</td><td>' + row.triggerYears + '/' + row.n + '</td></tr>';
    }).join('') : '';

    var ratioRows = function (ratio, dir, unit) {
      var op = dir === 'low' ? '≤' : '≥';
      return Object.keys(ratio).map(Number).sort(function (a, b) { return dir === 'low' ? b - a : a - b; })
        .map(function (k) { return '<tr><td>' + unit + ' ' + op + ' ' + k + '</td><td>赔付 ' + pct(ratio[k]) + '</td></tr>'; }).join('');
    };
    var primaryRatio = ratioRows(scheme.primary.ratio, scheme.primary.indexDir, scheme.primary.indexUnit);
    var secRatio = scheme.combo ? ratioRows(scheme.combo.secondary.ratio, scheme.combo.secondary.indexDir, scheme.combo.secondary.indexUnit) : '';

    var basis = [
      '① <b>农时物候精准匹配</b>：指数卡在' + scheme.primary.windowLabel + '（' + scheme.primary.phenoNote + '），从源头降基差；',
      '② <b>网格化 + 地面观测</b>：县域用多站/卫星网格化，以' + f.countyName + '县气象站/省气候中心观测标定；',
      '③ <b>遥感校验校准</b>：NDVI/降水反演作设计期校验与对农户、监管佐证（纯指数不叠加产量触发）；',
      '④ <b>机器学习量化基差</b>：建模"气象指数→实际损失"偏差分布，定位高基差区域；',
      '⑤ <b>再保/区域分散</b>：系统性基差用再保与多县区组合分散；多责任合计时合计 ULR 须落 70%-75%，勿机械平分。'
    ].join('<br>');

    var scenarioTag = f.scenario ? ('<div class="warn">已绑定场景：' + ({ s1: '遴选/应标创新点', s2: '县域特色险种立项', s3: '财政补贴与农户封顶', s4: '基差风险评级治理', s5: '区域连片巨灾', s6: '传统 vs 指数决策' }[f.scenario]) + '（相关要点见"需求场景"工作台）</div>') : '';

    var exportObj = {
      生成时间: new Date().toISOString().slice(0, 10),
      区域: { 县: f.countyName, 经纬度: [f.lat, f.lon], 农业区: zoneName },
      作物: { 代码: f.crop, 名称: scheme.cropName, 保额: f.sum, 承保面积_万亩: f.area || null },
      主害责任: {
        灾害: perilCN1, 指数: idx, 触发依据: scheme.primary.indexBase,
        物候窗口: scheme.primary.windowLabel + '（' + fmtMD(f.m1, f.d1) + '—' + fmtMD(f.m2, f.d2) + '）',
        分段赔付比例表: scheme.primary.ratio
      },
      次害责任: scheme.combo ? { 灾害: perilCN2, 指数: scheme.combo.secondary.indexName, 分段赔付比例表: scheme.combo.secondary.ratio } : null,
      费率回测: {
        数据来源: R.usedSrc || 'Open-Meteo/ERA5', 样本年数: R.n,
        期望年赔付率_纯: pct(R.mean), 纯费率区间: pct(R.lo) + '~' + pct(R.hi),
        建议综合费率: pct(R.rateMean), 综合费率区间: pct(R.rateLo) + '~' + pct(R.rateHi),
        触发年数: R.triggerYears + '/' + R.n, ULR: R.ulr != null ? pct(R.ulr, 0) : null,
        校准结论: v[0] + '：' + v[1], 逐年赔付率: R.combined.map(function (x, i) { return { 年: 2026 - R.n + i, 赔付率: +(x * 100).toFixed(2) }; })
      },
      基差治理: basis, 再保安排: reinsHtml, 风险减量: riskHtml,
      阈值灵敏度: sens ? sens : '取数失败', 合规锚定: COMPLIANCE, 免责: SRC_NOTE + ' 主体区分：阳光财险≠阳光农互。'
    };
    window.__lastScheme = exportObj;

    var html =
      '<div class="res-head">天气指数保险方案 · ' + scheme.cropName + ' · ' + f.countyName + ' · ' + perilCN1 + (perilCN2 ? '+' + perilCN2 : '') + '</div>' +
      scenarioTag +
      '<div class="kpi-row">' +
        kpi('作物 / 区域', scheme.cropName + '<br>' + zoneName, '保额 ' + f.sum + ' 元/亩' + (f.area ? ' · 承保 ' + f.area + ' 万亩' : '')) +
        kpi('建议综合费率', pct(R.rateMean), '含费用15%+风险附加10%') +
        kpi('纯费率 Bootstrap 区间', pct(R.lo) + '~' + pct(R.hi), R.n + '年历史 95%置信') +
        kpi('合计 ULR / 结论', (R.ulr != null ? pct(R.ulr, 0) : '—'), v[0]) +
      '</div>' +
      '<div class="res-block"><div class="rb-h">一、指数与触发设计（主害 ' + perilCN1 + '）</div><div class="rb-b">' +
        card('气象指数', idx, scheme.primary.indexBase) +
        card('关键物候窗口', scheme.primary.windowLabel, scheme.primary.phenoNote) +
        card('建议保险期间', fmtMD(f.m1, f.d1) + ' — ' + fmtMD(f.m2, f.d2), '每年同窗') +
        card('数据来源', R.usedSrc || 'Open-Meteo/ERA5', SRC_NOTE + '（分辨率约25km格点；县域尺度平滑降基差）') +
        '<div class="rb-sub">分段赔付函数（保额 ' + f.sum + ' 元/亩）</div>' +
        '<table class="mini"><tr><th>触发条件</th><th>赔付强度</th></tr>' + primaryRatio + '</table>' +
        (mrefHtml ? '<div class="rb-sub">市场同类产品怎么设（取经锚点 · 参考非定值）</div>' + mrefHtml : '') +
        agroHtml +
      '</div></div>' +
      (scheme.combo ? '<div class="res-block"><div class="rb-h">二、次害责任（' + perilCN2 + '）</div><div class="rb-b">' +
        card('气象指数', scheme.combo.secondary.indexName, scheme.combo.secondary.indexBase) +
        '<table class="mini"><tr><th>触发条件</th><th>赔付强度</th></tr>' + secRatio + '</table>' +
        '<div class="note-sm">多责任合计：逐年两责赔付叠加封顶 100%，合计 ULR 须落 70%-75%。</div>' +
      '</div></div>' : '') +
      '<div class="res-block"><div class="rb-h">三、费率回测（真实气象验证）</div><div class="rb-b">' +
        card('期望年赔付率（纯风险损失率）', pct(R.mean), '多年历史均值') +
        card('触发年数', R.triggerYears + ' / ' + R.n, '历史出险频率') +
        card('最重赔付年', pct(R.maxR), '封顶前最大年赔付率') +
        card('校准结论', v[0], v[1]) +
        '<div class="rb-sub">逐年赔付率（' + (2026 - R.n) + '–2025，占保额比例）</div>' +
        '<canvas id="sd-chart" width="760" height="220"></canvas>' +
      '</div></div>' +
      '<div class="res-block"><div class="rb-h">四、阈值灵敏度分析（平移起赔线看费率 · 对标 ParameterPro）</div><div class="rb-b">' +
        '<div class="note-sm">同一县域/作物，仅平移"起赔阈值"对期望赔付率与合计 ULR 的影响（ULR 目标带 70%-75%）。据此在"农户获得感"与"费率可持续"间取平衡。</div>' +
        (sens ? '<table class="mini"><tr><th>起赔阈值(变体)</th><th>期望年赔付率</th><th>建议综合费率</th><th>合计 ULR</th><th>触发年</th></tr>' + sensRows + '</table><canvas id="sd-sens-chart" width="760" height="170"></canvas>'
              : '<div class="note-sm">灵敏度分析取数失败，可重试。</div>') +
      '</div></div>' +
      '<div class="res-block"><div class="rb-h">五、基差风险治理（核心敌人）</div><div class="rb-b">' + basis + '</div></div>' +
      '<div class="res-block"><div class="rb-h">六、再保与风险分散（对接中农再/国际再保/ILS）</div><div class="rb-b">' + reinsHtml + '</div></div>' +
      '<div class="res-block"><div class="rb-h">七、灾前预警与风险减量（保防减救赔全流程）</div><div class="rb-b">' + riskHtml + '</div></div>' +
      '<div class="res-block"><div class="rb-h">八、政策合规锚定</div><div class="rb-b">' + COMPLIANCE.map(function (c) { return '· ' + c; }).join('<br>') + '</div></div>' +
      '<div class="res-actions"><button class="primary" id="sd-export">导出方案(JSON)</button><button class="ghost" id="sd-print">打印 / 存为PDF</button></div>' +
      '<div class="note-sm">说明：本方案由平台自动反推 + 真实气象回测生成；阈值/费率以【】占位，最终以试点县历史气象数据标定、精算报备与监管批复为准。主体区分：阳光财险≠阳光农互。</div>';

    out.innerHTML = html;
    document.getElementById('sd-export').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(window.__lastScheme, null, 2)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = '天气指数保险方案_' + scheme.cropName + '_' + f.countyName + '.json'; a.click();
    });
    document.getElementById('sd-print').addEventListener('click', function () { window.print(); });
    drawChart(R, 'sd-chart');
    if (sens) drawSens(sens, 'sd-sens-chart');
  }

  function drawSens(sens, id) {
    var cv = document.getElementById(id); if (!cv) return;
    var ctx = cv.getContext('2d'); var W = cv.width, H = cv.height, padL = 46, padB = 26, padT = 12, padR = 12;
    ctx.clearRect(0, 0, W, H);
    var data = sens.map(function (s) { return s.ulr != null ? s.ulr : s.mean; }); // 无试算费率时用纯赔付率
    var n = data.length;
    var maxV = Math.max.apply(null, data) * 1.15 || 0.05;
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
      var bh = data[i] / maxV * plotH;
      ctx.fillStyle = (sens[i].ulr != null && sens[i].ulr > 0.75) ? '#c0392b' : (sens[i].ulr != null && sens[i].ulr < 0.70 ? '#e0a32e' : '#3b9b6b');
      ctx.fillRect(padL + i * bw + bw * 0.2, H - padB - bh, bw * 0.6, bh);
      ctx.fillStyle = '#5b6b7b'; ctx.textAlign = 'center'; ctx.font = '10px sans-serif';
      ctx.fillText(sens[i].label.replace(/[≥≤]/, ''), padL + i * bw + bw / 2, H - padB + 15);
    }
  }

  function kpi(t, v, s) { return '<div class="kpi"><div class="kpi-t">' + t + '</div><div class="kpi-v">' + v + '</div><div class="kpi-s">' + s + '</div></div>'; }
  function card(t, v, s) { return '<div class="rc"><div class="rc-t">' + t + '</div><div class="rc-v">' + v + '</div><div class="rc-s">' + s + '</div></div>'; }

  function drawChart(R, id) {
    var cv = document.getElementById(id); if (!cv) return;
    var ctx = cv.getContext('2d'); var W = cv.width, H = cv.height, padL = 42, padB = 28, padT = 12, padR = 12;
    ctx.clearRect(0, 0, W, H);
    var data = R.combined, n = data.length;
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
      var bh = data[i] / maxV * plotH;
      ctx.fillStyle = data[i] > 0 ? '#e0792e' : '#bcd0c4';
      ctx.fillRect(padL + i * bw + bw * 0.18, H - padB - bh, bw * 0.64, bh);
    }
    var ey = H - padB - R.mean / maxV * plotH;
    ctx.strokeStyle = '#c0392b'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(padL, ey); ctx.lineTo(W - padR, ey); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#5b6b7b'; ctx.textAlign = 'center';
    var y0 = 2026 - n;
    [0, Math.floor(n / 2), n - 1].forEach(function (i) { ctx.fillText((y0 + i), padL + i * bw + bw / 2, H - padB + 16); });
  }

  window.SchemeDesigner = { init: init };
})();
