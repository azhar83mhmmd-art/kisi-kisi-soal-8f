// ════════════════════════════════════════════════════════════
//  supabase.js — KisiKisi 8F  |  Optimized v4
//  Perbaikan baru v4:
//  1. Profile cache di localStorage → tampil instan saat reload
//  2. Deteksi koneksi (navigator.onLine) → mode offline otomatis
//  3. Auto-retry dengan exponential backoff saat koneksi lambat
//  4. Fetch profil async (non-blocking) → UI tampil lebih dulu
//  5. Semua loading berdasarkan response server nyata (no fake timeout)
//  6. Pesan error & status koneksi yang jelas untuk user
// ════════════════════════════════════════════════════════════

// ── CONFIG ────────────────────────────────────────────────
const SUPABASE_URL      = 'https://bwohpyynytutxifhtmbl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_XjKS6P8GJdJmCjwBBYQL0g_pESSBRKf';
const ADMIN_SECRET_CODE = 'qwerty'; // ⚠️  Ganti sebelum production!

// ── INIT CLIENT ───────────────────────────────────────────
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:     true,
    autoRefreshToken:   true,
    detectSessionInUrl: true
  },
  realtime: {
    params: { eventsPerSecond: 10 }
  }
});

// ════════════════════════════════════════════════════════════
//  KONEKSI — Deteksi online/offline secara real-time
// ════════════════════════════════════════════════════════════
let _isOnline = navigator.onLine;
const _connCallbacks = new Set();

function onConnectionChange(cb) { _connCallbacks.add(cb); }
function offConnectionChange(cb) { _connCallbacks.delete(cb); }
function _fireConnectionChange(online) {
  _isOnline = online;
  _connCallbacks.forEach(cb => { try { cb(online); } catch(_) {} });
}

window.addEventListener('online',  () => {
  console.log('[Net] Online — mencoba reconnect...');
  _fireConnectionChange(true);
});
window.addEventListener('offline', () => {
  console.log('[Net] Offline — masuk mode offline');
  _fireConnectionChange(false);
});

const isOnline = () => _isOnline;

// ════════════════════════════════════════════════════════════
//  PROFILE CACHE — localStorage (persist antar session reload)
//  Key: profile:<userId>  Value: { data, ts }
//  TTL: 5 menit — hanya untuk mempercepat tampilan awal
// ════════════════════════════════════════════════════════════
const PROFILE_CACHE_TTL = 5 * 60 * 1000;

function profileCacheSave(userId, data) {
  try {
    localStorage.setItem('profile:' + userId, JSON.stringify({ data, ts: Date.now() }));
  } catch(_) {}
}

function profileCacheGet(userId) {
  try {
    const raw = localStorage.getItem('profile:' + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > PROFILE_CACHE_TTL) {
      localStorage.removeItem('profile:' + userId);
      return null;
    }
    return parsed.data;
  } catch(_) { return null; }
}

function profileCacheClear(userId) {
  try {
    if (userId) {
      localStorage.removeItem('profile:' + userId);
    } else {
      Object.keys(localStorage)
        .filter(k => k.startsWith('profile:'))
        .forEach(k => localStorage.removeItem(k));
    }
  } catch(_) {}
}

// ════════════════════════════════════════════════════════════
//  AUTH BUSY FLAG
// ════════════════════════════════════════════════════════════
let _authBusy = false;
const isAuthBusy = () => _authBusy;

let pendingOTPData = null;

// ════════════════════════════════════════════════════════════
//  TIMEOUT WRAPPER
// ════════════════════════════════════════════════════════════
function withTimeout(promise, ms, label) {
  ms    = ms    || 5000;
  label = label || 'query';
  const timeout = new Promise(function(_, reject) {
    setTimeout(function() {
      reject(new Error('[TIMEOUT] ' + label + ' melebihi ' + ms + 'ms'));
    }, ms);
  });
  return Promise.race([promise, timeout]);
}

// ════════════════════════════════════════════════════════════
//  AUTO-RETRY — Exponential backoff (no fake loading)
//  Retry hanya terjadi setelah request nyata gagal.
// ════════════════════════════════════════════════════════════
async function withRetry(fn, opts) {
  const maxAttempts = (opts && opts.maxAttempts) || 3;
  const baseDelay   = (opts && opts.baseDelay)   || 500;
  const label       = (opts && opts.label)       || 'op';
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await fn();
      if (i > 0) console.log('[Retry] ' + label + ' berhasil pada percobaan ' + (i + 1));
      return result;
    } catch (e) {
      lastErr = e;
      const isTimeout = e.message && e.message.includes('TIMEOUT');
      const isNetwork = !isOnline() || (e.message && (e.message.includes('fetch') || e.message.includes('network')));
      if (i < maxAttempts - 1 && (isTimeout || isNetwork)) {
        const delay = baseDelay * Math.pow(2, i);
        console.warn('[Retry] ' + label + ' gagal (' + e.message + '), coba lagi dalam ' + delay + 'ms...');
        await new Promise(function(r) { setTimeout(r, delay); });
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

// ════════════════════════════════════════════════════════════
//  IN-MEMORY CACHE
// ════════════════════════════════════════════════════════════
const _cache = new Map();
const TTL = { mapel: 30000, kisi: 60000, profile: 60000 };

const cacheSet = (k, v, ttl) => _cache.set(k, { v, exp: Date.now() + ttl });
const cacheGet = k => {
  const e = _cache.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { _cache.delete(k); return null; }
  return e.v;
};
const cacheDel   = prefix => { for (const k of _cache.keys()) if (k.startsWith(prefix)) _cache.delete(k); };
const cacheClear = ()     => _cache.clear();

// ════════════════════════════════════════════════════════════
//  REALTIME CHANNEL MANAGER
// ════════════════════════════════════════════════════════════
const _channels = new Map();

async function rtSubscribe(name, config, cb) {
  if (_channels.has(name)) {
    try { await _channels.get(name).unsubscribe(); } catch (_) {}
    _channels.delete(name);
  }
  const ch = sb.channel(name).on('postgres_changes', config, cb).subscribe(function(status) {
    console.log('[RT] Channel "' + name + '" status:', status);
  });
  _channels.set(name, ch);
  return ch;
}

async function rtUnsubscribeAll() {
  stopBroadcastPolling();
  for (const ch of _channels.values()) { try { await ch.unsubscribe(); } catch (_) {} }
  _channels.clear();
}

// ════════════════════════════════════════════════════════════
//  PROFILE — Core functions
// ════════════════════════════════════════════════════════════

async function getProfile(userId) {
  console.log('[Auth] getProfile untuk userId:', userId);
  try {
    const result = await withTimeout(
      sb.from('profiles')
        .select('id,user_id,nama_lengkap,email,kelas,role,status,avatar_url')
        .eq('user_id', userId)
        .maybeSingle(),
      5000,
      'getProfile'
    );

    if (result.error) {
      console.error('[Auth] getProfile error:', result.error.message);
      return null;
    }

    if (result.data) {
      profileCacheSave(userId, result.data);
    }

    console.log('[Auth] getProfile result:', result.data ? 'ditemukan' : 'tidak ada');
    return result.data;
  } catch (e) {
    console.error('[Auth] getProfile exception:', e.message);
    return null;
  }
}

async function ensureProfile(user) {
  console.log('[Auth] ensureProfile untuk:', user.email);

  let p = await getProfile(user.id);
  if (p) { console.log('[Auth] Profile sudah ada (cek 1)'); return p; }

  console.log('[Auth] Profile belum ada, tunggu DB trigger 800ms...');
  await new Promise(function(r) { setTimeout(r, 800); });

  p = await getProfile(user.id);
  if (p) { console.log('[Auth] Profile sudah ada (cek 2 pasca trigger)'); return p; }

  console.log('[Auth] Membuat profile manual...');
  const nama = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name))
    || user.email.split('@')[0];

  try {
    const { data, error } = await withTimeout(
      sb.from('profiles').upsert({
        user_id:      user.id,
        nama_lengkap: nama,
        email:        user.email,
        kelas:        '8F',
        role:         'siswa',
        status:       'pending'
      }, { onConflict: 'user_id' }).select().single(),
      5000,
      'ensureProfile upsert'
    );
    if (error) { console.error('[Auth] ensureProfile upsert error:', error.message); return null; }
    if (data) profileCacheSave(user.id, data);
    console.log('[Auth] Profile berhasil dibuat manual');
    return data;
  } catch (e) {
    console.error('[Auth] ensureProfile exception:', e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
//  REGISTER & OTP
// ════════════════════════════════════════════════════════════

async function initiateRegister(nama, email, password, kelas, role) {
  if (!isOnline()) return { success: false, error: 'Tidak ada koneksi internet.' };
  const { data: ex } = await sb.from('profiles').select('email').eq('email', email).maybeSingle();
  if (ex) return { success: false, error: 'Email sudah terdaftar.' };

  pendingOTPData = { nama, email, password, kelas, role };
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) return { success: false, error: 'Gagal kirim OTP: ' + error.message };
  return { success: true };
}

async function verifyOTPAndRegister(inputOTP) {
  if (!pendingOTPData) return { success: false, error: 'Sesi habis. Daftar ulang.' };
  const { nama, email, password, kelas, role } = pendingOTPData;

  const { data, error } = await sb.auth.verifyOtp({ email, token: inputOTP, type: 'email' });
  if (error) return { success: false, error: 'OTP salah atau kadaluarsa.' };

  _authBusy = true;
  console.log('[Auth] _authBusy = true (OTP verify)');

  try {
    const user = data.user;
    await sb.auth.updateUser({ password });
    await new Promise(function(r) { setTimeout(r, 700); });

    const { error: pe } = await withTimeout(
      sb.from('profiles').upsert({
        user_id:      user.id,
        nama_lengkap: nama,
        email,
        kelas,
        role,
        status:       role === 'admin' ? 'approved' : 'pending',
        updated_at:   new Date().toISOString()
      }, { onConflict: 'user_id' }),
      5000,
      'verifyOTP upsert profile'
    );

    if (pe) {
      console.error('[Auth] OTP upsert error:', pe.message);
      return { success: false, error: 'Gagal simpan profil: ' + pe.message };
    }

    pendingOTPData = null;
    const profile = await getProfile(user.id);
    return { success: true, user, profile };

  } catch (e) {
    console.error('[Auth] verifyOTPAndRegister exception:', e.message);
    return { success: false, error: 'Terjadi kesalahan: ' + e.message };
  } finally {
    _authBusy = false;
    console.log('[Auth] _authBusy = false (OTP selesai)');
  }
}

async function resendOTPCode() {
  if (!pendingOTPData) return { success: false, error: 'Sesi habis.' };
  if (!isOnline()) return { success: false, error: 'Tidak ada koneksi internet.' };
  const { error } = await sb.auth.signInWithOtp({
    email: pendingOTPData.email, options: { shouldCreateUser: true }
  });
  return error ? { success: false, error: error.message } : { success: true };
}

// ════════════════════════════════════════════════════════════
//  LOGIN / LOGOUT
// ════════════════════════════════════════════════════════════

async function loginUser(email, password) {
  if (!isOnline()) return { success: false, error: 'Tidak ada koneksi internet. Periksa WiFi atau data Anda.' };

  try {
    const { data, error } = await withTimeout(
      sb.auth.signInWithPassword({ email, password }),
      10000, 'loginUser'
    );
    if (error) {
      const m = error.message || '';
      const msg = (m.includes('Invalid login') || m.includes('invalid_credentials'))
        ? 'Email atau password salah.'
        : m.includes('confirm') ? 'Email belum dikonfirmasi.'
        : (m.includes('Too many') || m.includes('rate')) ? 'Terlalu banyak percobaan. Tunggu beberapa menit.'
        : (m.includes('fetch') || m.includes('network') || m.includes('Failed')) ? 'Koneksi gagal. Periksa internet Anda.'
        : 'Login gagal: ' + m;
      return { success: false, error: msg };
    }

    let profile = null;
    try {
      profile = await withRetry(
        function() { return getProfile(data.user.id); },
        { maxAttempts: 3, baseDelay: 500, label: 'getProfile after login' }
      );
    } catch(_) {}

    if (!profile) profile = await ensureProfile(data.user);

    if (!profile) {
      await sb.auth.signOut();
      return { success: false, error: 'Profil tidak ditemukan. Hubungi admin.' };
    }
    return { success: true, user: data.user, profile };
  } catch (e) {
    const msg = (e.message && e.message.includes('TIMEOUT'))
      ? 'Koneksi timeout. Server lambat merespons, coba lagi.'
      : 'Koneksi gagal. Periksa internet Anda.';
    return { success: false, error: msg };
  }
}

async function loginWithGoogle() {
  if (!isOnline()) return { success: false, error: 'Tidak ada koneksi internet.' };
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.href.split('?')[0].split('#')[0],
        queryParams: { prompt: 'select_account' }
      }
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (e) {
    return { success: false, error: 'Gagal login Google: ' + e.message };
  }
}

async function deleteUserProfile(profileId) {
  try {
    const { error } = await withTimeout(
      sb.from('profiles').delete().eq('id', profileId),
      5000, 'deleteUserProfile'
    );
    if (!error) cacheDel('profile:');
    return { success: !error, error: error && error.message };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function logoutUser() {
  if (typeof _pendingChannel !== 'undefined' && _pendingChannel) {
    try { _pendingChannel.unsubscribe(); } catch(_) {}
    _pendingChannel = null;
  }
  await rtUnsubscribeAll();
  if (currentUser) profileCacheClear(currentUser.id);
  await sb.auth.signOut();
  cacheClear();
  currentUser = currentProfile = null;
  showPage('page-login');
}

// ════════════════════════════════════════════════════════════
//  CACHED GETTERS
// ════════════════════════════════════════════════════════════

async function getMapelCached() {
  const hit = cacheGet('mapel:all');
  if (hit) return { data: hit, error: null };
  const r = await sb.from('mapel')
    .select('id,nama,icon,is_locked,color_from,color_to,urutan,deskripsi')
    .order('urutan');
  if (r.data) cacheSet('mapel:all', r.data, TTL.mapel);
  return r;
}

async function getKisiKisiCached(mapelId) {
  const k   = 'kisi:' + mapelId;
  const hit = cacheGet(k);
  if (hit) return { data: hit, error: null };
  const r = await sb.from('kisi_kisi')
    .select('id,judul,konten,tipe,urutan')
    .eq('mapel_id', mapelId)
    .order('urutan');
  if (r.data) cacheSet(k, r.data, TTL.kisi);
  return r;
}

// ════════════════════════════════════════════════════════════
//  USER MANAGEMENT
// ════════════════════════════════════════════════════════════

const getAllUsers = () => sb.from('profiles')
  .select('id,nama_lengkap,email,kelas,role,status,created_at')
  .order('created_at', { ascending: false });

async function updateUserStatus(id, status) {
  const { error } = await sb.from('profiles')
    .update({ status, updated_at: new Date().toISOString() }).eq('id', id);
  if (!error) cacheDel('profile:');
  return { success: !error, error: error && error.message };
}

// ════════════════════════════════════════════════════════════
//  MAPEL CRUD
// ════════════════════════════════════════════════════════════

const getMapel = () => sb.from('mapel')
  .select('id,nama,icon,is_locked,color_from,color_to,urutan,deskripsi')
  .order('urutan');

async function createMapel(data) {
  const { error, data: result } = await sb.from('mapel').insert(data).select().single();
  if (!error) cacheDel('mapel:');
  return { success: !error, error: error && error.message, data: result };
}

async function updateMapel(id, data) {
  const { error } = await sb.from('mapel').update(data).eq('id', id);
  if (!error) cacheDel('mapel:');
  return { success: !error, error: error && error.message };
}

async function deleteMapel(id) {
  const { error } = await sb.from('mapel').delete().eq('id', id);
  if (!error) { cacheDel('mapel:'); cacheDel('kisi:'); }
  return { success: !error, error: error && error.message };
}

async function toggleMapelLock(id, locked) {
  const { error } = await sb.from('mapel').update({ is_locked: locked }).eq('id', id);
  if (!error) cacheDel('mapel:');
  return { success: !error, error: error && error.message };
}

// ════════════════════════════════════════════════════════════
//  KISI-KISI CRUD
// ════════════════════════════════════════════════════════════

const getKisiKisi = id => sb.from('kisi_kisi')
  .select('id,judul,konten,tipe,urutan').eq('mapel_id', id).order('urutan');

async function createKisiKisi(data) {
  const { error, data: result } = await sb.from('kisi_kisi').insert(data).select().single();
  if (!error) cacheDel('kisi:' + data.mapel_id);
  return { success: !error, error: error && error.message, data: result };
}

async function updateKisiKisi(id, data) {
  const { error } = await sb.from('kisi_kisi')
    .update(Object.assign({}, data, { updated_at: new Date().toISOString() })).eq('id', id);
  if (!error) cacheDel('kisi:');
  return { success: !error, error: error && error.message };
}

async function deleteKisiKisi(id) {
  const { error } = await sb.from('kisi_kisi').delete().eq('id', id);
  if (!error) cacheDel('kisi:');
  return { success: !error, error: error && error.message };
}

// ════════════════════════════════════════════════════════════
//  SOAL (MCQ / MULTIPLE / ESSAY)
// ════════════════════════════════════════════════════════════

async function getQuestions(mapelId) {
  const { data, error } = await sb.from('questions')
    .select('id,question_text,type,explanation,urutan,options(id,option_text,is_correct,urutan)')
    .eq('mapel_id', mapelId)
    .order('urutan')
    .order('urutan', { foreignTable: 'options' });
  return { data, error };
}

async function saveQuestion(mapelId, payload) {
  const { question_text, type, explanation, options, urutan } = payload;
  if (!question_text || !question_text.trim()) return { success: false, error: 'Teks soal wajib diisi.' };
  if (type !== 'essay' && (!options || options.length < 2))
    return { success: false, error: 'Minimal 2 pilihan jawaban.' };
  if (type === 'mcq' && options.filter(function(o) { return o.is_correct; }).length !== 1)
    return { success: false, error: 'Pilihan ganda harus tepat 1 jawaban benar.' };
  if (type === 'multiple' && options.filter(function(o) { return o.is_correct; }).length < 2)
    return { success: false, error: 'Pilihan kompleks minimal 2 jawaban benar.' };

  const { data: q, error: qErr } = await sb.from('questions').insert({
    mapel_id: mapelId, question_text: question_text.trim(), type,
    explanation: (explanation && explanation.trim()) || null, urutan: urutan || 0
  }).select().single();
  if (qErr) return { success: false, error: qErr.message };

  if (type !== 'essay' && options && options.length) {
    const { error: oErr } = await sb.from('options').insert(
      options.map(function(o, i) {
        return {
          question_id: q.id,
          option_text: o.option_text.trim(),
          is_correct:  !!o.is_correct,
          urutan:      i + 1
        };
      })
    );
    if (oErr) return { success: false, error: 'Soal tersimpan tapi options gagal: ' + oErr.message };
  }
  return { success: true, data: q };
}

async function deleteQuestion(id) {
  const { error } = await sb.from('questions').delete().eq('id', id);
  return { success: !error, error: error && error.message };
}

// ════════════════════════════════════════════════════════════
//  BROADCASTS
// ════════════════════════════════════════════════════════════

async function uploadBroadcastImage(file) {
  try {
    const ext  = file.name.split('.').pop();
    const name = 'bcast_' + Date.now() + '.' + ext;
    const { data, error } = await sb.storage
      .from('broadcast-images')
      .upload(name, file, { cacheControl: '3600', upsert: false });
    if (error) return { success: false, error: error.message };
    const { data: urlData } = sb.storage.from('broadcast-images').getPublicUrl(data.path);
    return { success: true, url: urlData.publicUrl };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function sendBroadcast(title, message, imageUrl) {
  imageUrl = imageUrl || null;
  const { data: { user } } = await sb.auth.getUser();
  const { error } = await sb.from('broadcasts').insert({
    title: title || 'Pengumuman', message,
    image_url: imageUrl,
    created_by: user && user.id
  });
  return { success: !error, error: error && error.message };
}

async function getBroadcastHistory() {
  const { data } = await sb.from('broadcasts')
    .select('id,title,message,image_url,created_at')
    .order('created_at', { ascending: false }).limit(20);
  return data || [];
}

let _bcastLastCheck = null;
let _bcastPollTimer = null;
let _bcastPollCb   = null;

async function _pollBroadcast() {
  if (!_bcastPollCb || !currentUser || !isOnline()) return;
  try {
    let q = sb.from('broadcasts')
      .select('id,title,message,image_url,created_at')
      .order('created_at', { ascending: false }).limit(5);
    if (_bcastLastCheck) q = q.gt('created_at', _bcastLastCheck);
    const { data } = await q;
    if (data && data.length) {
      _bcastLastCheck = new Date().toISOString();
      data.reverse().forEach(function(b) { _bcastPollCb(b); });
    }
  } catch (_) {}
}

function startBroadcastPolling(cb) {
  _bcastPollCb = cb;
  _bcastLastCheck = new Date().toISOString();
  clearInterval(_bcastPollTimer);
  _bcastPollTimer = setInterval(_pollBroadcast, 15000);
}

function stopBroadcastPolling() {
  clearInterval(_bcastPollTimer);
  _bcastPollCb = null;
}

// ════════════════════════════════════════════════════════════
//  REALTIME HELPERS
// ════════════════════════════════════════════════════════════

const rtMapel     = function(cb) { return rtSubscribe('mapel-ch',    { event: '*',      schema: 'public', table: 'mapel' }, cb); };
const rtProfiles  = function(cb) {
  return rtSubscribe('profiles-ch', { event: '*', schema: 'public', table: 'profiles' }, function(payload) {
    // Update localStorage cache secara real-time jika profile user saat ini berubah
    if (currentUser && payload.new && payload.new.user_id === currentUser.id) {
      profileCacheSave(currentUser.id, payload.new);
      console.log('[RT] Profile cache diperbarui via realtime');
    }
    cb(payload);
  });
};
const rtBroadcast = function(cb) {
  startBroadcastPolling(cb);
  return rtSubscribe('broadcast-ch', { event: 'INSERT', schema: 'public', table: 'broadcasts' }, function(p) {
    _bcastLastCheck = new Date().toISOString();
    cb(p.new);
  });
};
