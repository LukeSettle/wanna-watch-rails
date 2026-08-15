// WannaWatch web client. Single-page app with no build step.
// Screens: name -> home/create -> lobby -> match (swiping) -> waiting -> results.

const state = {
  user: null,
  view: "loading",      // view when not in a game: name | home | create | history
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
let ignoreClicksUntil = 0;

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

function onTap(el, handler) {
  if (!el) return;
  el.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() < ignoreClicksUntil) return;
    handler(event);
  });
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

  const resetToken = new URLSearchParams(location.search).get("reset_token");
  if (resetToken) {
    history.replaceState({}, "", "/");
    state.resetToken = resetToken;
    state.view = "reset";
    render();
    return;
  }

  // A login session wins over the device-based guest identity.
  try {
    state.user = await backend.me();
    adoptUser(state.user);
  } catch {
    try {
      state.user = await backend.findUserByDeviceId(deviceId);
    } catch {
      state.user = null;
    }
  }

  if (state.user?.username) {
    await enterHome();
  } else {
    state.view = "name";
    render();
  }
}

// Keeps the guest fallback pointing at the logged-in account.
function adoptUser(user) {
  state.user = user;
  if (user.device_id) {
    state.deviceId = user.device_id;
    localStorage.setItem(storageKey("device_id"), user.device_id);
  }
}

async function logout() {
  try {
    await backend.logout();
  } catch {
    // clearing local state is what matters
  }
  localStorage.removeItem(storageKey("device_id"));
  location.href = "/";
}

function pendingEntryCode() {
  return new URLSearchParams(location.search).get("entry_code");
}

async function enterHome() {
  connectCable();
  state.view = "home";

  const entryCode = pendingEntryCode();
  if (entryCode) {
    history.replaceState({}, "", "/");
    const joined = await joinGameByCode(entryCode);
    if (joined) return;
  }
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
  if (!msg) return;

  if (msg.type === "match") {
    if (typeof msg.game === "string" && msg.game.length > 2) {
      const game = JSON.parse(msg.game);
      if (state.game && game.id === state.game.id) applyGameUpdate(game);
    }
    if (isFirstMatch()) {
      state.finalMatchId = msg.movie_id;
    } else {
      showMatchBanner(msg.movie_id);
    }
    render();
    return;
  }

  if (msg.type !== "system") return;

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

function isEndless() {
  return state.game?.mode === "endless";
}

function isFirstMatch() {
  return state.game?.mode === "first_match";
}

function isContinuous() {
  return isEndless() || isFirstMatch();
}

function matchedIdsOf(game) {
  const lists = (game?.players || []).map((p) => p.liked_movie_ids || []);
  if (lists.length < 2) return [];
  return lists.reduce((a, b) => a.filter((id) => b.includes(id)));
}

function applyGameUpdate(game) {
  const previous = state.game;
  state.game = game;

  if (previous && game.load_more_count > previous.load_more_count && game.mode !== "endless") {
    state.finishedSent = false;
    fetchMovies();
  }

  // Endless mode: alert on matches discovered via any update path
  // (socket broadcast, poll, or another player's swipe).
  if (previous && game.mode === "endless") {
    const before = new Set(matchedIdsOf(previous));
    matchedIdsOf(game).forEach((id) => {
      if (!before.has(id)) showMatchBanner(id);
    });
    updateMatchesPill();
  }
}

// Safety net: if the websocket is down, or we're on a screen that depends on
// other players, refresh the game state by polling.
let pollInFlight = false;
setInterval(async () => {
  flushPendingSwipes();
  if (!state.game || pollInFlight) return;

  const screen = screenName();
  const socketOpen = cable?.isOpen();
  const needsLivePlayers = ["lobby", "waiting", "results"].includes(screen) ||
    (screen === "match" && isContinuous());
  if (socketOpen && !needsLivePlayers) return;

  pollInFlight = true;
  try {
    const game = await backend.findGameByEntryCode(state.game.entry_code);
    if (state.game && game.id === state.game.id) {
      applyGameUpdate(game);
      render();
    }
  } catch {
    // offline or transient error; try again on the next tick
  } finally {
    pollInFlight = false;
  }
}, 4000);

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

async function startGame(game) {
  state.game = game;
  state.movies = [];
  state.serverMessages = [];
  state.noMoreMovies = false;
  state.finishedSent = false;
  connectCable();
  cable.subscribe(gameChannelParams());
  render();

  try {
    applyGameUpdate(await backend.joinGame(game.id, state.user.id));
  } catch {
    toast("Could not join the game. Check your connection.");
  }
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

function defaultGameValues() {
  return {
    mode: "first_match",
    providers: state.user.providers || [],
    genres: [],
    languages: [],
    userScoreRange: [0, 10],
    releaseYearRange: [1980, new Date().getFullYear()],
    runtimeRange: [0, 240],
  };
}

async function createGame(values) {
  const query = buildDiscoverQuery(values);
  const game = await backend.upsertGame({
    entry_code: generateEntryCode(),
    query: JSON.stringify(query),
    user_id: state.user.id,
    providers: values.providers,
    mode: values.mode || "classic",
  });
  startGame(game);
}

async function quickPlay() {
  try {
    await createGame(defaultGameValues());
  } catch {
    toast("Something went wrong creating the game.");
  }
}

async function sendReady() {
  try {
    applyGameUpdate(await backend.ready(state.game.id, state.user.id));
    render();
    fetchMovies();
  } catch {
    toast("Could not start. Try again.");
  }
}

function likedMovieIds() {
  return loadJSON(likedIdsKey(), []);
}

async function sendFinished() {
  if (state.finishedSent) return;
  state.finishedSent = true;
  try {
    const seenIds = loadJSON(swipedIdsKey(), []);
    applyGameUpdate(await backend.finishMatching(state.game.id, state.user.id, likedMovieIds(), seenIds));
    render();
  } catch {
    state.finishedSent = false;
    toast("Couldn't send your picks — retrying…");
    setTimeout(sendFinished, 3000);
  }
}

async function keepPlaying() {
  try {
    applyGameUpdate(await backend.keepPlaying({ game_id: state.game.id, user_id: state.user.id }));
    render();
    fetchMovies();
  } catch {
    toast("Could not start another round.");
  }
}

// ---------- movies ----------

async function fetchMovies() {
  if (!state.game || state.fetchingMovies) return;
  state.fetchingMovies = true;
  render();

  try {
    const { movies: results } = await backend.gameDeck(state.game.id, state.user.id);
    const known = new Set(state.movies.map((m) => m.id));
    const swiped = new Set(loadJSON(swipedIdsKey(), []));
    let added = 0;
    results.forEach((movie) => {
      if (known.has(movie.id)) return;
      known.add(movie.id);
      state.movies.push({ ...movie, hidden: swiped.has(movie.id) });
      added += 1;
    });
    if (added === 0 && unswipedMovies().length === 0) {
      state.noMoreMovies = true;
    }
  } catch (error) {
    console.error(error);
    toast("Could not load movies.");
  } finally {
    state.fetchingMovies = false;
    render();
  }
}

// Continuous modes: report each swipe right away; queue and retry if offline.
function reportSwipe(movieId, liked) {
  backend.swipe(state.game.id, state.user.id, movieId, liked)
    .then(async (res) => {
      if (!res.matched) return;
      if (isFirstMatch()) {
        state.finalMatchId = movieId;
        try {
          applyGameUpdate(await backend.findGameByEntryCode(state.game.entry_code));
        } catch {
          // the poll or socket broadcast will deliver the finished game
        }
        render();
      } else {
        showMatchBanner(movieId);
      }
    })
    .catch(() => {
      const queue = loadJSON(storageKey("pending_swipes"), []);
      queue.push({ gameId: state.game.id, movieId, liked });
      saveJSON(storageKey("pending_swipes"), queue);
    });
}

let flushingSwipes = false;
async function flushPendingSwipes() {
  if (flushingSwipes || !state.user) return;
  const queue = loadJSON(storageKey("pending_swipes"), []);
  if (queue.length === 0) return;

  flushingSwipes = true;
  const remaining = [];
  for (const swipe of queue) {
    try {
      await backend.swipe(swipe.gameId, state.user.id, swipe.movieId, swipe.liked);
    } catch {
      remaining.push(swipe);
    }
  }
  saveJSON(storageKey("pending_swipes"), remaining);
  flushingSwipes = false;
}

function unswipedMovies() {
  return state.movies.filter((m) => !m.hidden);
}

function recordSwipe(movie, liked, { deferFinish } = {}) {
  movie.hidden = true;

  const swiped = new Set(loadJSON(swipedIdsKey(), []));
  swiped.add(movie.id);
  saveJSON(swipedIdsKey(), [...swiped]);

  if (liked) {
    const liked_ids = new Set(likedMovieIds());
    liked_ids.add(movie.id);
    saveJSON(likedIdsKey(), [...liked_ids]);
  }

  if (isContinuous()) {
    reportSwipe(movie.id, liked);
    updateDeckCounter();
    revealNextCard();
    maybeShowFunMessages();
    if (unswipedMovies().length < 6) fetchMovies();
    if (unswipedMovies().length === 0) render();
    return;
  }

  if (unswipedMovies().length === 0) {
    if (!deferFinish) {
      ignoreClicksUntil = Date.now() + 400;
      sendFinished();
      render();
    }
  } else {
    updateDeckCounter();
    revealNextCard();
  }
}

// ---------- rendering ----------

function screenName() {
  if (state.view === "login" || state.view === "reset") return state.view;
  if (!state.user?.username) return "name";
  if (!state.game) return state.view;
  if (isFirstMatch()) return state.game.finished_at ? "matchFound" : "match";
  if (isEndless()) return "match";
  const me = currentPlayer();
  if (state.game.finished_at) return "results";
  if (me?.finished_at) return "waiting";
  if (me?.ready_at) return "match";
  return "lobby";
}

function render() {
  const screen = screenName();
  document.body.classList.toggle("lock-scroll", screen === "match");
  const key = renderKeyFor(screen);
  if (key === lastRenderKey) {
    if (screen === "lobby" || screen === "waiting") updateDynamicLists(screen);
    return;
  }
  lastRenderKey = key;
  document.getElementById("movie-modal")?.setAttribute("hidden", "");

  const renderers = {
    name: renderNameScreen,
    login: renderLoginScreen,
    register: renderRegisterScreen,
    reset: renderResetScreen,
    home: renderHomeScreen,
    create: renderCreateScreen,
    history: renderHistoryScreen,
    lobby: renderLobbyScreen,
    match: renderMatchScreen,
    matchFound: renderMatchFoundScreen,
    waiting: renderWaitingScreen,
    results: renderResultsScreen,
    loading: () => {},
  };
  renderers[screen]();
}

function renderKeyFor(screen) {
  if (screen === "match") {
    if (isContinuous()) {
      const empty = unswipedMovies().length === 0;
      return `continuous-${state.game.id}-${empty}-${empty && state.fetchingMovies}-${state.noMoreMovies}`;
    }
    return `match-${state.game.id}-${state.game.load_more_count}-${state.movies.length}-${state.fetchingMovies}-${state.noMoreMovies}-${state.finishedSent}`;
  }
  if (screen === "matchFound") return `matchFound-${state.game.id}`;
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
      <button class="link" id="go-login">Already have an account? Log in</button>
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

  document.getElementById("go-login").addEventListener("click", () => {
    state.view = "login";
    render();
  });
}

// ---------- auth screens ----------

function renderLoginScreen() {
  app.innerHTML = `
    <div class="screen center">
      <img src="/logo.png" alt="WannaWatch" class="logo">
      <h1 class="headline-sm">Welcome back</h1>
      <form id="login-form" class="card form-card">
        <label for="login-email">Email</label>
        <input id="login-email" type="email" placeholder="you@example.com" required autocomplete="email">
        <label for="login-password">Password</label>
        <input id="login-password" type="password" placeholder="••••••••" required autocomplete="current-password">
        <button type="submit" class="btn btn-primary">Log in</button>
      </form>
      <button class="link" id="forgot-password">Forgot password?</button>
      <button class="link" id="back-to-name">Just play as a guest instead</button>
    </div>`;

  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      adoptUser(await backend.login(
        document.getElementById("login-email").value,
        document.getElementById("login-password").value
      ));
      toast(`Welcome back, ${state.user.username}!`);
      await enterHome();
    } catch (error) {
      toast(error.serverMessage || "Could not log in.");
    }
  });

  document.getElementById("forgot-password").addEventListener("click", async () => {
    const email = document.getElementById("login-email").value.trim() ||
      prompt("Enter your account email:")?.trim();
    if (!email) return;
    try {
      await backend.forgotPassword(email);
      toast("Check your email for a reset link.");
    } catch (error) {
      toast(error.serverMessage || "Could not send the reset email.");
    }
  });

  document.getElementById("back-to-name").addEventListener("click", () => {
    state.view = state.user?.username ? "home" : "name";
    render();
  });
}

function renderRegisterScreen() {
  app.innerHTML = `
    ${topBarHtml("")}
    <div class="screen center">
      <h1 class="headline-sm">Save your account</h1>
      <p class="muted">Keep your games and matches, and log in from any device.</p>
      <form id="register-form" class="card form-card">
        <label for="register-email">Email</label>
        <input id="register-email" type="email" placeholder="you@example.com" required autocomplete="email">
        <label for="register-password">Password <span class="muted">(8+ characters)</span></label>
        <input id="register-password" type="password" placeholder="••••••••" required minlength="8" autocomplete="new-password">
        <button type="submit" class="btn btn-primary">Create login</button>
      </form>
      <button class="link" id="back-home">Back to home</button>
    </div>`;

  bindBrandHome();
  document.getElementById("register-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      adoptUser(await backend.register({
        user_id: state.user?.id,
        username: state.user?.username,
        email: document.getElementById("register-email").value,
        password: document.getElementById("register-password").value,
      }));
      toast("Account saved — you can log in anywhere now!");
      state.view = "home";
      lastRenderKey = null;
      render();
    } catch (error) {
      toast(error.serverMessage || "Could not create the account.");
    }
  });

  document.getElementById("back-home").addEventListener("click", () => {
    state.view = "home";
    render();
  });
}

function renderResetScreen() {
  app.innerHTML = `
    <div class="screen center">
      <img src="/logo.png" alt="WannaWatch" class="logo">
      <h1 class="headline-sm">Set a new password</h1>
      <form id="reset-form" class="card form-card">
        <label for="reset-password">New password <span class="muted">(8+ characters)</span></label>
        <input id="reset-password" type="password" placeholder="••••••••" required minlength="8" autocomplete="new-password">
        <button type="submit" class="btn btn-primary">Save and log in</button>
      </form>
    </div>`;

  document.getElementById("reset-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      adoptUser(await backend.resetPassword(state.resetToken, document.getElementById("reset-password").value));
      state.resetToken = null;
      toast("Password updated!");
      await enterHome();
    } catch (error) {
      toast(error.serverMessage || "Could not reset the password.");
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
        <p class="muted">Start a game, share the code, and swipe until you all like the same movie. First match wins — that's tonight's pick.</p>
      </div>

      <button class="btn btn-primary btn-big" id="quick-play">▶ Quick play</button>
      <button class="btn btn-ghost" id="create-game">Custom game (optional filters)</button>

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

      <button class="link" id="view-history">See previous games</button>

      ${state.user.email
        ? `<p class="muted center-text">Logged in as ${esc(state.user.email)} · <button class="link inline-link" id="logout">Log out</button></p>`
        : `<section class="card account-card">
             <div>
               <strong>Playing as a guest</strong>
               <p class="muted">Create a login to keep your games and play from any device.</p>
             </div>
             <button class="btn btn-secondary" id="save-account">Create login</button>
           </section>`}
    </div>`;

  document.getElementById("quick-play").addEventListener("click", (event) => {
    event.target.disabled = true;
    quickPlay();
  });

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

  document.getElementById("view-history").addEventListener("click", () => {
    state.view = "history";
    render();
  });

  document.getElementById("save-account")?.addEventListener("click", () => {
    state.view = "register";
    render();
  });

  document.getElementById("logout")?.addEventListener("click", () => {
    if (confirm("Log out on this device?")) logout();
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
      ${game.mode === "endless" ? `<span class="endless-tag">Endless</span>` : ""}
      ${game.mode === "first_match" ? `<span class="endless-tag">First match</span>` : ""}
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
  const eraPresets = [
    { label: "Any time", from: 1950, to: currentYear },
    { label: "New", from: 2020, to: currentYear },
    { label: "2010s", from: 2010, to: 2019 },
    { label: "2000s", from: 2000, to: 2009 },
    { label: "80s & 90s", from: 1980, to: 1999 },
    { label: "Classics", from: 1950, to: 1979 },
  ];
  // One-tap bundles that set genres + rating + era underneath.
  const vibePresets = [
    { label: "Surprise me", genres: [], rating: 0, era: "Any time" },
    { label: "Date night", genres: [10749, 35, 18], rating: 6, era: "Any time" },
    { label: "Laugh out loud", genres: [35], rating: 6, era: "Any time" },
    { label: "Edge of your seat", genres: [53, 27, 9648, 80], rating: 6, era: "Any time" },
    { label: "Family night", genres: [10751, 16, 12], rating: 6, era: "Any time" },
    { label: "Critically acclaimed", genres: [], rating: 8, era: "Any time" },
    { label: "Throwback", genres: [], rating: 7, era: "80s & 90s" },
  ];
  const ratingPresets = [
    { label: "Any rating", min: 0 },
    { label: "Decent 6+", min: 6 },
    { label: "Good 7+", min: 7 },
    { label: "Great 8+", min: 8 },
  ];
  const runtimePresets = [
    { label: "Any length", min: 0, max: 400 },
    { label: "Quick · under 90 min", min: 0, max: 90 },
    { label: "Standard · under 2 hrs", min: 0, max: 120 },
    { label: "Long · 2 hrs+", min: 120, max: 400 },
  ];
  const languagePresets = [
    { label: "English", value: "en" },
    { label: "Spanish", value: "es" },
    { label: "French", value: "fr" },
    { label: "Korean", value: "ko" },
    { label: "Japanese", value: "ja" },
    { label: "German", value: "de" },
    { label: "Italian", value: "it" },
  ];

  const presetChips = (items, extra) => items.map((item, index) => `
    <button type="button" class="chip ${index === 0 ? "selected" : ""}" ${extra(item)}>${esc(item.label)}</button>
  `).join("");

  app.innerHTML = `
    ${topBarHtml("")}
    <div class="screen">
      <h1 class="headline-sm">Custom game</h1>
      <p class="muted">Pick a mode and a vibe — everything else is optional. We curate from what everyone playing has liked.</p>
      <form id="create-form">
        <section class="card form-card">
          <label>Game mode</label>
          <div class="mode-options">
            <button type="button" class="mode-option selected" data-mode="first_match">
              <strong>First match</strong>
              <span>Swipe until you all like the same movie. The first match ends the game — that's tonight's pick.</span>
            </button>
            <button type="button" class="mode-option" data-mode="endless">
              <strong>Endless</strong>
              <span>A shared list that never stops. Swipe on your own time and get alerted on every match.</span>
            </button>
            <button type="button" class="mode-option" data-mode="classic">
              <strong>Classic</strong>
              <span>Everyone swipes the same 20 movies, then compare results.</span>
            </button>
          </div>
        </section>

        <section class="card form-card">
          <label>What's the vibe?</label>
          <p class="hint">One tap sets the mood — tweak anything below after.</p>
          <div class="chips single" id="vibe-chips">
            ${vibePresets.map((v, i) => `<button type="button" class="chip ${i === 0 ? "selected" : ""}" data-vibe="${i}">${esc(v.label)}</button>`).join("")}
          </div>
        </section>

        <section class="card form-card">
          <label>Where do you watch?</label>
          <p class="hint">Leave blank for any service. We'll remember your picks.</p>
          <div class="chips" id="provider-chips">
            ${PROVIDERS.map((p) => `<button type="button" class="chip" data-value="${p.code}">${esc(p.title)}</button>`).join("")}
          </div>
        </section>

        <details class="card fine-tune">
          <summary>Fine-tune <span class="muted">(optional)</span></summary>

          <div class="form-card">
            <label>Genres</label>
            <div class="chips" id="genre-chips"><span class="muted">Loading genres…</span></div>

            <label>When was it made?</label>
            <div class="chips single" id="era-chips">
              ${presetChips(eraPresets, (item) => `data-from="${item.from}" data-to="${item.to}"`)}
            </div>

            <label>How good does it need to be?</label>
            <div class="chips single" id="rating-chips">
              ${presetChips(ratingPresets, (item) => `data-min="${item.min}"`)}
            </div>

            <label>How long is movie night?</label>
            <div class="chips single" id="runtime-chips">
              ${presetChips(runtimePresets, (item) => `data-min="${item.min}" data-max="${item.max}"`)}
            </div>

            <label>Language</label>
            <div class="chips" id="language-chips">
              ${languagePresets.map((item) => `<button type="button" class="chip" data-value="${item.value}">${esc(item.label)}</button>`).join("")}
            </div>
          </div>
        </details>

        <div class="button-row sticky-actions">
          <button type="button" class="btn btn-ghost" id="cancel-create">Back</button>
          <button type="submit" class="btn btn-primary" id="create-submit">Start swiping</button>
        </div>
      </form>
    </div>`;

  bindBrandHome();

  document.querySelectorAll(".mode-option").forEach((option) => {
    option.addEventListener("click", () => {
      document.querySelectorAll(".mode-option").forEach((el) => el.classList.remove("selected"));
      option.classList.add("selected");
    });
  });

  // A vibe bulk-sets the fine-tune chips underneath.
  let pendingVibeGenres = null;
  const applyVibe = (vibe) => {
    pendingVibeGenres = vibe.genres;
    document.querySelectorAll("#genre-chips .chip").forEach((chip) => {
      chip.classList.toggle("selected", vibe.genres.includes(Number(chip.dataset.value)));
    });
    document.querySelectorAll("#rating-chips .chip").forEach((chip) => {
      chip.classList.toggle("selected", Number(chip.dataset.min) === vibe.rating);
    });
    document.querySelectorAll("#era-chips .chip").forEach((chip) => {
      chip.classList.toggle("selected", chip.textContent.trim() === vibe.era);
    });
  };

  document.getElementById("vibe-chips").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    document.querySelectorAll("#vibe-chips .chip").forEach((el) => el.classList.remove("selected"));
    chip.classList.add("selected");
    applyVibe(vibePresets[Number(chip.dataset.vibe)]);
  });

  const toggleMulti = (containerId) => {
    document.getElementById(containerId).addEventListener("click", (event) => {
      event.target.closest(".chip")?.classList.toggle("selected");
    });
  };
  const selectOne = (containerId) => {
    document.getElementById(containerId).addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (!chip) return;
      document.querySelectorAll(`#${containerId} .chip`).forEach((el) => el.classList.remove("selected"));
      chip.classList.add("selected");
    });
  };

  toggleMulti("provider-chips");
  toggleMulti("genre-chips");
  toggleMulti("language-chips");
  selectOne("era-chips");
  selectOne("rating-chips");
  selectOne("runtime-chips");

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
    const era = document.querySelector("#era-chips .chip.selected");
    const rating = document.querySelector("#rating-chips .chip.selected");
    const runtime = document.querySelector("#runtime-chips .chip.selected");

    const values = {
      mode: document.querySelector(".mode-option.selected")?.dataset.mode || "first_match",
      providers: selected("provider-chips"),
      genres: selected("genre-chips"),
      languages: selected("language-chips"),
      userScoreRange: [Number(rating?.dataset.min || 0), 10],
      releaseYearRange: [Number(era?.dataset.from || 1950), Number(era?.dataset.to || currentYear)],
      runtimeRange: [Number(runtime?.dataset.min || 0), Number(runtime?.dataset.max || 400)],
    };

    const submit = document.getElementById("create-submit");
    submit.disabled = true;
    try {
      await createGame(values);
    } catch {
      submit.disabled = false;
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
      if (pendingVibeGenres?.length) {
        chipContainer.querySelectorAll(".chip").forEach((chip) => {
          chip.classList.toggle("selected", pendingVibeGenres.includes(Number(chip.dataset.value)));
        });
      }
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
  });

  document.getElementById("leave-game").addEventListener("click", leaveGame);
}

// ---------- movie details ----------

function formatVoteCount(count) {
  if (!count) return "";
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k ratings`;
  return `${count} ratings`;
}

function trailerKey(movie) {
  const videos = movie.videos?.results || [];
  const trailer = videos.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official)
    || videos.find((v) => v.site === "YouTube" && v.type === "Trailer")
    || videos.find((v) => v.site === "YouTube");
  return trailer?.key || null;
}

function watchProviders(movie) {
  const groups = movie["watch/providers"]?.results?.US || {};
  const seen = new Set();
  return ["flatrate", "ads", "rent", "buy"].flatMap((kind) =>
    (groups[kind] || []).filter((provider) => {
      if (seen.has(provider.provider_id)) return false;
      seen.add(provider.provider_id);
      return true;
    }).map((provider) => ({ ...provider, kind }))
  );
}

function movieDetailsHtml(movie, { compact = false } = {}) {
  const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
  const runtime = movie.runtime ? `${movie.runtime} min` : "";
  const genres = (movie.genres || []).map((g) => g.name).join(" · ");
  const rating = movie.vote_average ? movie.vote_average.toFixed(1) : "–";
  const votes = formatVoteCount(movie.vote_count);
  const trailer = trailerKey(movie);
  const providers = watchProviders(movie);
  const cast = (movie.credits?.cast || []).slice(0, compact ? 4 : 6);
  const reviews = (movie.reviews?.results || []).slice(0, compact ? 1 : 2);

  return `
    <div class="details-block">
      <h3>${esc(movie.title)} <span class="muted">${year}</span></h3>
      <p class="rating">★ ${rating} / 10 ${votes ? `<span class="muted">· ${esc(votes)}</span>` : ""}</p>
      <p class="meta-line">${[runtime, genres].filter(Boolean).map(esc).join(" · ")}</p>
      <p class="overview">${esc(movie.overview || "No description available.")}</p>
    </div>
    ${providers.length ? `
      <div class="details-block">
        <h4>Where to watch</h4>
        <div class="provider-row">
          ${providers.slice(0, 8).map((p) => `
            <div class="provider-logo" title="${esc(p.provider_name)} (${p.kind === "flatrate" ? "stream" : p.kind})">
              ${p.logo_path
                ? `<img src="${posterUrl(p.logo_path, "w92")}" alt="${esc(p.provider_name)}">`
                : esc(p.provider_name)}
            </div>`).join("")}
        </div>
        <p class="hint">Streaming data from JustWatch via TMDB.</p>
      </div>` : ""}
    ${cast.length ? `
      <div class="details-block">
        <h4>Cast</h4>
        <div class="cast-row">
          ${cast.map((person) => `
            <div class="cast-card">
              ${profileUrl(person.profile_path)
                ? `<img src="${profileUrl(person.profile_path)}" alt="${esc(person.name)}">`
                : `<div class="cast-placeholder">${esc((person.name || "?").slice(0, 1))}</div>`}
              <strong>${esc(person.name)}</strong>
              <span class="muted">${esc(person.character || "")}</span>
            </div>`).join("")}
        </div>
      </div>` : ""}
    ${trailer ? `
      <div class="details-block">
        <button type="button" class="btn btn-secondary trailer-btn" data-trailer="${esc(trailer)}">▶ Watch trailer</button>
        <div class="trailer-frame" hidden></div>
      </div>` : ""}
    ${reviews.length ? `
      <div class="details-block">
        <h4>Reviews</h4>
        ${reviews.map((review) => {
          const body = review.content.length > 280 ? `${review.content.slice(0, 280).trim()}…` : review.content;
          return `<blockquote class="review"><p>${esc(body)}</p><cite>— ${esc(review.author)}</cite></blockquote>`;
        }).join("")}
      </div>` : ""}`;
}

function showTrailer(button) {
  const frame = button.parentElement.querySelector(".trailer-frame");
  if (!frame || !frame.hidden) return;
  frame.hidden = false;
  frame.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${button.dataset.trailer}?rel=0" title="Trailer" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  button.hidden = true;
}

function bindTrailerButtons(root) {
  root.querySelectorAll("[data-trailer]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showTrailer(button);
    });
  });
}

function toggleCardFlip(card, movie, target) {
  const trailerBtn = target.closest?.("[data-trailer]");
  if (trailerBtn) {
    showTrailer(trailerBtn);
    return;
  }
  if (card.classList.contains("flipped")) {
    if (target.closest?.(".trailer-frame, iframe, a")) return;
    card.classList.remove("flipped");
    return;
  }
  card.classList.add("flipped");
  fillCardDetails(card, movie);
}

async function fillCardDetails(card, movie) {
  const panel = card.querySelector(".card-details");
  if (!panel || panel.dataset.loaded === "1") return;
  panel.innerHTML = `<p class="muted">Loading details…</p>`;
  const details = await fetchMovieSummary(movie.id);
  if (!panel.isConnected) return;
  if (!details) {
    panel.innerHTML = `<p class="overview">${esc(movie.overview || "No description available.")}</p><button type="button" class="link" data-flip-back>Tap to flip back</button>`;
    return;
  }
  panel.innerHTML = `${movieDetailsHtml(details, { compact: true })}<button type="button" class="link" data-flip-back>Flip back</button>`;
  panel.dataset.loaded = "1";
  bindTrailerButtons(panel);
}

async function openMovieModal(movieId) {
  let overlay = document.getElementById("movie-modal");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "movie-modal";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div class="modal-sheet"><p class="muted">Loading…</p></div>`;
  overlay.hidden = false;

  const close = () => { overlay.hidden = true; overlay.innerHTML = ""; };
  overlay.addEventListener("pointerup", (event) => {
    if (event.target === overlay) close();
  }, { once: true });

  const movie = await fetchMovieSummary(movieId);
  if (!overlay.isConnected || overlay.hidden) return;
  if (!movie) {
    overlay.innerHTML = `<div class="modal-sheet"><p>Couldn't load that movie.</p><button class="btn btn-ghost" id="modal-close">Close</button></div>`;
    overlay.querySelector("#modal-close").addEventListener("click", close);
    return;
  }

  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-header">
        <button class="link" id="modal-close">Close</button>
      </div>
      ${movie.poster_path ? `<img class="modal-poster" src="${posterUrl(movie.poster_path, "w342")}" alt="${esc(movie.title)}">` : ""}
      ${movieDetailsHtml(movie)}
    </div>`;
  overlay.querySelector("#modal-close").addEventListener("click", close);
  bindTrailerButtons(overlay);
}

function bindResultCards(root) {
  root.querySelectorAll(".result-card[data-id]").forEach((card) => {
    card.addEventListener("click", () => openMovieModal(Number(card.dataset.id)));
  });
}

const shownMatchBanners = new Set();

async function showMatchBanner(movieId) {
  if (shownMatchBanners.has(movieId)) return;
  shownMatchBanners.add(movieId);
  updateMatchesPill();

  let banner = document.getElementById("match-banner");
  if (!banner) {
    banner = document.createElement("button");
    banner.id = "match-banner";
    banner.className = "match-banner";
    document.body.appendChild(banner);
  }

  const movie = await fetchMovieSummary(movieId);
  const title = movie?.title || "a movie";
  banner.innerHTML = `
    ${movie?.poster_path ? `<img src="${posterUrl(movie.poster_path, "w92")}" alt="">` : ""}
    <span><strong>It's a match! 🎉</strong><br>Everyone liked ${esc(title)}</span>`;
  banner.hidden = false;
  banner.onclick = () => {
    banner.hidden = true;
    openMovieModal(movieId);
  };
  clearTimeout(showMatchBanner.timer);
  showMatchBanner.timer = setTimeout(() => { banner.hidden = true; }, 6000);
}

function updateMatchesPill() {
  const pill = document.getElementById("matches-pill");
  if (pill && state.game) pill.textContent = `♥ ${matchedIdsOf(state.game).length} matches`;
}

async function showMatchesModal() {
  const ids = matchedIdsOf(state.game);
  let overlay = document.getElementById("movie-modal");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "movie-modal";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
  }
  overlay.hidden = false;

  const close = () => { overlay.hidden = true; overlay.innerHTML = ""; };
  overlay.addEventListener("pointerup", (event) => {
    if (event.target === overlay) close();
  }, { once: true });

  if (ids.length === 0) {
    overlay.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header"><button class="link" id="modal-close">Close</button></div>
        <h3>No matches yet</h3>
        <p class="muted">Keep swiping — you'll both get an alert the moment you like the same movie.</p>
      </div>`;
    overlay.querySelector("#modal-close").addEventListener("click", close);
    return;
  }

  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-header">
        <h3 style="margin:0">Your matches (${ids.length})</h3>
        <button class="link" id="modal-close">Close</button>
      </div>
      <div class="results-grid" id="matches-grid"><p class="muted">Loading…</p></div>
    </div>`;
  overlay.querySelector("#modal-close").addEventListener("click", close);

  const cards = await Promise.all(ids.slice(0, 60).map(async (id) => {
    const movie = await fetchMovieSummary(id);
    if (!movie) return "";
    const poster = posterUrl(movie.poster_path, "w342");
    return `
      <button type="button" class="result-card" data-id="${id}">
        ${poster ? `<img src="${poster}" alt="${esc(movie.title)}">` : `<div class="poster-missing">${esc(movie.title)}</div>`}
        <div class="result-info"><strong>${esc(movie.title)}</strong></div>
      </button>`;
  }));

  const grid = overlay.querySelector("#matches-grid");
  if (grid) {
    grid.innerHTML = cards.join("");
    grid.querySelectorAll(".result-card[data-id]").forEach((card) => {
      card.addEventListener("click", () => {
        close();
        openMovieModal(Number(card.dataset.id));
      });
    });
  }
}

function renderMatchScreen() {
  if (isContinuous()) return renderContinuousMatchScreen();

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
  buildDeckDom();
  attachDeckGestures(document.getElementById("deck"));

  document.getElementById("nope-button").addEventListener("click", () => swipeTopCard(false));
  document.getElementById("like-button").addEventListener("click", () => swipeTopCard(true));
}

function renderContinuousMatchScreen() {
  if (state.movies.length === 0 && !state.fetchingMovies && !state.noMoreMovies) {
    fetchMovies();
  }

  if (state.noMoreMovies && unswipedMovies().length === 0) {
    app.innerHTML = `
      ${topBarHtml(`<span class="code-pill">${esc(state.game.entry_code)}</span>`)}
      <div class="screen center">
        <h1 class="headline-sm">You've swiped everything we could find</h1>
        <p class="muted">${isEndless()
          ? "Check your matches, or start a new game with different filters for a fresh well."
          : "No match yet — start a new game with looser filters and try again."}</p>
        ${isEndless() ? `<button class="btn btn-primary" id="view-matches">♥ View matches</button>` : ""}
        <button class="btn ${isEndless() ? "btn-ghost" : "btn-primary"}" id="back-home">Home</button>
      </div>`;
    bindBrandHome();
    document.getElementById("view-matches")?.addEventListener("click", showMatchesModal);
    document.getElementById("back-home").addEventListener("click", leaveGame);
    return;
  }

  if (unswipedMovies().length === 0) {
    app.innerHTML = `
      ${topBarHtml(`<span class="code-pill">${esc(state.game.entry_code)}</span>`)}
      <div class="screen center">
        <div class="spinner"></div>
        <p class="muted">Finding movies…</p>
      </div>`;
    bindBrandHome();
    return;
  }

  app.innerHTML = `
    ${topBarHtml(`<span class="code-pill">${esc(state.game.entry_code)}</span>`)}
    <div class="screen match-layout">
      <div class="deck-meta">
        ${isEndless()
          ? `<button type="button" class="meta-pill" id="matches-pill">♥ ${matchedIdsOf(state.game).length} matches</button>
             <span class="endless-tag">Endless</span>`
          : `<span id="deck-counter" class="muted"></span>
             <span class="endless-tag">First match wins</span>`}
        <button type="button" class="meta-pill" id="invite-pill">+ Invite</button>
      </div>
      <div class="deck" id="deck"></div>
      <div class="swipe-actions">
        <button class="action-btn nope" id="nope-button" aria-label="Nope">✕</button>
        <button class="action-btn like" id="like-button" aria-label="Like">♥</button>
      </div>
    </div>`;

  bindBrandHome();
  buildDeckDom();
  attachDeckGestures(document.getElementById("deck"));

  document.getElementById("matches-pill")?.addEventListener("click", showMatchesModal);
  document.getElementById("invite-pill").addEventListener("click", async () => {
    await navigator.clipboard.writeText(shareLink());
    toast("Invite link copied — anyone can join and swipe on their own time!");
  });
  document.getElementById("nope-button").addEventListener("click", () => swipeTopCard(false));
  document.getElementById("like-button").addEventListener("click", () => swipeTopCard(true));
}

// ---------- first-match celebration ----------

async function renderMatchFoundScreen() {
  const matchId = state.finalMatchId || matchedIdsOf(state.game)[0];

  const confetti = Array.from({ length: 36 }, () => {
    const left = Math.random() * 100;
    const delay = Math.random() * 2.2;
    const duration = 2.6 + Math.random() * 2;
    const color = ["#ff5757", "#3ec6ff", "#2ecc71", "#f5c518", "#b98cff"][Math.floor(Math.random() * 5)];
    const size = 7 + Math.random() * 7;
    return `<span class="confetti" style="left:${left}vw;background:${color};width:${size}px;height:${size * 1.4}px;animation-delay:${delay}s;animation-duration:${duration}s"></span>`;
  }).join("");

  app.innerHTML = `
    <div class="confetti-layer">${confetti}</div>
    ${topBarHtml(`<span class="code-pill">${esc(state.game.entry_code)}</span>`)}
    <div class="screen center">
      <h1 class="headline">It's a match! 🎉</h1>
      <p class="muted">Everyone agreed — tonight you're watching:</p>
      <div class="final-movie" id="final-movie"><div class="spinner"></div></div>
      <div class="button-row full-width">
        <button class="btn btn-secondary" id="final-details">Details</button>
        <button class="btn btn-primary" id="play-again">Play again</button>
      </div>
      <button class="link" id="back-home">Back to home</button>
    </div>`;

  bindBrandHome();
  document.getElementById("final-details").addEventListener("click", () => matchId && openMovieModal(matchId));
  document.getElementById("play-again").addEventListener("click", (event) => {
    event.target.disabled = true;
    quickPlay();
  });
  document.getElementById("back-home").addEventListener("click", leaveGame);

  if (!matchId) return;
  const movie = await fetchMovieSummary(matchId);
  const el = document.getElementById("final-movie");
  if (!el || !movie) return;
  const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
  el.innerHTML = `
    ${movie.poster_path ? `<img src="${posterUrl(movie.poster_path, "w342")}" alt="${esc(movie.title)}">` : ""}
    <strong>${esc(movie.title)}</strong>
    <span class="muted">${year} · ★ ${movie.vote_average ? movie.vote_average.toFixed(1) : "–"}</span>`;
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

function buildDeckDom() {
  const deck = document.getElementById("deck");
  if (!deck) return;
  deck.innerHTML = unswipedMovies().slice(0, 3).map(movieCardHtml).reverse().join("");
  updateDeckCounter();
}

function updateDeckCounter() {
  const counter = document.getElementById("deck-counter");
  if (!counter) return;
  if (isContinuous()) {
    const swipedCount = loadJSON(swipedIdsKey(), []).length;
    counter.textContent = `${swipedCount} swiped`;
    return;
  }
  const count = unswipedMovies().length;
  counter.textContent = `${count} movie${count === 1 ? "" : "s"} left`;
}

// ---------- playful progress messages ----------

const MILESTONE_MESSAGES = {
  15: "15 swipes in — the perfect movie is playing hard to get.",
  30: "30 swipes! Somewhere out there, a movie is waiting to be loved.",
  50: "50 deep. True love takes time.",
  75: "75 swipes — picky crew. Respect.",
  100: "100 swipes! This is dedication.",
  150: "150?! Your movie better show up soon…",
  200: "200 swipes. At this point, watch them all.",
};

const shownFunMessages = new Set();

function showFunBanner(message) {
  let banner = document.getElementById("fun-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "fun-banner";
    banner.className = "match-banner fun-banner";
    document.body.appendChild(banner);
  }
  banner.innerHTML = `<span>${esc(message)}</span>`;
  banner.hidden = false;
  clearTimeout(showFunBanner.timer);
  showFunBanner.timer = setTimeout(() => { banner.hidden = true; }, 4000);
}

function wiggleDeck() {
  const deck = document.getElementById("deck");
  if (!deck) return;
  deck.classList.add("wiggle");
  setTimeout(() => deck.classList.remove("wiggle"), 900);
}

function maybeShowFunMessages() {
  if (state.game?.finished_at) return;
  const myCount = loadJSON(swipedIdsKey(), []).length;

  if (MILESTONE_MESSAGES[myCount] && !shownFunMessages.has(`m${myCount}`)) {
    shownFunMessages.add(`m${myCount}`);
    showFunBanner(MILESTONE_MESSAGES[myCount]);
    wiggleDeck();
    return;
  }

  if (myCount % 10 === 0) maybeShowPositionMessage(myCount);
}

// Playful nudges about where you are in the shared list vs. everyone else.
function maybeShowPositionMessage(localCount) {
  const others = (state.game?.players || []).filter((p) => p.user?.id !== state.user.id);
  if (others.length === 0) return;

  const me = currentPlayer();
  const myCount = Math.max(localCount, me?.seen_movie_ids?.length || 0);
  const leader = others.reduce((a, b) =>
    (b.seen_movie_ids?.length || 0) > (a.seen_movie_ids?.length || 0) ? b : a
  );
  const theirCount = leader.seen_movie_ids?.length || 0;
  const name = leader.user?.username || "Your friend";
  const diff = myCount - theirCount;

  let key = null;
  let message = null;
  if (diff >= 25) {
    key = "ahead25";
    message = `You're ${diff} movies ahead of ${name}. Save some popcorn for the rest of us!`;
  } else if (diff >= 10) {
    key = "ahead10";
    message = `${diff} ahead of ${name} — someone's excited for movie night!`;
  } else if (diff <= -25) {
    key = "behind25";
    message = `${name} is ${-diff} movies ahead. They mean business — time to catch up!`;
  } else if (diff <= -10) {
    key = "behind10";
    message = `${name} is ${-diff} swipes ahead of you. Chase 'em down!`;
  }

  if (key && !shownFunMessages.has(`p${key}`)) {
    shownFunMessages.add(`p${key}`);
    showFunBanner(message);
    wiggleDeck();
  }
}

function topCardEl(deck) {
  const cards = deck.querySelectorAll(".movie-card:not(.flying)");
  return cards[cards.length - 1] || null;
}

function movieForCard(card) {
  return state.movies.find((m) => m.id === Number(card.dataset.id));
}

// Adds the next queued card underneath the visible stack, so swipes never
// rebuild the deck DOM mid-animation.
function revealNextCard() {
  const deck = document.getElementById("deck");
  if (!deck) return;
  const visibleIds = new Set(
    [...deck.querySelectorAll(".movie-card:not(.flying)")].map((c) => Number(c.dataset.id))
  );
  const next = unswipedMovies().slice(0, 3).find((m) => !visibleIds.has(m.id));
  if (next) deck.insertAdjacentHTML("afterbegin", movieCardHtml(next));
}

function swipeThreshold() {
  return Math.min(120, window.innerWidth * 0.28);
}

// Pointer-drag gestures on the whole deck area (not just the card), so a
// swipe started anywhere on the play area moves the top card. The deck has
// touch-action: none, so the browser never turns the gesture into a scroll.
function attachDeckGestures(deck) {
  let card = null;
  let movie = null;
  let stamps = null;
  let startX = 0;
  let startY = 0;
  let deltaX = 0;
  let dragging = false;
  let moved = false;
  let samples = [];

  deck.addEventListener("pointerdown", (event) => {
    card = topCardEl(deck);
    if (!card) return;
    movie = movieForCard(card);
    stamps = {
      like: card.querySelector(".stamp-like"),
      nope: card.querySelector(".stamp-nope"),
    };
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    deltaX = 0;
    samples = [{ x: event.clientX, t: event.timeStamp }];
    deck.setPointerCapture(event.pointerId);
    card.classList.add("dragging");
  });

  deck.addEventListener("pointermove", (event) => {
    if (!dragging || !card) return;
    deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    samples.push({ x: event.clientX, t: event.timeStamp });
    if (samples.length > 6) samples.shift();
    if (Math.abs(deltaX) > 6 || Math.abs(deltaY) > 6) moved = true;

    const rotation = (deltaX / window.innerWidth) * 18;
    card.style.transform = `translate(${deltaX}px, ${deltaY * 0.15}px) rotate(${rotation}deg)`;
    stamps.like.style.opacity = deltaX > 0 ? Math.min(1, deltaX / swipeThreshold()) : 0;
    stamps.nope.style.opacity = deltaX < 0 ? Math.min(1, -deltaX / swipeThreshold()) : 0;
  });

  const release = (event) => {
    if (!dragging || !card) return;
    dragging = false;
    card.classList.remove("dragging");

    // px/ms over the last few pointer samples; a quick flick counts even if
    // the card didn't travel the full threshold distance.
    const first = samples[0];
    const last = samples[samples.length - 1];
    const velocity = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
    const flicked = Math.abs(velocity) > 0.6 && Math.abs(deltaX) > 30 &&
      Math.sign(velocity) === Math.sign(deltaX);

    if (Math.abs(deltaX) > swipeThreshold() || flicked) {
      flyOut(card, deltaX > 0, movie);
    } else {
      card.style.transform = "";
      stamps.like.style.opacity = 0;
      stamps.nope.style.opacity = 0;
      if (!moved && event.type === "pointerup") {
        const hit = document.elementFromPoint(event.clientX, event.clientY) || event.target;
        toggleCardFlip(card, movie, hit.nodeType === 1 ? hit : hit.parentElement);
      }
    }
    card = null;
    movie = null;
    deltaX = 0;
  };

  deck.addEventListener("pointerup", release);
  deck.addEventListener("pointercancel", release);
}

function flyOut(card, liked, movie) {
  const lastCard = !isContinuous() && unswipedMovies().length <= 1;
  const exitX = (liked ? 1 : -1) * Math.max(window.innerWidth, 480);
  card.classList.add("flying");
  card.style.transform = `translate(${exitX}px, -30px) rotate(${liked ? 30 : -30}deg)`;
  card.querySelector(liked ? ".stamp-like" : ".stamp-nope").style.opacity = 1;
  recordSwipe(movie, liked, { deferFinish: lastCard });
  setTimeout(() => {
    card.remove();
    if (lastCard) {
      sendFinished();
      ignoreClicksUntil = Date.now() + 250;
      render();
    }
  }, 350);
}

function swipeTopCard(liked) {
  const deck = document.getElementById("deck");
  if (!deck) return;
  const card = topCardEl(deck);
  if (!card) return;
  flyOut(card, liked, movieForCard(card));
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
  onTap(document.getElementById("keep-playing"), keepPlaying);
  onTap(document.getElementById("go-home"), leaveGame);

  const grid = document.getElementById("results-grid");
  if (matchedIds.length === 0) return;

  const localMovies = new Map(state.movies.map((m) => [m.id, m]));
  const cards = await Promise.all(matchedIds.slice(0, 30).map(async (id) => {
    const movie = localMovies.get(id) || (await fetchMovieSummary(id));
    if (!movie) return "";
    const poster = posterUrl(movie.poster_path, "w342");
    const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
    return `
      <button type="button" class="result-card" data-id="${id}">
        ${poster ? `<img src="${poster}" alt="${esc(movie.title)}">` : `<div class="poster-missing">${esc(movie.title)}</div>`}
        <div class="result-info">
          <strong>${esc(movie.title)}</strong>
          <span class="muted">${year} · ★ ${movie.vote_average ? movie.vote_average.toFixed(1) : "–"}</span>
        </div>
      </button>`;
  }));

  if (grid.isConnected) {
    grid.innerHTML = cards.join("");
    bindResultCards(grid);
  }
}

// ---------- previous games ----------

const movieSummaryCache = new Map();

async function fetchMovieSummary(id) {
  if (movieSummaryCache.has(id)) return movieSummaryCache.get(id);
  try {
    const movie = await tmdb.movie(id);
    movieSummaryCache.set(id, movie);
    return movie;
  } catch {
    movieSummaryCache.set(id, null);
    return null;
  }
}

function matchedIdsFor(game) {
  const lists = (game.players || []).map((p) => p.liked_movie_ids || []);
  return lists.length ? lists.reduce((a, b) => a.filter((id) => b.includes(id))) : [];
}

async function renderHistoryScreen() {
  app.innerHTML = `
    ${topBarHtml("")}
    <div class="screen">
      <h1 class="headline-sm">Previous games</h1>
      <p class="muted">Tap a game to see what everyone matched on — or flip to see all likes.</p>
      <div id="history-content"><p class="muted">Loading…</p></div>
      <button class="link" id="back-home">Back to home</button>
    </div>`;

  bindBrandHome();
  document.getElementById("back-home").addEventListener("click", () => {
    state.view = "home";
    render();
  });

  let games = [];
  try {
    games = await backend.previousGames(state.user.id);
  } catch {
    // shows the empty state below
  }

  const container = document.getElementById("history-content");
  if (!container) return;

  if (games.length === 0) {
    container.innerHTML = `<p class="muted">No finished games yet — play one first!</p>`;
    return;
  }
  renderHistoryList(container, games);
}

function renderHistoryList(container, games) {
  container.innerHTML = games.map((game) => {
    const date = game.finished_at
      ? new Date(game.finished_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "";
    const names = game.players.map((p) => esc(p.user?.username)).join(", ");
    const solo = game.players.length === 1;
    const count = matchedIdsFor(game).length;
    const label = solo
      ? `${count} like${count === 1 ? "" : "s"}`
      : `${count} match${count === 1 ? "" : "es"}`;
    return `
      <button class="game-row" data-id="${game.id}">
        <span class="game-code">${esc(game.entry_code)}</span>
        <span class="game-players">${names}</span>
        <span class="match-badge">${label}</span>
        <span class="muted">${date}</span>
      </button>`;
  }).join("");

  container.querySelectorAll(".game-row").forEach((row) => {
    row.addEventListener("click", () => {
      const game = games.find((g) => g.id === Number(row.dataset.id));
      renderHistoryDetail(container, games, game, "matches");
    });
  });
}

async function renderHistoryDetail(container, games, game, tab) {
  const matchedIds = matchedIdsFor(game);
  const playerCount = game.players.length;

  const likersByMovie = new Map();
  game.players.forEach((player) => {
    (player.liked_movie_ids || []).forEach((id) => {
      if (!likersByMovie.has(id)) likersByMovie.set(id, []);
      likersByMovie.get(id).push(player.user?.username || "Someone");
    });
  });
  const allLikedIds = [...likersByMovie.keys()]
    .sort((a, b) => likersByMovie.get(b).length - likersByMovie.get(a).length);

  const ids = tab === "matches" ? matchedIds : allLikedIds;

  container.innerHTML = `
    <div class="history-header">
      <button class="link" id="history-back">← All games</button>
      <span class="code-pill">${esc(game.entry_code)}</span>
    </div>
    <p class="muted">Played by ${game.players.map((p) => esc(p.user?.username)).join(", ")}</p>
    <div class="tab-row">
      <button class="tab ${tab === "matches" ? "active" : ""}" data-tab="matches">
        ${playerCount === 1 ? "Likes" : "Matches"} (${matchedIds.length})
      </button>
      <button class="tab ${tab === "all" ? "active" : ""}" data-tab="all">All likes (${allLikedIds.length})</button>
    </div>
    <div id="history-grid" class="results-grid">${ids.length ? `<p class="muted">Loading movies…</p>` : ""}</div>`;

  document.getElementById("history-back").addEventListener("click", () => renderHistoryList(container, games));
  container.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => renderHistoryDetail(container, games, game, button.dataset.tab));
  });

  const grid = document.getElementById("history-grid");
  if (ids.length === 0) {
    grid.outerHTML = `<p class="muted">${tab === "matches" && playerCount > 1
      ? "No matches in this game."
      : "No likes in this game."}</p>`;
    return;
  }

  const cards = await Promise.all(ids.slice(0, 30).map(async (id) => {
    const movie = await fetchMovieSummary(id);
    if (!movie) return "";
    const likers = likersByMovie.get(id) || [];
    const everyone = playerCount > 1 && likers.length === playerCount;
    const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
    const subtitle = tab === "all"
      ? (everyone ? "⭐ Everyone liked this" : `Liked by ${likers.map(esc).join(", ")}`)
      : `${year} · ★ ${movie.vote_average ? movie.vote_average.toFixed(1) : "–"}`;
    const poster = posterUrl(movie.poster_path, "w342");
    return `
      <button type="button" class="result-card" data-id="${id}">
        ${poster ? `<img src="${poster}" alt="${esc(movie.title)}">` : `<div class="poster-missing">${esc(movie.title)}</div>`}
        <div class="result-info">
          <strong>${esc(movie.title)}</strong>
          <span class="muted">${subtitle}</span>
        </div>
      </button>`;
  }));

  if (grid.isConnected) {
    grid.innerHTML = cards.join("");
    bindResultCards(grid);
  }
}

boot();
