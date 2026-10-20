/* ============================================================
   无站点近似标定引擎（Station-free Proxy Calibration）
   ------------------------------------------------------------
   在"不接国家气象站（CIMISS）/省气候中心"的前提下，仅用
   Open-Meteo/ERA5 公开再分析，使方案尽量贴近"站点标定"结果。
   三条近似手段（均来自公开文献，可溯源、可调）：
     ① 县域多格点均值：centroid + 4 个 ±0.25° 偏移格点逐日均值，
        模拟"县域多站平均"，降低单点采样误差（近似站点网均值）。
     ② 降水偏差校正：ERA5 日降水 RB 高估 +13.54%、微量<1mm 显著高估
        （长三角 185 站实证，MDPI 2026）→ 剔除 trace(<1mm)日 + 区域系数。
     ③ 指数-产量 R² 最优阈值：若用户提供历史单产，做指数→减产率回归，
        扫描候选 strike 取 R² 最大者（对应沁县谷子"最大 R² 最优匹配"法）。
   所有输出均标注"未接国家站·近似标定"，最终以站点观测为准。
   ============================================================ */
(function () {
  'use strict';

  // ① 县域多格点均值：把多格点逐日序列取均值（模拟多站网均值）
  function countyMean(arrays) {
    if (!arrays.length) return null;
    var base = arrays[0];
    var n = arrays.length;
    var out = { time: base.time.slice(), tmax: [], tmin: [], prcp: [], wind: [] };
    for (var i = 0; i < base.time.length; i++) {
      var sT = 0, sTmin = 0, sP = 0, sW = 0, c = 0;
      for (var k = 0; k < n; k++) {
        var a = arrays[k];
        if (i >= a.time.length) continue;
        if (a.tmax[i] != null) { sT += a.tmax[i]; sTmin += a.tmin[i]; sP += a.prcp[i]; sW += a.wind[i]; c++; }
      }
      if (!c) { out.tmax.push(null); out.tmin.push(null); out.prcp.push(null); out.wind.push(null); continue; }
      out.tmax.push(sT / c); out.tmin.push(sTmin / c); out.prcp.push(sP / c); out.wind.push(sW / c);
    }
    return out;
  }

  // ② 降水偏差校正：剔除 trace(<1mm) 日（ERA5 显著高估微量），
  //    再乘区域修正系数（默认 1.0；长三角文献 RB+13.54% → 可填 0.88 校正）。
  function biasCorrectPrecip(prcpDaily, factor) {
    var f = (factor && factor > 0) ? factor : 1.0;
    return prcpDaily.map(function (v) {
      var x = (v == null ? 0 : v);
      return x < 1 ? 0 : x * f;
    });
  }

  // 把 Open-Meteo daily 对象规整为本引擎内部字段
  function normDaily(d) {
    return {
      time: d.time || [],
      tmax: d.temperature_2m_max || [],
      tmin: d.temperature_2m_min || [],
      prcp: d.precipitation_sum || [],
      wind: d.wind_speed_10m_max || []
    };
  }

  // 对规整后 daily 应用降水偏差校正
  function correctDaily(d, precipFactor) {
    if (!d) return d;
    d.prcp = biasCorrectPrecip(d.prcp, precipFactor);
    return d;
  }

  // 原始指数值（用于回归 / 分位阈值），与 engine-rate.triggerRatio 同口径
  function rawIndex(peril, d, idx, minRun) {
    if (!idx || !idx.length) return 0;
    if (peril === 'rainy') {
      var p = idx.map(function (i) { return d.prcp[i] == null ? 0 : d.prcp[i]; });
      var run = 0, best = 0;
      for (var i = 0; i <= p.length; i++) {
        if (i < p.length && p[i] >= 1) { run++; }
        else { if (run >= (minRun || 3)) best = Math.max(best, run); run = 0; }
      }
      return best;
    }
    if (peril === 'storm') return Math.max.apply(null, idx.map(function (i) { return d.prcp[i] == null ? 0 : d.prcp[i]; }));
    if (peril === 'frost') { var t = idx.map(function (i) { return d.tmin[i]; }).filter(function (v) { return v != null; }); return t.length ? Math.min.apply(null, t) : 0; }
    if (peril === 'heat') { var h = idx.map(function (i) { return d.tmax[i]; }).filter(function (v) { return v != null; }); return h.length ? Math.max.apply(null, h) : 0; }
    if (peril === 'drought') return idx.reduce(function (a, i) { return a + (d.prcp[i] == null ? 0 : d.prcp[i]); }, 0);
    if (peril === 'wind') return Math.max.apply(null, idx.map(function (i) { return (d.wind[i] == null ? 0 : d.wind[i]) / 3.6; }));
    return 0;
  }

  // ③ 指数→产量 线性回归 + R²
  function fitIndexYield(indexArr, yieldArr) {
    var ix = [], yy = [];
    for (var i = 0; i < Math.min(indexArr.length, yieldArr.length); i++) {
      if (!isNaN(indexArr[i]) && yieldArr[i] != null && !isNaN(yieldArr[i])) { ix.push(indexArr[i]); yy.push(yieldArr[i]); }
    }
    var m = ix.length; if (m < 3) return null;
    var sx = 0, sy = 0; for (var j = 0; j < m; j++) { sx += ix[j]; sy += yy[j]; }
    var mx = sx / m, my = sy / m, sxx = 0, sxy = 0, syy = 0;
    for (var j = 0; j < m; j++) { var dx = ix[j] - mx, dy = yy[j] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    var slope = sxx === 0 ? 0 : sxy / sxx;
    var r2 = (sxx === 0 || syy === 0) ? 0 : (sxy * sxy) / (sxx * syy);
    return { slope: slope, intercept: my - slope * mx, r2: r2, n: m, meanY: my };
  }

  // 最大 R² 阈值优化：扫描候选 strike，以"线性赔付"对减产率回归，取 R² 最大者
  function optimizeStrike(indexArr, yieldArr, dir) {
    var fit0 = fitIndexYield(indexArr, yieldArr);
    if (!fit0) return null;
    var meanY = fit0.meanY;
    var loss = yieldArr.map(function (y) { return (meanY - y) / meanY; }); // 减产率（正=受损）
    var vals = indexArr.filter(function (v) { return !isNaN(v); }).slice().sort(function (a, b) { return a - b; });
    if (vals.length < 3) return null;
    var lo = vals[0], hi = vals[vals.length - 1];
    if (hi === lo) return null;
    var best = null, steps = 40;
    for (var s = 0; s <= steps; s++) {
      var strike = lo + (hi - lo) * s / steps;
      var denom = hi - strike; if (denom <= 0) continue;
      var pay = indexArr.map(function (v) {
        var t = dir === 'low' ? (strike - v) / denom : (v - strike) / denom;
        return Math.max(0, Math.min(1, isNaN(t) ? 0 : t));
      });
      var f = fitIndexYield(pay, loss);
      if (f && (!best || f.r2 > best.r2)) best = { strike: strike, r2: f.r2, n: f.n };
    }
    return best;
  }

  // 分位阈值建议（可复现锚）：返回 p5/p10/p25/中位
  function suggestStrike(indexArr, dir) {
    var vals = indexArr.filter(function (v) { return !isNaN(v); }).slice().sort(function (a, b) { return a - b; });
    if (!vals.length) return null;
    function pct(p) { return vals[Math.min(vals.length - 1, Math.floor(vals.length * p))]; }
    return { p5: pct(.05), p10: pct(.10), p25: pct(.25), median: pct(.5), lo: vals[0], hi: vals[vals.length - 1] };
  }

  window.Calibrate = {
    countyMean: countyMean, biasCorrectPrecip: biasCorrectPrecip,
    normDaily: normDaily, correctDaily: correctDaily, rawIndex: rawIndex,
    fitIndexYield: fitIndexYield, optimizeStrike: optimizeStrike, suggestStrike: suggestStrike
  };
})();
