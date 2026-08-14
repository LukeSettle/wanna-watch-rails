// Backend + TMDB clients. Payload shapes mirror the React Native app
// (app/data/backend_client.js and app/data/movie_api.js in the WannaWatch repo)
// so web and mobile players are fully compatible in the same game.

const TMDB_API_KEY = "fd1efe23da588e99056fdb264ca89bbd";

const PROVIDERS = [
  { title: "Netflix", code: "8" },
  { title: "Max", code: "1899" },
  { title: "Hulu", code: "15" },
  { title: "Disney+", code: "337" },
  { title: "Peacock", code: "386" },
  { title: "Amazon Prime Video", code: "9" },
  { title: "Paramount Plus", code: "531" },
  { title: "Apple TV", code: "2" },
];

async function backendRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = new Error(`Request failed: ${method} ${path} (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

const backend = {
  upsertUser(user) {
    return backendRequest("/users/upsert", { method: "POST", body: user });
  },
  findUserByDeviceId(deviceId) {
    return backendRequest(`/users/find_by_device_id?device_id=${encodeURIComponent(deviceId)}`);
  },
  gamesIndex(userId) {
    return backendRequest(`/games?user_id=${userId}`);
  },
  upsertGame(game) {
    return backendRequest("/games/upsert", { method: "POST", body: game });
  },
  findGameByEntryCode(entryCode) {
    return backendRequest(`/games/find_by_entry_code?entry_code=${encodeURIComponent(entryCode)}`);
  },
  keepPlaying(params) {
    return backendRequest("/games/keep_playing", { method: "POST", body: params });
  },
  friendsIndex(userId) {
    return backendRequest(`/friends/index?user_id=${userId}`);
  },
  friendsMovieIds(userId, friendId) {
    return backendRequest(`/friends/movie_ids?user_id=${userId}&friend_id=${friendId}`);
  },
};

const tmdb = {
  // game.query stores an axios-style request ({ method, url, params }) written
  // by whichever client created the game, so every player runs the same search.
  async discover(game) {
    const options = JSON.parse(game.query);
    const page = ((options.params.page + game.load_more_count) % 500) + 1;
    const params = new URLSearchParams({ ...options.params, page });
    const response = await fetch(`${options.url}&${params}`);
    if (!response.ok) throw new Error(`TMDB discover failed (${response.status})`);
    return (await response.json()).results;
  },

  async movieDetails(movieId) {
    const [details, providers] = await Promise.all([
      fetch(`https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_API_KEY}`),
      fetch(`https://api.themoviedb.org/3/movie/${movieId}/watch/providers?api_key=${TMDB_API_KEY}`),
    ]);
    if (!details.ok) throw new Error(`TMDB details failed (${details.status})`);
    return {
      movieDetails: await details.json(),
      watchProviders: providers.ok ? await providers.json() : { results: {} },
    };
  },

  async genres() {
    const response = await fetch(
      `https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_API_KEY}&language=en-US`
    );
    if (!response.ok) throw new Error(`TMDB genres failed (${response.status})`);
    return (await response.json()).genres;
  },
};

// Builds the identical query the React Native GameForm builds.
function buildDiscoverQuery(values) {
  const params = {
    with_origin_country: "US",
    page: Math.floor(Math.random() * 5) + 1,
    sort_by: "popularity.desc",
    "vote_average.gte": values.userScoreRange[0],
    "vote_average.lte": values.userScoreRange[1],
    "primary_release_date.gte": `${values.releaseYearRange[0]}-01-01`,
    "primary_release_date.lte": `${values.releaseYearRange[1]}-12-31`,
    "with_runtime.gte": values.runtimeRange[0],
    "with_runtime.lte": values.runtimeRange[1],
  };

  if (values.providers.length > 0) {
    params.with_watch_providers = values.providers.join("|");
    params.watch_region = "US";
  }
  if (values.genres.length > 0) {
    params.with_genres = values.genres.join("|");
  }
  if (values.languages.length > 0) {
    params.with_original_language = values.languages.join("|");
  }

  return {
    method: "GET",
    url: `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}`,
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
