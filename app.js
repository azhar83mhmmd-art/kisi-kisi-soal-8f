// ════════════════════════════════════════════════════════════
//  app.js — KisiKisi 8F  |  Production Fix v3
//  Anti-stuck measures:
//  1. initApp tidak infinite loop — selalu ada exit path
//  2. Timeout 5 detik di setiap fetch profile
//  3. Fallback UI jika loading terlalu lama (tombol retry)
//  4. isAuthBusy() guard mencegah double-fetch saat OTP
//  5. Safety timeout 10 detik (bukan 15) dengan fallback yang jelas
// ════════════════════════════════════════════════════════════

// ── GLOBAL STATE ──────────────────────────────────────────
let currentUser    = null;
let currentProfile = null;
let currentMapel   = null;
let selectedRole   = 'siswa';
let allUsers       = [];
let editingMapelId = null, editingKisiId = null;
let activeAdminMapelId = null;
let soalMode       = 'kisi';
let currentSoalType = 'mcq';
let soalOptions    = [];
let editingSoalId  = null;
let allQuestions   = [];

// ── HELPERS ───────────────────────────────────────────────
const q       = id => document.getElementById(id);
const esc     = s  => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('id-ID',
  { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';

function setLoading(btn, on) {
  if (!btn) return;
  btn.classList.toggle('btn-loading', on);
  btn.disabled = on;
}

// ════════════════════════════════════════════════════════════
//  LOADING SCREEN — tiga state: loading | error | hidden
// ════════════════════════════════════════════════════════════

function showAppLoading(msg = 'Memuat...') {
  const el = q('app-loading');
  if (!el) return;
  el.style.display = 'flex'; el.style.opacity = '1';
  const t = el.querySelector('.loading-text'); if (t) t.textContent = msg;
  // Sembunyikan error state
  const errBox = q('loading-error'); if (errBox) errBox.style.display = 'none';
  const bar    = q('load-bar');      if (bar)    bar.style.display    = '';
  const spinner = el.querySelector('.loading-bar'); if (spinner) spinner.style.display = '';
}

// showLoadingError — loading screen jadi error UI yang berguna
// Tombol "Coba Lagi" → jalankan ulang onRetry (fetch nyata)
// Tombol "Keluar & Login Ulang" → clear session + redirect login
function showLoadingError(msg, onRetry) {
  const el = q('app-loading');
  if (!el) { hideAppLoading(); return; }
  el.style.display = 'flex'; el.style.opacity = '1';
  const t = el.querySelector('.loading-text'); if (t) t.textContent = '';
  const bar    = q('load-bar');
  const barWrap = el.querySelector('.loading-bar');
  if (bar)     bar.style.display    = 'none';
  if (barWrap) barWrap.style.display = 'none';

  let errBox = q('loading-error');
  if (!errBox) {
    errBox = document.createElement('div');
    errBox.id = 'loading-error';
    errBox.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;padding:0 24px';
    el.querySelector('.loading-inner').appendChild(errBox);
  }
  errBox.style.display = 'flex';
  // Ganti \n dengan <br> untuk tampilan multi-baris
  const msgHtml = esc(msg).replace(/\\n|\n/g, '<br>');
  errBox.innerHTML = `
    <div style="font-size:36px">⚠️</div>
    <div style="font-size:13px;color:var(--muted);line-height:1.7;max-width:280px">${msgHtml}</div>
    <button id="btn-retry-load"
      style="padding:10px 24px;background:linear-gradient(135deg,#4f8ef7,#3a6fd8);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;">
      🔄 Coba Lagi
    </button>
    <button onclick="forceLogout()" 
      style="padding:8px 20px;background:rgba(255,255,255,.06);color:var(--muted);border:1px solid rgba(255,255,255,.1);border-radius:10px;font-size:13px;cursor:pointer;">
      Keluar & Login Ulang
    </button>`;
  // Pasang event listener (bukan inline onclick dengan toString agar aman)
  const retryBtn = document.getElementById('btn-retry-load');
  if (retryBtn && onRetry) retryBtn.addEventListener('click', onRetry);
}

function hideAppLoading() {
  const el = q('app-loading');
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(() => { el.style.display = 'none'; }, 300);
}

async function forceLogout() {
  cacheClear();
  await sb.auth.signOut().catch(() => {});
  currentUser = currentProfile = null;
  hideAppLoading();
  showPage('page-login');
}

// ── ROUTER ────────────────────────────────────────────────
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const p = q(id);
  if (p) { p.classList.add('active'); window.scrollTo(0, 0); }
}

// ── TOAST ─────────────────────────────────────────────────
function showToast(title, msg, type = 'info') {
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="t-icon">${icons[type]||'ℹ️'}</span>
    <div><div class="t-title">${esc(title)}</div><div class="t-msg">${esc(msg)}</div></div>
    <button class="t-close" onclick="this.parentElement.remove()">✕</button>`;
  const tc = q('toast-container');
  if (tc) tc.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 280); }, 4500);
}

// ── MARKDOWN ──────────────────────────────────────────────
function md(text) {
  if (!text) return '';
  return text
    .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/`(.+?)`/g,       '<code>$1</code>')
    .replace(/^> (.+)$/gm,     '<blockquote>$1</blockquote>')
    .replace(/^- (.+)$/gm,     '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)+/g, '<ul>$&</ul>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/\|(.+)\|/g, m => {
      const cells = m.slice(1,-1).split('|').map(c => c.trim());
      return '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
    })
    .replace(/(<tr>[\s\S]*?<\/tr>)+/g, '<table>$&</table>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
}

// ════════════════════════════════════════════════════════════
//  AUTH CORE — FIX UTAMA ADA DI SINI
// ════════════════════════════════════════════════════════════

// OPTIMIZED — fetchProfileSafe v4
// - Cek localStorage cache DULU → tampil instan tanpa request server
// - Fetch server di background → update UI jika ada perubahan
// - Auto-retry dengan backoff saat koneksi lambat
// - Tidak ada fake timeout / setTimeout palsu
async function fetchProfileSafe(user) {
  const isOAuth = (user.app_metadata && user.app_metadata.provider === 'google')
    || (user.app_metadata && user.app_metadata.providers && user.app_metadata.providers.includes('google'));

  console.log('[Auth] fetchProfileSafe:', user.email, '| OAuth:', isOAuth);

  // ── LANGKAH 0: Cek localStorage cache (tampil instan < 10ms) ──
  const cached = profileCacheGet(user.id);
  if (cached) {
    console.log('[Auth] Profile dari localStorage cache — tampil instan');
    // Refresh dari server di background (tidak blokir UI)
    getProfile(user.id).then(fresh => {
      if (fresh && currentProfile && fresh.user_id === currentProfile.user_id) {
        const changed = JSON.stringify(fresh) !== JSON.stringify(currentProfile);
        if (changed) {
          console.log('[Auth] Profile diperbarui dari server (background refresh)');
          currentProfile = fresh;
          // Update UI jika status berubah (misal: pending → approved)
          if (fresh.status !== cached.status || fresh.role !== cached.role) {
            routeProfile(fresh);
          }
        }
      }
    }).catch(() => {});
    return cached;
  }

  // ── LANGKAH 1: Fetch dari server dengan auto-retry ──
  console.log('[Auth] Tidak ada cache, fetch dari server...');
  let profile = null;
  try {
    profile = await withRetry(
      function() { return getProfile(user.id); },
      { maxAttempts: 3, baseDelay: 400, label: 'fetchProfileSafe' }
    );
  } catch(e) {
    console.error('[Auth] fetchProfileSafe: semua retry gagal:', e.message);
  }

  if (profile) {
    console.log('[Auth] Profil ditemukan dari server');
    return profile;
  }

  // ── LANGKAH 2: Tunggu DB trigger lalu coba lagi ──
  console.log('[Auth] Profil belum ada, tunggu DB trigger 800ms...');
  await new Promise(function(r) { setTimeout(r, 800); });

  profile = await getProfile(user.id);
  if (profile) {
    console.log('[Auth] Profil ditemukan setelah tunggu DB trigger');
    return profile;
  }

  // ── LANGKAH 3: Buat profil otomatis ──
  console.log('[Auth] Profil tidak ada, buat otomatis...');
  profile = await ensureProfile(user);
  if (profile) {
    console.log('[Auth] Profil berhasil dibuat otomatis');
    return profile;
  }

  console.error('[Auth] fetchProfileSafe: semua upaya gagal');
  return null;
}

// OPTIMIZED — initApp v4
// - Jika ada cache → tampilkan UI dulu, load profil di background
// - Tidak ada blocking UI
// - Semua loading berdasarkan response server nyata
// - Handle offline dengan pesan yang jelas
async function initApp(session) {
  if (!session) {
    console.log('[Auth] initApp: session null → ke login');
    hideAppLoading();
    showPage('page-login');
    return;
  }

  console.log('[Auth] initApp: session ada untuk', session.user.email);
  currentUser = session.user;

  // ── CEK CACHE DULU: tampilkan UI tanpa delay ──
  const cachedProfile = profileCacheGet(session.user.id);
  if (cachedProfile) {
    console.log('[Auth] initApp: pakai cache → UI tampil instan');
    currentProfile = cachedProfile;
    routeProfile(cachedProfile);
    // Fetch terbaru di background — tidak blokir
    fetchProfileSafe(session.user).catch(() => {});
    return;
  }

  // ── TIDAK ADA CACHE: tampilkan loading screen yang real ──
  // Periksa koneksi terlebih dahulu
  if (!isOnline()) {
    showLoadingError(
      'Tidak ada koneksi internet.\nHubungkan ke WiFi atau aktifkan data seluler, lalu coba lagi.',
      function() { location.reload(); }
    );
    return;
  }

  showAppLoading('Memuat profil Anda...');

  // Timeout 8 detik — semua berdasarkan response server nyata
  const profilePromise = fetchProfileSafe(session.user);
  const timeoutPromise = new Promise(function(resolve) {
    setTimeout(function() { resolve('TIMEOUT'); }, 8000);
  });

  const result = await Promise.race([profilePromise, timeoutPromise]);

  if (result === 'TIMEOUT') {
    console.error('[Auth] initApp TIMEOUT — profile fetch melebihi 8 detik');
    showLoadingError(
      'Koneksi terputus, mencoba kembali...\nServer lambat merespons. Periksa koneksi internet Anda.',
      function() {
        showAppLoading('Menghubungkan ke server...');
        initApp(session);
      }
    );
    return;
  }

  const profile = result;

  if (!profile) {
    console.error('[Auth] initApp: profile null setelah semua upaya');
    showLoadingError(
      'Profil tidak ditemukan.\nKemungkinan akun belum terdaftar atau ada masalah database.',
      async function() {
        showAppLoading('Mencoba ulang...');
        await initApp(session);
      }
    );
    return;
  }

  console.log('[Auth] initApp: sukses → role:', profile.role, '| status:', profile.status);
  currentProfile = profile;
  routeProfile(profile);
}

function routeProfile(p) {
  hideAppLoading();
  if (p.role === 'admin') {
    showToast('Selamat Datang', `Admin ${p.nama_lengkap} ✦`, 'success');
    initAdmin(); showPage('page-admin');
  } else if (p.status === 'approved') {
    showToast('Halo!', `Selamat datang, ${p.nama_lengkap} 👋`, 'success');
    initDashboard(); showPage('page-dashboard');
  } else if (p.status === 'pending') {
    // Tampilkan nama di halaman pending
    const nameEl = q('pending-name');
    if (nameEl) nameEl.textContent = p.nama_lengkap;
    const emailEl = q('pending-email');
    if (emailEl) emailEl.textContent = p.email;
    showPage('page-pending');
    // Realtime: otomatis redirect saat admin approve/reject
    startPendingListener(p.user_id);
  } else {
    showPage('page-rejected');
  }
}

let _pendingChannel = null;
function startPendingListener(userId) {
  if (_pendingChannel) { try { _pendingChannel.unsubscribe(); } catch(_){} }
  _pendingChannel = sb.channel('pending-status-' + userId)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'profiles',
      filter: `user_id=eq.${userId}`
    }, async payload => {
      const status = payload.new?.status;
      if (status === 'approved') {
        if (_pendingChannel) { _pendingChannel.unsubscribe(); _pendingChannel = null; }
        currentProfile = payload.new;
        showToast('Disetujui! 🎉', 'Akun Anda telah disetujui admin.', 'success');
        initDashboard(); showPage('page-dashboard');
      } else if (status === 'rejected') {
        if (_pendingChannel) { _pendingChannel.unsubscribe(); _pendingChannel = null; }
        showPage('page-rejected');
      }
    })
    .subscribe();
}

// ════════════════════════════════════════════════════════════
//  AUTH UI — TABS, LOGIN, REGISTER, OTP
// ════════════════════════════════════════════════════════════

let authTab = 'login';
function switchTab(tab) {
  authTab = tab;
  q('login-form').style.display    = tab === 'login'    ? 'block' : 'none';
  q('register-form').style.display = tab === 'register' ? 'block' : 'none';
  q('tab-masuk').classList.toggle('active', tab === 'login');
  q('tab-daftar').classList.toggle('active', tab === 'register');
  if (tab === 'register') setRole('siswa');
}

function setRole(role) {
  selectedRole = role;
  ['role-siswa','role-admin'].forEach(id => {
    const el = q(id); if (!el) return;
    el.classList.toggle('role-active', (id === 'role-siswa' && role === 'siswa') || (id === 'role-admin' && role === 'admin'));
    el.classList.toggle('siswa-active', id === 'role-siswa' && role === 'siswa');
    el.classList.toggle('admin-active', id === 'role-admin' && role === 'admin');
  });
  const sw = q('secret-wrap'); if (sw) sw.style.display = role === 'admin' ? 'block' : 'none';
}

async function handleLogin(e) {
  e.preventDefault();
  const btn   = q('btn-login');
  const email = q('login-email').value.trim();
  const pw    = q('login-password').value;
  if (!email || !pw) { showToast('Error', 'Email dan password wajib diisi.', 'error'); return; }

  setLoading(btn, true);
  const res = await loginUser(email, pw);
  setLoading(btn, false);

  if (!res.success) { showToast('Gagal Masuk', res.error, 'error'); return; }

  currentUser = res.user; currentProfile = res.profile;
  showAppLoading('Memuat...');
  routeProfile(res.profile);
}

async function handleGoogleLogin() {
  const btn = q('btn-google');
  if (btn) btn.disabled = true;
  const res = await loginWithGoogle();
  if (!res.success) {
    if (btn) btn.disabled = false;
    showToast('Error', res.error || 'Gagal login Google.', 'error');
  }
  // Jika sukses → halaman akan redirect, tidak perlu action lain
}

async function handleRegister(e) {
  e.preventDefault();
  const btn   = q('btn-register');
  const nama  = q('reg-nama').value.trim();
  const email = q('reg-email').value.trim();
  const pw    = q('reg-password').value;

  if (pw.length < 6) { showToast('Error', 'Password minimal 6 karakter.', 'error'); return; }
  if (selectedRole === 'admin' && q('reg-secret')?.value.trim() !== ADMIN_SECRET_CODE) {
    showToast('Kode Salah', 'Kode rahasia admin tidak valid.', 'error'); return;
  }

  setLoading(btn, true);
  const res = await initiateRegister(nama, email, pw, '8F', selectedRole);
  setLoading(btn, false);

  if (!res.success) { showToast('Error', res.error, 'error'); return; }
  q('otp-email-display').textContent = email;
  q('otp-role-info').textContent = selectedRole === 'admin' ? 'Admin' : 'Siswa';
  showPage('page-otp');
  startOtpTimer();
}

// ── OTP ───────────────────────────────────────────────────
let otpInterval = null;
function startOtpTimer() {
  let s = 300;
  const el = q('otp-countdown');
  if (otpInterval) clearInterval(otpInterval);
  otpInterval = setInterval(() => {
    s--;
    if (el) el.textContent = `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`;
    if (s <= 0) { clearInterval(otpInterval); if (el) el.textContent = 'Kadaluarsa'; showToast('OTP Kadaluarsa','Daftar ulang.','warning'); }
  }, 1000);
}

function otpInput(e, i) {
  e.target.value = e.target.value.replace(/\D/g, '').slice(-1);
  e.target.classList.toggle('on', !!e.target.value);
  if (e.target.value && i < 7) q(`otp-${i+1}`)?.focus();
  if ([...Array(8)].every((_,j) => q(`otp-${j}`)?.value)) setTimeout(submitOTP, 200);
}
function otpKey(e, i) {
  if (e.key === 'Backspace' && !e.target.value && i > 0) q(`otp-${i-1}`)?.focus();
}

async function submitOTP() {
  const otp = [...Array(8)].map((_,i) => q(`otp-${i}`)?.value || '').join('');
  if (otp.length < 8) { showToast('Error', 'Isi 8 digit OTP.', 'error'); return; }

  const btn = q('btn-verify-otp');
  setLoading(btn, true);
  showAppLoading('Memverifikasi OTP...');

  const res = await verifyOTPAndRegister(otp);
  setLoading(btn, false);
  hideAppLoading();

  if (!res.success) {
    showToast('OTP Gagal', res.error, 'error');
    [...Array(8)].forEach((_,i) => { const b = q(`otp-${i}`); if (b) { b.value=''; b.classList.remove('on'); } });
    q('otp-0')?.focus();
    return;
  }

  clearInterval(otpInterval);
  currentUser = res.user; currentProfile = res.profile;

  if (res.profile?.role === 'admin') {
    showToast('Berhasil!', `Selamat datang, ${res.profile.nama_lengkap}! 🎉`, 'success');
    initAdmin(); showPage('page-admin');
  } else {
    showToast('Berhasil!', 'Akun dibuat. Menunggu persetujuan admin.', 'success');
    showPage('page-pending');
  }
}

async function handleResendOTP() {
  const res = await resendOTPCode();
  if (!res.success) { showToast('Error', res.error, 'error'); return; }
  [...Array(8)].forEach((_,i) => { const b = q(`otp-${i}`); if (b) { b.value=''; b.classList.remove('on'); } });
  q('otp-0')?.focus();
  startOtpTimer();
  showToast('Terkirim', 'OTP baru dikirim ke email.', 'info');
}

async function checkStatus() {
  if (!currentUser) return;
  showToast('Mengecek...', 'Memeriksa status akun.', 'info');
  const p = await getProfile(currentUser.id);
  if (!p) { showToast('Error','Gagal cek status.','error'); return; }
  currentProfile = p;
  if (p.status === 'approved')  { initDashboard(); showPage('page-dashboard'); showToast('Disetujui!','Akun Anda disetujui 🎉','success'); }
  else if (p.status === 'rejected') showPage('page-rejected');
  else showToast('Masih Pending','Akun masih diverifikasi admin.','warning');
}

// ════════════════════════════════════════════════════════════
//  DASHBOARD
// ════════════════════════════════════════════════════════════

async function initDashboard() {
  const p = currentProfile;
  if (p) {
    q('dash-name').textContent   = p.nama_lengkap;
    q('dash-avatar').textContent = p.nama_lengkap.charAt(0).toUpperCase();
    const h = new Date().getHours();
    q('dash-greeting').textContent =
      h < 11 ? 'Selamat Pagi ☀️' : h < 15 ? 'Selamat Siang 🌤️' : h < 18 ? 'Selamat Sore 🌅' : 'Selamat Malam 🌙';
  }
  await loadMapel();
  rtMapel(() => { cacheDel('mapel:'); loadMapel(); });
  rtBroadcast(broadcast => showBroadcastModal(broadcast));
}

async function loadMapel() {
  const grid = q('mapel-grid'); if (!grid) return;

  // Skeleton loading nyata — animasi shimmer, bukan spinner kosong
  grid.innerHTML = [...Array(6)].map(() => `
    <div class="mapel-card skeleton-card" aria-label="Memuat...">
      <div class="skeleton skeleton-icon"></div>
      <div class="skeleton skeleton-line lg"></div>
      <div class="skeleton skeleton-line sm"></div>
    </div>`).join('');

  const { data, error } = await getMapelCached();

  if (error) {
    grid.innerHTML = `<div class="empty-full" style="grid-column:1/-1">
      <div class="e-icon">⚠️</div>
      <p style="color:var(--red);margin-bottom:12px">Gagal memuat mata pelajaran.</p>
      <button class="btn btn-ghost btn-sm" onclick="loadMapel()">🔄 Coba Lagi</button>
    </div>`; return;
  }

  const avail = (data||[]).filter(m => !m.is_locked).length;
  const te = q('stat-total'); if (te) te.textContent = (data||[]).length;
  const ae = q('stat-avail'); if (ae) ae.textContent = avail;

  if (!(data||[]).length) {
    grid.innerHTML = `<div class="empty-full" style="grid-column:1/-1"><div class="e-icon">📭</div><p>Belum ada mata pelajaran.</p></div>`;
    return;
  }

  grid.innerHTML = data.map((m, i) => `
    <div class="mapel-card ${m.is_locked?'locked':''}"
      onclick="${m.is_locked ? `showLockedMsg('${esc(m.nama)}')` : `showDisclaimer('${m.id}','${esc(m.nama)}','${m.icon}')`}"
      style="animation-delay:${i*.045}s;--card-accent:linear-gradient(135deg,${m.color_from},${m.color_to})"
      title="${m.is_locked?'Terkunci':'Buka kisi-kisi'}">
      ${m.is_locked ? '<span class="mapel-lock">🔒</span>' : ''}
      <span class="mapel-icon">${m.icon}</span>
      <div class="mapel-name">${esc(m.nama)}</div>
      <div class="mapel-status ${m.is_locked?'lock':'avail'}">
        <span class="mapel-dot"></span>${m.is_locked?'Terkunci':'Tersedia'}
      </div>
    </div>`).join('');
}

function showLockedMsg(nama) { showToast('Terkunci 🔒', `${nama} belum dibuka oleh admin.`, 'warning'); }

// ── DISCLAIMER ────────────────────────────────────────────
function showDisclaimer(id, nama, icon) {
  q('disc-icon').textContent = icon;
  q('disc-name').textContent = nama;
  q('btn-disc-ok').onclick   = () => { closeModal('modal-disclaimer'); openKisi(id, nama, icon); };
  openModal('modal-disclaimer');
}

// ── KISI PAGE ─────────────────────────────────────────────
async function openKisi(id, nama, icon) {
  currentMapel = { id, nama, icon };
  q('kisi-hero').innerHTML = `
    <div class="kisi-back" onclick="goBack()">← Kembali</div>
    <div class="kisi-hero-card" style="--hero-grad:linear-gradient(90deg,var(--blue),var(--purple))">
      <div class="kisi-hero-top">
        <span class="kisi-big-icon">${icon}</span>
        <div>
          <div class="kisi-title">${esc(nama)}</div>
          <div class="kisi-sub">Kisi-kisi Ulangan · Kelas 8F</div>
        </div>
      </div>
    </div>`;
  showPage('page-kisi');
  const tabBar = q('kisi-tab-bar'); if (tabBar) tabBar.style.display = 'flex';
  switchKisiTab('materi');
}

function switchKisiTab(tab) {
  soalMode = tab;
  ['materi','questions'].forEach(t => q(`ktab-${t}`)?.classList.toggle('active', t===tab));
  if (tab === 'materi') loadKisiMateri(currentMapel.id);
  else loadKisiQuestions(currentMapel.id);
}

async function loadKisiMateri(mapelId) {
  const list = q('kisi-list');
  list.innerHTML = `<div style="padding:0 20px 24px">${[...Array(3)].map(()=>`<div class="skel" style="height:68px;border-radius:14px;margin-bottom:12px"></div>`).join('')}</div>`;
  const { data, error } = await getKisiKisiCached(mapelId);
  if (error) {
    list.innerHTML = `<div class="empty"><div class="e-icon">⚠️</div><p style="color:var(--red)">Gagal memuat kisi-kisi.</p>
      <button class="btn btn-ghost btn-sm" style="margin-top:12px" onclick="loadKisiMateri('${mapelId}')">🔄 Coba Lagi</button></div>`; return;
  }
  if (!data?.length) { list.innerHTML = `<div class="empty"><div class="e-icon">📭</div><p>Belum ada kisi-kisi.</p></div>`; return; }
  list.innerHTML = `<div style="padding:0 20px 32px">` + data.map((item,i) => `
    <div class="kisi-item" id="ki-${item.id}" style="animation-delay:${i*.06}s">
      <div class="kisi-item-hd" onclick="toggleKisi('${item.id}')">
        <div class="kisi-row">
          <span class="tag ${item.tipe}">${item.tipe}</span>
          <span class="kisi-item-title">${esc(item.judul)}</span>
        </div>
        <span class="chevron">▼</span>
      </div>
      <div class="kisi-body"><div class="kisi-body-inner">${md(item.konten)}</div></div>
    </div>`).join('') + `</div>`;
  if (data[0]) setTimeout(() => toggleKisi(data[0].id), 300);
}

async function loadKisiQuestions(mapelId) {
  const list = q('kisi-list');
  list.innerHTML = `<div style="padding:0 20px 24px">${[...Array(3)].map(()=>`<div class="skel" style="height:80px;border-radius:14px;margin-bottom:12px"></div>`).join('')}</div>`;
  const { data, error } = await getQuestions(mapelId);
  allQuestions = data || [];
  if (error || !data?.length) {
    list.innerHTML = `<div class="empty"><div class="e-icon">❓</div><p>Belum ada soal latihan.</p></div>`; return;
  }
  list.innerHTML = `<div style="padding:0 20px 32px">` +
    `<div class="soal-header"><span class="soal-count">${data.length} Soal</span>
     <button class="btn btn-ghost btn-sm" onclick="checkAllAnswers()">Periksa Semua</button></div>` +
    data.map((q_, i) => renderQuestionCard(q_, i)).join('') + `</div>`;
}

function renderQuestionCard(q_, i) {
  const typeLabel = { mcq:'Pilihan Ganda', multiple:'Pilihan Kompleks', essay:'Isian' };
  const typeColor = { mcq:'var(--blue)', multiple:'var(--purple)', essay:'var(--amber)' };
  let optHtml = '';
  if (q_.type !== 'essay' && q_.options?.length) {
    optHtml = `<div class="q-options">${q_.options.map((o,oi) => `
      <label class="q-opt" id="qopt-${q_.id}-${oi}">
        <input type="${q_.type==='mcq'?'radio':'checkbox'}" name="q-${q_.id}" value="${o.id}" data-correct="${o.is_correct}" class="q-input" onchange="onAnswerChange('${q_.id}')">
        <span class="q-opt-text">${esc(o.option_text)}</span>
      </label>`).join('')}</div>`;
  } else if (q_.type === 'essay') {
    optHtml = `<textarea class="q-essay-input" id="essay-${q_.id}" placeholder="Tulis jawaban Anda di sini..." rows="3"></textarea>`;
  }
  return `
    <div class="q-card" id="qcard-${q_.id}" style="animation-delay:${i*.05}s">
      <div class="q-meta">
        <span class="q-num">${i+1}</span>
        <span class="q-type-badge" style="color:${typeColor[q_.type]}">${typeLabel[q_.type]}</span>
      </div>
      <div class="q-text">${esc(q_.question_text)}</div>
      ${optHtml}
      <div class="q-feedback" id="qfb-${q_.id}" style="display:none"></div>
    </div>`;
}

function onAnswerChange(qId) { q(`qcard-${qId}`)?.classList.add('answered'); }

function checkAllAnswers() {
  let correct = 0, total = 0;
  allQuestions.forEach(qu => {
    if (qu.type === 'essay') return;
    total++;
    const inputs   = document.querySelectorAll(`input[name="q-${qu.id}"]`);
    const selected = [...inputs].filter(i => i.checked);
    const fb       = q(`qfb-${qu.id}`);
    const card     = q(`qcard-${qu.id}`);
    if (!selected.length) {
      if (fb) { fb.style.display='block'; fb.className='q-feedback q-skip'; fb.textContent='⚪ Belum dijawab'; } return;
    }
    const correctIds  = qu.options.filter(o=>o.is_correct).map(o=>o.id);
    const selectedIds = selected.map(i=>i.value);
    const ok = correctIds.length === selectedIds.length && correctIds.every(id=>selectedIds.includes(id));
    if (ok) { correct++; card?.classList.add('q-correct'); } else { card?.classList.add('q-wrong'); }
    inputs.forEach((inp,oi) => {
      const lbl = q(`qopt-${qu.id}-${oi}`);
      if (lbl) {
        if (inp.dataset.correct === 'true') lbl.classList.add('opt-correct');
        else if (inp.checked) lbl.classList.add('opt-wrong');
      }
    });
    let expHtml = ok ? '✅ Benar!' : '❌ Salah.';
    if (!ok && qu.explanation) expHtml += ` <span class="q-exp">${esc(qu.explanation)}</span>`;
    if (fb) { fb.style.display='block'; fb.className=`q-feedback ${ok?'q-fb-correct':'q-fb-wrong'}`; fb.innerHTML=expHtml; }
  });
  const pct = total > 0 ? Math.round((correct/total)*100) : 0;
  showToast(
    pct >= 80 ? '🎉 Bagus!' : pct >= 60 ? '👍 Lumayan!' : '💪 Terus Belajar!',
    `Skor: ${correct}/${total} (${pct}%)`,
    pct >= 80 ? 'success' : pct >= 60 ? 'info' : 'warning'
  );
}

function toggleKisi(id) { q(`ki-${id}`)?.classList.toggle('open'); }
function goBack()        { showPage('page-dashboard'); }

// ════════════════════════════════════════════════════════════
//  BROADCAST POP-UP
// ════════════════════════════════════════════════════════════

const BCAST_KEY   = 'kisi8f_read_bcast';
const getRead     = () => { try { return JSON.parse(localStorage.getItem(BCAST_KEY)||'[]'); } catch{return[];} };
const markRead    = id => { const r=getRead(); if(!r.includes(id)) localStorage.setItem(BCAST_KEY,JSON.stringify([...r,id].slice(-50))); };

function showBroadcastModal(b) {
  if (!b?.id || getRead().includes(b.id)) return;
  document.getElementById('bcast-overlay')?.remove();
  const el = document.createElement('div');
  el.id = 'bcast-overlay'; el.className = 'modal-bg open';
  const imgHtml = b.image_url
    ? `<div class="bcast-img-wrap"><img src="${b.image_url}" alt="Gambar" class="bcast-img" onclick="this.classList.toggle('bcast-img-zoom')"></div>`
    : '';
  el.innerHTML = `
    <div class="modal bcast-modal">
      <div class="bcast-stripe"></div>
      <div class="bcast-head">
        <span class="bcast-icon">📢</span>
        <div>
          <div class="bcast-title">${esc(b.title||'Pengumuman')}</div>
          <div class="bcast-time">${fmtDate(b.created_at)}</div>
        </div>
        <button class="modal-close" style="position:static;margin-left:auto" onclick="closeBcast('${b.id}')">✕</button>
      </div>
      ${imgHtml}
      <div class="bcast-body">${esc(b.message)}</div>
      <button class="btn btn-primary w-full" onclick="closeBcast('${b.id}')">✓ Mengerti</button>
    </div>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
}

function closeBcast(id) {
  markRead(id);
  const el = document.getElementById('bcast-overlay');
  if (el) { el.classList.remove('open'); setTimeout(()=>{ el.remove(); document.body.style.overflow=''; },280); }
}

// ════════════════════════════════════════════════════════════
//  ADMIN
// ════════════════════════════════════════════════════════════

function initAdmin() {
  const p = currentProfile;
  if (p) {
    q('admin-name').textContent   = p.nama_lengkap;
    q('admin-avatar').textContent = p.nama_lengkap.charAt(0).toUpperCase();
  }
  loadAdminStats(); loadUsers(); adminSection('users');
  rtProfiles(() => { loadAdminStats(); loadUsers(); showToast('Update','Data pengguna berubah.','info'); });
  rtBroadcast(b => showBroadcastModal(b));
}

function adminSection(sec) {
  ['users','mapel','soal','broadcast','stats'].forEach(s => {
    q(`snav-${s}`)?.classList.toggle('active', s===sec);
    q(`nav-${s}`)?.classList.toggle('active', s===sec);
    const el = q(`admin-${s}`); if (el) el.style.display = s===sec ? 'block' : 'none';
  });
  if (sec==='users')     { loadUsers(); loadAdminStats(); }
  if (sec==='mapel')     loadAdminMapel();
  if (sec==='soal')      loadAdminSoalPage();
  if (sec==='broadcast') loadBroadcastPage();
  if (sec==='stats')     loadAdminStats();
}

// ── USERS ─────────────────────────────────────────────────
async function loadAdminStats() {
  const { data } = await getAllUsers(); if (!data) return;
  allUsers = data;
  const c = data.reduce((a,u)=>{ a[u.status]=(a[u.status]||0)+1; return a; },{});
  const s = (id,v) => { const e=q(id); if(e) e.textContent=v; };
  s('a-total',data.length); s('a-pending',c.pending||0); s('a-approved',c.approved||0); s('a-rejected',c.rejected||0);
  s('stat-today', data.filter(u=>new Date(u.created_at).toDateString()===new Date().toDateString()).length);
}

async function loadUsers() {
  const tbody = q('users-tbody'); if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" class="td-empty"><div class="skel" style="height:14px;width:50%;margin:0 auto"></div></td></tr>`;
  const { data, error } = await getAllUsers();
  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="td-empty" style="color:var(--red)">
      Gagal memuat. <button class="btn btn-ghost btn-sm" onclick="loadUsers()">Coba Lagi</button></td></tr>`; return;
  }
  allUsers = data || []; renderUsersTable(allUsers);
}

function renderUsersTable(data) {
  const tbody = q('users-tbody'); if (!tbody) return;
  if (!data.length) { tbody.innerHTML = `<tr><td colspan="6" class="td-empty">Belum ada pengguna.</td></tr>`; return; }
  tbody.innerHTML = data.map(u => {
    const isAdmin = u.role === 'admin';
    const actions = isAdmin ? `<span style="color:var(--dim)">—</span>` : `<div class="acts">
      ${u.status !== 'approved' ? `<button class="btn btn-success btn-sm" title="Setujui" onclick="setStatus('${u.id}','approved','${esc(u.nama_lengkap)}')">✓ Setujui</button>` : ''}
      ${u.status !== 'pending'  ? `<button class="btn btn-ghost btn-sm" title="Pending" onclick="setStatus('${u.id}','pending','${esc(u.nama_lengkap)}')">⏳</button>` : ''}
      <button class="btn btn-danger btn-sm" title="Tolak & Hapus" onclick="setStatus('${u.id}','rejected','${esc(u.nama_lengkap)}')">✕ Tolak</button>
    </div>`;
    return `<tr>
      <td><div class="u-cell">
        <div class="avatar" style="width:32px;height:32px;font-size:11px">${u.nama_lengkap.charAt(0).toUpperCase()}</div>
        <div><div class="u-name">${esc(u.nama_lengkap)}</div><div class="u-email">${esc(u.email)}</div></div>
      </div></td>
      <td>${esc(u.kelas)}</td>
      <td><span class="badge ${isAdmin ? 'b-admin' : 'b-siswa'}">${u.role}</span></td>
      <td><span class="badge b-${u.status}">${u.status}</span></td>
      <td class="td-date hide-sm">${fmtDate(u.created_at)}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
}

async function setStatus(id, status, nama) {
  if (status === 'rejected') {
    if (!confirm(`Tolak & hapus akun "${nama}"?\n\nAkun yang ditolak akan dihapus permanen.`)) return;
    const res = await deleteUserProfile(id);
    if (res.success) { showToast('Dihapus', `Akun ${nama} dihapus.`, 'warning'); loadUsers(); loadAdminStats(); }
    else showToast('Error', res.error, 'error');
    return;
  }
  const res = await updateUserStatus(id, status);
  const labels = { approved: 'Disetujui ✅', pending: 'Ke Pending' };
  const types  = { approved: 'success', pending: 'info' };
  if (res.success) { showToast('Berhasil', `${nama} — ${labels[status]}`, types[status]); loadUsers(); loadAdminStats(); }
  else showToast('Error', res.error, 'error');
}

function searchUsers(val) {
  renderUsersTable(allUsers.filter(u =>
    (u.nama_lengkap+u.email+u.status+u.role).toLowerCase().includes(val.toLowerCase())
  ));
}

// ── MAPEL ─────────────────────────────────────────────────
async function loadAdminMapel() {
  const grid = q('admin-mapel-grid'); if (!grid) return;
  grid.innerHTML = `<div class="skel" style="height:90px;border-radius:12px"></div>`.repeat(4);
  const { data } = await getMapel(); if (!data) return;
  grid.innerHTML = !data.length
    ? `<div class="empty-full" style="grid-column:1/-1"><div class="e-icon">📭</div><p>Belum ada mapel.</p></div>`
    : data.map(m => `
    <div class="mapel-mgr-card">
      <div class="mapel-mgr-top">
        <div class="mapel-mgr-info">
          <span class="mapel-mgr-icon">${m.icon}</span>
          <div>
            <div class="mapel-mgr-name">${esc(m.nama)}</div>
            <div class="mapel-mgr-status">Status: <span style="color:${m.is_locked?'var(--red)':'var(--green)'}">
              ${m.is_locked?'🔒 Terkunci':'✅ Tersedia'}</span></div>
          </div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${!m.is_locked?'checked':''} onchange="toggleMapel('${m.id}',this.checked)">
          <span class="toggle-track"></span>
        </label>
      </div>
      <div class="mapel-mgr-actions">
        <button class="btn btn-ghost btn-sm" onclick="openEditMapel('${m.id}','${esc(m.nama)}','${m.icon}','${m.color_from}','${m.color_to}',${m.urutan})">✏️ Edit</button>
        <button class="btn btn-ghost btn-sm" onclick="openSoalForMapel('${m.id}')">📝 Soal</button>
        <button class="btn btn-danger btn-sm" onclick="deleteMapelConfirm('${m.id}','${esc(m.nama)}')">🗑️</button>
      </div>
    </div>`).join('');
}

async function toggleMapel(id, enabled) {
  const res = await toggleMapelLock(id, !enabled);
  if (res.success) { showToast('Berhasil',`Mapel ${enabled?'dibuka':'dikunci'}.`,'success'); loadAdminMapel(); }
  else showToast('Error',res.error,'error');
}

function openAddMapel() {
  editingMapelId=null;
  q('mapel-modal-title').textContent='Tambah Mata Pelajaran';
  q('mapel-form-nama').value=''; q('mapel-form-icon').value='📚';
  q('mapel-form-from').value='#4f8ef7'; q('mapel-form-to').value='#9b7ef8';
  q('mapel-form-urutan').value='0'; openModal('modal-mapel');
}
function openEditMapel(id,nama,icon,from_,to_,urutan) {
  editingMapelId=id;
  q('mapel-modal-title').textContent='Edit Mata Pelajaran';
  q('mapel-form-nama').value=nama; q('mapel-form-icon').value=icon;
  q('mapel-form-from').value=from_; q('mapel-form-to').value=to_;
  q('mapel-form-urutan').value=urutan; openModal('modal-mapel');
}
async function saveMapel() {
  const nama=q('mapel-form-nama').value.trim(), icon=q('mapel-form-icon').value.trim()||'📚';
  const from_=q('mapel-form-from').value, to_=q('mapel-form-to').value;
  const urutan=parseInt(q('mapel-form-urutan').value)||0;
  if (!nama) { showToast('Error','Nama mapel wajib diisi.','error'); return; }
  const btn=q('btn-save-mapel'); setLoading(btn,true);
  const res = editingMapelId
    ? await updateMapel(editingMapelId,{nama,icon,color_from:from_,color_to:to_,urutan})
    : await createMapel({nama,icon,color_from:from_,color_to:to_,urutan,is_locked:true});
  setLoading(btn,false);
  if (res.success) { showToast('Berhasil',editingMapelId?'Diperbarui.':'Ditambahkan.','success'); closeModal('modal-mapel'); loadAdminMapel(); }
  else showToast('Error',res.error||'Gagal.','error');
}
async function deleteMapelConfirm(id,nama) {
  if (!confirm(`Hapus mapel "${nama}"? Semua kisi-kisi juga terhapus.`)) return;
  const res = await deleteMapel(id);
  if (res.success) { showToast('Dihapus',`"${nama}" dihapus.`,'warning'); loadAdminMapel(); }
  else showToast('Error',res.error,'error');
}

// ── SOAL ADMIN ────────────────────────────────────────────
async function loadAdminSoalPage() {
  const sel = q('soal-mapel-select'); if (!sel) return;
  const { data } = await getMapel();
  if (!data?.length) { q('admin-soal').innerHTML=`<h2 class="sec-title">Manajemen Soal</h2><div class="empty-full"><div class="e-icon">📚</div><p>Tambah mapel terlebih dahulu.</p></div>`; return; }
  sel.innerHTML = `<option value="">-- Pilih --</option>` + data.map(m=>`<option value="${m.id}">${m.icon} ${esc(m.nama)}</option>`).join('');
  if (activeAdminMapelId) { sel.value=activeAdminMapelId; onSoalMapelChange(); }
  switchSoalAdminTab('kisi');
}

function switchSoalAdminTab(tab) {
  soalMode=tab;
  q('stab-kisi')?.classList.toggle('active',tab==='kisi');
  q('stab-questions')?.classList.toggle('active',tab==='questions');
  q('kisi-admin-section').style.display     = tab==='kisi'      ? 'block' : 'none';
  q('questions-admin-section').style.display = tab==='questions' ? 'block' : 'none';
  if (!activeAdminMapelId) return;
  if (tab==='kisi') loadKisiAdmin(activeAdminMapelId); else loadQuestionsAdmin(activeAdminMapelId);
}

function onSoalMapelChange() {
  const id=q('soal-mapel-select').value; activeAdminMapelId=id;
  if (!id) {
    q('kisi-admin-list').innerHTML=q('questions-admin-list').innerHTML=`<div class="empty-hint">Pilih mapel di atas.</div>`; return;
  }
  if (soalMode==='kisi') loadKisiAdmin(id); else loadQuestionsAdmin(id);
}

function openSoalForMapel(mapelId) { activeAdminMapelId=mapelId; adminSection('soal'); }

async function loadKisiAdmin(mapelId) {
  const list=q('kisi-admin-list'); if(!list) return;
  list.innerHTML=[...Array(3)].map(()=>`<div class="skel" style="height:68px;border-radius:12px;margin-bottom:10px"></div>`).join('');
  const {data,error}=await getKisiKisi(mapelId);
  if (error) { list.innerHTML=`<div class="empty-full" style="color:var(--red)">Gagal memuat data. <button class="btn btn-ghost btn-sm" onclick="loadKisiAdmin('${mapelId}')">Retry</button></div>`; return; }
  if (!data?.length) { list.innerHTML=`<div class="empty-full"><div class="e-icon">📝</div><p>Belum ada kisi-kisi.</p></div>`; return; }
  list.innerHTML=data.map((item,i)=>`
    <div class="kisi-admin-item" style="animation-delay:${i*.04}s">
      <div class="kisi-admin-hd">
        <div class="kisi-admin-left">
          <span class="tag ${item.tipe}">${item.tipe}</span>
          <span class="kisi-admin-title">${esc(item.judul)}</span>
        </div>
        <div class="kisi-admin-acts">
          <button class="btn btn-ghost btn-sm" onclick="openEditKisi('${item.id}','${esc(item.judul)}','${item.tipe}',${item.urutan},\`${item.konten.replace(/`/g,'\\`')}\`)">✏️</button>
          <button class="btn btn-danger btn-sm" onclick="deleteKisiConfirm('${item.id}','${esc(item.judul)}')">🗑️</button>
        </div>
      </div>
      <div class="kisi-admin-preview">${esc(item.konten.substring(0,90))}${item.konten.length>90?'...':''}</div>
    </div>`).join('');
}

function openAddKisi() {
  if (!activeAdminMapelId) { showToast('Pilih Mapel','Pilih mapel dulu.','warning'); return; }
  editingKisiId=null;
  q('kisi-modal-title').textContent='Tambah Kisi-kisi';
  q('kisi-form-judul').value=''; q('kisi-form-tipe').value='materi';
  q('kisi-form-urutan').value='0'; q('kisi-form-konten').value='';
  openModal('modal-kisi');
}
function openEditKisi(id,judul,tipe,urutan,konten) {
  editingKisiId=id; q('kisi-modal-title').textContent='Edit Kisi-kisi';
  q('kisi-form-judul').value=judul; q('kisi-form-tipe').value=tipe;
  q('kisi-form-urutan').value=urutan; q('kisi-form-konten').value=konten;
  openModal('modal-kisi');
}
async function saveKisi() {
  const mapelId=activeAdminMapelId||q('soal-mapel-select')?.value;
  const judul=q('kisi-form-judul').value.trim(), tipe=q('kisi-form-tipe').value;
  const urutan=parseInt(q('kisi-form-urutan').value)||0, konten=q('kisi-form-konten').value.trim();
  if (!judul) { showToast('Error','Judul wajib diisi.','error'); return; }
  if (!konten){ showToast('Error','Konten wajib diisi.','error'); return; }
  const btn=q('btn-save-kisi'); setLoading(btn,true);
  const res = editingKisiId ? await updateKisiKisi(editingKisiId,{judul,tipe,urutan,konten}) : await createKisiKisi({judul,tipe,urutan,konten,mapel_id:mapelId});
  setLoading(btn,false);
  if (res.success) { showToast('Berhasil',editingKisiId?'Diperbarui.':'Ditambahkan.','success'); closeModal('modal-kisi'); loadKisiAdmin(mapelId); }
  else showToast('Error',res.error||'Gagal.','error');
}
async function deleteKisiConfirm(id,judul) {
  if (!confirm(`Hapus "${judul}"?`)) return;
  const res=await deleteKisiKisi(id); const mapelId=activeAdminMapelId;
  if (res.success) { showToast('Dihapus','Dihapus.','warning'); if(mapelId) loadKisiAdmin(mapelId); }
  else showToast('Error',res.error,'error');
}

async function loadQuestionsAdmin(mapelId) {
  const list=q('questions-admin-list'); if(!list) return;
  list.innerHTML=[...Array(3)].map(()=>`<div class="skel" style="height:80px;border-radius:12px;margin-bottom:10px"></div>`).join('');
  const {data,error}=await getQuestions(mapelId);
  if (error) { list.innerHTML=`<div class="empty-full" style="color:var(--red)">Gagal memuat soal.</div>`; return; }
  if (!data?.length) { list.innerHTML=`<div class="empty-full"><div class="e-icon">❓</div><p>Belum ada soal.</p></div>`; return; }
  const tLabel={mcq:'Pilihan Ganda',multiple:'Pilihan Kompleks',essay:'Essay'};
  const tColor={mcq:'var(--blue)',multiple:'var(--purple)',essay:'var(--amber)'};
  list.innerHTML=data.map((qu,i)=>`
    <div class="kisi-admin-item" style="animation-delay:${i*.04}s">
      <div class="kisi-admin-hd">
        <div class="kisi-admin-left" style="flex:1;min-width:0">
          <span class="q-num-badge">${i+1}</span>
          <span class="tag" style="color:${tColor[qu.type]};background:rgba(79,142,247,.08)">${tLabel[qu.type]}</span>
          <span class="kisi-admin-title">${esc(qu.question_text.substring(0,70))}${qu.question_text.length>70?'...':''}</span>
        </div>
        <div class="kisi-admin-acts" style="flex-shrink:0">
          <button class="btn btn-danger btn-sm" onclick="deleteQuestionConfirm('${qu.id}')">🗑️</button>
        </div>
      </div>
      ${qu.options?.length?`<div class="kisi-admin-preview">${qu.options.map(o=>`${o.is_correct?'✅':'◻️'} ${esc(o.option_text)}`).join(' · ')}</div>`:''}
    </div>`).join('');
}

async function deleteQuestionConfirm(id) {
  if (!confirm('Hapus soal ini?')) return;
  const res=await deleteQuestion(id);
  if (res.success) { showToast('Dihapus','Soal dihapus.','warning'); loadQuestionsAdmin(activeAdminMapelId); }
  else showToast('Error',res.error,'error');
}

// ── SOAL FORM ─────────────────────────────────────────────
function initSoalOptions() {
  soalOptions=[{option_text:'',is_correct:false},{option_text:'',is_correct:false},{option_text:'',is_correct:false},{option_text:'',is_correct:false}];
}

function setSoalType(type) {
  currentSoalType=type;
  ['mcq','multiple','essay'].forEach(t => q(`stype-${t}`)?.classList.toggle('active',t===type));
  const optSec=q('soal-options-section'), expLabel=q('soal-exp-label');
  if (type==='essay') {
    if(optSec) optSec.style.display='none';
    if(expLabel) expLabel.textContent='Kunci Jawaban *';
  } else {
    if(optSec) optSec.style.display='block';
    if(expLabel) expLabel.textContent='Pembahasan (Opsional)';
    const lbl=q('soal-options-label');
    if(lbl) lbl.textContent=type==='mcq'?'Pilihan Jawaban * (centang 1 benar)':'Pilihan Jawaban * (centang semua benar)';
    renderSoalOptions();
  }
}

function renderSoalOptions() {
  const list=q('soal-options-list'); if(!list) return;
  list.innerHTML=soalOptions.map((o,i)=>`
    <div class="opt-row">
      <input type="${currentSoalType==='mcq'?'radio':'checkbox'}" name="soal-correct" ${o.is_correct?'checked':''} class="opt-check" onchange="toggleSoalCorrect(${i},this.checked)">
      <input type="text" class="opt-input" value="${esc(o.option_text)}" placeholder="Pilihan ${String.fromCharCode(65+i)}..." oninput="updateSoalOpt(${i},this.value)">
      ${soalOptions.length>2?`<button class="btn-rm-opt" onclick="removeSoalOpt(${i})">✕</button>`:''}
    </div>`).join('');
}

function addSoalOpt() {
  if(soalOptions.length>=8){showToast('Batas','Maksimal 8 pilihan.','warning');return;}
  soalOptions.push({option_text:'',is_correct:false}); renderSoalOptions();
}
function removeSoalOpt(i)    { soalOptions.splice(i,1); renderSoalOptions(); }
function updateSoalOpt(i,v)  { if(soalOptions[i]) soalOptions[i].option_text=v; }
function toggleSoalCorrect(i,checked) {
  if(currentSoalType==='mcq') soalOptions.forEach((o,idx)=>o.is_correct=idx===i);
  else if(soalOptions[i]) soalOptions[i].is_correct=checked;
  renderSoalOptions();
}

function openAddQuestion() {
  if(!activeAdminMapelId){showToast('Pilih Mapel','Pilih mapel dulu.','warning');return;}
  editingSoalId=null; currentSoalType='mcq'; initSoalOptions();
  q('soal-modal-title').textContent='Tambah Soal';
  q('soal-form-text').value=''; q('soal-form-exp').value='';
  setSoalType('mcq'); openModal('modal-soal');
}

async function saveSoal() {
  const mapelId=activeAdminMapelId;
  const question_text=q('soal-form-text')?.value.trim()||'';
  const explanation=q('soal-form-exp')?.value.trim()||'';
  const btn=q('btn-save-soal'); setLoading(btn,true);
  const res=await saveQuestion(mapelId,{question_text,type:currentSoalType,explanation,options:currentSoalType!=='essay'?soalOptions:[],urutan:0});
  setLoading(btn,false);
  if (res.success) { showToast('Berhasil','Soal disimpan!','success'); closeModal('modal-soal'); loadQuestionsAdmin(mapelId); }
  else showToast('Gagal',res.error,'error');
}

// ── BROADCAST ADMIN ───────────────────────────────────────
async function loadBroadcastPage() {
  const hist=q('broadcast-history'); if(!hist) return;
  hist.innerHTML=`<div class="skel" style="height:60px;border-radius:10px;margin-bottom:8px"></div>`.repeat(3);
  const data=await getBroadcastHistory();
  if (!data.length) { hist.innerHTML=`<div class="empty-hint">Belum ada broadcast.</div>`; return; }
  hist.innerHTML=data.map(b=>`
    <div class="bcast-hist-item">
      <div class="bcast-hist-top">
        <strong>${esc(b.title||'Pengumuman')}</strong>
        <span class="td-date">${fmtDate(b.created_at)}</span>
      </div>
      <div class="bcast-hist-msg">${esc(b.message)}</div>
      ${b.image_url ? `<img src="${b.image_url}" alt="foto" class="bcast-hist-img" onclick="window.open('${b.image_url}','_blank')">` : ''}
    </div>`).join('');
}

function previewBcastImage(input) {
  const wrap = q('bcast-img-preview-wrap');
  const label = q('bcast-file-text');
  if (!input.files?.[0]) { if(wrap) wrap.innerHTML=''; return; }
  const file = input.files[0];
  label.textContent = '📎 ' + file.name;
  const url = URL.createObjectURL(file);
  if (wrap) wrap.innerHTML = `
    <div style="position:relative;display:inline-block;margin-top:8px;">
      <img src="${url}" style="max-width:100%;max-height:160px;border-radius:8px;border:1px solid var(--border-m);">
      <button onclick="removeBcastImage()" style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,.6);color:#fff;border:none;border-radius:50%;width:22px;height:22px;cursor:pointer;font-size:12px;">✕</button>
    </div>`;
}

function removeBcastImage() {
  const fi = q('bcast-image');
  if (fi) fi.value = '';
  const wrap = q('bcast-img-preview-wrap');
  if (wrap) wrap.innerHTML = '';
  const label = q('bcast-file-text');
  if (label) label.textContent = '📎 Pilih foto...';
}

async function handleSendBroadcast() {
  const title   = q('bcast-title')?.value.trim()||'Pengumuman';
  const message = q('bcast-message')?.value.trim();
  if (!message) { showToast('Error','Pesan tidak boleh kosong.','error'); return; }

  const btn = q('btn-send-bcast'); setLoading(btn, true);

  // Upload foto jika ada
  let imageUrl = null;
  const fileInput = q('bcast-image');
  if (fileInput?.files?.[0]) {
    const file = fileInput.files[0];
    if (file.size > 3 * 1024 * 1024) {
      showToast('Error', 'Ukuran foto max 3 MB.', 'error');
      setLoading(btn, false); return;
    }
    const upRes = await uploadBroadcastImage(file);
    if (!upRes.success) {
      showToast('Gagal Upload', upRes.error, 'error');
      setLoading(btn, false); return;
    }
    imageUrl = upRes.url;
  }

  const res = await sendBroadcast(title, message, imageUrl);
  setLoading(btn, false);
  if (res.success) {
    showToast('Terkirim!', 'Broadcast dikirim.', 'success');
    q('bcast-title').value = '';
    q('bcast-message').value = '';
    if (fileInput) { fileInput.value = ''; q('bcast-img-preview')?.remove(); }
    loadBroadcastPage();
  } else showToast('Gagal', res.error, 'error');
}

// ── MODAL ─────────────────────────────────────────────────
const openModal  = id => { const el=q(id); if(el){el.classList.add('open');document.body.style.overflow='hidden';} };
const closeModal = id => { const el=q(id); if(el){el.classList.remove('open');document.body.style.overflow='';} };
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-bg')) { e.target.classList.remove('open'); document.body.style.overflow=''; }
});

// ════════════════════════════════════════════════════════════
//  BOOT — ROOT CAUSE FIX UTAMA
// ════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  setRole('siswa');
  showAppLoading('Memeriksa sesi...');

  console.log('[Boot] App dimuat, menunggu auth state...');

  // ── DETEKSI KONEKSI — tampilkan banner offline/online ──
  function updateConnectionBanner(online) {
    let banner = document.getElementById('conn-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'conn-banner';
      banner.style.cssText = [
        'position:fixed;top:0;left:0;right:0;z-index:9999',
        'padding:8px 16px;font-size:13px;font-weight:600',
        'text-align:center;transition:transform .3s ease,opacity .3s ease',
        'transform:translateY(-100%);opacity:0'
      ].join(';');
      document.body.appendChild(banner);
    }
    if (online) {
      banner.textContent = '✅ Koneksi pulih — memuat ulang data...';
      banner.style.background = '#16a34a';
      banner.style.color = '#fff';
      banner.style.transform = 'translateY(0)';
      banner.style.opacity = '1';
      setTimeout(() => {
        banner.style.transform = 'translateY(-100%)';
        banner.style.opacity = '0';
      }, 3000);
    } else {
      banner.textContent = '📡 Tidak ada koneksi internet — mode offline';
      banner.style.background = '#dc2626';
      banner.style.color = '#fff';
      banner.style.transform = 'translateY(0)';
      banner.style.opacity = '1';
    }
  }

  // Daftarkan listener koneksi dari supabase.js
  onConnectionChange(function(online) {
    updateConnectionBanner(online);
    if (online && currentUser && !currentProfile) {
      // Reconnect: coba muat profil lagi
      console.log('[Net] Kembali online, mencoba muat ulang profil...');
      showAppLoading('Menghubungkan ke server...');
      sb.auth.getSession().then(function({ data: { session } }) {
        if (session) initApp(session);
        else { hideAppLoading(); showPage('page-login'); }
      });
    }
  });

  // Jika sudah offline saat load
  if (!isOnline()) updateConnectionBanner(false);

  // ── AUTO-LOGIN: cek session tersimpan langsung ──
  sb.auth.getSession().then(({ data: { session } }) => {
    if (session && !currentProfile && !isAuthBusy()) {
      console.log('[Boot] getSession() menemukan sesi aktif — inisialisasi langsung');
      clearTimeout(safetyTimer);
      initApp(session);
    }
  });

  // Safety timeout 10 detik — jika onAuthStateChange tidak pernah terpicu
  const safetyTimer = setTimeout(() => {
    console.warn('[Boot] Safety timeout 10 dtk — onAuthStateChange tidak terpicu');
    hideAppLoading();
    if (!currentUser) showPage('page-login');
  }, 10_000);

  sb.auth.onAuthStateChange(async (event, session) => {
    console.log('[Auth] onAuthStateChange:', event, '| session:', session ? 'ada' : 'null');

    if (isAuthBusy()) {
      console.log('[Auth] Busy (OTP verify) — skip onAuthStateChange');
      return;
    }

    clearTimeout(safetyTimer);

    if (event === 'SIGNED_OUT' || !session) {
      console.log('[Auth] SIGNED_OUT atau session null');
      currentUser = currentProfile = null;
      cacheClear();
      rtUnsubscribeAll();
      hideAppLoading();
      showPage('page-login');
      return;
    }

    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      if (event === 'TOKEN_REFRESHED' && currentProfile) {
        console.log('[Auth] TOKEN_REFRESHED — sudah login, skip init');
        return;
      }
      console.log('[Auth]', event, '— mulai initApp');
      await initApp(session);
    }
  });
});
