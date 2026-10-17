const $ = s => document.querySelector(s);
const video = $('#video'), track = $('#track'), tl = $('#tl'), stage = $('#stage');
const zw = $('#zw'), fxEl = $('#fx');
let pid = null, meta = null, clips = [], sfx = [], music = null, assets = [], texts = [], fonts = [], fxs = [], imgs = [];
let sel = -1, selSfx = null, selMusic = false, selText = null, selFx = null, selImg = null, cur = 0, head = 0, playing = false, pps = 40;
let undo = [], redo = [], saveT = null, gesture = false, zkey = '', swallow = false;
let dirty = false, uiT = null, openTok = 0;   // dirty = save කරන්න තියෙන edit; openTok = project switch token
const DEF = { speed: 1, zoom: 1, zx: 0.5, zy: 0.5, crop: null };
let canvas = 'auto';   // output ratio: auto | orig | 'a:b'
let cropMode = false, cropIdx = -1, cb = null, cratio = null;   // crop editor state
const TRDEF = { type: 'none', dur: 0.4, snd: null, sv: 1 };
const norm = c => ({ ...DEF, ...c, tr: { ...TRDEF, ...(c.tr || {}) } });

const sp = c => c.speed || 1;
const len = c => (c.end - c.start) / sp(c);
const total = () => clips.reduce((a, c) => a + len(c), 0);
const offsets = () => { let o = 0; return clips.map(c => { const r = o; o += len(c); return r; }); };
const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const setStatus = s => $('#status').textContent = s;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 9);
const asset = id => assets.find(a => a.id === id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clearSel = () => { sel = -1; selSfx = null; selMusic = false; selText = null; selFx = null; selImg = null; };

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
  if (!clips.length) return;
  t = Math.max(0, Math.min(t, total()));
  const { i, src } = tlToClip(t);
  cur = i; video.currentTime = src; head = t;
  if (playing) audioStart();
  touchUi();
}

function play() {
  if (!clips.length) return;
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
  renderText(); renderImgs();
}
new ResizeObserver(updateStage).observe($('#sw'));   // layout / window වෙනස් වුනාම stage එක refit
// crop box + zoom එකෙන් සැබෑවටම පෙන්නන source region එක (backend එකේ crop → zoom crop ඒකම)
function effRect(c) {
  const cr = c.crop || FULL, z = c.zoom || 1, w = cr.w / z, h = cr.h / z;
  return { x: cr.x + (cr.w - w) * (c.zx ?? 0.5), y: cr.y + (cr.h - h) * (c.zy ?? 0.5), w, h };
}

function applyZoom(c) {
  const r = cropMode ? FULL : effRect(c), W = stage.clientWidth, H = stage.clientHeight, sa = srcA();
  const k = [r.x, r.y, r.w, r.h, W, H, sa, !cropMode && c.crop ? 1 : 0].join('|');
  if (k === zkey) return;
  zkey = k;
  if (!W || !H) return;
  // video element = source frame, canvas එක ඇතුළේ contain (Vw×Vh)
  const Vw = Math.min(W, H * sa), Vh = Vw / sa;
  video.style.width = Vw + 'px'; video.style.height = Vh + 'px';
  // region එක (crop+zoom) canvas එකට contain-fit → backend එකේ scale+pad එකම
  const s = Math.min(W / (r.w * Vw), H / (r.h * Vh)), cx = (r.x + r.w / 2) * Vw, cy = (r.y + r.h / 2) * Vh;
  zmst = { s, cx, cy, Vw, Vh, r, W, H };
  video.style.transformOrigin = '0 0';
  video.style.transform = `translate(${W / 2}px,${H / 2}px) scale(${s}) translate(${-cx}px,${-cy}px)`;
  video.style.clipPath = r.w > 0.999 && r.h > 0.999 ? 'none'
    : `inset(${r.y * 100}% ${Math.max(0, 1 - r.x - r.w) * 100}% ${Math.max(0, 1 - r.y - r.h) * 100}% ${r.x * 100}%)`;
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
    applyFx(); applyText(); applyImg();
    try { applyVfx(); } catch (err) { console.warn('fx preview', err); }
  }
  requestAnimationFrame(tick);
}

// ================= render =================
function syncInsp() {
  if (cropMode && sel !== cropIdx) exitCrop();
  const c = clips[sel], s = sfx.find(x => x.id === selSfx), m = selMusic && music, tx = curText(), fx = curFx(), im = curImg();
  $('#insp').hidden = !(c || s || m || tx || fx || im);
  $('#i-text').hidden = !tx; if (tx) syncText(tx);
  $('#i-fx').hidden = !fx; if (fx) syncFx(fx);
  $('#i-img').hidden = !im; if (im) syncImg(im);
  $('#idleh').hidden = !c || cropMode;
  $('#i-clip').hidden = !c; $('#i-sfx').hidden = !s; $('#i-music').hidden = !m;
  if (c) {
    $('#speed').value = sp(c); $('#speedv').textContent = sp(c) + 'x';
    if (document.activeElement !== $('#cdur')) $('#cdur').value = len(c).toFixed(2);
    $('#czoom').value = c.zoom; $('#czoomv').textContent = (+c.zoom).toFixed(2) + 'x';
    $('#zx').value = c.zx; $('#zy').value = c.zy;
    $('#croprm').hidden = !c.crop;
    const first = sel === 0, tr = c.tr || TRDEF;
    $('#trtype').value = tr.type;
    $('#trdur').value = tr.dur; $('#trdurv').textContent = (+tr.dur).toFixed(2) + 's';
    $('#trvol').value = tr.sv;
    $('#trsnd').innerHTML = '<option value="">No sound</option>' +
      assets.filter(a => a.kind === 'sfx').map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
    $('#trsnd').value = tr.snd || '';
    ['#trtype', '#trdur', '#trsnd', '#trvol'].forEach(id => $(id).disabled = first);
    $('#trnote').textContent = first ? '(මුල් clip එකට transition නෑ)' : '';
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
  updateStage(); $('#canvas').value = canvas;
  track.querySelectorAll('.clip,.sfx,.music,.tmark,.txi,.fxi,.imi').forEach(e => e.remove());
  const off = offsets(), T = total();
  const add = (cls, css, text) => {
    const d = document.createElement('div');
    d.className = cls; Object.assign(d.style, css); d.textContent = text;
    track.appendChild(d); return d;
  };
  clips.forEach((c, i) => add('clip' + (i === sel ? ' sel' : ''),
    { left: off[i] * pps + 'px', width: len(c) * pps + 'px' },
    `${fmt(c.start)}→${fmt(c.end)}` + (sp(c) !== 1 ? ` · ${sp(c)}x` : '') + (c.zoom > 1 ? ` · 🔍${(+c.zoom).toFixed(1)}` : '') + (c.crop ? ' · ✂crop' : '')));
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
      'T  ' + (t.text.split('\n')[0] || '(empty)')).dataset.id = t.id;
  });
  const nr = Math.max(1, rowsEnd.length);
  $('#txlane').style.height = nr * 32 + 2 + 'px';
  const imTop = 148 + nr * 32, imRows = [];   // Image lane: text rows වලට යටින්
  [...imgs].sort((a, b) => a.start - b.start).forEach(t => {
    let rw = imRows.findIndex(e => e <= t.start + 1e-6); if (rw < 0) { rw = imRows.length; imRows.push(0); }
    imRows[rw] = t.start + t.dur;
    add('imi' + (t.id === selImg ? ' sel' : ''), { left: t.start * pps + 'px', width: Math.max(18, t.dur * pps) + 'px', top: imTop + rw * 32 + 'px' },
      '🖼 ' + (asset(t.asset)?.name || 'missing') + ' · ' + Math.round(t.op * 100) + '%').dataset.id = t.id;
  });
  const ni = Math.max(1, imRows.length);
  $('#imlane').style.top = imTop - 2 + 'px'; $('#imlane').style.height = ni * 32 + 2 + 'px';
  const fxTop = imTop + ni * 32 + 4, fxRows = [];   // FX lane: image rows වලට යටින්
  [...fxs].sort((a, b) => a.start - b.start).forEach(f => {
    let rw = fxRows.findIndex(e => e <= f.start + 1e-6); if (rw < 0) { rw = fxRows.length; fxRows.push(0); }
    fxRows[rw] = f.start + f.dur;
    add('fxi fx-' + f.type + (f.id === selFx ? ' sel' : ''),
      { left: f.start * pps + 'px', width: Math.max(18, f.dur * pps) + 'px', top: fxTop + rw * 32 + 'px' },
      (FXN[f.type] || f.type) + ' · ' + Math.round(f.amt * 100) + '%').dataset.id = f.id;
  });
  const nf = Math.max(1, fxRows.length);
  $('#fxlane').style.top = fxTop - 2 + 'px'; $('#fxlane').style.height = nf * 32 + 2 + 'px';
  tl.style.height = fxTop + nf * 32 + 4 + 'px';
  const end = Math.max(T, ...sfx.map(s => s.t + (asset(s.asset)?.duration || 1)), ...texts.map(t => t.start + t.dur), ...imgs.map(t => t.start + t.dur), ...fxs.map(f => f.start + f.dur));
  track.style.width = Math.max(end * pps + 80, tl.clientWidth) + 'px';
  syncInsp(); renderText(); renderImgs();
}

// ================= state / undo / save =================
const state = () => JSON.stringify({ clips, sfx, music, canvas, texts, fxs, imgs });
function setState(s) { const o = JSON.parse(s); clips = o.clips; sfx = o.sfx; music = o.music; canvas = o.canvas || 'auto'; texts = o.texts || []; fxs = o.fxs || []; imgs = o.imgs || []; }
function snap(label = 'Edit') { undo.push({ s: state(), label }); redo = []; if (undo.length > 100) undo.shift(); updUndoUi(); }
let toastT = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400);
}
function updUndoUi() {
  const u = undo[undo.length - 1], r = redo[redo.length - 1];
  $('#undo').title = u ? 'Undo: ' + u.label + ' (Ctrl+Z)' : 'Undo කරන්න දෙයක් නෑ';
  $('#redo').title = r ? 'Redo: ' + r.label + ' (Ctrl+Y)' : 'Redo කරන්න දෙයක් නෑ';
  $('#undo').disabled = !u; $('#redo').disabled = !r;
}
function touch() { dirty = true; clearTimeout(saveT); saveT = setTimeout(save, 600); }
function changed() { render(); touch(); }
function save() {   // edit (clips/sfx/music/canvas) -> edit.json. keepalive: tab එක close කළත් request එක යනවා
  clearTimeout(saveT);
  if (!pid || !dirty) return;
  dirty = false;
  fetch(`/api/projects/${pid}/edit`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    body: JSON.stringify({ clips, sfx, music, canvas, texts, fxs, imgs }) });
}
function saveUi() {   // playhead / timeline zoom / export settings -> ui.json ("last edited" වෙලාව වෙනස් කරන්නේ නෑ)
  clearTimeout(uiT);
  if (!pid || !clips.length) return;
  fetch(`/api/projects/${pid}/ui`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    body: JSON.stringify({ head: +head.toFixed(2), pps, res: $('#xres').value, preset: $('#xpreset').value }) });
}
function touchUi() { clearTimeout(uiT); uiT = setTimeout(saveUi, 800); }
function flush() { save(); saveUi(); }   // tab close / background / project switch
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
function undoRedo(from, to, verb) {
  if (!from.length) { toast(`${verb} කරන්න දෙයක් නෑ`); return; }
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
  if (sel < 0 || clips.length < 2) return;
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
  if (!clips.length) { setStatus('මුලින් video එකක් upload කරන්න'); return; }
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
function tlPoints(o = {}, exceptId = null) {
  const pts = [0, total()], off = offsets();
  off.forEach((x, i) => { pts.push(x, x + len(clips[i])); });
  if (o.head !== false) pts.push(head);
  texts.forEach(x => { if (x.id !== exceptId) pts.push(x.start, x.start + x.dur); });
  fxs.forEach(x => { if (x.id !== exceptId) pts.push(x.start, x.start + x.dur); });
  imgs.forEach(x => { if (x.id !== exceptId) pts.push(x.start, x.start + x.dur); });
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
  if (e.button || !clips.length) return;
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
  toast(val ? '✔ Crop apply කළා' : 'Crop අයින් කළා');
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
// clip select කළාම preview box එකේ කොන්/මැද handles වලින් කෙලින්ම ඇදලා free crop
$('#idleh').addEventListener('pointerdown', e => {
  const hd = e.target.closest('.ih');
  if (!hd || e.button || sel < 0) return;
  e.preventDefault(); e.stopPropagation();
  enterCrop(); if (!cropMode) return;
  startCropDrag(e, hd.dataset.h);
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
  c.end = +Math.min(meta?.duration || (c.start + want * sp(c)), c.start + want * sp(c)).toFixed(2);
  changed();
};
bind('#speed', () => clips[sel], 'speed', 'Clip speed'); bind('#czoom', () => clips[sel], 'zoom', 'Clip zoom');
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
$('#zreset').onclick = () => {
  if (sel < 0) return;
  snap('Remove zoom'); Object.assign(clips[sel], { zoom: 1, zx: 0.5, zy: 0.5 }); changed();
};
$('#sdel').onclick = delSfx;
$('#mdel').onclick = () => { snap('Remove music'); music = null; selMusic = false; changed(); };

$('#play').onclick = toggle; $('#split').onclick = split;
$('#del').onclick = () => selFx ? delFx() : selImg ? delImg() : selText ? delText() : selSfx ? delSfx() : del();
$('#undo').onclick = () => undoRedo(undo, redo, 'Undo'); $('#redo').onclick = () => undoRedo(redo, undo, 'Redo');
$('#canvas').onchange = e => { snap('Canvas ratio'); canvas = e.target.value; zkey = ''; changed(); e.target.blur(); };
$('#tzoom').oninput = e => { pps = +e.target.value; render(); touchUi(); };
$('#xres').onchange = touchUi; $('#xpreset').onchange = touchUi;

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
  else if (e.key === 's' || e.key === 'S') split();
  else if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey) enterCrop();
  else if (e.key === 'Delete' || e.key === 'Backspace') selFx ? delFx() : selImg ? delImg() : selText ? delText() : selSfx ? delSfx() : del();
  else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoRedo(redo, undo, 'Redo'); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoRedo(undo, redo, 'Undo'); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); undoRedo(redo, undo, 'Redo'); }
});

// ================= asset library =================
async function loadAssets() {
  try { assets = await (await fetch('/api/assets')).json(); } catch { return; }
  const mk = kind => assets.filter(a => a.kind === kind).map(a =>
    `<div class="asset" data-id="${a.id}">${kind === 'image' ? `<img class="ath" src="/api/assets/${a.id}/file" alt="">` : ''}<span class="an" title="${esc(a.name)}">${esc(a.name)}</span>` +
    `<button data-act="add" title="Add">＋</button><button data-act="del" title="Delete">✕</button></div>`).join('') || '<i class="hint">—</i>';
  $('#lib-sfx').innerHTML = mk('sfx'); $('#lib-music').innerHTML = mk('music'); $('#lib-img').innerHTML = mk('image');
  render(); preloadAudio();
}

$('#lib').addEventListener('click', async e => {
  const row = e.target.closest('.asset'); if (!row) return;
  const a = asset(row.dataset.id), act = e.target.dataset.act;
  if (!a) return;
  if (act === 'del') {
    if (!confirm(`"${a.name}" library එකෙන් delete කරන්නද?`)) return;
    await fetch(`/api/assets/${a.id}`, { method: 'DELETE' }); loadAssets();
  } else if (act === 'add') a.kind === 'image' ? addImg(a) : addAsset(a);
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
      toast(kind === 'image' && /audio file/.test(msg) ? 'Server එක පරණයි: backend/main.py replace කරලා restart කරන්න' : 'Upload error: ' + msg);
      return;
    }
    if (kind === 'image') toast('Image add උනා ✔ (＋ එබුවාම timeline එකට එනවා)');
  }
  setStatus(meta?.name || ''); loadAssets();
}
$('#up-sfx').onchange = e => uploadAssets(e, 'sfx');
$('#up-music').onchange = e => uploadAssets(e, 'music');
$('#up-img').onchange = e => uploadAssets(e, 'image');

// ================= export =================
$('#export').onclick = async () => {
  if (!pid || !clips.length) return;
  clearTimeout(saveT);
  $('#dl').hidden = true;
  const renders = [];
  if (texts.some(t => t.text.trim())) {
    $('#export').disabled = true; $('#xstat').textContent = 'Text render කරනවා…';
    const W = outWidth();
    for (const t of texts) {
      if (!t.text.trim()) continue;
      const rr = await renderTextPng(t, W);
      renders.push({ id: t.id, png: rr.png, wf: rr.wf, x: t.x, y: t.y, op: t.op ?? 1, start: t.start, end: t.start + t.dur });
    }
    $('#export').disabled = false; $('#xstat').textContent = '';
  }
  const body = { clips, sfx, music, canvas, width: +$('#xres').value, preset: $('#xpreset').value, layers: texts, texts: renders, fxs, imgs };
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
    if (!r.ok) { goHome('Project එක හොයාගන්න බෑ'); return; }
    m = await r.json();
    if (m.status !== 'processing') break;
    setStatus('Proxy හදනවා…'); await sleep(1500);
    if (tok !== openTok) return;
  }
  if (m.status === 'error') { setStatus('Proxy error (ffmpeg install ද?)'); return; }
  const ed = await (await fetch(`/api/projects/${id}/edit`)).json();
  let ui = {};
  try { ui = await (await fetch(`/api/projects/${id}/ui`)).json(); } catch {}
  if (tok !== openTok) return;
  meta = m; setStatus(m.name);
  clips = (ed.clips?.length ? ed.clips : [{ start: 0, end: m.default_len || m.duration }]).map(norm);
  sfx = ed.sfx || []; music = ed.music || null; canvas = ed.canvas || 'auto';
  texts = (ed.texts || []).map(normT);
  fxs = (ed.fxs || []).map(normF);
  imgs = (ed.imgs || []).map(normI);
  // අන්තිමට තිබ්බ settings ආපහු
  pps = ui.pps || 40; $('#tzoom').value = pps;
  $('#xres').value = ui.res ?? '0'; $('#xpreset').value = ui.preset || 'veryfast';
  dirty = false; exitCrop(); undo = []; redo = []; updUndoUi(); clearSel(); cur = 0; head = 0; zkey = '';
  video.src = `/api/projects/${id}/proxy.mp4`;
  video.onloadedmetadata = () => { render(); seek(Math.min(+ui.head || 0, total())); };
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
  if (!list.length) { box.innerHTML = '<div class="pempty">තාම projects නෑ. උඩින් "+ New project" එකෙන් video එකක් upload කරන්න.</div>'; return; }
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
    if (!confirm(`"${card.querySelector('.pname').textContent}" project එක සම්පූර්ණයෙන්ම delete කරන්නද? (video, edits, export — ආපහු ගන්න බෑ)`)) return;
    const r = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    if (!r.ok) { toast((await r.text()).slice(0, 80)); return; }
  }
  loadProjects();
};

function goHome(msg) {
  flush();
  ++openTok; pause();
  pid = null; meta = null; clips = []; sfx = []; music = null; texts = []; fxs = []; imgs = []; dirty = false;
  clearSel(); exitCrop(); zkey = '';
  video.removeAttribute('src'); video.load();
  document.body.classList.add('home');
  $('#hmsg').textContent = msg || 'Project එකක් open කරන්න, නැත්නම් අලුත් එකක් හදන්න. හැම edit එකක්ම auto-save වෙනවා.';
  loadProjects();
}
$('#homebtn').onclick = e => { goHome(); e.target.blur(); };


// ================= text layers =================
const TXDEF = { text: 'Text', font: 'Nirmala UI', size: 0.07, bold: false, italic: false, underline: false, outline: false,
  color: '#ffffff', align: 'center', x: 0.5, y: 0.8, start: 0, dur: 3, op: 1 };
const SYS_FONTS = ['Nirmala UI', 'Iskoola Pota', 'Noto Sans Sinhala', 'Segoe UI', 'Arial', 'Verdana', 'Georgia', 'Times New Roman', 'Impact', 'Comic Sans MS'];
const FALLBACK = '"Nirmala UI","Iskoola Pota","Noto Sans Sinhala","Noto Sans",sans-serif';   // සිංහල glyphs නැති font වලට fallback
const COLORS = ['#ffffff', '#000000', '#ff3b30', '#ffd60a', '#34c759', '#0a84ff', '#ff9f0a', '#ff2d92', '#bf5af2', '#00e5ff'];
const MINT = 0.2;
const LH = 1.4, PADK = 0.25;   // line-height / padding (em) — preview + export දෙකේම එකයි
let txStyle = {}; try { txStyle = JSON.parse(localStorage.txStyle || '{}'); } catch {}
let snapOn = localStorage.snap !== '0', gridOn = localStorage.grid === '1';
const normT = t => ({ ...TXDEF, ...t });
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
  Object.assign(el.style, { left: t.x * 100 + '%', top: t.y * 100 + '%', fontSize: px + 'px', padding: PADK + 'em',
    fontFamily: fam(t.font), fontWeight: t.bold ? 700 : 400, fontStyle: t.italic ? 'italic' : 'normal', color: t.color, textAlign: t.align });
  const tt = el.firstChild;
  tt.style.textDecoration = t.underline ? 'underline' : 'none';
  tt.style.webkitTextStroke = t.outline ? `${0.14 * px}px #000` : '0';
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
  const px0 = e.clientX, py0 = e.clientY, x0 = t.x, y0 = t.y, s0 = t.size, bw = el.offsetWidth, bh = el.offsetHeight;
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
      t.x = (fx + sx * bw * kk / 2) / W; t.y = (fy + sy * bh * kk / 2) / H;
    } else {
      let nx = x0 + dx / W, ny = y0 + dy / H, gv = null, gh = null;
      nx = Math.max(0, Math.min(1, nx)); ny = Math.max(0, Math.min(1, ny));
      if (snapOn && !ev.altKey) {
        const vl = [{ v: 0.5, center: true }], hl = [{ v: 0.5, center: true }];
        if (gridOn) for (const v of [0, 1 / 3, 2 / 3, 1]) { vl.push({ v }); hl.push({ v }); }
        const a = snap1(nx, bw / W / 2, vl, 7 / W), b = snap1(ny, bh / H / 2, hl, 7 / H);
        nx = a.c; ny = b.c; gv = a.line; gh = b.line;
      }
      t.x = nx; t.y = ny; guides(gv, gh);
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
  if (!(selText || selImg) || cropMode || e.target.closest('.tx') || e.target.closest('.im') || e.target.closest('.hd')) return;
  clearSel(); render();
});
txov.addEventListener('dblclick', e => { if (e.target.closest('.tx')) { const a = $('#ttext'); a.focus(); a.select(); } });

// ----- timeline: text / FX item move / trim (+ magnetic snap) -----
track.addEventListener('pointerdown', e => {
  const el = e.target.closest('.txi,.fxi,.imi'); if (!el || e.button) return;
  const kind = el.classList.contains('fxi') ? 'fx' : el.classList.contains('imi') ? 'im' : 'tx', isFx = kind === 'fx';
  const t = (isFx ? fxs : kind === 'im' ? imgs : texts).find(x => x.id === el.dataset.id); if (!t) return;
  swallow = true; setTimeout(() => swallow = false, 300);
  if ((isFx ? selFx : kind === 'im' ? selImg : selText) !== t.id) { clearSel(); if (isFx) selFx = t.id; else if (kind === 'im') selImg = t.id; else selText = t.id; }
  const rc = el.getBoundingClientRect(), lx = e.clientX - rc.left;
  const mode = lx < 7 ? 'l' : lx > rc.width - 7 ? 'r' : 'm';
  const x0 = e.clientX, s0 = t.start, d0 = t.dur, e0 = s0 + d0, MIN = 0.2;
  const pts = tlPoints({}, t.id), tol = 9 / pps;   // snap points (මේ item එක හැර)
  let moved = false;
  el.setPointerCapture?.(e.pointerId);
  const mv = ev => {
    const dt = (ev.clientX - x0) / pps;
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    if (!moved) { snap((isFx ? 'FX ' : kind === 'im' ? 'Image ' : 'Text ') + (mode === 'm' ? 'move' : 'trim')); moved = true; }
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
    el.style.left = t.start * pps + 'px'; el.style.width = Math.max(18, t.dur * pps) + 'px';
    if (isFx) syncFx(t, true); else if (kind === 'im') { syncImg(t, true); applyImg(true); } else { syncText(t, true); applyText(true); }
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
  txStyle = { font: t.font, size: t.size, bold: t.bold, italic: t.italic, underline: t.underline, outline: t.outline, color: t.color, align: t.align };
  localStorage.txStyle = JSON.stringify(txStyle);
}
function syncText(t, light) {   // light = drag වෙලාවේ number inputs විතරයි
  if (document.activeElement !== $('#tstart')) $('#tstart').value = (+t.start).toFixed(2);
  if (document.activeElement !== $('#tdur')) $('#tdur').value = (+t.dur).toFixed(2);
  $('#tsize').value = t.size * 100; $('#tsizev').textContent = (t.size * 100).toFixed(1) + '%';
  const to = Math.round((t.op ?? 1) * 100); $('#topac').value = to; $('#topacv').textContent = to + '%';
  if (light) return;
  if ($('#ttext').value !== t.text) $('#ttext').value = t.text;
  const mine = fonts.map(f => `<option value="uf_${f.id}">${esc(f.name)}</option>`).join('');
  const sys = [...new Set([...SYS_FONTS, t.font].filter(f => !f.startsWith('uf_')))].map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
  $('#tfont').innerHTML = (mine ? `<optgroup label="My fonts">${mine}</optgroup>` : '') + `<optgroup label="System">${sys}</optgroup>`;
  $('#tfont').value = t.font;
  $('#tfdel').hidden = !t.font.startsWith('uf_');
  [['#tb', t.bold], ['#ti', t.italic], ['#tu', t.underline], ['#toutl', t.outline]].forEach(([id, on]) => $(id).classList.toggle('on', !!on));
  document.querySelectorAll('[data-al]').forEach(b => b.classList.toggle('on', b.dataset.al === t.align));
  document.querySelectorAll('#tcolors button').forEach(b => b.classList.toggle('on', b.dataset.c === t.color));
  $('#tcolor').value = t.color;
}
$('#tcolors').innerHTML = COLORS.map(c => `<button data-c="${c}" style="background:${c}" title="${c}"></button>`).join('');
function editT(label, fn) { const t = curText(); if (!t) return; snapT(label); fn(t); remember(t); changed(); }
$('#ttext').oninput = e => editT('Edit text', t => t.text = e.target.value);
$('#tfont').onchange = e => editT('Text font', t => t.font = e.target.value);
$('#tb').onclick = () => editT('Bold', t => t.bold = !t.bold);
$('#ti').onclick = () => editT('Italic', t => t.italic = !t.italic);
$('#tu').onclick = () => editT('Underline', t => t.underline = !t.underline);
$('#toutl').onclick = () => editT('Outline', t => t.outline = !t.outline);
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
$('#tcx').onclick = () => editT('Center text X', t => t.x = 0.5);
$('#tcy').onclick = () => editT('Center text Y', t => t.y = 0.5);
$('#tdup').onclick = () => { const t = curText(); if (!t) return; snap('Duplicate text'); const n = { ...t, id: uid(), x: Math.min(1, t.x + 0.03), y: Math.min(1, t.y + 0.03) }; texts.push(n); selText = n.id; changed(); };
$('#tdel').onclick = () => delText();
function delText() { if (!selText) return; snap('Delete text'); texts = texts.filter(x => x.id !== selText); selText = null; changed(); }
$('#addtext').onclick = () => {
  if (!clips.length) { setStatus('මුලින් project එකක් open කරන්න'); return; }
  snap('Add text'); clearSel();
  const t = normT({ ...txStyle, id: uid(), x: 0.5, y: 0.8, start: +head.toFixed(2), dur: +Math.max(0.5, Math.min(3, total() - head)).toFixed(2) });
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
  toast('Font add උනා: ' + m.name);
};
$('#tfdel').onclick = async () => {
  const t = curText(); if (!t || !t.font.startsWith('uf_')) return;
  const id = t.font.slice(3), f = fonts.find(x => x.id === id);
  if (!confirm(`"${f?.name || 'font'}" delete කරන්නද? (මේක use කරන texts වලට default font එක එනවා)`)) return;
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
  let w = +$('#xres').value || cw; return w - (w % 2);
}
async function renderTextPng(t, W) {
  const px = t.size * W;
  try { await document.fonts.load(cssFont(t, px), t.text); } catch {}
  const c = document.createElement('canvas'), g = c.getContext('2d');
  g.font = cssFont(t, px);
  const lines = t.text.split('\n'), ws = lines.map(l => g.measureText(l).width), maxw = Math.max(...ws);
  const m = g.measureText('Hg'), A = m.fontBoundingBoxAscent ?? px * 0.95, D = m.fontBoundingBoxDescent ?? px * 0.25;
  const pad = PADK * px, lh = LH * px;
  c.width = Math.max(2, Math.ceil(maxw + 2 * pad)); c.height = Math.max(2, Math.ceil(lines.length * lh + 2 * pad));
  g.font = cssFont(t, px); g.textBaseline = 'alphabetic'; g.lineJoin = 'round';
  lines.forEach((l, i) => {
    const base = pad + i * lh + (lh - (A + D)) / 2 + A;
    const x = t.align === 'left' ? pad : t.align === 'right' ? pad + maxw - ws[i] : pad + (maxw - ws[i]) / 2;
    if (t.outline) { g.strokeStyle = '#000'; g.lineWidth = 0.14 * px; g.strokeText(l, x, base); }
    g.fillStyle = t.color; g.fillText(l, x, base);
    if (t.underline && l) g.fillRect(x, base + 0.1 * px, ws[i], Math.max(1, 0.06 * px));
  });
  return { png: c.toDataURL('image/png'), wf: c.width / W };
}

// ================= image overlays =================
const IMDEF = { asset: '', x: 0.5, y: 0.5, w: 0.4, op: 1, start: 0, dur: 3 };
const normI = t => ({ ...IMDEF, ...t });
const curImg = () => imgs.find(x => x.id === selImg);
const imov = $('#imov');

function placeImg(el, t) {
  Object.assign(el.style, { left: t.x * 100 + '%', top: t.y * 100 + '%', width: t.w * 100 + '%' });
  const im = el.firstChild, src = `/api/assets/${t.asset}/file`;
  if (im.getAttribute('src') !== src) im.src = src;
  el.classList.toggle('sel', t.id === selImg);
}
function renderImgs() {
  if (!stage.clientWidth) return;
  imov.hidden = cropMode;
  const have = new Map([...imov.children].map(e => [e.dataset.id, e]));
  imgs.forEach(t => {
    let el = have.get(t.id); have.delete(t.id);
    if (!el) {
      el = document.createElement('div'); el.className = 'im'; el.dataset.id = t.id;
      el.innerHTML = '<img draggable="false" alt="">' + ['tl', 'tr', 'bl', 'br'].map(h => `<i class="th" data-h="${h}"></i>`).join('');
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
  }
}

function addImg(a) {
  if (!clips.length) { setStatus('මුලින් project එකක් open කරන්න'); return; }
  snap('Add image'); clearSel();
  const T = total(), start = +Math.min(head, Math.max(0, T - 0.5)).toFixed(2);
  const nat = a.w && a.h ? a.w / a.h : 1, ca = canvasAspect();
  let w = 0.4; if (w * ca / nat > 0.5) w = 0.5 * nat / ca;   // canvas එකේ උස භාගයකට වඩා නොවෙන්න
  const t = normI({ id: uid(), asset: a.id, x: 0.5, y: 0.5, w: +w.toFixed(3), op: 1, start, dur: +Math.max(0.5, Math.min(3, T - start)).toFixed(2) });
  imgs.push(t); selImg = t.id; changed();
  if (head < t.start || head >= t.start + t.dur) seek(t.start + 0.01);   // playhead එක image range එක ඇතුළට
}
function delImg() { if (!selImg) return; snap('Delete image'); imgs = imgs.filter(x => x.id !== selImg); selImg = null; changed(); }

// ----- preview: move (magnetic: center / edges / grid) / resize (corner handles) -----
imov.addEventListener('pointerdown', e => {
  const el = e.target.closest('.im'); if (!el || e.button) return;
  const t = imgs.find(x => x.id === el.dataset.id); if (!t) return;
  e.preventDefault(); e.stopPropagation();
  if (selImg !== t.id) { clearSel(); selImg = t.id; render(); }
  const handle = e.target.closest('.th')?.dataset.h;
  const R = stage.getBoundingClientRect(), W = R.width, H = R.height;
  const px0 = e.clientX, py0 = e.clientY, x0 = t.x, y0 = t.y, w0 = t.w, bw = el.offsetWidth, bh = el.offsetHeight;
  let moved = false;
  el.setPointerCapture?.(e.pointerId);
  const mv = ev => {
    const dx = ev.clientX - px0, dy = ev.clientY - py0;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    if (!moved) { snap(handle ? 'Resize image' : 'Move image'); moved = true; }
    if (handle) {
      const sx = handle.includes('l') ? -1 : 1, sy = handle.includes('t') ? -1 : 1;
      const fx = x0 * W - sx * bw / 2, fy = y0 * H - sy * bh / 2;               // opposite (fixed) corner
      const vx = sx * bw, vy = sy * bh, px = ev.clientX - R.left - fx, py = ev.clientY - R.top - fy;
      const k = Math.max(0.05, Math.min(10, (px * vx + py * vy) / (vx * vx + vy * vy)));
      t.w = Math.max(0.03, Math.min(4, w0 * k));
      const kk = t.w / w0;
      t.x = (fx + sx * bw * kk / 2) / W; t.y = (fy + sy * bh * kk / 2) / H;
    } else {
      let nx = clampN(x0 + dx / W, 0, 1), ny = clampN(y0 + dy / H, 0, 1), gv = null, gh = null;
      if (snapOn && !ev.altKey) {
        const vl = [{ v: 0.5, center: true }, { v: 0 }, { v: 1 }], hl = [{ v: 0.5, center: true }, { v: 0 }, { v: 1 }];
        if (gridOn) for (const v of [1 / 3, 2 / 3]) { vl.push({ v }); hl.push({ v }); }
        const a = snap1(nx, bw / W / 2, vl, 7 / W), b = snap1(ny, bh / H / 2, hl, 7 / H);
        nx = a.c; ny = b.c; gv = a.line; gh = b.line;
      }
      t.x = nx; t.y = ny; guides(gv, gh);
    }
    placeImg(el, t);
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
  $('#iop').value = op; $('#iopv').textContent = op + '%';
  if (light) return;
  $('#iname').textContent = asset(t.asset)?.name || 'missing';
}
function editI(label, fn) { const t = curImg(); if (!t) return; snapT(label); fn(t); changed(); }
$('#iop').oninput = e => editI('Image opacity', t => t.op = clampN(+e.target.value / 100, 0, 1));
$('#isize').oninput = e => editI('Image size', t => t.w = Math.max(0.03, +e.target.value / 100));
['#iop', '#isize'].forEach(id => $(id).onchange = e => e.target.blur());
$('#istart').onchange = e => editI('Image time', t => t.start = Math.max(0, +e.target.value || 0));
$('#idur').onchange = e => editI('Image time', t => t.dur = Math.max(0.2, +e.target.value || 3));
$('#ifit').onclick = e => { editI('Image → video end', t => { t.start = Math.min(t.start, Math.max(0, total() - MINT)); t.dur = Math.max(MINT, total() - t.start); }); e.target.blur(); };
$('#iend').onclick = e => { editI('Image → playhead', t => { t.dur = Math.max(MINT, head - t.start); }); e.target.blur(); };
$('#icx').onclick = e => { editI('Center image X', t => t.x = 0.5); e.target.blur(); };
$('#icy').onclick = e => { editI('Center image Y', t => t.y = 0.5); e.target.blur(); };
$('#idup').onclick = () => { const t = curImg(); if (!t) return; snap('Duplicate image'); const n = { ...t, id: uid(), x: Math.min(1, t.x + 0.03), y: Math.min(1, t.y + 0.03) }; imgs.push(n); selImg = n.id; changed(); };
$('#idel').onclick = () => delImg();

// ================= FX: grain / vintage / dust / glitch =================
const FXN = { grain: '🎞 Grain', vintage: '📼 Vintage', dust: '✨ Dust & scratches', glitch: '📺 Glitch' };
const FXDEF = { type: 'grain', start: 0, dur: 3, amt: 0.6 };
const normF = f => ({ ...FXDEF, ...f });
const curFx = () => fxs.find(x => x.id === selFx);

function addFx(type) {
  if (!clips.length) { setStatus('මුලින් project එකක් open කරන්න'); return; }
  snap('Add ' + type); clearSel();
  const T = total(), whole = type !== 'glitch';   // grain/vintage/dust = මුළු video එකටම; glitch = playhead එකේ ඉඳන් තත්පර 1.5ක්
  const start = whole ? 0 : Math.min(+head.toFixed(2), Math.max(0, T - 0.3));
  const f = { id: uid(), type, start, dur: whole ? T : Math.max(0.3, Math.min(1.5, T - start)), amt: type === 'glitch' ? 0.7 : 0.6 };
  fxs.push(f); selFx = f.id; changed();
}
function delFx() { if (!selFx) return; snap('Delete effect'); fxs = fxs.filter(x => x.id !== selFx); selFx = null; changed(); }
function syncFx(f, light) {
  if (document.activeElement !== $('#fstart')) $('#fstart').value = (+f.start).toFixed(2);
  if (document.activeElement !== $('#fdur')) $('#fdur').value = (+f.dur).toFixed(2);
  if (light) return;
  $('#fname').textContent = FXN[f.type] || f.type;
  $('#famt').value = f.amt; $('#famtv').textContent = Math.round(f.amt * 100) + '%';
}
function editF(label, fn) { const f = curFx(); if (!f) return; snapT(label); fn(f); changed(); }
$('#fxbtns').onclick = e => { const b = e.target.closest('button'); if (b) { addFx(b.dataset.fx); b.blur(); } };
$('#famt').oninput = e => editF('Effect intensity', f => f.amt = +e.target.value);
$('#famt').onchange = e => e.target.blur();
$('#fstart').onchange = e => editF('Effect time', f => f.start = Math.max(0, +e.target.value || 0));
$('#fdur').onchange = e => editF('Effect time', f => f.dur = Math.max(0.1, +e.target.value || 1));
$('#ffull').onclick = e => { editF('Effect → whole video', f => { f.start = 0; f.dur = total(); }); e.target.blur(); };
$('#fend').onclick = e => { editF('Effect → video end', f => { f.start = Math.min(f.start, Math.max(0, total() - 0.1)); f.dur = Math.max(0.1, total() - f.start); }); e.target.blur(); };
$('#fdup').onclick = () => { const f = curFx(); if (!f) return; snap('Duplicate effect'); const n = { ...f, id: uid(), start: f.start + 0.3 }; fxs.push(n); selFx = n.id; changed(); };
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
  const rx = (z.r.x * z.Vw - z.cx) * z.s + z.W / 2, ry = (z.r.y * z.Vh - z.cy) * z.s + z.H / 2, rw = z.r.w * z.Vw * z.s, rh = z.r.h * z.Vh * z.s;
  const draw = (c, dx) => { c.save(); c.translate(dx, 0); c.translate(z.W / 2, z.H / 2); c.scale(z.s, z.s); c.translate(-z.cx, -z.cy); c.drawImage(video, 0, 0, z.Vw, z.Vh); c.restore(); };
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
  const ga = off ? 0 : fxAt('grain'), va = off ? 0 : fxAt('vintage'), da = off ? 0 : fxAt('dust'), la = off ? 0 : fxAt('glitch');
  vfx.dirty = !!(ga || va || da || la);
  // grain
  const gr = $('#vgr');
  if (ga) {
    if (!vfx.tile) { vfx.tile = noiseTile(); gr.style.backgroundImage = `url(${vfx.tile})`; }
    const k = Math.floor(head * 14);
    if (vfx.gk !== k) { vfx.gk = k; gr.style.backgroundPosition = `${Math.floor(hh(k * 1.7) * 192)}px ${Math.floor(hh(k * 2.9) * 192)}px`; }
    gr.style.opacity = ga * 0.9;
  }
  if (!!ga !== vfx.g) { vfx.g = !!ga; gr.style.display = ga ? 'block' : 'none'; }
  // vintage (video filter + vignette/warm overlay)
  const vf = va ? `sepia(${(0.5 * va).toFixed(3)}) contrast(${(1 + 0.1 * va).toFixed(3)}) saturate(${(1 - 0.25 * va).toFixed(3)}) brightness(${(1 + 0.03 * va).toFixed(3)})` : '';
  if (vfx.vf !== vf) { vfx.vf = vf; zw.style.filter = vf; }
  const vv = $('#vvg');
  if (vfx.va !== va) { vfx.va = va; vv.style.opacity = va; }
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

// ================= layout: preview center / right =================
function setLayout(m) {
  const mid = $('#mid'), els = [$('#pbar'), $('#cropbar'), $('#insp')];
  document.body.classList.toggle('pr', m === 'right');
  if (m === 'right') { els.forEach(e => mid.append(e)); $('#cols').append($('#sw')); }
  else { els.forEach(e => $('#tl').before(e)); $('main').append($('#sw')); }
  $('#layout').textContent = m === 'right' ? '◧ Preview center' : '◨ Preview right';
  localStorage.layout = m; zkey = ''; updateStage();
}
$('#layout').onclick = e => { setLayout(document.body.classList.contains('pr') ? 'center' : 'right'); e.target.blur(); };
setLayout(localStorage.layout === 'right' ? 'right' : 'center');

requestAnimationFrame(tick);
loadAssets(); loadFonts();
goHome();
