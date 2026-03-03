import { CLIENT_ID } from "./config.js";

function redirectUri() {
  // callback.html 自身
  return window.location.href.split("?")[0];
}

function tokenStore() {
  return {
    get() {
      const raw = localStorage.getItem("sp_token");
      return raw ? JSON.parse(raw) : null;
    },
    set(v) { localStorage.setItem("sp_token", JSON.stringify(v)); },
  };
}

(async () => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const savedState = sessionStorage.getItem("oauth_state");
  const verifier = sessionStorage.getItem("pkce_verifier");

  if (!code || !verifier || !state || state !== savedState) {
    document.body.textContent = "認証に失敗しました（code/state/verifier不足）";
    return;
  }

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    document.body.textContent = `token交換失敗: ${res.status} ${t}`;
    return;
  }

  const j = await res.json();
  const tok = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Math.floor(Date.now()/1000) + (j.expires_in ?? 3600),
    scope: j.scope
  };
  tokenStore().set(tok);

  // indexへ戻す
  const back = new URL("index.html", window.location.href);
  window.location.replace(back.toString());
})();