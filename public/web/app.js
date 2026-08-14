// WannaWatch web client. Single-page app with no build step.
// Screens: name -> home/create -> lobby -> match (swiping) -> waiting -> results.

const state = {
  user: null,
  view: "loading",      // view when not in a game: name | home | create | matches
  game: null,
  movies: [],
  serverMessages: [],
  currentGames: [],
  friends: [],
  noMoreMovies: false,
  finishedSent: false,
  fetchingMovies: false,
};

let cable = null;
let lastRenderKey = null;

const app = document.getElementById("app");

// ---------- helpers ----------

function esc(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2500);
}

function storageKey(suffix) {
  return `ww_${suffix}`;
}

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function currentPlayer() {
  return state.game?.players?.find((p) => p.user?.id === state.user?.id);
}

function likedIdsKey() {
  return storageKey(`liked_${state.game.id}`);
}

function swipedIdsKey() {
  return storageKey(`swiped_${state.game.id}`);
}

// ---------- boot ----------

async function boot() {
  let deviceId = localStorage.getItem(storageKey("device_id"));
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(storageKey("device_id"), deviceId);
  }
  state.deviceId = deviceId;

  try {
    state.user = await backend.findUserByDeviceId(deviceId);
  } catch {
    state.user = null;
  }

  if (state.user?.username) {
    await enterHome();
  } else {
    state.view = "name";
    render();
  }
}

function pendingEntryCode() {
  return new URLSearchParams(location.search).get("entry_code");
}

async function enterHome() {
  connectCable();

  const entryCode = pendingEntryCode();
  if (entryCode) {
    history.replaceState({}, "", "/");
    const joined = await joinGameByCode(entryCode);
    if (joined) return;
  }

  state.view = "home";
  cable.subscribe({ channel: "UserGamesChannel" });
  render();
  refreshGamesList();
}

function connectCable() {
  if (cable) return;
  cable = new Cable(state.user.id, handleSocketMessage);
}

async function refreshGamesList() {
  try {
    state.currentGames = await backend.gamesIndex(state.user.id);
  } catch {
    state.currentGames = [];
  }
  renderGamesList();
}

// ---------- socket ----------

function gameChannelParams() {
  return { channel: "GameChannel", game_id: state.game.id };
}

function handleSocketMessage(data) {
  const msg = data.message;
  if (!msg || msg.type !== "system") return;

  if (msg.message === "game_index_updated") {
    refreshGamesList();
    return;
  }

  state.serverMessages.push(msg.message);
  if (typeof msg.game === "string" && msg.game.length > 2) {
    const game = JSON.parse(msg.game);
    if (state.game && game.id === state.game.id) applyGameUpdate(game);
  }
  render();
}

function applyGameUpdate(game) {
  const previous = state.game;
  state.game = game;

  if (previous && game.load_more_count > previous.load_more_count) {
    state.finishedSent = false;
    fetchMovies();
  }
  if (!currentPlayer()?.finished_at) {
    state.finishedSent = false;
  }
}

// ---------- game lifecycle ----------

async function joinGameByCode(code) {
  try {
    const game = await backend.findGameByEntryCode(code.trim().toUpperCase());
    startGame(game);
    return true;
  } catch (error) {
    toast(error.status === 404 ? "Game not found. Check the code." : "Could not join game.");
    return false;
  }
}

function startGame(game) {
  state.game = game;
  state.movies = [];
  state.serverMessages = [];
  state.noMoreMovies = false;
  state.finishedSent = false;
  connectCable();
  cable.subscribe(gameChannelParams());
  render();
  if (currentPlayer()?.ready_at) fetchMovies();
}

function leaveGame() {
  if (state.game) cable.unsubscribe(gameChannelParams());
  state.game = null;
  state.movies = [];
  state.view = "home";
  cable.subscribe({ channel: "UserGamesChannel" });
  render();
  refreshGamesList();
}

async function createGame(values) {
  const query = buildDiscoverQuery(values);
  const game = await backend.upsertGame({
    entry_code: generateEntryCode(),
    query: JSON.stringify(query),
    user_id: state.user.id,
    providers: values.providers,
  });
  startGame(game);
}

function sendReady() {
  cable.perform(gameChannelParams(), "ready");
}

function likedMovieIds() {
  return loadJSON(likedIdsKey(), []);
}

function sendFinished() {
  if (state.finishedSent) return;
  state.finishedSent = true;
  cable.perform(gameChannelParams(), "finish_matching", { liked_movie_ids: likedMovieIds() });
}

async function keepPlaying() {
  try {
    await backend.keepPlaying({ game_id: state.game.id, user_id: state.user.id });
  } catch {
    toast("Could not start another round.");
  }
}

// ---------- movies ----------

async function fetchMovies() {
  if (!state.game?.query || state.fetchingMovies) return;
  state.fetchingMovies = true;
  render();

  try {
    const results = await tmdb.discover(state.game);
    if (results.length === 0 && state.movies.every((m) => m.hidden)) {
      state.noMoreMovies = true;
    }
    const known = new Set(state.movies.map((m) => m.id));
    const swiped = new Set(loadJSON(swipedIdsKey(), []));
    results.forEach((movie) => {
      if (known.has(movie.id)) return;
      known.add(movie.id);
      state.movies.push({ ...movie, hidden: swiped.has(movie.id) });
    });
  } catch (error) {
    console.error(error);
    toast("Could not load movies from TMDB.");
  } finally {
    state.fetchingMovies = false;
    render();
  }
}

function unswipedMovies() {
  return state.movies.filter((m) => !m.hidden);
}

function recordSwipe(movie, liked) {
  movie.hidden = true;

  const swiped = new Set(loadJSON(swipedIdsKey(), []));
  swiped.add(movie.id);
  saveJSON(swipedIdsKey(), [...swiped]);

  if (liked) {
    const liked_ids = new Set(likedMovieIds());
    liked_ids.add(movie.id);
    saveJSON(likedIdsKey(), [...liked_ids]);
  }

  if (unswipedMovies().length === 0) {
    sendFinished();
    render();
  } else {
    updateDeckDom();
  }
}

// ---------- rendering ----------

function screenName() {
  if (!state.user?.username) return "name";
  if (!state.game) return state.view;
  const me = currentPlayer();
  if (state.game.finished_at) return "results";
  if (me?.finished_at) return "waiting";
  if (me?.ready_at) return "match";
  return "lobby";
}

function render() {
  const screen = screenName();
  const key = renderKeyFor(screen);
  if (key === lastRenderKey) {
    if (screen === "lobby" || screen === "waiting") updateDynamicLists(screen);
    return;
  }
  lastRenderKey = key;

  const renderers = {
    name: renderNameScreen,
    home: renderHomeScreen,
    create: renderCreateScreen,
    matches: renderMatchesScreen,
    lobby: renderLobbyScreen,
    match: renderMatchScreen,
    waiting: renderWaitingScreen,
    results: renderResultsScreen,
    loading: () => {},
  };
  renderers[screen]();
}

function renderKeyFor(screen) {
  if (screen === "match") {
    return `match-${state.game.id}-${state.game.load_more_count}-${state.movies.length}-${state.fetchingMovies}-${state.noMoreMovies}-${state.finishedSent}`;
  }
  if (screen === "lobby" || screen === "waiting") return `${screen}-${state.game.id}`;
  if (screen === "results") return `results-${state.game.id}-${state.game.finished_at}`;
  return `${screen}-${Date.now()}`;
}

// Lobby and waiting screens refresh their lists in place on every broadcast.
function updateDynamicLists(screen) {
  const players = document.getElementById("player-list");
  if (players) players.innerHTML = playerListHtml(screen === "waiting");
  const feed = document.getElementById("message-feed");
  if (feed) feed.innerHTML = messageFeedHtml();
}

function topBarHtml(subtitle) {
  return `
    <header class="topbar">
      <div class="brand" id="brand-home">
        <img src="/logo.png" alt="">
        <span>WannaWatch</span>
      </div>
      ${subtitle ? `<span class="topbar-subtitle">${subtitle}</span>` : ""}
    </header>`;
}

function bindBrandHome() {
  document.getElementById("brand-home")?.addEventListener("click", () => {
    if (state.game && !confirm("Leave this game and go home?")) return;
    leaveGame();
  });
}

// ---------- name screen ----------

function renderNameScreen() {
  app.innerHTML = `
    <div class="screen center">
      <img src="/logo.png" alt="WannaWatch" class="logo">
      <h1 class="headline">So… what do you <span class="accent">wanna watch</span>?</h1>
      <p class="muted">Swipe movies with friends. Match on the ones you all like.</p>
      <form id="name-form" class="card form-card">
        <label for="username">What should we call you?</label>
        <input id="username" name="username" maxlength="30" placeholder="Enter your name" required autocomplete="nickname">
        <button type="submit" class="btn btn-primary">Let's go</button>
      </form>
    </div>`;

  document.getElementById("name-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = document.getElementById("username").value.trim();
    if (!username) return;
    try {
      state.user = await backend.upsertUser({ device_id: state.deviceId, username });
      await enterHome();
    } catch {
      toast("Could not save your name. Try again.");
    }
  });
}

// ---------- home screen ----------

function renderHomeScreen() {
  app.innerHTML = `
    ${topBarHtml(`<button class="link" id="edit-name">${esc(state.user.username)}</button>`)}
    <div class="screen">
      <div class="hero">
        <h1 class="headline">Movie night, <span class="accent">solved</span>.</h1>
        <p class="muted">Start a game, share the code, swipe the same movies. See what you all match on.</p>
      </div>

      <button class="btn btn-primary btn-big" id="create-game">+ Create a game</button>

      <form id="join-form" class="card form-card">
        <label for="join-code">Have a game code?</label>
        <div class="join-row">
          <input id="join-code" placeholder="e.g. ABC123" maxlength="6" autocomplete="off" autocapitalize="characters">
          <button type="submit" class="btn btn-secondary">Join</button>
        </div>
      </form>

      <section class="card list-card">
        <h2>Your games</h2>
        <div id="games-list"><p class="muted">Loading…</p></div>
      </section>

      <button class="link" id="view-matches">View past matches with friends</button>
    </div>`;

  document.getElementById("create-game").addEventListener("click", () => {
    state.view = "create";
    render();
  });

  document.getElementById("join-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = document.getElementById("join-code").value;
    if (code.trim()) joinGameByCode(code);
  });

  document.getElementById("edit-name").addEventListener("click", async () => {
    const username = prompt("Update your name:", state.user.username);
    if (!username?.trim()) return;
    state.user = await backend.upsertUser({ device_id: state.deviceId, username: username.trim() });
    lastRenderKey = null;
    render();
  });

  document.getElementById("view-matches").addEventListener("click", () => {
    state.view = "matches";
    render();
  });

  renderGamesList();
  refreshGamesList();
}

function renderGamesList() {
  const container = document.getElementById("games-list");
  if (!container) return;

  if (state.currentGames.length === 0) {
    container.innerHTML = `<p class="muted">No games yet. Create one and invite a friend!</p>`;
    return;
  }

  container.innerHTML = state.currentGames.map((game) => `
    <button class="game-row" data-code="${esc(game.entry_code)}">
      <span class="game-code">${esc(game.entry_code)}</span>
      <span class="game-players">${game.players.map((p) => esc(p.user?.username)).join(", ")}</span>
      <span class="game-resume">Resume →</span>
    </button>`).join("");

  container.querySelectorAll(".game-row").forEach((row) => {
    row.addEventListener("click", () => joinGameByCode(row.dataset.code));
  });
}

// ---------- create game screen ----------

let genresCache = null;

async function renderCreateScreen() {
  const currentYear = new Date().getFullYear();

  app.innerHTML = `
    ${topBarHtml("")}
    <div class="screen">
      <h1 class="headline-sm">Set up your movie list</h1>
      <form id="create-form">
        <section class="card form-card">
          <label>Streaming services <span class="muted">(optional)</span></label>
          <div class="chips" id="provider-chips">
            ${PROVIDERS.map((p) => `<button type="button" class="chip" data-value="${p.code}">${esc(p.title)}</button>`).join("")}
          </div>
        </section>

        <section class="card form-card">
          <label>Genres <span class="muted">(optional)</span></label>
          <div class="chips" id="genre-chips"><span class="muted">Loading genres…</span></div>
        </section>

        <section class="card form-card">
          <label for="min-rating">Minimum rating: <strong id="min-rating-label">Any</strong></label>
          <input type="range" id="min-rating" min="0" max="8" step="1" value="0">

          <label>Release years</label>
          <div class="year-row">
            <select id="year-from"></select>
            <span class="muted">to</span>
            <select id="year-to"></select>
          </div>

          <label for="max-runtime">Max runtime: <strong id="max-runtime-label">Any</strong></label>
          <input type="range" id="max-runtime" min="60" max="240" step="10" value="240">
        </section>

        <div class="button-row">
          <button type="button" class="btn btn-ghost" id="cancel-create">Back</button>
          <button type="submit" class="btn btn-primary">Create game</button>
        </div>
      </form>
    </div>`;

  bindBrandHome();

  const yearFrom = document.getElementById("year-from");
  const yearTo = document.getElementById("year-to");
  for (let year = currentYear; year >= 1950; year--) {
    yearFrom.insertAdjacentHTML("beforeend", `<option value="${year}">${year}</option>`);
    yearTo.insertAdjacentHTML("beforeend", `<option value="${year}">${year}</option>`);
  }
  yearFrom.value = 1980;
  yearTo.value = currentYear;

  const minRating = document.getElementById("min-rating");
  minRating.addEventListener("input", () => {
    document.getElementById("min-rating-label").textContent =
      minRating.value === "0" ? "Any" : `${minRating.value}+`;
  });

  const maxRuntime = document.getElementById("max-runtime");
  maxRuntime.addEventListener("input", () => {
    document.getElementById("max-runtime-label").textContent =
      maxRuntime.value === "240" ? "Any" : `${maxRuntime.value} min`;
  });

  const bindChips = (containerId) => {
    document.getElementById(containerId).addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (chip) chip.classList.toggle("selected");
    });
  };
  bindChips("provider-chips");
  bindChips("genre-chips");

  // Pre-select the user's saved streaming services.
  (state.user.providers || []).forEach((code) => {
    document.querySelector(`#provider-chips .chip[data-value="${code}"]`)?.classList.add("selected");
  });

  document.getElementById("cancel-create").addEventListener("click", () => {
    state.view = "home";
    render();
  });

  document.getElementById("create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = (id) =>
      [...document.querySelectorAll(`#${id} .chip.selected`)].map((chip) => chip.dataset.value);

    const values = {
      providers: selected("provider-chips"),
      genres: selected("genre-chips"),
      languages: [],
      userScoreRange: [Number(minRating.value), 10],
      releaseYearRange: [Number(yearFrom.value), Number(yearTo.value)],
      runtimeRange: [0, Number(maxRuntime.value)],
    };

    try {
      await createGame(values);
    } catch {
      toast("Something went wrong creating the game.");
    }
  });

  try {
    genresCache = genresCache || (await tmdb.genres());
    const chipContainer = document.getElementById("genre-chips");
    if (chipContainer) {
      chipContainer.innerHTML = genresCache
        .map((g) => `<button type="button" class="chip" data-value="${g.id}">${esc(g.name)}</button>`)
        .join("");
    }
  } catch {
    const chipContainer = document.getElementById("genre-chips");
    if (chipContainer) chipContainer.innerHTML = `<span class="muted">Genres unavailable</span>`;
  }
}

// ---------- lobby ----------

function playerListHtml(showFinished = false) {
  return (state.game.players || []).map((player) => {
    const status = showFinished
      ? (player.finished_at ? "✓ done" : "still swiping…")
      : (player.ready_at ? "✓ ready" : "not ready");
    const statusClass = (showFinished ? player.finished_at : player.ready_at) ? "ok" : "";
    return `
      <div class="player-row">
        <span class="player-name">${esc(player.user?.username)}${player.user?.id === state.user.id ? " (you)" : ""}</span>
        <span class="player-status ${statusClass}">${status}</span>
      </div>`;
  }).join("");
}

function messageFeedHtml() {
  return [...state.serverMessages].slice(-6).reverse()
    .map((message) => `<div class="feed-row">${esc(message)}</div>`)
    .join("");
}

function shareLink() {
  return `${location.origin}/?entry_code=${state.game.entry_code}`;
}

function renderLobbyScreen() {
  const me = currentPlayer();

  app.innerHTML = `
    ${topBarHtml(`<span class="muted">Lobby</span>`)}
    <div class="screen">
      <div class="card code-card">
        <p class="muted">Share this code with friends</p>
        <div class="entry-code">${esc(state.game.entry_code)}</div>
        <div class="button-row">
          <button class="btn btn-secondary" id="copy-link">Copy invite link</button>
          <button class="btn btn-ghost" id="copy-code">Copy code</button>
        </div>
      </div>

      <section class="card list-card">
        <h2>Players</h2>
        <div id="player-list">${playerListHtml()}</div>
      </section>

      <button class="btn btn-primary btn-big" id="ready-button" ${me?.ready_at ? "disabled" : ""}>
        ${me?.ready_at ? "Waiting for others…" : "I'm ready — start swiping"}
      </button>

      <section class="card list-card">
        <h2>Activity</h2>
        <div id="message-feed">${messageFeedHtml()}</div>
      </section>

      <button class="link" id="leave-game">Leave game</button>
    </div>`;

  bindBrandHome();

  document.getElementById("copy-link").addEventListener("click", async () => {
    await navigator.clipboard.writeText(shareLink());
    toast("Invite link copied!");
  });

  document.getElementById("copy-code").addEventListener("click", async () => {
    await navigator.clipboard.writeText(state.game.entry_code);
    toast("Code copied!");
  });

  document.getElementById("ready-button").addEventListener("click", () => {
    if (state.game.players.length === 1) {
      const goSolo = confirm(
        "You're the only one here! It's more fun with friends — share the invite link so they can join. Continue solo anyway?"
      );
      if (!goSolo) return;
    }
    sendReady();
    fetchMovies();
  });

  document.getElementById("leave-game").addEventListener("click", leaveGame);
}

// ---------- matching (swipe deck) ----------

function renderMatchScreen() {
  if (state.finishedSent && unswipedMovies().length === 0) {
    app.innerHTML = `
      ${topBarHtml("")}
      <div class="screen center">
        <div class="spinner"></div>
        <p class="muted">Sending your picks…</p>
      </div>`;
    bindBrandHome();
    return;
  }

  if (state.movies.length === 0 && !state.fetchingMovies && !state.noMoreMovies) {
    fetchMovies();
  }

  if (state.noMoreMovies) {
    app.innerHTML = `
      ${topBarHtml("")}
      <div class="screen center">
        <h1 class="headline-sm">No more movies match your filters</h1>
        <p class="muted">Try a new game with different genres or services.</p>
        <button class="btn btn-primary" id="back-home">Back to home</button>
      </div>`;
    bindBrandHome();
    document.getElementById("back-home").addEventListener("click", leaveGame);
    return;
  }

  if (state.fetchingMovies && unswipedMovies().length === 0) {
    app.innerHTML = `
      ${topBarHtml("")}
      <div class="screen center">
        <div class="spinner"></div>
        <p class="muted">Loading movies…</p>
      </div>`;
    bindBrandHome();
    return;
  }

  app.innerHTML = `
    ${topBarHtml(`<span class="code-pill">${esc(state.game.entry_code)}</span>`)}
    <div class="screen match-layout">
      <div class="deck-meta">
        <span id="deck-counter"></span>
        <span class="muted">tap card for details</span>
      </div>
      <div class="deck" id="deck"></div>
      <div class="swipe-actions">
        <button class="action-btn nope" id="nope-button" aria-label="Nope">✕</button>
        <button class="action-btn like" id="like-button" aria-label="Like">♥</button>
      </div>
    </div>`;

  bindBrandHome();
  updateDeckDom();

  document.getElementById("nope-button").addEventListener("click", () => swipeTopCard(false));
  document.getElementById("like-button").addEventListener("click", () => swipeTopCard(true));
}

function movieCardHtml(movie) {
  const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
  const rating = movie.vote_average ? movie.vote_average.toFixed(1) : "–";
  const poster = posterUrl(movie.poster_path);
  return `
    <div class="movie-card" data-id="${movie.id}">
      <div class="stamp stamp-like">LIKE</div>
      <div class="stamp stamp-nope">NOPE</div>
      ${poster
        ? `<img class="poster" src="${poster}" alt="${esc(movie.title)}" draggable="false">`
        : `<div class="poster poster-missing">${esc(movie.title)}</div>`}
      <div class="card-caption">
        <div class="card-title-row">
          <strong>${esc(movie.title)}</strong>
          <span class="rating">★ ${rating}</span>
        </div>
        <span class="muted">${year}</span>
      </div>
      <div class="card-details">
        <h3>${esc(movie.title)} <span class="muted">${year}</span></h3>
        <p class="rating">★ ${rating} / 10</p>
        <p class="overview">${esc(movie.overview || "No description available.")}</p>
        <p class="muted">Tap to flip back</p>
      </div>
    </div>`;
}

function updateDeckDom() {
  const deck = document.getElementById("deck");
  if (!deck) return;

  const queue = unswipedMovies();
  const counter = document.getElementById("deck-counter");
  if (counter) counter.textContent = `${queue.length} movie${queue.length === 1 ? "" : "s"} left`;

  deck.innerHTML = queue.slice(0, 3).map(movieCardHtml).reverse().join("");

  const cards = deck.querySelectorAll(".movie-card");
  const topCard = cards[cards.length - 1];
  if (topCard) {
    const movie = queue[0];
    attachSwipeHandlers(topCard, movie);
  }
}

function attachSwipeHandlers(card, movie) {
  let startX = 0;
  let startY = 0;
  let deltaX = 0;
  let dragging = false;
  let moved = false;

  const threshold = Math.min(130, window.innerWidth * 0.3);

  const setTransform = () => {
    const rotation = (deltaX / window.innerWidth) * 20;
    card.style.transform = `translateX(${deltaX}px) rotate(${rotation}deg)`;
    const likeStamp = card.querySelector(".stamp-like");
    const nopeStamp = card.querySelector(".stamp-nope");
    likeStamp.style.opacity = deltaX > 0 ? Math.min(1, deltaX / threshold) : 0;
    nopeStamp.style.opacity = deltaX < 0 ? Math.min(1, -deltaX / threshold) : 0;
  };

  card.addEventListener("pointerdown", (event) => {
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    deltaX = 0;
    card.setPointerCapture(event.pointerId);
    card.classList.add("dragging");
  });

  card.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    deltaX = event.clientX - startX;
    if (Math.abs(deltaX) > 8 || Math.abs(event.clientY - startY) > 8) moved = true;
    setTransform();
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove("dragging");

    if (Math.abs(deltaX) > threshold) {
      flyOut(card, deltaX > 0, movie);
    } else {
      card.style.transform = "";
      card.querySelector(".stamp-like").style.opacity = 0;
      card.querySelector(".stamp-nope").style.opacity = 0;
      if (!moved) card.classList.toggle("flipped");
    }
    deltaX = 0;
  };

  card.addEventListener("pointerup", endDrag);
  card.addEventListener("pointercancel", endDrag);
}

function flyOut(card, liked, movie) {
  const exitX = liked ? window.innerWidth : -window.innerWidth;
  card.classList.add("flying");
  card.style.transform = `translateX(${exitX * 1.2}px) rotate(${liked ? 30 : -30}deg)`;
  card.querySelector(liked ? ".stamp-like" : ".stamp-nope").style.opacity = 1;
  setTimeout(() => recordSwipe(movie, liked), 250);
}

function swipeTopCard(liked) {
  const queue = unswipedMovies();
  if (queue.length === 0) return;
  const deck = document.getElementById("deck");
  const cards = deck.querySelectorAll(".movie-card");
  const topCard = cards[cards.length - 1];
  if (topCard) {
    flyOut(topCard, liked, queue[0]);
  } else {
    recordSwipe(queue[0], liked);
  }
}

document.addEventListener("keydown", (event) => {
  if (screenName() !== "match") return;
  if (event.key === "ArrowRight") swipeTopCard(true);
  if (event.key === "ArrowLeft") swipeTopCard(false);
});

// ---------- waiting ----------

function renderWaitingScreen() {
  app.innerHTML = `
    ${topBarHtml(`<span class="code-pill">${esc(state.game.entry_code)}</span>`)}
    <div class="screen center">
      <div class="spinner"></div>
      <h1 class="headline-sm">You're done swiping!</h1>
      <p class="muted">Hang tight while everyone finishes.</p>
      <section class="card list-card full-width">
        <h2>Players</h2>
        <div id="player-list">${playerListHtml(true)}</div>
      </section>
      <button class="link" id="leave-game">Back to home</button>
    </div>`;

  bindBrandHome();
  document.getElementById("leave-game").addEventListener("click", leaveGame);
}

// ---------- results ----------

async function renderResultsScreen() {
  const idLists = (state.game.players || []).map((p) => p.liked_movie_ids || []);
  const matchedIds = idLists.length
    ? idLists.reduce((a, b) => a.filter((id) => b.includes(id)))
    : [];

  const heading =
    matchedIds.length === 0
      ? "No matches this round 😅"
      : matchedIds.length === 1
        ? "It's a match! 🎉"
        : `${matchedIds.length} matches! 🎉`;

  app.innerHTML = `
    ${topBarHtml(`<span class="code-pill">${esc(state.game.entry_code)}</span>`)}
    <div class="screen">
      <h1 class="headline-sm center-text">${heading}</h1>
      <p class="muted center-text">${matchedIds.length === 0
        ? "Nobody liked the same movies. Keep playing for a fresh batch!"
        : "You all swiped right on these:"}</p>
      <div class="results-grid" id="results-grid"></div>
      <div class="button-row sticky-actions">
        <button class="btn btn-primary" id="keep-playing">Keep playing</button>
        <button class="btn btn-ghost" id="go-home">Home</button>
      </div>
    </div>`;

  bindBrandHome();
  document.getElementById("keep-playing").addEventListener("click", keepPlaying);
  document.getElementById("go-home").addEventListener("click", leaveGame);

  const grid = document.getElementById("results-grid");
  if (matchedIds.length === 0) return;

  const localMovies = new Map(state.movies.map((m) => [m.id, m]));
  const cards = await Promise.all(matchedIds.slice(0, 30).map(async (id) => {
    let movie = localMovies.get(id);
    if (!movie) {
      try {
        movie = (await tmdb.movieDetails(id)).movieDetails;
      } catch {
        return "";
      }
    }
    const poster = posterUrl(movie.poster_path, "w342");
    const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
    return `
      <div class="result-card">
        ${poster ? `<img src="${poster}" alt="${esc(movie.title)}">` : `<div class="poster-missing">${esc(movie.title)}</div>`}
        <div class="result-info">
          <strong>${esc(movie.title)}</strong>
          <span class="muted">${year} · ★ ${movie.vote_average ? movie.vote_average.toFixed(1) : "–"}</span>
        </div>
      </div>`;
  }));

  if (grid.isConnected) grid.innerHTML = cards.join("");
}

// ---------- friend matches ----------

async function renderMatchesScreen() {
  app.innerHTML = `
    ${topBarHtml("")}
    <div class="screen">
      <h1 class="headline-sm">Matches with friends</h1>
      <p class="muted">Pick a friend to see every movie you've both liked, across all your games.</p>
      <div id="friend-list" class="card list-card"><p class="muted">Loading…</p></div>
      <div id="friend-matches"></div>
      <button class="link" id="back-home">Back to home</button>
    </div>`;

  bindBrandHome();
  document.getElementById("back-home").addEventListener("click", () => {
    state.view = "home";
    render();
  });

  let friends = [];
  try {
    friends = (await backend.friendsIndex(state.user.id)).filter((f) => f.id !== state.user.id);
  } catch {
    // fall through to empty state
  }

  const list = document.getElementById("friend-list");
  if (!list) return;

  if (friends.length === 0) {
    list.innerHTML = `<p class="muted">No friends yet — play a game together first!</p>`;
    return;
  }

  list.innerHTML = friends
    .map((f) => `<button class="game-row friend-row" data-id="${f.id}"><span>${esc(f.username)}</span><span class="game-resume">See matches →</span></button>`)
    .join("");

  list.querySelectorAll(".friend-row").forEach((row) => {
    row.addEventListener("click", async () => {
      const container = document.getElementById("friend-matches");
      container.innerHTML = `<p class="muted center-text">Loading matches…</p>`;
      try {
        const { ourLikedMovieIds } = await backend.friendsMovieIds(state.user.id, row.dataset.id);
        if (ourLikedMovieIds.length === 0) {
          container.innerHTML = `<p class="muted center-text">No shared likes with this friend yet.</p>`;
          return;
        }
        const cards = await Promise.all(ourLikedMovieIds.slice(0, 24).map(async (id) => {
          try {
            const movie = (await tmdb.movieDetails(id)).movieDetails;
            const poster = posterUrl(movie.poster_path, "w342");
            return `
              <div class="result-card">
                ${poster ? `<img src="${poster}" alt="${esc(movie.title)}">` : `<div class="poster-missing">${esc(movie.title)}</div>`}
                <div class="result-info"><strong>${esc(movie.title)}</strong></div>
              </div>`;
          } catch {
            return "";
          }
        }));
        container.innerHTML = `<div class="results-grid">${cards.join("")}</div>`;
      } catch {
        container.innerHTML = `<p class="muted center-text">Could not load matches.</p>`;
      }
    });
  });
}

boot();
