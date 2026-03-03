import { CLIENT_ID } from "./config.js";

const SCOPES = [
  "user-read-private",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
].join(" ");

const logEl = document.getElementById("log");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const appEl = document.getElementById("app");
const playlistSelect = document.getElementById("playlistSelect");
const generateBtn = document.getElementById("generateBtn");

function log(msg) {
  logEl.textContent += `${msg}\n`;
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(str) {
  const enc = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return new Uint8Array(digest);
}

function randomString(len = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return [...arr].map(x => chars[x % chars.length]).join("");
}

function redirectUri() {
  // index.html から callback.html を指す
  return new URL("callback.html", window.location.href).toString();
}

function tokenStore() {
  return {
    get() {
      const raw = localStorage.getItem("sp_token");
      return raw ? JSON.parse(raw) : null;
    },
    set(v) { localStorage.setItem("sp_token", JSON.stringify(v)); },
    clear() { localStorage.removeItem("sp_token"); }
  };
}

async function refreshIfNeeded(tok) {
  const now = Math.floor(Date.now() / 1000);
  if (!tok) return null;
  if (tok.expires_at && tok.expires_at - now > 30) return tok;

  log("アクセストークン更新中…");
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: tok.refresh_token
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
  const j = await res.json();

  const next = {
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? tok.refresh_token,
    expires_at: Math.floor(Date.now()/1000) + (j.expires_in ?? 3600),
    scope: j.scope ?? tok.scope
  };
  tokenStore().set(next);
  return next;
}

async function api(path, tok, opts = {}) {
  const t = await refreshIfNeeded(tok);
  const res = await fetch(`https://api.spotify.com/v1/${path}`, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      "Authorization": `Bearer ${t.access_token}`,
      "Content-Type": "application/json"
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${opts.method || "GET"} ${path} -> ${res.status} ${txt}`);
  }
  return res.json();
}

async function login() {
  const verifier = randomString(64);
  const challenge = base64url(await sha256(verifier));
  const state = randomString(24);

  sessionStorage.setItem("pkce_verifier", verifier);
  sessionStorage.setItem("oauth_state", state);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri(),
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: SCOPES,
    state
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

function logout() {
  tokenStore().clear();
  logEl.textContent = "";
  log("ログアウトしました。");
  appEl.style.display = "none";
  loginBtn.style.display = "";
  logoutBtn.style.display = "none";
}

async function loadPlaylists(tok) {
  log("プレイリスト一覧取得中…");
  playlistSelect.innerHTML = "";

  // 自分のプロフィール（owner filter用）
  const me = await api("me", tok);
  const myId = me.id;

  let url = "me/playlists?limit=50&offset=0";
  const all = [];

  while (true) {
    const j = await api(url, tok);
    for (const p of j.items || []) {
      // items endpointは owner/collab じゃないと403になり得るので、まずは自分のもの/協働を優先表示
      const ownerId = p.owner?.id;
      const isCandidate = (ownerId === myId) || (p.collaborative === true);
      all.push({ ...p, __candidate: isCandidate });
    }
    if (!j.next) break;
    const next = new URL(j.next);
    url = `me/playlists?${next.searchParams.toString()}`;
  }

  // candidateを上に
  all.sort((a,b) => (b.__candidate - a.__candidate) || a.name.localeCompare(b.name));

  for (const p of all) {
    const opt = document.createElement("option");
    opt.value = p.id;
    const total = p.items?.total ?? p.tracks?.total ?? "?"; // tracksはdeprecated
    opt.textContent = `${p.__candidate ? "★ " : ""}${p.name} (${total})`;
    playlistSelect.appendChild(opt);
  }

  log(`プレイリスト ${all.length} 件`);
}

async function fetchPlaylistTracks(tok, playlistId) {
  log("母集団プレイリストの曲を取得中…");
  const tracks = [];
  let offset = 0;

  while (true) {
    const j = await api(`playlists/${playlistId}/items?limit=50&offset=${offset}&additional_types=track&market=from_token`, tok);
    for (const it of j.items || []) {
      const t = it.item; // 2026以降 item
      if (!t || t.type !== "track" || !t.id || !t.duration_ms) continue;
      if (it.is_local) continue;
      tracks.push({ id: t.id, dur: t.duration_ms, name: t.name });
    }
    offset += 50;
    if (offset >= (j.total ?? 0)) break;
  }

  // dedup
  const map = new Map();
  for (const t of tracks) map.set(t.id, t);
  const uniq = [...map.values()];
  log(`取得完了: ${uniq.length} 曲`);
  return uniq;
}

function pickSubset(tracks, targetMinutes, toleranceSec, tries) {
  const target = targetMinutes * 60 * 1000;
  const tol = toleranceSec * 1000;

  const ids = tracks.map(t => t.id);
  const dur = new Map(tracks.map(t => [t.id, t.dur]));

  let best = [];
  let bestSum = 0;
  let bestDiff = Infinity;

  for (let k = 0; k < tries; k++) {
    // Fisher–Yates shuffle
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    let sum = 0;
    const chosen = [];
    for (const id of ids) {
      const d = dur.get(id);
      if (sum + d <= target + tol) {
        chosen.push(id);
        sum += d;
        if (Math.abs(sum - target) <= tol) break;
      }
    }
    const diff = Math.abs(sum - target);
    if (diff < bestDiff) {
      best = chosen;
      bestSum = sum;
      bestDiff = diff;
    }
  }
  return { ids: best, sumMs: bestSum, diffMs: bestDiff, targetMs: target };
}

async function createPlaylist(tok, name, description) {
  // 2026以降は /me/playlists を使う
  return api("me/playlists", tok, {
    method: "POST",
    body: JSON.stringify({ name, public: false, description })
  });
}

async function addItems(tok, playlistId, trackIds) {
  const uris = trackIds.map(id => `spotify:track:${id}`);
  for (let i = 0; i < uris.length; i += 100) {
    const batch = uris.slice(i, i + 100);
    await api(`playlists/${playlistId}/items`, tok, {
      method: "POST",
      body: JSON.stringify({ uris: batch })
    });
  }
}

async function main() {
  const store = tokenStore();
  let tok = store.get();

  loginBtn.onclick = () => login();
  logoutBtn.onclick = () => logout();

  if (tok) {
    loginBtn.style.display = "none";
    logoutBtn.style.display = "";
    appEl.style.display = "";
    try {
      await loadPlaylists(tok);
    } catch (e) {
      log(`エラー: ${e.message}`);
    }
  } else {
    log("ログインしてください。");
  }

  generateBtn.onclick = async () => {
    try {
      tok = store.get();
      if (!tok) throw new Error("not logged in");

      const playlistId = playlistSelect.value;
      const minutes = parseInt(document.getElementById("minutes").value, 10);
      const tol = parseInt(document.getElementById("tolerance").value, 10);
      const tries = parseInt(document.getElementById("tries").value, 10);

      const tracks = await fetchPlaylistTracks(tok, playlistId);
      if (tracks.length === 0) throw new Error("母集団が空です");

      const picked = pickSubset(tracks, minutes, tol, tries);
      log(`選曲: ${picked.ids.length}曲 / 合計 ${(picked.sumMs/60000).toFixed(2)}分 / 差 ${(picked.diffMs/1000).toFixed(1)}秒`);

      const now = new Date().toISOString().slice(0,10);
      const name = `Focus ${minutes}min ${now}`;
      const created = await createPlaylist(tok, name, "Pool-only time cut");
      await addItems(tok, created.id, picked.ids);

      log(`完了: ${created.external_urls.spotify}`);
      window.open(created.external_urls.spotify, "_blank");
    } catch (e) {
      log(`失敗: ${e.message}`);
      log("※ 403の場合：その母集団プレイリストは owner/collaborator でない可能性があります。");
    }
  };
}

main();