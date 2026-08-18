/**
 * MichBen Ciné Quizz — serveur de jeu (MVP)
 * Node 18+ / Express / Socket.IO
 */

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { charger, sauver, initStockage, enBase } from "./db.js";
import { createRequire } from "module";
import { dirname, join } from "path";
import crypto from "crypto";
import fs from "fs";
import { mountAuth, userFromCookie, connecterManuel, creerCompte, estCompteEnfant, addRankedPoints,
         spendCredits, grantCredits, getCredits, CREDITS_PER_GAME,
         listUsers, adminUpdateUser, adminDeleteUser, grantAll,
         grantPoints, getPoints, exchangePoints,
         marquerEnLigne, marquerHorsLigne, estEnLigne, nombreEnLigne, getConnectedUsers,
         estModerateur, definirRole, ROLES, chargerUtilisateurs,
         relations, demanderAmi, accepterAmi, retirerAmi, bloquer,
         chercherJoueurs, statutRelation, estBloque, emailAValider,
         leaderboard, reinitialiserClassement, definirPhoto, fichePublique,
         retirerPoints, grantPointsDon, ajouterXp, infoNiveau, validerManuellement,
         verifierCode, rattacherParrain, infoParrainage, verifierCodeParrain,
         parrainageManquant, parrainageObligatoire, genererCodeAdmin } from "./auth-x.js";

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static("public", {
  setHeaders(res, chemin) {
    res.setHeader("Cache-Control",
      chemin.endsWith(".html") ? "no-cache, must-revalidate" : "public, max-age=86400");
  },
}));

const MOTEUR = (() => {
  const require = createRequire(import.meta.url);
  const racine = dirname(require.resolve("socket.io/package.json"));
  return join(racine, "client-dist", "socket.io.min.js");
})();

app.get("/js/moteur.js", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.type("application/javascript").sendFile(MOTEUR, (err) => {
    if (err && !res.headersSent) res.status(404).send("// moteur introuvable");
  });
});

mountAuth(app);
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" }, path: "/rt" });

const REGLAGES_DEFAUT = {
  animationsAvancees: true,
  roundDuration: 60,
  basePoints: 1000,
  tmdbApiKey: "",
  creditsDepart: 12,
  creditsParPartie: 4,
  pointsParTicket: 250,
  saisonJours: 20,
  partiesClasseesParJour: 5,
  transfertMax: 2000,
  transfertParJour: 5000,
  coeurs: 3,
  xpBase: 100,
  xpCroissance: 1.04,
  niveauMax: 300,
  xpParPartie: 40,
  xpParBonneReponse: 12,
  xpParVictoire: 60,
  graceApresPremier: 15,
  vitesseSynopsis: 2800,
  indices: {
    letters:  { actif: true, points: 150, tickets: 1, libelle: "Nombre de lettres" },
    year:     { actif: true, points: 100, tickets: 1, libelle: "Année" },
    director: { actif: true, points: 200, tickets: 1, libelle: "Réalisateur" },
    actors:   { actif: true, points: 300, tickets: 2, libelle: "Acteurs" },
    poster:   { actif: true, points: 250, tickets: 2, libelle: "Photo du film", zoom: 160, cadrage: "center", flou: 0 },
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
  CHOICE_RATIO: 1,
  TIP_URL: process.env.TIP_URL || "https://buymeacoffee.com/votre-pseudo",
};

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "michben-admin";
let empreinteAdmin = null;
const hacherAdmin = (mdp, sel = crypto.randomBytes(16).toString("hex")) =>
  `${sel}:${crypto.scryptSync(mdp, sel, 64).toString("hex")}`;

const MOVIES_FILE = new URL("./movies.json", import.meta.url);
let movies = [];
const niveauDepuisVotes = (v = 0) => (v >= 8000 ? "facile" : v >= 2500 ? "moyen" : "difficile");

function normaliserFilms() {
  for (const m of movies) {
    if (!m.difficulty) m.difficulty = niveauDepuisVotes(m.votes);
    if (m.enabled === undefined) m.enabled = true;
  }
}
const saveMovies = () => sauver("movies", movies, MOVIES_FILE);

const REPORTS_FILE = new URL("./reports.json", import.meta.url);
let reports = [];
let palmares = [];
const saveReports = () => sauver("reports", reports, REPORTS_FILE);

const MOTIFS = {
  spoiler: "Le synopsis révèle le titre",
  synopsis: "Synopsis incompréhensible ou trop court",
  image: "Image ou affiche incorrecte",
  reponse: "Mauvaise réponse acceptée",
  inapproprie: "Contenu inapproprié",
  autre: "Autre",
};

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

function motDePasseAdminValide(mdp) {
  if (!mdp) return false;
  if (!empreinteAdmin) return mdp === ADMIN_TOKEN;
  const [sel, attendu] = empreinteAdmin.split(":");
  const calcule = crypto.scryptSync(mdp, sel, 64).toString("hex");
  return calcule.length === attendu.length &&
         crypto.timingSafeEqual(Buffer.from(calcule), Buffer.from(attendu));
}

const PORT = process.env.PORT || 3000;

await initStockage();
movies = await charger("movies", MOVIES_FILE, []);
normaliserFilms();
reports = await charger("reports", REPORTS_FILE, []);
empreinteAdmin = await charger("adminPass", null, null);
palmares = await charger("palmares", null, []);
REGLAGES = { ...structuredClone(REGLAGES_DEFAUT), ...(await charger("reglages", null, {})) };
await chargerUtilisateurs();

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`MichBen Ciné Quizz → http://localhost:${PORT}  (admin : /admin.html)`);
  console.log(`${movies.length} films · stockage : ${enBase ? "Postgres" : "fichiers locaux"}`);
});
