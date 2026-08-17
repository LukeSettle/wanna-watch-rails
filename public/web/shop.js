// Shop / Extras + light ad slots. Loaded after api.js; used by app.js.

function isAdFree() {
  return !!(state.user?.ad_free || state.user?.entitlements?.ad_free || state.user?.supporter);
}

function hasEntitlement(key) {
  if (key === "ad_free") return isAdFree();
  const ents = state.user?.entitlements || {};
  return !!ents[key];
}

function flairBadgeHtml(user = state.user) {
  if (!user?.entitlements?.lobby_flair && !user?.entitlements?.supporter) return "";
  const style = user.entitlements?.flair_style || (user.entitlements?.supporter ? "star" : "popcorn");
  const labels = { popcorn: "🍿", film: "🎬", star: "⭐" };
  const title = user.entitlements?.supporter ? "Supporter" : "Flair";
  return `<span class="flair-badge" title="${esc(title)}" data-style="${esc(style)}">${labels[style] || "✨"}</span>`;
}

function usernameWithFlair(user = state.user) {
  if (!user) return "";
  return `${esc(user.username || "Player")}${flairBadgeHtml(user)}`;
}

function adsenseClient() {
  return window.WW_ADS?.client || "";
}

function adsenseSlot(placement) {
  const slots = window.WW_ADS?.slots || {};
  return slots[placement] || "";
}

function adSlotHtml(placement = "home") {
  if (isAdFree()) return "";

  const client = adsenseClient();
  const slot = adsenseSlot(placement);
  if (!client || !slot) return "";

  return `
    <aside class="ad-slot" data-placement="${esc(placement)}">
      <ins class="adsbygoogle"
           style="display:block"
           data-ad-client="${esc(client)}"
           data-ad-slot="${esc(slot)}"
           data-ad-format="auto"
           data-full-width-responsive="true"></ins>
    </aside>`;
}

function bindAdSlots(root = document) {
  root.querySelectorAll("ins.adsbygoogle:not([data-adsbygoogle-status])").forEach(() => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      /* AdSense may throw if the script is blocked */
    }
  });
}

function vaultKey() {
  return storageKey(`vault_${state.user?.id || "guest"}`);
}

function loadVault() {
  return loadJSON(vaultKey(), []);
}

function saveVault(items) {
  saveJSON(vaultKey(), items);
}

function mergeIntoVault(movies) {
  if (!hasEntitlement("match_vault") || !movies?.length) return 0;
  const existing = loadVault();
  const byKey = new Map(existing.map((m) => [`${m.media_type || "movie"}:${m.id}`, m]));
  let added = 0;
  movies.forEach((movie) => {
    if (!movie?.id) return;
    const key = `${movie.media_type || "movie"}:${movie.id}`;
    if (byKey.has(key)) return;
    byKey.set(key, {
      id: movie.id,
      title: movie.title,
      poster_path: movie.poster_path,
      release_date: movie.release_date,
      media_type: movie.media_type || "movie",
      saved_at: new Date().toISOString(),
    });
    added += 1;
  });
  saveVault([...byKey.values()]);
  return added;
}

function exportVault() {
  const blob = new Blob([JSON.stringify(loadVault(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "wannawatch-match-vault.json";
  a.click();
  URL.revokeObjectURL(url);
}

function deepDiveExtrasHtml(movie) {
  if (!hasEntitlement("deep_dive") || !movie) return "";

  const tagline = movie.tagline ? `<p class="deep-tagline">“${esc(movie.tagline)}”</p>` : "";
  const budget = movie.budget > 0 ? `Budget ~$${(movie.budget / 1_000_000).toFixed(0)}M` : "";
  const revenue = movie.revenue > 0 ? `Gross ~$${(movie.revenue / 1_000_000).toFixed(0)}M` : "";
  const money = [budget, revenue].filter(Boolean).join(" · ");
  const crew = (movie.credits?.crew || [])
    .filter((c) => ["Director", "Writer", "Screenplay", "Creator"].includes(c.job))
    .slice(0, 4);
  const extraCast = (movie.credits?.cast || []).slice(6, 12);

  return `
    <div class="details-block deep-dive-block">
      <h4>Deep dive <span class="owned-pill">unlocked</span></h4>
      ${tagline}
      ${money ? `<p class="meta-line">${esc(money)}</p>` : ""}
      ${crew.length ? `<p class="meta-line">${crew.map((c) => `${esc(c.job)}: ${esc(c.name)}`).join(" · ")}</p>` : ""}
      ${extraCast.length ? `
        <div class="cast-row">
          ${extraCast.map((person) => `
            <div class="cast-card">
              ${profileUrl(person.profile_path)
                ? `<img src="${profileUrl(person.profile_path)}" alt="${esc(person.name)}">`
                : `<div class="cast-placeholder">${esc((person.name || "?").slice(0, 1))}</div>`}
              <strong>${esc(person.name)}</strong>
              <span class="muted">${esc(person.character || "")}</span>
            </div>`).join("")}
        </div>` : ""}
      <p class="hint">Movie-lover extras from TMDB — part of Deep Dive Cards.</p>
    </div>`;
}

async function handleShopReturn() {
  const params = new URLSearchParams(location.search);
  const shop = params.get("shop");
  if (!shop) return false;

  history.replaceState({}, "", "/");
  if (shop === "cancel") {
    toast("Checkout canceled — no charge.");
    state.view = "shop";
    return true;
  }

  if (shop === "success") {
    const sessionId = params.get("session_id");
    try {
      if (sessionId && state.user) {
        adoptUser(await backend.confirmShopPurchase(sessionId, state.user.id));
      }
      toast("You're the best — thank you! Extras unlocked.");
    } catch {
      toast("Payment received — refreshing your extras…");
      try {
        if (state.user?.email) adoptUser(await backend.me());
        else if (state.user) adoptUser(await backend.shopEntitlements(state.user.id));
      } catch { /* ignore */ }
    }
    state.view = "shop";
    return true;
  }
  return false;
}

function ownedLabel(product) {
  const keys = product.entitlement_keys || [];
  if (product.kind === "tip") return "";
  if (keys.some((k) => hasEntitlement(k))) return `<span class="owned-pill">Owned</span>`;
  return "";
}

function renderShopScreen() {
  app.innerHTML = `
    ${topBarHtml(`<button class="link" id="shop-back">Back</button>`)}
    <div class="screen shop-screen">
      <div class="hero">
        <h1 class="headline-sm">Extras</h1>
        <p class="muted">You're supporting indie movie night software. Core play with friends stays free forever — these are feel-good add-ons.</p>
      </div>
      <div id="shop-status" class="shop-status muted">Loading catalog…</div>
      <div id="shop-products" class="shop-products"></div>
      <section class="card shop-vault-card" id="shop-vault" hidden></section>
      <p class="muted shop-legal" id="shop-legal"></p>
    </div>`;

  bindBrandHome();
  document.getElementById("shop-back").addEventListener("click", () => {
    state.view = "home";
    render();
  });

  loadShopCatalog();
}

async function loadShopCatalog() {
  const status = document.getElementById("shop-status");
  const list = document.getElementById("shop-products");
  const legal = document.getElementById("shop-legal");
  if (!list) return;

  try {
    const data = await backend.shopCatalog(state.user?.id);
    if (data.entitlements && state.user) {
      state.user = { ...state.user, ...data.entitlements };
    }

    const stripeOk = data.stripe_configured;
    const demoOk = data.demo_unlock_allowed;
    status.innerHTML = stripeOk
      ? `Secure checkout via Stripe. ${isAdFree() ? "You're ad-free — thank you!" : "Small banners help keep the free tier going."}`
      : `Payments aren't live on this server yet.${demoOk ? " Dev demo unlock is available below." : " Browse the catalog — coming soon."}`;

    if (legal) legal.textContent = data.copy?.legal || "";

    list.innerHTML = (data.products || []).map((product) => `
      <article class="card shop-product" data-id="${esc(product.id)}">
        <div class="shop-product-top">
          <div>
            <h2>${esc(product.name)} ${ownedLabel(product)}</h2>
            <p class="shop-tagline">${esc(product.tagline)}</p>
          </div>
          <div class="shop-price">${esc(product.price_label)}</div>
        </div>
        <p class="muted">${esc(product.description)}</p>
        <div class="shop-actions">
          ${checkoutButtonHtml(product, stripeOk, demoOk)}
        </div>
      </article>`).join("");

    list.querySelectorAll("[data-buy]").forEach((btn) => {
      btn.addEventListener("click", () => startCheckout(btn.dataset.buy, btn));
    });
    list.querySelectorAll("[data-demo]").forEach((btn) => {
      btn.addEventListener("click", () => demoUnlock(btn.dataset.demo, btn));
    });

    renderShopVault();
  } catch {
    status.textContent = "Couldn't load the shop. Try again in a moment.";
  }
}

function checkoutButtonHtml(product, stripeOk, demoOk) {
  const owned = (product.entitlement_keys || []).some((k) => hasEntitlement(k));
  if (owned && product.kind !== "tip") {
    return `<button type="button" class="btn btn-ghost" disabled>Already yours</button>`;
  }
  if (stripeOk) {
    return `<button type="button" class="btn btn-primary" data-buy="${esc(product.id)}">Get it</button>`;
  }
  if (demoOk) {
    return `<button type="button" class="btn btn-secondary" data-demo="${esc(product.id)}">Demo unlock</button>`;
  }
  return `<button type="button" class="btn btn-ghost" disabled>Coming soon</button>`;
}

async function startCheckout(productId, button) {
  if (!state.user) {
    toast("Pick a name first, then come back to Extras.");
    return;
  }
  if (!state.user.email) {
    toast("Create a free login to buy & restore purchases.");
    state.view = "register";
    lastRenderKey = null;
    render();
    return;
  }

  button.disabled = true;
  try {
    const result = await backend.createShopCheckout(productId, state.user.id);
    if (result.checkout_url) {
      location.href = result.checkout_url;
      return;
    }
    toast(result.error || "Could not start checkout.");
  } catch (error) {
    if (error.serverMessage && /login/i.test(error.serverMessage)) {
      toast(error.serverMessage);
      state.view = "register";
      lastRenderKey = null;
      render();
      return;
    }
    toast(error.serverMessage || "Checkout failed.");
  } finally {
    button.disabled = false;
  }
}

async function demoUnlock(productId, button) {
  if (!state.user) return;
  button.disabled = true;
  try {
    adoptUser(await backend.demoShopUnlock(productId, state.user.id));
    toast("Demo unlock applied — enjoy!");
    lastRenderKey = null;
    render();
  } catch (error) {
    toast(error.serverMessage || "Demo unlock failed.");
    button.disabled = false;
  }
}

function renderShopVault() {
  const el = document.getElementById("shop-vault");
  if (!el) return;
  if (!hasEntitlement("match_vault")) {
    el.hidden = true;
    return;
  }

  const items = loadVault();
  el.hidden = false;
  el.innerHTML = `
    <h2>Match Vault</h2>
    <p class="muted">${items.length ? `${items.length} saved match${items.length === 1 ? "" : "es"}.` : "Matches you save from results will land here."}</p>
    <div class="vault-list">
      ${items.slice(0, 12).map((m) => `
        <div class="vault-row">
          <strong>${esc(m.title || "Untitled")}</strong>
          <span class="muted">${m.release_date ? esc(String(m.release_date).slice(0, 4)) : ""}</span>
        </div>`).join("") || ""}
    </div>
    <div class="button-row">
      <button type="button" class="btn btn-secondary" id="export-vault" ${items.length ? "" : "disabled"}>Export JSON</button>
    </div>`;

  document.getElementById("export-vault")?.addEventListener("click", () => {
    exportVault();
    toast("Vault exported.");
  });
}
