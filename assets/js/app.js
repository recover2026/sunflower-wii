/* ============================================================
   向阳社 · 天气指数保险设计平台 · 主控
   ============================================================ */
(function () {
  'use strict';
  var KB = window.AGRI_KB;

  /* ---------- Tab 切换 ---------- */
  window.switchTab = function (name) {
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('on', t.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('on', v.id === 'v-' + name);
    });
    // 切换后重排地图（隐藏 tab 内 canvas 宽度为 0 时不渲染，切到该视图需重绘）
    if (window.mapHome) window.mapHome.relayout();
    if (window.mapPicker) window.mapPicker.relayout();
    if (window.mapScheme) window.mapScheme.relayout();
    if (window.mapRate) window.mapRate.relayout();
  };
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); });
  });

  /* ---------- 退出登录：清门禁会话并回到密码页 ---------- */
  (function bindExit() {
    var btn = document.getElementById('btn-exit');
    if (!btn) return;
    btn.addEventListener('click', function () {
      try { sessionStorage.removeItem('sunflower_wii_gate_v1'); } catch (e) { }
      location.reload();
    });
  })();

  /* ---------- 时钟 ---------- */
  function tick() {
    var d = new Date();
    var wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    document.getElementById('clock-date').textContent =
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' 周' + wd;
    document.getElementById('clock-time').textContent =
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  tick(); setInterval(tick, 1000);

  /* ---------- 反推表单：填充作物/区域 ---------- */
  (function fillReverse() {
    var cs = document.getElementById('rv-crop');
    Object.keys(KB.crops).forEach(function (k) {
      var o = document.createElement('option'); o.value = k; o.textContent = KB.crops[k].name + '（' + KB.crops[k].cat + '）'; cs.appendChild(o);
    });
    var zs = document.getElementById('rv-zone');
    Object.keys(KB.zones).forEach(function (k) {
      var o = document.createElement('option'); o.value = k; o.textContent = KB.zones[k].name; zs.appendChild(o);
    });
    document.getElementById('rv-go').addEventListener('click', function () {
      document.getElementById('reverse-empty').style.display = 'none';
      window.ReverseEngine.render(window.__scn);
    });
  })();

  /* ---------- 行业方案库卡片（带筛选） ---------- */
  (function fillMarket() {
    var grid = document.getElementById('market-grid');
    var tagCls = { '国内': 'dom', '国际': 'intl', '方法论': 'met' };
    function cardHTML(m) {
      var k = m.tag.split('·')[0];
      var cls = tagCls[k] || 'met';
      var card = document.createElement('div');
      card.className = 'mcard';
      var detail = '';
      if (m.liability || m.claimTable || m.claim) {
        var claimHTML = '';
        if (m.claimTable) {
          claimHTML = '<div class="md-row"><b>理赔阈值（表格化）</b>' +
            '<table class="claimtb"><thead><tr><th>灾害/指数</th><th>触发条件</th><th>赔付标准</th></tr></thead><tbody>' +
            m.claimTable.map(function (r) {
              return '<tr><td>' + r.d + '</td><td>' + r.t + '</td><td>' + r.p + '</td></tr>';
            }).join('') +
            '</tbody></table>' +
            (m.claimNote ? '<div class="claim-note">注：' + m.claimNote + '</div>' : '') +
            '</div>';
        } else if (m.claim) {
          claimHTML = '<div class="md-row"><b>理赔阈值</b>' + m.claim + '</div>';
        }
        detail =
          '<button class="mdtoggle" type="button">▾ 细则：保险责任 · 理赔阈值</button>' +
          '<div class="mdetail" style="display:none">' +
          (m.liability ? '<div class="md-row"><b>保险责任</b>' + m.liability + '</div>' : '') +
          claimHTML +
          '</div>';
      }
      var ptag = m.payType ? '<span class="ptag ' + m.payType + '">' + (m.payType === 'linear' ? '线性' : '阶梯') + '</span>' : '';
      card.innerHTML =
        '<div class="mt"><span class="mtag ' + cls + '">' + m.tag + '</span>' + ptag + '<h4>' + m.name + '</h4></div>' +
        '<div class="mo">' + m.org + ' · ' + m.region + ' · ' + m.year + '</div>' +
        '<div class="mk"><b>作物/灾害：</b>' + m.crop + ' / ' + m.peril + '<br>' +
        '<b>指数：</b>' + m.index + '<br>' +
        '<b>触发：</b>' + m.trigger + '<br>' +
        '<b>赔付：</b>' + m.payout + '<br>' +
        '<b>赔付结构：</b>' + (m.payType === 'linear' ? '线性理赔阈值' : '阶梯型理赔阈值') + '</div>' +
        detail +
        '<div class="mn">' + m.note + '</div>';
      var tg = card.querySelector('.mdtoggle'), dt = card.querySelector('.mdetail');
      if (tg && dt) {
        tg.addEventListener('click', function () {
          var open = dt.style.display !== 'none';
          dt.style.display = open ? 'none' : 'block';
          tg.textContent = open ? '▾ 细则：保险责任 · 理赔阈值' : '▴ 收起细则';
        });
      }
      return card;
    }
    function render() {
      var scope = (document.getElementById('mf-scope') || {}).value || '';
      var kw = ((document.getElementById('mf-kw') || {}).value || '').trim().toLowerCase();
      grid.innerHTML = '';
      var list = KB.marketDesigns.filter(function (m) {
        var scopeOk = !scope || m.tag.indexOf(scope) === 0 || (scope === '国内' && m.tag.indexOf('国内') === 0);
        var ctTxt = (m.claimTable || []).map(function (r) { return r.d + r.t + r.p; }).join('');
        var kwOk = !kw || (m.crop + m.peril + m.name + m.index + (m.liability || '') + ctTxt + (m.claim || '')).toLowerCase().indexOf(kw) >= 0;
        return scopeOk && kwOk;
      });
      list.forEach(function (m) { grid.appendChild(cardHTML(m)); });
      var c = document.getElementById('mf-count'); if (c) c.textContent = '共 ' + list.length + ' 条';
    }
    render();
    var sf = document.getElementById('mf-scope'), kwf = document.getElementById('mf-kw');
    if (sf) sf.addEventListener('change', render);
    if (kwf) kwf.addEventListener('input', render);
  })();

  /* ---------- 方法论步骤 + 速查表 ---------- */
  (function fillMethod() {
    var box = document.getElementById('method-steps');
    KB.pipeline.forEach(function (s, i) {
      var div = document.createElement('div');
      div.className = 'step';
      div.innerHTML = '<div class="sn">' + (i + 1) + '</div><div class="st">' + s.replace(/^Step\d+\s*/, '') + '</div>';
      box.appendChild(div);
    });
    var qt = document.getElementById('method-quick');
    if (qt) {
      KB.designQuick.forEach(function (d) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + d.peril + '</td><td>' + d.index + '</td><td>' + d.base + '</td><td>' + d.dir + '</td><td>' + d.win + '</td>';
        qt.appendChild(tr);
      });
    }
  })();

  /* ---------- 初始化费率引擎 + 地图选点（首页 + 选点页两份） + 需求场景工作台 ---------- */
  window.RateEngine.init();
  if (window.MapPicker) { MapPicker.initHome(); MapPicker.initPicker(); MapPicker.initSchemeMap(); MapPicker.initRateMap(); }
  if (window.SchemeDesigner) SchemeDesigner.init();
  if (window.Scenarios) window.Scenarios.init();
})();
