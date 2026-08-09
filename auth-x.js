/**
 * Authentification « Se connecter avec X » — OAuth 2.0 + PKCE.
 *
 * Variables d'environnement à définir sur Render :
 *   X_CLIENT_ID       depuis developer.x.com → votre app → Keys and tokens
 *   X_CLIENT_SECRET   idem
 *   PUBLIC_URL        https://www.michbencine.fr
 *
 * Dans les réglages de l'app X, l'URL de callback doit être EXACTEMENT :
 *   https://www.michbencine.fr/auth/x/callback
 *
 * Sans X_CLIENT_ID, un mode développement local est activé (voir plus bas).
 */

import crypto from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";

const CLIENT_ID = process.env.X_CLIENT_ID;
const CLIENT_SECRET = process.env.X_CLIENT_SECRET;
const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const CALLBACK = `${PUBLIC_URL}/auth/x/callback`;
const DEV_MODE = !CLIENT_ID; // aucune clé X : connexion locale de test

const USERS_FILE = new URL("./users.json", import.meta.url);
let users = existsSync(USERS_FILE) ? JSON.parse(readFileSync(USERS_FILE, "utf8")) : {};
const saveUsers = () => writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

const sessions = new Map(); // sid -> { userId, createdAt }
const pending = new Map();  // state -> { verifier, createdAt }

/* ---------- petites aides ---------- */

const b64url = (buf) => buf.toString("base64url");
const parseCookies = (header = "") =>
  Object.fromEntries(header.split(";").map((c) => {
    const i = c.indexOf("=");
    return i < 0 ? [c.trim(), ""] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }).filter(([k]) => k));

/** Utilisateur associé à une requête (ou à une poignée de main Socket.IO). */
export function userFromCookie(cookieHeader) {
  const sid = parseCookies(cookieHeader).mb_sid;
  const session = sid && sessions.get(sid);
  return session ? users[session.userId] || null : null;
}

export const STARTING_CREDITS = 12;   // offerts à l'inscription
export const CREDITS_PER_GAME = 4;    // gagnés à chaque partie terminée

/** Débite un crédit. Renvoie false si le solde est insuffisant. */
export function spendCredits(userId, amount) {
  const user = users[userId];
  if (!user || (user.credits ?? 0) < amount) return false;
  user.credits -= amount;
  saveUsers();
  return true;
}

/** Crédite le compte (fin de partie, cadeau). */
export function grantCredits(userId, amount) {
  const user = users[userId];
  if (!user) return;
  user.credits = (user.credits ?? 0) + amount;
  saveUsers();
}

export const getCredits = (userId) => users[userId]?.credits ?? 0;
export const getPoints = (userId) => users[userId]?.points ?? 0;

/** Cagnotte dépensable, alimentée à chaque partie, distincte du classement. */
export function grantPoints(userId, points) {
  const user = users[userId];
  if (!user || points <= 0) return;
  user.points = (user.points ?? 0) + points;
  saveUsers();
}

/**
 * Convertit des points en tickets bonus.
 * Le classement n'est pas touché : seule la cagnotte diminue.
 */
export function exchangePoints(userId, points, rate) {
  const user = users[userId];
  if (!user) return { error: "NOT_FOUND" };

  const demande = Math.floor(Number(points) || 0);
  if (demande < rate) return { error: "MIN_NOT_REACHED" };
  if ((user.points ?? 0) < demande) return { error: "NOT_ENOUGH_POINTS" };

  const tickets = Math.floor(demande / rate);
  const consommes = tickets * rate;           // pas de perte sur l'appoint
  user.points -= consommes;
  user.credits = (user.credits ?? 0) + tickets;
  saveUsers();
  return { tickets, consommes, points: user.points, credits: user.credits };
}

/* ---------- administration ---------- */

export const listUsers = () =>
  Object.values(users).sort((x, y) => (y.totalScore || 0) - (x.totalScore || 0));

export function adminUpdateUser(id, changes) {
  const user = users[id];
  if (!user) return null;
  if (typeof changes.credits === "number") user.credits = Math.max(0, Math.round(changes.credits));
  if (typeof changes.totalScore === "number") user.totalScore = Math.max(0, Math.round(changes.totalScore));
  if (typeof changes.points === "number") user.points = Math.max(0, Math.round(changes.points));
  if (typeof changes.pseudo === "string" && changes.pseudo.trim().length >= 2) {
    user.pseudo = changes.pseudo.trim().slice(0, 20);
    user.pseudoChosen = true;
  }
  if (changes.banned === true || changes.banned === false) user.banned = changes.banned;
  saveUsers();
  return user;
}

export function adminDeleteUser(id) {
  if (!users[id]) return false;
  delete users[id];
  for (const [sid, s] of sessions) if (s.userId === id) sessions.delete(sid); // déconnexion immédiate
  saveUsers();
  return true;
}

/** Crédite tout le monde d'un coup (cadeau, compensation). */
export function grantAll(amount) {
  for (const u of Object.values(users)) u.credits = (u.credits ?? 0) + amount;
  saveUsers();
  return Object.keys(users).length;
}

/** Ajoute des points au total permanent d'un joueur (mode classé). */
export function addRankedPoints(userId, points) {
  const user = users[userId];
  if (!user) return;
  user.totalScore = (user.totalScore || 0) + points;   // classement : ne baisse jamais
  user.gamesPlayed = (user.gamesPlayed || 0) + 1;
  saveUsers();
}

export const leaderboard = (limit = 50) =>
  Object.values(users)
    .filter((u) => u.totalScore > 0)
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, limit)
    .map((u, i) => ({ rank: i + 1, pseudo: u.pseudo, avatar: u.avatar, totalScore: u.totalScore, gamesPlayed: u.gamesPlayed }));

function createSession(res, user) {
  const sid = b64url(crypto.randomBytes(24));
  sessions.set(sid, { userId: user.id, createdAt: Date.now() });
  const secure = PUBLIC_URL.startsWith("https") ? " Secure;" : "";
  res.setHeader("Set-Cookie",
    `mb_sid=${sid}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
}

/* ---------- routes ---------- */

export function mountAuth(app) {
  app.get("/api/me", (req, res) => {
    const user = userFromCookie(req.headers.cookie);
    if (!user) return res.status(401).json({ error: "NOT_AUTHENTICATED", devMode: DEV_MODE });
    res.json(user);
  });

  app.get("/api/leaderboard", (_req, res) => res.json(leaderboard()));

  app.post("/api/profile", (req, res) => {
    const user = userFromCookie(req.headers.cookie);
    if (!user) return res.status(401).json({ error: "NOT_AUTHENTICATED" });
    const pseudo = String(req.body.pseudo || "").trim().slice(0, 20);
    if (pseudo.length < 2) return res.status(400).json({ error: "PSEUDO_TOO_SHORT" });

    const taken = Object.values(users).some(
      (u) => u.id !== user.id && (u.pseudo || "").toLowerCase() === pseudo.toLowerCase()
    );
    if (taken) return res.status(409).json({ error: "PSEUDO_TAKEN" });

    user.pseudo = pseudo;
    user.pseudoChosen = true;
    if (typeof req.body.avatar === "string") user.avatar = req.body.avatar.slice(0, 8);
    saveUsers();
    res.json(user);
  });

  app.post("/auth/logout", (req, res) => {
    const sid = parseCookies(req.headers.cookie).mb_sid;
    if (sid) sessions.delete(sid);
    res.setHeader("Set-Cookie", "mb_sid=; HttpOnly; Path=/; Max-Age=0");
    res.json({ ok: true });
  });

  /* --- Mode développement : aucune clé X configurée --- */
  if (DEV_MODE) {
    console.warn("⚠️  X_CLIENT_ID absent : connexion de test activée. NE PAS DÉPLOYER AINSI.");
    app.get("/auth/x/login", (_req, res) => {
      const id = `dev-${crypto.randomBytes(4).toString("hex")}`;
      users[id] = { id, pseudo: "", pseudoChosen: false, avatar: "🎬", totalScore: 0, gamesPlayed: 0, credits: STARTING_CREDITS, points: 0 };
      saveUsers();
      createSession(res, users[id]);
      res.redirect("/");
    });
    return;
  }

  /* --- OAuth 2.0 avec PKCE --- */
  app.get("/auth/x/login", (_req, res) => {
    const state = b64url(crypto.randomBytes(16));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    pending.set(state, { verifier, createdAt: Date.now() });

    const url = new URL("https://twitter.com/i/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", CALLBACK);
    url.searchParams.set("scope", "tweet.read users.read offline.access");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    res.redirect(url.toString());
  });

  app.get("/auth/x/callback", async (req, res) => {
    const { code, state } = req.query;
    const entry = pending.get(state);
    pending.delete(state);
    if (!code || !entry) return res.redirect("/?erreur=state");

    try {
      const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
      const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
        body: new URLSearchParams({
          code, grant_type: "authorization_code",
          client_id: CLIENT_ID, redirect_uri: CALLBACK, code_verifier: entry.verifier,
        }),
      });
      const token = await tokenRes.json();
      if (!token.access_token) throw new Error(JSON.stringify(token));

      const meRes = await fetch("https://api.twitter.com/2/users/me?user.fields=profile_image_url", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      const { data } = await meRes.json();
      if (!data?.id) throw new Error("profil X illisible");

      const id = `x:${data.id}`;
      users[id] = users[id] || { id, pseudo: "", pseudoChosen: false, suggestion: data.username.slice(0, 20),
        avatar: "🎬", totalScore: 0, gamesPlayed: 0, credits: STARTING_CREDITS, points: 0 };
      users[id].xHandle = data.username;
      saveUsers();
      createSession(res, users[id]);
      res.redirect("/");
    } catch (err) {
      console.error("Échec OAuth X :", err.message);
      res.redirect("/?erreur=auth");
    }
  });
}

/* Nettoyage horaire des états OAuth abandonnés. */
setInterval(() => {
  const limit = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of pending) if (v.createdAt < limit) pending.delete(k);
}, 60 * 60 * 1000).unref?.();
