// ════════════════════════════════════════════════════════════
//  supabase.js — KisiKisi 8F  |  Production Fix v3
//  Root causes fixed:
//  1. Race condition: onAuthStateChange + OTP verify berjalan bersamaan
//  2. getProfile tidak punya timeout → bisa hang selamanya
//  3. ensureProfile untuk Google OAuth tidak menunggu DB trigger
//  4. Realtime channel menumpuk (memory leak + event duplikat)
//  5. Cache tidak digunakan → setiap navigasi fetch ulang
// ════════════════════════════════════════════════════════════

// ── CONFIG ────────────────────────────────────────────────
const SUPABASE_URL      = 'https://bwohpyynytutxifhtmbl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_XjKS6P8GJdJmCjwBBYQL0g_pESSBRKf';
const ADMIN_SECRET_CODE = 'qwerty'; // ⚠️  Ganti sebelum production!

// ── INIT CLIENT ───────────────────────────────────────────
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:   true,   // simpan session di localStorage
    autoRefreshToken: true,   // refresh token otomatis
    detectSessionInUrl: true  // tangkap token dari URL (OAuth redirect)
  }
});

// ────────────────────────────────────────────────────────────
//  ROOT CAUSE FIX #1 — Auth busy flag
//  Masalah: setelah verifyOtp(), Supabase langsung tembak
//  onAuthStateChange('SIGNED_IN'). Kalau tidak diblokir,
//  initApp() jalan sebelum profile selesai di-upsert.
//  Solusi: set _authBusy = true selama proses OTP & upsert.
// ────────────────────────────────────────────────────────────
let _authBusy = false;
const isAuthBusy = () => _authBusy;

// ── OTP PENDING ───────────────────────────────────────────
let pendingOTPData = null;

// ────────────────────────────────────────────────────────────
//  ROOT CAUSE FIX #2 — Fetch dengan hard timeout
//  Masalah: query Supabase bisa hang tanpa batas waktu
//  (cold start, koneksi buruk, RLS block tanpa error).
//  Solusi: AbortController + Promise.race dengan timeout 5 dtk.
// ────────────────────────────────────────────────────────────
function withTimeout(promise, ms = 5000, label = 'query') {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`[TIMEOUT] ${label} melebihi ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

// ── CACHE SEDERHANA ───────────────────────────────────────
// Mencegah fetch berulang saat user navigasi (mapel, kisi-kisi).
const _cache = new Map();
const TTL = { mapel: 30_000, kisi: 60_000, profile: 60_000 };

const cacheSet = (k, v, ttl) => _cache.set(k, { v, exp: Date.now() + ttl });
const cacheGet = k => {
  const e = _cache.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { _cache.delete(k); return null; }
  return e.v;
};
const cacheDel   = prefix => { for (const k of _cache.keys()) if (k.startsWith(prefix)) _cache.delete(k); };
const cacheClear = ()     => _cache.clear();

// ── REALTIME CHANNEL MANAGER ──────────────────────────────
// Mencegah channel menumpuk saat user navigasi bolak-balik.
const _channels = new Map();

async function rtSubscribe(name, config, cb) {
  // Bersihkan channel lama dengan nama yang sama sebelum buat baru
  if (_channels.has(name)) {
    try { await _channels.get(name).unsubscribe(); } catch (_) {}
    _channels.delete(name);
  }
  const ch = sb.channel(name).on('postgres_changes', config, cb).subscribe();
  _channels.set(name, ch);
  return ch;
}

async function rtUnsubscribeAll() {
  stopBroadcastPolling();
  for (const ch of _channels.values()) { try { await ch.unsubscribe(); } catch (_) {} }
  _channels.clear();
}

// ════════════════════════════════════════════════════════════
//  PROFILE — core function (semua fix ada di sini)
// ════════════════════════════════════════════════════════════

// ROOT CAUSE FIX #3 — getProfile dengan timeout + error handling
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

    console.log('[Auth] getProfile result:', result.data ? 'ditemukan' : 'tidak ada');
    return result.data;
  } catch (e) {
    console.error('[Auth] getProfile exception:', e.message);
    return null; // selalu return null, jangan throw — biarkan caller handle
  }
}

// ROOT CAUSE FIX #4 — autoCreate profile jika tidak ada (terutama OAuth)
// Flow: cek ada? → tunggu DB trigger (800ms) → cek lagi → buat manual
async function ensureProfile(user) {
  console.log('[Auth] ensureProfile untuk:', user.email);

  // Cek pertama kali
  let p = await getProfile(user.id);
  if (p) { console.log('[Auth] Profile sudah ada (cek 1)'); return p; }

  // Tunggu DB trigger handle_new_user selesai (asynchronous di Postgres)
  console.log('[Auth] Profile belum ada, tunggu DB trigger 800ms...');
  await new Promise(r => setTimeout(r, 800));

  // Cek kedua setelah tunggu
  p = await getProfile(user.id);
  if (p) { console.log('[Auth] Profile sudah ada (cek 2 pasca trigger)'); return p; }

  // Trigger belum jalan atau gagal → buat manual
  console.log('[Auth] Membuat profile manual...');
  const nama = user.user_metadata?.full_name
    || user.user_metadata?.name
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
  // Cek duplikat email
  const { data: ex } = await sb.from('profiles').select('email').eq('email', email).maybeSingle();
  if (ex) return { success: false, error: 'Email sudah terdaftar.' };

  pendingOTPData = { nama, email, password, kelas, role };
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) return { success: false, error: 'Gagal kirim OTP: ' + error.message };
  return { success: true };
}

// ROOT CAUSE FIX #1 (lanjutan) — _authBusy mencegah double-fetch
async function verifyOTPAndRegister(inputOTP) {
  if (!pendingOTPData) return { success: false, error: 'Sesi habis. Daftar ulang.' };
  const { nama, email, password, kelas, role } = pendingOTPData;

  const { data, error } = await sb.auth.verifyOtp({ email, token: inputOTP, type: 'email' });
  if (error) return { success: false, error: 'OTP salah atau kadaluarsa.' };

  // ⚠️  KRITIS: Set busy SEBELUM updateUser agar onAuthStateChange tidak masuk
  _authBusy = true;
  console.log('[Auth] _authBusy = true (OTP verify)');

  try {
    const user = data.user;

    // Update password (ini trigger SIGNED_IN lagi — busy flag menghentikannya)
    await sb.auth.updateUser({ password });

    // Tunggu DB trigger handle_new_user selesai dulu
    await new Promise(r => setTimeout(r, 700));

    // Upsert profil dengan data yang benar (override default dari trigger)
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
    // ⚠️  KRITIS: Selalu reset, bahkan jika error (pakai finally)
    _authBusy = false;
    console.log('[Auth] _authBusy = false (OTP selesai)');
  }
}

async function resendOTPCode() {
  if (!pendingOTPData) return { success: false, error: 'Sesi habis.' };
  const { error } = await sb.auth.signInWithOtp({
    email: pendingOTPData.email, options: { shouldCreateUser: true }
  });
  return error ? { success: false, error: error.message } : { success: true };
}

// ════════════════════════════════════════════════════════════
//  LOGIN / LOGOUT
// ════════════════════════════════════════════════════════════

async function loginUser(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    const msg = error.message.includes('Invalid') ? 'Email atau password salah.'
      : error.message.includes('confirm') ? 'Email belum dikonfirmasi.'
      : error.message.includes('Too many') ? 'Terlalu banyak percobaan. Tunggu beberapa menit.'
      : 'Login gagal: ' + error.message;
    return { success: false, error: msg };
  }

  // Fetch profile dengan timeout — jangan biarkan login hang
  const profile = await getProfile(data.user.id);
  if (!profile) {
    await sb.auth.signOut();
    return { success: false, error: 'Profil tidak ditemukan. Hubungi admin.' };
  }
  return { success: true, user: data.user, profile };
}

async function loginWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google', options: { redirectTo: window.location.origin }
  });
  if (error) showToast('Error', error.message, 'error');
}

async function logoutUser() {
  await rtUnsubscribeAll();
  await sb.auth.signOut();
  cacheClear();
  currentUser = currentProfile = null;
  showPage('page-login');
}

// ════════════════════════════════════════════════════════════
//  CACHED GETTERS — hindari fetch berulang
// ════════════════════════════════════════════════════════════

async function getMapelCached() {
  const hit = cacheGet('mapel:all');
  if (hit) return { data: hit, error: null };
  // Select spesifik — jangan select *
  const r = await sb.from('mapel')
    .select('id,nama,icon,is_locked,color_from,color_to,urutan,deskripsi')
    .order('urutan');
  if (r.data) cacheSet('mapel:all', r.data, TTL.mapel);
  return r;
}

async function getKisiKisiCached(mapelId) {
  const k   = `kisi:${mapelId}`;
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
  return { success: !error, error: error?.message };
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
  return { success: !error, error: error?.message, data: result };
}

async function updateMapel(id, data) {
  const { error } = await sb.from('mapel').update(data).eq('id', id);
  if (!error) cacheDel('mapel:');
  return { success: !error, error: error?.message };
}

async function deleteMapel(id) {
  const { error } = await sb.from('mapel').delete().eq('id', id);
  if (!error) { cacheDel('mapel:'); cacheDel('kisi:'); }
  return { success: !error, error: error?.message };
}

async function toggleMapelLock(id, locked) {
  const { error } = await sb.from('mapel').update({ is_locked: locked }).eq('id', id);
  if (!error) cacheDel('mapel:');
  return { success: !error, error: error?.message };
}

// ════════════════════════════════════════════════════════════
//  KISI-KISI CRUD
// ════════════════════════════════════════════════════════════

const getKisiKisi = id => sb.from('kisi_kisi')
  .select('id,judul,konten,tipe,urutan').eq('mapel_id', id).order('urutan');

async function createKisiKisi(data) {
  const { error, data: result } = await sb.from('kisi_kisi').insert(data).select().single();
  if (!error) cacheDel(`kisi:${data.mapel_id}`);
  return { success: !error, error: error?.message, data: result };
}

async function updateKisiKisi(id, data) {
  const { error } = await sb.from('kisi_kisi')
    .update({ ...data, updated_at: new Date().toISOString() }).eq('id', id);
  if (!error) cacheDel('kisi:');
  return { success: !error, error: error?.message };
}

async function deleteKisiKisi(id) {
  const { error } = await sb.from('kisi_kisi').delete().eq('id', id);
  if (!error) cacheDel('kisi:');
  return { success: !error, error: error?.message };
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

async function saveQuestion(mapelId, { question_text, type, explanation, options, urutan }) {
  if (!question_text?.trim()) return { success: false, error: 'Teks soal wajib diisi.' };
  if (type !== 'essay' && (!options || options.length < 2))
    return { success: false, error: 'Minimal 2 pilihan jawaban.' };
  if (type === 'mcq' && options.filter(o => o.is_correct).length !== 1)
    return { success: false, error: 'Pilihan ganda harus tepat 1 jawaban benar.' };
  if (type === 'multiple' && options.filter(o => o.is_correct).length < 2)
    return { success: false, error: 'Pilihan kompleks minimal 2 jawaban benar.' };

  const { data: q, error: qErr } = await sb.from('questions').insert({
    mapel_id: mapelId, question_text: question_text.trim(), type,
    explanation: explanation?.trim() || null, urutan: urutan || 0
  }).select().single();
  if (qErr) return { success: false, error: qErr.message };

  if (type !== 'essay' && options?.length) {
    const { error: oErr } = await sb.from('options').insert(
      options.map((o, i) => ({
        question_id: q.id,
        option_text: o.option_text.trim(),
        is_correct:  !!o.is_correct,
        urutan:      i + 1
      }))
    );
    if (oErr) return { success: false, error: 'Soal tersimpan tapi options gagal: ' + oErr.message };
  }
  return { success: true, data: q };
}

async function deleteQuestion(id) {
  const { error } = await sb.from('questions').delete().eq('id', id);
  return { success: !error, error: error?.message };
}

// ════════════════════════════════════════════════════════════
//  BROADCASTS
// ════════════════════════════════════════════════════════════

async function uploadBroadcastImage(file) {
  try {
    const ext  = file.name.split('.').pop();
    const name = `bcast_${Date.now()}.${ext}`;
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

async function sendBroadcast(title, message, imageUrl = null) {
  const { data: { user } } = await sb.auth.getUser();
  const { error } = await sb.from('broadcasts').insert({
    title: title || 'Pengumuman', message,
    image_url: imageUrl || null,
    created_by: user?.id
  });
  return { success: !error, error: error?.message };
}

async function getBroadcastHistory() {
  const { data } = await sb.from('broadcasts')
    .select('id,title,message,image_url,created_at')
    .order('created_at', { ascending: false }).limit(20);
  return data || [];
}

// Polling fallback: cek broadcast baru tiap 15 detik (jika realtime gagal)
let _bcastLastCheck = null;
let _bcastPollTimer = null;
let _bcastPollCb   = null;

async function _pollBroadcast() {
  if (!_bcastPollCb || !currentUser) return;
  try {
    let q = sb.from('broadcasts')
      .select('id,title,message,image_url,created_at')
      .order('created_at', { ascending: false }).limit(5);
    if (_bcastLastCheck) q = q.gt('created_at', _bcastLastCheck);
    const { data } = await q;
    if (data?.length) {
      _bcastLastCheck = new Date().toISOString();
      data.reverse().forEach(b => _bcastPollCb(b));
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

const rtMapel     = cb => rtSubscribe('mapel-ch',    { event: '*',      schema: 'public', table: 'mapel' }, cb);
const rtProfiles  = cb => rtSubscribe('profiles-ch', { event: '*',      schema: 'public', table: 'profiles' }, cb);
const rtBroadcast = cb => {
  startBroadcastPolling(cb); // polling fallback selalu aktif
  return rtSubscribe('broadcast-ch', { event: 'INSERT', schema: 'public', table: 'broadcasts' }, p => {
    _bcastLastCheck = new Date().toISOString(); // update timestamp agar polling tidak duplikat
    cb(p.new);
  });
};
