// webkit/index.tsx
//
// Runs INSIDE Steam's store pages (store.steampowered.com). On a game page it
// injects an "Unlock via ONE GAMERS" button next to the Community Hub button —
// but only when (a) this machine is activated (SUINABE.dat present) and (b) the
// AppID is in the api/onennabe catalog. Clicking it records the unlock.
//
// Backend RPCs (from backend/rpc_functions.lua) are reached via the `backend`
// bridge and return JSON strings.

declare const backend: any;

const BTN_ID = 'onegamers-unlock-btn';

function getAppId(): string | null {
	const m = location.href.match(/\/app\/(\d+)/);
	return m ? m[1] : null;
}

const STEAM64_BASE = 76561197960265728;

// Store pages expose the signed-in SteamID in several places depending on the
// page. Try them all, and fall back to converting a 32-bit AccountID → 64. This
// is a fallback only — the backend prefers the SteamID stored in SUINABE.dat.
function getSteamId64(): string {
	const w = window as any;
	const asId = (v: any): string => {
		const s = String(v || '').replace(/\D/g, '');
		if (!s) return '';
		if (s.length >= 17) return s;                      // already a SteamID64
		const n = Number(s);
		if (n > 0 && n < 4294967296) return String(STEAM64_BASE + n); // AccountID → 64
		return '';
	};
	try {
		let id = asId(w.g_steamID); if (id) return id;
		id = asId(w.g_rgProfileData && w.g_rgProfileData.steamid); if (id) return id;
		id = asId(w.g_AccountID); if (id) return id;
	} catch { /* keep trying */ }
	try {
		const a = document.querySelector<HTMLAnchorElement>('a[href*="steamcommunity.com/profiles/"]');
		const m = a && a.href.match(/\/profiles\/(\d{17})/);
		if (m) return m[1];
	} catch { /* keep trying */ }
	try {
		const el = document.querySelector<HTMLElement>('[data-miniprofile]');
		const id = el && asId(el.getAttribute('data-miniprofile'));
		if (id) return id;
	} catch { /* give up */ }
	return '';
}

async function callBackend(fn: string, ...args: any[]): Promise<any> {
	try {
		if (typeof backend === 'undefined' || typeof backend[fn] !== 'function') return null;
		const raw = await backend[fn](...args);
		return typeof raw === 'string' ? JSON.parse(raw) : raw;
	} catch (e) {
		console.error('[ONE GAMERS] backend.' + fn + ' failed', e);
		return null;
	}
}

// Inject the shared ONE GAMERS popup styles once.
function injectOGStyles() {
	if (document.getElementById('og-style')) return;
	const s = document.createElement('style');
	s.id = 'og-style';
	s.textContent = `
@keyframes og-fade { from { opacity:0 } to { opacity:1 } }
@keyframes og-pop { 0% { opacity:0; transform:translateY(12px) scale(.96) } 100% { opacity:1; transform:none } }
@keyframes og-check { 0% { stroke-dashoffset:48 } 100% { stroke-dashoffset:0 } }
@keyframes og-glow { 0%,100% { box-shadow:0 0 0 0 rgba(89,209,133,.35) } 50% { box-shadow:0 0 0 8px rgba(89,209,133,0) } }
@keyframes og-slidein { from { opacity:0; transform:translateX(20px) } to { opacity:1; transform:none } }
.og-overlay { position:fixed;inset:0;z-index:2147483647;background:rgba(6,12,20,.72);
  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;
  animation:og-fade .18s ease;font-family:"Motiva Sans",Arial,sans-serif }
.og-card { width:440px;max-width:92vw;position:relative;overflow:hidden;border-radius:16px;
  background:linear-gradient(160deg,#1a2b40 0%,#16212e 60%,#111823 100%);
  border:1px solid rgba(102,192,244,.18);box-shadow:0 30px 80px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.05);
  color:#e9f1f8;animation:og-pop .28s cubic-bezier(.2,.9,.3,1.2) }
.og-topbar { height:4px;background:linear-gradient(90deg,#1a9fff,#66c0f4,#59d185) }
.og-body { padding:28px 26px 24px }
.og-close { position:absolute;top:14px;right:16px;cursor:pointer;font-size:20px;line-height:1;
  width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:8px;color:#8aa3ba;transition:.15s }
.og-close:hover { background:rgba(255,255,255,.08);color:#fff }
.og-success-wrap { display:flex;flex-direction:column;align-items:center;text-align:center }
.og-tick { width:78px;height:78px;border-radius:50%;background:rgba(89,209,133,.12);
  display:flex;align-items:center;justify-content:center;margin-bottom:18px;animation:og-glow 1.8s ease-in-out infinite }
.og-tick svg { width:42px;height:42px }
.og-tick path { stroke:#59d185;stroke-width:5;fill:none;stroke-linecap:round;stroke-linejoin:round;
  stroke-dasharray:48;stroke-dashoffset:48;animation:og-check .5s .12s ease forwards }
.og-brand-mini { font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#66c0f4;font-weight:700;margin-bottom:8px;opacity:.9 }
.og-success-title { font-size:22px;font-weight:800;color:#fff;margin-bottom:8px }
.og-success-sub { font-size:13px;color:#9db4c8;line-height:1.55;margin-bottom:22px;max-width:330px }
.og-actions { display:flex;gap:10px;width:100%;justify-content:center }
.og-btn { padding:12px 20px;border-radius:10px;border:none;cursor:pointer;font-size:14px;font-weight:700;
  font-family:inherit;transition:.15s;display:inline-flex;align-items:center;justify-content:center;gap:8px }
.og-btn-ghost { background:rgba(255,255,255,.06);color:#c3d4e2 }
.og-btn-ghost:hover { background:rgba(255,255,255,.12) }
.og-btn-lib { background:linear-gradient(135deg,#1a9fff,#0a6bd8);color:#fff;box-shadow:0 6px 18px rgba(26,159,255,.4) }
.og-btn-lib:hover { filter:brightness(1.08);transform:translateY(-1px) }
.og-errtoast { position:fixed;bottom:74px;right:20px;z-index:2147483647;background:linear-gradient(160deg,#2a1a1f,#1b2838);
  color:#ff8a8a;border:1px solid rgba(255,107,107,.4);border-radius:10px;padding:12px 16px;
  font-family:"Motiva Sans",Arial,sans-serif;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.5);
  animation:og-slidein .25s ease;max-width:320px }
`;
	(document.head || document.body).appendChild(s);
}

// Small toast — used for error feedback only. Success gets the full modal.
function toast(msg: string, good = true) {
	injectOGStyles();
	const t = document.createElement('div');
	t.textContent = msg;
	if (good) {
		t.style.cssText =
			'position:fixed;bottom:74px;right:20px;z-index:2147483647;background:linear-gradient(160deg,#16302a,#1b2838);' +
			'color:#66c0f4;border:1px solid rgba(102,192,244,.4);border-radius:10px;padding:12px 16px;' +
			'font-family:"Motiva Sans",Arial,sans-serif;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.5);';
	} else {
		t.className = 'og-errtoast';
	}
	document.body.appendChild(t);
	setTimeout(() => t.remove(), 4000);
}

// Navigate the Steam client to the Library view. Store pages intercept steam://
// links, so a hidden anchor click is the reliable way to switch views.
function goToLibrary() {
	try {
		const a = document.createElement('a');
		a.href = 'steam://open/games';
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		setTimeout(() => { try { a.remove(); } catch {} }, 300);
	} catch {
		try { location.href = 'steam://open/games'; } catch {}
	}
}

// Beautiful success modal shown after a game is unlocked, with a shortcut to the
// Steam Library.
function showUnlockSuccess(appName?: string) {
	injectOGStyles();
	const old = document.getElementById('og-unlock-modal');
	if (old) old.remove();

	const overlay = document.createElement('div');
	overlay.id = 'og-unlock-modal';
	overlay.className = 'og-overlay';

	const card = document.createElement('div');
	card.className = 'og-card';
	card.innerHTML =
		'<div class="og-topbar"></div><div class="og-body">' +
		'<div class="og-close" id="ogu-close">&times;</div>' +
		'<div class="og-success-wrap">' +
		'<div class="og-tick"><svg viewBox="0 0 52 52"><path d="M14 27 l8 8 l16 -18"/></svg></div>' +
		'<div class="og-brand-mini">ONE GAMERS</div>' +
		'<div class="og-success-title">Game Unlocked</div>' +
		'<div class="og-success-sub">' +
		(appName ? ('<b style="color:#fff">' + appName + '</b> has been added to your account. ') : 'This game has been added to your account. ') +
		'It will appear in your library in a moment — you may need to restart Steam.</div>' +
		'<div class="og-actions">' +
		'<button id="ogu-close2" class="og-btn og-btn-ghost">Close</button>' +
		'<button id="ogu-lib" class="og-btn og-btn-lib">' +
		'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>' +
		'Go to Library</button>' +
		'</div></div></div>';

	overlay.appendChild(card);
	document.body.appendChild(overlay);

	const close = () => overlay.remove();
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
	document.getElementById('ogu-close')?.addEventListener('click', close);
	document.getElementById('ogu-close2')?.addEventListener('click', close);
	document.getElementById('ogu-lib')?.addEventListener('click', () => { goToLibrary(); close(); });
}

// Best-effort: the game's title from the store page (for the success message).
function getAppName(): string {
	const el = document.querySelector('.apphub_AppName, #appHubAppName, .page_title_area .apphub_AppName');
	return (el && (el.textContent || '').trim()) || '';
}

function makeButton(appid: string): HTMLElement {
	const btn = document.createElement('a');
	btn.id = BTN_ID;
	(btn as any).dataset.appid = appid;
	btn.className = 'btnv6_blue_hoverfade btn_medium'; // match Steam's store button styling
	btn.style.cssText = 'margin-left:8px;vertical-align:top;cursor:pointer;';
	btn.innerHTML = '<span>Unlock via ONE GAMERS</span>';

	btn.addEventListener('click', async (e) => {
		e.preventDefault();
		const span = btn.querySelector('span')!;
		const prev = span.textContent;
		span.textContent = 'Unlocking…';
		btn.style.pointerEvents = 'none';
		// Pass the page's SteamID as a fallback; the backend prefers the one
		// stored in SUINABE.dat and only uses this if the marker lacks it.
		const r = await callBackend('unlock_su', appid, getSteamId64());
		if (r && r.ok) {
			span.textContent = 'Unlocked ✓';
			showUnlockSuccess(getAppName());
		} else {
			toast((r && r.message) || 'Unlock failed.', false);
			span.textContent = prev || 'Unlock via ONE GAMERS';
			btn.style.pointerEvents = '';
		}
	});
	return btn;
}

// Find the Community Hub button/link on the store app page.
function findCommunityHub(): HTMLElement | null {
	// It links to the game's community hub.
	const byHref = document.querySelector<HTMLElement>('a[href*="steamcommunity.com/app/"]');
	if (byHref) return byHref;
	// Fallback: match by text.
	const links = document.querySelectorAll<HTMLElement>('a, .btnv6_blue_hoverfade');
	for (const el of Array.from(links)) {
		if ((el.textContent || '').trim().toLowerCase().includes('community hub')) return el;
	}
	return null;
}

function placeButton(btn: HTMLElement) {
	const hub = findCommunityHub();
	if (hub && hub.parentElement) {
		hub.parentElement.insertBefore(btn, hub.nextSibling);
	} else {
		// Fallback so the button is never lost if the hub button isn't found.
		btn.style.cssText += ';position:fixed;bottom:20px;right:20px;z-index:2147483647;';
		document.body.appendChild(btn);
	}
}

let evaluating = false;
async function ensureButton() {
	const appid = getAppId();
	const existing = document.getElementById(BTN_ID);

	if (!appid) { if (existing) existing.remove(); return; }
	if (existing) { if ((existing as any).dataset.appid === appid) return; existing.remove(); }
	if (evaluating) return;
	evaluating = true;
	try {
		// Gate 1: activated?
		const st = await callBackend('su_status');
		if (!st || !st.activated) return;

		// Gate 2: is this AppID in the onennabe catalog?
		const on = await callBackend('is_onennabe', appid);
		if (!on || !on.ok) return;

		if (getAppId() !== appid || document.getElementById(BTN_ID)) return;
		placeButton(makeButton(appid));
	} finally {
		evaluating = false;
	}
}

function start() {
	// Prove the webkit script is running at all (shows on ANY store page).
	try {
		ensureButton();
		try {
			const obs = new MutationObserver(() => ensureButton());
			obs.observe(document.body, { childList: true, subtree: true });
		} catch {
			setInterval(ensureButton, 1500);
		}
		let last = location.href;
		setInterval(() => { if (location.href !== last) { last = location.href; ensureButton(); } }, 1000);
	} catch {
		/* ignore */
	}
}

// Announce load immediately; retry until <body> exists.
(function boot() {
	if (document && document.body) { start(); return; }
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		setTimeout(boot, 200);
	}
})();
