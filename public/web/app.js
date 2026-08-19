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
  invites: [],
  noMoreMovies: false,
  finishedSent: false,
  fetchingMovies: false,
  lastSwipe: null,      // one-level undo: { movie, liked }
  finalMatchKey: null,
  libraryTab: "matches", // matches | likes | friends
  libraryFriendId: null,
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

function titleKey(movieOrId, mediaType) {
  if (movieOrId && typeof movieOrId === "object") {
    return mediaKey(movieOrId.id, movieOrId.media_type || mediaType || "movie");
  }
  return mediaKey(movieOrId, mediaType || "movie");
}

function isGuest() {
  return Boolean(state.user) && !state.user.email;
}

function accountNudgeHtml(context = "home") {
  if (!isGuest()) return "";
  const copy = {
    home: "Friends, invites, and history stick better with an account — guests can still play.",
    history: "Create a login so liked movies and matches stay with you on any device.",
    lobby: "Accounts make friend invites easier. Guests can keep swiping.",
  };
  return `
    <section class="card account-card account-nudge">
      <div>
        <strong>Playing as a guest</strong>
        <p class="muted">${copy[context] || copy.home}</p>
      </div>
      <button type="button" class="btn btn-secondary" data-save-account>Create login</button>
    </section>`;
}

function bindAccountNudge(root = document) {
  root.querySelectorAll("[data-save-account]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.game && !confirm("Leave this game to create a login?")) return;
      if (state.game) {
        cable?.unsubscribe(gameChannelParams());
        state.game = null;
        state.movies = [];
      }
      state.view = "register";
      render();
    });
  });
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

  if (await handleShopReturn()) {
    if (state.user?.username) {
      connectCable();
      cable?.subscribe({ channel: "UserGamesChannel" });
    } else {
      state.view = "name";
    }
    render();
    return;
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
  refreshFriendsAndInvites();
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

async function refreshFriendsAndInvites() {
  if (!state.user) return;
  try {
    const [friends, invites] = await Promise.all([
      backend.friends(state.user.id),
      backend.gameInvites(state.user.id),
    ]);
    state.friends = friends.filter((f) => f.id !== state.user.id);
    state.invites = invites;
  } catch {
    state.friends = [];
    state.invites = [];
  }
  renderFriendsList();
  renderIncomingInvites();
  maybeShowInvitePopup();
}

function incomingInvites() {
  return state.invites.filter((i) => i.status === "pending" && i.invitee?.id === state.user?.id);
}

function outgoingInvitesForGame(gameId) {
  return state.invites.filter(
    (i) => i.status === "pending" && i.inviter?.id === state.user?.id && i.game_id === gameId
  );
}

function upsertInvite(invite) {
  if (!invite?.id) return;
  const index = state.invites.findIndex((i) => i.id === invite.id);
  if (invite.status === "pending") {
    if (index >= 0) state.invites[index] = invite;
    else state.invites.unshift(invite);
  } else if (index >= 0) {
    state.invites.splice(index, 1);
  }
  hideInvitePopupIfStale(invite);
}

function hideInvitePopupIfStale(invite) {
  const popup = document.getElementById("invite-popup");
  if (!popup || popup.hidden) return;
  if (Number(popup.dataset.inviteId) === invite.id && invite.status !== "pending") {
    hideInvitePopup();
  }
}

function maybeShowInvitePopup() {
  const popup = document.getElementById("invite-popup");
  if (popup && !popup.hidden) return;
  const next = incomingInvites()[0];
  if (next) showInvitePopup(next);
}

function showInvitePopup(invite) {
  const popup = document.getElementById("invite-popup");
  if (!popup || !invite) return;
  popup.dataset.inviteId = invite.id;
  popup.hidden = false;
  popup.querySelector(".invite-popup-text").textContent =
    `${invite.inviter?.username || "Someone"} invited you to play (${invite.entry_code})`;
}

function hideInvitePopup() {
  const popup = document.getElementById("invite-popup");
  if (!popup) return;
  popup.hidden = true;
  delete popup.dataset.inviteId;
}

async function acceptInvite(inviteId) {
  try {
    const invite = await backend.acceptGameInvite(inviteId, state.user.id);
    upsertInvite(invite);
    hideInvitePopup();
    if (invite.game) startGame(invite.game);
    else await joinGameByCode(invite.entry_code);
    maybeShowInvitePopup();
  } catch {
    toast("Couldn't accept that invite.");
  }
}

async function declineInvite(inviteId) {
  try {
    const invite = await backend.declineGameInvite(inviteId, state.user.id);
    upsertInvite(invite);
    hideInvitePopup();
    renderIncomingInvites();
    maybeShowInvitePopup();
  } catch {
    toast("Couldn't decline that invite.");
  }
}

async function inviteFriendToGame(friendId, gameId) {
  try {
    const invite = await backend.createGameInvite({
      inviterId: state.user.id,
      inviteeId: friendId,
      gameId,
    });
    upsertInvite(invite);
    toast("Invite sent!");
    renderLobbyInvites();
    renderFriendsList();
    return invite;
  } catch (error) {
    toast(error.serverMessage || "Couldn't send invite.");
    return null;
  }
}

async function startGameWithFriend(friendId) {
  try {
    const query = buildDiscoverQuery(defaultGameValues());
    const game = await backend.upsertGame({
      entry_code: generateEntryCode(),
      query: JSON.stringify(query),
      user_id: state.user.id,
      providers: state.user.providers || [],
      mode: "first_match",
    });
    await inviteFriendToGame(friendId, game.id);
    startGame(game);
  } catch {
    toast("Couldn't start a game with that friend.");
  }
}

// ---------- socket ----------

function gameChannelParams() {
  return { channel: "GameChannel", game_id: state.game.id };
}

function handleSocketMessage(data) {
  const msg = data.message;
  if (!msg) return;

  if (msg.type === "game_invite" || msg.type === "game_invite_updated") {
    upsertInvite(msg.invite);
    if (msg.type === "game_invite" && msg.invite?.invitee?.id === state.user?.id && msg.invite.status === "pending") {
      showInvitePopup(msg.invite);
    } else if (msg.type === "game_invite_updated" && msg.invite?.inviter?.id === state.user?.id) {
      const name = msg.invite.invitee?.username || "Friend";
      if (msg.invite.status === "accepted") toast(`${name} accepted your invite!`);
      else if (msg.invite.status === "declined") toast(`${name} declined your invite.`);
      renderLobbyInvites();
    }
    renderFriendsList();
    renderIncomingInvites();
    return;
  }

  if (msg.type === "match") {
    if (typeof msg.game === "string" && msg.game.length > 2) {
      const game = JSON.parse(msg.game);
      if (state.game && game.id === state.game.id) applyGameUpdate(game);
    }
    const key = msg.media_key || titleKey(msg.movie_id, msg.media_type);
    if (isFirstMatch()) {
      state.finalMatchKey = key;
    } else {
      showMatchBanner(key);
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
  const lists = (game?.players || []).map((p) => normalizeMediaKeyList(p.liked_movie_ids || []));
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
  state.lastSwipe = null;
  state.finalMatchKey = null;
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
  refreshFriendsAndInvites();
}

function defaultGameValues() {
  return {
    mode: "first_match",
    providers: state.user.providers || [],
    genres: [],
    languages: [],
    userScoreRange: [0, 10],
    releaseYearRange: [1980, new Date().getFullYear()],
    releaseYearRanges: [[1980, new Date().getFullYear()]],
    runtimeRange: [0, 240],
    mediaType: "movie",
    includeKids: false,
    favorPopular: false,
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
    const known = new Set(state.movies.map((m) => titleKey(m)));
    const swiped = new Set(normalizeMediaKeyList(loadJSON(swipedIdsKey(), [])));
    let added = 0;
    results.forEach((movie) => {
      const key = titleKey(movie);
      if (known.has(key)) return;
      known.add(key);
      state.movies.push({ ...movie, hidden: swiped.has(key) });
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
function reportSwipe(movie, liked) {
  const mediaType = movie.media_type || "movie";
  backend.swipe(state.game.id, state.user.id, movie.id, liked, mediaType)
    .then(async (res) => {
      if (!res.matched) return;
      const key = res.media_key || titleKey(movie);
      if (isFirstMatch()) {
        state.finalMatchKey = key;
        try {
          applyGameUpdate(await backend.findGameByEntryCode(state.game.entry_code));
        } catch {
          // the poll or socket broadcast will deliver the finished game
        }
        render();
      } else {
        showMatchBanner(key);
      }
    })
    .catch(() => {
      const queue = loadJSON(storageKey("pending_swipes"), []);
      queue.push({
        gameId: state.game.id,
        movieId: movie.id,
        mediaType,
        liked,
      });
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
      await backend.swipe(
        swipe.gameId,
        state.user.id,
        swipe.movieId,
        swipe.liked,
        swipe.mediaType || "movie"
      );
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
  const key = titleKey(movie);

  const swiped = new Set(normalizeMediaKeyList(loadJSON(swipedIdsKey(), [])));
  swiped.add(key);
  saveJSON(swipedIdsKey(), [...swiped]);

  if (liked) {
    const likedIds = new Set(normalizeMediaKeyList(likedMovieIds()));
    likedIds.add(key);
    saveJSON(likedIdsKey(), [...likedIds]);
  }

  state.lastSwipe = { movie, liked, key };
  updateUndoButton();
  maybeShowSwipeAdBreak();

  if (isContinuous()) {
    reportSwipe(movie, liked);
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

async function undoLastSwipe() {
  const last = state.lastSwipe;
  if (!last || !state.game || state.finishedSent || state.game.finished_at) return;

  const { movie, liked, key } = last;
  state.lastSwipe = null;
  movie.hidden = false;

  const swiped = normalizeMediaKeyList(loadJSON(swipedIdsKey(), [])).filter((id) => id !== key);
  saveJSON(swipedIdsKey(), swiped);

  if (liked) {
    const likedIds = normalizeMediaKeyList(likedMovieIds()).filter((id) => id !== key);
    saveJSON(likedIdsKey(), likedIds);
  }

  // Drop an offline queued report for this title if it never reached the server.
  const pending = loadJSON(storageKey("pending_swipes"), []).filter((swipe) => {
    if (swipe.gameId !== state.game.id) return true;
    return titleKey(swipe.movieId, swipe.mediaType || "movie") !== key;
  });
  saveJSON(storageKey("pending_swipes"), pending);

  if (isContinuous()) {
    try {
      await backend.undoSwipe(state.game.id, state.user.id, movie.id, movie.media_type || "movie");
    } catch {
      toast("Couldn't undo on the server — try again.");
    }
  }

  state.noMoreMovies = false;
  if (!document.getElementById("deck")) {
    lastRenderKey = null;
    render();
  } else {
    updateUndoButton();
    buildDeckDom();
    updateDeckCounter();
  }
  toast("Undo");
}

// ---------- rendering ----------

function screenName() {
  if (state.view === "login" || state.view === "reset" || state.view === "shop") return state.view;
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
    shop: renderShopScreen,
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
  if (screen === "lobby") renderLobbyInvites();
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
        <label for="register-phone">Phone <span class="muted">(optional, for SMS alerts)</span></label>
        <input id="register-phone" type="tel" placeholder="+1 555 123 4567" autocomplete="tel">
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
        phone: document.getElementById("register-phone").value.trim() || undefined,
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
    ${topBarHtml(`<button class="link" id="edit-name">${usernameWithFlair(state.user)}</button>`)}
    <div class="screen">
      <div class="hero">
        <h1 class="headline">Movie night, <span class="accent">solved</span>.</h1>
        <p class="muted">Start a game, share the code, and swipe until you all like the same movie. First match wins — that's tonight's pick.</p>
      </div>

      ${accountNudgeHtml("home")}

      <button class="btn btn-primary btn-big" id="quick-play">▶ Quick play</button>
      <button class="btn btn-ghost" id="create-game">Custom game (optional filters)</button>
      ${isPlus() ? "" : `<button class="btn btn-secondary" id="open-shop">WannaWatch+</button>`}

      ${adSlotHtml("home")}

      <form id="join-form" class="card form-card">
        <label for="join-code">Have a game code?</label>
        <div class="join-row">
          <input id="join-code" placeholder="e.g. ABC123" maxlength="6" autocomplete="off" autocapitalize="characters">
          <button type="submit" class="btn btn-secondary">Join</button>
        </div>
      </form>

      <section class="card list-card" id="incoming-invites-section" hidden>
        <h2>Game invites</h2>
        <div id="incoming-invites"></div>
      </section>

      <section class="card list-card">
        <h2>Friends</h2>
        <div id="friends-list"><p class="muted">Loading…</p></div>
      </section>

      <section class="card list-card library-home-card">
        <div class="section-heading">
          <h2>Your movies</h2>
          <button type="button" class="link" id="view-history">Browse all →</button>
        </div>
        <p class="muted library-home-copy">Recent likes and matches — settle on tonight’s pick or sift with a friend.</p>
        <div id="home-settled-slot"></div>
        <div id="home-library-preview"><p class="muted">Loading…</p></div>
      </section>

      <section class="card list-card">
        <h2>Your games</h2>
        <div id="games-list"><p class="muted">Loading…</p></div>
      </section>

      ${state.user.email
        ? `<section class="card form-card settings-card" id="notification-settings">
             <h2>Notifications</h2>
             <p class="muted">Email and SMS for invites, nudges, and matches. No app push yet.</p>
             <label for="settings-phone">Phone</label>
             <input id="settings-phone" type="tel" placeholder="+1 555 123 4567" value="${esc(state.user.phone || "")}" autocomplete="tel">
             <label class="check-row"><input type="checkbox" id="pref-email" ${prefChecked("email_enabled")}> Email alerts</label>
             <label class="check-row"><input type="checkbox" id="pref-sms" ${prefChecked("sms_enabled")}> SMS alerts</label>
             <label class="check-row"><input type="checkbox" id="pref-invite" ${prefChecked("game_invite")}> Game invites</label>
             <label class="check-row"><input type="checkbox" id="pref-nudge" ${prefChecked("game_nudge")}> Game nudges</label>
             <label class="check-row"><input type="checkbox" id="pref-match" ${prefChecked("match_alert")}> Match alerts</label>
             <button type="button" class="btn btn-secondary" id="save-settings">Save notification settings</button>
             <p class="muted center-text">Logged in as ${esc(state.user.email)} · <button class="link inline-link" id="logout">Log out</button></p>
           </section>`
        : ""}
    </div>`;

  bindAccountNudge();
  bindAdSlots(app);

  document.getElementById("quick-play").addEventListener("click", (event) => {
    event.target.disabled = true;
    quickPlay();
  });

  document.getElementById("create-game").addEventListener("click", () => {
    state.view = "create";
    render();
  });

  document.getElementById("open-shop")?.addEventListener("click", () => {
    state.view = "shop";
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

  document.getElementById("save-settings")?.addEventListener("click", async () => {
    try {
      adoptUser(await backend.updateAccount({
        phone: document.getElementById("settings-phone").value.trim(),
        notification_preferences: {
          email_enabled: document.getElementById("pref-email").checked,
          sms_enabled: document.getElementById("pref-sms").checked,
          game_invite: document.getElementById("pref-invite").checked,
          game_nudge: document.getElementById("pref-nudge").checked,
          match_alert: document.getElementById("pref-match").checked,
        },
      }));
      toast("Notification settings saved.");
      lastRenderKey = null;
      render();
    } catch (error) {
      toast(error.serverMessage || "Could not save settings.");
    }
  });

  document.getElementById("logout")?.addEventListener("click", () => {
    if (confirm("Log out on this device?")) logout();
  });

  renderGamesList();
  renderFriendsList();
  renderIncomingInvites();
  renderHomeLibraryPreview();
  refreshGamesList();
  refreshFriendsAndInvites();
}

async function renderHomeLibraryPreview() {
  const preview = document.getElementById("home-library-preview");
  const settledSlot = document.getElementById("home-settled-slot");
  if (!preview) return;

  const pick = loadSettledPick();
  if (settledSlot) {
    if (pick?.key) {
      settledSlot.innerHTML = `
        <button type="button" class="home-settled-chip" id="home-open-settled">
          <span class="settled-label">Tonight’s pick</span>
          <strong>${esc(pick.title || "Your pick")}</strong>
        </button>`;
      settledSlot.querySelector("#home-open-settled")?.addEventListener("click", () => {
        const { id, mediaType } = parseMediaKey(pick.key);
        openMovieModal(id, mediaType);
      });
    } else {
      settledSlot.innerHTML = "";
    }
  }

  let games = [];
  try {
    games = await backend.previousGames(state.user.id);
  } catch {
    preview.innerHTML = `<p class="muted">Play a round to start collecting likes here.</p>`;
    return;
  }

  if (!preview.isConnected) return;

  const library = buildLibraryFromGames(games);
  const matchKeys = new Set(library.matches.map(([key]) => key));
  const keys = [
    ...library.matches.map(([key]) => key),
    ...library.myLikes.map(([key]) => key).filter((key) => !matchKeys.has(key)),
  ].slice(0, 8);

  if (keys.length === 0) {
    preview.innerHTML = `
      <p class="muted">No likes yet. After you swipe, your movies will show up here.</p>
      <button type="button" class="btn btn-secondary btn-small" id="home-library-empty-cta">Open your movies</button>`;
    preview.querySelector("#home-library-empty-cta")?.addEventListener("click", () => {
      state.view = "history";
      render();
    });
    return;
  }

  preview.innerHTML = `<div class="home-poster-row" id="home-poster-row"><p class="muted">Loading posters…</p></div>`;
  const row = document.getElementById("home-poster-row");
  const cards = await Promise.all(keys.map(async (key) => {
    const { id, mediaType } = parseMediaKey(key);
    const movie = await fetchMovieSummary(id, mediaType);
    if (!movie) return null;
    const poster = posterUrl(movie.poster_path, "w185");
    const isMatch = matchKeys.has(key);
    return `
      <button type="button" class="home-poster-card" data-key="${esc(key)}" data-id="${id}" data-media="${esc(movie.media_type || mediaType || "movie")}" title="${esc(movie.title)}">
        ${poster
          ? `<img src="${poster}" alt="${esc(movie.title)}">`
          : `<span class="home-poster-fallback">${esc((movie.title || "?").slice(0, 1))}</span>`}
        ${isMatch ? `<span class="home-poster-badge">Match</span>` : ""}
        <span class="home-poster-title">${esc(movie.title)}</span>
      </button>`;
  }));

  if (!row?.isConnected) return;
  const html = cards.filter(Boolean).join("");
  row.innerHTML = html || `<p class="muted">Couldn't load recent titles.</p>`;

  row.querySelectorAll(".home-poster-card").forEach((card) => {
    card.addEventListener("click", () => {
      openMovieModal(Number(card.dataset.id), card.dataset.media);
    });
  });
}

function prefChecked(key) {
  const prefs = state.user?.notification_preferences || {};
  const defaults = {
    email_enabled: true,
    sms_enabled: true,
    game_invite: true,
    game_nudge: true,
    match_alert: true,
  };
  const value = prefs[key] ?? defaults[key];
  return value ? "checked" : "";
}

function renderIncomingInvites() {
  const section = document.getElementById("incoming-invites-section");
  const container = document.getElementById("incoming-invites");
  if (!section || !container) return;

  const invites = incomingInvites();
  if (invites.length === 0) {
    section.hidden = true;
    container.innerHTML = "";
    return;
  }

  section.hidden = false;
  container.innerHTML = invites.map((invite) => `
    <div class="friend-row">
      <div class="friend-info">
        <strong>${esc(invite.inviter?.username || "Friend")}</strong>
        <span class="muted">Code ${esc(invite.entry_code)}</span>
      </div>
      <div class="friend-actions">
        <button class="btn btn-secondary btn-small" data-accept="${invite.id}">Accept</button>
        <button class="btn btn-ghost btn-small" data-decline="${invite.id}">Decline</button>
      </div>
    </div>`).join("");

  container.querySelectorAll("[data-accept]").forEach((btn) => {
    btn.addEventListener("click", () => acceptInvite(Number(btn.dataset.accept)));
  });
  container.querySelectorAll("[data-decline]").forEach((btn) => {
    btn.addEventListener("click", () => declineInvite(Number(btn.dataset.decline)));
  });
}

function renderFriendsList() {
  const container = document.getElementById("friends-list");
  if (!container) return;

  if (state.friends.length === 0) {
    container.innerHTML = `<p class="muted">Play a game with someone and they'll show up here — then you can invite them in-app.</p>`;
    return;
  }

  container.innerHTML = state.friends.map((friend) => `
    <div class="friend-row">
      <div class="friend-info">
        <strong>${esc(friend.username || "Player")}</strong>
      </div>
      <button class="btn btn-secondary btn-small" data-play="${friend.id}">Play</button>
    </div>`).join("");

  container.querySelectorAll("[data-play]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await startGameWithFriend(Number(btn.dataset.play));
    });
  });
}

function renderGamesList() {
  const container = document.getElementById("games-list");
  if (!container) return;

  if (state.currentGames.length === 0) {
    container.innerHTML = `<p class="muted">No games yet. Create one and invite a friend!</p>`;
    return;
  }

  container.innerHTML = state.currentGames.map((game) => {
    const players = game.players.map((p) => esc(p.user?.username)).filter(Boolean).join(", ");
    const modeTag = game.mode === "endless"
      ? `<span class="endless-tag">Endless</span>`
      : game.mode === "first_match"
        ? `<span class="endless-tag">First match</span>`
        : "";

    return `
    <div class="game-row">
      <button class="game-row-main" data-code="${esc(game.entry_code)}">
        <span class="game-row-info">
          <span class="game-row-heading">
            <span class="game-code">${esc(game.entry_code)}</span>
            ${modeTag}
          </span>
          ${players ? `<span class="game-players">${players}</span>` : ""}
        </span>
        <span class="game-resume"><span class="game-resume-label">Resume </span><span aria-hidden="true">→</span></span>
      </button>
      <button class="game-remove" data-id="${game.id}" data-code="${esc(game.entry_code)}" aria-label="Remove from game" title="Remove from game">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM7 9h2v9H7V9zm-1 12h12l1-12H5l1 12z"/>
        </svg>
      </button>
    </div>`;
  }).join("");

  container.querySelectorAll(".game-row-main").forEach((row) => {
    row.addEventListener("click", () => joinGameByCode(row.dataset.code));
  });

  container.querySelectorAll(".game-remove").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const code = btn.dataset.code;
      if (!confirm(`Remove yourself from game ${code}?`)) return;

      btn.disabled = true;
      try {
        await backend.leaveGame(Number(btn.dataset.id), state.user.id);
        if (state.game?.id === Number(btn.dataset.id)) leaveGame();
        else await refreshGamesList();
      } catch {
        toast("Couldn't leave that game. Try again.");
        btn.disabled = false;
      }
    });
  });
}

// ---------- create game screen ----------

let genresCache = null;

async function renderCreateScreen() {
  const currentYear = new Date().getFullYear();
  const eraPresets = [
    { label: "Any time", from: 1950, to: currentYear, any: true },
    { label: "New", from: 2020, to: currentYear },
    { label: "2010s", from: 2010, to: 2019 },
    { label: "2000s", from: 2000, to: 2009 },
    { label: "80s & 90s", from: 1980, to: 1999 },
    { label: "Classics", from: 1950, to: 1979 },
  ];
  const vibePresets = [
    { label: "Surprise me", genres: [], rating: 0, era: "Any time", favorPopular: false, includeKids: false },
    { label: "Crowd favorites", genres: [], rating: 6, era: "Any time", favorPopular: true, includeKids: false },
    { label: "Date night", genres: [10749, 35, 18], rating: 6, era: "Any time", favorPopular: false, includeKids: false },
    { label: "Laugh out loud", genres: [35], rating: 6, era: "Any time", favorPopular: false, includeKids: false },
    { label: "Edge of your seat", genres: [53, 27, 9648, 80], rating: 6, era: "Any time", favorPopular: false, includeKids: false },
    { label: "Family night", genres: [10751, 16, 12], rating: 6, era: "Any time", favorPopular: false, includeKids: true },
    { label: "Critically acclaimed", genres: [], rating: 8, era: "Any time", favorPopular: false, includeKids: false },
    { label: "Throwback", genres: [], rating: 7, era: "80s & 90s", favorPopular: false, includeKids: false },
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

  const fineTuneFields = `
          <div class="form-card fine-tune-body">
            <div class="field-block">
              <label>Genres</label>
              <div class="chips" id="genre-chips"><span class="muted">Loading genres…</span></div>
            </div>

            <div class="field-block">
              <label>When was it made?</label>
              <p class="hint">Pick one or combine eras (e.g. New + Classics).</p>
              <div class="chips" id="era-chips">
                ${eraPresets.map((item, index) => `
                  <button type="button" class="chip ${index === 0 ? "selected" : ""}" data-from="${item.from}" data-to="${item.to}" data-any="${item.any ? "1" : "0"}">${esc(item.label)}</button>
                `).join("")}
              </div>
            </div>

            <div class="field-block">
              <label>How good does it need to be?</label>
              <div class="chips single" id="rating-chips">
                ${presetChips(ratingPresets, (item) => `data-min="${item.min}"`)}
              </div>
            </div>

            <div class="field-block" id="runtime-block">
              <label>How long is movie night?</label>
              <div class="chips single" id="runtime-chips">
                ${presetChips(runtimePresets, (item) => `data-min="${item.min}" data-max="${item.max}"`)}
              </div>
            </div>

            <div class="field-block">
              <label>Language</label>
              <div class="chips" id="language-chips">
                ${languagePresets.map((item) => `<button type="button" class="chip" data-value="${item.value}">${esc(item.label)}</button>`).join("")}
              </div>
            </div>

            <div class="field-block">
              <label>Extras</label>
              <div class="chips" id="extra-chips">
                <button type="button" class="chip" id="favor-popular-chip">Favor popular</button>
                <button type="button" class="chip" id="include-kids-chip">Include children's</button>
              </div>
            </div>
          </div>`;

  const fineTuneSection = isPlus()
    ? `<details class="card fine-tune">
          <summary>Fine-tune <span class="muted">(optional)</span></summary>
          ${fineTuneFields}
        </details>`
    : `<section class="card fine-tune fine-tune-locked">
          <div class="fine-tune-lock">
            <div>
              <strong>Fine-tune</strong>
              <p class="muted">Genres, eras, runtime, and language — WannaWatch+.</p>
            </div>
            <button type="button" class="btn btn-secondary btn-small" id="unlock-fine-tune">Get WannaWatch+</button>
          </div>
          <div hidden>${fineTuneFields}</div>
        </section>`;

  app.innerHTML = `
    ${topBarHtml("")}
    <div class="screen create-screen">
      <h1 class="headline-sm">Custom game</h1>
      <p class="muted create-lede">${isPlus()
        ? "Pick a mode and vibe — Fine-tune below if you want."
        : "Pick a mode and vibe. WannaWatch+ unlocks Fine-tune."}</p>
      <form id="create-form">
        <section class="card form-card">
          <label>Game mode</label>
          <div class="mode-options">
            <button type="button" class="mode-option selected" data-mode="first_match">
              <strong>First match</strong>
              <span>First title everyone likes wins — that's tonight's pick.</span>
            </button>
            <button type="button" class="mode-option" data-mode="endless">
              <strong>Endless</strong>
              <span>Keep swiping on your own time; get alerted on every match.</span>
            </button>
            <button type="button" class="mode-option" data-mode="classic">
              <strong>Classic</strong>
              <span>Same 20 titles for everyone, then compare.</span>
            </button>
          </div>
        </section>

        <section class="card form-card">
          <div class="field-block">
            <label>What's the vibe?</label>
            <p class="hint">One tap sets the mood — tweak below after.</p>
            <div class="chips single" id="vibe-chips">
              ${vibePresets.map((v, i) => `<button type="button" class="chip ${i === 0 ? "selected" : ""}" data-vibe="${i}">${esc(v.label)}</button>`).join("")}
            </div>
          </div>

          <div class="field-block">
            <label>Movies or TV?</label>
            <div class="chips single" id="media-chips">
              <button type="button" class="chip selected" data-value="movie">Movies</button>
              <button type="button" class="chip" data-value="tv">TV shows</button>
              <button type="button" class="chip" data-value="both">Both</button>
            </div>
          </div>

          <div class="field-block">
            <label>Where do you watch?</label>
            <p class="hint">Optional — we'll remember your picks.</p>
            <div class="chips" id="provider-chips"><span class="muted">Loading services…</span></div>
            <button type="button" class="btn btn-ghost btn-small" id="provider-more" hidden>More services</button>
          </div>
        </section>

        ${fineTuneSection}

        <div class="button-row sticky-actions">
          <button type="button" class="btn btn-ghost" id="cancel-create">Back</button>
          <button type="submit" class="btn btn-primary" id="create-submit">Start swiping</button>
        </div>
      </form>
    </div>`;

  bindBrandHome();

  document.getElementById("unlock-fine-tune")?.addEventListener("click", (event) => {
    event.preventDefault();
    openPlusShop();
  });

  document.querySelectorAll(".mode-option").forEach((option) => {
    option.addEventListener("click", () => {
      document.querySelectorAll(".mode-option").forEach((el) => el.classList.remove("selected"));
      option.classList.add("selected");
    });
  });

  let pendingVibeGenres = null;
  const favorPopularChip = document.getElementById("favor-popular-chip");
  const includeKidsChip = document.getElementById("include-kids-chip");

  const setEraByLabel = (label) => {
    document.querySelectorAll("#era-chips .chip").forEach((chip) => {
      chip.classList.toggle("selected", chip.textContent.trim() === label);
    });
  };

  const applyVibe = (vibe) => {
    pendingVibeGenres = vibe.genres;
    document.querySelectorAll("#genre-chips .chip").forEach((chip) => {
      chip.classList.toggle("selected", vibe.genres.includes(Number(chip.dataset.value)));
    });
    document.querySelectorAll("#rating-chips .chip").forEach((chip) => {
      chip.classList.toggle("selected", Number(chip.dataset.min) === vibe.rating);
    });
    setEraByLabel(vibe.era);
    favorPopularChip?.classList.toggle("selected", !!vibe.favorPopular);
    includeKidsChip?.classList.toggle("selected", !!vibe.includeKids);
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

  // Eras are multi-select; "Any time" is exclusive with specific decades.
  document.getElementById("era-chips").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    const chips = [...document.querySelectorAll("#era-chips .chip")];
    if (chip.dataset.any === "1") {
      chips.forEach((el) => el.classList.toggle("selected", el === chip));
      return;
    }
    chips.filter((el) => el.dataset.any === "1").forEach((el) => el.classList.remove("selected"));
    chip.classList.toggle("selected");
    if (!chips.some((el) => el.classList.contains("selected"))) {
      chips.find((el) => el.dataset.any === "1")?.classList.add("selected");
    }
  });

  toggleMulti("provider-chips");
  toggleMulti("genre-chips");
  toggleMulti("language-chips");
  selectOne("media-chips");
  selectOne("rating-chips");
  selectOne("runtime-chips");

  favorPopularChip?.addEventListener("click", () => favorPopularChip.classList.toggle("selected"));
  includeKidsChip?.addEventListener("click", () => includeKidsChip.classList.toggle("selected"));

  const syncRuntimeVisibility = () => {
    const media = document.querySelector("#media-chips .chip.selected")?.dataset.value || "movie";
    const block = document.getElementById("runtime-block");
    if (block) block.hidden = media === "tv";
  };
  document.getElementById("media-chips").addEventListener("click", () => {
    syncRuntimeVisibility();
    loadGenresForMedia();
  });
  syncRuntimeVisibility();

  const savedProviderIds = new Set(normalizeProviderIds(state.user.providers || []));
  let providerList = null;
  let showingAllProviders = false;

  function renderProviderChips() {
    const container = document.getElementById("provider-chips");
    const moreBtn = document.getElementById("provider-more");
    if (!container || !providerList) return;

    const list = showingAllProviders ? providerList.all : providerList.featured;
    container.innerHTML = list
      .map((p) => `<button type="button" class="chip" data-value="${p.code}">${esc(p.title)}</button>`)
      .join("");

    container.querySelectorAll(".chip").forEach((chip) => {
      if (savedProviderIds.has(chip.dataset.value)) chip.classList.add("selected");
    });

    if (moreBtn) {
      const hasMore = providerList.all.length > providerList.featured.length;
      moreBtn.hidden = !hasMore;
      moreBtn.textContent = showingAllProviders ? "Fewer services" : "More services";
    }
  }

  document.getElementById("provider-more")?.addEventListener("click", () => {
    // Sync selection state from currently visible chips before re-render.
    const visibleCodes = [...document.querySelectorAll("#provider-chips .chip")].map((c) => c.dataset.value);
    visibleCodes.forEach((code) => savedProviderIds.delete(code));
    document.querySelectorAll("#provider-chips .chip.selected").forEach((chip) => {
      savedProviderIds.add(chip.dataset.value);
    });
    showingAllProviders = !showingAllProviders;
    renderProviderChips();
  });

  loadProviders().then((list) => {
    providerList = list;
    renderProviderChips();
  }).catch(() => {
    const container = document.getElementById("provider-chips");
    if (container) container.innerHTML = `<span class="muted">Services unavailable</span>`;
  });

  document.getElementById("cancel-create").addEventListener("click", () => {
    state.view = "home";
    render();
  });

  document.getElementById("create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = (id) =>
      [...document.querySelectorAll(`#${id} .chip.selected`)].flatMap((chip) => {
        if (chip.dataset.movieId || chip.dataset.tvId) {
          return [chip.dataset.movieId, chip.dataset.tvId].filter(Boolean);
        }
        return chip.dataset.value ? [chip.dataset.value] : [];
      });
    const eras = [...document.querySelectorAll("#era-chips .chip.selected")];
    const rating = document.querySelector("#rating-chips .chip.selected");
    const runtime = document.querySelector("#runtime-chips .chip.selected");
    const mediaType = document.querySelector("#media-chips .chip.selected")?.dataset.value || "movie";

    const releaseYearRanges = eras.map((era) => [
      Number(era.dataset.from || 1950),
      Number(era.dataset.to || currentYear),
    ]);

    const values = {
      mode: document.querySelector(".mode-option.selected")?.dataset.mode || "first_match",
      providers: normalizeProviderIds(selected("provider-chips")),
      genres: selected("genre-chips"),
      languages: selected("language-chips"),
      userScoreRange: [Number(rating?.dataset.min || 0), 10],
      releaseYearRanges,
      releaseYearRange: releaseYearRanges[0] || [1950, currentYear],
      runtimeRange: [Number(runtime?.dataset.min || 0), Number(runtime?.dataset.max || 400)],
      mediaType,
      includeKids: includeKidsChip?.classList.contains("selected") || false,
      favorPopular: favorPopularChip?.classList.contains("selected") || false,
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

  let genresCacheMovie = null;
  let genresCacheTv = null;

  async function loadGenresForMedia() {
    const media = document.querySelector("#media-chips .chip.selected")?.dataset.value || "movie";
    const chipContainer = document.getElementById("genre-chips");
    if (!chipContainer) return;

    chipContainer.innerHTML = `<span class="muted">Loading genres…</span>`;
    try {
      genresCacheMovie = genresCacheMovie || genresCache || (await tmdb.genres("movie"));
      genresCache = genresCacheMovie;
      genresCacheTv = genresCacheTv || (await tmdb.genres("tv"));

      let chipsHtml = "";
      if (media === "both") {
        const byName = new Map();
        genresCacheMovie.forEach((g) => byName.set(g.name, { name: g.name, movieId: g.id, tvId: null }));
        genresCacheTv.forEach((g) => {
          const existing = byName.get(g.name);
          if (existing) existing.tvId = g.id;
          else byName.set(g.name, { name: g.name, movieId: null, tvId: g.id });
        });
        chipsHtml = [...byName.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((g) => `
            <button type="button" class="chip" data-movie-id="${g.movieId || ""}" data-tv-id="${g.tvId || ""}" data-value="${g.movieId || g.tvId}">
              ${esc(g.name)}
            </button>`)
          .join("");
      } else {
        const list = media === "tv" ? genresCacheTv : genresCacheMovie;
        chipsHtml = list
          .map((g) => `<button type="button" class="chip" data-value="${g.id}">${esc(g.name)}</button>`)
          .join("");
      }

      chipContainer.innerHTML = chipsHtml;
      if (pendingVibeGenres?.length) {
        chipContainer.querySelectorAll(".chip").forEach((chip) => {
          const ids = [chip.dataset.value, chip.dataset.movieId, chip.dataset.tvId]
            .filter(Boolean)
            .map(Number);
          chip.classList.toggle("selected", ids.some((id) => pendingVibeGenres.includes(id)));
        });
      }
    } catch {
      chipContainer.innerHTML = `<span class="muted">Genres unavailable</span>`;
    }
  }

  loadGenresForMedia();
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
        <span class="player-name">${usernameWithFlair(player.user)}${player.user?.id === state.user.id ? " (you)" : ""}</span>
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

      <section class="card list-card" id="lobby-invite-section">
        <h2>Invite friends</h2>
        <div id="lobby-invites"></div>
      </section>

      ${accountNudgeHtml("lobby")}

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
  bindAccountNudge();
  renderLobbyInvites();

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
        "You're the only one here! It's more fun with friends — invite them in-app or share the link. Continue solo anyway?"
      );
      if (!goSolo) return;
    }
    sendReady();
  });

  document.getElementById("leave-game").addEventListener("click", leaveGame);
}

function renderLobbyInvites() {
  const container = document.getElementById("lobby-invites");
  const section = document.getElementById("lobby-invite-section");
  if (!container || !section || !state.game) return;

  const playerIds = new Set((state.game.players || []).map((p) => p.user?.id));
  const invitableFriends = state.friends.filter((f) => !playerIds.has(f.id));
  const pendingByFriend = new Map(
    outgoingInvitesForGame(state.game.id).map((i) => [i.invitee?.id, i])
  );

  if (state.friends.length === 0) {
    container.innerHTML = `<p class="muted">No past co-players yet. Share the code above, or play once and invite them next time.</p>`;
    return;
  }

  if (invitableFriends.length === 0) {
    container.innerHTML = `<p class="muted">Everyone on your friends list is already in this game.</p>`;
    return;
  }

  container.innerHTML = invitableFriends.map((friend) => {
    const pending = pendingByFriend.get(friend.id);
    return `
    <div class="friend-row">
      <div class="friend-info">
        <strong>${esc(friend.username || "Player")}</strong>
        ${pending ? `<span class="muted">Invite pending</span>` : ""}
      </div>
      <div class="friend-actions">
        ${pending
          ? `<button class="btn btn-ghost btn-small" data-nudge="${pending.id}">Nudge</button>`
          : `<button class="btn btn-secondary btn-small" data-invite="${friend.id}">Invite</button>`}
      </div>
    </div>`;
  }).join("");

  container.querySelectorAll("[data-invite]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const invite = await inviteFriendToGame(Number(btn.dataset.invite), state.game.id);
      if (!invite) btn.disabled = false;
    });
  });

  container.querySelectorAll("[data-nudge]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await backend.nudgeGameInvite(Number(btn.dataset.nudge), state.user.id);
        toast("Nudge sent.");
      } catch (error) {
        toast(error.serverMessage || "Couldn't send nudge.");
        btn.disabled = false;
      }
    });
  });
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

function watchTonightUrl(movie) {
  return movie["watch/providers"]?.results?.US?.link || null;
}

function preferredFlatrateProviders(movie) {
  const flatrate = movie["watch/providers"]?.results?.US?.flatrate || [];
  if (!flatrate.length) return [];
  const userCodes = new Set(normalizeProviderIds(state.user?.providers || []));
  const preferred = flatrate.filter((p) => userCodes.has(String(p.provider_id)));
  return preferred.length ? preferred : flatrate;
}

function matchShareUrl(movie) {
  return watchTonightUrl(movie)
    || `https://www.themoviedb.org/${movie.media_type === "tv" ? "tv" : "movie"}/${movie.id}`;
}

async function shareMatch(movie) {
  const title = movie.title || "WannaWatch match";
  const text = `WannaWatch match: ${title}`;
  const url = matchShareUrl(movie);
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast("Match copied to clipboard");
  } catch {
    toast("Couldn't share this match.");
  }
}

function matchActionsHtml(movie, { compact = false } = {}) {
  const watchUrl = watchTonightUrl(movie);
  const preferred = preferredFlatrateProviders(movie);
  const label = preferred[0]
    ? `Watch on ${preferred[0].provider_name}`
    : "Watch tonight";
  return `
    <div class="match-actions ${compact ? "compact" : ""}">
      ${watchUrl
        ? `<a class="btn btn-primary btn-small" href="${esc(watchUrl)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`
        : `<span class="muted">No US streaming link yet</span>`}
      <button type="button" class="btn btn-secondary btn-small" data-share-match>Share</button>
    </div>`;
}

function bindMatchActions(root, movie) {
  root.querySelectorAll("[data-share-match]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      shareMatch(movie);
    });
  });
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
      ${matchActionsHtml(movie, { compact })}
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
      </div>` : ""}
    ${compact ? "" : deepDiveExtrasHtml(movie)}`;
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
  const details = await fetchMovieSummary(movie.id, movie.media_type);
  if (!panel.isConnected) return;
  if (!details) {
    panel.innerHTML = `<p class="overview">${esc(movie.overview || "No description available.")}</p><button type="button" class="link" data-flip-back>Tap to flip back</button>`;
    return;
  }
  panel.innerHTML = `${movieDetailsHtml(details, { compact: true })}<button type="button" class="link" data-flip-back>Flip back</button>`;
  panel.dataset.loaded = "1";
  bindTrailerButtons(panel);
  bindMatchActions(panel, details);
}

async function openMovieModal(movieId, mediaType) {
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

  const parsed = parseMediaKey(movieId);
  const id = parsed.id || Number(movieId);
  const media = mediaType || parsed.mediaType;
  const movie = await fetchMovieSummary(id, media);
  if (!overlay.isConnected || overlay.hidden) return;
  if (!movie) {
    overlay.innerHTML = `<div class="modal-sheet"><p>Couldn't load that title.</p><button class="btn btn-ghost" id="modal-close">Close</button></div>`;
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
  bindMatchActions(overlay, movie);
}

function bindResultCards(root) {
  root.querySelectorAll(".result-card[data-id]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest(".match-actions, a, button")) return;
      openMovieModal(card.dataset.id, card.dataset.media);
    });
  });
}

const shownMatchBanners = new Set();

async function showMatchBanner(mediaKeyOrId, mediaType) {
  const key = typeof mediaKeyOrId === "string" && mediaKeyOrId.includes(":")
    ? mediaKeyOrId
    : titleKey(mediaKeyOrId, mediaType);
  if (shownMatchBanners.has(key)) return;
  shownMatchBanners.add(key);
  updateMatchesPill();

  let banner = document.getElementById("match-banner");
  if (!banner) {
    banner = document.createElement("button");
    banner.id = "match-banner";
    banner.className = "match-banner";
    document.body.appendChild(banner);
  }

  const { id, mediaType: mt } = parseMediaKey(key);
  const movie = await fetchMovieSummary(id, mt);
  const title = movie?.title || "a movie";
  banner.innerHTML = `
    ${movie?.poster_path ? `<img src="${posterUrl(movie.poster_path, "w92")}" alt="">` : ""}
    <span><strong>It's a match! 🎉</strong><br>Everyone liked ${esc(title)}</span>`;
  banner.hidden = false;
  banner.onclick = () => {
    banner.hidden = true;
    openMovieModal(id, mt);
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

  const cards = await Promise.all(ids.slice(0, 60).map(async (key) => {
    const { id, mediaType } = parseMediaKey(key);
    const movie = await fetchMovieSummary(id, mediaType);
    if (!movie) return "";
    const poster = posterUrl(movie.poster_path, "w342");
    const media = movie.media_type || mediaType || "movie";
    return `
      <article class="result-card" data-id="${esc(key)}" data-media="${media}">
        <button type="button" class="result-card-main" data-open-match>
          ${poster ? `<img src="${poster}" alt="${esc(movie.title)}">` : `<div class="poster-missing">${esc(movie.title)}</div>`}
          <div class="result-info"><strong>${esc(movie.title)}</strong></div>
        </button>
        ${matchActionsHtml(movie, { compact: true })}
      </article>`;
  }));

  const grid = overlay.querySelector("#matches-grid");
  if (grid) {
    grid.innerHTML = cards.join("");
    grid.querySelectorAll(".result-card").forEach((card, index) => {
      const key = ids[index];
      const { id, mediaType } = parseMediaKey(key);
      card.querySelector("[data-open-match]")?.addEventListener("click", () => {
        close();
        openMovieModal(id, mediaType);
      });
      fetchMovieSummary(id, mediaType).then((movie) => {
        if (movie) bindMatchActions(card, movie);
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
        <button class="action-btn undo" id="undo-button" aria-label="Undo last swipe" disabled>↶</button>
        <button class="action-btn like" id="like-button" aria-label="Like">♥</button>
      </div>
    </div>`;

  bindBrandHome();
  buildDeckDom();
  attachDeckGestures(document.getElementById("deck"));
  updateUndoButton();

  document.getElementById("nope-button").addEventListener("click", () => swipeTopCard(false));
  document.getElementById("undo-button").addEventListener("click", () => undoLastSwipe());
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
        <button class="action-btn undo" id="undo-button" aria-label="Undo last swipe" disabled>↶</button>
        <button class="action-btn like" id="like-button" aria-label="Like">♥</button>
      </div>
    </div>`;

  bindBrandHome();
  buildDeckDom();
  attachDeckGestures(document.getElementById("deck"));
  updateUndoButton();

  document.getElementById("matches-pill")?.addEventListener("click", showMatchesModal);
  document.getElementById("invite-pill").addEventListener("click", async () => {
    await navigator.clipboard.writeText(shareLink());
    toast("Invite link copied — anyone can join and swipe on their own time!");
  });
  document.getElementById("nope-button").addEventListener("click", () => swipeTopCard(false));
  document.getElementById("undo-button").addEventListener("click", () => undoLastSwipe());
  document.getElementById("like-button").addEventListener("click", () => swipeTopCard(true));
}

// ---------- first-match celebration ----------

async function renderMatchFoundScreen() {
  const matchKey = state.finalMatchKey || matchedIdsOf(state.game)[0];
  const parsed = matchKey ? parseMediaKey(matchKey) : null;

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
      <div id="final-actions" class="button-row full-width"></div>
      <div class="button-row full-width">
        <button class="btn btn-secondary" id="final-details">Details</button>
        <button class="btn btn-primary" id="play-again">Play again</button>
      </div>
      <button class="link" id="back-home">Back to home</button>
    </div>`;

  bindBrandHome();
  document.getElementById("final-details").addEventListener("click", () => {
    if (parsed) openMovieModal(parsed.id, parsed.mediaType);
  });
  document.getElementById("play-again").addEventListener("click", (event) => {
    event.target.disabled = true;
    quickPlay();
  });
  document.getElementById("back-home").addEventListener("click", leaveGame);

  if (!parsed) return;
  const movie = await fetchMovieSummary(parsed.id, parsed.mediaType);
  const el = document.getElementById("final-movie");
  if (!el || !movie) return;
  const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
  el.innerHTML = `
    ${movie.poster_path ? `<img src="${posterUrl(movie.poster_path, "w342")}" alt="${esc(movie.title)}">` : ""}
    <strong>${esc(movie.title)}</strong>
    <span class="muted">${year} · ★ ${movie.vote_average ? movie.vote_average.toFixed(1) : "–"}</span>`;
  const actions = document.getElementById("final-actions");
  if (actions) {
    actions.innerHTML = matchActionsHtml(movie);
    bindMatchActions(actions, movie);
  }
}

function movieCardHtml(movie) {
  const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
  const rating = movie.vote_average ? movie.vote_average.toFixed(1) : "–";
  const poster = posterUrl(movie.poster_path);
  const media = movie.media_type || "movie";
  const kind = media === "tv" ? "TV" : "";
  return `
    <div class="movie-card" data-id="${movie.id}" data-media="${media}">
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
        <span class="muted">${[year, kind].filter(Boolean).join(" · ")}</span>
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
    const swipedCount = normalizeMediaKeyList(loadJSON(swipedIdsKey(), [])).length;
    counter.textContent = `${swipedCount} swiped`;
    return;
  }
  const count = unswipedMovies().length;
  counter.textContent = `${count} movie${count === 1 ? "" : "s"} left`;
}

function updateUndoButton() {
  const button = document.getElementById("undo-button");
  if (!button) return;
  const canUndo = Boolean(state.lastSwipe) && !state.finishedSent && !state.game?.finished_at;
  button.disabled = !canUndo;
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
  const myCount = normalizeMediaKeyList(loadJSON(swipedIdsKey(), [])).length;

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
  const key = titleKey(card.dataset.id, card.dataset.media);
  return state.movies.find((m) => titleKey(m) === key);
}

// Adds the next queued card underneath the visible stack, so swipes never
// rebuild the deck DOM mid-animation.
function revealNextCard() {
  const deck = document.getElementById("deck");
  if (!deck) return;
  const visibleIds = new Set(
    [...deck.querySelectorAll(".movie-card:not(.flying)")].map((c) => titleKey(c.dataset.id, c.dataset.media))
  );
  const next = unswipedMovies().slice(0, 3).find((m) => !visibleIds.has(titleKey(m)));
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
  const idLists = (state.game.players || []).map((p) => normalizeMediaKeyList(p.liked_movie_ids || []));
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
        : "You all swiped right on these — rewatch, stream, or share:"}</p>
      <div class="results-grid" id="results-grid"></div>
      ${adSlotHtml("results")}
      <div class="button-row sticky-actions">
        <button class="btn btn-primary" id="keep-playing">Keep playing</button>
        <button class="btn btn-ghost" id="go-home">Home</button>
      </div>
    </div>`;

  bindBrandHome();
  bindAdSlots(app);
  onTap(document.getElementById("keep-playing"), keepPlaying);
  onTap(document.getElementById("go-home"), leaveGame);

  const grid = document.getElementById("results-grid");
  if (matchedIds.length === 0) return;

  const localMovies = new Map(state.movies.map((m) => [titleKey(m), m]));
  const cards = await Promise.all(matchedIds.slice(0, 30).map(async (key) => {
    const { id, mediaType } = parseMediaKey(key);
    const movie = localMovies.get(key) || (await fetchMovieSummary(id, mediaType));
    if (!movie) return "";
    const poster = posterUrl(movie.poster_path, "w342");
    const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
    const media = movie.media_type || mediaType || "movie";
    return `
      <article class="result-card actionable" data-id="${esc(key)}" data-media="${media}">
        <button type="button" class="result-card-main" data-open-match>
          ${poster ? `<img src="${poster}" alt="${esc(movie.title)}">` : `<div class="poster-missing">${esc(movie.title)}</div>`}
          <div class="result-info">
            <strong>${esc(movie.title)}</strong>
            <span class="muted">${year} · ★ ${movie.vote_average ? movie.vote_average.toFixed(1) : "–"}</span>
          </div>
        </button>
        ${matchActionsHtml(movie, { compact: true })}
      </article>`;
  }));

  if (grid.isConnected) {
    grid.innerHTML = cards.join("");
    const resolved = await Promise.all(matchedIds.slice(0, 30).map(async (key, index) => {
      const card = grid.children[index];
      if (!card) return null;
      const { id, mediaType } = parseMediaKey(key);
      card.querySelector("[data-open-match]")?.addEventListener("click", () => openMovieModal(id, mediaType));
      const movie = await fetchMovieSummary(id, mediaType);
      if (movie) bindMatchActions(card, movie);
      return movie;
    }));
    const added = mergeIntoVault(resolved.filter(Boolean));
    if (added > 0) toast(`Saved ${added} to Match Vault.`);
  }
}

// ---------- movie library (likes, matches, friend curation) ----------

const movieSummaryCache = new Map();

async function fetchMovieSummary(id, mediaType) {
  const parsed = parseMediaKey(id);
  const numericId = parsed.id || Number(id);
  const hinted = mediaType || parsed.mediaType || state.movies?.find((m) => m.id === numericId)?.media_type;
  const order = hinted === "tv" ? ["tv", "movie"] : hinted === "movie" ? ["movie"] : ["movie", "tv"];

  for (const type of order) {
    const cacheKey = `${type}:${numericId}`;
    if (movieSummaryCache.has(cacheKey)) {
      const cached = movieSummaryCache.get(cacheKey);
      if (cached) return cached;
      continue;
    }
    try {
      const movie = await tmdb.details(numericId, type);
      movie.media_type = movie.media_type || type;
      movieSummaryCache.set(cacheKey, movie);
      return movie;
    } catch {
      movieSummaryCache.set(cacheKey, null);
    }
  }
  return null;
}

function matchedIdsFor(game) {
  const lists = (game.players || []).map((p) => normalizeMediaKeyList(p.liked_movie_ids || []));
  return lists.length ? lists.reduce((a, b) => a.filter((id) => b.includes(id))) : [];
}

function settledPickKey() {
  return storageKey(`settled_${state.user?.id || "guest"}`);
}

function loadSettledPick() {
  return loadJSON(settledPickKey(), null);
}

function saveSettledPick(entry) {
  saveJSON(settledPickKey(), entry);
}

function clearSettledPick() {
  localStorage.removeItem(settledPickKey());
}

// Aggregate likes/matches across finished games into movie-centric lists.
function buildLibraryFromGames(games) {
  const myLikes = new Map(); // key -> { count, with: Set<name>, lastAt }
  const matches = new Map(); // key -> { with: Set<name>, count }

  games.forEach((game) => {
    const finishedAt = game.finished_at ? Date.parse(game.finished_at) : 0;
    const players = game.players || [];
    const me = players.find((p) => p.user?.id === state.user.id);
    const others = players.filter((p) => p.user?.id !== state.user.id);

    normalizeMediaKeyList(me?.liked_movie_ids || []).forEach((key) => {
      const entry = myLikes.get(key) || { count: 0, with: new Set(), lastAt: 0 };
      entry.count += 1;
      entry.lastAt = Math.max(entry.lastAt, finishedAt);
      others.forEach((p) => {
        if (normalizeMediaKeyList(p.liked_movie_ids || []).includes(key)) {
          entry.with.add(p.user?.username || "Friend");
        }
      });
      myLikes.set(key, entry);
    });

    if (players.length < 2) return;
    matchedIdsFor(game).forEach((key) => {
      const entry = matches.get(key) || { with: new Set(), count: 0, lastAt: 0 };
      entry.count += 1;
      entry.lastAt = Math.max(entry.lastAt, finishedAt);
      others.forEach((p) => entry.with.add(p.user?.username || "Friend"));
      matches.set(key, entry);
    });
  });

  const byRecent = (a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0);
  const sortMyLikes = [...myLikes.entries()].sort(byRecent);
  const sortMatches = [...matches.entries()].sort(byRecent);

  return { myLikes: sortMyLikes, matches: sortMatches };
}

function capLibraryEntries(entries) {
  if (isPlus() || !entries?.length) return { visible: entries || [], total: entries?.length || 0, capped: false };
  const total = entries.length;
  const limit = LIBRARY_FREE_LIMIT;
  return {
    visible: entries.slice(0, limit),
    total,
    capped: total > limit,
  };
}

function plusHistoryNudgeHtml(total, noun) {
  return `<p class="muted plus-nudge">Showing your last ${LIBRARY_FREE_LIMIT} of ${total} ${noun}. <button type="button" class="link inline-link" data-open-plus>WannaWatch+ ($2.99/mo) unlocks the rest.</button></p>`;
}

function bindPlusNudge(root) {
  root.querySelectorAll("[data-open-plus]").forEach((btn) => {
    btn.addEventListener("click", openPlusShop);
  });
}

async function renderHistoryScreen() {
  app.innerHTML = `
    ${topBarHtml("")}
    <div class="screen library-screen">
      <h1 class="headline-sm">Your movies</h1>
      <p class="muted">${isPlus()
        ? "Likes and matches across every night — pick tonight’s film, or narrow a list with a friend."
        : `Free keeps your last ${LIBRARY_FREE_LIMIT} likes and matches. WannaWatch+ ($2.99/mo) unlocks the full history.`}</p>
      ${accountNudgeHtml("history")}
      <div id="settled-banner"></div>
      <div class="tab-row library-tabs">
        <button class="tab ${state.libraryTab === "matches" ? "active" : ""}" data-lib-tab="matches">Matches</button>
        <button class="tab ${state.libraryTab === "likes" ? "active" : ""}" data-lib-tab="likes">My likes</button>
        <button class="tab ${state.libraryTab === "friends" ? "active" : ""}" data-lib-tab="friends">With a friend</button>
      </div>
      <div id="history-content"><p class="muted">Loading…</p></div>
      <button class="link" id="back-home">Back to home</button>
    </div>`;

  bindBrandHome();
  bindAccountNudge();
  renderSettledBanner();

  document.getElementById("back-home").addEventListener("click", () => {
    state.view = "home";
    render();
  });

  document.querySelectorAll("[data-lib-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.libraryTab = button.dataset.libTab;
      if (state.libraryTab !== "friends") state.libraryFriendId = null;
      renderHistoryScreen();
    });
  });

  let games = [];
  try {
    games = await backend.previousGames(state.user.id);
  } catch {
    // empty state below
  }

  const container = document.getElementById("history-content");
  if (!container) return;

  const library = buildLibraryFromGames(games);
  if (state.libraryTab === "matches") {
    await renderLibraryMatches(container, library.matches);
  } else if (state.libraryTab === "likes") {
    await renderLibraryLikes(container, library.myLikes);
  } else {
    await renderLibraryFriends(container);
  }
}

function renderSettledBanner() {
  const el = document.getElementById("settled-banner");
  if (!el) return;
  const pick = loadSettledPick();
  if (!pick?.key) {
    el.innerHTML = "";
    return;
  }

  el.innerHTML = `
    <section class="card settled-card">
      <div>
        <p class="settled-label">Tonight’s pick</p>
        <strong>${esc(pick.title || "Your pick")}</strong>
        ${pick.withNames ? `<p class="muted">With ${esc(pick.withNames)}</p>` : ""}
      </div>
      <div class="settled-actions">
        <button type="button" class="btn btn-primary btn-small" data-open-settled>Open</button>
        <button type="button" class="btn btn-ghost btn-small" data-clear-settled>Clear</button>
      </div>
    </section>`;

  el.querySelector("[data-open-settled]")?.addEventListener("click", () => {
    const { id, mediaType } = parseMediaKey(pick.key);
    openMovieModal(id, mediaType);
  });
  el.querySelector("[data-clear-settled]")?.addEventListener("click", () => {
    clearSettledPick();
    renderSettledBanner();
    toast("Cleared tonight’s pick.");
  });
}

async function renderLibraryMatches(container, matchEntries) {
  if (matchEntries.length === 0) {
    container.innerHTML = `
      <p class="muted">No matches yet. Play with a friend until you both like the same title — they’ll land here.</p>`;
    return;
  }

  const { visible, total, capped } = capLibraryEntries(matchEntries);

  container.innerHTML = `
    <div class="library-toolbar">
      <p class="muted">${capped
        ? `${visible.length} of ${total} titles you matched on`
        : `${total} title${total === 1 ? "" : "s"} you matched on`}</p>
      ${visible.length > 1
        ? `<button type="button" class="btn btn-secondary btn-small" id="settle-random">Pick one for us</button>`
        : ""}
    </div>
    ${capped ? plusHistoryNudgeHtml(total, "matches") : ""}
    <div id="library-grid" class="results-grid"><p class="muted">Loading…</p></div>`;

  bindPlusNudge(container);

  document.getElementById("settle-random")?.addEventListener("click", async () => {
    const [key, meta] = visible[Math.floor(Math.random() * visible.length)];
    const { id, mediaType } = parseMediaKey(key);
    const movie = await fetchMovieSummary(id, mediaType);
    settleOnTitle(key, movie, [...(meta.with || [])].join(", "));
  });

  await fillLibraryGrid(
    document.getElementById("library-grid"),
    visible.map(([key, meta]) => ({
      key,
      subtitle: `Matched with ${[...meta.with].join(", ") || "friends"}`,
      withNames: [...meta.with].join(", "),
      showSettle: true,
    }))
  );
}

async function renderLibraryLikes(container, likeEntries) {
  if (likeEntries.length === 0) {
    container.innerHTML = `<p class="muted">No likes yet — swipe right in a game and they’ll show up here.</p>`;
    return;
  }

  const { visible, total, capped } = capLibraryEntries(likeEntries);

  container.innerHTML = `
    <div class="library-toolbar">
      <p class="muted">${capped
        ? `${visible.length} of ${total} titles you’ve liked`
        : `${total} title${total === 1 ? "" : "s"} you’ve liked`}</p>
      ${visible.length > 1
        ? `<button type="button" class="btn btn-secondary btn-small" id="settle-random-likes">Settle on one</button>`
        : ""}
    </div>
    ${capped ? plusHistoryNudgeHtml(total, "likes") : ""}
    <div id="library-grid" class="results-grid"><p class="muted">Loading…</p></div>`;

  bindPlusNudge(container);

  document.getElementById("settle-random-likes")?.addEventListener("click", async () => {
    const [key, meta] = visible[Math.floor(Math.random() * visible.length)];
    const { id, mediaType } = parseMediaKey(key);
    const movie = await fetchMovieSummary(id, mediaType);
    settleOnTitle(key, movie, [...(meta.with || [])].join(", "));
  });

  await fillLibraryGrid(
    document.getElementById("library-grid"),
    visible.map(([key, meta]) => ({
      key,
      subtitle: meta.with.size
        ? `Also liked with ${[...meta.with].join(", ")}`
        : `Liked in ${meta.count} game${meta.count === 1 ? "" : "s"}`,
      withNames: [...meta.with].join(", "),
      showSettle: true,
    }))
  );
}

async function renderLibraryFriends(container) {
  if (!state.friends.length) {
    try {
      const friends = await backend.friends(state.user.id);
      state.friends = friends.filter((f) => f.id !== state.user.id);
    } catch {
      state.friends = [];
    }
  }

  if (state.friends.length === 0) {
    container.innerHTML = `
      <p class="muted">Play with someone first — then you can sift through the movies you’ve both liked.</p>`;
    return;
  }

  const friend = state.friends.find((f) => f.id === state.libraryFriendId) || null;

  container.innerHTML = `
    <label class="library-friend-label" for="library-friend">Friend</label>
    <select id="library-friend" class="library-friend-select">
      <option value="">Choose a friend…</option>
      ${state.friends.map((f) => `
        <option value="${f.id}" ${friend?.id === f.id ? "selected" : ""}>${esc(f.username || "Player")}</option>
      `).join("")}
    </select>
    <div id="friend-library-body"><p class="muted">Pick a friend to see titles you’ve both liked.</p></div>`;

  document.getElementById("library-friend").addEventListener("change", (event) => {
    state.libraryFriendId = event.target.value ? Number(event.target.value) : null;
    renderLibraryFriends(container);
  });

  if (!friend) return;

  const body = document.getElementById("friend-library-body");
  body.innerHTML = `<p class="muted">Loading movies with ${esc(friend.username)}…</p>`;

  let shared = [];
  let mine = [];
  let theirs = [];
  try {
    const data = await backend.friendsMovieIds(state.user.id, friend.id);
    shared = normalizeMediaKeyList(data.ourLikedMovieIds || []);
    mine = normalizeMediaKeyList(data.myLikedMovieIds || []);
    theirs = normalizeMediaKeyList(data.friendsLikedMovieIds || []);
  } catch {
    body.innerHTML = `<p class="muted">Couldn't load shared likes. Try again.</p>`;
    return;
  }

  body.innerHTML = `
    <div class="library-toolbar">
      <p class="muted"><strong>${shared.length}</strong> in common · you liked ${mine.length} · ${esc(friend.username)} liked ${theirs.length}</p>
    </div>
    ${shared.length >= 2
      ? `<button type="button" class="btn btn-primary" id="sift-with-friend">Narrow it down together</button>
         <p class="hint">Starts a first-match game using only the movies you’ve both already liked.</p>`
      : shared.length === 1
        ? `<button type="button" class="btn btn-primary" id="settle-shared-one">That’s the one — settle</button>`
        : `<p class="muted">No shared likes yet. Play a game with ${esc(friend.username)} first.</p>`}
    ${shared.length > 1
      ? `<button type="button" class="btn btn-ghost btn-small" id="settle-random-shared">Pick one for us</button>`
      : ""}
    <div id="library-grid" class="results-grid"></div>`;

  document.getElementById("sift-with-friend")?.addEventListener("click", async (event) => {
    event.target.disabled = true;
    await startCurateGameWithFriend(friend.id, shared);
  });

  document.getElementById("settle-shared-one")?.addEventListener("click", async () => {
    const key = shared[0];
    const { id, mediaType } = parseMediaKey(key);
    settleOnTitle(key, await fetchMovieSummary(id, mediaType), friend.username);
  });

  document.getElementById("settle-random-shared")?.addEventListener("click", async () => {
    const key = shared[Math.floor(Math.random() * shared.length)];
    const { id, mediaType } = parseMediaKey(key);
    settleOnTitle(key, await fetchMovieSummary(id, mediaType), friend.username);
  });

  if (shared.length === 0) return;

  await fillLibraryGrid(
    document.getElementById("library-grid"),
    shared.slice(0, 40).map((key) => ({
      key,
      subtitle: `You & ${friend.username} both liked this`,
      withNames: friend.username,
      showSettle: true,
    }))
  );
}

async function startCurateGameWithFriend(friendId, keys) {
  if (!keys?.length) {
    toast("Need shared likes to narrow down.");
    return;
  }
  try {
    const values = { ...defaultGameValues(), curateKeys: keys.slice(0, 40), mode: "first_match" };
    const query = buildDiscoverQuery(values);
    const game = await backend.upsertGame({
      entry_code: generateEntryCode(),
      query: JSON.stringify(query),
      user_id: state.user.id,
      providers: state.user.providers || [],
      mode: "first_match",
    });
    await inviteFriendToGame(friendId, game.id);
    toast("Invite sent — swipe your shared likes until one wins.");
    startGame(game);
  } catch {
    toast("Couldn't start that sift session.");
  }
}

function settleOnTitle(key, movie, withNames = "") {
  if (!key) return;
  saveSettledPick({
    key,
    title: movie?.title || "Tonight’s pick",
    withNames: withNames || "",
    at: Date.now(),
  });
  renderSettledBanner();
  toast(`Settled: ${movie?.title || "tonight’s pick"}`);
  if (movie) openMovieModal(movie.id, movie.media_type);
}

async function fillLibraryGrid(grid, items) {
  if (!grid) return;
  if (!items.length) {
    grid.innerHTML = "";
    return;
  }

  grid.innerHTML = `<p class="muted">Loading movies…</p>`;
  const resolved = [];
  for (const item of items) {
    const { id, mediaType } = parseMediaKey(item.key);
    const movie = await fetchMovieSummary(id, mediaType);
    if (!movie) continue;
    resolved.push({ item, movie, id, mediaType });
  }

  if (!grid.isConnected) return;
  if (!resolved.length) {
    grid.innerHTML = `<p class="muted">Couldn't load those titles.</p>`;
    return;
  }

  grid.innerHTML = resolved.map(({ item, movie, mediaType }) => {
    const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
    const poster = posterUrl(movie.poster_path, "w342");
    const media = movie.media_type || mediaType || "movie";
    const providers = preferredFlatrateProviders(movie);
    const watchLabel = providers[0] ? `Watch on ${providers[0].provider_name}` : "Watch tonight";
    return `
      <article class="result-card actionable" data-id="${esc(item.key)}" data-media="${media}" data-with="${esc(item.withNames || "")}">
        <button type="button" class="result-card-main" data-open-match>
          ${poster ? `<img src="${poster}" alt="${esc(movie.title)}">` : `<div class="poster-missing">${esc(movie.title)}</div>`}
          <div class="result-info">
            <strong>${esc(movie.title)}</strong>
            <span class="muted">${esc(item.subtitle || `${year} · ★ ${movie.vote_average ? movie.vote_average.toFixed(1) : "–"}`)}</span>
          </div>
        </button>
        <div class="match-actions compact">
          ${item.showSettle
            ? `<button type="button" class="btn btn-secondary btn-small" data-settle>Tonight</button>`
            : ""}
          ${watchTonightUrl(movie)
            ? `<a class="btn btn-primary btn-small" href="${esc(watchTonightUrl(movie))}" target="_blank" rel="noopener noreferrer">${esc(watchLabel)}</a>`
            : ""}
          <button type="button" class="btn btn-ghost btn-small" data-share-match>Share</button>
        </div>
      </article>`;
  }).join("");

  [...grid.querySelectorAll(".result-card")].forEach((card, index) => {
    const { item, movie, id, mediaType } = resolved[index];
    card.querySelector("[data-open-match]")?.addEventListener("click", () => openMovieModal(id, mediaType));
    card.querySelector("[data-settle]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      settleOnTitle(item.key, movie, item.withNames || card.dataset.with || "");
    });
    bindMatchActions(card, movie);
  });
}

boot();

document.getElementById("invite-accept")?.addEventListener("click", () => {
  const popup = document.getElementById("invite-popup");
  const id = Number(popup?.dataset.inviteId);
  if (id) acceptInvite(id);
});

document.getElementById("invite-decline")?.addEventListener("click", () => {
  const popup = document.getElementById("invite-popup");
  const id = Number(popup?.dataset.inviteId);
  if (id) declineInvite(id);
});
