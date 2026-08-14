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
import { charger, sauver, initStockage, enBase } from "./db.js";
import { createRequire } from "module";
import { dirname, join } from "path";
import crypto from "crypto";
import { mountAuth, userFromCookie, addRankedPoints,
         spendCredits, grantCredits, getCredits, CREDITS_PER_GAME,
         listUsers, adminUpdateUser, adminDeleteUser, grantAll,
         grantPoints, getPoints, exchangePoints,
         marquerEnLigne, marquerHorsLigne, estEnLigne, nombreEnLigne,
         estModerateur, definirRole, ROLES, chargerUtilisateurs,
         relations, demanderAmi, accepterAmi, retirerAmi, bloquer,
         chercherJoueurs, statutRelation, estBloque, emailAValider,
         leaderboard, reinitialiserClassement, definirPhoto } from "./auth-x.js";

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
/**
 * Le moteur temps réel, servi sous un nom neutre depuis la bibliothèque
 * installée : rien à copier dans le dépôt, et les bloqueurs qui filtrent
 * le mot « socket.io » n'ont plus de nom à reconnaître.
 */
const MOTEUR = (() => {
  const require = createRequire(import.meta.url);
  // le paquet n'exporte pas ce chemin : on part du dossier du paquet
  const racine = dirname(require.resolve("socket.io/package.json"));
  return join(racine, "client-dist", "socket.io.min.js");
})();

app.get("/js/moteur.js", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.type("application/javascript").sendFile(MOTEUR, (err) => {
    if (err && !res.headersSent) res.status(404).send("// moteur introuvable");
  });
});

mountAuth(app);                       // /auth/x/login, /auth/x/callback, /api/me, /api/leaderboard
const httpServer = createServer(app);
/**
 * Le chemin par défaut « /socket.io » est filtré par de nombreux bloqueurs de
 * publicité, qui reconnaissent le nom. On expose donc le même service sous
 * « /rt », un nom neutre. Un seul serveur : tous les joueurs partagent
 * bien les mêmes salons.
 */
const io = new Server(httpServer, { cors: { origin: "*" }, path: "/rt" });

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Réglages du jeu, modifiables depuis la console d'administration.
 * Ils sont conservés en base : un changement survit aux redéploiements.
 */
const REGLAGES_DEFAUT = {
  roundDuration: 60,                 // secondes
  basePoints: 1000,
  creditsDepart: 12,
  creditsParPartie: 4,
  pointsParTicket: 250,
  saisonJours: 20,                   // durée d'une saison classée
  partiesClasseesParSaison: 5,       // parties classées autorisées par joueur
  graceApresPremier: 15,             // secondes
  indices: {
    letters:  { actif: true, points: 150, tickets: 1, libelle: "Nombre de lettres" },
    year:     { actif: true, points: 100, tickets: 1, libelle: "Année" },
    director: { actif: true, points: 200, tickets: 1, libelle: "Réalisateur" },
    actors:   { actif: true, points: 300, tickets: 2, libelle: "Acteurs" },
    poster:   { actif: true, points: 250, tickets: 2, libelle: "Photo du film",
                zoom: 160, cadrage: "center", flou: 0 },
  },
};

let REGLAGES = structuredClone(REGLAGES_DEFAUT);

const CONFIG = {
  get ROUND_DURATION_MS() { return REGLAGES.roundDuration * 1000; },
  get BASE_POINTS() { return REGLAGES.basePoints; },
  get HINT_COSTS() {
    return Object.fromEntries(Object.entries(REGLAGES.indices)
      .filter(([, v]) => v.actif).map(([k, v]) => [k, v.points]));
  },
  get HINT_CREDITS() {
    return Object.fromEntries(Object.entries(REGLAGES.indices)
      .filter(([, v]) => v.actif).map(([k, v]) => [k, v.tickets]));
  },
  get GRACE_AFTER_FIRST_MS() { return REGLAGES.graceApresPremier * 1000; },
  get POINTS_PAR_TICKET() { return REGLAGES.pointsParTicket; },
  MAX_PLAYERS: 16,
  CHOICE_RATIO: 1,                // le clic est le seul mode de réponse : score plein
  TIP_URL: process.env.TIP_URL || "https://buymeacoffee.com/votre-pseudo",
};

/**
 * Mot de passe d'administration.
 *
 * Il est stocké en base sous forme d'empreinte, ce qui permet de le changer
 * depuis la console sans redéployer. La variable ADMIN_TOKEN ne sert plus
 * qu'à la toute première ouverture, ou comme secours si la base est vide.
 */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "michben-admin";
let empreinteAdmin = null;   // chargée au démarrage

const hacherAdmin = (mdp, sel = crypto.randomBytes(16).toString("hex")) =>
  `${sel}:${crypto.scryptSync(mdp, sel, 64).toString("hex")}`;

function motDePasseAdminValide(mdp) {
  if (!mdp) return false;
  if (!empreinteAdmin) return mdp === ADMIN_TOKEN;      // aucun mot de passe encore défini
  const [sel, attendu] = empreinteAdmin.split(":");
  const calcule = crypto.scryptSync(mdp, sel, 64).toString("hex");
  return calcule.length === attendu.length &&
         crypto.timingSafeEqual(Buffer.from(calcule), Buffer.from(attendu));
}
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // sans I, O, 0, 1

/* ------------------------------------------------------------------ */
/* Catalogue de films (persisté dans movies.json)                      */
/* ------------------------------------------------------------------ */

const MOVIES_FILE = new URL("./movies.json", import.meta.url);
let movies = [];

/** Niveau déduit de la notoriété : un film très voté est facile à reconnaître. */
const niveauDepuisVotes = (v = 0) => (v >= 8000 ? "facile" : v >= 2500 ? "moyen" : "difficile");

/** Complète les catalogues anciens, sans niveau ni activation. */
function normaliserFilms() {
  for (const m of movies) {
    if (!m.difficulty) m.difficulty = niveauDepuisVotes(m.votes);
    if (m.enabled === undefined) m.enabled = true;
  }
}
const saveMovies = () => sauver("movies", movies, MOVIES_FILE);

/* ---------- signalements d'anomalies ---------- */

const REPORTS_FILE = new URL("./reports.json", import.meta.url);
let reports = [];
let palmares = [];   // podiums des saisons écoulées
const saveReports = () => sauver("reports", reports, REPORTS_FILE);

const MOTIFS = {
  spoiler: "Le synopsis révèle le titre",
  synopsis: "Synopsis incompréhensible ou trop court",
  image: "Image ou affiche incorrecte",
  reponse: "Mauvaise réponse acceptée",
  inapproprie: "Contenu inapproprié",
  autre: "Autre",
};

/** Accès réservé aux modérateurs (session) ou à la clé d'administration. */
function requireModerateur(req, res, next) {
  if (motDePasseAdminValide(req.get("x-admin-token"))) return next();
  const user = userFromCookie(req.headers.cookie);
  if (estModerateur(user)) { req.moderateur = user; return next(); }
  res.status(403).json({ error: "FORBIDDEN" });
}

function requireAdmin(req, res, next) {
  if (!motDePasseAdminValide(req.get("x-admin-token")))
    return res.status(401).json({ error: "UNAUTHORIZED" });
  next();
}

/** Change le mot de passe d'administration, après vérification de l'actuel. */
app.post("/api/admin/password", requireAdmin, (req, res) => {
  const nouveau = String(req.body.nouveau || "");
  if (nouveau.length < 8) return res.status(400).json({ error: "TROP_COURT" });
  if (nouveau === ADMIN_TOKEN) return res.status(400).json({ error: "TROP_EVIDENT" });

  empreinteAdmin = hacherAdmin(nouveau);
  sauver("adminPass", empreinteAdmin);
  res.json({ ok: true });
});

app.get("/api/admin/reglages", requireAdmin, (_req, res) => res.json(REGLAGES));

app.put("/api/admin/reglages", requireAdmin, (req, res) => {
  const r = req.body || {};
  const borne = (v, min, max, defaut) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaut;
  };

  REGLAGES.roundDuration    = borne(r.roundDuration, 10, 300, REGLAGES.roundDuration);
  REGLAGES.basePoints       = borne(r.basePoints, 100, 10000, REGLAGES.basePoints);
  REGLAGES.creditsDepart    = borne(r.creditsDepart, 0, 1000, REGLAGES.creditsDepart);
  REGLAGES.creditsParPartie = borne(r.creditsParPartie, 0, 100, REGLAGES.creditsParPartie);
  REGLAGES.pointsParTicket  = borne(r.pointsParTicket, 10, 100000, REGLAGES.pointsParTicket);
  REGLAGES.graceApresPremier= borne(r.graceApresPremier, 0, 120, REGLAGES.graceApresPremier);

  for (const [cle, valeurs] of Object.entries(r.indices || {})) {
    const cible = REGLAGES.indices[cle];
    if (!cible) continue;
    cible.actif   = valeurs.actif !== false;
    cible.points  = borne(valeurs.points, 0, 5000, cible.points);
    cible.tickets = borne(valeurs.tickets, 0, 50, cible.tickets);
    if (typeof valeurs.libelle === "string" && valeurs.libelle.trim())
      cible.libelle = valeurs.libelle.trim().slice(0, 40);
    if (cle === "poster") {
      cible.zoom = borne(valeurs.zoom, 100, 400, cible.zoom);
      cible.flou = borne(valeurs.flou, 0, 30, cible.flou);
      if (["center","top","bottom","left","right"].includes(valeurs.cadrage))
        cible.cadrage = valeurs.cadrage;
    }
  }

  // au moins un indice doit rester actif, sinon la boutique est vide
  if (!Object.values(REGLAGES.indices).some((i) => i.actif))
    REGLAGES.indices.year.actif = true;

  sauver("reglages", REGLAGES);
  res.json(REGLAGES);
});

app.post("/api/admin/reglages/defaut", requireAdmin, (_req, res) => {
  REGLAGES = structuredClone(REGLAGES_DEFAUT);
  sauver("reglages", REGLAGES);
  res.json(REGLAGES);
});

/** Indique si le mot de passe par défaut est encore en usage. */
app.get("/api/admin/etat", requireAdmin, (_req, res) =>
  res.json({ motDePasseParDefaut: !empreinteAdmin })
);

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

/** Réimporte movies.json du dépôt par-dessus le catalogue en base. */
app.post("/api/admin/movies/reimport", requireAdmin, async (_req, res) => {
  try {
    const { readFileSync } = await import("fs");
    const frais = JSON.parse(readFileSync(MOVIES_FILE, "utf8"));
    if (!Array.isArray(frais) || !frais.length) throw new Error("fichier vide");
    movies = frais;
    normaliserFilms();
    saveMovies();
    res.json({ ok: true, films: movies.length });
  } catch (e) {
    res.status(400).json({ error: "IMPORT_ECHOUE", detail: e.message });
  }
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

/** Cadrage spécifique à un film, ou null pour suivre le réglage global. */
function cadragePropre(valeur) {
  if (!valeur || valeur.suivreGlobal) return null;
  const borne = (v, min, max, defaut) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaut;
  };
  return {
    zoom: borne(valeur.zoom, 100, 400, 160),
    flou: borne(valeur.flou, 0, 30, 0),
    cadrage: ["center", "top", "bottom", "left", "right"].includes(valeur.cadrage)
      ? valeur.cadrage : "center",
  };
}

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
    // cadrage propre à ce film : remplace le réglage global quand il est défini
    cadrageImage: cadragePropre(body.cadrageImage),
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

app.get("/api/reports/motifs", (_req, res) => res.json(MOTIFS));

/** Tout joueur connecté peut signaler une anomalie sur un film. */
app.post("/api/reports", (req, res) => {
  const user = userFromCookie(req.headers.cookie);
  if (!user) return res.status(401).json({ error: "NOT_AUTHENTICATED" });

  const movieId = Number(req.body.movieId);
  const film = movies.find((m) => m.id === movieId);
  if (!film) return res.status(404).json({ error: "MOVIE_NOT_FOUND" });
  if (!MOTIFS[req.body.motif]) return res.status(400).json({ error: "MOTIF_INVALIDE" });

  const doublon = reports.find(
    (r) => r.movieId === movieId && r.auteurId === user.id && r.statut === "ouvert"
  );
  if (doublon) return res.json({ ok: true, deja: true });

  reports.push({
    id: (reports.at(-1)?.id || 0) + 1,
    movieId, titre: film.title,
    motif: req.body.motif,
    commentaire: String(req.body.commentaire || "").trim().slice(0, 300),
    auteurId: user.id, auteur: user.pseudo,
    statut: "ouvert", date: new Date().toISOString(),
  });
  saveReports();
  res.status(201).json({ ok: true });
});

app.get("/api/reports", requireModerateur, (_req, res) =>
  res.json(reports.slice().reverse())
);

/** Traiter un signalement : le clore, ou retirer le film du catalogue. */
app.put("/api/reports/:id", requireModerateur, (req, res) => {
  const signalement = reports.find((r) => r.id === Number(req.params.id));
  if (!signalement) return res.status(404).json({ error: "NOT_FOUND" });

  if (req.body.statut === "ouvert" || req.body.statut === "traite")
    signalement.statut = req.body.statut;

  if (req.body.retirerFilm) {
    const film = movies.find((m) => m.id === signalement.movieId);
    if (film) { film.enabled = false; saveMovies(); }
    signalement.statut = "traite";
  }
  signalement.traitePar = req.moderateur?.pseudo || "administration";
  saveReports();
  res.json(signalement);
});

/** Attribue ou retire la photo de profil d'un joueur. */
app.put("/api/admin/users/:id/photo", requireAdmin, (req, res) => {
  const r = definirPhoto(req.params.id, req.body.photo);
  if (!r) return res.status(404).json({ error: "NOT_FOUND" });
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true, photo: r.photo || null });
});

app.put("/api/admin/users/:id/role", requireAdmin, (req, res) => {
  const user = definirRole(req.params.id, req.body.role);
  if (!user) return res.status(400).json({ error: "ROLE_INVALIDE" });
  res.json(user);
});

/** Renvoie l'utilisateur connecté, ou termine la requête en 401. */
function exigeCompte(req, res) {
  const user = userFromCookie(req.headers.cookie);
  if (!user) { res.status(401).json({ error: "NOT_AUTHENTICATED" }); return null; }
  return user;
}

/* ------------------------------------------------------------------ */
/* Solo et partie classée, sans temps réel                            */
/*                                                                     */
/* Ces modes ne concernent qu'un joueur : les faire passer par le      */
/* WebSocket les rendait inutilement fragiles (bloqueurs, réseaux      */
/* filtrants). Ici, tout se joue en requêtes HTTP ordinaires.          */
/* ------------------------------------------------------------------ */

const parties = new Map();   // userId -> partie en cours

const vueManche = (p) => ({
  roundIndex: p.index,
  total: p.playlist.length,
  synopsis: masquerReponse(p.playlist[p.index].synopsis, p.playlist[p.index]),
  choices: p.choices,
  duration: CONFIG.ROUND_DURATION_MS,
  hintCosts: CONFIG.HINT_COSTS,
  hintCredits: CONFIG.HINT_CREDITS,
  hintLabels: libellesIndices(),
  posterStyle: styleAffiche(p.playlist[p.index]),
});

function demarrerManche(p) {
  const film = p.playlist[p.index];
  p.choices = buildChoices(film);
  p.startedAt = Date.now();
  p.hints = [];
  p.repondu = false;
  p.pauseA = null;
  return vueManche(p);
}

app.post("/api/solo/start", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;

  const { mode = "solo", difficulty = "tous", rounds } = req.body;
  const vivier = movies.filter(
    (m) => m.enabled !== false && (difficulty === "tous" || m.difficulty === difficulty)
  );
  if (!vivier.length) return res.status(400).json({ error: "NO_MOVIES" });

  if (mode === "ranked" && partiesRestantes(user.id) <= 0)
    return res.status(400).json({ error: "PLUS_DE_PARTIES", ...infoSaison() });

  const p = {
    mode: mode === "ranked" ? "ranked" : "solo",
    playlist: melange(vivier).slice(0, Math.min(Number(rounds) || 10, vivier.length)),
    index: 0, score: 0,
  };
  parties.set(user.id, p);
  res.json({ ok: true, mode: p.mode, ...demarrerManche(p) });
});

/**
 * Pause en solo. Le temps écoulé est figé côté serveur, sinon un joueur
 * pourrait mettre en pause, chercher la réponse, et marquer le score maximum.
 */
app.post("/api/solo/pause", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const p = parties.get(user.id);
  if (!p || p.repondu) return res.status(400).json({ error: "PAS_DE_MANCHE" });

  if (req.body.reprendre) {
    if (p.pauseA) { p.startedAt += Date.now() - p.pauseA; p.pauseA = null; }
  } else if (!p.pauseA) {
    p.pauseA = Date.now();
  }
  const reste = Math.max(0, CONFIG.ROUND_DURATION_MS - ((p.pauseA || Date.now()) - p.startedAt));
  res.json({ ok: true, enPause: Boolean(p.pauseA), reste });
});

app.post("/api/solo/hint", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const p = parties.get(user.id);
  if (!p || p.repondu) return res.status(400).json({ error: "PAS_DE_MANCHE" });
  if (p.pauseA) return res.status(400).json({ error: "EN_PAUSE" });

  const type = req.body.type;
  if (!CONFIG.HINT_COSTS[type]) return res.status(400).json({ error: "UNKNOWN_HINT" });
  if (p.hints.includes(type)) return res.status(400).json({ error: "ALREADY_BOUGHT" });
  if (!spendCredits(user.id, CONFIG.HINT_CREDITS[type]))
    return res.status(400).json({ error: "NO_CREDITS" });

  p.hints.push(type);
  const film = p.playlist[p.index];
  const value = type === "poster" ? (film.still || film.poster)
              : type === "letters" ? titlePattern(film.title)
              : film[type];
  res.json({ ok: true, type, value, credits: getCredits(user.id) });
});

app.post("/api/solo/answer", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const p = parties.get(user.id);
  if (!p || p.repondu) return res.status(400).json({ error: "PAS_DE_MANCHE" });

  if (p.pauseA) return res.status(400).json({ error: "EN_PAUSE" });

  const film = p.playlist[p.index];
  const juste = Number(req.body.choiceId) === film.id;
  p.repondu = true;

  let points = 0;
  if (juste) {
    points = computeScore({ elapsedMs: Date.now() - p.startedAt, hintsUsed: p.hints });
    p.score += points;
  }
  res.json({
    ok: true, correct: juste, points, movieId: film.id,
    answer: film.title, poster: film.poster, total: p.score,
  });
});

app.post("/api/solo/next", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const p = parties.get(user.id);
  if (!p) return res.status(400).json({ error: "PAS_DE_PARTIE" });

  p.index++;
  if (p.index < p.playlist.length) return res.json({ ok: true, ...demarrerManche(p) });

  // fin de partie : on crédite une seule fois, puis on oublie la partie
  parties.delete(user.id);
  if (p.mode === "ranked") {
    addRankedPoints(user.id, p.score);
    consommerPartieClassee(user.id);
  }
  grantPoints(user.id, p.score);
  grantCredits(user.id, REGLAGES.creditsParPartie);
  res.json({
    ok: true, fini: true, score: p.score, mode: p.mode,
    credits: getCredits(user.id), points: getPoints(user.id),
  });
});

/* ---------- amis ---------- */

app.get("/api/friends", (req, res) => {
  const user = exigeCompte(req, res);
  if (user) res.json(relations(user.id));
});

app.get("/api/players/search", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const trouves = chercherJoueurs(req.query.q, user.id)
    .map((j) => ({ ...j, relation: statutRelation(user.id, j.id) }));
  res.json(trouves);
});

app.get("/api/players/:id/relation", (req, res) => {
  const user = exigeCompte(req, res);
  if (user) res.json({ relation: statutRelation(user.id, req.params.id) });
});

const ACTIONS = {
  demander: demanderAmi,
  accepter: accepterAmi,
  retirer: retirerAmi,
  bloquer: (a, b) => bloquer(a, b, true),
  debloquer: (a, b) => bloquer(a, b, false),
};

app.post("/api/friends/:action", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const action = ACTIONS[req.params.action];
  if (!action) return res.status(400).json({ error: "ACTION_INCONNUE" });

  const resultat = action(user.id, String(req.body.id || ""));
  if (resultat?.error) return res.status(400).json(resultat);
  res.json({ ...resultat, relation: statutRelation(user.id, req.body.id) });
});

app.get("/api/presence", (_req, res) => res.json({ enLigne: nombreEnLigne() }));

app.get("/api/leaderboard", (req, res) =>
  res.json(leaderboard(50, req.query.type === "global" ? "global" : "saison"))
);

app.get("/api/saison", (req, res) => {
  const user = userFromCookie(req.headers.cookie);
  res.json({
    ...infoSaison(),
    partiesRestantes: user ? partiesRestantes(user.id) : null,
    palmares: palmares.slice(-3).reverse(),
  });
});

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

/* ------------------------------------------------------------------ */
/* Saisons classées                                                    */
/*                                                                     */
/* Le classement classé se réinitialise tous les N jours. Chaque joueur */
/* dispose d'un nombre limité de parties : le classement récompense la  */
/* régularité et la justesse, pas le temps passé.                      */
/* ------------------------------------------------------------------ */

let saison = null;

function chargerSaison(brut) {
  saison = brut || { numero: 1, debut: Date.now(), participations: {} };
  verifierSaison();
}

/** Ouvre une nouvelle saison si la précédente est arrivée à échéance. */
function verifierSaison() {
  const duree = REGLAGES.saisonJours * 24 * 60 * 60 * 1000;
  if (Date.now() - saison.debut < duree) return false;

  archiverSaison();
  saison = { numero: saison.numero + 1, debut: Date.now(), participations: {} };
  sauver("saison", saison);
  console.log(`Nouvelle saison classée : n° ${saison.numero}`);
  return true;
}

/** Conserve le podium de la saison écoulée, puis remet les scores à zéro. */
function archiverSaison() {
  const podium = leaderboard(10).map(({ rank, pseudo, avatar, totalScore }) =>
    ({ rank, pseudo, avatar, totalScore }));
  palmares.push({ numero: saison.numero, fin: Date.now(), podium });
  sauver("palmares", palmares);
  reinitialiserClassement();
}

const infoSaison = () => {
  verifierSaison();
  const fin = saison.debut + REGLAGES.saisonJours * 24 * 60 * 60 * 1000;
  return {
    numero: saison.numero,
    debut: saison.debut,
    fin,
    joursRestants: Math.max(0, Math.ceil((fin - Date.now()) / 86400000)),
    partiesMax: REGLAGES.partiesClasseesParSaison,
  };
};

const partiesRestantes = (userId) => {
  verifierSaison();
  return Math.max(0, REGLAGES.partiesClasseesParSaison - (saison.participations[userId] || 0));
};

function consommerPartieClassee(userId) {
  saison.participations[userId] = (saison.participations[userId] || 0) + 1;
  sauver("saison", saison);
}

/** Libellés des indices actifs, tels que définis dans l'administration. */
const libellesIndices = () =>
  Object.fromEntries(Object.entries(REGLAGES.indices)
    .filter(([, v]) => v.actif).map(([k, v]) => [k, v.libelle]));

/**
 * Recadrage de l'image d'indice. Un zoom supérieur à 100 % rogne les bords :
 * le titre imprimé et les visages en gros plan disparaissent souvent, ce qui
 * rend l'indice utile sans donner la réponse.
 */
const styleAffiche = (film) => {
  if (film?.cadrageImage) return film.cadrageImage;   // réglage propre au film
  const p = REGLAGES.indices.poster;
  return { zoom: p.zoom ?? 100, cadrage: p.cadrage || "center", flou: p.flou ?? 0 };
};

/**
 * Masque dans le synopsis tout mot appartenant au titre ou aux réponses
 * acceptées. Le joueur voit « ▪▪▪▪▪ » : il comprend qu'un mot a été retiré
 * parce qu'il donnait la réponse, plutôt que de tomber sur un synopsis
 * incohérent ou, pire, sur le titre en clair.
 */
const MOTS_VIDES = new Set([
  "le","la","les","un","une","des","du","de","d","l","au","aux","et","ou","à","a",
  "en","dans","sur","pour","par","avec","sans","son","sa","ses","ce","cet","cette",
  "the","of","and","in","on","to","il","elle","est","qui","que","plus","ne","pas",
]);

function masquerReponse(synopsis, film) {
  const sources = [film.title, ...(film.acceptedAnswers || [])];
  const interdits = new Set();

  for (const source of sources) {
    const complet = normalize(source);
    if (complet.length > 2) interdits.add(complet);
    for (const mot of complet.split(/\s+/))
      if (mot.length > 3 && !MOTS_VIDES.has(mot)) interdits.add(mot);
  }
  if (!interdits.size) return synopsis;

  // on remplace mot à mot, en conservant la ponctuation d'origine
  return synopsis.replace(/[\p{L}\p{N}'’-]+/gu, (mot) => {
    const nu = normalize(mot);
    if (!nu || nu.length < 3) return mot;
    const touche = [...interdits].some((i) =>
      nu === i || (i.length > 4 && nu.startsWith(i)) || (nu.length > 4 && i.startsWith(nu))
    );
    return touche ? "▪".repeat(Math.max(3, mot.length)) : mot;
  });
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
  room.pauseA = null;
  room.graceRestant = null;
  for (const p of room.players.values()) { p.hasAnswered = false; p.hints = []; }

  io.to(room.code).emit("round:start", {
    roundIndex: room.roundIndex,
    total: room.playlist.length,
    synopsis: masquerReponse(movie.synopsis, movie),   // aucun mot du titre ne transparaît
    duration: CONFIG.ROUND_DURATION_MS,
    hintCosts: CONFIG.HINT_COSTS,
    hintCredits: CONFIG.HINT_CREDITS,
    hintLabels: libellesIndices(),
    posterStyle: styleAffiche(movie),
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
    movieId: room.currentMovie.id,
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
    grantCredits(p.userId, REGLAGES.creditsParPartie);
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
  if (emailAValider(user)) return next(new Error("EMAIL_NON_VALIDE"));
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
    if (room.pauseA) return cb?.({ ok: false, error: "EN_PAUSE" });
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
    if (room.pauseA) return cb?.({ ok: false, error: "EN_PAUSE" });

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
      room.graceDebut = Date.now();
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

    // un message n'atteint pas les joueurs qui ont bloqué son auteur
    for (const autre of room.players.values()) {
      if (estBloque(autre.userId, player.userId)) continue;
      io.to(autre.id).emit("chat:message", {
        pseudo: player.pseudo, avatar: player.avatar, text: message, at: Date.now(),
      });
    }
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

  /**
   * Pause d'une partie à plusieurs, réservée à l'hôte : sinon n'importe quel
   * joueur pourrait figer la manche des autres. Le chronomètre est réellement
   * suspendu, pas seulement masqué.
   */
  socket.on("game:pause", ({ code, reprendre }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.status !== "playing") return;

    if (reprendre) {
      if (!room.pauseA) return;
      const duree = Date.now() - room.pauseA;
      room.startedAt += duree;
      room.pauseA = null;
      const reste = CONFIG.ROUND_DURATION_MS - (Date.now() - room.startedAt);
      room.timer = setTimeout(() => endRound(room), Math.max(0, reste));
      if (room.graceRestant) {
        room.graceTimer = setTimeout(() => endRound(room), room.graceRestant);
        room.graceRestant = null;
      }
      io.to(room.code).emit("game:paused", { enPause: false, reste });
      return;
    }

    if (room.pauseA) return;
    room.pauseA = Date.now();
    clearTimeout(room.timer);
    if (room.graceTimer) {
      room.graceRestant = Math.max(0, CONFIG.GRACE_AFTER_FIRST_MS - (Date.now() - room.graceDebut || 0));
      clearTimeout(room.graceTimer);
    }
    const reste = Math.max(0, CONFIG.ROUND_DURATION_MS - (room.pauseA - room.startedAt));
    io.to(room.code).emit("game:paused", { enPause: true, reste, par: socket.data.user.pseudo });
  });

  /** Réactions émoji pendant la partie, relayées à tout le salon. */
  const EMOJIS = ["😂", "😀", "😮", "😡", "😭", "❤️", "👏", "🤔"];
  let derniereReaction = 0;

  socket.on("reaction", ({ code, emoji }) => {
    const room = rooms.get(code);
    const player = room?.players.get(socket.id);
    if (!room || !player || !EMOJIS.includes(emoji)) return;
    if (Date.now() - derniereReaction < 700) return;   // évite le matraquage
    derniereReaction = Date.now();
    io.to(room.code).emit("reaction", { emoji, pseudo: player.pseudo, avatar: player.avatar });
  });

  /** Invite un ami dans le salon en cours. Il reçoit une notification. */
  socket.on("invite:send", ({ code, amiId }, cb) => {
    const room = rooms.get(code);
    if (!room || !room.players.has(socket.id)) return cb?.({ ok: false });
    if (statutRelation(user.id, amiId) !== "ami") return cb?.({ ok: false, error: "PAS_AMI" });
    if (estBloque(user.id, amiId)) return cb?.({ ok: false, error: "BLOQUE" });

    let livree = false;
    for (const [, s] of io.of("/").sockets) {
      if (s.data.user?.id !== amiId) continue;
      s.emit("invite:recue", {
        code: room.code, mode: room.mode,
        de: user.pseudo, avatar: user.avatar,
        joueurs: room.players.size,
      });
      livree = true;
    }
    cb?.({ ok: true, livree });
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
    photo: user.photo || null,
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

/* ------------------------------------------------------------------ */
/* Démarrage : rien n'est servi avant que les données soient chargées   */
/* ------------------------------------------------------------------ */

const PORT = process.env.PORT || 3000;

await initStockage();
movies = await charger("movies", MOVIES_FILE, []);
normaliserFilms();
reports = await charger("reports", REPORTS_FILE, []);
empreinteAdmin = await charger("adminPass", null, null);
palmares = await charger("palmares", null, []);
chargerSaison(await charger("saison", null, null));
REGLAGES = { ...structuredClone(REGLAGES_DEFAUT), ...(await charger("reglages", null, {})) };
if (!empreinteAdmin)
  console.warn("⚠️  Mot de passe d'administration par défaut : changez-le depuis /admin.html");
await chargerUtilisateurs();

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`MichBen Ciné Quizz → http://localhost:${PORT}  (admin : /admin.html)`);
  console.log(`${movies.length} films · stockage : ${enBase ? "Postgres" : "fichiers locaux"}`);
});
