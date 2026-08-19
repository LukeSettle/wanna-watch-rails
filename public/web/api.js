// Backend + TMDB clients. Payload shapes mirror the React Native app
// (app/data/backend_client.js and app/data/movie_api.js in the WannaWatch repo)
// so web and mobile players are fully compatible in the same game.

const TMDB_API_KEY = "fd1efe23da588e99056fdb264ca89bbd";

// Stale IDs users may still have saved (rent/buy or retired catalog entries).
const PROVIDER_ID_ALIASES = {
  "2": "350", // Apple TV Store → Apple TV (subscription)
  "531": "2303", // retired Paramount Plus → Paramount Plus Premium
};

// Preferred chip order. Names/logos come from TMDB at runtime.
const FEATURED_PROVIDER_IDS = ["8", "1899", "15", "337", "386", "9", "2303", "350"];

const PROVIDERS_FALLBACK = [
  { title: "Netflix", code: "8" },
  { title: "Max", code: "1899" },
  { title: "Hulu", code: "15" },
  { title: "Disney Plus", code: "337" },
  { title: "Peacock Premium", code: "386" },
  { title: "Amazon Prime Video", code: "9" },
  { title: "Paramount Plus Premium", code: "2303" },
  { title: "Apple TV", code: "350" },
];

function normalizeProviderIds(ids) {
  return [...new Set((ids || []).map(String).map((id) => PROVIDER_ID_ALIASES[id] || id))];
}

async function backendRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const error = new Error(data?.error || `Request failed: ${method} ${path} (${response.status})`);
    error.status = response.status;
    error.serverMessage = data?.error;
    throw error;
  }
  return response.json();
}

const backend = {
  me() {
    return backendRequest("/auth/me");
  },
  register(params) {
    return backendRequest("/auth/register", { method: "POST", body: params });
  },
  login(email, password) {
    return backendRequest("/auth/login", { method: "POST", body: { email, password } });
  },
  logout() {
    return backendRequest("/auth/logout", { method: "POST" });
  },
  forgotPassword(email) {
    return backendRequest("/auth/forgot", { method: "POST", body: { email } });
  },
  resetPassword(token, password) {
    return backendRequest("/auth/reset", { method: "POST", body: { token, password } });
  },
  updateAccount(params) {
    return backendRequest("/auth/update", { method: "POST", body: params });
  },
  upsertUser(user) {
    return backendRequest("/users/upsert", { method: "POST", body: user });
  },
  findUserByDeviceId(deviceId) {
    return backendRequest(`/users/find_by_device_id?device_id=${encodeURIComponent(deviceId)}`);
  },
  gamesIndex(userId) {
    return backendRequest(`/games?user_id=${userId}`);
  },
  friends(userId) {
    return backendRequest(`/friends/index?user_id=${userId}`);
  },
  friendsMovieIds(userId, friendId) {
    return backendRequest(
      `/friends/movie_ids?user_id=${userId}&friend_id=${friendId}`
    );
  },
  gameInvites(userId) {
    return backendRequest(`/game_invites?user_id=${userId}`);
  },
  createGameInvite({ inviterId, inviteeId, gameId }) {
    return backendRequest("/game_invites", {
      method: "POST",
      body: { inviter_id: inviterId, invitee_id: inviteeId, game_id: gameId },
    });
  },
  acceptGameInvite(inviteId, userId) {
    return backendRequest(`/game_invites/${inviteId}/accept`, {
      method: "POST",
      body: { user_id: userId },
    });
  },
  declineGameInvite(inviteId, userId) {
    return backendRequest(`/game_invites/${inviteId}/decline`, {
      method: "POST",
      body: { user_id: userId },
    });
  },
  nudgeGameInvite(inviteId, userId) {
    return backendRequest(`/game_invites/${inviteId}/nudge`, {
      method: "POST",
      body: { user_id: userId },
    });
  },
  upsertGame(game) {
    return backendRequest("/games/upsert", { method: "POST", body: game });
  },
  findGameByEntryCode(entryCode) {
    return backendRequest(`/games/find_by_entry_code?entry_code=${encodeURIComponent(entryCode)}`);
  },
  joinGame(gameId, userId) {
    return backendRequest(`/games/${gameId}/join`, { method: "POST", body: { user_id: userId } });
  },
  leaveGame(gameId, userId) {
    return backendRequest(`/games/${gameId}/leave`, { method: "POST", body: { user_id: userId } });
  },
  ready(gameId, userId) {
    return backendRequest(`/games/${gameId}/ready`, { method: "POST", body: { user_id: userId } });
  },
  finishMatching(gameId, userId, likedMovieIds, seenMovieIds) {
    return backendRequest(`/games/${gameId}/finish_matching`, {
      method: "POST",
      body: { user_id: userId, liked_movie_ids: likedMovieIds, seen_movie_ids: seenMovieIds },
    });
  },
  keepPlaying(params) {
    return backendRequest("/games/keep_playing", { method: "POST", body: params });
  },
  previousGames(userId) {
    return backendRequest(`/games/previous?user_id=${userId}`);
  },
  gameDeck(gameId, userId) {
    return backendRequest(`/games/${gameId}/deck?user_id=${userId}`);
  },
  swipe(gameId, userId, movieId, liked, mediaType = "movie") {
    return backendRequest(`/games/${gameId}/swipe`, {
      method: "POST",
      body: {
        user_id: userId,
        movie_id: movieId,
        media_type: mediaType || "movie",
        media_key: mediaKey(movieId, mediaType),
        liked,
      },
    });
  },
  undoSwipe(gameId, userId, movieId, mediaType = "movie") {
    return backendRequest(`/games/${gameId}/undo_swipe`, {
      method: "POST",
      body: {
        user_id: userId,
        movie_id: movieId,
        media_type: mediaType || "movie",
        media_key: mediaKey(movieId, mediaType),
      },
    });
  },
  shopCatalog(userId) {
    const qs = userId ? `?user_id=${userId}` : "";
    return backendRequest(`/shop/catalog${qs}`);
  },
  shopEntitlements(userId) {
    return backendRequest(`/shop/entitlements?user_id=${userId}`);
  },
  createShopCheckout(productId, userId) {
    return backendRequest("/shop/checkout", {
      method: "POST",
      body: { product_id: productId, user_id: userId },
    });
  },
  confirmShopPurchase(sessionId, userId) {
    return backendRequest("/shop/confirm", {
      method: "POST",
      body: { session_id: sessionId, user_id: userId },
    });
  },
  createShopPortal(userId) {
    return backendRequest("/shop/portal", {
      method: "POST",
      body: { user_id: userId },
    });
  },
};

function mediaKey(id, mediaType = "movie") {
  if (id == null || id === "") return null;
  const raw = String(id);
  if (raw.includes(":")) return raw;
  return `${mediaType === "tv" ? "tv" : "movie"}:${Number(raw)}`;
}

function parseMediaKey(value) {
  const raw = String(value ?? "");
  if (raw.includes(":")) {
    const [media, id] = raw.split(":");
    return { mediaType: media === "tv" ? "tv" : "movie", id: Number(id) };
  }
  return { mediaType: "movie", id: Number(raw) };
}

function normalizeMediaKeyList(values) {
  return [...new Set((values || []).map((v) => mediaKey(parseMediaKey(v).id, parseMediaKey(v).mediaType)).filter(Boolean))];
}

const tmdb = {
  async movie(movieId) {
    const params = new URLSearchParams({
      api_key: TMDB_API_KEY,
      append_to_response: "credits,videos,reviews,watch/providers",
    });
    const response = await fetch(`https://api.themoviedb.org/3/movie/${movieId}?${params}`);
    if (!response.ok) throw new Error(`TMDB movie failed (${response.status})`);
    const data = await response.json();
    return { ...data, media_type: "movie" };
  },

  async tv(tvId) {
    const params = new URLSearchParams({
      api_key: TMDB_API_KEY,
      append_to_response: "credits,videos,reviews,watch/providers",
    });
    const response = await fetch(`https://api.themoviedb.org/3/tv/${tvId}?${params}`);
    if (!response.ok) throw new Error(`TMDB tv failed (${response.status})`);
    const data = await response.json();
    return {
      ...data,
      title: data.name || data.title,
      release_date: data.first_air_date || data.release_date,
      runtime: Array.isArray(data.episode_run_time) ? data.episode_run_time[0] : data.runtime,
      media_type: "tv",
    };
  },

  async genres(media = "movie") {
    const kind = media === "tv" ? "tv" : "movie";
    const response = await fetch(
      `https://api.themoviedb.org/3/genre/${kind}/list?api_key=${TMDB_API_KEY}&language=en-US`
    );
    if (!response.ok) throw new Error(`TMDB genres failed (${response.status})`);
    return (await response.json()).genres;
  },

  async watchProviders(region = "US") {
    const params = new URLSearchParams({
      api_key: TMDB_API_KEY,
      language: "en-US",
      watch_region: region,
    });
    const response = await fetch(`https://api.themoviedb.org/3/watch/providers/movie?${params}`);
    if (!response.ok) throw new Error(`TMDB providers failed (${response.status})`);
    return (await response.json()).results || [];
  },

  async details(id, mediaType = "movie") {
    return mediaType === "tv" ? this.tv(id) : this.movie(id);
  },
};

let providersCache = null;

async function loadProviders() {
  if (providersCache) return providersCache;

  try {
    const results = await tmdb.watchProviders("US");
    const byId = new Map(results.map((p) => [String(p.provider_id), p]));
    const featuredSet = new Set(FEATURED_PROVIDER_IDS);

    const featured = FEATURED_PROVIDER_IDS.map((id) => {
      const p = byId.get(id);
      if (p) return { title: p.provider_name, code: id, logo_path: p.logo_path };
      const fallback = PROVIDERS_FALLBACK.find((item) => item.code === id);
      return fallback ? { ...fallback } : null;
    }).filter(Boolean);
    const rest = results
      .filter((p) => !featuredSet.has(String(p.provider_id)))
      .sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999))
      .map((p) => ({
        title: p.provider_name,
        code: String(p.provider_id),
        logo_path: p.logo_path,
      }));

    providersCache = { featured, all: [...featured, ...rest] };
  } catch {
    providersCache = { featured: PROVIDERS_FALLBACK, all: PROVIDERS_FALLBACK };
  }

  return providersCache;
}

// Back-compat alias used by older call sites.
const PROVIDERS = PROVIDERS_FALLBACK;


// Builds the discover query stored on the game (deck builder reads params).
function buildDiscoverQuery(values) {
  const year = new Date().getFullYear();
  const ranges = (values.releaseYearRanges?.length
    ? values.releaseYearRanges
    : [values.releaseYearRange || [1950, year]]
  ).map(([from, to]) => [Number(from), Number(to)]);

  const minYear = Math.min(...ranges.map(([from]) => from));
  const maxYear = Math.max(...ranges.map(([, to]) => to));
  const mediaType = values.mediaType || "movie";

  const params = {
    with_origin_country: "US",
    page: Math.floor(Math.random() * 5) + 1,
    sort_by: "popularity.desc",
    media_type: mediaType,
    "vote_average.gte": values.userScoreRange[0],
    "vote_average.lte": values.userScoreRange[1],
    "primary_release_date.gte": `${minYear}-01-01`,
    "primary_release_date.lte": `${maxYear}-12-31`,
    "with_runtime.gte": values.runtimeRange[0],
    "with_runtime.lte": values.runtimeRange[1],
  };

  if (ranges.length > 1) {
    params.ww_year_ranges = ranges.map(([from, to]) => `${from}-${to}`).join(",");
  }

  if (values.favorPopular) {
    params.favor_popular = "true";
    params["vote_count.gte"] = 500;
  }

  const genreIds = (values.genres || []).map(Number);
  const wantsKids = genreIds.includes(10751) || genreIds.includes(10762);
  if (!values.includeKids && !wantsKids) {
    params.exclude_kids = "true";
    // Certification is primary; genre exclusion backs up recommendations.
    params.without_genres = mediaType === "movie" ? "10751" : "10751|10762";
    params.certification_country = "US";
    if (mediaType === "tv") {
      params["certification.gte"] = "TV-PG";
    } else if (mediaType === "movie") {
      params["certification.gte"] = "PG";
    }
    // "both" applies per-media certs in DeckBuilder; keep genre backup here.
  } else if (values.includeKids) {
    params.include_kids = "true";
  }

  const providerIds = normalizeProviderIds(values.providers);
  if (providerIds.length > 0) {
    params.with_watch_providers = providerIds.join("|");
    params.watch_region = "US";
    // Subscription streaming only — without this, discover also matches rent/buy.
    params.with_watch_monetization_types = "flatrate";
  }
  if (genreIds.length > 0) {
    params.with_genres = genreIds.join("|");
  }
  if (values.languages.length > 0) {
    params.with_original_language = values.languages.join("|");
  }

  if (values.curateKeys?.length) {
    params.ww_curate_keys = values.curateKeys.join(",");
  }

  const path = mediaType === "tv" ? "discover/tv" : "discover/movie";
  return {
    method: "GET",
    url: `https://api.themoviedb.org/3/${path}?api_key=${TMDB_API_KEY}`,
    params,
  };
}


function generateEntryCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function posterUrl(path, size = "w500") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

function profileUrl(path) {
  return path ? `https://image.tmdb.org/t/p/w185${path}` : null;
}
