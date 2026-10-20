/* ============================================================
   县级选点地图（全国 · 合规边界）
   ------------------------------------------------------------
   渲染方式：行政区划 GeoJSON + 原生 Canvas 本地渲染。边界数据本地打包优先
   （assets/geo/：全国省界+各省市级+试点市县级，共 37 个文件 4.6MB），
   本地缺失的层级自动回退 DataV.GeoAtlas 远程拉取 —— 离线/file:// 均可秒开。
   边界数据基于国家基础地理信息标准，符合地图合规要求（无错绘国界/省界）。
   省 → 市 → 县 三级下钻，点击县多边形取质心(GCJ-02) → 写入 window.__mpCoord → 引擎二。
   首页(homemap)与选点页(pickmap)共用同一 CountyMap 类与边界缓存。
   ============================================================ */
(function () {
  'use strict';
  var BASE = 'https://geo.datav.aliyun.com/areas_v3/bound/';
  var LOCAL = 'assets/geo/'; // 本地打包边界（全国+省级+试点市），离线/file:///预览沙箱均可用
  var _cache = new Map(); // 全局缓存，首页与选点页共享，避免重复拉取

  function fetchJSON(adcode) {
    if (_cache.has(adcode)) return Promise.resolve(_cache.get(adcode));
    // 本地优先（秒开、离线可用）；本地没有该层级（如大部分县级）再走 DataV 远程兜底
    return fetch(LOCAL + adcode + '_full.json')
      .then(function (r) { if (!r.ok) throw new Error('no-local'); return r.json(); })
      .catch(function () {
        return fetch(BASE + adcode + '_full.json')
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
      })
      .then(function (j) { _cache.set(adcode, j); return j; });
  }

  function eachRing(geom, cb) {
    if (!geom) return;
    if (geom.type === 'Polygon') geom.coordinates.forEach(cb);
    else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(function (poly) { poly.forEach(cb); });
  }
  function eachCoord(geom, cb) {
    eachRing(geom, function (ring) { ring.forEach(function (c) { cb(c[0], c[1]); }); });
  }

  function CountyMap(opts) {
    this.provSel = document.getElementById(opts.provSel);
    this.citySel = document.getElementById(opts.citySel);
    this.countySel = document.getElementById(opts.countySel);
    this.canvas = document.getElementById(opts.canvas);
    this.statusEl = opts.status ? document.getElementById(opts.status) : null;
    this.backBtn = opts.back ? document.getElementById(opts.back) : null;
    this.onSelect = opts.onSelect || function () {};
    this.ctx = this.canvas.getContext('2d');
    this.features = []; this._paths = []; this.level = 'province';
    this.curProv = null; this.curCity = null; this.selName = null; // selName=当前选中县（金色高亮）
    this.dpr = window.devicePixelRatio || 1;
    this.W = 600; this.H = 430;
    this._bind();
    this.load('100000'); // 全国省界
  }

  CountyMap.prototype._setStatus = function (t) { if (this.statusEl) this.statusEl.textContent = t || ''; };

  CountyMap.prototype._bind = function () {
    var self = this;
    this.provSel.addEventListener('change', function () { self._drillProv(self.provSel.value); });
    this.citySel.addEventListener('change', function () { self._drillCity(self.citySel.value); });
    this.countySel.addEventListener('change', function () { self._onCountyChange(); });
    this.canvas.addEventListener('click', function (e) { self._onClick(e); });
    if (this.backBtn) this.backBtn.addEventListener('click', function () { self.back(); });
  };

  CountyMap.prototype.load = function (adcode) {
    var self = this;
    this._setStatus('边界数据加载中…');
    return fetchJSON(adcode).then(function (j) {
      self.features = j.features || [];
      self.level = self.features.length ? (self.features[0].properties.level || 'city') : 'province';
      self._populate(self.features);
      self.relayout();
      self._setStatus('');
      return j;
    }).catch(function (err) {
      self._setStatus('边界数据加载失败（本地 assets/geo 与 DataV.GeoAtlas 均不可达）：' + err.message);
    });
  };

  CountyMap.prototype._populate = function (features) {
    var lv = this.level;
    if (lv === 'province') this._fill(this.provSel, features, '省');
    else if (lv === 'city') { this._fill(this.citySel, features, '市'); this._fill(this.countySel, [], '—'); }
    else { this._fill(this.countySel, features, '县/区'); }
  };

  CountyMap.prototype._fill = function (sel, features, ph) {
    if (!sel) return;
    sel.innerHTML = '';
    var def = document.createElement('option'); def.value = ''; def.textContent = ph; sel.appendChild(def);
    features.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.properties.adcode; o.textContent = f.properties.name;
      var c = f.properties.centroid || f.properties.center;
      if (c) { o.dataset.lat = c[1]; o.dataset.lon = c[0]; o.dataset.name = f.properties.name; }
      sel.appendChild(o);
    });
  };

  CountyMap.prototype._drillProv = function (adcode) {
    if (!adcode) return;
    this.curProv = adcode; this.curCity = null;
    this.load(adcode);
  };
  CountyMap.prototype._drillCity = function (adcode) {
    if (!adcode) return;
    this.curCity = adcode;
    this.load(adcode);
  };
  CountyMap.prototype._onCountyChange = function () {
    var opt = this.countySel.selectedOptions[0];
    if (!opt || !opt.dataset.lat) return;
    this._selectCounty(opt.dataset.name, { lat: parseFloat(opt.dataset.lat), lon: parseFloat(opt.dataset.lon) }, opt.value);
  };

  CountyMap.prototype._bbox = function (feats, latFloor) {
    feats = feats || this.features;
    var minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
    feats.forEach(function (f) {
      eachCoord(f.geometry, function (lon, lat) {
        if (latFloor != null && lat < latFloor) return; // 南海岛礁不参与大陆定界
        if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      });
    });
    if (minLon > maxLon) { minLon = 73; maxLon = 135; minLat = 18; maxLat = 54; }
    return { minLon: minLon, maxLon: maxLon, minLat: minLat, maxLat: maxLat };
  };

  /* 投影：x = lon×cos(中纬)（修正经纬度实际长度差），y 线性；
     再按包围盒宽高比 contain 缩放并居中 —— 保证形状不失真。
     全国视图 latFloor=17：海南省三沙岛礁(至3.8°N)不拉扁大陆，由南海附图呈现 */
  CountyMap.prototype._computeTransform = function (feats, W, H, pad, latFloor) {
    var b = this._bbox(feats, latFloor);
    var midLat = (b.minLat + b.maxLat) / 2;
    var k = Math.cos(midLat * Math.PI / 180); // 经度修正系数
    var minPX = b.minLon * k, w = (b.maxLon - b.minLon) * k, h = b.maxLat - b.minLat;
    if (w <= 0 || h <= 0) { w = w || 1; h = h || 1; }
    var availW = W * (1 - pad * 2), availH = H * (1 - pad * 2);
    var s = Math.min(availW / w, availH / h);
    this._tf = {
      k: k, s: s,
      ox: W / 2 - ((minPX + w / 2) * s),      // 水平居中
      oyTop: H / 2 - (h / 2) * s,             // 垂直居中
      maxLat: b.maxLat
    };
  };

  CountyMap.prototype._project = function (lon, lat, tf) {
    var t = tf || this._tf;
    return [lon * t.k * t.s + t.ox, (t.maxLat - lat) * t.s + t.oyTop];
  };

  // 容器可见时才渲染（隐藏 tab 内 canvas 宽度为 0，跳过）
  CountyMap.prototype.relayout = function () {
    var rect = this.canvas.getBoundingClientRect();
    var cssW = rect.width || (this.canvas.parentElement ? this.canvas.parentElement.clientWidth : 0) || 600;
    var cssH = rect.height || 430;
    if (cssW < 2) return;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.W = cssW; this.H = cssH;
    try { this._render(); }
    catch (err) {
      // 渲染错误与"边界加载失败(网络)"分开提示，避免误导排查
      this._paths = [];
      this._setStatus('地图渲染异常：' + (err && err.message ? err.message : err));
    }
  };

  CountyMap.prototype._drawFeatures = function (feats, tf, fill, stroke, lw) {
    var ctx = this.ctx, self = this;
    feats.forEach(function (f) {
      var path = new Path2D();
      eachRing(f.geometry, function (ring) {
        ring.forEach(function (c, i) {
          var p = self._project(c[0], c[1], tf);
          if (i === 0) path.moveTo(p[0], p[1]); else path.lineTo(p[0], p[1]);
        });
        path.closePath();
      });
      ctx.fillStyle = fill; ctx.fill(path);
      ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(path);
      self._paths.push({ path: path, feature: f });
    });
  };

  /* 地名居中标注：取每个 feature 质心(GCJ-02) → 投影 → 居中 fillText。
     textAlign/textBaseline 保证"居中"；先白描边光晕再深色填充，保证任何底色上可读。
     仅标注当前层级（this.features 即当前下钻层级），下钻省→市→县自动随 features 变化。 */
  CountyMap.prototype._drawLabels = function (feats, tf) {
    var ctx = this.ctx, self = this;
    var lv = this.level;
    var base = lv === 'district' ? 9 : (lv === 'city' ? 11 : 12); // 县名最密→最小
    var fs = base * this.dpr;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // canvas font 简写中含空格的字体名必须整体加引号，否则整条 font 声明失效
    ctx.font = fs + 'px "PingFang SC","Microsoft YaHei","Hiragino Sans GB","Heiti SC",sans-serif';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, this.dpr * 2.2);
    ctx.strokeStyle = 'rgba(255,255,255,0.88)';     // 白色光晕，压住描边/填充
    ctx.fillStyle = lv === 'district' ? '#5a4a1f' : '#23344f';
    feats.forEach(function (f) {
      var c = f.properties.centroid || f.properties.center;
      if (!c) return;
      var p = self._project(c[0], c[1], tf);
      // 超出画布安全跳过（避免质心异常拉出界）
      if (p[0] < -40 || p[0] > self.canvas.width + 40 || p[1] < -20 || p[1] > self.canvas.height + 20) return;
      ctx.strokeText(f.properties.name, p[0], p[1]);
      ctx.fillText(f.properties.name, p[0], p[1]);
    });
  };

  CountyMap.prototype._render = function () {
    if (!this.features.length) return;
    var ctx = this.ctx, self = this;
    var W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    this._paths = [];

    var fill = this.level === 'district' ? '#fff6dd' : (this.level === 'city' ? '#eef4fb' : '#e7eef7');
    var stroke = this.level === 'district' ? '#C9A24B' : '#3a5f9f';
    var lw = Math.max(0.5, this.dpr * 0.6);

    // 分离"南海诸岛"（全国视图专属）：主图只画大陆，南海按标准画法放右下角附图
    var main = [], southSea = [];
    this.features.forEach(function (f) {
      var n = f.properties.name || '';
      if (n.indexOf('南海诸岛') > -1 || f.properties.adcode === '100000_JD') southSea.push(f);
      else main.push(f);
    });

    // 主图：带纬度修正的等比投影，contain 居中；全国视图排除南海岛礁定界
    var latFloor = this.level === 'province' && southSea.length ? 17 : null;
    this._computeTransform(main.length ? main : this.features, W, H, 0.07, latFloor);
    this._drawFeatures(main, this._tf, fill, stroke, lw);

    // 选中县高亮（淡金填充+金棕描边）：县下拉↔地图双向匹配的可视反馈
    if (this.selName && this.level === 'district') {
      var selFeats = main.filter(function (f) { return f.properties.name === self.selName; });
      if (selFeats.length) this._drawFeatures(selFeats, this._tf, '#ffe9b3', '#C9822A', Math.max(1.2, this.dpr * 1.2));
    }

    // 地名居中标注（省/市/县）：高亮之后绘制，确保选中县名仍清晰
    this._drawLabels(main, this._tf);

    // 南海诸岛附图（右下角，比例尺独立，虚线框 —— 国家地图标准画法）
    if (southSea.length) {
      var iw = W * 0.16, ih = iw * 1.42;               // 南海纵向狭长
      var ix = W - iw - W * 0.03, iy = H - ih - H * 0.03;
      var b = this._bbox(southSea);
      var midK = Math.cos(((b.minLat + b.maxLat) / 2) * Math.PI / 180);
      var mw = (b.maxLon - b.minLon) * midK;
      var mh = b.maxLat - b.minLat;
      var s2 = Math.min(iw * 0.9 / mw, ih * 0.9 / mh);
      // 附图变换：bbox 中心对准附图框中心（x = lon×k×s + ox；y = (maxLat-lat)×s + oyTop）
      var sc = {
        k: midK, s: s2, maxLat: b.maxLat,
        ox: ix + iw / 2 - ((b.minLon + b.maxLon) / 2) * midK * s2,
        oyTop: iy + ih / 2 - (mh / 2) * s2
      };
      ctx.setLineDash([4 * this.dpr, 3 * this.dpr]);
      ctx.strokeStyle = '#8aa4c8'; ctx.lineWidth = Math.max(0.5, this.dpr * 0.5);
      ctx.strokeRect(ix, iy, iw, ih);
      ctx.setLineDash([]);
      ctx.font = Math.max(9, this.dpr * 10) + 'px sans-serif';
      ctx.fillStyle = '#5b7699';
      ctx.fillText('南海诸岛', ix + iw * 0.2, iy - 5 * this.dpr);
      this._drawFeatures(southSea, sc, fill, stroke, Math.max(0.4, this.dpr * 0.45));
    }
  };

  CountyMap.prototype._onClick = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) * this.dpr;
    var y = (e.clientY - rect.top) * this.dpr;
    for (var i = this._paths.length - 1; i >= 0; i--) {
      if (this.ctx.isPointInPath(this._paths[i].path, x, y)) {
        this._pick(this._paths[i].feature); break;
      }
    }
  };

  CountyMap.prototype._pick = function (f) {
    var ad = f.properties.adcode, name = f.properties.name;
    if (this.level === 'province') { this.provSel.value = ad; this._drillProv(ad); }
    else if (this.level === 'city') { this.citySel.value = ad; this._drillCity(ad); }
    else { this._selectCounty(name, this._centroid(f), ad); }
  };

  CountyMap.prototype._centroid = function (f) {
    var c = f.properties.centroid || f.properties.center;
    if (c) return { lat: c[1], lon: c[0] };
    var b = this._bbox(); return { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
  };

  CountyMap.prototype._selectCounty = function (name, c, adcode) {
    window.__mpCoord = { lat: c.lat, lon: c.lon, name: name, adcode: adcode || null };
    this.selName = name; // 记录选中县 → 渲染层金色高亮
    this.onSelect(name, c.lat, c.lon, adcode);
  };

  CountyMap.prototype.back = function () {
    this.curProv = null; this.curCity = null;
    this.load('100000');
  };

  /* ---------- 工厂：首页 + 选点页两个实例 ---------- */
  window.CountyMap = CountyMap;
  window.MapPicker = {
    initHome: function () {
      if (!document.getElementById('homemap')) return;
      window.mapHome = new CountyMap({
        provSel: 'hm-prov', citySel: 'hm-city', countySel: 'hm-county',
        canvas: 'homemap', status: 'home-map-status', back: 'hm-back',
        onSelect: function (name, lat, lon) {
          var s = document.getElementById('hm-sel'); if (s) s.textContent = name;
          var la = document.getElementById('hm-lat'); if (la) la.textContent = lat.toFixed(4);
          var lo = document.getElementById('hm-lon'); if (lo) lo.textContent = lon.toFixed(4);
          var a = document.getElementById('hm-action'); if (a) a.style.display = 'flex';
          var rtla = document.getElementById('rt-lat'); if (rtla) rtla.value = lat.toFixed(4);
          var rtlo = document.getElementById('rt-lon'); if (rtlo) rtlo.value = lon.toFixed(4);
          // 同步引擎二 rt-city 下拉，避免"坐标已填但下拉仍是默认市"的视觉不一致
          var ci = document.getElementById('rt-city');
          if (ci && window.AGRI_KB && window.AGRI_KB.cities && ci.options.length) {
            var best = null, bd = 1e9;
            window.AGRI_KB.cities.forEach(function (c) {
              var d = Math.hypot((c.lat || 0) - lat, (c.lon || 0) - lon);
              if (d < bd) { bd = d; best = c; }
            });
            if (best) ci.value = best.lat + ',' + best.lon + ',' + best.z;
          }
        }
      });
    },
    initPicker: function () {
      if (!document.getElementById('pickmap')) return;
      window.mapPicker = new CountyMap({
        provSel: 'mp-prov', citySel: 'mp-city', countySel: 'mp-county',
        canvas: 'pickmap', status: 'map-status', back: 'mp-back',
        onSelect: function (name, lat, lon) {
          var s = document.getElementById('mp-sel'); if (s) s.textContent = name;
          var la = document.getElementById('mp-lat'); if (la) la.textContent = lat.toFixed(4);
          var lo = document.getElementById('mp-lon'); if (lo) lo.textContent = lon.toFixed(4);
        }
      });
      var apply = document.getElementById('mp-apply');
      if (apply) apply.addEventListener('click', function () {
        var c = window.__mpCoord;
        if (!c) { alert('请先在地图上或下拉中选择县/区'); return; }
        var la = document.getElementById('rt-lat'); if (la) la.value = c.lat.toFixed(4);
        var lo = document.getElementById('rt-lon'); if (lo) lo.value = c.lon.toFixed(4);
        switchTab('rate');
        var el = document.getElementById('rt-lat'); if (el) el.scrollIntoView({ behavior: 'smooth' });
      });
      var reset = document.getElementById('mp-reset');
      if (reset) reset.addEventListener('click', function () {
        var s = document.getElementById('mp-sel'); if (s) s.textContent = '未选择';
        var la = document.getElementById('mp-lat'); if (la) la.textContent = '—';
        var lo = document.getElementById('mp-lon'); if (lo) lo.textContent = '—';
        window.__mpCoord = null;
      });
    },
    /* 方案设计器输入面板内嵌选点地图：选县即回填 sd-lat/sd-lon/sd-county */
    initSchemeMap: function () {
      if (!document.getElementById('sdm-canvas')) return;
      window.mapScheme = new CountyMap({
        provSel: 'sdm-prov', citySel: 'sdm-city', countySel: 'sdm-county',
        canvas: 'sdm-canvas', status: 'sdm-status', back: 'sdm-back',
        onSelect: function (name, lat, lon) {
          var L = lat.toFixed(4), Lo = lon.toFixed(4);
          var la = document.getElementById('sd-lat'), lo = document.getElementById('sd-lon'), co = document.getElementById('sd-county');
          if (la) la.value = L; if (lo) lo.value = Lo; if (co) co.value = lat + ',' + lon + ',' + name;
          var s = document.getElementById('sdm-sel'); if (s) s.textContent = name;
          var sl = document.getElementById('sdm-lat'); if (sl) sl.textContent = L;
          var so = document.getElementById('sdm-lon'); if (so) so.textContent = Lo;
        }
      });
    },
    /* 引擎二输入面板内嵌选点地图：选县即回填 rt-lat/rt-lon/rt-city */
    initRateMap: function () {
      if (!document.getElementById('rtm-canvas')) return;
      window.mapRate = new CountyMap({
        provSel: 'rtm-prov', citySel: 'rtm-city', countySel: 'rtm-county',
        canvas: 'rtm-canvas', status: 'rtm-status', back: 'rtm-back',
        onSelect: function (name, lat, lon) {
          var L = lat.toFixed(4), Lo = lon.toFixed(4);
          var la = document.getElementById('rt-lat'), lo = document.getElementById('rt-lon'), ci = document.getElementById('rt-city');
          if (la) la.value = L; if (lo) lo.value = Lo; if (ci) ci.value = lat + ',' + lon + ',' + name;
          var s = document.getElementById('rtm-sel'); if (s) s.textContent = name;
          var sl = document.getElementById('rtm-lat'); if (sl) sl.textContent = L;
          var so = document.getElementById('rtm-lon'); if (so) so.textContent = Lo;
        }
      });
    }
  };
})();
