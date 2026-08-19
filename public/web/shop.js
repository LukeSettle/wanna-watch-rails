// Shop / WannaWatch+ + light ad slots. Loaded after api.js; used by app.js.

function isAdFree() {
  return !!(state.user?.ad_free || state.user?.entitlements?.ad_free || state.user?.supporter || isPlus());
}

function isPlus() {
  const status = state.user?.subscription_status;
  if (["active", "trialing", "past_due"].includes(status)) return true;
  return !!(state.user?.plus || state.user?.entitlements?.plus);
}

function hasEntitlement(key) {
  if (key === "ad_free") return isAdFree();
  if (key === "plus") return isPlus();
  const ents = state.user?.entitlements || {};
  return !!ents[key];
}

function openPlusShop() {
  state.view = "shop";
  lastRenderKey = null;
  render();
}

const LIBRARY_FREE_LIMIT = 10;

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

function swipeAdInterval() {
  const n = Number(window.WW_ADS?.swipeInterval);
  return Number.isFinite(n) && n > 0 ? n : 40;
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
    </div>`;
}

// ---------- swipe ad breaks ----------

function swipeAdCountKey() {
  return storageKey(`swipe_ad_count_${state.user?.id || state.deviceId || "guest"}`);
}

function nextSwipeAdCount() {
  const n = Number(loadJSON(swipeAdCountKey(), 0)) + 1;
  saveJSON(swipeAdCountKey(), n);
  return n;
}

function maybeShowSwipeAdBreak() {
  if (isAdFree()) return;
  if (document.getElementById("swipe-ad-break")) return;

  const interval = swipeAdInterval();
  const count = nextSwipeAdCount();
  if (count % interval !== 0) return;

  showSwipeAdBreak();
}

function showSwipeAdBreak() {
  const existing = document.getElementById("swipe-ad-break");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "swipe-ad-break";
  overlay.className = "modal-overlay swipe-ad-overlay";
  overlay.innerHTML = `
    <div class="modal-sheet swipe-ad-sheet" role="dialog" aria-labelledby="swipe-ad-title">
      <p class="swipe-ad-kicker">Quick break</p>
      <h2 id="swipe-ad-title">Sponsored pause</h2>
      <p class="muted">Ads keep WannaWatch free. WannaWatch+ removes them, unlocks Fine-tune, and keeps your full history.</p>
      <div class="swipe-ad-unit">
        ${adSlotHtml("swipe") || `
          <div class="swipe-ad-fallback">
            <p>Thanks for swiping — a short pause helps keep the lights on.</p>
          </div>`}
      </div>
      <div class="button-row swipe-ad-actions">
        <button type="button" class="btn btn-primary" id="swipe-ad-continue">Keep swiping</button>
        <button type="button" class="btn btn-secondary" id="swipe-ad-remove">Get WannaWatch+</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  bindAdSlots(overlay);

  const close = () => overlay.remove();
  document.getElementById("swipe-ad-continue").addEventListener("click", close);
  document.getElementById("swipe-ad-remove").addEventListener("click", () => {
    close();
    openPlusShop();
  });
}

async function handleShopReturn() {
  const params = new URLSearchParams(location.search);
  const shop = params.get("shop");
  if (!shop) return false;

  history.replaceState({}, "", "/");
  if (shop === "portal") {
    state.view = "shop";
    return true;
  }

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
      toast("WannaWatch+ is on — thank you!");
    } catch {
      toast("Payment received — refreshing…");
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
  if (isPlus()) return `<span class="owned-pill">Subscribed</span>`;
  const keys = product.entitlement_keys || [];
  if (keys.some((k) => hasEntitlement(k))) return `<span class="owned-pill">Owned</span>`;
  return "";
}

function renderShopScreen() {
  app.innerHTML = `
    ${topBarHtml(`<button class="link" id="shop-back">Back</button>`)}
    <div class="screen shop-screen">
      <div class="hero">
        <h1 class="headline-sm">WannaWatch+</h1>
        <p class="muted">$2.99/month. No ads, Fine-tune on custom games, and your full likes &amp; matches history while you're subscribed. Cancel anytime.</p>
      </div>
      <div id="shop-status" class="shop-status muted">Loading…</div>
      <div id="shop-products" class="shop-products"></div>
      <p class="muted shop-legal" id="shop-legal"></p>
    </div>`;

  bindBrandHome();
  document.getElementById("shop-back").addEventListener("click", () => {
    state.view = state.game ? "match" : "home";
    lastRenderKey = null;
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
    if (data.swipe_ad_interval) {
      window.WW_ADS = window.WW_ADS || {};
      window.WW_ADS.swipeInterval = data.swipe_ad_interval;
    }

    const stripeOk = data.stripe_configured;
    status.innerHTML = isPlus()
      ? "You're on WannaWatch+ — thank you for supporting the app."
      : stripeOk
        ? "Secure checkout via Stripe. $2.99/month, cancel anytime."
        : "Payments aren't live on this server yet.";

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
        <ul class="shop-perks">
          <li>No ad breaks or banners</li>
          <li>Fine-tune custom games (genres, eras, runtime, language)</li>
          <li>Full likes &amp; matches history — not just the last ${LIBRARY_FREE_LIMIT}</li>
        </ul>
        <div class="shop-actions">
          ${checkoutButtonHtml(product, stripeOk)}
        </div>
      </article>`).join("");

    list.querySelectorAll("[data-buy]").forEach((btn) => {
      btn.addEventListener("click", () => startCheckout(btn.dataset.buy, btn));
    });
    list.querySelectorAll("[data-portal]").forEach((btn) => {
      btn.addEventListener("click", () => startPortal(btn));
    });
  } catch {
    status.textContent = "Couldn't load the shop. Try again in a moment.";
  }
}

function checkoutButtonHtml(product, stripeOk) {
  if (isPlus()) {
    if (state.user?.can_manage_subscription && stripeOk) {
      return `<button type="button" class="btn btn-secondary" data-portal>Manage subscription</button>`;
    }
    return `<button type="button" class="btn btn-ghost" disabled>Subscribed</button>`;
  }
  if (stripeOk) {
    return `<button type="button" class="btn btn-primary" data-buy="${esc(product.id)}">Subscribe — ${esc(product.price_label)}</button>`;
  }
  return `<button type="button" class="btn btn-ghost" disabled>Coming soon</button>`;
}

async function startCheckout(productId, button) {
  if (!state.user) {
    toast("Pick a name first, then come back for WannaWatch+.");
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
    if (result.checkout_url || result.portal_url) {
      location.href = result.checkout_url || result.portal_url;
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

async function startPortal(button) {
  if (!state.user) return;
  button.disabled = true;
  try {
    const result = await backend.createShopPortal(state.user.id);
    if (result.portal_url) {
      location.href = result.portal_url;
      return;
    }
    toast(result.error || "Couldn't open subscription settings.");
  } catch (error) {
    toast(error.serverMessage || "Couldn't open subscription settings.");
  } finally {
    button.disabled = false;
  }
}
