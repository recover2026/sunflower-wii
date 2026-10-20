/* ============================================================
   引擎一 · 需求反推保险方案（输入关键需求 → 反推可落地方案）
   依赖：window.AGRI_KB
   输出：可被引擎二(方案测算费率)直接消费的 scheme 对象
   升级 v2：① 目标区域省→市→县三级级联（选县自动匹配气候带+坐标）
            ② 主要灾害可多选（组合设计）
            ③ 方案类型：阶梯型理赔阈值 / 线性理赔阈值（RWBCIS式）
            ④ 反推结果结合全生育期农事农时历与作物真实受灾机理
   ============================================================ */
(function () {
  'use strict';
  var KB = window.AGRI_KB;

  // 灾害中文名
  var PERIL_CN = { drought: '干旱/降水亏缺', frost: '低温霜冻', heat: '高温热害', rainy: '连阴雨渍涝', storm: '暴雨洪涝', wind: '大风倒伏' };
  var PERIL_LIST = ['drought', 'frost', 'heat', 'rainy', 'storm', 'wind'];

  // 经验费率基调（纯费率%，仅供反推占位，须用引擎二真实气象回测校准）
  var PERIL_BASE = { drought: [4, 7], frost: [3, 6], heat: [3, 6], rainy: [3, 5], storm: [2, 4], wind: [2, 4] };
  var ZONE_MULT = { northeast: 1.10, huanghuai: 1.05, yangtze: 1.10, southwest: 1.00, northwest: 1.15, south: 1.10 };

  function pct(x) { return (x * 100).toFixed(2) + '%'; }
  function rv(id) { return document.getElementById(id).value; }
  function chk(id) { var e = document.getElementById(id); return e ? e.checked : false; }

  /* ============================================================
     省 → 市 → 县 地理层级（气候带 z + 市坐标；县坐标取县治近似，取自所属市）
     覆盖阳光财险农险主要经营区域的代表农业县，县域坐标用于"送入引擎二取真实历史气象"
     ============================================================ */
  var GEO = {
    '黑龙江': { z: 'northeast', cities: {
      '哈尔滨': { lat: 45.80, lon: 126.53, c: ['哈尔滨市区', '五常市', '巴彦县', '尚志市', '双城区'] },
      '齐齐哈尔': { lat: 47.35, lon: 123.92, c: ['龙江县', '甘南县', '讷河市'] },
      '绥化': { lat: 46.63, lon: 126.97, c: ['北林区', '庆安县', '海伦市'] },
      '佳木斯': { lat: 46.81, lon: 130.37, c: ['富锦市', '桦南县', '桦川县'] } } },
    '吉林': { z: 'northeast', cities: {
      '长春': { lat: 43.82, lon: 125.32, c: ['农安县', '榆树市', '德惠市', '九台区'] },
      '松原': { lat: 45.14, lon: 124.82, c: ['前郭县', '长岭县', '乾安县'] },
      '四平': { lat: 43.17, lon: 124.35, c: ['梨树县', '伊通县', '双辽市'] },
      '吉林市': { lat: 43.84, lon: 126.55, c: ['舒兰市', '永吉县', '磐石市'] } } },
    '辽宁': { z: 'northeast', cities: {
      '沈阳': { lat: 41.80, lon: 123.43, c: ['新民市', '辽中区', '法库县'] },
      '铁岭': { lat: 42.29, lon: 123.84, c: ['昌图县', '开原市', '西丰县'] },
      '锦州': { lat: 41.10, lon: 121.13, c: ['黑山县', '北镇市', '义县'] } } },
    '内蒙古（东部）': { z: 'northeast', cities: {
      '呼伦贝尔': { lat: 49.21, lon: 119.77, c: ['扎兰屯市', '莫力达瓦旗', '阿荣旗'] },
      '兴安盟': { lat: 46.08, lon: 122.08, c: ['乌兰浩特市', '突泉县', '扎赉特旗'] },
      '通辽': { lat: 43.65, lon: 122.27, c: ['科左中旗', '开鲁县', '库伦旗'] },
      '赤峰': { lat: 42.26, lon: 118.92, c: ['翁牛特旗', '宁城县', '喀喇沁旗'] } } },
    '山东': { z: 'huanghuai', cities: {
      '聊城': { lat: 36.46, lon: 115.98, c: ['高唐县', '莘县', '冠县', '临清市'] },
      '德州': { lat: 37.43, lon: 116.36, c: ['禹城市', '平原县', '陵城区'] },
      '济南': { lat: 36.65, lon: 117.12, c: ['章丘区', '商河县', '济阳区'] },
      '菏泽': { lat: 35.23, lon: 115.48, c: ['曹县', '郓城县', '单县'] },
      '济宁': { lat: 35.41, lon: 116.59, c: ['汶上县', '嘉祥县', '兖州区'] } } },
    '河南': { z: 'huanghuai', cities: {
      '周口': { lat: 33.63, lon: 114.65, c: ['扶沟县', '太康县', '西华县', '沈丘县'] },
      '郑州': { lat: 34.75, lon: 113.62, c: ['新郑市', '中牟县', '荥阳市'] },
      '商丘': { lat: 34.41, lon: 115.65, c: ['夏邑县', '虞城县', '柘城县'] },
      '南阳': { lat: 32.99, lon: 112.53, c: ['邓州市', '唐河县', '新野县'] },
      '驻马店': { lat: 33.00, lon: 113.98, c: ['上蔡县', '正阳县', '平舆县'] } } },
    '河北': { z: 'huanghuai', cities: {
      '石家庄': { lat: 38.04, lon: 114.51, c: ['藁城区', '赵县', '栾城区'] },
      '邯郸': { lat: 36.61, lon: 114.49, c: ['大名县', '魏县', '曲周县'] },
      '保定': { lat: 38.87, lon: 115.46, c: ['清苑区', '定州市', '安国市'] },
      '沧州': { lat: 38.30, lon: 116.86, c: ['献县', '吴桥县', '河间市'] } } },
    '安徽（皖北）': { z: 'huanghuai', cities: {
      '合肥': { lat: 31.82, lon: 117.23, c: ['长丰县', '肥东县', '肥西县'] },
      '阜阳': { lat: 32.90, lon: 115.81, c: ['临泉县', '太和县', '颍上县'] },
      '宿州': { lat: 33.63, lon: 116.99, c: ['埇桥区', '灵璧县', '泗县'] },
      '蚌埠': { lat: 32.92, lon: 117.39, c: ['怀远县', '五河县'] } } },
    '江苏（苏北）': { z: 'huanghuai', cities: {
      '徐州': { lat: 34.27, lon: 117.18, c: ['邳州市', '睢宁县', '沛县'] },
      '盐城': { lat: 33.35, lon: 120.16, c: ['大丰区', '射阳县', '建湖县'] },
      '连云港': { lat: 34.60, lon: 119.16, c: ['东海县', '灌云县'] } } },
    '湖北': { z: 'yangtze', cities: {
      '武汉': { lat: 30.59, lon: 114.30, c: ['黄陂区', '江夏区', '新洲区'] },
      '黄冈': { lat: 30.45, lon: 114.87, c: ['浠水县', '蕲春县', '麻城市', '红安县'] },
      '荆州': { lat: 30.35, lon: 112.24, c: ['监利市', '洪湖市', '公安县'] },
      '襄阳': { lat: 32.01, lon: 112.12, c: ['枣阳市', '宜城市', '谷城县'] } } },
    '湖南': { z: 'yangtze', cities: {
      '长沙': { lat: 28.23, lon: 112.94, c: ['长沙县', '宁乡市', '浏阳市'] },
      '常德': { lat: 29.03, lon: 111.70, c: ['桃源县', '临澧县', '汉寿县'] },
      '益阳': { lat: 28.55, lon: 112.36, c: ['南县', '赫山区', '沅江市'] },
      '岳阳': { lat: 29.36, lon: 113.13, c: ['华容县', '岳阳县', '汨罗市'] } } },
    '江西': { z: 'yangtze', cities: {
      '南昌': { lat: 28.68, lon: 115.86, c: ['南昌县', '新建区', '进贤县'] },
      '九江': { lat: 29.71, lon: 116.00, c: ['都昌县', '永修县', '湖口县'] },
      '上饶': { lat: 28.45, lon: 117.97, c: ['鄱阳县', '余干县', '万年县'] },
      '吉安': { lat: 27.12, lon: 114.99, c: ['泰和县', '吉水县', '永丰县'] } } },
    '浙江': { z: 'yangtze', cities: {
      '杭州': { lat: 30.27, lon: 120.15, c: ['建德市', '桐庐县', '富阳区'] },
      '嘉兴': { lat: 30.75, lon: 120.75, c: ['海宁市', '桐乡市', '平湖市'] },
      '宁波': { lat: 29.87, lon: 121.55, c: ['余姚市', '慈溪市'] },
      '金华': { lat: 29.08, lon: 119.65, c: ['兰溪市', '义乌市'] } } },
    '安徽（皖南）': { z: 'yangtze', cities: {
      '芜湖': { lat: 31.33, lon: 118.43, c: ['无为市', '湾沚区'] },
      '安庆': { lat: 30.51, lon: 117.05, c: ['怀宁县', '望江县', '宿松县'] } } },
    '江苏（苏南）': { z: 'yangtze', cities: {
      '南京': { lat: 32.06, lon: 118.80, c: ['高淳区', '溧水区'] },
      '苏州': { lat: 31.30, lon: 120.62, c: ['常熟市', '太仓市'] } } },
    '四川': { z: 'southwest', cities: {
      '成都': { lat: 30.57, lon: 104.07, c: ['崇州市', '邛崃市', '金堂县'] },
      '绵阳': { lat: 31.47, lon: 104.68, c: ['三台县', '江油市', '梓潼县'] },
      '南充': { lat: 30.80, lon: 106.08, c: ['西充县', '南部县', '阆中市'] },
      '宜宾': { lat: 28.75, lon: 104.64, c: ['宜宾县', '江安县', '长宁县'] },
      '德阳': { lat: 31.13, lon: 104.40, c: ['中江县', '广汉市'] } } },
    '重庆': { z: 'southwest', cities: {
      '重庆': { lat: 29.56, lon: 106.55, c: ['合川区', '铜梁区', '垫江县', '忠县'] } } },
    '贵州': { z: 'southwest', cities: {
      '贵阳': { lat: 26.65, lon: 106.63, c: ['开阳县', '息烽县', '清镇市'] },
      '遵义': { lat: 27.73, lon: 106.92, c: ['湄潭县', '播州区', '凤冈县'] },
      '黔东南': { lat: 26.58, lon: 107.98, c: ['凯里市', '黎平县', '锦屏县'] } } },
    '云南': { z: 'southwest', cities: {
      '昆明': { lat: 25.04, lon: 102.71, c: ['宜良县', '石林县', '嵩明县'] },
      '曲靖': { lat: 25.49, lon: 103.68, c: ['陆良县', '师宗县', '罗平县'] },
      '玉溪': { lat: 24.35, lon: 102.55, c: ['通海县', '澄江市', '江川区'] },
      '红河': { lat: 23.37, lon: 103.37, c: ['建水县', '石屏县', '弥勒市'] } } },
    '陕西': { z: 'northwest', cities: {
      '西安': { lat: 34.34, lon: 108.94, c: ['周至县', '鄠邑区', '蓝田县'] },
      '渭南': { lat: 34.50, lon: 109.50, c: ['大荔县', '蒲城县', '富平县'] },
      '咸阳': { lat: 34.34, lon: 108.71, c: ['武功县', '兴平市', '三原县'] },
      '榆林': { lat: 38.29, lon: 109.74, c: ['榆阳区', '靖边县', '定边县'] } } },
    '甘肃': { z: 'northwest', cities: {
      '兰州': { lat: 36.06, lon: 103.83, c: ['榆中县', '永登县'] },
      '张掖': { lat: 38.93, lon: 100.45, c: ['临泽县', '高台县', '甘州区'] },
      '庆阳': { lat: 35.71, lon: 107.64, c: ['西峰区', '镇原县', '宁县'] },
      '酒泉': { lat: 39.74, lon: 98.49, c: ['敦煌市', '金塔县'] } } },
    '宁夏': { z: 'northwest', cities: {
      '银川': { lat: 38.49, lon: 106.23, c: ['贺兰县', '永宁县', '灵武市'] },
      '吴忠': { lat: 38.00, lon: 106.20, c: ['青铜峡市', '利通区', '盐池县'] } } },
    '新疆': { z: 'northwest', cities: {
      '乌鲁木齐': { lat: 43.83, lon: 87.62, c: ['米东区', '乌鲁木齐县'] },
      '昌吉': { lat: 44.02, lon: 87.30, c: ['昌吉市', '玛纳斯县', '呼图壁县'] },
      '伊犁': { lat: 43.92, lon: 81.32, c: ['伊宁市', '察布查尔县', '霍城县'] },
      '阿克苏': { lat: 41.17, lon: 80.27, c: ['温宿县', '沙雅县', '库车市'] } } },
    '山西': { z: 'northwest', cities: {
      '太原': { lat: 37.87, lon: 112.55, c: ['清徐县', '阳曲县', '娄烦县'] },
      '运城': { lat: 35.02, lon: 111.00, c: ['临猗县', '芮城县', '永济市'] },
      '晋中': { lat: 37.69, lon: 112.75, c: ['太谷区', '祁县', '平遥县'] } } },
    '内蒙古（西部）': { z: 'northwest', cities: {
      '呼和浩特': { lat: 40.84, lon: 111.75, c: ['土默特左旗', '托克托县', '和林格尔县'] },
      '巴彦淖尔': { lat: 40.74, lon: 107.40, c: ['临河区', '五原县', '杭锦后旗'] },
      '鄂尔多斯': { lat: 39.61, lon: 109.78, c: ['准格尔旗', '达拉特旗'] } } },
    '广东': { z: 'south', cities: {
      '广州': { lat: 23.13, lon: 113.26, c: ['从化区', '增城区', '花都区'] },
      '茂名': { lat: 21.66, lon: 110.93, c: ['高州市', '化州市', '信宜市'] },
      '湛江': { lat: 21.27, lon: 110.36, c: ['雷州市', '徐闻县', '遂溪县'] },
      '肇庆': { lat: 23.05, lon: 112.44, c: ['高要区', '四会市'] } } },
    '广西': { z: 'south', cities: {
      '南宁': { lat: 22.82, lon: 108.37, c: ['武鸣区', '隆安县', '上林县'] },
      '玉林': { lat: 22.63, lon: 110.18, c: ['陆川县', '博白县', '北流市'] },
      '桂林': { lat: 25.27, lon: 110.29, c: ['临桂区', '全州县', '灵川县'] },
      '柳州': { lat: 24.33, lon: 109.42, c: ['柳城县', '鹿寨县'] } } },
    '福建': { z: 'south', cities: {
      '福州': { lat: 26.07, lon: 119.30, c: ['闽侯县', '福清市', '长乐区'] },
      '漳州': { lat: 24.51, lon: 117.66, c: ['龙海区', '南靖县', '漳浦县'] },
      '泉州': { lat: 24.87, lon: 118.58, c: ['南安市', '安溪县', '惠安县'] } } },
    '海南': { z: 'south', cities: {
      '海口': { lat: 20.04, lon: 110.32, c: ['琼山区', '澄迈县'] },
      '三亚': { lat: 18.25, lon: 109.51, c: ['崖州区', '乐东县'] },
      '儋州': { lat: 19.52, lon: 109.58, c: ['儋州市', '临高县'] } } }
  };

  function geoMeta(prov, city, county) {
    var g = GEO[prov]; if (!g) return null;
    var c = g.cities[city]; if (!c) return null;
    return { zone: g.z, lat: c.lat, lon: c.lon };
  }

  // 初始化省→市→县级联
  function initGeo() {
    var prov = document.getElementById('rv-prov');
    if (!prov) return;
    Object.keys(GEO).forEach(function (p) {
      var o = document.createElement('option'); o.value = p; o.textContent = p; prov.appendChild(o);
    });
    function fillCity(p) {
      var cs = document.getElementById('rv-city'); cs.innerHTML = '<option value="">市</option>';
      var co = document.getElementById('rv-county'); co.innerHTML = '<option value="">县/区</option>';
      if (!p) return;
      Object.keys(GEO[p].cities).forEach(function (c) {
        var o = document.createElement('option'); o.value = c; o.textContent = c; cs.appendChild(o);
      });
    }
    function fillCounty(p, c) {
      var co = document.getElementById('rv-county'); co.innerHTML = '<option value="">县/区</option>';
      if (!p || !c) return;
      GEO[p].cities[c].c.forEach(function (x) {
        var o = document.createElement('option'); o.value = x; o.textContent = x; co.appendChild(o);
      });
    }
    prov.addEventListener('change', function () {
      fillCity(this.value);
      document.getElementById('rv-county').innerHTML = '<option value="">县/区</option>';
      document.getElementById('rv-geo-status').textContent = '已选省，继续选市、县';
    });
    document.getElementById('rv-city').addEventListener('change', function () {
      fillCounty(rv('rv-prov'), this.value);
      document.getElementById('rv-geo-status').textContent = '已选市，继续选县/区';
    });
    document.getElementById('rv-county').addEventListener('change', function () {
      var st = document.getElementById('rv-geo-status');
      if (!this.value) { st.textContent = '选县后自动匹配气候带，坐标自动送入引擎二取该县真实历史气象'; return; }
      var m = geoMeta(rv('rv-prov'), rv('rv-city'), this.value);
      if (m && document.getElementById('rv-zone')) document.getElementById('rv-zone').value = m.zone;
      st.innerHTML = '已选 <b>' + rv('rv-prov') + ' · ' + rv('rv-city') + ' · ' + this.value +
        '</b>　气候带：' + (KB.zones[m.zone] ? KB.zones[m.zone].name : m.zone) +
        '　坐标(县治近似)：' + m.lat.toFixed(2) + '°N, ' + m.lon.toFixed(2) + '°E（自动送入引擎二取真实历史气象）';
    });
  }

  /* ---------- 物候 / 子方案 ---------- */
  function findWindow(crop, peril) {
    var phases = crop.phenology;
    for (var i = 0; i < phases.length; i++) {
      if (phases[i].vul.indexOf(peril) >= 0) return phases[i];
    }
    return phases[phases.length - 1];
  }

  // 单责任子方案（保留旧形状，兼容引擎二 loadFromScheme）
  function subScheme(crop, zoneKey, peril, sum) {
    var tpl = KB.perilTpl[peril];
    var idx = KB.indexTypes[tpl.index];
    var phase = findWindow(crop, peril);
    return {
      peril: peril, perilName: PERIL_CN[peril],
      indexKey: tpl.index, indexName: idx.name, indexBase: idx.base, indexUnit: idx.unit, indexDir: idx.dir,
      window: phase.m.slice(), windowLabel: phase.name,
      triggerParams: tpl.params, ratio: JSON.parse(JSON.stringify(tpl.ratio)),
      phenoNote: phase.note
    };
  }

  // 当前勾选的灾害（按 PERIL_LIST 顺序）
  function getCheckedPerils() {
    var box = document.getElementById('rv-perils'); if (!box) return [];
    var out = [];
    PERIL_LIST.forEach(function (p) {
      var inp = box.querySelector('input[value="' + p + '"]');
      if (inp && inp.checked) out.push(p);
    });
    return out;
  }

  function buildScheme() {
    var cropKey = rv('rv-crop');
    var zoneKey = rv('rv-zone');
    var perils = getCheckedPerils();
    var sum = parseFloat(rv('rv-sum')) || 400;
    var rateCap = parseFloat(rv('rv-cap')) || 0;
    var insured = rv('rv-insured');
    var policy = chk('rv-policy');
    var paytype = rv('rv-paytype') || 'step';
    var crop = KB.crops[cropKey];
    var subs = perils.map(function (p) { return subScheme(crop, zoneKey, p, sum); });
    var primary = subs[0] || null;
    var combo = null;
    if (subs.length > 1) {
      var p1 = subs[0], p2 = subs[1];
      var lo = Math.min(1, (PERIL_BASE[p1.peril][0] + PERIL_BASE[p2.peril][0]) / 100 * (ZONE_MULT[zoneKey] || 1));
      var hi = Math.min(1, (PERIL_BASE[p1.peril][1] + PERIL_BASE[p2.peril][1]) / 100 * (ZONE_MULT[zoneKey] || 1));
      combo = { primary: p1, secondary: p2, lo: lo, hi: hi };
    }
    var geo = geoMeta(rv('rv-prov'), rv('rv-city'), rv('rv-county'));
    return {
      crop: cropKey, cropName: crop.name, zone: zoneKey, zoneName: KB.zones[zoneKey] ? KB.zones[zoneKey].name : '—',
      perils: subs, primary: primary, combo: combo, paytype: paytype,
      sumInsured: sum, rateCap: rateCap, insured: insured, policy: policy,
      county: rv('rv-county') || '', city: rv('rv-city') || '', province: rv('rv-prov') || '', geo: geo
    };
  }

  function estimateRateOne(peril, zoneKey) {
    var base = PERIL_BASE[peril];
    var mult = ZONE_MULT[zoneKey] || 1.0;
    return { lo: Math.max(0.5, (base[0] - 1.2) * mult), hi: (base[1] + 1.2) * mult };
  }

  function renderRatioTable(idx) {
    var ratio = idx.ratio, dir = idx.indexDir, op = dir === 'low' ? '≤' : '≥', unit = idx.indexUnit;
    var keys = Object.keys(ratio).map(Number).sort(function (a, b) { return dir === 'low' ? b - a : a - b; });
    var rows = '';
    keys.forEach(function (k) { rows += '<tr><td>' + unit + ' ' + op + ' ' + fmtNum(k) + '</td><td>赔付 ' + pct(ratio[k]) + '</td></tr>'; });
    return '<table class="mini"><tr><th>触发条件</th><th>赔付强度</th></tr>' + rows + '</table>';
  }

  // 线性理赔阈值（RWBCIS式）：触发→退出区间线性折算
  function linearInfo(sub) {
    var dir = sub.indexDir;
    var ks = Object.keys(sub.ratio).map(Number).sort(function (a, b) { return a - b; });
    var T, E, cap;
    if (dir === 'low') { T = ks[ks.length - 1]; E = ks[0]; cap = sub.ratio[E]; }
    else { T = ks[0]; E = ks[ks.length - 1]; cap = sub.ratio[E]; }
    var mid = (T + E) / 2;
    return {
      dir: dir, T: T, E: E, cap: cap, unit: sub.indexUnit,
      formula: dir === 'low'
        ? '赔付率 = ' + pct(cap) + ' × (' + fmtNum(T) + ' − 指数值) ÷ (' + fmtNum(T) + ' − ' + fmtNum(E) + ')；指数 ≥ ' + fmtNum(T) + ' 赔0%，≤ ' + fmtNum(E) + ' 按 ' + pct(cap) + ' 封顶'
        : '赔付率 = ' + pct(cap) + ' × (指数值 − ' + fmtNum(T) + ') ÷ (' + fmtNum(E) + ' − ' + fmtNum(T) + ')；指数 ≤ ' + fmtNum(T) + ' 赔0%，≥ ' + fmtNum(E) + ' 按 ' + pct(cap) + ' 封顶',
      samples: [[T, 0], [mid, cap / 2], [E, cap]]
    };
  }
  function renderLinear(sub) {
    var L = linearInfo(sub), rows = '';
    L.samples.forEach(function (r) {
      rows += '<tr><td>' + sub.indexUnit + ' ' + fmtNum(r[0]) + '</td><td>赔付 ' + pct(r[1]) + '</td></tr>';
    });
    return '<table class="mini"><tr><th>指数值</th><th>赔付率</th></tr>' + rows + '</table>' +
      '<div class="note-sm">线性折算（' + (L.dir === 'low' ? '越低越赔' : '越高越赔') + '）：' + L.formula + '</div>';
  }

  function fmtNum(x) { return parseFloat(x.toFixed(2)).toString(); }
  function fmtMD(m, d) { return m + '月' + d + '日'; }
  function fmtSpan(arr) { return arr[0] + '月—' + arr[2] + '月'; }

  // 全生育期农事农时历
  function phenoCalendar(crop) {
    var rows = '';
    crop.phenology.forEach(function (ph) {
      var perilsCN = ph.vul.map(function (p) { return PERIL_CN[p]; }).join('、');
      rows += '<tr><td>' + ph.name + '</td><td>' + fmtSpan(ph.m) + '</td><td>' + perilsCN + '</td><td>' + ph.note + '</td></tr>';
    });
    return '<div class="rb-sub">全生育期农事农时历（' + crop.name + '）</div>' +
      '<table class="mini wide"><tr><th>生育阶段</th><th>月份区间</th><th>主要怕灾</th><th>真实受灾机理</th></tr>' + rows + '</table>';
  }

  // 某种灾害在哪些物候阶段造成真实受灾（机理串联）
  function mechanismFor(crop, peril) {
    var hits = crop.phenology.filter(function (ph) { return ph.vul.indexOf(peril) >= 0; });
    if (!hits.length) return '<div class="note-sm">' + PERIL_CN[peril] + '：本作物物候库中无直接命中阶段（可结合县域实测标定）。</div>';
    return hits.map(function (ph) {
      return '<li><b>' + ph.name + '（' + fmtSpan(ph.m) + '）</b>：' + ph.note + '</li>';
    }).join('');
  }

  // 单责任卡片块（含农事农时 + 真实受灾机理 + 阶梯/线性赔付）
  function perilBlock(sub, paytype, tag) {
    var est = estimateRateOne(sub.peril, currentZone());
    var payout = paytype === 'linear' ? renderLinear(sub) : renderRatioTable(sub);
    var payLabel = paytype === 'linear' ? '线性理赔阈值（RWBCIS式）' : '阶梯型理赔阈值（分档查表）';
    return '<div class="res-block"><div class="rb-h">' + tag + ' · ' + sub.indexName + '（' + sub.perilName + '）</div>' +
      '<div class="rb-b">' +
      card('关键物候窗口（农事农时）', sub.windowLabel, '卡点：' + sub.phenoNote + '<br>建议保险期间：每年 ' + fmtMD(sub.window[0], sub.window[1]) + ' — ' + fmtMD(sub.window[2], sub.window[3])) +
      card('真实受灾机理（作物对应）', PERIL_CN[sub.peril] + ' 命中阶段', '<ul class="mech">' + mechanismFor(currentCrop(), sub.peril) + '</ul>') +
      card('触发参数建议', '待试点县标定', sub.triggerParams) +
      card('经验费率区间（纯费率）', pct(est.lo / 100) + ' ~ ' + pct(est.hi / 100),
        '含费用率15%+风险附加10%后综合费率约 ' + pct(est.lo * 1.25 / 100) + ' ~ ' + pct(est.hi * 1.25 / 100) + '<br>补贴后农户端常封顶 1.5-2%') +
      '<div class="rb-sub">分段赔付函数 · ' + payLabel + '（保额 ' + currentSum() + ' 元/亩）</div>' + payout +
      '<div class="note-sm">赔付额 = 单位保额 × 指数赔付率（' + (paytype === 'linear' ? '线性折算' : '分档查表') + '），设起赔与封顶；阈值/比例以【】占位，待历史气象标定+监管批复。</div>' +
      '</div></div>';
  }

  function currentZone() { return rv('rv-zone'); }
  function currentSum() { return parseFloat(rv('rv-sum')) || 400; }
  function currentCrop() { return KB.crops[rv('rv-crop')]; }

  function basisRisk(s) {
    var region = s.county ? (s.province + '·' + s.city + '·' + s.county) : (s.zoneName || '—');
    var arr = [
      '① <b>农时物候精准匹配</b>：指数必须卡在作物最怕灾时点（如 ' + (s.primary ? s.primary.windowLabel : '关键物候窗口') + '），从源头降基差；',
      '② <b>网格化 + 加地面观测</b>：县域用多站/卫星网格化（ERA5 约 25km 网格，须以县站/省气候中心观测标定）；本方案目标县【' + region + '】坐标约 ' + (s.geo ? (s.geo.lat.toFixed(2) + '°N,' + s.geo.lon.toFixed(2) + '°E') : '待选') + '，可送入引擎二取真实历史气象。',
      '③ <b>遥感校验校准</b>：NDVI/降水反演作设计期校验与对农户/监管佐证（纯指数不叠加产量触发）；',
      '④ <b>机器学习量化基差</b>：建模"气象指数→实际损失"偏差分布，定位高基差区域/作物；',
      '⑤ <b>再保/区域分散</b>：系统性基差用再保与多县区组合分散；多责任合计时合计 ULR 须落在 70%-75%，勿机械平分。'
    ];
    return arr.join('<br>');
  }

  function render(scenarioKey) {
    var scheme, out;
    try { scheme = buildScheme(); } catch (e) { return; }
    out = document.getElementById('reverse-out');
    if (!scheme.perils.length) {
      out.innerHTML = '<div class="warn">请至少勾选一种「主要灾害」（可多选组合设计）后再反推。</div>';
      out.style.display = 'block';
      return;
    }

    var regionTxt = scheme.county
      ? (scheme.province + ' · ' + scheme.city + ' · <b>' + scheme.county + '</b>')
      : (scheme.zoneName || '—');
    var geoTxt = scheme.geo ? ('　坐标(县治近似)：' + scheme.geo.lat.toFixed(2) + '°N, ' + scheme.geo.lon.toFixed(2) + '°E') : '';

    var rateNote = scheme.rateCap > 0
      ? '<div class="warn">你设定的期望费率上限为 <b>' + pct(scheme.rateCap / 100) + '</b>；下方为经验费率区间，若超出需用引擎二回测后收紧阈值或提保额/调结构。</div>'
      : '';

    var comboNote = '';
    if (scheme.combo) {
      comboNote = '<div class="callout" style="margin-top:10px"><b>多责任合计前瞻：</b>主害（' + scheme.combo.primary.perilName +
        '）与次害（' + scheme.combo.secondary.perilName + '）合计经验纯费率约 ' + pct(scheme.combo.lo / 100) + ' ~ ' +
        pct(scheme.combo.hi / 100) + '。进入引擎二勾选「多责任合计」可逐年叠加两责赔付（封顶100%）真实回测<b>合计 ULR</b>，并校准至 70%-75% 可持续带。</div>';
    }

    var perilBlocks = scheme.perils.map(function (sub, i) {
      return perilBlock(sub, scheme.paytype, scheme.perils.length > 1 ? ('责任' + (i + 1)) : '主害责任');
    }).join('');

    var payIntro = scheme.paytype === 'linear'
      ? '<div class="res-block"><div class="rb-h">方案类型说明 · 线性理赔阈值（RWBCIS式）</div><div class="rb-b">触发即按"触发值→退出值"线性折算赔付，无分档跳变，平滑贴合农户损失曲线；适用于物候窗口内指数连续变化、农户损失近似线性的场景（印度 RWBCIS 主要形态）。退出值以上按封顶比例赔。</div></div>'
      : '<div class="res-block"><div class="rb-h">方案类型说明 · 阶梯型理赔阈值（分档查表）</div><div class="rb-b">达到档位即按固定比例赔付，规则直观、农户易懂、理赔口径清晰，是国内天气指数保险市场主流形态。每档设起赔与封顶。</div></div>';

    var html =
      '<div class="res-head">反推方案 · ' + scheme.cropName + ' · ' + regionTxt + geoTxt + '</div>' +
      '<div class="res-block"><div class="rb-h">全生育期农事农时历与真实受灾机理</div>' +
      '<div class="rb-b">' + phenoCalendar(KB.crops[scheme.crop]) + '</div></div>' +
      perilBlocks +
      payIntro +
      '<div class="res-block"><div class="rb-h">基差风险治理（核心敌人）</div>' +
      '<div class="rb-b">' + basisRisk(scheme) + '</div></div>' +
      '<div class="res-block"><div class="rb-h">标定数据源与监管锚定</div>' +
      '<div class="rb-b">历史气象标定源：Open-Meteo Archive（ERA5 再分析，25km 网格，免费可溯源）作初算；<b>精算报备须以试点县国家气象站/省气候中心观测标定</b>。合规：金发〔2024〕35号(双精准)、银保监规〔2023〕4号(精算)、银保监规〔2022〕4号(承保理赔办法)。主体区分：<b>阳光财产保险股份有限公司≠阳光农业相互保险公司</b>。纯天气指数触发，遥感仅作校验/校准与佐证。</div></div>' +
      comboNote + rateNote +
      (scenarioKey ? scenarioBlock(scenarioKey, scheme) : '') +
      '<div class="res-actions"><button class="primary" id="rv-to-rate">→ 把此方案送入「方案测算费率」引擎' + (scheme.combo ? '（多责任合计）' : '') + '</button>' +
      '<button class="ghost" id="rv-copy">复制方案(JSON)</button></div>' +
      '<div class="note-sm">说明：本反推为方法论占位方案，所有阈值/费率以【】占位，最终以试点县历史气象数据标定与监管批复为准。</div>';

    out.innerHTML = html;
    out.style.display = 'block';

    document.getElementById('rv-to-rate').addEventListener('click', function () {
      window.RateEngine.loadFromScheme(scheme);
      window.switchTab('rate');
    });
    document.getElementById('rv-copy').addEventListener('click', function () {
      navigator.clipboard && navigator.clipboard.writeText(JSON.stringify(scheme, null, 2));
      this.textContent = '已复制 ✓';
      var t = this; setTimeout(function () { t.textContent = '复制方案(JSON)'; }, 1500);
    });
  }

  function card(title, val, sub) {
    return '<div class="rc"><div class="rc-t">' + title + '</div><div class="rc-v">' + val + '</div><div class="rc-s">' + (sub || '') + '</div></div>';
  }

  // 场景化落地要点（把反推方案变成可交差的动作）
  function scenarioBlock(key, s) {
    if (key === 's1') {
      var lvl = s.combo ? '双责任（' + s.combo.primary.perilName + '+' + s.combo.secondary.perilName + '）' : '单责任（' + s.primary.perilName + '）';
      return '<div class="res-block scn"><div class="rb-h">场景：遴选 / 应标创新点 · 可直接写入应标文件</div>' +
        '<div class="rb-b"><ol class="scn-list">' +
        '<li><b>产品创新条款（评审加分项）</b>：在"产品创新/科技赋能"章节陈述——' + s.cropName + '天气指数保险（' + lvl + '），纯气象指数触发、遥感校验，理赔时效 T+0~T+3。</li>' +
        '<li><b>指数触发逻辑</b>：' + s.primary.indexName + '，卡点窗口 ' + s.primary.windowLabel + '（每年 ' + (s.primary.window[0]) + '月' + s.primary.window[1] + '日—' + s.primary.window[2] + '月' + s.primary.window[3] + '日），阈值以【】占位待试点县标定。</li>' +
        '<li><b>费率测算依据</b>：经验纯费率 ' + currentEst(s) + '；须用本平台引擎二以试点县真实气象回测 ULR，写入"费率科学依据"章节。</li>' +
        '<li><b>基差治理承诺</b>：农时物候精准匹配 + 网格化 + 遥感校准，作为"降争议"承诺写入服务方案。</li>' +
        '<li><b>合规锚定</b>：金发〔2024〕35号(双精准)、银保监规〔2023〕4号(精算)；主体写"阳光财产保险股份有限公司"。</li>' +
        '</ol><div class="note-sm">评审口径：产品创新 + 科技赋能 + 农户获得感 三项叠加最具加分价值；避免写"无灾返保费"等违规表述。</div></div></div>';
    }
    if (key === 's2') {
      return '<div class="res-block scn"><div class="rb-h">场景：县域特色险种立项 · 立项汇报要点</div>' +
        '<div class="rb-b"><ol class="scn-list">' +
        '<li><b>主害与物候依据</b>：' + s.cropName + '在' + s.zoneName + '最怕灾为' + s.primary.perilName + '，卡点窗口 ' + s.primary.windowLabel + '（' + s.primary.phenoNote + '）。</li>' +
        '<li><b>保额与费率区间</b>：建议保额 ' + s.sumInsured + ' 元/亩；纯费率 ' + currentEst(s) + '，综合费率(×1.25) 待引擎二回测校准。</li>' +
        '<li><b>财政可承受能力</b>：用本平台"财政补贴与农户封顶测算"测算各级分担，确保农户端封顶可控。</li>' +
        '<li><b>试点县遴选建议</b>：选该作物集中、气象站/省气候中心数据可得、基差可控的县先行小步试点（本平台可细分到县）。</li>' +
        '<li><b>基差治理与理赔路径</b>：农时物候匹配 + 遥感校验；定损争议由气象数据权威性兜底。</li>' +
        '</ol><div class="note-sm">立项节奏建议：立项标定(1-3月)→小步试点(4-9月)→扩面报备(10-12月)，与政策遴选周期错峰。</div></div></div>';
    }
    return '';
  }
  function currentEst(s) {
    var b = { drought: [4, 7], frost: [3, 6], heat: [3, 6], rainy: [3, 5], storm: [2, 4], wind: [2, 4] }[s.primary.peril];
    var m = { northeast: 1.10, huanghuai: 1.05, yangtze: 1.10, southwest: 1.00, northwest: 1.15, south: 1.10 }[s.zone] || 1;
    return (b[0] * m).toFixed(1) + '% ~ ' + (b[1] * m).toFixed(1) + '%';
  }

  /* ---------- 纯参数反推方案（供方案设计器"一键成案"调用，不依赖 DOM） ---------- */
  function propose(opt) {
    if (!opt) throw new Error('propose 缺少参数');
    var cropKey = opt.cropKey, zoneKey = opt.zoneKey || 'yangtze';
    var crop = KB.crops[cropKey];
    if (!crop) throw new Error('未知作物代码：' + cropKey);
    if (!opt.peril) throw new Error('请指定主害风险(peril)');
    var sum = opt.sum || 400;
    var subs = [subScheme(crop, zoneKey, opt.peril, sum)];
    if (opt.peril2) subs.push(subScheme(crop, zoneKey, opt.peril2, sum));
    var primary = subs[0];
    var combo = null;
    if (subs.length > 1) {
      var p1 = subs[0], p2 = subs[1];
      var lo = Math.min(1, (PERIL_BASE[p1.peril][0] + PERIL_BASE[p2.peril][0]) / 100 * (ZONE_MULT[zoneKey] || 1));
      var hi = Math.min(1, (PERIL_BASE[p1.peril][1] + PERIL_BASE[p2.peril][1]) / 100 * (ZONE_MULT[zoneKey] || 1));
      combo = { primary: p1, secondary: p2, lo: lo, hi: hi };
    }
    return {
      crop: cropKey, cropName: crop.name, zone: zoneKey,
      zoneName: KB.zones[zoneKey] ? KB.zones[zoneKey].name : '—',
      perils: subs, primary: primary, combo: combo, paytype: 'step',
      sumInsured: sum
    };
  }

  // 暴露 + 自初始化级联
  window.ReverseEngine = { init: initGeo, render: render, buildScheme: buildScheme, propose: propose };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGeo);
  else initGeo();
})();
