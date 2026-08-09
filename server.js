/**
 * MichBen Ciné Quizz — serveur de jeu (MVP)
 * Node 18+ / Express / Socket.IO
 *
 *   npm install && npm start   →  http://localhost:3000
 *   Interface d'administration →  http://localhost:3000/admin.html
 *
 * Les films sont stockés dans movies.json (éditable via l'admin).
 * L'état des parties est en mémoire : Redis en production.
 */

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { readFileSync, writeFileSync } from "fs";
import crypto from "crypto";
import { mountAuth, userFromCookie, addRankedPoints,
         spendCredits, grantCredits, getCredits, CREDITS_PER_GAME,
         listUsers, adminUpdateUser, adminDeleteUser, grantAll,
         grantPoints, getPoints, exchangePoints,
         marquerEnLigne, marquerHorsLigne, estEnLigne, nombreEnLigne } from "./auth-x.js";

const app = express();
app.use(express.json());
/**
 * Les pages HTML ne doivent jamais rester en cache : sinon un joueur garde
 * l'ancienne version après une mise à jour et croit le jeu cassé.
 * Le reste (images, polices) peut être mis en cache sans risque.
 */
app.use(express.static("public", {
  setHeaders(res, chemin) {
    res.setHeader("Cache-Control",
      chemin.endsWith(".html") ? "no-cache, must-revalidate" : "public, max-age=86400");
  },
}));
mountAuth(app);                       // /auth/x/login, /auth/x/callback, /api/me, /api/leaderboard
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const CONFIG = {
  ROUND_DURATION_MS: 60_000,
  BASE_POINTS: 1000,
  HINT_COSTS: { letters: 150, year: 100, director: 200, actors: 300, poster: 250 },  // en points
  HINT_CREDITS: { letters: 1, year: 1, director: 1, actors: 2, poster: 2 },         // en crédits
  MAX_PLAYERS: 16,
  GRACE_AFTER_FIRST_MS: 15_000,   // délai laissé aux autres après la première bonne réponse
  POINTS_PAR_TICKET: 250,         // taux de conversion points → tickets bonus
  CHOICE_RATIO: 1,                // le clic est le seul mode de réponse : score plein
  TIP_URL: process.env.TIP_URL || "https://buymeacoffee.com/votre-pseudo",
};

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "michben-admin"; // à changer avant toute mise en ligne
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // sans I, O, 0, 1

/* ------------------------------------------------------------------ */
/* Catalogue de films (persisté dans movies.json)                      */
/* ------------------------------------------------------------------ */

const MOVIES_FILE = new URL("./movies.json", import.meta.url);
let movies = JSON.parse(readFileSync(MOVIES_FILE, "utf8"));

/** Niveau déduit de la notoriété : un film très voté est facile à reconnaître. */
const niveauDepuisVotes = (v = 0) => (v >= 8000 ? "facile" : v >= 2500 ? "moyen" : "difficile");

// les anciens catalogues n'ont ni niveau ni activation : on les complète
for (const m of movies) {
  if (!m.difficulty) m.difficulty = niveauDepuisVotes(m.votes);
  if (m.enabled === undefined) m.enabled = true;
}
const saveMovies = () => writeFileSync(MOVIES_FILE, JSON.stringify(movies, null, 2));

function requireAdmin(req, res, next) {
  if (req.get("x-admin-token") !== ADMIN_TOKEN) return res.status(401).json({ error: "UNAUTHORIZED" });
  next();
}

app.get("/api/movies", requireAdmin, (_req, res) => res.json(movies));

/** Active ou désactive des films en lot, selon niveau et note minimale. */
app.post("/api/admin/movies/bulk", requireAdmin, (req, res) => {
  const { difficulty, minRating, enabled } = req.body;
  let touched = 0;
  for (const m of movies) {
    if (difficulty && difficulty !== "tous" && m.difficulty !== difficulty) continue;
    if (minRating && (m.rating || 0) < Number(minRating)) continue;
    m.enabled = enabled !== false;
    touched++;
  }
  saveMovies();
  res.json({ touched, actifs: movies.filter((m) => m.enabled).length });
});

app.get("/api/admin/stats", requireAdmin, (_req, res) => {
  const parNiveau = {};
  for (const n of ["facile", "moyen", "difficile"])
    parNiveau[n] = {
      total: movies.filter((m) => m.difficulty === n).length,
      actifs: movies.filter((m) => m.difficulty === n && m.enabled).length,
    };
  res.json({ total: movies.length, actifs: movies.filter((m) => m.enabled).length, parNiveau });
});

/* ---------- administration des joueurs ---------- */

app.get("/api/admin/users", requireAdmin, (_req, res) => res.json(listUsers()));

app.put("/api/admin/users/:id", requireAdmin, (req, res) => {
  const user = adminUpdateUser(req.params.id, req.body);
  if (!user) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(user);
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) =>
  adminDeleteUser(req.params.id) ? res.status(204).end() : res.status(404).json({ error: "NOT_FOUND" })
);

app.post("/api/admin/grant-all", requireAdmin, (req, res) => {
  const amount = Math.round(Number(req.body.amount) || 0);
  if (!amount) return res.status(400).json({ error: "AMOUNT_REQUIRED" });
  res.json({ users: grantAll(amount), amount });
});

app.post("/api/movies", requireAdmin, (req, res) => {
  const movie = sanitizeMovie(req.body);
  if (!movie.title || !movie.synopsis) return res.status(400).json({ error: "TITLE_AND_SYNOPSIS_REQUIRED" });
  movie.id = Math.max(0, ...movies.map((m) => m.id)) + 1;
  movies.push(movie);
  saveMovies();
  res.status(201).json(movie);
});

app.put("/api/movies/:id", requireAdmin, (req, res) => {
  const index = movies.findIndex((m) => m.id === Number(req.params.id));
  if (index === -1) return res.status(404).json({ error: "NOT_FOUND" });
  movies[index] = { ...sanitizeMovie(req.body), id: movies[index].id };
  saveMovies();
  res.json(movies[index]);
});

app.delete("/api/movies/:id", requireAdmin, (req, res) => {
  movies = movies.filter((m) => m.id !== Number(req.params.id));
  saveMovies();
  res.status(204).end();
});

function sanitizeMovie(body) {
  const answers = Array.isArray(body.acceptedAnswers)
    ? body.acceptedAnswers
    : String(body.acceptedAnswers || "").split(",");
  return {
    title: String(body.title || "").trim(),
    synopsis: String(body.synopsis || "").trim(),
    acceptedAnswers: [String(body.title || ""), ...answers].map((a) => a.trim()).filter(Boolean),
    year: Number(body.year) || null,
    director: String(body.director || "").trim(),
    actors: String(body.actors || "").trim(),
    poster: String(body.poster || "").trim(),
    still: String(body.still || "").trim(),
    rating: Number(body.rating) || null,
    votes: Number(body.votes) || 0,
    difficulty: ["facile", "moyen", "difficile"].includes(body.difficulty)
      ? body.difficulty : niveauDepuisVotes(Number(body.votes) || 0),
    enabled: body.enabled !== false,
  };
}

/* ------------------------------------------------------------------ */
/* Premium : suppression de la publicité                               */
/* ------------------------------------------------------------------ */

/**
 * ATTENTION — implémentation de démonstration.
 * En production : Stripe Checkout côté serveur, statut premium écrit en base
 * depuis le WEBHOOK Stripe (jamais depuis le client), et licence liée au
 * compte utilisateur. Ici, une licence signée est délivrée sans paiement réel
 * pour que le flux soit testable de bout en bout.
 */
const LICENSE_SECRET = process.env.LICENSE_SECRET || "dev-secret-a-remplacer";
const signLicense = (id) =>
  `${id}.${crypto.createHmac("sha256", LICENSE_SECRET).update(id).digest("hex").slice(0, 24)}`;
const verifyLicense = (lic) => {
  const [id, sig] = String(lic || "").split(".");
  return Boolean(id && sig && signLicense(id) === `${id}.${sig}`);
};

app.get("/api/presence", (_req, res) => res.json({ enLigne: nombreEnLigne() }));

app.get("/api/config", (_req, res) => res.json({
  tipUrl: CONFIG.TIP_URL, maxPlayers: CONFIG.MAX_PLAYERS, pointsParTicket: CONFIG.POINTS_PAR_TICKET,
}));

/** Espace échange : points gagnés → tickets bonus. */
app.post("/api/exchange", (req, res) => {
  const user = userFromCookie(req.headers.cookie);
  if (!user) return res.status(401).json({ error: "NOT_AUTHENTICATED" });

  const result = exchangePoints(user.id, req.body.points, CONFIG.POINTS_PAR_TICKET);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post("/api/premium/checkout", (_req, res) => {
  // TODO : créer une session Stripe Checkout et renvoyer session.url
  // const session = await stripe.checkout.sessions.create({...});
  res.json({ mode: "demo", license: signLicense(crypto.randomUUID()) });
});

app.post("/api/premium/verify", (req, res) => res.json({ premium: verifyLicense(req.body.license) }));

/* ------------------------------------------------------------------ */
/* Utilitaires de jeu                                                  */
/* ------------------------------------------------------------------ */

const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

/**
 * Quatre propositions : la bonne, plus trois leurres pris de préférence
 * dans la même décennie — sinon le bon titre saute aux yeux.
 */
function buildChoices(movie) {
  const actifs = movies.filter((m) => m.enabled !== false);
  const memeEpoque = actifs.filter(
    (m) => m.id !== movie.id && m.year && movie.year && Math.abs(m.year - movie.year) <= 12
  );
  const vivier = melange(memeEpoque.length >= 3 ? memeEpoque : actifs.filter((m) => m.id !== movie.id));

  const leurres = [];
  for (const m of vivier) {
    if (leurres.length >= 3) break;
    if (leurres.some((l) => l.title === m.title) || m.title === movie.title) continue;
    leurres.push(m);
  }

  return melange([movie, ...leurres].map((m) => ({ id: m.id, title: m.title })));
}

/** Motif du titre : un tiret par lettre, espaces et ponctuation conservés. */
function titlePattern(title) {
  return [...title].map((c) => (/[\p{L}\p{N}]/u.test(c) ? "–" : c)).join("");
}

/**
 * Mélange de Fisher-Yates : chaque permutation est équiprobable.
 * (sort(() => Math.random() - 0.5) paraît équivalent mais ne l'est pas :
 *  le comparateur est incohérent et l'ordre final reste biaisé.)
 */
function melange(tableau) {
  const t = [...tableau];
  for (let i = t.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [t[i], t[j]] = [t[j], t[i]];
  }
  return t;
}

/** Normalisation permissive : casse, accents, ponctuation, article initial. */
function normalize(str) {
  return String(str)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/^(le |la |les |the |a |an )/, "")
    .trim();
}

/** Score = base × facteur temps − coût des indices consommés. */
function computeScore({ elapsedMs, hintsUsed }) {
  const timeFactor = Math.max(0.1, 1 - elapsedMs / CONFIG.ROUND_DURATION_MS);
  const penalty = hintsUsed.reduce((sum, h) => sum + (CONFIG.HINT_COSTS[h] ?? 0), 0);
  return Math.max(50, Math.round(CONFIG.BASE_POINTS * timeFactor) - penalty);
}

function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    mode: room.mode,
    difficulty: room.difficulty,
    roundIndex: room.roundIndex,
    players: [...room.players.values()].map((p) => ({
      id: p.id, pseudo: p.pseudo, avatar: p.avatar, score: p.score,
      team: p.team, hasAnswered: p.hasAnswered,
    })),
    teams: room.mode === "teams" ? teamScores(room) : null,
  };
}

/** Score cumulé par équipe, utilisé en mode équipes. */
function teamScores(room) {
  const totals = { A: 0, B: 0 };
  for (const p of room.players.values()) if (p.team) totals[p.team] += p.score;
  return totals;
}

/* ------------------------------------------------------------------ */
/* Boucle de jeu                                                       */
/* ------------------------------------------------------------------ */

function startRound(room) {
  clearTimeout(room.graceTimer);
  room.graceTimer = null;
  const movie = room.playlist[room.roundIndex];
  if (!movie) return endGame(room);

  room.status = "playing";
  room.currentMovie = movie;
  room.choices = buildChoices(movie);
  room.startedAt = Date.now();
  for (const p of room.players.values()) { p.hasAnswered = false; p.hints = []; }

  io.to(room.code).emit("round:start", {
    roundIndex: room.roundIndex,
    total: room.playlist.length,
    synopsis: movie.synopsis,        // le titre et l'affiche ne partent jamais au client
    duration: CONFIG.ROUND_DURATION_MS,
    hintCosts: CONFIG.HINT_COSTS,
    hintCredits: CONFIG.HINT_CREDITS,
    choices: room.choices,
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room), CONFIG.ROUND_DURATION_MS);
}

function endRound(room) {
  if (room.status !== "playing") return;   // évite un double appel timer + grâce
  clearTimeout(room.timer);
  clearTimeout(room.graceTimer);
  room.graceTimer = null;
  io.to(room.code).emit("round:end", {
    answer: room.currentMovie.title,
    poster: room.currentMovie.poster,   // affiche révélée seulement maintenant
    year: room.currentMovie.year,
    scores: publicState(room).players,
    isHost: room.hostId,
    mode: room.mode,
  });
  room.roundIndex++;
  room.status = "intermission";
  room.nextTimer = setTimeout(() => startRound(room), 6000);
}

function endGame(room) {
  room.status = "finished";
  const state = publicState(room);
  const ranking = state.players.sort((a, b) => b.score - a.score);
  for (const p of room.players.values()) {
    if (room.mode === "ranked") addRankedPoints(p.userId, p.score); // classement permanent
    grantPoints(p.userId, p.score);                                  // cagnotte échangeable
    grantCredits(p.userId, CREDITS_PER_GAME);
  }
  for (const p of room.players.values())
    io.to(p.id).emit("game:end", { ranking, mode: room.mode, teams: state.teams,
      credits: getCredits(p.userId), points: getPoints(p.userId) });
  // TODO : persister la partie et créditer les récompenses
}

/* ------------------------------------------------------------------ */
/* Événements Socket.IO                                                */
/* ------------------------------------------------------------------ */

io.use((socket, next) => {
  const user = userFromCookie(socket.handshake.headers.cookie);
  if (!user) return next(new Error("NOT_AUTHENTICATED"));   // aucune partie sans compte
  if (user.banned) return next(new Error("BANNED"));
  if (!user.pseudoChosen) return next(new Error("NO_PSEUDO")); // ni sans pseudo choisi
  socket.data.user = user;
  next();
});

io.on("connection", (socket) => {
  const user = socket.data.user;
  marquerEnLigne(user.id);
  io.emit("presence", { enLigne: nombreEnLigne() });

  socket.on("disconnect", () => {
    marquerHorsLigne(user.id);
    io.emit("presence", { enLigne: nombreEnLigne() });
  });

  socket.on("room:create", ({ rounds, mode, difficulty }, cb) => {
    const vivier = movies.filter(
      (m) => m.enabled !== false &&
             (!difficulty || difficulty === "tous" || m.difficulty === difficulty)
    );
    if (vivier.length === 0) return cb?.({ ok: false, error: "NO_MOVIES" });

    const code = generateRoomCode();
    const count = Math.min(Number(rounds) || 10, vivier.length);
    const room = {
      code, hostId: socket.id, status: "lobby", roundIndex: 0,
      mode: ["solo", "ffa", "duel", "teams", "ranked"].includes(mode) ? mode : "ffa",
      players: new Map(),
      difficulty: difficulty || "tous",
      playlist: melange(vivier).slice(0, count),
      currentMovie: null, startedAt: null, timer: null, nextTimer: null, graceTimer: null,
    };
    rooms.set(code, room);
    joinRoom(socket, room, user);
    cb?.({ ok: true, code, state: publicState(room) });
    if (room.mode === "solo" || room.mode === "ranked") startRound(room); // le solo démarre immédiatement
  });

  socket.on("room:join", ({ code }, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    const limit = room.mode === "duel" ? 2 : CONFIG.MAX_PLAYERS;
    if (room.players.size >= limit) return cb?.({ ok: false, error: "ROOM_FULL" });
    if (room.status === "finished") return cb?.({ ok: false, error: "GAME_OVER" });

    const enCours = room.status !== "lobby";
    joinRoom(socket, room, user);
    if (enCours) room.players.get(socket.id).hasAnswered = true; // n'entre qu'à la manche suivante
    cb?.({ ok: true, code: room.code, state: publicState(room), waiting: enCours,
           roundIndex: room.roundIndex, total: room.playlist.length });
  });

  socket.on("team:choose", ({ code, team }) => {
    const room = rooms.get(code);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.status !== "lobby" || !["A", "B"].includes(team)) return;
    player.team = team;
    io.to(room.code).emit("room:update", publicState(room));
  });

  socket.on("game:start", ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.status !== "lobby") return;
    startRound(room);
  });

  socket.on("hint:buy", ({ code, type }, cb) => {
    const room = rooms.get(code);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.status !== "playing") return cb?.({ ok: false });
    if (!CONFIG.HINT_COSTS[type]) return cb?.({ ok: false, error: "UNKNOWN_HINT" });
    if (player.hints.includes(type)) return cb?.({ ok: false, error: "ALREADY_BOUGHT" });

    if (!spendCredits(player.userId, CONFIG.HINT_CREDITS[type]))
      return cb?.({ ok: false, error: "NO_CREDITS" });

    player.hints.push(type);
    const value =
      type === "poster" ? (room.currentMovie.still || room.currentMovie.poster) // sans titre imprimé
    : type === "letters" ? titlePattern(room.currentMovie.title)
    : room.currentMovie[type];
    cb?.({ ok: true, type, value, credits: getCredits(player.userId) });
  });

  socket.on("answer:submit", ({ code, guess, choiceId }, cb) => {
    const room = rooms.get(code);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.status !== "playing" || player.hasAnswered) return cb?.({ ok: false });

    const parClic = choiceId !== undefined && choiceId !== null;
    const correct = parClic
      ? Number(choiceId) === room.currentMovie.id
      : room.currentMovie.acceptedAnswers.some((a) => normalize(a) === normalize(guess));

    // un clic est définitif : sinon il suffirait de cliquer les quatre cases
    if (!correct) {
      if (!parClic) return cb?.({ ok: true, correct: false });
      player.hasAnswered = true;
      io.to(room.code).emit("player:answered", { id: player.id, pseudo: player.pseudo, team: player.team, points: 0 });
      if ([...room.players.values()].every((p) => p.hasAnswered)) endRound(room);
      return cb?.({ ok: true, correct: false, final: true });
    }

    player.hasAnswered = true;
    let points = computeScore({ elapsedMs: Date.now() - room.startedAt, hintsUsed: player.hints });
    if (parClic) points = Math.max(30, Math.round(points * CONFIG.CHOICE_RATIO));
    player.score += points;

    cb?.({ ok: true, correct: true, points, movieId: room.currentMovie.id });
    io.to(room.code).emit("player:answered", { id: player.id, pseudo: player.pseudo, team: player.team, points });

    const tousTrouve = [...room.players.values()].every((p) => p.hasAnswered);
    if (tousTrouve) return endRound(room);

    // premier à trouver : les autres ont encore quelques secondes
    if (!room.graceTimer) {
      room.graceTimer = setTimeout(() => endRound(room), CONFIG.GRACE_AFTER_FIRST_MS);
      io.to(room.code).emit("round:grace", { ms: CONFIG.GRACE_AFTER_FIRST_MS, pseudo: player.pseudo });
    }
  });

  /** Chat réservé aux joueurs du salon. Les messages qui contiennent la
   *  réponse en cours sont bloqués : sinon le chat devient un anti-jeu. */
  socket.on("chat:send", ({ code, text }) => {
    const room = rooms.get(code);
    const player = room?.players.get(socket.id);
    if (!room || !player) return;

    const message = String(text || "").trim().slice(0, 200);
    if (!message) return;

    if (room.status === "playing" && room.currentMovie) {
      const said = normalize(message);
      const leaks = room.currentMovie.acceptedAnswers.some((a) => {
        const answer = normalize(a);
        return answer.length > 2 && said.includes(answer);
      });
      if (leaks) return socket.emit("chat:blocked");
    }

    io.to(room.code).emit("chat:message", {
      pseudo: player.pseudo, avatar: player.avatar, text: message, at: Date.now(),
    });
  });

  /** Un joueur qui a déjà répondu (ou qui joue seul) peut enchaîner. */
  socket.on("round:skip", ({ code }) => {
    const room = rooms.get(code);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.status !== "playing") return;
    if (["solo", "ranked"].includes(room.mode) || player.hasAnswered) endRound(room);
  });

  /** Enchaîner sans attendre la fin de l'entracte. */
  socket.on("round:next", ({ code }) => {
    const room = rooms.get(code);
    if (!room || !room.players.has(socket.id) || room.status !== "intermission") return;
    if (!["solo", "ranked"].includes(room.mode) && room.hostId !== socket.id) return; // l'hôte décide
    clearTimeout(room.nextTimer);
    startRound(room);
  });

  socket.on("room:leave", () => leaveAllRooms(socket));

  socket.on("disconnect", () => leaveAllRooms(socket));

  function leaveAllRooms(socket) {
    for (const room of rooms.values()) {
      if (!room.players.delete(socket.id)) continue;
      socket.leave(room.code);
      if (room.players.size === 0) {
        clearTimeout(room.timer); clearTimeout(room.nextTimer); clearTimeout(room.graceTimer);
        rooms.delete(room.code);
      } else {
        if (room.hostId === socket.id) room.hostId = [...room.players.keys()][0];
        io.to(room.code).emit("room:update", publicState(room));
      }
    }
  }
});

function joinRoom(socket, room, user) {
  room.players.set(socket.id, {
    id: socket.id,
    userId: user.id,
    pseudo: user.pseudo,
    avatar: user.avatar || "🎬",
    team: room.mode === "teams" ? balancedTeam(room) : null,
    score: 0, hints: [], hasAnswered: false,
  });
  socket.join(room.code);
  io.to(room.code).emit("room:update", publicState(room));
}

/** Place le nouvel arrivant dans l'équipe la moins nombreuse. */
function balancedTeam(room) {
  let a = 0, b = 0;
  for (const p of room.players.values()) p.team === "A" ? a++ : p.team === "B" ? b++ : null;
  return a <= b ? "A" : "B";
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, "0.0.0.0", () =>
  console.log(`MichBen Ciné Quizz → http://localhost:${PORT}  (admin : /admin.html)`)
);
