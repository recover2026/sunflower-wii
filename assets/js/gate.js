/* ============================================================
   向阳社 · 天气指数保险设计平台 · 访问门禁
   ------------------------------------------------------------
   ⚠️ 安全边界（务必知悉）：纯静态站点无服务端，本门禁为「casual 门禁」，
   仅挡普通误入者，非访问控制，不能承载真实敏感数据。
   真加密保护须改用：① 发布应用(带鉴权沙箱域名) ② 后端会话校验 ③ Basic Auth。
   仅存 SHA-256 哈希，明文密码不写入任何文件。
   ============================================================ */
(function () {
  'use strict';
  // SHA-256('nongxian2026')
  var HASH = '2c13ed08244da02d611cc5296c9fd8bb9c076a946c2a6002242d7a30d8981c14';
  var SESSION_KEY = 'sunflower_wii_gate_v1';

  try {
    if (sessionStorage.getItem(SESSION_KEY) === '1') { return; }
  } catch (e) { /* 隐私模式降级为每次询问 */ }

  // 纯 JS SHA-256（不依赖 crypto.subtle，file:// 与 https 均可，已与 hashlib 对齐校验）
  function sha256(ascii) {
    function rrot(v, c) { return (v >>> c) | (v << (32 - c)); }
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var msg = [];
    for (var i = 0; i < ascii.length; i++) msg.push(ascii.charCodeAt(i));
    msg.push(0x80); while (msg.length % 64 !== 56) msg.push(0);
    var lenBits = ascii.length * 8;
    for (var j = 0; j < 4; j++) msg.push(0);
    msg.push((lenBits >>> 24) & 255); msg.push((lenBits >>> 16) & 255); msg.push((lenBits >>> 8) & 255); msg.push(lenBits & 255);
    var w = new Array(64);
    for (var i = 0; i < msg.length; i += 64) {
      for (var t = 0; t < 16; t++) w[t] = (msg[i + 4 * t] << 24) | (msg[i + 4 * t + 1] << 16) | (msg[i + 4 * t + 2] << 8) | msg[i + 4 * t + 3];
      for (var t = 16; t < 64; t++) {
        var s0 = rrot(w[t - 15], 7) ^ rrot(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rrot(w[t - 2], 17) ^ rrot(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (var t = 0; t < 64; t++) {
        var S1 = rrot(e, 6) ^ rrot(e, 11) ^ rrot(e, 25);
        var ch = (e & f) ^ ((~e) & g);
        var t1 = (h + S1 + ch + K[t] + w[t]) | 0;
        var S0 = rrot(a, 2) ^ rrot(a, 13) ^ rrot(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }

  function mount() {
    var wrap = document.createElement('div');
    wrap.id = 'sfGate';
    wrap.innerHTML =
      '<div class="gate-card">' +
      '  <img src="assets/img/sunflower-logo.png" alt="" class="gate-logo">' +
      '  <div class="gate-title">向阳<span>社</span><span class="gate-sub"> · 天气指数保险设计平台</span></div>' +
      '  <div class="gate-badge">AGRI · WII DESIGN STUDIO</div>' +
      '  <div class="gate-tip">懂农业种植 · 懂气象数据 · 智能反推方案与费率</div>' +
      '  <input id="sfGatePw" type="password" autocomplete="current-password" placeholder="请输入访问密码" class="gate-input">' +
      '  <div id="sfGateMsg" class="gate-msg"></div>' +
      '  <button id="sfGateBtn" class="gate-btn">进入平台</button>' +
      '  <div class="gate-foot">本平台为内部设计辅助工具，数据仅供演示<br>最终以精算报备与监管批复为准</div>' +
      '</div>';
    document.body.appendChild(wrap);
    document.documentElement.style.overflow = 'hidden';

    var pw = wrap.querySelector('#sfGatePw');
    var msg = wrap.querySelector('#sfGateMsg');
    var btn = wrap.querySelector('#sfGateBtn');
    setTimeout(function () { pw.focus(); }, 60);

    function tryIn() {
      var v = pw.value || '';
      if (!v) { msg.textContent = '请输入密码'; return; }
      var h = sha256(v);
      if (h === HASH) {
        try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) { }
        wrap.remove();
        document.documentElement.style.overflow = '';
      } else {
        msg.textContent = '密码不正确，请重试';
        pw.value = '';
        pw.focus();
      }
    }
    btn.addEventListener('click', tryIn);
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); tryIn(); } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
