const $ = s => document.querySelector(s);
const video = $('#video'), track = $('#track'), tl = $('#tl'), stage = $('#stage');
const zw = $('#zw'), fxEl = $('#fx');
let pid = null, meta = null, clips = [], sfx = [], music = null, assets = [], texts = [], fonts = [], fxs = [], imgs = [], shapes = [];
let sel = -1, selSfx = null, selMusic = false, selText = null, selFx = null, selImg = null, selShape = null, cur = 0, head = 0, playing = false, pps = 40;
let undo = [], redo = [], saveT = null, gesture = false, zkey = '', swallow = false;
let linked = true, mute = false;   // linked = main item delete කරන්න බෑ · mute = main video sound off
let dirty = false, uiT = null, openTok = 0;   // dirty = save කරන්න තියෙන edit; openTok = project switch token
const DEF = { smooth: false, speed: 1, zoom: 1, zx: 0.5, zy: 0.5, crop: null, pos: null, rad: 0 };   // pos = {x,y,w}: video placement on the canvas (center x/y 0..1, w = width / canvas width); null = auto fit   // rad = corner radius (video region එකේ පොඩි පැත්තේ fraction, 0..0.5)
let canvas = 'auto';   // output ratio: auto | orig | 'a:b'
let canvasBg = '#000000';   // canvas background color (empty areas around / behind the main video)
let cropMode = false, cropIdx = -1, cb = null, cratio = null;   // crop editor state
const TRDEF = { type: 'none', dur: 0.4, snd: null, sv: 1 };
const norm = c => ({ ...DEF, ...c, tr: { ...TRDEF, ...(c.tr || {}) } });

const sp = c => c.speed || 1;
const SPMIN = 0.1, SPMAX = 8;   // speed slider = log scale (slow 0.1x ට හොඳ ඉඩක්)
const spToSl = v => 100 * Math.log(Math.max(SPMIN, Math.min(SPMAX, v)) / SPMIN) / Math.log(SPMAX / SPMIN);
const slToSp = v => { const x = SPMIN * Math.pow(SPMAX / SPMIN, v / 100); return Math.max(SPMIN, Math.min(SPMAX, x < 2 ? Math.round(x * 20) / 20 : Math.round(x * 4) / 4)); };
const len = c => (c.end - c.start) / sp(c);
// main track එක හිස් (main delete කරලා) නම් timeline එකේ දිග = ඉතිරි items වල අන්තිම කෙළවර (ඒවගේ duration වෙනස් වෙන්නේ නෑ)
const ghostLen = () => Math.max(0, ...sfx.map(s => s.t + (asset(s.asset)?.duration || 1)), ...texts.map(t => t.start + t.dur), ...imgs.map(t => t.start + t.dur), ...shapes.map(t => t.start + t.dur), ...fxs.map(f => f.start + f.dur));
const total = () => clips.length ? clips.reduce((a, c) => a + len(c), 0) : ghostLen();
const offsets = () => { let o = 0; return clips.map(c => { const r = o; o += len(c); return r; }); };
const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const setStatus = s => $('#status').textContent = s;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 9);
const asset = id => assets.find(a => a.id === id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clearSel = () => { sel = -1; selSfx = null; selMusic = false; selText = null; selFx = null; selImg = null; selShape = null; };

// ---- scroll (ticker): text / image canvas එක හරහා ගමන් කරලා අනිත් පැත්තෙන් ආපහු එනවා (export එකේ backend ov_x() එකම formula) ----
// t.x = item එකේ පටන් ගන්න තැන (center, 0..1) · t.scr = -1 වමට / 1 දකුණට / 0 නැහැ · t.spd = canvas width එකෙන් තත්පරයකට කීයද
const scrDir = t => +t.scr || 0;
const scrU = t => head >= t.start - 1e-6 && head < t.start + t.dur ? head - t.start : 0;
const scrOff = t => scrDir(t) * (t.spd || 0.2) * scrU(t);
const wrapX = (p, w) => { const L = 1 + w, lo = -w / 2; return lo + (((p - lo) % L) + L) % L; };
const dispX = (t, w) => scrDir(t) ? wrapX(t.x + scrOff(t), w) : t.x;
// ---- vertical scroll: t.scv = -1 උඩට (පහළින් උඩට) / 1 පහළට (උඩින් පහළට) · speed = canvas height එකෙන් තත්පරයකට (t.spd) ----
const scrV = t => +t.scv || 0;
const isScr = t => !!(scrDir(t) || scrV(t));
const scrOffY = t => scrV(t) * (t.spd || 0.2) * scrU(t);
const dispY = (t, h) => scrV(t) ? wrapX(t.y + scrOffY(t), h) : t.y;
// image / video height as a fraction of the canvas height: h > 0 = freely resized by the user · else derived from the file's own aspect ratio
const imHf = t => { if (+t.h > 0) return +t.h; const a = t.emoji ? null : asset(t.asset), ar = a?.w && a?.h ? a.w / a.h : 1; return t.w * (stage.clientWidth || 1) / ar / (stage.clientHeight || 1); };

// ================= audio engine (SFX + music preview) =================
let ac = null, live = [], prev = null;
const bufs = {};
const ctx = () => ac || (ac = new (window.AudioContext || window.webkitAudioContext)());

async function loadBuf(id) {
  if (bufs[id]) return bufs[id];
  try {
    const ab = await (await fetch(`/api/assets/${id}/file`)).arrayBuffer();
    bufs[id] = await ctx().decodeAudioData(ab);
  } catch (e) { console.warn('audio decode failed', id, e); }
  return bufs[id];
}
const preloadAudio = () => [...sfx.map(s => s.asset), music?.asset, ...clips.map(c => c.tr?.snd)].filter(Boolean).forEach(loadBuf);

function audioStop() { live.forEach(s => { try { s.stop(); } catch {} }); live = []; }

function audioStart() {
  audioStop();
  const a = ctx(); a.resume();
  const t0 = a.currentTime + 0.05, h = head, T = total();
  const out = (buf, vol, when, off, loop) => {
    const s = a.createBufferSource(), g = a.createGain();
    s.buffer = buf; s.loop = !!loop; g.gain.value = vol;
    s.connect(g); g.connect(a.destination); s.start(when, off); live.push(s);
    return g;
  };
  for (const x of allSfx()) {
    const b = bufs[x.asset]; if (!b) continue;
    if (x.t >= h) out(b, x.vol, t0 + (x.t - h), 0);
    else if (h - x.t < b.duration) out(b, x.vol, t0, h - x.t);
  }
  if (music && bufs[music.asset]) {
    const b = bufs[music.asset], g = out(b, music.vol, t0, h % b.duration, true).gain;
    const f = Math.min(music.fade, T);
    if (f > 0) {
      const fs = T - f;
      if (h >= fs) g.setValueAtTime(music.vol * Math.max(0, (T - h) / f), t0);
      else g.setValueAtTime(music.vol, t0 + (fs - h));
      g.linearRampToValueAtTime(0, t0 + Math.max(0.01, T - h));
    }
  }
}

async function previewAsset(a) {
  const b = await loadBuf(a.id); if (!b) return;
  if (prev) { try { prev.stop(); } catch {} }
  const s = ctx().createBufferSource();
  s.buffer = b; s.connect(ctx().destination); ctx().resume(); s.start(); prev = s;
}

// ================= timeline math / playback =================
function tlToClip(t) {
  const off = offsets();
  for (let i = clips.length - 1; i >= 0; i--)
    if (t >= off[i]) { const c = clips[i]; return { i, src: c.start + Math.min(t - off[i], len(c)) * sp(c) }; }
  return { i: 0, src: clips[0].start };
}

function seek(t) {
  if (!pid) return;
  if (!clips.length) { head = Math.max(0, Math.min(t, total())); touchUi(); return; }   // main නැති වෙලාවේ playhead එක විතරයි
  t = Math.max(0, Math.min(t, total()));
  const { i, src } = tlToClip(t);
  cur = i; video.currentTime = src; head = t;
  if (playing) audioStart();
  touchUi();
}

function play() {
  if (!clips.length) { if (pid) toast('There is no main item — use "🔁 Replace main" to add a video / image'); return; }
  if (head >= total() - 0.05) seek(0);
  video.play(); playing = true; audioStart();
}
function pause() { video.pause(); playing = false; audioStop(); touchUi(); }
const toggle = () => playing ? pause() : play();

// ================= transitions (preview) =================
const TRFX = { flash: { fl: '#fff' }, black: { fl: '#000' }, zoom: { z: 1 }, zoomflash: { z: 1, fl: '#fff' }, shake: { sh: 1 } };
const trHalf = i => Math.min((clips[i].tr?.dur || 0.4) / 2, len(clips[i - 1]) / 2, len(clips[i]) / 2);

function allSfx() {   // user SFX + transition whoosh sounds
  const off = offsets(), out = [...sfx];
  for (let i = 1; i < clips.length; i++) {
    const t = clips[i].tr;
    if (t && t.type !== 'none' && t.snd) out.push({ asset: t.snd, t: Math.max(0, off[i] - trHalf(i)), vol: t.sv });
  }
  return out;
}

function applyFx() {
  let zi = 0, sh = 0, fv = 0, col = '#fff';
  const off = offsets();
  for (let i = 1; i < clips.length; i++) {
    const f = TRFX[clips[i].tr?.type]; if (!f) continue;
    const h = trHalf(i), d = Math.abs(head - off[i]); if (d >= h) continue;
    const lin = 1 - d / h, sq = lin * lin;
    if (f.z) zi = Math.max(zi, sq);
    if (f.sh) sh = Math.max(sh, sq);
    if (f.fl && lin > fv) { fv = lin; col = f.fl; }
  }
  const W = stage.clientWidth, H = stage.clientHeight, s = 1 + 0.5 * zi + 0.12 * sh;
  const dx = 0.03 * W * sh * Math.sin(head * 80), dy = 0.02 * H * sh * Math.sin(head * 97);
  const tf = s > 1 ? `translate(${dx}px,${dy}px) scale(${s})` : 'none';
  if (zw.style.transform !== tf) zw.style.transform = tf;
  fxEl.style.background = col; fxEl.style.opacity = fv;
}

const FULL = { x: 0, y: 0, w: 1, h: 1 };
let zmst = null;   // video preview transform (glitch preview canvas එකට)
const srcA = () => meta?.width && meta?.height ? meta.width / meta.height : 9 / 16;
function canvasAspect() {
  if (cropMode || canvas === 'orig') return srcA();      // crop edit කරනකොට මුළු frame එකම පෙන්නනවා
  if (canvas === 'auto') { const cr = clips[0]?.crop; return cr ? cr.w * srcA() / cr.h : srcA(); }
  const [a, b] = canvas.split(':').map(Number); return a / b;
}
function updateStage() {   // preview stage එක canvas ratio එකට (available space එකට fit)
  const box = $('#sw'), a = canvasAspect(), bw = box.clientWidth, bh = box.clientHeight;
  if (!bw || !bh) return;
  const w = Math.min(bw, bh * a), h = w / a;
  stage.style.width = w + 'px'; stage.style.height = h + 'px';
  renderText(); renderImgs(); renderShapes();
}
new ResizeObserver(updateStage).observe($('#sw'));   // layout / window වෙනස් වුනාම stage එක refit
// crop box + zoom එකෙන් සැබෑවටම පෙන්නන source region එක (backend එකේ crop → zoom crop ඒකම)
function effRect(c) {
  const cr = c.crop || FULL, z = c.zoom || 1, w = cr.w / z, h = cr.h / z;
  return { x: cr.x + (cr.w - w) * (c.zx ?? 0.5), y: cr.y + (cr.h - h) * (c.zy ?? 0.5), w, h };
}

// where the clip's visible region (crop+zoom) sits on the stage, in px: center + size. pos = user placed, else contain-fit
function placeOf(c, W, H) {
  const r = effRect(c), ar = r.w / r.h * srcA();
  if (c.pos) { const w = c.pos.w * W; return { cx: c.pos.x * W, cy: c.pos.y * H, w, h: w / ar }; }
  const w = Math.min(W, H * ar); return { cx: W / 2, cy: H / 2, w, h: w / ar };
}
const vbox = $('#vbox');
function placeVbox(c) {   // selection box (move / resize / crop handles) over the visible part of the video
  const W = stage.clientWidth, H = stage.clientHeight;
  if (cropMode || sel < 0 || sel !== cur || !c || !W || !H) { vbox.hidden = true; return; }
  const p = placeOf(c, W, H), x0 = Math.max(0, p.cx - p.w / 2), x1 = Math.min(W, p.cx + p.w / 2), y0 = Math.max(0, p.cy - p.h / 2), y1 = Math.min(H, p.cy + p.h / 2);
  vbox.hidden = x1 - x0 < 4 || y1 - y0 < 4;
  Object.assign(vbox.style, { left: x0 + 'px', top: y0 + 'px', width: (x1 - x0) + 'px', height: (y1 - y0) + 'px' });
}
function applyZoom(c) {
  const r = cropMode ? FULL : effRect(c), W = stage.clientWidth, H = stage.clientHeight, sa = srcA(), rad = cropMode ? 0 : +c.rad || 0;
  const pos = !cropMode && c.pos ? c.pos : null;
  const k = [r.x, r.y, r.w, r.h, W, H, sa, !cropMode && c.crop ? 1 : 0, rad, pos ? pos.x + ',' + pos.y + ',' + pos.w : '', sel, cur, cropMode ? 1 : 0].join('|');
  if (k === zkey) return;
  zkey = k;
  if (!W || !H) return;
  // video element = source frame, canvas එක ඇතුළේ contain (Vw×Vh)
  const Vw = Math.min(W, H * sa), Vh = Vw / sa;
  video.style.width = Vw + 'px'; video.style.height = Vh + 'px';
  // region = crop+zoom. pos නැත්නම් canvas එකට contain-fit (backend scale+pad), pos තිබ්බොත් user දාපු තැනට / size එකට
  const s = pos ? pos.w * W / (r.w * Vw) : Math.min(W / (r.w * Vw), H / (r.h * Vh));
  const tx = pos ? pos.x * W : W / 2, ty = pos ? pos.y * H : H / 2;
  const cx = (r.x + r.w / 2) * Vw, cy = (r.y + r.h / 2) * Vh;
  zmst = { s, cx, cy, Vw, Vh, r, W, H, tx, ty };
  video.style.transformOrigin = '0 0';
  video.style.transform = `translate(${tx}px,${ty}px) scale(${s}) translate(${-cx}px,${-cy}px)`;
  const R = rad * Math.min(r.w * Vw, r.h * Vh);   // corner radius (video element local px; transform scale එකෙන් screen size එකට සමානයි)
  video.style.clipPath = r.w > 0.999 && r.h > 0.999 && R < 0.5 ? 'none'
    : `inset(${r.y * 100}% ${Math.max(0, 1 - r.x - r.w) * 100}% ${Math.max(0, 1 - r.y - r.h) * 100}% ${r.x * 100}%${R >= 0.5 ? ` round ${R.toFixed(2)}px` : ''})`;
  placeVbox(c);
}

function tick() {
  if (clips.length) {
    const c = clips[cur];
    if (video.playbackRate !== sp(c)) video.playbackRate = sp(c);
    applyZoom(c);
    if (playing && video.currentTime >= c.end - 0.03 * sp(c)) {
      if (cur < clips.length - 1) {
        const n = clips[cur + 1];
        cur++;
        if (Math.abs(n.start - c.end) > 0.001) video.currentTime = n.start;
      } else { pause(); video.currentTime = c.end; }
    }
    const k = clips[cur];
    head = offsets()[cur] + Math.max(0, (video.currentTime - k.start) / sp(k));
    $('#head').style.left = head * pps + 'px';
    $('#time').textContent = `${fmt(head)} / ${fmt(total())}`;
    applyFx(); applyText(); applyImg(); applyShapes();
    try { applyVfx(); } catch (err) { console.warn('fx preview', err); }
  } else if (pid) {   // main නැත: playhead + overlays විතරක් update
    $('#head').style.left = head * pps + 'px';
    $('#time').textContent = `${fmt(head)} / ${fmt(total())}`;
    applyFx(); applyText(); applyImg(); applyShapes();
    try { applyVfx(); } catch {}
  }
  requestAnimationFrame(tick);
}

// ================= render =================
function syncInsp() {
  if (cropMode && sel !== cropIdx) exitCrop();
  const c = clips[sel], s = sfx.find(x => x.id === selSfx), m = selMusic && music, tx = curText(), fx = curFx(), im = curImg(), shp = curShape();
  $('#insp').hidden = !(c || s || m || tx || fx || im || shp);
  $('#i-shape').hidden = !shp; if (shp) syncShape(shp);
  $('#i-text').hidden = !tx; if (tx) syncText(tx);
  $('#i-fx').hidden = !fx; if (fx) syncFx(fx);
  $('#i-img').hidden = !im; if (im) syncImg(im);
  $('#idleh').hidden = !c || cropMode;
  $('#i-clip').hidden = !c; $('#i-sfx').hidden = !s; $('#i-music').hidden = !m;
  if (c) {
    $('#speed').value = spToSl(sp(c)); $('#speedv').textContent = +(+sp(c)).toFixed(2) + 'x'; $('#smooth').checked = !!c.smooth; $('#smoothrow').hidden = sp(c) >= 0.99;
    if (document.activeElement !== $('#cdur')) $('#cdur').value = len(c).toFixed(2);
    $('#czoom').value = c.zoom; $('#czoomv').textContent = (+c.zoom).toFixed(2) + 'x';
    $('#zx').value = c.zx; $('#zy').value = c.zy;
    const cr = Math.round((c.rad || 0) * 100); $('#crad').value = cr; $('#cradv').textContent = cr + '%';
    $('#croprm').hidden = !c.crop;
    syncPlace(c);
    const first = sel === 0, tr = c.tr || TRDEF;
    $('#trtype').value = tr.type;
    $('#trdur').value = tr.dur; $('#trdurv').textContent = (+tr.dur).toFixed(2) + 's';
    $('#trvol').value = tr.sv;
    $('#trsnd').innerHTML = '<option value="">No sound</option>' +
      assets.filter(a => a.kind === 'sfx').map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
    $('#trsnd').value = tr.snd || '';
    ['#trtype', '#trdur', '#trsnd', '#trvol'].forEach(id => $(id).disabled = first);
    $('#trnote').textContent = first ? '(The first clip has no transition)' : '';
  }
  if (s) {
    $('#sname').textContent = asset(s.asset)?.name || 'missing';
    $('#svol').value = s.vol; $('#svolv').textContent = (+s.vol).toFixed(2);
    $('#stime').value = (+s.t).toFixed(2);
  }
  if (m) {
    $('#mname').textContent = asset(music.asset)?.name || 'missing';
    $('#mvol').value = music.vol; $('#mvolv').textContent = (+music.vol).toFixed(2);
    $('#mfade').value = music.fade; $('#mfadev').textContent = music.fade + 's';
  }
}

function render() {
  updateStage(); $('#canvas').value = canvas; stage.style.background = canvasBg; $('#cbg').value = canvasBg;
  normZ();   // layer order (z) → 0..n-1
  track.querySelectorAll('.clip,.sfx,.music,.tmark,.txi,.fxi,.imi,.shi,.mainph').forEach(e => e.remove());
  video.style.visibility = clips.length ? '' : 'hidden'; video.muted = mute; syncMainBtns();
  const off = offsets(), T = total();
  const add = (cls, css, text) => {
    const d = document.createElement('div');
    d.className = cls; Object.assign(d.style, css); d.textContent = text;
    track.appendChild(d); return d;
  };
  clips.forEach((c, i) => add('clip' + (i === sel ? ' sel' : ''),
    { left: off[i] * pps + 'px', width: len(c) * pps + 'px' },
    `${fmt(c.start)}→${fmt(c.end)}` + (sp(c) !== 1 ? ` · ${sp(c)}x` : '') + (c.zoom > 1 ? ` · 🔍${(+c.zoom).toFixed(1)}` : '') + (c.crop ? ' · ✂crop' : '') + (c.rad > 0 ? ' · ◜round' : '')));
  if (!clips.length && pid) {   // main track එක හිස්: නව main video / image එකක් දාන්න placeholder
    const ph = add('mainph', { width: Math.max(260, T * pps - 8) + 'px' }, '＋ Add a main video / image (click)');
    ph.title = 'No main item — all other items are kept. They stay as they are when you add a new video / image.';
  }
  clips.forEach((c, i) => {
    if (!i) return;
    const on = c.tr && c.tr.type !== 'none';
    const m = add('tmark' + (on ? ' on' : ''), { left: off[i] * pps - 10 + 'px' }, on ? '⚡' : '+');
    m.dataset.i = i; m.title = 'Transition';
  });
  sfx.forEach(s => {
    const a = asset(s.asset);
    add('sfx' + (s.id === selSfx ? ' sel' : ''),
      { left: s.t * pps + 'px', width: Math.max(24, (a?.duration || 1) * pps) + 'px' },
      '🔊 ' + (a?.name || 'missing')).dataset.id = s.id;
  });
  if (music) add('music' + (selMusic ? ' sel' : ''), { left: '0px', width: T * pps + 'px' },
    '🎵 ' + (asset(music.asset)?.name || 'missing'));
  const rowsEnd = [];   // text items: overlap වෙනවා නම් වෙනම row වලට
  [...texts].sort((a, b) => a.start - b.start).forEach(t => {
    let rw = rowsEnd.findIndex(e => e <= t.start + 1e-6); if (rw < 0) { rw = rowsEnd.length; rowsEnd.push(0); }
    rowsEnd[rw] = t.start + t.dur;
    add('txi' + (t.id === selText ? ' sel' : ''), { left: t.start * pps + 'px', width: Math.max(18, t.dur * pps) + 'px', top: 144 + rw * 32 + 'px' },
      (isScr(t) ? (scrV(t) ? (scrV(t) < 0 ? 'T ⇡ ' : 'T ⇣ ') : scrDir(t) < 0 ? 'T ⇠ ' : 'T ⇢ ') : 'T  ') + (t.text.split('\n')[0] || '(empty)')).dataset.id = t.id;
  });
  const nr = Math.max(1, rowsEnd.length);
  $('#txlane').style.height = nr * 32 + 2 + 'px';
  const imTop = 148 + nr * 32, imRows = [];   // Image lane: text rows වලට යටින්
  [...imgs].sort((a, b) => a.start - b.start).forEach(t => {
    let rw = imRows.findIndex(e => e <= t.start + 1e-6); if (rw < 0) { rw = imRows.length; imRows.push(0); }
    imRows[rw] = t.start + t.dur;
    add('imi' + (t.id === selImg ? ' sel' : ''), { left: t.start * pps + 'px', width: Math.max(18, t.dur * pps) + 'px', top: imTop + rw * 32 + 'px' },
      (t.emoji ? '' : asset(t.asset)?.vid ? '🎬 ' : '🖼 ') + (isScr(t) ? (scrV(t) ? (scrV(t) < 0 ? '⇡ ' : '⇣ ') : scrDir(t) < 0 ? '⇠ ' : '⇢ ') : '') + imLabel(t) + ' · ' + Math.round(t.op * 100) + '%').dataset.id = t.id;
  });
  const ni = Math.max(1, imRows.length);
  $('#imlane').style.top = imTop - 2 + 'px'; $('#imlane').style.height = ni * 32 + 2 + 'px';
  const shTop = imTop + ni * 32 + 4, shRows = [];   // Shape lane: image rows වලට යටින්
  [...shapes].sort((a, b) => a.start - b.start).forEach(t => {
    let rw = shRows.findIndex(e => e <= t.start + 1e-6); if (rw < 0) { rw = shRows.length; shRows.push(0); }
    shRows[rw] = t.start + t.dur;
    add('shi' + (t.id === selShape ? ' sel' : ''), { left: t.start * pps + 'px', width: Math.max(18, t.dur * pps) + 'px', top: shTop + rw * 32 + 'px' },
      '◆ ' + (SHAPES[t.type] || t.type) + ' · ' + Math.round(t.op * 100) + '%').dataset.id = t.id;
  });
  const nsh = Math.max(1, shRows.length);
  $('#shlane').style.top = shTop - 2 + 'px'; $('#shlane').style.height = nsh * 32 + 2 + 'px';
  const fxTop = shTop + nsh * 32 + 4, fxRows = [];   // FX lane: shape rows වලට යටින්
  [...fxs].sort((a, b) => a.start - b.start).forEach(f => {
    let rw = fxRows.findIndex(e => e <= f.start + 1e-6); if (rw < 0) { rw = fxRows.length; fxRows.push(0); }
    fxRows[rw] = f.start + f.dur;
    add('fxi fx-' + f.type + (f.id === selFx ? ' sel' : ''),
      { left: f.start * pps + 'px', width: Math.max(18, f.dur * pps) + 'px', top: fxTop + rw * 32 + 'px' },
      (FXN[f.type] || f.type) + ' · ' + Math.round(f.amt * 100) + '%').dataset.id = f.id;
  });
  const nf = Math.max(1, fxRows.length);
  $('#fxlane').style.top = fxTop - 2 + 'px'; $('#fxlane').style.height = nf * 32 + 2 + 'px';
  track.style.height = fxTop + nf * 32 + 4 + 'px'; tl.style.height = 'auto';   // උස track එකෙන් (scrollbar එකත් එක්ක) → උඩ/පහළ scroll නෑ
  const end = Math.max(T, ...sfx.map(s => s.t + (asset(s.asset)?.duration || 1)), ...texts.map(t => t.start + t.dur), ...imgs.map(t => t.start + t.dur), ...shapes.map(t => t.start + t.dur), ...fxs.map(f => f.start + f.dur));
  track.style.width = Math.max(end * pps + 80, tl.clientWidth) + 'px';
  syncInsp(); renderText(); renderImgs(); renderShapes(); renderLayers();
}

// ================= state / undo / save =================
const state = () => JSON.stringify({ clips, sfx, music, canvas, bg: canvasBg, texts, fxs, imgs, shapes, linked, mute });
function setState(s) { const o = JSON.parse(s); clips = o.clips; sfx = o.sfx; music = o.music; canvas = o.canvas || 'auto'; canvasBg = o.bg || '#000000'; texts = o.texts || []; fxs = o.fxs || []; imgs = o.imgs || []; shapes = o.shapes || []; linked = o.linked !== false; mute = !!o.mute; }
function snap(label = 'Edit') { undo.push({ s: state(), label }); redo = []; if (undo.length > 100) undo.shift(); updUndoUi(); }
let toastT = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400);
}
function updUndoUi() {
  const u = undo[undo.length - 1], r = redo[redo.length - 1];
  $('#undo').title = u ? 'Undo: ' + u.label + ' (Ctrl+Z)' : 'Nothing to undo';
  $('#redo').title = r ? 'Redo: ' + r.label + ' (Ctrl+Y)' : 'Nothing to redo';
  $('#undo').disabled = !u; $('#redo').disabled = !r;
}
function touch() { dirty = true; clearTimeout(saveT); saveT = setTimeout(save, 600); }
function changed() { render(); touch(); }
function save() {   // edit (clips/sfx/music/canvas) -> edit.json. keepalive: tab එක close කළත් request එක යනවා
  clearTimeout(saveT);
  if (!pid || !dirty) return;
  dirty = false;
  fetch(`/api/projects/${pid}/edit`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    body: JSON.stringify({ clips, sfx, music, canvas, bg: canvasBg, texts, fxs, imgs, shapes, linked, mute, noMain: !clips.length }) });
}
function saveUi() {   // playhead / timeline zoom / export settings -> ui.json ("last edited" වෙලාව වෙනස් කරන්නේ නෑ)
  clearTimeout(uiT);
  if (!pid) return;
  fetch(`/api/projects/${pid}/ui`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    body: JSON.stringify({ head: +head.toFixed(2), pps, res: $('#xres').value, preset: $('#xpreset').value }) });
}
function touchUi() { clearTimeout(uiT); uiT = setTimeout(saveUi, 800); }
function flush() { save(); saveUi(); }   // tab close / background / project switch
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
function undoRedo(from, to, verb) {
  if (!from.length) { toast(`Nothing to ${verb.toLowerCase()}`); return; }
  const e = from.pop();
  to.push({ s: state(), label: e.label });
  setState(e.s); clearSel(); changed(); seek(Math.min(head, total()));
  toast(`${verb === 'Undo' ? '↶ Undo' : '↷ Redo'}: ${e.label}`); updUndoUi();
}

// ================= edit actions =================
function split() {
  if (!clips.length) return;
  const { i, src } = tlToClip(head), c = clips[i];
  if (src - c.start < 0.05 || c.end - src < 0.05) return;
  snap('Split clip');
  clips.splice(i, 1, { ...c, end: src }, { ...c, start: src, tr: { ...TRDEF } });
  clearSel(); changed();
}
function del() {
  if (sel < 0) return;
  if (clips.length < 2) {   // අන්තිම main item එක: Unlink කරලා නම් විතරයි delete කරන්න පුළුවන් (ඉතිරි items delete වෙන්නේ නෑ)
    if (linked) { toast('🔗 Linked — click the "Linked" button to unlink before deleting the main item'); return; }
    if (playing) pause();
    snap('Delete main'); const keep = head;
    clips = []; clearSel(); zkey = ''; changed(); seek(Math.min(keep, total()));
    toast('Main item deleted · other items (text / image / FX / SFX / music) are kept — use "🔁 Replace main" to add a new one');
    return;
  }
  snap('Delete clip');
  const keep = head;
  clips.splice(sel, 1); clearSel();
  changed(); seek(Math.min(keep, total()));
}
function delSfx() {
  if (!selSfx) return;
  snap('Delete SFX'); sfx = sfx.filter(x => x.id !== selSfx); selSfx = null; changed();
}
function addAsset(a) {
  if (!pid) { setStatus('Upload a video first'); return; }
  snap(a.kind === 'sfx' ? 'Add SFX' : 'Set music'); clearSel();
  if (a.kind === 'sfx') {
    const s = { id: uid(), asset: a.id, t: +head.toFixed(2), vol: 1 };
    sfx.push(s); selSfx = s.id;
  } else { music = { asset: a.id, vol: 0.3, fade: 1.5 }; selMusic = true; }
  loadBuf(a.id); changed();
}

// ================= magnetic snap (timeline) =================
// snap points: 0, video end, clip boundaries, playhead, වෙන text/FX/SFX වල කොන්. Alt = temporarily off
const snapLine = document.createElement('div'); snapLine.id = 'snapline'; snapLine.hidden = true; track.appendChild(snapLine);
const showSnapLine = v => { snapLine.hidden = false; snapLine.style.left = v * pps + 'px'; };
const hideSnapLine = () => { snapLine.hidden = true; };
function tlPoints(o = {}, exceptId = null, exceptGrp = '') {
  const pts = [0, total()], off = offsets();
  off.forEach((x, i) => { pts.push(x, x + len(clips[i])); });
  if (o.head !== false) pts.push(head);
  texts.forEach(x => { if (x.id !== exceptId) pts.push(x.start, x.start + x.dur); });
  fxs.forEach(x => { if (x.id !== exceptId) pts.push(x.start, x.start + x.dur); });
  imgs.forEach(x => { if (x.id !== exceptId && !(exceptGrp && x.grp === exceptGrp)) pts.push(x.start, x.start + x.dur); });
  shapes.forEach(x => { if (x.id !== exceptId) pts.push(x.start, x.start + x.dur); });
  sfx.forEach(x => { if (x.id !== exceptId) pts.push(x.t, x.t + (asset(x.asset)?.duration || 0)); });
  return pts;
}
function tlNear(x, pts, tol) {
  let best = null;
  for (const p of pts) { const d = p - x; if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d) - 0.01)) best = { d, v: p }; }   // near-tie: මුලින්ම ඇති point එක (video end / clip boundary) දිනනවා
  return best;
}
function snapSeek(t, ev, quiet) {   // playhead seek / click -> ළඟම snap point එකට
  if (!snapOn || (ev && ev.altKey)) { hideSnapLine(); return t; }
  const n = tlNear(t, tlPoints({ head: false }), 9 / pps);
  if (n) { if (!quiet) showSnapLine(n.v); return n.v; }
  hideSnapLine(); return t;
}

// ================= timeline interaction =================
track.addEventListener('pointerdown', e => {
  const el = e.target.closest('.sfx,.music'); if (!el) return;
  swallow = true; setTimeout(() => swallow = false, 300);
  if (el.classList.contains('music')) { clearSel(); selMusic = true; render(); return; }
  const s = sfx.find(x => x.id === el.dataset.id); if (!s) return;
  clearSel(); selSfx = s.id;
  const x0 = e.clientX, t0 = s.t; let moved = false;
  const pts = tlPoints({}, s.id), sdur = asset(s.asset)?.duration || 0;
  el.setPointerCapture?.(e.pointerId);
  const mv = ev => {
    const dx = ev.clientX - x0;
    if (!moved && Math.abs(dx) < 3) return;
    if (!moved) { snap('Move SFX'); moved = true; }
    let nt = Math.max(0, t0 + dx / pps), hit = null;
    if (snapOn && !ev.altKey) {
      const a = tlNear(nt, pts, 9 / pps), b = sdur ? tlNear(nt + sdur, pts, 9 / pps) : null;
      const c = a && (!b || Math.abs(a.d) <= Math.abs(b.d)) ? a : b;
      if (c) { nt = Math.max(0, nt + c.d); hit = c; }
    }
    s.t = hit ? nt : +nt.toFixed(2);
    hit ? showSnapLine(hit.v) : hideSnapLine();
    el.style.left = s.t * pps + 'px'; syncInsp();
  };
  const up = () => {
    el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up);
    hideSnapLine();
    if (moved) changed(); else render();
  };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
});

// ----- playhead drag (seek bar එක mouse එකෙන් ඇදගෙන යන්න) -----
const nearHead = x => Math.abs(x - head * pps) <= 6;
track.addEventListener('pointerdown', e => {
  if (e.button || !pid) return;
  if (!nearHead(e.clientX - track.getBoundingClientRect().left)) return;
  e.stopImmediatePropagation(); e.preventDefault();
  swallow = true;
  if (playing) pause();
  track.setPointerCapture?.(e.pointerId);
  const go = ev => seek(snapSeek((ev.clientX - track.getBoundingClientRect().left) / pps, ev));
  const up = () => {
    track.removeEventListener('pointermove', go); track.removeEventListener('pointerup', up); track.removeEventListener('pointercancel', up);
    hideSnapLine(); setTimeout(() => swallow = false, 300);
  };
  track.addEventListener('pointermove', go); track.addEventListener('pointerup', up); track.addEventListener('pointercancel', up);
  go(e);
}, true);
track.addEventListener('pointermove', e => track.classList.toggle('nearhead', nearHead(e.clientX - track.getBoundingClientRect().left)));

// ----- clip drag → reorder -----
track.addEventListener('pointerdown', e => {
  const el = e.target.closest('.clip'); if (!el || e.button) return;
  const idx = [...track.querySelectorAll('.clip')].indexOf(el);
  // clip එකේ දකුණු කොන ඇදලා දිග අඩු/වැඩි කරන්න (image project එකක නම් මුළු දිග 600s දක්වා)
  const rc0 = el.getBoundingClientRect();
  if (e.clientX > rc0.right - 10 && clips[idx]) {
    const c = clips[idx], e0 = c.end, x1 = e.clientX, maxEnd = meta?.duration || e0;
    let did = false;
    el.setPointerCapture?.(e.pointerId);
    const mv2 = ev => {
      if (!did && Math.abs(ev.clientX - x1) < 3) return;
      if (!did) { snap('Clip duration'); did = true; if (playing) pause(); }
      const ne = e0 + ((ev.clientX - x1) / pps) * sp(c);
      c.end = +Math.min(maxEnd, Math.max(c.start + 0.2 * sp(c), ne)).toFixed(2);
      el.style.width = len(c) * pps + 'px';
    };
    const up2 = () => {
      el.removeEventListener('pointermove', mv2); el.removeEventListener('pointerup', up2); el.removeEventListener('pointercancel', up2);
      swallow = true; setTimeout(() => swallow = false, 300);
      if (did) { sel = idx; changed(); } else { render(); }
    };
    el.addEventListener('pointermove', mv2); el.addEventListener('pointerup', up2); el.addEventListener('pointercancel', up2);
    e.preventDefault(); return;
  }
  const x0 = e.clientX, base = offsets()[idx], dl = $('#dropline');
  let moved = false, to = idx;
  el.setPointerCapture?.(e.pointerId);
  const mv = ev => {
    const dx = ev.clientX - x0;
    if (!moved && Math.abs(dx) < 5) return;
    if (!moved) { moved = true; if (playing) pause(); el.classList.add('drag'); }
    el.style.left = Math.max(0, base * pps + dx) + 'px';
    // ඉතිරි clips වල slot (boundary) වලින්, ඇදගෙන යන clip එකේ center එකට ළඟම slot එක තෝරනවා
    const others = clips.map((_, i) => i).filter(i => i !== idx);
    const W = len(clips[idx]) * pps, center = base * pps + dx + W / 2;
    let acc = 0, best = Infinity, bestPos = 0; to = 0;
    for (let k = 0; k <= others.length; k++) {
      const dist = Math.abs(center - (acc + W / 2));
      if (dist < best) { best = dist; to = k; bestPos = acc; }
      if (k < others.length) acc += len(clips[others[k]]) * pps;
    }
    dl.hidden = false; dl.style.left = bestPos - 1 + 'px';
  };
  const up = () => {
    el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up);
    dl.hidden = true;
    if (!moved) return;                       // සාමාන්‍ය click එක පහළ handler එකෙන්
    swallow = true; setTimeout(() => swallow = false, 300);
    if (to === idx) { render(); return; }
    snap('Move clip');
    const [c] = clips.splice(idx, 1); clips.splice(to, 0, c);
    clearSel(); sel = to; changed(); seek(offsets()[to]);
  };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
});

track.addEventListener('click', e => {
  if (swallow) return;
  if (e.target.closest('.mainph')) { $('#replfile').click(); return; }
  const tm = e.target.closest('.tmark');
  if (tm) { clearSel(); sel = +tm.dataset.i; seek(offsets()[sel]); render(); return; }
  const t = snapSeek((e.clientX - track.getBoundingClientRect().left) / pps, e, true);
  clearSel();
  const ce = e.target.closest('.clip');
  if (ce) sel = [...track.querySelectorAll('.clip')].indexOf(ce);
  seek(t); render();
});


// ================= crop (border box: move / resize / ratio presets / free) =================
const cbox = $('#cbox'), MINB = 0.06;
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const aspStage = srcA;
const fitW = a => Math.min(1, a);                       // normalized ratio a (w/h) සහිත ලොකුම box එකේ width
function ratioOf(k) {
  if (k === 'free') return null;
  if (k === 'orig') return aspStage();
  const [a, b] = k.split(':').map(Number); return a / b;   // pixel ratio
}
function clampBox() {
  cb.w = clampN(cb.w, 0.02, 1); cb.h = clampN(cb.h, 0.02, 1);
  cb.x = clampN(cb.x, 0, 1 - cb.w); cb.y = clampN(cb.y, 0, 1 - cb.h);
}
function drawCrop(skipSlider) {
  clampBox();
  Object.assign(cbox.style, { left: cb.x * 100 + '%', top: cb.y * 100 + '%', width: cb.w * 100 + '%', height: cb.h * 100 + '%' });
  if (!skipSlider) $('#csize').value = Math.round(cb.w / fitW(cb.w / cb.h) * 100);
  const W = meta?.width || stage.clientWidth, H = meta?.height || stage.clientHeight;
  $('#cinfo').textContent = `${Math.round(cb.w * W)}×${Math.round(cb.h * H)} px`;
}
function setRatio(k) {
  document.querySelectorAll('#ratios button').forEach(b => b.classList.toggle('on', b.dataset.r === k));
  cratio = ratioOf(k);
  if (cratio) {   // box එක ratio එකට auto-fit (දැන් තියෙන center එකේම)
    const ar = cratio / aspStage(), cx = cb.x + cb.w / 2, cy = cb.y + cb.h / 2, w = fitW(ar), h = w / ar;
    cb = { x: clampN(cx - w / 2, 0, 1 - w), y: clampN(cy - h / 2, 0, 1 - h), w, h };
  }
  drawCrop();
}
function enterCrop() {
  if (sel < 0 || cropMode) return;
  if (playing) pause();
  cropMode = true; cropIdx = sel;
  cb = clips[sel].crop ? { ...clips[sel].crop } : { ...FULL };
  cratio = null;
  document.querySelectorAll('#ratios button').forEach(b => b.classList.toggle('on', b.dataset.r === 'free'));
  $('#call').checked = false;
  if (tlToClip(head).i !== sel) seek(offsets()[sel]);
  $('#cropov').hidden = false; $('#cropbar').hidden = false; $('#idleh').hidden = true; zkey = '';
  updateStage(); drawCrop();
}
function exitCrop() {
  cropMode = false; cropIdx = -1; zkey = '';
  $('#cropov').hidden = true; $('#cropbar').hidden = true; $('#idleh').hidden = sel < 0;
  updateStage();
}
function applyCrop() {
  if (!cropMode) return;
  clampBox();
  const full = cb.w > 0.999 && cb.h > 0.999, r4 = v => +v.toFixed(4);
  const val = full ? null : { x: r4(cb.x), y: r4(cb.y), w: r4(cb.w), h: r4(cb.h) };
  const idx = $('#call').checked ? clips.map((_, i) => i) : [cropIdx];
  snap(val ? 'Crop' : 'Remove crop');
  idx.forEach(i => clips[i].crop = val ? { ...val } : null);
  exitCrop(); changed();
  toast(val ? '✔ Crop applied' : 'Crop removed');
}
// ratio-locked / free resize (px නෙවෙයි, 0..1 stage coords)
function resizeBox(h, s, px, py) {
  const l = h.includes('l'), r = h.includes('r'), t = h.includes('t'), b = h.includes('b');
  if (!cratio) {
    let L = s.x, R = s.x + s.w, T = s.y, B = s.y + s.h;
    if (l) L = Math.min(px, R - MINB); if (r) R = Math.max(px, L + MINB);
    if (t) T = Math.min(py, B - MINB); if (b) B = Math.max(py, T + MINB);
    cb = { x: L, y: T, w: R - L, h: B - T }; return;
  }
  const ar = cratio / aspStage();
  if ((l || r) && (t || b)) {          // corner: opposite corner එක anchor
    const ax = l ? s.x + s.w : s.x, ay = t ? s.y + s.h : s.y, sx = l ? -1 : 1, sy = t ? -1 : 1;
    let w = Math.max(Math.abs(px - ax), Math.abs(py - ay) * ar);
    w = Math.max(MINB, Math.min(w, sx > 0 ? 1 - ax : ax, (sy > 0 ? 1 - ay : ay) * ar));
    const hh = w / ar;
    cb = { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - hh, w, h: hh };
  } else if (l || r) {                 // left/right edge: vertical center එක රඳවගෙන
    const ax = l ? s.x + s.w : s.x, cy = s.y + s.h / 2;
    let w = Math.abs(px - ax);
    w = Math.max(MINB, Math.min(w, l ? ax : 1 - ax, 2 * Math.min(cy, 1 - cy) * ar));
    const hh = w / ar;
    cb = { x: l ? ax - w : ax, y: cy - hh / 2, w, h: hh };
  } else {                             // top/bottom edge
    const ay = t ? s.y + s.h : s.y, cx = s.x + s.w / 2;
    let hh = Math.abs(py - ay);
    hh = Math.max(MINB / ar, Math.min(hh, t ? ay : 1 - ay, 2 * Math.min(cx, 1 - cx) / ar));
    const w = hh * ar;
    cb = { x: cx - w / 2, y: t ? ay - hh : ay, w, h: hh };
  }
}
function startCropDrag(e, h) {
  const R = stage.getBoundingClientRect(), s = { ...cb };
  const X = ev => (ev.clientX - R.left) / R.width, Y = ev => (ev.clientY - R.top) / R.height;
  const x0 = X(e), y0 = Y(e);
  cbox.setPointerCapture?.(e.pointerId);
  const mv = ev => {
    if (h === 'move') { cb.x = clampN(s.x + X(ev) - x0, 0, 1 - s.w); cb.y = clampN(s.y + Y(ev) - y0, 0, 1 - s.h); }
    else resizeBox(h, s, clampN(X(ev), 0, 1), clampN(Y(ev), 0, 1));
    drawCrop();
  };
  const up = () => { cbox.removeEventListener('pointermove', mv); cbox.removeEventListener('pointerup', up); cbox.removeEventListener('pointercancel', up); };
  cbox.addEventListener('pointermove', mv); cbox.addEventListener('pointerup', up); cbox.addEventListener('pointercancel', up);
}
cbox.addEventListener('pointerdown', e => {
  if (!cropMode || e.button) return;
  e.preventDefault(); e.stopPropagation();
  startCropDrag(e, e.target.dataset.h || 'move');
});
// clip select කළාම: video box එකේ කොන් = resize (corner drag) · මැද handles = free crop · box එක ඇතුළෙන් ඇදලා move
$('#idleh').addEventListener('pointerdown', e => {
  const hd = e.target.closest('.ih');
  if (!hd || e.button || sel < 0) return;
  e.preventDefault(); e.stopPropagation();
  const h = hd.dataset.h;
  if (h.length === 2) { startPlaceResize(e, h, hd); return; }   // tl tr bl br
  enterCrop(); if (!cropMode) return;
  startCropDrag(e, h);
});
function setPos(c, W, H, p) {   // stage px -> normalized pos
  c.pos = { x: +(p.cx / W).toFixed(4), y: +(p.cy / H).toFixed(4), w: +(p.w / W).toFixed(4) };
}
function startPlaceResize(e, h, hd) {
  const c = clips[sel]; if (!c) return;
  const R = stage.getBoundingClientRect(), W = R.width, H = R.height, p = placeOf(c, W, H);
  const sx = h.includes('l') ? -1 : 1, sy = h.includes('t') ? -1 : 1;
  const fx = p.cx - sx * p.w / 2, fy = p.cy - sy * p.h / 2, vx = sx * p.w, vy = sy * p.h;   // fixed (opposite) corner + diagonal
  const proj = ev => (ev.clientX - R.left - fx) * vx + (ev.clientY - R.top - fy) * vy;
  const d0 = proj(e) || 1, ar = p.w / p.h;
  let moved = false;
  hd.setPointerCapture?.(e.pointerId);
  const mv = ev => {
    if (!moved) { if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) < 3) return; snap('Resize video'); moved = true; if (playing) pause(); }
    const w = clampN(p.w * proj(ev) / d0, 0.03 * W, 8 * W), hh = w / ar;
    setPos(c, W, H, { cx: fx + sx * w / 2, cy: fy + sy * hh / 2, w });
    zkey = ''; applyZoom(c); syncPlace(c); touch();
  };
  const up = () => { hd.removeEventListener('pointermove', mv); hd.removeEventListener('pointerup', up); hd.removeEventListener('pointercancel', up); if (moved) changed(); };
  hd.addEventListener('pointermove', mv); hd.addEventListener('pointerup', up); hd.addEventListener('pointercancel', up);
}
// video එක preview එකේ ඇදලා move (magnetic: canvas center / edges / grid)
stage.addEventListener('pointerdown', e => {
  if (cropMode || e.button || !clips.length || e.target.closest('.tx, .im, .sp, .hd, #cropov')) return;
  if (sel !== cur || sel < 0) { const i = tlToClip(head).i; clearSel(); sel = i; render(); }
  const c = clips[sel]; if (!c) return;
  e.preventDefault();
  const R = stage.getBoundingClientRect(), W = R.width, H = R.height, p = placeOf(c, W, H);
  let moved = false;
  stage.setPointerCapture?.(e.pointerId);
  const mv = ev => {
    const dx = ev.clientX - e.clientX, dy = ev.clientY - e.clientY;
    if (!moved) { if (Math.abs(dx) + Math.abs(dy) < 3) return; snap('Move video'); moved = true; if (playing) pause(); }
    let nx = clampN((p.cx + dx) / W, 0, 1), ny = clampN((p.cy + dy) / H, 0, 1), gv = null, gh = null;
    if (snapOn && !ev.altKey) {
      const vl = [{ v: 0.5, center: true }, { v: 0 }, { v: 1 }], hl = [{ v: 0.5, center: true }, { v: 0 }, { v: 1 }];
      if (gridOn) for (const v of [1 / 3, 2 / 3]) { vl.push({ v }); hl.push({ v }); }
      const a = snap1(nx, p.w / W / 2, vl, 7 / W), b = snap1(ny, p.h / H / 2, hl, 7 / H);
      nx = a.c; ny = b.c; gv = a.line; gh = b.line;
    }
    setPos(c, W, H, { cx: nx * W, cy: ny * H, w: p.w }); guides(gv, gh);
    zkey = ''; applyZoom(c); syncPlace(c); touch();
  };
  const up = () => { stage.removeEventListener('pointermove', mv); stage.removeEventListener('pointerup', up); stage.removeEventListener('pointercancel', up); guides(null, null); if (moved) changed(); };
  stage.addEventListener('pointermove', mv); stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
});
function scaleBox(f) {                 // zoom: box එක ratio රඳවගෙන ලොකු/පොඩි කරනවා
  const a = cb.w / cb.h, cx = cb.x + cb.w / 2, cy = cb.y + cb.h / 2;
  let w = clampN(cb.w * f, Math.max(MINB, MINB * a), fitW(a)), h = w / a;
  cb = { x: clampN(cx - w / 2, 0, 1 - w), y: clampN(cy - h / 2, 0, 1 - h), w, h };
  drawCrop();
}
$('#cropov').addEventListener('wheel', e => { if (cropMode) { e.preventDefault(); scaleBox(e.deltaY < 0 ? 0.95 : 1.05); } }, { passive: false });
$('#csize').oninput = e => {
  const a = cb.w / cb.h, cx = cb.x + cb.w / 2, cy = cb.y + cb.h / 2;
  const w = Math.max(MINB, MINB * a, fitW(a) * (+e.target.value / 100)), h = w / a;
  cb = { x: clampN(cx - w / 2, 0, 1 - w), y: clampN(cy - h / 2, 0, 1 - h), w, h };
  drawCrop(true);
};
$('#ratios').onclick = e => { const b = e.target.closest('button'); if (b && cropMode) { setRatio(b.dataset.r); b.blur(); } };
$('#cfull').onclick = e => { cb = { ...FULL }; setRatio(document.querySelector('#ratios .on')?.dataset.r || 'free'); e.target.blur(); };
$('#capply').onclick = applyCrop;
$('#ccancel').onclick = exitCrop;
$('#cropbtn').onclick = e => { enterCrop(); e.target.blur(); };
$('#croprm').onclick = () => { if (sel < 0) return; snap('Remove crop'); clips[sel].crop = null; changed(); };

// ================= video placement (move / resize on canvas) + canvas background =================
function syncPlace(c) {
  const W = stage.clientWidth, H = stage.clientHeight; if (!c || !W) return;
  const p = placeOf(c, W, H), sz = Math.round(p.w / W * 100);
  if (document.activeElement !== $('#psize')) $('#psize').value = clampN(sz, 5, 300);
  $('#psizev').textContent = sz + '%';
  $('#pfit').classList.toggle('on', !c.pos);
}
$('#psize').oninput = e => {
  const c = clips[sel]; if (!c) return;
  if (!gesture) { snap('Video size'); gesture = true; }
  const W = stage.clientWidth, H = stage.clientHeight, p = placeOf(c, W, H), w = +e.target.value / 100 * W;
  setPos(c, W, H, { cx: p.cx, cy: p.cy, w }); changed();
};
$('#psize').onchange = e => { gesture = false; e.target.blur(); };
$('#pfit').onclick = e => { const c = clips[sel]; if (!c) return; snap('Fit video'); c.pos = null; changed(); e.target.blur(); };
$('#pfill').onclick = e => {
  const c = clips[sel]; if (!c) return; snap('Fill canvas');
  const W = stage.clientWidth, H = stage.clientHeight, r = effRect(c), ar = r.w / r.h * srcA();
  setPos(c, W, H, { cx: W / 2, cy: H / 2, w: Math.max(W, H * ar) }); changed(); e.target.blur();
};
$('#pcenter').onclick = e => {
  const c = clips[sel]; if (!c) return; snap('Center video');
  const W = stage.clientWidth, H = stage.clientHeight, p = placeOf(c, W, H);
  setPos(c, W, H, { cx: W / 2, cy: H / 2, w: p.w }); changed(); e.target.blur();
};
$('#cbg').oninput = e => { if (!gesture) { snap('Canvas background'); gesture = true; } canvasBg = e.target.value; stage.style.background = canvasBg; touch(); };
$('#cbg').onchange = e => { gesture = false; changed(); e.target.blur(); };
document.querySelectorAll('#bgsw button').forEach(b => b.onclick = () => { snap('Canvas background'); canvasBg = b.dataset.c; changed(); });

// ================= inspector =================
function bind(id, obj, key, label) {
  const el = $(id);
  el.oninput = () => {
    const o = obj(); if (!o) return;
    if (!gesture) { snap(label); gesture = true; }
    o[key] = +el.value; changed();
  };
  el.onchange = () => { gesture = false; el.blur(); };
}
const curSfx = () => sfx.find(x => x.id === selSfx);
$('#cdur').onchange = e => {   // clip duration (තත්පර) type කරලා දෙන්න
  const c = clips[sel]; if (!c) return;
  snap('Clip duration');
  const want = Math.max(0.2, +e.target.value || 1);
  const lim = meta?.duration || (c.start + want * sp(c)), wantEnd = c.start + want * sp(c);
  c.end = +Math.min(lim, wantEnd).toFixed(2);
  if (wantEnd > lim + 0.01) toast(`The source is only ${lim.toFixed(1)}s long — it cannot be extended further`);
  changed();
};
$('#speed').oninput = e => { const c = clips[sel]; if (!c) return; snapT('Clip speed'); c.speed = slToSp(+e.target.value); changed(); };
$('#speed').onchange = e => e.target.blur();
$('#smooth').onchange = e => { const c = clips[sel]; if (!c) return; snap('Smooth slow-mo'); c.smooth = e.target.checked; changed(); };
bind('#czoom', () => clips[sel], 'zoom', 'Clip zoom');
bind('#zx', () => clips[sel], 'zx', 'Zoom X'); bind('#zy', () => clips[sel], 'zy', 'Zoom Y');
bind('#trdur', () => clips[sel]?.tr, 'dur', 'Transition duration'); bind('#trvol', () => clips[sel]?.tr, 'sv', 'Transition volume');
$('#trtype').onchange = e => { if (sel < 1) return; snap('Transition'); clips[sel].tr.type = e.target.value; changed(); e.target.blur(); };
$('#trsnd').onchange = e => {
  if (sel < 1) return;
  snap('Transition sound'); clips[sel].tr.snd = e.target.value || null;
  if (e.target.value) loadBuf(e.target.value);
  changed(); e.target.blur();
};
bind('#svol', curSfx, 'vol', 'SFX volume');
bind('#mvol', () => music, 'vol', 'Music volume'); bind('#mfade', () => music, 'fade', 'Music fade');
$('#stime').onchange = e => {
  const s = curSfx(); if (!s) return;
  snap('SFX time'); s.t = Math.max(0, +e.target.value || 0); changed();
};
document.querySelectorAll('[data-sp]').forEach(b => b.onclick = () => {
  if (sel < 0) return;
  snap('Clip speed'); clips[sel].speed = +b.dataset.sp; changed();
});
$('#crad').oninput = e => { const c = clips[sel]; if (!c) return; snapT('Corner radius'); c.rad = clampN(+e.target.value / 100, 0, 0.5); changed(); };
$('#crad').onchange = e => e.target.blur();
$('#cradall').onclick = e => { const c = clips[sel]; if (!c) return; snap('Corner radius (all clips)'); clips.forEach(x => x.rad = c.rad || 0); changed(); e.target.blur(); };
$('#zreset').onclick = () => {
  if (sel < 0) return;
  snap('Remove zoom'); Object.assign(clips[sel], { zoom: 1, zx: 0.5, zy: 0.5 }); changed();
};
$('#sdel').onclick = delSfx;
$('#mdel').onclick = () => { snap('Remove music'); music = null; selMusic = false; changed(); };

$('#play').onclick = toggle; $('#split').onclick = split;
$('#del').onclick = () => selFx ? delFx() : selImg ? delImg() : selShape ? delShape() : selText ? delText() : selSfx ? delSfx() : del();
$('#undo').onclick = () => undoRedo(undo, redo, 'Undo'); $('#redo').onclick = () => undoRedo(redo, undo, 'Redo');
$('#canvas').onchange = e => { snap('Canvas ratio'); canvas = e.target.value; zkey = ''; changed(); e.target.blur(); };
$('#tzoom').oninput = e => { pps = +e.target.value; render(); touchUi(); };
$('#xres').onchange = touchUi; $('#xpreset').onchange = touchUi;

function nudge(e) {   // arrow keys = move the selected overlay by 0.5% (Shift = 2%)
  const o = selItem(); if (!o) return false;
  const st = e.shiftKey ? 0.02 : 0.005, dx = e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, dy = e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
  snapT('Nudge'); (o.grp ? grpList(o) : [o]).forEach(m => { m.x = +(m.x + dx).toFixed(5); m.y = +(m.y + dy).toFixed(5); }); changed(); return true;
}
addEventListener('keydown', e => {
  if (!pid || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (cropMode) {                      // crop edit කරන වෙලාවේ වෙන shortcuts නෑ
    const st = e.shiftKey ? 0.02 : 0.005;
    if (e.key === 'Enter') { e.preventDefault(); applyCrop(); }
    else if (e.key === 'Escape') exitCrop();
    else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      cb.x += e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0;
      cb.y += e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
      drawCrop();
    }
    if (e.code !== 'Space') return;
  }
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.key.startsWith('Arrow') && !e.ctrlKey && !e.altKey && !e.metaKey && nudge(e)) e.preventDefault();
  else if (e.key === 's' || e.key === 'S') split();
  else if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey) enterCrop();
  else if (e.key === 'Delete' || e.key === 'Backspace') selFx ? delFx() : selImg ? delImg() : selShape ? delShape() : selText ? delText() : selSfx ? delSfx() : del();
  else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoRedo(redo, undo, 'Redo'); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoRedo(undo, redo, 'Undo'); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); undoRedo(redo, undo, 'Redo'); }
});

// ================= timeline: වමට / දකුණට scroll විතරයි (උඩ / පහළ නෑ) =================
tl.addEventListener('wheel', e => {   // wheel: lanes උඩ/පහළ overflow නම් → උඩ/පහළ scroll; නැත්නම් / Shift ඔබා ඇත්නම් → වමට/දකුණට
  if (e.ctrlKey) return;
  const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
  const canV = tl.scrollHeight > tl.clientHeight + 1;
  if (canV && !e.shiftKey && !horiz) {   // native vertical scroll (flicker නෑ)
    const atTop = tl.scrollTop <= 0 && e.deltaY < 0, atBot = tl.scrollTop + tl.clientHeight >= tl.scrollHeight - 1 && e.deltaY > 0;
    if (!atTop && !atBot) return;        // browser එකම scroll කරයි
  }
  e.preventDefault();
  tl.scrollLeft += horiz ? e.deltaX : e.deltaY;
}, { passive: false });

// ================= main item: link / unlink · mute · extract audio · replace =================
const errText = t => { try { return JSON.parse(t).detail || t; } catch { return String(t).slice(0, 120); } };
function syncMainBtns() {
  const lb = $('#linkbtn'), mb = $('#mutebtn'), eb = $('#extractbtn'), ha = meta?.has_audio !== false;
  lb.classList.toggle('on', linked); lb.textContent = linked ? '🔗 Linked' : '🔓 Unlinked';
  mb.classList.toggle('on', mute); mb.textContent = mute ? '🔇 Main muted' : '🔊 Main sound';
  mb.disabled = !pid; $('#replbtn').style.opacity = pid ? 1 : .5;
  eb.disabled = !pid || !ha; eb.title = ha ? 'Extract the main video audio into the Music library' : 'This main item has no audio';
}
$('#linkbtn').onclick = e => {
  if (!pid) return;
  snap(linked ? 'Unlink' : 'Link'); linked = !linked; changed();
  toast(linked ? '🔗 Linked — the main item cannot be deleted' : '🔓 Unlinked — the main item can be deleted · other items are not deleted');
  e.target.blur();
};
$('#mutebtn').onclick = e => {
  if (!pid) return;
  snap(mute ? 'Unmute main' : 'Mute main'); mute = !mute; changed();
  if (mute && meta?.has_audio === false) toast('This main item has no audio');
  e.target.blur();
};
$('#extractbtn').onclick = async e => {
  e.target.blur(); if (!pid) return;
  toast('Extracting audio…');
  let r; try { r = await fetch(`/api/projects/${pid}/extract-audio`, { method: 'POST' }); } catch { toast('Server error'); return; }
  if (!r.ok) { toast('Extract error: ' + errText(await r.text())); return; }
  const a = await r.json(); await loadAssets();
  if (!music && asset(a.id)) { addAsset(asset(a.id)); toast('🎵 Audio extracted — added to the Music track (and saved in the library)'); }
  else toast('🎵 Audio extracted: ' + a.name + ' — press ＋ in the Music library to use it as music');
};
$('#replfile').onchange = e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !pid) return;
  if (playing) pause();
  const id = pid, tok = openTok, oldT = total(), keep = head, prevName = meta?.name || '';
  const fd = new FormData(); fd.append('file', f);
  const x = new XMLHttpRequest();
  x.open('POST', `/api/projects/${id}/replace`);
  x.upload.onprogress = p => setStatus(`Main upload ${Math.round(p.loaded / p.total * 100)}%`);
  x.onerror = () => { setStatus(prevName); toast('Upload error'); };
  x.onload = async () => {
    if (tok !== openTok) return;
    if (x.status !== 200) { setStatus(prevName); toast('Replace error: ' + errText(x.responseText)); return; }
    let m = JSON.parse(x.responseText);
    while (m.status === 'processing') {   // proxy එක හදනකල් බලාගෙන
      setStatus('Preparing proxy…'); await sleep(1500);
      if (tok !== openTok) return;
      const r = await fetch(`/api/projects/${id}`); if (!r.ok) return;
      m = await r.json();
    }
    if (tok !== openTok) return;
    if (m.status === 'error') { setStatus(prevName); toast('Proxy error — is ffmpeg installed?'); return; }
    meta = m; setStatus(m.name);
    // අලුත් main = මුළු video එක (image එකක් නම් කලින් timeline එකේ දිගටම) · ඉතිරි items (text / image / FX / SFX / music) එහෙමම
    const L = m.is_image ? Math.min(m.duration || 300, Math.max(oldT, m.default_len || 5)) : (m.duration || 5);
    exitCrop(); undo = []; redo = []; updUndoUi();   // පරණ source එකට අදාළ undo history වලංගු නෑ
    clips = [norm({ start: 0, end: +L.toFixed(2) })]; clearSel(); cur = 0; zkey = '';
    video.src = `/api/projects/${id}/proxy.mp4?v=${Date.now()}`;
    video.onloadedmetadata = () => { render(); seek(Math.min(keep, total())); };
    dirty = true; save(); render();
    toast('✔ Main item replaced — all other items are kept');
  };
  x.send(fd);
};

// ================= asset library =================
async function loadAssets() {
  try { assets = await (await fetch('/api/assets')).json(); } catch { return; }
  const mk = kind => assets.filter(a => a.kind === kind).map(a =>
    `<div class="asset" data-id="${a.id}">${kind === 'image' ? `<img class="ath" src="/api/assets/${a.id}/${a.vid ? 'thumb' : 'file'}" alt="">${a.vid ? '<span class="vbadge" title="Video">🎬</span>' : ''}` : ''}<span class="an" title="${esc(a.name)}">${esc(a.name)}</span>` +
    `<button data-act="add" title="Add">＋</button>${kind === 'image' ? '<button data-act="addscr" title="Scrolling logo / image / video (moves left)">⇠</button>' : ''}<button data-act="del" title="Delete">✕</button></div>`).join('') || '<i class="hint">—</i>';
  $('#lib-sfx').innerHTML = mk('sfx'); $('#lib-music').innerHTML = mk('music'); $('#lib-img').innerHTML = mk('image');
  render(); preloadAudio();
}

$('#lib').addEventListener('click', async e => {
  const row = e.target.closest('.asset'); if (!row) return;
  const a = asset(row.dataset.id), act = e.target.dataset.act;
  if (!a) return;
  if (act === 'del') {
    if (!confirm(`Delete "${a.name}" from the library?`)) return;
    await fetch(`/api/assets/${a.id}`, { method: 'DELETE' }); loadAssets();
  } else if (act === 'add') a.kind === 'image' ? addImg(a) : addAsset(a);
  else if (act === 'addscr' && a.kind === 'image') addImg(a, true);
  else if (e.target.classList.contains('an') && a.kind !== 'image') previewAsset(a);
});

async function uploadAssets(e, kind) {
  const files = [...e.target.files]; e.target.value = '';
  for (const f of files) {
    setStatus('Upload ' + f.name);
    const fd = new FormData(); fd.append('file', f); fd.append('kind', kind);
    const r = await fetch('/api/assets', { method: 'POST', body: fd });
    if (!r.ok) {
      const msg = (await r.text()).slice(0, 100); setStatus('Upload error: ' + msg);
      toast(kind === 'image' && /audio file/.test(msg) ? 'The server is outdated: replace backend/main.py and restart it' : 'Upload error: ' + msg);
      return;
    }
    if (kind === 'image') toast((/\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(f.name) ? 'Video' : 'Image') + ' added ✔ (press ＋ to put it on the timeline)');
  }
  setStatus(meta?.name || ''); loadAssets();
}
$('#up-sfx').onchange = e => uploadAssets(e, 'sfx');
$('#up-music').onchange = e => uploadAssets(e, 'music');
$('#up-img').onchange = e => uploadAssets(e, 'image');

// ================= export =================
$('#export').onclick = async () => {
  if (!pid) return;
  if (!clips.length) { toast('No main video / image — add one before exporting'); return; }
  clearTimeout(saveT);
  $('#dl').hidden = true;
  const renders = [];
  if (texts.some(t => t.text.trim())) {
    $('#export').disabled = true; $('#xstat').textContent = 'Rendering text…';
    const W = outWidth();
    for (const t of texts) {
      if (!t.text.trim()) continue;
      const rr = await renderTextPng(t, W);
      renders.push({ id: t.id, png: rr.png, wf: rr.wf, x: t.x, y: t.y, op: t.op ?? 1, scr: scrDir(t), scv: scrV(t), spd: t.spd || 0.2, z: t.z, start: t.start, end: t.start + t.dur });
    }
    $('#export').disabled = false; $('#xstat').textContent = '';
  }
  normZ();   // layer order (z) → 0..n-1 (text / image / shape share one stacking order)
  const SW = outWidth(), SH = Math.round(SW / (outAspect() || 1)), shRenders = shapes.map(t => ({ ...renderShapePng(t, SW, SH), id: t.id, x: t.x, y: t.y, op: t.op, z: t.z, start: t.start, end: t.start + t.dur }));
  const body = { clips, sfx, music, canvas, bg: canvasBg, width: $('#xres').value === 'hd' ? outWidth() : +$('#xres').value, preset: $('#xpreset').value, layers: texts, texts: renders, shapes: shRenders, shapeDefs: shapes, fxs, imgs, mute, linked };
  const r = await fetch(`/api/projects/${pid}/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { $('#xstat').textContent = 'Export error: ' + (await r.text()).slice(0, 120); return; }
  pollExport();
};

async function pollExport() {
  const x = $('#xstat'), bar = $('#xbar'), tok = openTok, id = pid;
  for (;;) {
    if (tok !== openTok) return;   // වෙන project එකකට මාරු වුනා
    let j;
    try { j = await (await fetch(`/api/projects/${id}/export`)).json(); }
    catch { x.textContent = 'Server error'; return; }
    if (j.status === 'queued' || j.status === 'running') {
      bar.hidden = false; bar.value = j.progress || 0;
      x.textContent = j.status === 'queued' ? 'Queue…' : Math.round((j.progress || 0) * 100) + '%';
      $('#export').disabled = true;
      await sleep(1000); continue;
    }
    $('#export').disabled = false; bar.hidden = true;
    if (j.status === 'done') {
      x.textContent = 'Export ✔';
      const a = $('#dl'); a.href = `/api/projects/${id}/output.mp4?t=${Date.now()}`; a.hidden = false;
    } else if (j.status === 'error') x.textContent = 'Export error: ' + (j.error || '').slice(-150);
    else x.textContent = '';
    return;
  }
}

// ================= upload video / open project =================
$('#file').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append('file', f);
  const x = new XMLHttpRequest();
  x.open('POST', '/api/projects');
  x.upload.onprogress = p => setStatus(`Upload ${Math.round(p.loaded / p.total * 100)}%`);
  x.onload = () => {
    if (x.status !== 200) { setStatus('Error ' + x.status + ': ' + x.responseText.slice(0, 120)); return; }
    const m = JSON.parse(x.responseText); e.target.value = ''; openProject(m.id);
  };
  x.onerror = () => setStatus('Upload error');
  x.send(fd);
};

async function openProject(id) {
  const tok = ++openTok;
  if (pid && pid !== id) flush();
  pause(); pid = id;
  document.body.classList.remove('home');
  $('#dl').hidden = true; $('#xstat').textContent = ''; $('#xbar').hidden = true; $('#export').disabled = false;
  setStatus('Loading…');
  let m;
  for (;;) {
    const r = await fetch(`/api/projects/${id}`);
    if (tok !== openTok) return;
    if (!r.ok) { goHome('Project not found'); return; }
    m = await r.json();
    if (m.status !== 'processing') break;
    setStatus('Preparing proxy…'); await sleep(1500);
    if (tok !== openTok) return;
  }
  if (m.status === 'error') { setStatus('Proxy error (is ffmpeg installed?)'); return; }
  const ed = await (await fetch(`/api/projects/${id}/edit`)).json();
  let ui = {};
  try { ui = await (await fetch(`/api/projects/${id}/ui`)).json(); } catch {}
  if (tok !== openTok) return;
  meta = m; setStatus(m.name);
  clips = (ed.clips?.length ? ed.clips : ed.noMain ? [] : [{ start: 0, end: m.default_len || m.duration }]).map(norm);
  linked = ed.linked !== false; mute = !!ed.mute;
  sfx = ed.sfx || []; music = ed.music || null; canvas = ed.canvas || 'auto'; canvasBg = ed.bg || '#000000';
  texts = (ed.texts || []).map(normT);
  fxs = (ed.fxs || []).map(normF);
  imgs = (ed.imgs || []).map(normI);
  shapes = (ed.shapes || []).map(normS);
  // අන්තිමට තිබ්බ settings ආපහු
  pps = ui.pps || 40; $('#tzoom').value = pps;
  $('#xres').value = ui.res ?? 'hd'; $('#xpreset').value = ui.preset || 'veryfast';
  dirty = false; exitCrop(); undo = []; redo = []; updUndoUi(); clearSel(); cur = 0; head = 0; zkey = '';
  video.src = `/api/projects/${id}/proxy.mp4`;
  video.onloadedmetadata = () => { render(); seek(Math.min(+ui.head || 0, total())); };
  render();   // video metadata එනකන් බලන්නේ නැතුව buttons / main placeholder ටික sync කරනවා
  preloadAudio(); pollExport();
}

// ================= home screen: projects list =================
function fmtDate(sec) {
  const d = new Date(sec * 1000);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' · ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
const fmtDur = t => { t = Math.round(t || 0); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

async function loadProjects() {
  const box = $('#plist');
  let list;
  try { list = await (await fetch('/api/projects')).json(); }
  catch { box.innerHTML = '<div class="pempty">Server error</div>'; return; }
  if (!list.length) { box.innerHTML = '<div class="pempty">No projects yet. Use "+ New project" at the top to upload a video.</div>'; return; }
  box.innerHTML = list.map(p => `
    <div class="pcard" data-id="${p.id}">
      <div class="pth">${p.thumb ? `<img loading="lazy" src="/api/projects/${p.id}/thumb.jpg" alt="">` : (p.status === 'processing' ? 'Processing…' : '🎬')}
        ${p.exported ? '<span class="bdg">Exported</span>' : ''}<span class="dur">${fmtDur(p.edited_duration)}</span></div>
      <div class="pbody">
        <div class="pname" title="${esc(p.name)}">${esc(p.name)}</div>
        <div class="pdate" title="Created: ${esc(fmtDate(p.created))}">Last edited<br>${fmtDate(p.updated)}</div>
        <div class="pmeta">${p.clips > 1 ? p.clips + ' clips' : 'No cuts yet'}${p.sfx ? ' · ' + p.sfx + ' SFX' : ''}${p.music ? ' · music' : ''}</div>
        <div class="pact"><button data-a="open">Open</button><button data-a="ren">✎ Rename</button><button data-a="del" class="danger">🗑</button></div>
      </div>
    </div>`).join('');
}

$('#plist').onclick = async e => {
  const card = e.target.closest('.pcard'); if (!card) return;
  const id = card.dataset.id, a = e.target.closest('button')?.dataset.a;
  if (!a || a === 'open') return openProject(id);
  if (a === 'ren') {
    const old = card.querySelector('.pname').textContent, name = prompt('Project name', old);
    if (name === null || !name.trim() || name.trim() === old) return;
    await fetch(`/api/projects/${id}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  } else if (a === 'del') {
    if (!confirm(`Delete the project "${card.querySelector('.pname').textContent}" completely? (video, edits and export — this cannot be undone)`)) return;
    const r = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    if (!r.ok) { toast((await r.text()).slice(0, 80)); return; }
  }
  loadProjects();
};

function goHome(msg) {
  flush();
  ++openTok; pause();
  pid = null; meta = null; clips = []; sfx = []; music = null; texts = []; fxs = []; imgs = []; shapes = []; dirty = false; linked = true; mute = false;
  clearSel(); exitCrop(); zkey = '';
  video.removeAttribute('src'); video.load();
  document.body.classList.add('home');
  $('#hmsg').textContent = msg || 'Open a project or create a new one. Every edit is saved automatically.';
  loadProjects();
}
$('#homebtn').onclick = e => { goHome(); e.target.blur(); };


// ================= text layers =================
const TXDEF = { text: 'Text', font: 'Nirmala UI', size: 0.07, bold: false, italic: false, underline: false, outline: false,
  sw: 0, sc: '#000000', shd: 0, shc: '#000000', bg: '', bga: 0.8, brad: 0.2,
  color: '#ffffff', align: 'center', x: 0.5, y: 0.8, start: 0, dur: 3, op: 1, scr: 0, scv: 0, spd: 0.2 };
const SYS_FONTS = ['Nirmala UI', 'Iskoola Pota', 'Noto Sans Sinhala', 'Segoe UI', 'Arial', 'Verdana', 'Georgia', 'Times New Roman', 'Impact', 'Comic Sans MS'];
const FALLBACK = '"Nirmala UI","Iskoola Pota","Noto Sans Sinhala","Noto Sans",sans-serif';   // සිංහල glyphs නැති font වලට fallback
const COLORS = ['#ffffff', '#000000', '#ff3b30', '#ffd60a', '#34c759', '#0a84ff', '#ff9f0a', '#ff2d92', '#bf5af2', '#00e5ff'];
const MINT = 0.2;
const LH = 1.4, PADK = 0.25;
const padEm = t => Math.max(PADK, (+t.sw || 0) / 2 + 0.1) + (t.bg ? 0.2 : 0) + (+t.shd > 0 ? 0.33 * t.shd : 0);   // stroke / shadow / background වලට අමතර ඉඩ (preview + export එකම)
const hexA = (h, a) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return 'transparent'; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${n >> 8 & 255},${n & 255},${a})`; };   // line-height / padding (em) — preview + export දෙකේම එකයි
let txStyle = {}; try { txStyle = JSON.parse(localStorage.txStyle || '{}'); } catch {}
let snapOn = localStorage.snap !== '0', gridOn = localStorage.grid === '1';
const normT = t => { const o = { ...TXDEF, ...t }; if (t.sw === undefined && t.outline) o.sw = 0.14; return o; };   // පරණ "Outline" → stroke 14%
const curText = () => texts.find(x => x.id === selText);
const fam = f => `"${f}",${FALLBACK}`;
const cssFont = (t, px) => `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${px}px ${fam(t.font)}`;
const txov = $('#txov');

async function loadFonts() {
  try { fonts = await (await fetch('/api/fonts')).json(); } catch { fonts = []; }
  await Promise.all(fonts.map(async f => {
    const name = 'uf_' + f.id;
    if ([...document.fonts].some(x => x.family.replace(/"/g, '') === name)) return;
    try { const ff = new FontFace(name, `url(/api/fonts/${f.id}/file)`); await ff.load(); document.fonts.add(ff); }
    catch (e) { console.warn('font load failed', f, e); }
  }));
  zkey = ''; renderText(); if (curText()) syncText(curText());
}

function placeEl(el, t, W) {
  const px = t.size * W;
  Object.assign(el.style, { zIndex: Z0 + (t.z | 0), left: t.x * 100 + '%', top: t.y * 100 + '%', fontSize: px + 'px', padding: padEm(t) + 'em',
    fontFamily: fam(t.font), fontWeight: t.bold ? 700 : 400, fontStyle: t.italic ? 'italic' : 'normal', color: t.color, textAlign: t.align });
  if (scrDir(t)) el.style.left = dispX(t, el._wf || 0.2) * 100 + '%';
  if (scrV(t)) el.style.top = dispY(t, el._hf || 0.1) * 100 + '%';
  el._xl = null; el._yl = null;
  const tt = el.firstChild;
  tt.style.textDecoration = t.underline ? 'underline' : 'none';
  tt.style.webkitTextStroke = t.sw > 0.001 ? `${t.sw * px}px ${t.sc}` : '0';
  tt.style.textShadow = t.shd > 0 ? `0 ${0.08 * t.shd * px}px ${0.25 * t.shd * px}px ${t.shc}` : 'none';
  el.style.background = t.bg ? hexA(t.bg, t.bga) : 'none';
  el.style.borderRadius = t.bg ? t.brad + 'em' : '0';
  if (tt.textContent !== t.text) tt.textContent = t.text;
  el.classList.toggle('sel', t.id === selText);
}
function renderText() {
  const W = stage.clientWidth; if (!W) return;
  txov.hidden = cropMode;
  const have = new Map([...txov.children].map(e => [e.dataset.id, e]));
  texts.forEach(t => {
    let el = have.get(t.id); have.delete(t.id);
    if (!el) {
      el = document.createElement('div'); el.className = 'tx'; el.dataset.id = t.id;
      el.innerHTML = '<span class="tt"></span>' + ['tl', 'tr', 'bl', 'br'].map(h => `<i class="th" data-h="${h}"></i>`).join('');
      txov.appendChild(el);
    }
    placeEl(el, t, W);
  });
  have.forEach(e => e.remove());
  applyText(true);
}
function applyText(force) {   // text එක පෙන්නන්නේ එහි time range එකේදී (select කරලා තියෙන එක අඩු opacity එකෙන් හැමවෙලේම)
  for (const el of txov.children) {
    const t = texts.find(x => x.id === el.dataset.id); if (!t) continue;
    const on = head >= t.start - 1e-6 && head < t.start + t.dur - 1e-6, v = on ? 1 : t.id === selText ? 2 : 0;
    const o = v === 2 ? 0.4 : (t.op ?? 1);
    if (force || el._v !== v || el._o !== o) { el._v = v; el._o = o; el.style.display = v ? '' : 'none'; el.style.opacity = o; }
    if (isScr(t) && v) {   // scroll: හැම frame එකකම position එක update
      el._wf = el.offsetWidth / (stage.clientWidth || 1) || 0.2;
      el._hf = el.offsetHeight / (stage.clientHeight || 1) || 0.1;
      const xl = dispX(t, el._wf), yl = dispY(t, el._hf);
      if (el._xl !== xl) { el._xl = xl; el.style.left = xl * 100 + '%'; }
      if (el._yl !== yl) { el._yl = yl; el.style.top = yl * 100 + '%'; }
    }
  }
}

// ----- grid + magnetic snapping -----
function buildGrid() {
  const g = $('#gridov'); g.hidden = !gridOn;
  if (g.childElementCount) return;
  [[100 / 3, 'g'], [50, 'c'], [200 / 3, 'g']].forEach(([p, k]) => {
    g.insertAdjacentHTML('beforeend', `<i class="v ${k}" style="left:${p}%"></i><i class="h ${k}" style="top:${p}%"></i>`);
  });
}
function syncToggles() {
  $('#snapbtn').classList.toggle('on', snapOn); $('#gridbtn').classList.toggle('on', gridOn); buildGrid();
}
$('#snapbtn').onclick = e => { snapOn = !snapOn; localStorage.snap = snapOn ? '1' : '0'; syncToggles(); e.target.blur(); };
$('#gridbtn').onclick = e => { gridOn = !gridOn; localStorage.grid = gridOn ? '1' : '0'; syncToggles(); e.target.blur(); };
syncToggles();

// 1D snap: box (center c, half-size h) -> center line (always) + grid lines (grid on). returns {c, line}
function snap1(c, h, lines, tol) {
  let best = null;
  for (const L of lines) for (const off of (L.center ? [0] : [0, -h, h])) {   // box center / left(top) / right(bottom) edge
    const d = L.v - (c + off);
    if (Math.abs(d) < tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, v: L.v, center: L.center };
  }
  return best ? { c: c + best.d, line: best } : { c, line: null };
}
function guides(vx, hy) {
  [['#gv', vx, 'left'], ['#gh', hy, 'top']].forEach(([id, l, prop]) => {
    const e = $(id); e.hidden = !l;
    if (l) { e.style[prop] = l.v * 100 + '%'; e.classList.toggle('g', !l.center); }
  });
}

// ----- preview: move / resize (corner handles) -----
txov.addEventListener('pointerdown', e => {
  const el = e.target.closest('.tx'); if (!el || e.button) return;
  const t = texts.find(x => x.id === el.dataset.id); if (!t) return;
  e.preventDefault(); e.stopPropagation();
  if (selText !== t.id) { clearSel(); selText = t.id; render(); }
  const handle = e.target.closest('.th')?.dataset.h;
  const R = stage.getBoundingClientRect(), W = R.width, H = R.height;
  const px0 = e.clientX, py0 = e.clientY, s0 = t.size, bw = el.offsetWidth, bh = el.offsetHeight;
  const y0 = dispY(t, bh / H), scv = scrV(t), offY = scv ? scrOffY(t) : 0;
  const sc = scrDir(t), off = sc ? scrOff(t) : 0, x0 = dispX(t, bw / W);   // scroll text: දැන් පේන තැනින් drag, t.x = පටන් ගන්න තැන
  const setX = cx => { t.x = sc ? wrapX(cx - off, bw / W) : cx; };
  const setY = cy => { t.y = scv ? wrapX(cy - offY, bh / H) : cy; };
  let moved = false;
  el.setPointerCapture?.(e.pointerId);
  const mv = ev => {
    const dx = ev.clientX - px0, dy = ev.clientY - py0;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    if (!moved) { snap(handle ? 'Resize text' : 'Move text'); moved = true; }
    if (handle) {
      const sx = handle.includes('l') ? -1 : 1, sy = handle.includes('t') ? -1 : 1;
      const fx = x0 * W - sx * bw / 2, fy = y0 * H - sy * bh / 2;                  // opposite (fixed) corner
      const vx = sx * bw, vy = sy * bh, px = ev.clientX - R.left - fx, py = ev.clientY - R.top - fy;
      const k = Math.max(0.1, Math.min(8, (px * vx + py * vy) / (vx * vx + vy * vy)));
      t.size = Math.max(0.015, Math.min(0.5, s0 * k));
      const kk = t.size / s0;
      setX((fx + sx * bw * kk / 2) / W); setY((fy + sy * bh * kk / 2) / H);
    } else {
      let nx = x0 + dx / W, ny = y0 + dy / H, gv = null, gh = null;
      nx = Math.max(0, Math.min(1, nx)); ny = Math.max(0, Math.min(1, ny));
      if (snapOn && !ev.altKey) {
        const vl = [{ v: 0.5, center: true }], hl = [{ v: 0.5, center: true }];
        if (gridOn) for (const v of [0, 1 / 3, 2 / 3, 1]) { vl.push({ v }); hl.push({ v }); }
        const a = snap1(nx, bw / W / 2, vl, 7 / W), b = snap1(ny, bh / H / 2, hl, 7 / H);
        nx = a.c; ny = b.c; gv = a.line; gh = b.line;
      }
      setX(nx); setY(ny); guides(gv, gh);
    }
    placeEl(el, t, W);
    if (selText === t.id) syncText(t, true);
    touch();
  };
  const up = () => {
    el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    guides(null, null);
    if (moved) { remember(t); changed(); }
  };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
});
stage.addEventListener('pointerdown', e => {   // text එකෙන් පිට click කළාම text deselect
  if (!(selText || selImg || selShape) || cropMode || e.target.closest('.tx') || e.target.closest('.im') || e.target.closest('.sp') || e.target.closest('.hd')) return;
  clearSel(); render();
});
txov.addEventListener('dblclick', e => { if (e.target.closest('.tx')) { const a = $('#ttext'); a.focus(); a.select(); } });

// ----- timeline: text / FX item move / trim (+ magnetic snap) -----
track.addEventListener('pointerdown', e => {
  const el = e.target.closest('.txi,.fxi,.imi,.shi'); if (!el || e.button) return;
  const kind = el.classList.contains('fxi') ? 'fx' : el.classList.contains('imi') ? 'im' : el.classList.contains('shi') ? 'sh' : 'tx', isFx = kind === 'fx';
  const t = (isFx ? fxs : kind === 'im' ? imgs : kind === 'sh' ? shapes : texts).find(x => x.id === el.dataset.id); if (!t) return;
  swallow = true; setTimeout(() => swallow = false, 300);
  if ((isFx ? selFx : kind === 'im' ? selImg : kind === 'sh' ? selShape : selText) !== t.id) { clearSel(); if (isFx) selFx = t.id; else if (kind === 'im') selImg = t.id; else if (kind === 'sh') selShape = t.id; else selText = t.id; }
  const rc = el.getBoundingClientRect(), lx = e.clientX - rc.left;
  const mode = lx < 7 ? 'l' : lx > rc.width - 7 ? 'r' : 'm';
  const x0 = e.clientX, s0 = t.start, d0 = t.dur, e0 = s0 + d0, MIN = 0.2;
  const pts = tlPoints({}, t.id, t.grp || ''), tol = 9 / pps;   // snap points (මේ item එක හැර)
  let moved = false;
  el.setPointerCapture?.(e.pointerId);
  const mv = ev => {
    const dt = (ev.clientX - x0) / pps;
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    if (!moved) { snap((isFx ? 'FX ' : kind === 'im' ? 'Image ' : kind === 'sh' ? 'Shape ' : 'Text ') + (mode === 'm' ? 'move' : 'trim')); moved = true; }
    const on = snapOn && !ev.altKey; let hit = null;
    if (mode === 'm') {          // move: මුල හෝ අග ළඟම point එකට ඇලෙනවා
      let ns = Math.max(0, s0 + dt);
      if (on) {
        const a = tlNear(ns, pts, tol), b = tlNear(ns + d0, pts, tol);
        const c = a && (!b || Math.abs(a.d) <= Math.abs(b.d)) ? a : b;
        if (c) { ns = Math.max(0, ns + c.d); hit = c; }
      }
      t.start = hit ? ns : +ns.toFixed(2);
    } else if (mode === 'l') {   // trim left
      let ns = Math.max(0, Math.min(e0 - MIN, s0 + dt));
      const a = on ? tlNear(ns, pts, tol) : null;
      if (a && a.v >= 0 && a.v <= e0 - MIN) { ns = a.v; hit = a; }
      t.start = hit ? ns : +ns.toFixed(2);
      t.dur = hit ? e0 - ns : +(e0 - ns).toFixed(2);
    } else {                     // trim right: අග video end එකට ඇලෙනවා
      let ne = Math.max(s0 + MIN, e0 + dt);
      const a = on ? tlNear(ne, pts, tol) : null;
      if (a && a.v >= s0 + MIN) { ne = a.v; hit = a; }
      t.dur = hit ? ne - s0 : Math.max(MIN, +(d0 + dt).toFixed(2));
    }
    hit ? showSnapLine(hit.v) : hideSnapLine();
    if (kind === 'im') syncGrpTime(t);
    el.style.left = t.start * pps + 'px'; el.style.width = Math.max(18, t.dur * pps) + 'px';
    if (isFx) syncFx(t, true); else if (kind === 'im') { syncImg(t, true); applyImg(true); } else if (kind === 'sh') { syncShape(t, true); applyShapes(true); } else { syncText(t, true); applyText(true); }
  };
  const up = () => {
    el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    hideSnapLine();
    if (moved) changed();
    else { render(); if (head < t.start || head >= t.start + t.dur) seek(t.start + 0.01); }
  };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
});

// ----- inspector -----
let lastSnapL = '', lastSnapT = 0;
function snapT(label) { const n = Date.now(); if (label !== lastSnapL || n - lastSnapT > 1000) snap(label); lastSnapL = label; lastSnapT = n; }
function remember(t) {
  txStyle = { font: t.font, size: t.size, bold: t.bold, italic: t.italic, underline: t.underline, outline: t.outline, sw: t.sw, sc: t.sc, shd: t.shd, shc: t.shc, bg: t.bg, bga: t.bga, brad: t.brad, color: t.color, align: t.align };
  localStorage.txStyle = JSON.stringify(txStyle);
}
function syncText(t, light) {   // light = drag වෙලාවේ number inputs විතරයි
  if (document.activeElement !== $('#tstart')) $('#tstart').value = (+t.start).toFixed(2);
  if (document.activeElement !== $('#tdur')) $('#tdur').value = (+t.dur).toFixed(2);
  $('#tsize').value = t.size * 100; $('#tsizev').textContent = (t.size * 100).toFixed(1) + '%';
  const to = Math.round((t.op ?? 1) * 100); $('#topac').value = to; $('#topacv').textContent = to + '%';
  const tx = Math.round(t.x * 100), ty = Math.round(t.y * 100), td = scrDir(t), tv = scrV(t), ts = Math.round((t.spd || 0.2) * 100);
  $('#tpx').value = tx; $('#tpxv').textContent = tx + '%'; $('#tpy').value = ty; $('#tpyv').textContent = ty + '%';
  $('#tspd').value = ts; $('#tspdv').textContent = ts + '%/s'; $('#tspd').disabled = !(td || tv);
  [['#tscr0', !td && !tv], ['#tscrL', td < 0], ['#tscrR', td > 0], ['#tscrU', tv < 0], ['#tscrD', tv > 0]].forEach(([id, on]) => $(id).classList.toggle('on', on));
  const sw = Math.round((t.sw || 0) * 100), sd = Math.round((t.shd || 0) * 100), ba = Math.round((t.bga ?? 0.8) * 100), br = Math.round((t.brad ?? 0.2) * 100);
  $('#tsw').value = sw; $('#tswv').textContent = sw + '%'; $('#tshd').value = sd; $('#tshdv').textContent = sd + '%';
  $('#tbga').value = ba; $('#tbgav').textContent = ba + '%'; $('#tbrad').value = br; $('#tbradv').textContent = br + '%';
  [['sc', 'tsc'], ['shc', 'tshc'], ['bg', 'tbgc']].forEach(([k, id]) => {
    document.querySelectorAll('#' + id + ' button').forEach(b => b.classList.toggle('on', b.dataset.c === (t[k] || '')));
    const ci = $('#' + id + ' input'); if (ci && t[k]) ci.value = t[k];
  });
  if (light) return;
  if ($('#ttext').value !== t.text) $('#ttext').value = t.text;
  const mine = fonts.map(f => `<option value="uf_${f.id}">${esc(f.name)}</option>`).join('');
  const sys = [...new Set([...SYS_FONTS, t.font].filter(f => !f.startsWith('uf_')))].map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
  $('#tfont').innerHTML = (mine ? `<optgroup label="My fonts">${mine}</optgroup>` : '') + `<optgroup label="System">${sys}</optgroup>`;
  $('#tfont').value = t.font;
  $('#tfdel').hidden = !t.font.startsWith('uf_');
  [['#tb', t.bold], ['#ti', t.italic], ['#tu', t.underline], ['#toutl', t.sw > 0.001]].forEach(([id, on]) => $(id).classList.toggle('on', !!on));
  document.querySelectorAll('[data-al]').forEach(b => b.classList.toggle('on', b.dataset.al === t.align));
  document.querySelectorAll('#tcolors button').forEach(b => b.classList.toggle('on', b.dataset.c === t.color));
  $('#tcolor').value = t.color;
}
const CSW = [['#000000', 'Black'], ['#ffffff', 'White']];
function mkColors(id, key, label, none) {
  const el = $('#' + id);
  el.innerHTML = (none ? `<button class="none" data-c="" title="No background">None</button>` : '') + CSW.map(([c, n]) => `<button data-c="${c}" style="background:${c}" title="${n}"></button>`).join('') + `<input type="color" class="cc" value="#000000" title="Custom color">`;
  const set = c => editT(label, t => { t[key] = c; if (key === 'bg' && c && !(t.bga > 0)) t.bga = 0.8; });
  el.onclick = e => { const b = e.target.closest('button'); if (b) set(b.dataset.c); };
  el.querySelector('input').oninput = e => set(e.target.value);
}
mkColors('tsc', 'sc', 'Stroke color'); mkColors('tshc', 'shc', 'Shadow color'); mkColors('tbgc', 'bg', 'Background color', true);
$('#tsw').oninput = e => editT('Stroke width', t => { t.sw = +e.target.value / 100; t.outline = false; });
$('#tshd').oninput = e => editT('Shadow', t => t.shd = +e.target.value / 100);
$('#tbga').oninput = e => editT('Background opacity', t => t.bga = +e.target.value / 100);
$('#tbrad').oninput = e => editT('Background corners', t => t.brad = +e.target.value / 100);
['#tsw', '#tshd', '#tbga', '#tbrad'].forEach(id => $(id).onchange = e => e.target.blur());
$('#tcolors').innerHTML = COLORS.map(c => `<button data-c="${c}" style="background:${c}" title="${c}"></button>`).join('');
function editT(label, fn) { const t = curText(); if (!t) return; snapT(label); fn(t); remember(t); changed(); }
$('#ttext').oninput = e => editT('Edit text', t => t.text = e.target.value);
$('#tfont').onchange = e => editT('Text font', t => t.font = e.target.value);
$('#tb').onclick = () => editT('Bold', t => t.bold = !t.bold);
$('#ti').onclick = () => editT('Italic', t => t.italic = !t.italic);
$('#tu').onclick = () => editT('Underline', t => t.underline = !t.underline);
$('#toutl').onclick = () => editT('Outline', t => { t.sw = t.sw > 0.001 ? 0 : 0.14; t.outline = false; });
document.querySelectorAll('[data-al]').forEach(b => b.onclick = () => editT('Align', t => t.align = b.dataset.al));
$('#tsize').oninput = e => editT('Text size', t => t.size = +e.target.value / 100);
$('#topac').oninput = e => editT('Text opacity', t => t.op = Math.max(0, Math.min(1, +e.target.value / 100)));
$('#topac').onchange = e => e.target.blur();
$('#tcolors').onclick = e => { const c = e.target.closest('button')?.dataset.c; if (c) editT('Text color', t => t.color = c); };
$('#tcolor').oninput = e => editT('Text color', t => t.color = e.target.value);
$('#tstart').onchange = e => editT('Text time', t => t.start = Math.max(0, +e.target.value || 0));
$('#tdur').onchange = e => editT('Text time', t => t.dur = Math.max(0.2, +e.target.value || 3));
$('#tfit').onclick = e => { editT('Text → video end', t => { t.start = Math.min(t.start, Math.max(0, total() - MINT)); t.dur = Math.max(MINT, total() - t.start); }); e.target.blur(); };
$('#tend').onclick = e => { editT('Text → playhead', t => { t.dur = Math.max(MINT, head - t.start); }); e.target.blur(); };
$('#tpx').oninput = e => editT('Text X', t => t.x = +e.target.value / 100);
$('#tpy').oninput = e => editT('Text Y', t => t.y = +e.target.value / 100);
$('#tspd').oninput = e => editT('Text scroll speed', t => t.spd = clampN(+e.target.value / 100, 0.02, 1.5));
['#tpx', '#tpy', '#tspd'].forEach(id => $(id).onchange = e => e.target.blur());
$('#tscr0').onclick = e => { editT('Text scroll', t => { t.scr = 0; t.scv = 0; }); e.target.blur(); };
$('#tscrL').onclick = e => { editT('Text scroll', t => { t.scr = -1; t.scv = 0; t.spd = t.spd || 0.2; }); e.target.blur(); };
$('#tscrR').onclick = e => { editT('Text scroll', t => { t.scr = 1; t.scv = 0; t.spd = t.spd || 0.2; }); e.target.blur(); };
$('#tscrU').onclick = e => { editT('Text scroll', t => { t.scr = 0; t.scv = -1; t.spd = t.spd || 0.2; }); e.target.blur(); };   // පහළින් උඩට
$('#tscrD').onclick = e => { editT('Text scroll', t => { t.scr = 0; t.scv = 1; t.spd = t.spd || 0.2; }); e.target.blur(); };    // උඩින් පහළට
$('#twhole').onclick = e => { editT('Text whole video', t => { t.start = 0; t.dur = +Math.max(0.2, total()).toFixed(2); }); e.target.blur(); };
$('#tcx').onclick = () => editT('Center text X', t => t.x = 0.5);
$('#tcy').onclick = () => editT('Center text Y', t => t.y = 0.5);
$('#tdup').onclick = () => { const t = curText(); if (!t) return; snap('Duplicate text'); const n = { ...t, id: uid(), z: nextZ(), x: Math.min(1, t.x + 0.03), y: Math.min(1, t.y + 0.03) }; texts.push(n); selText = n.id; changed(); };
$('#tdel').onclick = () => delText();
function delText() { if (!selText) return; snap('Delete text'); texts = texts.filter(x => x.id !== selText); selText = null; changed(); }
$('#addtext').onclick = () => {
  if (!pid) { setStatus('Open a project first'); return; }
  snap('Add text'); clearSel();
  const t = normT({ ...txStyle, id: uid(), z: nextZ(), x: 0.5, y: 0.8, start: +head.toFixed(2), dur: +Math.max(0.5, Math.min(3, total() - head)).toFixed(2) });
  texts.push(t); selText = t.id; changed();
  const a = $('#ttext'); a.focus(); a.select();
};

$('#addscroll').onclick = () => {   // ticker: playhead එකේ ඉඳන් video end එක දක්වා, වමට scroll වෙන text එකක්
  if (!pid) { setStatus('Open a project first'); return; }
  snap('Add scrolling text'); clearSel();
  const T = total(), start = +Math.min(head, Math.max(0, T - 0.5)).toFixed(2);
  const t = normT({ ...txStyle, id: uid(), z: nextZ(), text: 'Scrolling text', x: 0.5, y: 0.9, scr: -1, spd: 0.2, start, dur: +Math.max(0.5, T - start).toFixed(2) });
  texts.push(t); selText = t.id; changed();
  const a = $('#ttext'); a.focus(); a.select();
};

// font upload
$('#up-font').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const fd = new FormData(); fd.append('file', f);
  const r = await fetch('/api/fonts', { method: 'POST', body: fd });
  if (!r.ok) { toast('Font upload error: ' + (await r.text()).slice(0, 80)); return; }
  const m = await r.json(); await loadFonts();
  const t = curText(); if (t) { snap('Text font'); t.font = 'uf_' + m.id; remember(t); changed(); }
  toast('Font added: ' + m.name);
};
$('#tfdel').onclick = async () => {
  const t = curText(); if (!t || !t.font.startsWith('uf_')) return;
  const id = t.font.slice(3), f = fonts.find(x => x.id === id);
  if (!confirm(`Delete "${f?.name || 'font'}"? (texts using it will fall back to the default font)`)) return;
  await fetch(`/api/fonts/${id}`, { method: 'DELETE' });
  snap('Delete font'); texts.forEach(x => { if (x.font === t.font) x.font = TXDEF.font; });
  await loadFonts(); changed();
};

// ----- export render: text -> PNG (browser shaping = preview එකටම සමානයි) -----
function outWidth() {
  const sw = meta?.width || 1080, sh = meta?.height || 1920;
  let cw;
  if (canvas === 'auto') { const cr = clips[0]?.crop; cw = cr ? Math.max(2, Math.round(cr.w * sw)) : sw; }
  else if (canvas === 'orig') cw = sw;
  else { const [a, b] = canvas.split(':').map(Number), rt = a / b; cw = rt > sw / sh ? sw : Math.round(sh * rt); }
  const rv = $('#xres').value;
  let w = rv === 'hd' ? Math.max(cw, 1080) : (+rv || cw); return w - (w % 2);
}
async function renderTextPng(t, W) {
  const px = t.size * W;
  try { await document.fonts.load(cssFont(t, px), t.text); } catch {}
  const c = document.createElement('canvas'), g = c.getContext('2d');
  g.font = cssFont(t, px);
  const lines = t.text.split('\n'), ws = lines.map(l => g.measureText(l).width), maxw = Math.max(...ws);
  const m = g.measureText('Hg'), A = m.fontBoundingBoxAscent ?? px * 0.95, D = m.fontBoundingBoxDescent ?? px * 0.25;
  const pad = padEm(t) * px, lh = LH * px;
  c.width = Math.max(2, Math.ceil(maxw + 2 * pad)); c.height = Math.max(2, Math.ceil(lines.length * lh + 2 * pad));
  g.font = cssFont(t, px); g.textBaseline = 'alphabetic'; g.lineJoin = 'round';
  if (t.bg) {   // background box (rounded)
    g.fillStyle = hexA(t.bg, t.bga); const r = Math.min(t.brad * px, c.width / 2, c.height / 2);
    g.beginPath(); g.moveTo(r, 0); g.arcTo(c.width, 0, c.width, c.height, r); g.arcTo(c.width, c.height, 0, c.height, r); g.arcTo(0, c.height, 0, 0, r); g.arcTo(0, 0, c.width, 0, r); g.closePath(); g.fill();
  }
  const hasSh = t.shd > 0, hasSw = t.sw > 0.001;
  const shOn = () => { if (hasSh) { g.shadowColor = t.shc; g.shadowBlur = 0.25 * t.shd * px; g.shadowOffsetX = 0; g.shadowOffsetY = 0.08 * t.shd * px; } };
  const shOff = () => { g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0; };
  lines.forEach((l, i) => {
    const base = pad + i * lh + (lh - (A + D)) / 2 + A;
    const x = t.align === 'left' ? pad : t.align === 'right' ? pad + maxw - ws[i] : pad + (maxw - ws[i]) / 2;
    if (hasSw) { shOn(); g.strokeStyle = t.sc; g.lineWidth = t.sw * px; g.strokeText(l, x, base); shOff(); g.fillStyle = t.color; g.fillText(l, x, base); }
    else { shOn(); g.fillStyle = t.color; g.fillText(l, x, base); shOff(); }
    g.fillStyle = t.color;
    if (t.underline && l) g.fillRect(x, base + 0.1 * px, ws[i], Math.max(1, 0.06 * px));
  });
  return { png: c.toDataURL('image/png'), wf: c.width / W };
}

// ================= emoji (Apple style) =================
// emoji කීපයක් එකට "group" වෙනවා: එකම size, fixed spacing, වමේ→දකුණට, group එකේ මැද = video මැද (magnetic).
// group එක එකට move / resize / time වෙනස් වෙනවා.
const EMGAP = 0.14, EMW = 0.22, EMMAX = 4;
const emojiName = {};
let emojiData = { ready: false, cats: [], items: [] }, emojiCat = '';
const grpList = t => t.grp ? imgs.filter(x => x.grp === t.grp) : [t];
const emChar = u => { try { return String.fromCodePoint(...u.split('-').map(h => parseInt(h, 16))); } catch { return '🙂'; } };
const imLabel = t => t.emoji ? emChar(t.emoji) + ' ' + (emojiName[t.emoji] || 'emoji') : (asset(t.asset)?.name || 'missing');
const grpSpan = (n, w) => n * w + (n - 1) * EMGAP * w;
function grpCenter(list) {
  const xs = list.map(x => x.x);
  return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: list.reduce((a, x) => a + x.y, 0) / list.length };
}
function layoutGrp(list, cx, cy, w) {
  const n = list.length; w = Math.max(0.03, Math.min(w, 0.96 / (n + (n - 1) * EMGAP)));
  const step = w * (1 + EMGAP), x0 = cx - (n - 1) * step / 2;
  list.forEach((m, i) => { m.w = +w.toFixed(4); m.x = +(x0 + i * step).toFixed(5); m.y = +cy.toFixed(5); });
}
function placeGrpEls(list) { for (const m of list) { const el = [...imov.children].find(e => e.dataset.id === m.id); if (el) placeImg(el, m); } }
function syncGrpTime(t) { if (t.grp) imgs.forEach(x => { if (x.grp === t.grp && x !== t) { x.start = t.start; x.dur = t.dur; } }); }

function addEmoji(u) {
  if (!pid) { setStatus('Open a project first'); return; }
  const cur = curImg(), join = $('#emjoin').checked && cur && cur.emoji;
  if (join && grpList(cur).length >= EMMAX) { toast(`A group can hold at most ${EMMAX} emoji — click an empty spot to start a new one`); return; }
  snap('Add emoji');
  const T = total();
  let t;
  if (join) {
    const g = cur.grp || (cur.grp = uid()), list = grpList(cur), c = grpCenter(list);
    t = normI({ id: uid(), z: nextZ(), emoji: u, grp: g, w: cur.w, op: cur.op, start: cur.start, dur: cur.dur });
    imgs.push(t);
    layoutGrp(grpList(t), 0.5, c.cy, cur.w);       // group එක video එකේ මැදට (X), spacing + size equal
  } else {
    clearSel();
    const start = +Math.min(head, Math.max(0, T - 0.5)).toFixed(2);
    t = normI({ id: uid(), z: nextZ(), emoji: u, x: 0.5, y: 0.5, w: EMW, op: 1, start, dur: +Math.max(0.5, Math.min(3, T - start)).toFixed(2) });
    imgs.push(t);
  }
  selImg = t.id; changed();
  if (head < t.start || head >= t.start + t.dur) seek(t.start + 0.01);
}

function renderEmojiGrid() {
  const g = $('#emgrid'), q = $('#emq').value.trim().toLowerCase();
  $('#eminstall').hidden = emojiData.ready || emojiBusy;
  if (!emojiData.ready) { g.innerHTML = ''; if (!emojiBusy) $('#emhint').textContent = 'The emoji library is not installed yet (one time only, about 2 minutes).'; return; }
  $('#emhint').textContent = '＋ click = add at the playhead · with "group" ON the emoji joins the selected one and is centered (same size, fixed spacing) · drag / corner-drag in the preview moves / resizes the whole group';
  let items = q ? emojiData.items.filter(x => x.n.includes(q) || x.k.includes(q)) : emojiData.items.filter(x => x.c === emojiCat);
  items = items.slice(0, q ? 160 : 600);
  g.innerHTML = items.map(x => `<button class="emb" data-u="${x.u}" title="${esc(x.n)}"><img loading="lazy" draggable="false" src="/api/emoji/${x.u}.png" alt="${esc(emChar(x.u))}"></button>`).join('');
}
let emojiBusy = false;
async function emojiInstallPoll() {   // server එකේ download job එක බලනවා
  emojiBusy = true; $('#eminstall').hidden = true;
  for (;;) {
    let j; try { j = await (await fetch('/api/emoji/install')).json(); } catch { j = { status: 'error', error: 'server' }; }
    if (j.status === 'running') { $('#emhint').textContent = `Downloading emoji… ${j.done}/${j.total || '?'}`; await sleep(1500); continue; }
    emojiBusy = false;
    if (j.status === 'error') { $('#emhint').textContent = 'Emoji install error: ' + j.error; $('#eminstall').hidden = false; return; }
    await loadEmoji(); toast('Emoji library ready ✔'); return;
  }
}
$('#eminstall').onclick = async () => { await fetch('/api/emoji/install', { method: 'POST' }); emojiInstallPoll(); };
async function loadEmoji() {
  try { emojiData = await (await fetch('/api/emoji')).json(); } catch { emojiData = { ready: false, cats: [], items: [] }; }
  emojiData.items.forEach(x => emojiName[x.u] = x.n);
  emojiCat = emojiData.cats[0] || '';
  $('#emcat').innerHTML = emojiData.cats.map(c => `<option>${esc(c)}</option>`).join('');
  renderEmojiGrid(); if (pid) render();
  if (!emojiData.ready && !emojiBusy) { try { if ((await (await fetch('/api/emoji/install')).json()).status === 'running') emojiInstallPoll(); } catch {} }
}
$('#emcat').onchange = e => { emojiCat = e.target.value; $('#emq').value = ''; renderEmojiGrid(); };
$('#emq').oninput = renderEmojiGrid;
$('#emgrid').addEventListener('click', e => { const b = e.target.closest('.emb'); if (b) addEmoji(b.dataset.u); });

// ================= layer order (z): text + image / video / emoji + shapes share ONE stacking order =================
// z = 0 .. n-1 (bottom → top). preview: each overlay element gets z-index = Z0 + z · export: backend sorts the overlays by z. The main video is always the bottom layer.
const Z0 = 12;
const HANDLES8 = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];   // resize handles: 4 corners + 4 sides
const allLayers = () => [...imgs.map(o => ({ k: 'im', o })), ...shapes.map(o => ({ k: 'sh', o })), ...texts.map(o => ({ k: 'tx', o }))];
function normZ() {   // old projects (no z) keep the old look: images < shapes < text
  const L = allLayers(); L.forEach((x, i) => x.i = i);
  const key = x => Number.isFinite(x.o.z) ? x.o.z : -1e6 + x.i;
  L.sort((a, b) => key(a) - key(b) || a.i - b.i);
  L.forEach((x, r) => x.o.z = r);
  return L;   // bottom → top
}
const nextZ = () => allLayers().reduce((m, x) => Math.max(m, Number.isFinite(x.o.z) ? x.o.z : -1), -1) + 1;
function layerUnits() {   // top → bottom · an emoji group (same grp) is ONE unit so it moves as a whole
  const L = normZ(), units = [], seen = new Set();
  for (let i = L.length - 1; i >= 0; i--) {
    const x = L[i];
    if (x.k === 'im' && x.o.grp) {
      if (seen.has(x.o.grp)) continue;
      seen.add(x.o.grp);
      units.push({ k: 'im', items: L.filter(y => y.k === 'im' && y.o.grp === x.o.grp).map(y => y.o) });
    } else units.push({ k: x.k, items: [x.o] });
  }
  return units;
}
function applyUnits(units) { let z = 0; for (let i = units.length - 1; i >= 0; i--) units[i].items.forEach(o => o.z = z++); }   // units[0] = top
const selItem = () => curImg() || curShape() || curText();
function layerMove(how) {   // how: front | up | down | back
  const o = selItem(); if (!o) return;
  const units = layerUnits(), i = units.findIndex(u => u.items.includes(o)); if (i < 0) return;
  const j = how === 'front' ? 0 : how === 'back' ? units.length - 1 : how === 'up' ? Math.max(0, i - 1) : Math.min(units.length - 1, i + 1);
  if (j === i) { toast(how === 'front' || how === 'up' ? 'Already in front' : 'Already at the back (just above the main video)'); return; }
  snap('Layer order'); const [u] = units.splice(i, 1); units.splice(j, 0, u); applyUnits(units); changed();
}
document.querySelectorAll('[data-lay]').forEach(b => b.onclick = e => { layerMove(b.dataset.lay); e.currentTarget.blur(); });

// ================= image overlays =================
// h = 0 → height follows the file's aspect ratio · h > 0 → freely resized height (fraction of canvas height) · lock = keep proportions while resizing
const IMDEF = { asset: '', emoji: '', grp: '', x: 0.5, y: 0.5, w: 0.4, h: 0, lock: false, op: 1, start: 0, dur: 3, rad: 0, scr: 0, scv: 0, spd: 0.2 };
const normI = t => ({ ...IMDEF, ...t });
const curImg = () => imgs.find(x => x.id === selImg);
const imov = $('#imov');

function placeImg(el, t) {
  const custom = +t.h > 0;   // freely resized: width AND height set by the user
  Object.assign(el.style, { zIndex: Z0 + (t.z | 0), left: dispX(t, t.w) * 100 + '%', top: dispY(t, imHf(t)) * 100 + '%', width: t.w * 100 + '%', height: custom ? t.h * 100 + '%' : '' });
  el.classList.toggle('free', custom);
  const a0 = t.emoji ? null : asset(t.asset);   // box keeps the file's proportions even before the image / video has loaded
  el.style.aspectRatio = !custom && a0?.w && a0?.h ? `${a0.w} / ${a0.h}` : '';
  el._xl = null; el._yl = null;
  const im = el.firstChild, src = t.emoji ? `/api/emoji/${t.emoji}.png` : `/api/assets/${t.asset}/file`;
  if (im.getAttribute('src') !== src) im.src = src;
  // corner radius (px): image එකේ පොඩි පැත්තේ fraction × radius
  const a = t.emoji ? null : asset(t.asset), ar = (im.naturalWidth || im.videoWidth) && (im.naturalHeight || im.videoHeight) ? (im.naturalWidth || im.videoWidth) / (im.naturalHeight || im.videoHeight) : a?.w && a?.h ? a.w / a.h : 1;
  const Wp = t.w * stage.clientWidth, Hp = custom ? t.h * stage.clientHeight : Wp / ar, Rp = (+t.rad || 0) * Math.min(Wp, Hp);
  im.style.borderRadius = Rp >= 0.5 ? Rp.toFixed(1) + 'px' : '0';
  el.classList.toggle('sel', t.id === selImg);
}
function renderImgs() {
  if (!stage.clientWidth) return;
  imov.hidden = cropMode;
  const have = new Map([...imov.children].map(e => [e.dataset.id, e]));
  imgs.forEach(t => {
    const isV = !t.emoji && !!asset(t.asset)?.vid;
    let el = have.get(t.id); have.delete(t.id);
    if (el && !!el._vid !== isV) { el.remove(); el = null; }   // assets late load වුනාම img ↔ video මාරු
    if (!el) {
      el = document.createElement('div'); el.className = 'im'; el.dataset.id = t.id; el._vid = isV;
      el.innerHTML = (isV ? '<video muted loop playsinline preload="auto" draggable="false"></video>' : '<img draggable="false" alt="">') + HANDLES8.map(h => `<i class="th" data-h="${h}"></i>`).join('');
      el.firstChild[isV ? 'onloadedmetadata' : 'onload'] = () => { const m = imgs.find(x => x.id === el.dataset.id); if (m) placeImg(el, m); };   // natural size ආවම radius ආයෙත් ගණන් කරනවා
      imov.appendChild(el);
    }
    placeImg(el, t);
  });
  have.forEach(e => e.remove());
  applyImg(true);
}
function applyImg(force) {   // image එක පෙන්නන්නේ එහි time range එකේදී (select කරලා තියෙන එක අඩු opacity එකෙන් හැමවෙලේම)
  for (const el of imov.children) {
    const t = imgs.find(x => x.id === el.dataset.id); if (!t) continue;
    const on = head >= t.start - 1e-6 && head < t.start + t.dur - 1e-6, v = on ? 1 : t.id === selImg ? 2 : 0;
    const o = v === 2 ? 0.35 : t.op;
    if (force || el._v !== v || el._o !== o) { el._v = v; el._o = o; el.style.display = v ? '' : 'none'; el.style.opacity = o; }
    if (el._vid) {   // video overlay: timeline head එකට sync (play වෙද්දී play, නැත්නම් pause + seek)
      const vv = el.firstChild, vd = vv.duration || asset(t.asset)?.duration || 0;
      if (v === 1 && vd > 0 && isFinite(vd)) {
        const want = Math.max(0, head - t.start) % vd;
        if (playing) {
          if (vv.paused) vv.play().catch(() => {});
          if (Math.abs(vv.currentTime - want) > 0.35 && Math.abs(vv.currentTime - want) < vd - 0.35) vv.currentTime = want;
        } else {
          if (!vv.paused) vv.pause();
          if (Math.abs(vv.currentTime - want) > 0.03) vv.currentTime = want;
        }
      } else if (!vv.paused) vv.pause();
    }
    if (isScr(t) && v) {   // scroll: හැම frame එකකම position එක update
      const xl = dispX(t, t.w), yl = dispY(t, imHf(t));
      if (el._xl !== xl) { el._xl = xl; el.style.left = xl * 100 + '%'; }
      if (el._yl !== yl) { el._yl = yl; el.style.top = yl * 100 + '%'; }
    }
  }
}

function addImg(a, scroll) {
  if (!pid) { setStatus('Open a project first'); return; }
  snap('Add image'); clearSel();
  const T = total(), start = +Math.min(head, Math.max(0, T - 0.5)).toFixed(2);
  const nat = a.w && a.h ? a.w / a.h : 1, ca = canvasAspect();
  let w = 0.4; if (w * ca / nat > 0.5) w = 0.5 * nat / ca;   // canvas එකේ උස භාගයකට වඩා නොවෙන්න
  const t = normI({ id: uid(), z: nextZ(), asset: a.id, x: 0.5, y: 0.5, w: +w.toFixed(3), op: 1, start, dur: +Math.max(0.5, Math.min(a.vid ? (a.duration || 3) : 3, T - start)).toFixed(2) });
  if (scroll) {   // scrolling logo: පොඩි size, පහළට ළඟින්, video end එක දක්වා, වමට යනවා
    t.w = +Math.min(t.w, 0.2).toFixed(3); t.y = 0.9; t.scr = -1; t.spd = 0.2; t.dur = +Math.max(0.5, T - start).toFixed(2);
  }
  imgs.push(t); selImg = t.id; changed();
  if (head < t.start || head >= t.start + t.dur) seek(t.start + 0.01);   // playhead එක image range එක ඇතුළට
}
function delImg() {
  if (!selImg) return; snap('Delete image');
  const t = curImg(), g = t?.grp, c = g ? grpCenter(grpList(t)) : null, w = t?.w;
  imgs = imgs.filter(x => x.id !== selImg); selImg = null;
  if (g) { const rest = imgs.filter(x => x.grp === g); if (rest.length) layoutGrp(rest, c.cx, c.cy, w); }   // ඉතිරි emoji ටික ආයෙත් center
  changed();
}

// ----- preview: move (magnetic: center / edges / grid) / FREE resize (corner + side handles) -----
// Shared by image / video / emoji overlays and shapes.
//  · drag the item = move anywhere (it may even leave the canvas a bit) · Alt / the 🧲 button = no magnetic snapping
//  · side handle = stretch one direction only · corner handle = stretch width + height freely
//  · hold Shift (or tick "Keep proportions") = keep the proportions
const MINBOX = 0.02, OUTMIN = -0.3, OUTMAX = 1.3;
function startBoxDrag(e, el, t, cfg) {
  const handle = e.target.closest('.th')?.dataset.h;
  const R = stage.getBoundingClientRect(), W = R.width, H = R.height;
  const px0 = e.clientX, py0 = e.clientY;
  const bw = el.offsetWidth || 1, bh = el.offsetHeight || 1;
  const sc = !!cfg.scroll && scrDir(t), off = sc ? scrOff(t) : 0, scv = !!cfg.scroll && scrV(t), offY = scv ? scrOffY(t) : 0;
  const x0 = cfg.scroll ? dispX(t, t.w) : t.x, y0 = cfg.scroll ? dispY(t, imHf(t)) : t.y;   // scroll item: drag from where it is NOW, t.x / t.y = its starting point
  const setX = cx => { t.x = sc ? wrapX(cx - off, t.w) : cx; };
  const setY = cy => { t.y = scv ? wrapX(cy - offY, cfg.hf(t)) : cy; };
  let moved = false;
  el.setPointerCapture?.(e.pointerId);
  const mv = ev => {
    const dx = ev.clientX - px0, dy = ev.clientY - py0;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    if (!moved) { snap((handle ? 'Resize ' : 'Move ') + cfg.name); moved = true; }
    if (handle) {
      const l = handle.includes('l'), r = handle.includes('r'), tp = handle.includes('t'), b = handle.includes('b'), corner = (l || r) && (tp || b);
      const cx0 = x0 * W, cy0 = y0 * H, L = cx0 - bw / 2, Rt = cx0 + bw / 2, T = cy0 - bh / 2, B = cy0 + bh / 2;
      const px = ev.clientX - R.left, py = ev.clientY - R.top, MN = MINBOX * Math.min(W, H);
      let nL = L, nR = Rt, nT = T, nB = B;
      if (l) nL = Math.min(px, Rt - MN); if (r) nR = Math.max(px, L + MN);   // free: only the dragged edges move
      if (tp) nT = Math.min(py, B - MN); if (b) nB = Math.max(py, T + MN);
      const keep = ev.shiftKey || !!t.lock;
      if (keep) {
        if (corner) {   // opposite corner stays fixed, scale along the diagonal
          const sx = l ? -1 : 1, sy = tp ? -1 : 1, fx = l ? Rt : L, fy = tp ? B : T, vx = sx * bw, vy = sy * bh;
          const k = clampN(((px - fx) * vx + (py - fy) * vy) / (vx * vx + vy * vy), 0.05, 30), nw = bw * k, nh = bh * k;
          nL = sx > 0 ? fx : fx - nw; nR = nL + nw; nT = sy > 0 ? fy : fy - nh; nB = nT + nh;
        } else if (l || r) {   // side: scale both, the other axis stays centered
          const k = (nR - nL) / bw, nh = bh * k; nT = cy0 - nh / 2; nB = cy0 + nh / 2;
        } else {
          const k = (nB - nT) / bh, nw = bw * k; nL = cx0 - nw / 2; nR = cx0 + nw / 2;
        }
      }
      const newW = nR - nL, newH = nB - nT;
      t.w = clampN(newW / W, MINBOX, 6);
      if (cfg.alwaysH || !keep || +t.h > 0) t.h = clampN(newH / H, MINBOX, 8); else t.h = 0;   // an image keeps "auto height" only while it is resized proportionally
      setX((nL + nR) / 2 / W); setY((nT + nB) / 2 / H); guides(null, null);
    } else {
      let nx = clampN(x0 + dx / W, OUTMIN, OUTMAX), ny = clampN(y0 + dy / H, OUTMIN, OUTMAX), gv = null, gh = null;
      if (snapOn && !ev.altKey) {
        const vl = [{ v: 0.5, center: true }, { v: 0 }, { v: 1 }], hl = [{ v: 0.5, center: true }, { v: 0 }, { v: 1 }];
        if (gridOn) for (const v of [1 / 3, 2 / 3]) { vl.push({ v }); hl.push({ v }); }
        const a = snap1(nx, bw / W / 2, vl, 7 / W), b = snap1(ny, bh / H / 2, hl, 7 / H);
        nx = a.c; ny = b.c; gv = a.line; gh = b.line;
      }
      setX(nx); setY(ny); guides(gv, gh);
    }
    cfg.place(el, t);
    cfg.sync(t, true);
    touch();
  };
  const up = () => {
    el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    guides(null, null);
    if (moved) changed();
  };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}

imov.addEventListener('pointerdown', e => {
  const el = e.target.closest('.im'); if (!el || e.button) return;
  const t = imgs.find(x => x.id === el.dataset.id); if (!t) return;
  e.preventDefault(); e.stopPropagation();
  if (selImg !== t.id) { clearSel(); selImg = t.id; render(); }
  if (!t.grp) { startBoxDrag(e, el, t, { name: 'image', place: placeImg, sync: syncImg, scroll: true, hf: imHf }); return; }
  // ----- emoji group: spacing + size fixed, the group moves / scales as a whole (proportional) -----
  const handle = e.target.closest('.th')?.dataset.h;
  const R = stage.getBoundingClientRect(), W = R.width, H = R.height;
  const px0 = e.clientX, py0 = e.clientY, w0 = t.w, bh = el.offsetHeight;
  const list = grpList(t), gc = grpCenter(list);
  const gd0 = Math.hypot(e.clientX - R.left - gc.cx * W, e.clientY - R.top - gc.cy * H) || 1;
  let moved = false;
  el.setPointerCapture?.(e.pointerId);
  const mv = ev => {
    const dx = ev.clientX - px0, dy = ev.clientY - py0;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    if (!moved) { snap(handle ? 'Resize image' : 'Move image'); moved = true; }
    if (handle) {   // group size: group center fixed, හැම emoji එකම එකපාර
      const k = Math.max(0.05, Math.min(10, Math.hypot(ev.clientX - R.left - gc.cx * W, ev.clientY - R.top - gc.cy * H) / gd0));
      layoutGrp(list, gc.cx, gc.cy, w0 * k);
    } else {        // group move: මුළු group එකම magnetic center එකට
      let nx = clampN(gc.cx + dx / W, OUTMIN, OUTMAX), ny = clampN(gc.cy + dy / H, OUTMIN, OUTMAX), gv = null, gh = null;
      if (snapOn && !ev.altKey) {
        const vl = [{ v: 0.5, center: true }, { v: 0 }, { v: 1 }], hl = [{ v: 0.5, center: true }, { v: 0 }, { v: 1 }];
        if (gridOn) for (const v of [1 / 3, 2 / 3]) { vl.push({ v }); hl.push({ v }); }
        const a = snap1(nx, grpSpan(list.length, t.w) / 2, vl, 7 / W), b = snap1(ny, bh / H / 2, hl, 7 / H);
        nx = a.c; ny = b.c; gv = a.line; gh = b.line;
      }
      layoutGrp(list, nx, ny, t.w); guides(gv, gh);
    }
    placeGrpEls(list);
    if (selImg === t.id) syncImg(t, true);
    touch();
  };
  const up = () => {
    el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    guides(null, null);
    if (moved) changed();
  };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
});

// ----- inspector -----
function syncImg(t, light) {
  if (document.activeElement !== $('#istart')) $('#istart').value = (+t.start).toFixed(2);
  if (document.activeElement !== $('#idur')) $('#idur').value = (+t.dur).toFixed(2);
  const sz = Math.round(t.w * 100), op = Math.round(t.op * 100);
  $('#isize').value = sz; $('#isizev').textContent = sz + '%';
  const iwp = Math.round(t.w * 100), ihp = Math.round(imHf(t) * 100);   // free size: width % of the canvas width · height % of the canvas height
  $('#iw').value = clampN(iwp, 2, 300); $('#iwv').textContent = iwp + '%'; $('#ih').value = clampN(ihp, 2, 300); $('#ihv').textContent = ihp + '%';
  $('#ilock').checked = !!t.lock;
  $('#iop').value = op; $('#iopv').textContent = op + '%';
  const rd = Math.round((t.rad || 0) * 100), px = Math.round(t.x * 100), py = Math.round(t.y * 100), sd = scrDir(t), sv = scrV(t), ss = Math.round((t.spd || 0.2) * 100);
  $('#irad').value = rd; $('#iradv').textContent = rd + '%';
  $('#ipx').value = px; $('#ipxv').textContent = px + '%'; $('#ipy').value = py; $('#ipyv').textContent = py + '%';
  $('#ispd').value = ss; $('#ispdv').textContent = ss + '%/s';
  [['#iscr0', !sd && !sv], ['#iscrL', sd < 0], ['#iscrR', sd > 0], ['#iscrU', sv < 0], ['#iscrD', sv > 0]].forEach(([id, on]) => $(id).classList.toggle('on', on));
  const grouped = !!t.grp && grpList(t).length > 1;   // emoji group = scroll නෑ
  ['#iscr0', '#iscrL', '#iscrR', '#iscrU', '#iscrD', '#ipx', '#ipy', '#iw', '#ih', '#ilock'].forEach(id => $(id).disabled = grouped);
  $('#irst').disabled = grouped || !(+t.h > 0);
  $('#ispd').disabled = grouped || !(sd || sv); $('#iscrnote').textContent = grouped ? 'Emoji groups have no scroll / position sliders (use Ungroup)' : (sd || sv) ? (sv ? 'Y' : 'X') + ' = starting point · you can also drag it in the preview' : '';
  if (light) return;
  const n = grpList(t).length;
  $('#iname').textContent = imLabel(t) + (t.grp && n > 1 ? ` · group (${n})` : '');
  $('#iungrp').hidden = !(t.grp && n > 1);
}
function editI(label, fn) { const t = curImg(); if (!t) return; snapT(label); fn(t); syncGrpTime(t); changed(); }
$('#iop').oninput = e => editI('Image opacity', t => grpList(t).forEach(m => m.op = clampN(+e.target.value / 100, 0, 1)));
$('#isize').oninput = e => editI('Image size', t => { const w = Math.max(0.03, +e.target.value / 100); if (t.grp) { const l = grpList(t), c = grpCenter(l); layoutGrp(l, c.cx, c.cy, w); } else { const k = w / t.w; if (+t.h > 0) t.h = clampN(t.h * k, MINBOX, 8); t.w = w; } });
// free size: Width / Height are independent (unless "Keep proportions" is ticked)
$('#iw').oninput = e => editI('Image width', t => { const w = clampN(+e.target.value / 100, MINBOX, 6); if (t.lock && +t.h > 0) t.h = clampN(t.h * w / t.w, MINBOX, 8); t.w = w; });
$('#ih').oninput = e => editI('Image height', t => { const h = clampN(+e.target.value / 100, MINBOX, 8); if (t.lock) { t.w = clampN(t.w * h / imHf(t), MINBOX, 6); if (+t.h > 0) t.h = h; } else t.h = h; });
$('#ilock').onchange = e => editI('Keep proportions', t => t.lock = e.target.checked);
$('#irst').onclick = e => { editI('Original ratio', t => { t.h = 0; }); e.target.blur(); };
['#iop', '#isize', '#iw', '#ih'].forEach(id => $(id).onchange = e => e.target.blur());
$('#irad').oninput = e => editI('Image corner radius', t => t.rad = clampN(+e.target.value / 100, 0, 0.5));
$('#ipx').oninput = e => editI('Image X', t => t.x = +e.target.value / 100);
$('#ipy').oninput = e => editI('Image Y', t => t.y = +e.target.value / 100);
$('#ispd').oninput = e => editI('Image scroll speed', t => t.spd = clampN(+e.target.value / 100, 0.02, 1.5));
['#irad', '#ipx', '#ipy', '#ispd'].forEach(id => $(id).onchange = e => e.target.blur());
$('#iscr0').onclick = e => { editI('Image scroll', t => { t.scr = 0; t.scv = 0; }); e.target.blur(); };
$('#iscrL').onclick = e => { editI('Image scroll', t => { t.scr = -1; t.scv = 0; t.spd = t.spd || 0.2; }); e.target.blur(); };
$('#iscrR').onclick = e => { editI('Image scroll', t => { t.scr = 1; t.scv = 0; t.spd = t.spd || 0.2; }); e.target.blur(); };
$('#iscrU').onclick = e => { editI('Image scroll', t => { t.scr = 0; t.scv = -1; t.spd = t.spd || 0.2; }); e.target.blur(); };   // පහළින් උඩට
$('#iscrD').onclick = e => { editI('Image scroll', t => { t.scr = 0; t.scv = 1; t.spd = t.spd || 0.2; }); e.target.blur(); };    // උඩින් පහළට
$('#iwhole').onclick = e => { editI('Image whole video', t => { t.start = 0; t.dur = +Math.max(0.2, total()).toFixed(2); }); e.target.blur(); };
$('#istart').onchange = e => editI('Image time', t => t.start = Math.max(0, +e.target.value || 0));
$('#idur').onchange = e => editI('Image time', t => t.dur = Math.max(0.2, +e.target.value || 3));
$('#ifit').onclick = e => { editI('Image → video end', t => { t.start = Math.min(t.start, Math.max(0, total() - MINT)); t.dur = Math.max(MINT, total() - t.start); }); e.target.blur(); };
$('#iend').onclick = e => { editI('Image → playhead', t => { t.dur = Math.max(MINT, head - t.start); }); e.target.blur(); };
$('#icx').onclick = e => { editI('Center image X', t => { if (t.grp) { const l = grpList(t), c = grpCenter(l); layoutGrp(l, 0.5, c.cy, t.w); } else t.x = 0.5; }); e.target.blur(); };
$('#icy').onclick = e => { editI('Center image Y', t => { if (t.grp) { const l = grpList(t), c = grpCenter(l); layoutGrp(l, c.cx, 0.5, t.w); } else t.y = 0.5; }); e.target.blur(); };
$('#idup').onclick = () => { const t = curImg(); if (!t) return; snap('Duplicate image'); const n = { ...t, id: uid(), z: nextZ(), grp: '', x: Math.min(1, t.x + 0.03), y: Math.min(1, t.y + 0.03) }; imgs.push(n); selImg = n.id; changed(); };
$('#idel').onclick = () => delImg();
$('#iungrp').onclick = () => { const t = curImg(); if (!t?.grp) return; snap('Ungroup emoji'); imgs.forEach(x => { if (x.grp === t.grp) x.grp = ''; }); changed(); };

// ================= shapes =================
// Vector shapes: rectangle (corner radius), circle / ellipse, triangle, diamond, pentagon, hexagon, star, heart, arrow, line.
// Free resize (width and height independent) · fill + stroke colors · opacity · timing · layer order.
// w = width (fraction of the canvas width) · h = height (fraction of the canvas height) · x / y = center (0..1)
// shapeD() draws the SAME path in the preview (SVG) and in the export (canvas → PNG), so both look identical.
const SHAPES = { rect: 'Rectangle', ellipse: 'Circle / ellipse', triangle: 'Triangle', diamond: 'Diamond', pentagon: 'Pentagon', hexagon: 'Hexagon', star: 'Star', heart: 'Heart', arrow: 'Arrow', line: 'Line' };
const SHDEF = { type: 'rect', x: 0.5, y: 0.5, w: 0.28, h: 0.28, lock: false, fill: '#4f86f5', fop: 1, sc: '#ffffff', sw: 0, op: 1, rad: 0, start: 0, dur: 3 };
const normS = t => ({ ...SHDEF, ...t });
const curShape = () => shapes.find(x => x.id === selShape);
let shStyle = {}; try { shStyle = JSON.parse(localStorage.shStyle || '{}'); } catch {}
const rememberS = t => { shStyle = { fill: t.fill, fop: t.fop, sc: t.sc, sw: t.sw }; localStorage.shStyle = JSON.stringify(shStyle); };

const f2 = n => +(+n).toFixed(2);
function polyD(pts, x0, y0, bw, bh) {   // points (any units) → scaled to fill the box exactly
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), mnx = Math.min(...xs), mny = Math.min(...ys);
  const sx = bw / ((Math.max(...xs) - mnx) || 1), sy = bh / ((Math.max(...ys) - mny) || 1);
  return 'M' + pts.map(p => `${f2(x0 + (p[0] - mnx) * sx)} ${f2(y0 + (p[1] - mny) * sy)}`).join('L') + 'Z';
}
const ngonPts = (n, rot) => Array.from({ length: n }, (_, i) => { const a = rot + i * 2 * Math.PI / n; return [Math.cos(a), Math.sin(a)]; });
const starPts = (n, ri) => Array.from({ length: n * 2 }, (_, i) => { const a = -Math.PI / 2 + i * Math.PI / n, r = i % 2 ? ri : 1; return [r * Math.cos(a), r * Math.sin(a)]; });
const HEART = [[50, 90], [10, 60, 0, 35, 0, 25], [0, 8, 14, 0, 27, 0], [38, 0, 46, 6, 50, 14], [54, 6, 62, 0, 73, 0], [86, 0, 100, 8, 100, 25], [100, 35, 90, 60, 50, 90]];
function shapeD(type, w, h, inset, rad) {   // path (px) of a shape inside a w × h box; stroke is drawn INSIDE the box (inset = stroke / 2)
  const i = Math.max(0, inset || 0), bw = Math.max(1, w - 2 * i), bh = Math.max(1, h - 2 * i), x0 = i, y0 = i, x1 = x0 + bw, y1 = y0 + bh, cx = x0 + bw / 2, cy = y0 + bh / 2;
  switch (type) {
    case 'ellipse': { const rx = bw / 2, ry = bh / 2; return `M${f2(cx - rx)} ${f2(cy)}A${f2(rx)} ${f2(ry)} 0 1 0 ${f2(cx + rx)} ${f2(cy)}A${f2(rx)} ${f2(ry)} 0 1 0 ${f2(cx - rx)} ${f2(cy)}Z`; }
    case 'triangle': return `M${f2(cx)} ${f2(y0)}L${f2(x1)} ${f2(y1)}L${f2(x0)} ${f2(y1)}Z`;
    case 'diamond': return `M${f2(cx)} ${f2(y0)}L${f2(x1)} ${f2(cy)}L${f2(cx)} ${f2(y1)}L${f2(x0)} ${f2(cy)}Z`;
    case 'pentagon': return polyD(ngonPts(5, -Math.PI / 2), x0, y0, bw, bh);
    case 'hexagon': return polyD(ngonPts(6, 0), x0, y0, bw, bh);
    case 'star': return polyD(starPts(5, 0.42), x0, y0, bw, bh);
    case 'arrow': return polyD([[0, 0.3], [0.58, 0.3], [0.58, 0], [1, 0.5], [0.58, 1], [0.58, 0.7], [0, 0.7]], x0, y0, bw, bh);
    case 'heart': {
      const X = v => f2(x0 + v / 100 * bw), Y = v => f2(y0 + v / 90 * bh);
      return `M${X(HEART[0][0])} ${Y(HEART[0][1])}` + HEART.slice(1).map(c => `C${X(c[0])} ${Y(c[1])} ${X(c[2])} ${Y(c[3])} ${X(c[4])} ${Y(c[5])}`).join('') + 'Z';
    }
    default: {   // rect (corner radius = fraction of the short side) · line = rounded bar
      const r = f2(Math.min(bw, bh) * (type === 'line' ? 0.5 : clampN(+rad || 0, 0, 0.5)));
      if (r < 0.5) return `M${f2(x0)} ${f2(y0)}H${f2(x1)}V${f2(y1)}H${f2(x0)}Z`;
      return `M${f2(x0 + r)} ${f2(y0)}H${f2(x1 - r)}A${r} ${r} 0 0 1 ${f2(x1)} ${f2(y0 + r)}V${f2(y1 - r)}A${r} ${r} 0 0 1 ${f2(x1 - r)} ${f2(y1)}H${f2(x0 + r)}A${r} ${r} 0 0 1 ${f2(x0)} ${f2(y1 - r)}V${f2(y0 + r)}A${r} ${r} 0 0 1 ${f2(x0 + r)} ${f2(y0)}Z`;
    }
  }
}
function shapeIcon(type, fill, sc, big) {   // small SVG icon (shape buttons + layer thumbnails)
  const line = type === 'line', w = 20, h = line ? 6 : 20, d = shapeD(type, w, h, 0, 0.18);
  return `<svg viewBox="0 0 24 24"><g transform="translate(2,${line ? 9 : 2})"><path d="${d}" fill="${fill || 'none'}" stroke="${fill ? 'none' : (sc || '#c9cedc')}" stroke-width="1.6" stroke-linejoin="round"/></g></svg>`;
}
$('#shgrid').innerHTML = Object.entries(SHAPES).map(([k, n]) => `<button data-sh="${k}" title="Add ${esc(n)}">${shapeIcon(k, '#9db8f5')}<span>${esc(n.split(' ')[0])}</span></button>`).join('');
$('#shtype').innerHTML = Object.entries(SHAPES).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('');
$('#shgrid').onclick = e => { const b = e.target.closest('button'); if (b) { addShape(b.dataset.sh); b.blur(); } };

const shov = $('#shov');
function placeShape(el, t) {
  const W = stage.clientWidth || 1, H = stage.clientHeight || 1, pw = Math.max(1, t.w * W), ph = Math.max(1, t.h * H), sw = (+t.sw || 0) * W;
  Object.assign(el.style, { zIndex: Z0 + (t.z | 0), left: t.x * 100 + '%', top: t.y * 100 + '%', width: t.w * 100 + '%', height: t.h * 100 + '%' });
  const svg = el.firstChild, path = svg.firstChild;
  svg.setAttribute('viewBox', `0 0 ${f2(pw)} ${f2(ph)}`); svg.setAttribute('preserveAspectRatio', 'none');
  path.setAttribute('d', shapeD(t.type, pw, ph, sw / 2, t.rad));
  path.setAttribute('fill', t.fill || 'none'); path.setAttribute('fill-opacity', t.fop ?? 1);
  path.setAttribute('stroke', sw > 0.01 ? t.sc : 'none'); path.setAttribute('stroke-width', f2(sw)); path.setAttribute('stroke-linejoin', 'round');
  el.classList.toggle('sel', t.id === selShape);
}
function renderShapes() {
  if (!stage.clientWidth) return;
  shov.hidden = cropMode;
  const have = new Map([...shov.children].map(e => [e.dataset.id, e]));
  shapes.forEach(t => {
    let el = have.get(t.id); have.delete(t.id);
    if (!el) {
      el = document.createElement('div'); el.className = 'sp'; el.dataset.id = t.id;
      el.innerHTML = '<svg><path/></svg>' + HANDLES8.map(h => `<i class="th" data-h="${h}"></i>`).join('');
      shov.appendChild(el);
    }
    placeShape(el, t);
  });
  have.forEach(e => e.remove());
  applyShapes(true);
}
function applyShapes(force) {   // shape එක පෙන්නන්නේ එහි time range එකේදී (select කරලා තියෙන එක අඩු opacity එකෙන් හැමවෙලේම)
  for (const el of shov.children) {
    const t = shapes.find(x => x.id === el.dataset.id); if (!t) continue;
    const on = head >= t.start - 1e-6 && head < t.start + t.dur - 1e-6, v = on ? 1 : t.id === selShape ? 2 : 0;
    const o = v === 2 ? 0.35 : t.op;
    if (force || el._v !== v || el._o !== o) { el._v = v; el._o = o; el.style.display = v ? '' : 'none'; el.style.opacity = o; }
  }
}
shov.addEventListener('pointerdown', e => {
  const el = e.target.closest('.sp'); if (!el || e.button) return;
  const t = shapes.find(x => x.id === el.dataset.id); if (!t) return;
  e.preventDefault(); e.stopPropagation();
  if (selShape !== t.id) { clearSel(); selShape = t.id; render(); }
  startBoxDrag(e, el, t, { name: 'shape', place: placeShape, sync: syncShape, scroll: false, alwaysH: true, hf: x => x.h });
});

function addShape(type) {
  if (!pid) { setStatus('Open a project first'); return; }
  snap('Add shape'); clearSel();
  const T = total(), start = +Math.min(head, Math.max(0, T - 0.5)).toFixed(2), asp = outAspect() || 1;
  const w = type === 'line' ? 0.4 : 0.28, h = type === 'line' ? 0.012 : Math.min(0.9, w * asp);   // new shapes are square in pixels
  const t = normS({ ...shStyle, id: uid(), z: nextZ(), type, x: 0.5, y: 0.5, w, h: +h.toFixed(4), start, dur: +Math.max(0.5, Math.min(3, T - start)).toFixed(2) });
  shapes.push(t); selShape = t.id; changed();
  if (head < t.start || head >= t.start + t.dur) seek(t.start + 0.01);
}
function delShape() { if (!selShape) return; snap('Delete shape'); shapes = shapes.filter(x => x.id !== selShape); selShape = null; changed(); }

// ----- shape inspector -----
const PAL = ['#ffffff', '#000000', '#ff3b30', '#ffd60a', '#34c759', '#0a84ff', '#ff9f0a', '#ff2d92', '#bf5af2', '#00e5ff'];
function colorRow(id, none, label, get, set) {   // swatches + custom color picker
  const el = $('#' + id);
  el.innerHTML = (none ? '<button class="none" data-c="" title="No fill">None</button>' : '') + PAL.map(c => `<button data-c="${c}" style="background:${c}" title="${c}"></button>`).join('') + '<input type="color" class="cc" value="#4f86f5" title="Custom color">';
  el.onclick = e => { const b = e.target.closest('button'); if (b) editS(label, t => set(t, b.dataset.c)); };
  el.querySelector('input').oninput = e => editS(label, t => set(t, e.target.value));
  el._sync = t => { const v = get(t) || ''; el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.c === v)); const ci = el.querySelector('input'); if (v) ci.value = v; };
}
function editS(label, fn) { const t = curShape(); if (!t) return; snapT(label); fn(t); rememberS(t); changed(); }
colorRow('shfill', true, 'Shape fill', t => t.fill, (t, c) => { t.fill = c; if (c && !(t.fop > 0)) t.fop = 1; });
colorRow('shsc', false, 'Shape stroke color', t => t.sc, (t, c) => { t.sc = c; if (!(t.sw > 0)) t.sw = 0.006; });
function syncShape(t, light) {   // light = drag වෙලාවේ sliders / numbers විතරයි
  if (document.activeElement !== $('#shstart')) $('#shstart').value = (+t.start).toFixed(2);
  if (document.activeElement !== $('#shdur')) $('#shdur').value = (+t.dur).toFixed(2);
  const wp = Math.round(t.w * 100), hp = Math.round(t.h * 100), px = Math.round(t.x * 100), py = Math.round(t.y * 100);
  $('#shw').value = clampN(wp, 2, 300); $('#shwv').textContent = wp + '%'; $('#shh').value = clampN(hp, 2, 300); $('#shhv').textContent = hp + '%';
  $('#shpx').value = clampN(px, -30, 130); $('#shpxv').textContent = px + '%'; $('#shpy').value = clampN(py, -30, 130); $('#shpyv').textContent = py + '%';
  if (light) return;
  const fo = Math.round((t.fop ?? 1) * 100), op = Math.round(t.op * 100), rd = Math.round((t.rad || 0) * 100);
  $('#shfop').value = fo; $('#shfopv').textContent = fo + '%';
  $('#shsw').value = clampN(Math.round(t.sw * 2000), 0, 100); $('#shswv').textContent = (t.sw * 100).toFixed(1) + '%';
  $('#shrad').value = rd; $('#shradv').textContent = rd + '%'; $('#shrad').disabled = t.type !== 'rect';
  $('#shop').value = op; $('#shopv').textContent = op + '%';
  $('#shtype').value = t.type; $('#shlock').checked = !!t.lock;
  $('#shfill')._sync(t); $('#shsc')._sync(t);
}
$('#shtype').onchange = e => { editS('Shape type', t => t.type = e.target.value); e.target.blur(); };
$('#shfop').oninput = e => editS('Fill opacity', t => t.fop = clampN(+e.target.value / 100, 0, 1));
$('#shsw').oninput = e => editS('Stroke width', t => t.sw = clampN(+e.target.value / 2000, 0, 0.05));
$('#shrad').oninput = e => editS('Corner radius', t => t.rad = clampN(+e.target.value / 100, 0, 0.5));
$('#shop').oninput = e => editS('Shape opacity', t => t.op = clampN(+e.target.value / 100, 0, 1));
$('#shw').oninput = e => editS('Shape width', t => { const w = clampN(+e.target.value / 100, MINBOX, 6); if (t.lock) t.h = clampN(t.h * w / t.w, MINBOX, 8); t.w = w; });
$('#shh').oninput = e => editS('Shape height', t => { const h = clampN(+e.target.value / 100, MINBOX, 8); if (t.lock) t.w = clampN(t.w * h / t.h, MINBOX, 6); t.h = h; });
$('#shlock').onchange = e => editS('Keep proportions', t => t.lock = e.target.checked);
$('#shpx').oninput = e => editS('Shape X', t => t.x = +e.target.value / 100);
$('#shpy').oninput = e => editS('Shape Y', t => t.y = +e.target.value / 100);
['#shfop', '#shsw', '#shrad', '#shop', '#shw', '#shh', '#shpx', '#shpy'].forEach(id => $(id).onchange = e => e.target.blur());
$('#shcx').onclick = e => { editS('Center shape X', t => t.x = 0.5); e.target.blur(); };
$('#shcy').onclick = e => { editS('Center shape Y', t => t.y = 0.5); e.target.blur(); };
$('#shsq').onclick = e => { editS('Square shape', t => { t.h = clampN(t.w * (stage.clientWidth || 1) / (stage.clientHeight || 1), MINBOX, 8); }); e.target.blur(); };
$('#shstart').onchange = e => editS('Shape time', t => t.start = Math.max(0, +e.target.value || 0));
$('#shdur').onchange = e => editS('Shape time', t => t.dur = Math.max(0.2, +e.target.value || 3));
$('#shwhole').onclick = e => { editS('Shape whole video', t => { t.start = 0; t.dur = +Math.max(0.2, total()).toFixed(2); }); e.target.blur(); };
$('#shfit').onclick = e => { editS('Shape → video end', t => { t.start = Math.min(t.start, Math.max(0, total() - MINT)); t.dur = Math.max(MINT, total() - t.start); }); e.target.blur(); };
$('#shend').onclick = e => { editS('Shape → playhead', t => { t.dur = Math.max(MINT, head - t.start); }); e.target.blur(); };
$('#shdup').onclick = () => { const t = curShape(); if (!t) return; snap('Duplicate shape'); const n = { ...t, id: uid(), z: nextZ(), x: t.x + 0.03, y: t.y + 0.03 }; shapes.push(n); selShape = n.id; changed(); };
$('#shdel').onclick = () => delShape();

// ----- export: shape → PNG at the OUTPUT size (same path as the preview) -----
function outAspect() {   // canvas ratio (w / h) of the exported video
  if (canvas === 'orig') return srcA();
  if (canvas === 'auto') { const cr = clips[0]?.crop; return cr ? cr.w * srcA() / cr.h : srcA(); }
  const [a, b] = canvas.split(':').map(Number); return a / b;
}
function renderShapePng(t, W, H) {
  const w = Math.max(2, Math.round(t.w * W)), h = Math.max(2, Math.round(t.h * H)), sw = (+t.sw || 0) * W;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), p = new Path2D(shapeD(t.type, w, h, sw / 2, t.rad));
  if (t.fill) { g.globalAlpha = t.fop ?? 1; g.fillStyle = t.fill; g.fill(p); g.globalAlpha = 1; }
  if (sw > 0.01) { g.strokeStyle = t.sc; g.lineWidth = sw; g.lineJoin = 'round'; g.stroke(p); }
  return { png: c.toDataURL('image/png'), wf: t.w, hf: t.h };
}

// ================= layers panel (what is in front / behind — drag to reorder) =================
const layersEl = $('#layers');
let layerSig = '', layerClickSkip = false;
function unitInfo(u) {
  const o = u.items[u.items.length - 1];
  if (u.k === 'tx') return { th: '<b>T</b>', name: o.text.split('\n')[0] || '(empty)', tag: 'Text' + (isScr(o) ? ' · scrolling' : '') };
  if (u.k === 'sh') return { th: shapeIcon(o.type, o.fill, o.sc), name: SHAPES[o.type] || o.type, tag: 'Shape' };
  if (o.emoji) { const n = u.items.length; return { th: `<img src="/api/emoji/${o.emoji}.png" alt="">`, name: n > 1 ? `Emoji group (${n})` : imLabel(o), tag: 'Emoji' }; }
  const a = asset(o.asset);
  return { th: a ? `<img src="/api/assets/${a.id}/${a.vid ? 'thumb' : 'file'}" alt="">` : '🖼', name: a?.name || 'missing', tag: a?.vid ? 'Video' : 'Image' };
}
function renderLayers() {
  if (!layersEl) return;
  const units = layerUnits(), cs = selItem();
  const rows = units.map(u => ({ u, info: unitInfo(u), sel: !!cs && u.items.includes(cs) }));
  const sig = JSON.stringify([rows.map(r => [r.info.th, r.info.name, r.info.tag, r.sel, r.u.items[0].start, r.u.items[0].dur]), sel >= 0, clips.length, pid]);
  if (sig === layerSig) return;
  layerSig = sig;
  const tm = t => `${(+t.start).toFixed(1)}–${(t.start + t.dur).toFixed(1)}s`;
  layersEl.innerHTML = (rows.length ? '' : '<div class="lempty">No layers yet — add text, images, videos, shapes or emoji.</div>') +
    rows.map((r, i) => `<div class="lrow${r.sel ? ' sel' : ''}" data-i="${i}" title="${esc(r.info.name)}"><span class="lh" title="Drag to reorder">⠿</span><span class="lth">${r.info.th}</span>` +
      `<span class="lmid"><span class="ln">${esc(r.info.name)}</span><span class="lt">${r.info.tag} · ${tm(r.u.items[0])}</span></span>` +
      `<button class="lb" data-m="up" title="Bring forward">▲</button><button class="lb" data-m="down" title="Send backward">▼</button></div>`).join('') +
    `<div class="lrow base${sel >= 0 ? ' sel' : ''}" data-base="1" title="The main video is always the bottom layer"><span class="lh"></span><span class="lth">🎞</span><span class="lmid"><span class="ln">Main video</span><span class="lt">Base layer · always at the bottom</span></span></div>`;
}
function selectUnit(u) {
  const o = u.items[u.items.length - 1];
  clearSel(); if (u.k === 'tx') selText = o.id; else if (u.k === 'sh') selShape = o.id; else selImg = o.id;
  render();
  if (head < o.start || head >= o.start + o.dur) seek(o.start + 0.01);
}
layersEl.addEventListener('click', e => {
  if (layerClickSkip) { layerClickSkip = false; return; }
  const row = e.target.closest('.lrow'); if (!row) return;
  if (row.dataset.base) { if (clips.length) { const i = tlToClip(head).i; clearSel(); sel = i; render(); } return; }
  const units = layerUnits(), i = +row.dataset.i, u = units[i]; if (!u) return;
  const m = e.target.closest('.lb')?.dataset.m;
  if (!m) { selectUnit(u); return; }
  const j = m === 'up' ? i - 1 : i + 1; if (j < 0 || j >= units.length) return;   // ▲ = one step toward the front
  snap('Layer order'); units.splice(i, 1); units.splice(j, 0, u); applyUnits(units); changed();
});
layersEl.addEventListener('pointerdown', e => {   // drag a row up / down to reorder
  const row = e.target.closest('.lrow');
  if (!row || row.dataset.base || e.button || e.target.closest('button')) return;
  const rows = [...layersEl.querySelectorAll('.lrow:not(.base)')], from = rows.indexOf(row);
  const y0 = e.clientY, drop = document.createElement('div'); drop.id = 'ldrop';
  let dragging = false, to = from;
  row.setPointerCapture?.(e.pointerId);
  const mv = ev => {
    if (!dragging) { if (Math.abs(ev.clientY - y0) < 5) return; dragging = true; row.classList.add('drag'); layersEl.appendChild(drop); }
    const others = rows.filter(r => r !== row);
    to = others.filter(r => { const b = r.getBoundingClientRect(); return ev.clientY > b.top + b.height / 2; }).length;   // slot among the other rows
    const ref = others[to], last = others[others.length - 1];
    drop.style.top = (ref ? ref.offsetTop - 3 : last ? last.offsetTop + last.offsetHeight + 1 : 0) + 'px';
    const lb = $('#libbody'), r = lb.getBoundingClientRect();   // auto-scroll the panel near its edges
    if (ev.clientY < r.top + 28) lb.scrollTop -= 12; else if (ev.clientY > r.bottom - 28) lb.scrollTop += 12;
  };
  const up = () => {
    row.removeEventListener('pointermove', mv); row.removeEventListener('pointerup', up); row.removeEventListener('pointercancel', up);
    drop.remove(); row.classList.remove('drag');
    if (!dragging) return;
    layerClickSkip = true; setTimeout(() => layerClickSkip = false, 60);
    if (to === from) return;
    const units = layerUnits(), [u] = units.splice(from, 1); units.splice(to, 0, u);
    snap('Reorder layers'); applyUnits(units); changed();
    toast('Layer order changed');
  };
  row.addEventListener('pointermove', mv); row.addEventListener('pointerup', up); row.addEventListener('pointercancel', up);
});

// ================= FX: grain / vintage / dust / glitch =================
const FXN = { grain: '🎞 Grain', vintage: '📼 Vintage', dust: '✨ Dust & scratches', glitch: '📺 Glitch', blur: '🌫 Blur (Gaussian)' };
const MAXBLUR = 7;
const FXDEF = { type: 'grain', start: 0, dur: 3, amt: 0.6 };
const normF = f => ({ ...FXDEF, ...f });
const curFx = () => fxs.find(x => x.id === selFx);

function addFx(type) {
  if (!pid) { setStatus('Open a project first'); return; }
  snap('Add ' + type); clearSel();
  if (type === 'blur' && fxs.filter(x => x.type === 'blur').length >= MAXBLUR) { toast(`Blur: at most ${MAXBLUR} items — edit or delete one of the existing blurs`); return; }
  const T = total(), whole = type !== 'glitch' && type !== 'blur';   // grain/vintage/dust = මුළු video එකටම; glitch / blur = playhead එකේ ඉඳන් තත්පර 1.5ක් (blur: Whole video button එකෙන් මුළු video එකටම)
  const start = whole ? 0 : Math.min(+head.toFixed(2), Math.max(0, T - 0.3));
  const f = { id: uid(), type, start, dur: whole ? T : Math.max(0.3, Math.min(1.5, T - start)), amt: type === 'glitch' ? 0.7 : type === 'blur' ? 0.35 : 0.6 };
  fxs.push(f); selFx = f.id; changed();
}
function delFx() { if (!selFx) return; snap('Delete effect'); fxs = fxs.filter(x => x.id !== selFx); selFx = null; changed(); }
function syncFx(f, light) {
  if (document.activeElement !== $('#famtn')) $('#famtn').value = Math.round(f.amt * 100);
  if (document.activeElement !== $('#fstart')) $('#fstart').value = (+f.start).toFixed(2);
  if (document.activeElement !== $('#fdur')) $('#fdur').value = (+f.dur).toFixed(2);
  if (light) return;
  $('#fname').textContent = FXN[f.type] || f.type;
  $('#famt').value = f.amt;
}
function editF(label, fn) { const f = curFx(); if (!f) return; snapT(label); fn(f); changed(); }
$('#fxbtns').onclick = e => { const b = e.target.closest('button'); if (b) { addFx(b.dataset.fx); b.blur(); } };
$('#famt').oninput = e => editF('Effect intensity', f => f.amt = clampN(+e.target.value, 0.01, 1.5));
$('#famt').onchange = e => e.target.blur();
$('#famtn').oninput = e => { const v = +e.target.value; if (v >= 1) editF('Effect intensity', f => f.amt = clampN(v / 100, 0.01, 1.5)); };
$('#famtn').onchange = e => { e.target.value = Math.round(clampN((+e.target.value || 60) / 100, 0.01, 1.5) * 100); };
$('#fstart').onchange = e => editF('Effect time', f => f.start = Math.max(0, +e.target.value || 0));
$('#fdur').onchange = e => editF('Effect time', f => f.dur = Math.max(0.1, +e.target.value || 1));
$('#ffull').onclick = e => { editF('Effect → whole video', f => { f.start = 0; f.dur = total(); }); e.target.blur(); };
$('#fend').onclick = e => { editF('Effect → video end', f => { f.start = Math.min(f.start, Math.max(0, total() - 0.1)); f.dur = Math.max(0.1, total() - f.start); }); e.target.blur(); };
$('#fdup').onclick = () => { const f = curFx(); if (!f) return; snap('Duplicate effect'); if (f.type === 'blur' && fxs.filter(x => x.type === 'blur').length >= MAXBLUR) { toast(`Blur: at most ${MAXBLUR} items`); return; }
  const n = { ...f, id: uid(), start: f.start + 0.3 }; fxs.push(n); selFx = n.id; changed(); };
$('#fdel').onclick = () => delFx();

// ----- FX preview (browser): export එකේ ffmpeg filters වලට සමාන look එකක් -----
// glitch burst schedule = backend hx() formula එකම (preview == export)
const hh = z => Math.abs(Math.sin(z) * 43758.5453) % 1;
const rng = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const vfx = { dirty: false }, glTmp = document.createElement('canvas');
const fxAt = type => {   // head එකේදී active effect එකේ intensity (නැත්නම් 0)
  let a = 0;
  for (const f of fxs) if (f.type === type && head >= f.start - 1e-6 && head < f.start + f.dur - 1e-6) a = Math.max(a, f.amt);
  return a;
};
function noiseTile() {
  const c = document.createElement('canvas'); c.width = c.height = 192;
  const g = c.getContext('2d'), im = g.createImageData(192, 192);
  for (let i = 0; i < im.data.length; i += 4) { const v = 128 + (Math.random() + Math.random() - 1) * 130; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
  g.putImageData(im, 0, 0); return c.toDataURL();
}
function drawDust(cv, W, H, a, k) {
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d'), r = rng(k * 7919 + 13), sc = W / 540;
  g.clearRect(0, 0, W, H);
  const n = Math.round(25 + 70 * a);
  for (let i = 0; i < n; i++) {   // සුදු + කළු දූවිලි
    const white = r() < 0.5, rad = (0.5 + r() * 1.6) * sc, al = (0.35 + 0.55 * r()) * (0.4 + 0.6 * a);
    g.fillStyle = white ? `rgba(255,255,255,${al})` : `rgba(0,0,0,${al})`;
    g.beginPath(); g.arc(r() * W, r() * H, rad, 0, 6.2832); g.fill();
  }
  const ns = r() < 0.25 + 0.6 * a ? 1 + Math.floor(r() * 2 * a + 0.5) : 0;   // සිරස් scratches
  g.lineWidth = Math.max(0.7, sc * 0.9);
  for (let i = 0; i < ns; i++) {
    const x = r() * W, y0 = r() * H * 0.5, ln = H * (0.3 + 0.5 * r());
    g.strokeStyle = `rgba(255,255,255,${0.25 + 0.4 * a})`;
    g.beginPath(); g.moveTo(x, y0); g.lineTo(x + (r() - 0.5) * 3 * sc, y0 + ln); g.stroke();
  }
}
function drawGlitch(cv, a, k, W, H) {   // RGB split + horizontal slice shift (video frame එකම canvas එකට අඳිනවා)
  const z = zmst; if (!z || !W || !H) return;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  if (glTmp.width !== W || glTmp.height !== H) { glTmp.width = W; glTmp.height = H; }
  const g = cv.getContext('2d'), tg = glTmp.getContext('2d');
  const rx = (z.r.x * z.Vw - z.cx) * z.s + z.tx, ry = (z.r.y * z.Vh - z.cy) * z.s + z.ty, rw = z.r.w * z.Vw * z.s, rh = z.r.h * z.Vh * z.s;
  const draw = (c, dx) => { c.save(); c.translate(dx, 0); c.translate(z.tx, z.ty); c.scale(z.s, z.s); c.translate(-z.cx, -z.cy); c.drawImage(video, 0, 0, z.Vw, z.Vh); c.restore(); };
  const rpx = Math.max(1, Math.round((3 + 14 * a) * W / 1080));
  g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, W, H);
  g.save(); g.beginPath(); g.rect(rx, ry, rw, rh); g.clip();
  [['#f00', -rpx], ['#0f0', 0], ['#00f', rpx]].forEach(([col, dx]) => {
    tg.save(); tg.globalCompositeOperation = 'source-over'; tg.clearRect(0, 0, W, H);
    tg.beginPath(); tg.rect(rx, ry, rw, rh); tg.clip();
    draw(tg, dx);
    tg.globalCompositeOperation = 'multiply'; tg.fillStyle = col; tg.fillRect(0, 0, W, H);
    tg.restore();
    g.globalCompositeOperation = 'lighter'; g.drawImage(glTmp, 0, 0);
  });
  g.globalCompositeOperation = 'source-over';
  [[hh(k * 7.31), 0.07, (hh(k * 3.17) - 0.5) * 2 * 0.15 * a], [hh(k * 11.9), 0.035, (hh(k * 5.53) - 0.5) * 2 * 0.10 * a]].forEach(([yf, hf, dxf]) => {
    const bh = Math.max(2, Math.round(H * hf)), y = Math.round((H - bh) * yf), dx = Math.round(dxf * W);
    g.drawImage(cv, 0, y, W, bh, dx, y, W, bh);
  });
  g.restore();
}
function applyVfx() {
  if (!fxs.length && !vfx.dirty) return;
  const off = cropMode || !clips.length, W = stage.clientWidth, H = stage.clientHeight;
  const ga = off ? 0 : fxAt('grain'), va = off ? 0 : fxAt('vintage'), da = off ? 0 : fxAt('dust'), la = off ? 0 : fxAt('glitch'), ba = off ? 0 : fxAt('blur');
  vfx.dirty = !!(ga || va || da || la || ba);
  // grain
  const gr = $('#vgr');
  if (ga) {
    if (!vfx.tile) { vfx.tile = noiseTile(); gr.style.backgroundImage = `url(${vfx.tile})`; }
    const k = Math.floor(head * 14);
    if (vfx.gk !== k) { vfx.gk = k; gr.style.backgroundPosition = `${Math.floor(hh(k * 1.7) * 192)}px ${Math.floor(hh(k * 2.9) * 192)}px`; }
    gr.style.opacity = Math.min(1, ga * 0.9);
  }
  if (!!ga !== vfx.g) { vfx.g = !!ga; gr.style.display = ga ? 'block' : 'none'; }
  // vintage (video filter + vignette/warm overlay)
  const vf0 = va ? `sepia(${(0.5 * va).toFixed(3)}) contrast(${(1 + 0.1 * va).toFixed(3)}) saturate(${(1 - 0.25 * va).toFixed(3)}) brightness(${(1 + 0.03 * va).toFixed(3)})` : '';
  const vf = (vf0 + (ba ? ` blur(${(ba * 24 * W / 1080).toFixed(2)}px)` : '')).trim();   // Gaussian blur: 100% = 24px @1080 (export gblur sigma එකම)
  if (vfx.vf !== vf) { vfx.vf = vf; zw.style.filter = vf; }
  const vv = $('#vvg');
  if (vfx.va !== va) { vfx.va = va; vv.style.opacity = Math.min(1, va); }
  if (!!va !== vfx.v) { vfx.v = !!va; vv.style.display = va ? 'block' : 'none'; }
  // dust & scratches (≈12fps)
  const du = $('#vdu');
  if (da) {
    const k = Math.floor(head * 12);
    if (vfx.dk !== k || vfx.da !== da || du.width !== W || du.height !== H) { vfx.dk = k; vfx.da = da; drawDust(du, W, H, da, k); }
  }
  if (!!da !== vfx.d) { vfx.d = !!da; du.style.display = da ? 'block' : 'none'; }
  // glitch (random bursts)
  const gl = $('#vgl');
  let burst = false;
  if (la && zmst) {
    const k = Math.floor(head * 8);
    if (hh(k * 91.7) < 0.22 + 0.4 * la) { burst = true; drawGlitch(gl, la, k, W, H); }
  }
  if (burst !== vfx.l) { vfx.l = burst; gl.style.display = burst ? 'block' : 'none'; }
}

// ================= library tabs (left panel) =================
function setLibTab(name) {
  document.querySelectorAll('#libtabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('#libbody .tab').forEach(t => t.hidden = t.dataset.tab !== name);
  localStorage.libtab = name;
}
document.querySelectorAll('#libtabs button').forEach(b => b.onclick = e => { setLibTab(b.dataset.tab); e.currentTarget.blur(); });
setLibTab(['text', 'media', 'shapes', 'emoji', 'fx', 'audio', 'layers'].includes(localStorage.libtab) ? localStorage.libtab : 'text');
zkey = ''; updateStage();

requestAnimationFrame(tick);
loadAssets(); loadFonts(); loadEmoji();
goHome();
