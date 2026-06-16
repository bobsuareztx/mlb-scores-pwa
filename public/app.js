const SCHEDULE_API = "https://statsapi.mlb.com/api/v1/schedule";
const STANDINGS_API = "https://statsapi.mlb.com/api/v1/standings";
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
  scoresPanel: document.querySelector("#scoresPanel"),
  scoresTab: document.querySelector("#scoresTab"),
  standingsBoard: document.querySelector("#standingsBoard"),
  standingsLabel: document.querySelector("#standingsLabel"),
  standingsPanel: document.querySelector("#standingsPanel"),
  standingsPill: document.querySelector("#standingsPill"),
  standingsTab: document.querySelector("#standingsTab"),
  template: document.querySelector("#gameTemplate"),
};

let activeView = "scores";
let refreshTimer;
let scoresAbortController;
let standingsAbortController;
let standingsLoaded = false;

const dateFormatter = new Intl.DateTimeFormat("en-US", {
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
  return dateFormatter.format(dateFromValue(value));
}

function isToday(value) {
  return value === centralToday();
}

function seasonForToday() {
  return centralToday().slice(0, 4);
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

function personName(person) {
  return person?.fullName || person?.name || "";
}

function pitcherRows(game) {
  const group = statusGroup(game);
  const awayProbable = personName(game.teams?.away?.probablePitcher);
  const homeProbable = personName(game.teams?.home?.probablePitcher);

  if (group === "Upcoming") {
    if (!awayProbable && !homeProbable) return [["Probables", "TBD"]];
    return [
      [`${teamAbbr(game.teams?.away)} SP`, awayProbable || "TBD"],
      [`${teamAbbr(game.teams?.home)} SP`, homeProbable || "TBD"],
    ];
  }

  if (group === "Live") {
    const pitcher = personName(game.linescore?.defense?.pitcher);
    const batter = personName(game.linescore?.offense?.batter);
    return [
      pitcher ? ["Pitching", pitcher] : null,
      batter ? ["At bat", batter] : null,
    ].filter(Boolean);
  }

  return [
    personName(game.decisions?.winner) ? ["W", personName(game.decisions.winner)] : null,
    personName(game.decisions?.loser) ? ["L", personName(game.decisions.loser)] : null,
    personName(game.decisions?.save) ? ["S", personName(game.decisions.save)] : null,
  ].filter(Boolean);
}

function renderPitchers(container, game) {
  container.replaceChildren();

  for (const [label, value] of pitcherRows(game)) {
    const row = document.createElement("div");
    const rowLabel = document.createElement("span");
    const rowValue = document.createElement("span");

    row.className = "pitcher-row";
    rowLabel.textContent = label;
    rowValue.textContent = value;
    row.append(rowLabel, rowValue);
    container.append(row);
  }
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
  renderPitchers(card.querySelector(".pitchers"), game);
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
  els.scoreboard.replaceChildren();

  if (!games.length) {
    renderEmpty(dateValue);
    return;
  }

  const groups = ["Live", "Upcoming", "Final"];

  for (const groupName of groups) {
    const groupGames = games.filter((game) => statusGroup(game) === groupName);
    if (!groupGames.length) continue;

    const section = document.createElement("section");
    const title = document.createElement("h2");

    section.className = "group";
    section.setAttribute("aria-label", `${groupName} games`);
    title.className = "group-title";
    title.textContent = groupName;
    section.append(title);
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
  scoresAbortController?.abort();
  scoresAbortController = new AbortController();

  setLoading(dateValue);

  const params = new URLSearchParams({
    sportId: "1",
    date: dateValue,
    hydrate: "linescore,team,venue,probablePitcher,decisions",
  });

  try {
    const response = await fetch(`${SCHEDULE_API}?${params}`, {
      signal: scoresAbortController.signal,
    });

    if (!response.ok) throw new Error(`MLB returned HTTP ${response.status}.`);

    const data = await response.json();
    const games = data.dates?.flatMap((date) => date.games || []) || [];

    renderGames(games, dateValue);
    setRefreshState(games, dateValue);

    if (isToday(dateValue) && activeView === "scores") {
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

const DIVISION_LABELS = new Map([
  [200, "American League West"],
  [201, "American League East"],
  [202, "American League Central"],
  [203, "National League West"],
  [204, "National League East"],
  [205, "National League Central"],
]);

const DIVISION_BY_TEAM = new Map([
  ["Yankees", "American League East"],
  ["Blue Jays", "American League East"],
  ["Orioles", "American League East"],
  ["Rays", "American League East"],
  ["Red Sox", "American League East"],
  ["White Sox", "American League Central"],
  ["Guardians", "American League Central"],
  ["Tigers", "American League Central"],
  ["Royals", "American League Central"],
  ["Twins", "American League Central"],
  ["Angels", "American League West"],
  ["Astros", "American League West"],
  ["Athletics", "American League West"],
  ["Mariners", "American League West"],
  ["Rangers", "American League West"],
  ["Braves", "National League East"],
  ["Marlins", "National League East"],
  ["Mets", "National League East"],
  ["Nationals", "National League East"],
  ["Phillies", "National League East"],
  ["Brewers", "National League Central"],
  ["Cardinals", "National League Central"],
  ["Cubs", "National League Central"],
  ["Pirates", "National League Central"],
  ["Reds", "National League Central"],
  ["D-backs", "National League West"],
  ["Dodgers", "National League West"],
  ["Giants", "National League West"],
  ["Padres", "National League West"],
  ["Rockies", "National League West"],
]);

function divisionTitle(record) {
  const id = Number(record.division?.id);
  const apiName = record.division?.name || "";
  const firstTeam = record.teamRecords?.[0]?.team?.teamName || "";

  if (DIVISION_LABELS.has(id)) return DIVISION_LABELS.get(id);
  if (DIVISION_BY_TEAM.has(firstTeam)) return DIVISION_BY_TEAM.get(firstTeam);
  if (apiName && apiName.toLowerCase() !== "division") return apiName;
  return "Division";
}

function divisionSortValue(record) {
  const title = divisionTitle(record);
  const leagueRank = title.includes("American") ? 0 : 1;
  const divisionRank = title.includes("East") ? 0 : title.includes("Central") ? 1 : 2;
  return leagueRank * 10 + divisionRank;
}

function divisionDisplayTitle(record) {
  return divisionTitle(record)
    .replace("American League", "AL")
    .replace("National League", "NL");
}

function splitRecord(teamRecord, type) {
  const split = teamRecord.records?.splitRecords?.find((item) => item.type === type);
  return split ? `${split.wins}-${split.losses}` : "-";
}

function renderStandings(records) {
  els.standingsBoard.replaceChildren();

  if (!records.length) {
    els.standingsBoard.innerHTML = `
      <section class="standings-empty">
        <strong>No standings found</strong>
        <p>MLB did not return current standings.</p>
      </section>
    `;
    return;
  }

  const sortedRecords = [...records].sort((a, b) => divisionSortValue(a) - divisionSortValue(b));

  for (const record of sortedRecords) {
    const card = document.createElement("article");
    const heading = document.createElement("h2");
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");

    card.className = "standings-card";
    heading.textContent = divisionDisplayTitle(record);
    table.className = "standings-table";
    thead.innerHTML = "<tr><th>Team</th><th>W</th><th>L</th><th>Pct</th><th>GB</th><th>L10</th><th>Strk</th></tr>";

    for (const teamRecord of record.teamRecords || []) {
      const row = document.createElement("tr");
      const values = [
        teamRecord.team?.teamName || teamRecord.team?.name || "Team",
        teamRecord.leagueRecord?.wins ?? "-",
        teamRecord.leagueRecord?.losses ?? "-",
        teamRecord.leagueRecord?.pct || "-",
        teamRecord.gamesBack || "-",
        splitRecord(teamRecord, "lastTen"),
        teamRecord.streak?.streakCode || "-",
      ];

      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = String(value);
        row.append(cell);
      }

      tbody.append(row);
    }

    table.append(thead, tbody);
    card.append(heading, table);
    els.standingsBoard.append(card);
  }
}

function renderStandingsError(message) {
  els.standingsBoard.innerHTML = `
    <section class="standings-empty">
      <strong>Standings did not load</strong>
      <p>${message}</p>
    </section>
  `;
}

function setStandingsLoading() {
  els.standingsLabel.textContent = "Fetching current divisions...";
  els.standingsPill.textContent = seasonForToday();
}

function setStandingsReady() {
  const now = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: CENTRAL_TIME_ZONE,
  }).format(new Date());

  els.standingsLabel.textContent = `Updated ${now} CT`;
  els.standingsPill.textContent = seasonForToday();
}

async function loadStandings({ force = false } = {}) {
  if (standingsLoaded && !force) return;

  standingsAbortController?.abort();
  standingsAbortController = new AbortController();
  setStandingsLoading();

  const params = new URLSearchParams({
    leagueId: "103,104",
    season: seasonForToday(),
    standingsTypes: "regularSeason",
  });

  try {
    const response = await fetch(`${STANDINGS_API}?${params}`, {
      signal: standingsAbortController.signal,
    });

    if (!response.ok) throw new Error(`MLB returned HTTP ${response.status}.`);

    const data = await response.json();
    renderStandings(data.records || []);
    setStandingsReady();
    standingsLoaded = true;
  } catch (error) {
    if (error.name === "AbortError") return;
    renderStandingsError(`${error.message} Try refresh again.`);
    els.standingsLabel.textContent = "Update failed";
  }
}

function setActiveView(view) {
  activeView = view;
  const scoresActive = view === "scores";

  els.scoresPanel.classList.toggle("active", scoresActive);
  els.standingsPanel.classList.toggle("active", !scoresActive);
  els.scoresTab.classList.toggle("active", scoresActive);
  els.standingsTab.classList.toggle("active", !scoresActive);
  els.scoresTab.setAttribute("aria-selected", String(scoresActive));
  els.standingsTab.setAttribute("aria-selected", String(!scoresActive));
  clearTimeout(refreshTimer);

  if (scoresActive) {
    if (isToday(els.dateInput.value)) refreshTimer = window.setTimeout(loadScores, REFRESH_MS);
  } else {
    loadStandings();
  }
}

els.refreshButton.addEventListener("click", () => {
  if (activeView === "scores") {
    loadScores();
  } else {
    loadStandings({ force: true });
  }
});
els.dateInput.addEventListener("change", loadScores);
els.prevDay.addEventListener("click", () => setDate(addDays(els.dateInput.value, -1)));
els.nextDay.addEventListener("click", () => setDate(addDays(els.dateInput.value, 1)));
els.scoresTab.addEventListener("click", () => setActiveView("scores"));
els.standingsTab.addEventListener("click", () => setActiveView("standings"));

window.addEventListener("focus", () => {
  if (activeView === "scores" && isToday(els.dateInput.value)) loadScores();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

setDate(centralToday());
