const API_BASE = "https://statsapi.mlb.com/api/v1/schedule";
const CENTRAL_TIME_ZONE = "America/Chicago";
const REFRESH_MS = 30000;

const els = {
  dateInput: document.querySelector("#dateInput"),
  dateLabel: document.querySelector("#dateLabel"),
  livePill: document.querySelector("#livePill"),
  nextDay: document.querySelector("#nextDay"),
  prevDay: document.querySelector("#prevDay"),
  refreshButton: document.querySelector("#refreshButton"),
  refreshLabel: document.querySelector("#refreshLabel"),
  scoreboard: document.querySelector("#scoreboard"),
  template: document.querySelector("#gameTemplate"),
};

let refreshTimer;
let abortController;

const formatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: CENTRAL_TIME_ZONE,
});

function centralToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: CENTRAL_TIME_ZONE,
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateFromValue(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function addDays(value, days) {
  const date = dateFromValue(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function prettyDate(value) {
  return formatter.format(dateFromValue(value));
}

function isToday(value) {
  return value === centralToday();
}

function statusGroup(game) {
  const detailed = game.status?.detailedState || "";
  const abstract = game.status?.abstractGameState || "";

  if (abstract === "Live") return "Live";
  if (abstract === "Final" || detailed === "Completed Early") return "Final";
  return "Upcoming";
}

function statusText(game) {
  const state = game.status?.detailedState || game.status?.abstractGameState || "Scheduled";
  if (statusGroup(game) !== "Upcoming") return state;

  const start = game.gameDate ? new Date(game.gameDate) : null;
  if (!start || Number.isNaN(start.getTime())) return state;

  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: CENTRAL_TIME_ZONE,
  }).format(start);

  return `${time} CT`;
}

function inningText(game) {
  const linescore = game.linescore || {};
  const state = statusGroup(game);

  if (state === "Live" && linescore.currentInning) {
    const half = linescore.inningHalf ? `${linescore.inningHalf} ` : "";
    return `${half}${linescore.currentInningOrdinal || linescore.currentInning}`;
  }

  if (state === "Final") return "Final";
  return statusText(game);
}

function gameDetail(game) {
  const linescore = game.linescore || {};
  const balls = linescore.balls;
  const strikes = linescore.strikes;
  const outs = linescore.outs;

  if (statusGroup(game) === "Live" && Number.isInteger(outs)) {
    const count = Number.isInteger(balls) && Number.isInteger(strikes) ? `${balls}-${strikes}, ` : "";
    return `${count}${outs} out${outs === 1 ? "" : "s"}`;
  }

  return game.teams?.away?.leagueRecord && game.teams?.home?.leagueRecord
    ? `${recordText(game.teams.away.leagueRecord)}  |  ${recordText(game.teams.home.leagueRecord)}`
    : game.status?.abstractGameState || "";
}

function recordText(record) {
  return `${record.wins}-${record.losses}`;
}

function teamName(teamSide) {
  return teamSide?.team?.teamName || teamSide?.team?.name || "Team";
}

function teamAbbr(teamSide) {
  const team = teamSide?.team || {};
  return (team.abbreviation || team.fileCode || teamName(teamSide).slice(0, 3)).toUpperCase();
}

function teamScore(teamSide, game) {
  const score = teamSide?.score;
  if (Number.isInteger(score)) return String(score);
  return statusGroup(game) === "Upcoming" ? "-" : "0";
}

function renderGame(game) {
  const card = els.template.content.firstElementChild.cloneNode(true);
  const group = statusGroup(game);
  const away = game.teams?.away;
  const home = game.teams?.home;
  const badge = card.querySelector(".badge");

  badge.textContent = group === "Live" ? "Live" : statusText(game);
  badge.classList.toggle("live", group === "Live");
  card.querySelector(".venue").textContent = game.venue?.name || "";
  card.querySelector(".away .abbr").textContent = teamAbbr(away);
  card.querySelector(".away .name").textContent = teamName(away);
  card.querySelector(".away .score").textContent = teamScore(away, game);
  card.querySelector(".home .abbr").textContent = teamAbbr(home);
  card.querySelector(".home .name").textContent = teamName(home);
  card.querySelector(".home .score").textContent = teamScore(home, game);
  card.querySelector(".inning").textContent = inningText(game);
  card.querySelector(".detail").textContent = gameDetail(game);

  return card;
}

function renderEmpty(dateValue) {
  els.scoreboard.innerHTML = `
    <section class="empty">
      <strong>No MLB games found</strong>
      <p>There are no major league games listed for ${prettyDate(dateValue)}.</p>
    </section>
  `;
}

function renderError(message) {
  els.scoreboard.innerHTML = `
    <section class="error">
      <strong>Scores did not load</strong>
      <p>${message}</p>
    </section>
  `;
}

function renderGames(games, dateValue) {
  els.scoreboard.innerHTML = "";

  if (!games.length) {
    renderEmpty(dateValue);
    return;
  }

  const groups = ["Live", "Upcoming", "Final"];

  for (const groupName of groups) {
    const groupGames = games.filter((game) => statusGroup(game) === groupName);
    if (!groupGames.length) continue;

    const section = document.createElement("section");
    section.className = "group";
    section.setAttribute("aria-label", `${groupName} games`);
    section.innerHTML = `<h2 class="group-title">${groupName}</h2>`;
    groupGames.forEach((game) => section.append(renderGame(game)));
    els.scoreboard.append(section);
  }
}

function setLoading(dateValue) {
  els.dateLabel.textContent = prettyDate(dateValue);
  els.refreshLabel.textContent = "Fetching games...";
  els.livePill.hidden = true;
}

function setRefreshState(games, dateValue) {
  const liveCount = games.filter((game) => statusGroup(game) === "Live").length;
  const now = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: CENTRAL_TIME_ZONE,
  }).format(new Date());

  els.dateLabel.textContent = prettyDate(dateValue);
  els.refreshLabel.textContent = `Updated ${now} CT`;
  els.livePill.textContent = liveCount ? `${liveCount} live` : "No live games";
  els.livePill.hidden = false;
}

async function loadScores() {
  const dateValue = els.dateInput.value;
  clearTimeout(refreshTimer);
  abortController?.abort();
  abortController = new AbortController();

  setLoading(dateValue);

  const params = new URLSearchParams({
    sportId: "1",
    date: dateValue,
    hydrate: "linescore,team,venue",
  });

  try {
    const response = await fetch(`${API_BASE}?${params}`, {
      signal: abortController.signal,
    });

    if (!response.ok) throw new Error(`MLB returned HTTP ${response.status}.`);

    const data = await response.json();
    const games = data.dates?.flatMap((date) => date.games || []) || [];

    renderGames(games, dateValue);
    setRefreshState(games, dateValue);

    if (isToday(dateValue)) {
      refreshTimer = window.setTimeout(loadScores, REFRESH_MS);
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    renderError(`${error.message} Check your connection and try refresh.`);
    els.refreshLabel.textContent = "Update failed";
    els.livePill.hidden = true;
  }
}

function setDate(value) {
  els.dateInput.value = value;
  loadScores();
}

els.refreshButton.addEventListener("click", loadScores);
els.dateInput.addEventListener("change", loadScores);
els.prevDay.addEventListener("click", () => setDate(addDays(els.dateInput.value, -1)));
els.nextDay.addEventListener("click", () => setDate(addDays(els.dateInput.value, 1)));

window.addEventListener("focus", () => {
  if (isToday(els.dateInput.value)) loadScores();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

setDate(centralToday());
