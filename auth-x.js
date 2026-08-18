/**
 * Authentification « Se connecter avec X » — OAuth 2.0 + PKCE.
 * Gère aussi les comptes email, les niveaux, les amis, et le parrainage.
 */

import crypto from "crypto";
import { charger, sauver } from "./db.js";

const CLIENT_ID = process.env.X_CLIENT_ID;
const CLIENT_SECRET = process.env.X_CLIENT_SECRET;
const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const CALLBACK = `${PUBLIC_URL}/auth/x/callback`;
const DEV_MODE = !CLIENT_ID;

const USERS_FILE = new URL("./users.json", import.meta.url);
let users = {};
const saveUsers = () => sauver("users", users, USERS_FILE);

export async function chargerUtilisateurs() {
  users = await charger("users", USERS_FILE, {});
  for (const u of Object.values(users))
    for (const champ of ["amis", "demandesRecues", "demandesEnvoyees", "bloques", "claimedBonuses"])
      if (!Array.isArray(u[champ])) u[champ] = [];
  for (const u of Object.values(users)) {
    if (u.scoreGlobal === undefined) u.scoreGlobal = u.totalScore || 0;
    if (u.partiesGlobales === undefined) u.partiesGlobales = u.gamesPlayed || 0;
  }
  console.log(`${Object.keys(users).length} compte(s) chargé(s).`);
}

const connectes = new Map();
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.LICENSE_SECRET;
const CLE_SESSION = SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const DUREE_SESSION = 60 * 60 * 24 * 30;

const signature = (donnees) =>
  crypto.createHmac("sha256", CLE_SESSION).update(donnees).digest("base64url");

function creerJeton(userId) {
  const expire = Math.floor(Date.now() / 1000) + DUREE_SESSION;
  const donnees = `${Buffer.from(userId).toString("base64url")}.${expire}`;
  return `${donnees}.${signature(donnees)}`;
}

function lireJeton(jeton) {
  const morceaux = String(jeton || "").split(".");
  if (morceaux.length !== 3) return null;
  const [idEncode, expire, sig] = morceaux;
  const attendue = Buffer.from(signature(`${idEncode}.${expire}`));
  const fournie = Buffer.from(sig);
  if (attendue.length !== fournie.length || !crypto.timingSafeEqual(attendue, fournie)) return null;
  if (Number(expire) < Date.now() / 1000) return null;
  return Buffer.from(idEncode, "base64url").toString();
}

const pending = new Map();
const b64url = (buf) => buf.toString("base64url");
const parseCookies = (header = "") =>
  Object.fromEntries(header.split(";").map((c) => {
    const i = c.indexOf("=");
    return i < 0 ? [c.trim(), ""] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }).filter(([k]) => k));

export function userFromCookie(cookieHeader) {
  const userId = lireJeton(parseCookies(cookieHeader).mb_sid);
  return userId ? users[userId] || null : null;
}

export const STARTING_CREDITS = 12;
export const CREDITS_PER_GAME = 4;

export function spendCredits(userId, amount) {
  const user = users[userId];
  if (!user || (user.credits ?? 0) < amount) return false;
  user.credits -= amount;
  saveUsers();
  return true;
}

export function grantCredits(userId, amount) {
  const user = users[userId];
  if (!user) return;
  user.credits = (user.credits ?? 0) + amount;
  saveUsers();
}

export function marquerEnLigne(userId) {
  connectes.set(userId, (connectes.get(userId) || 0) + 1);
}
export function marquerHorsLigne(userId) {
  const n = (connectes.get(userId) || 1) - 1;
  n <= 0 ? connectes.delete(userId) : connectes.set(userId, n);
}
export const estEnLigne = (userId) => connectes.has(userId);

export const getConnectedUsers = () => {
  return Array.from(connectes.keys())
    .map(id => users[id])
    .filter(u => u && u.pseudoChosen && !u.banned)
    .map(u => ({ id: u.id, pseudo: u.pseudo, avatar: u.avatar, photo: u.photo || null, role: u.role || 'joueur' }))
    .sort((a, b) => a.pseudo.localeCompare(b.pseudo));
};

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_EXPEDITEUR = process.env.EMAIL_EXPEDITEUR || "MichBen Ciné Quizz <onboarding@resend.dev>";

export async function captchaValide(jeton, ip) {
  if (!TURNSTILE_SECRET) return true;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: jeton || "", remoteip: ip || "" }),
    });
    const data = await res.json();
    return data.success === true;
  } catch (e) {
    return false;
  }
}

const codeQuatreChiffres = () => String(crypto.randomInt(1000, 10000));

async function envoyerCode(email, code) {
  if (!RESEND_API_KEY) return { simule: true };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: EMAIL_EXPEDITEUR, to: [email],
      subject: `${code} — votre code MichBen Ciné Quizz`,
      text: `Votre code de validation est ${code}.`,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return { envoye: true };
}

export async function envoyerCodeValidation(userId) {
  const u = users[userId];
  if (!u || !u.email) return { error: "INTROUVABLE" };
  if (u.emailVerifie) return { error: "DEJA_VERIFIE" };
  if (u.codeEnvoyeA && Date.now() - u.codeEnvoyeA < 60_000) return { error: "TROP_TOT" };

  u.code = codeQuatreChiffres();
  u.codeExpire = Date.now() + 20 * 60 * 1000;
  u.codeEnvoyeA = Date.now();
  u.codeEssais = 0;
  saveUsers();
  return await envoyerCode(u.email, u.code);
}

export function validerManuellement(id) {
  const u = users[id];
  if (!u) return null;
  u.emailVerifie = true;
  delete u.code; delete u.codeExpire; delete u.codeEssais;
  saveUsers();
  return u;
}

export function validerCode(userId, code) {
  const u = users[userId];
  if (!u) return { error: "INTROUVABLE" };
  if (u.emailVerifie) return { ok: true };
  if (!u.code || Date.now() > (u.codeExpire || 0)) return { error: "CODE_EXPIRE" };
  if ((u.codeEssais || 0) >= 5) return { error: "TROP_D_ESSAIS" };

  u.codeEssais = (u.codeEssais || 0) + 1;
  if (String(code || "").trim() !== u.code) { saveUsers(); return { error: "CODE_INCORRECT" }; }

  u.emailVerifie = true;
  delete u.code; delete u.codeExpire; delete u.codeEssais;
  saveUsers();
  return { ok: true };
}

export const parrainageManquant = (u) => parrainageObligatoire() && Boolean(u) && !u.parrainId && !u.fondateur;
export const emailAValider = (u) => Boolean(RESEND_API_KEY) && Boolean(u?.email) && !u.emailVerifie;

const normEmail = (e) => String(e || "").trim().toLowerCase();
const emailValide = (e) => /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(e);

function hacher(motDePasse, sel = crypto.randomBytes(16).toString("hex")) {
  const cle = crypto.scryptSync(motDePasse, sel, 64).toString("hex");
  return `${sel}:${cle}`;
}

function verifierMotDePasse(motDePasse, empreinte) {
  const [sel, attendu] = String(empreinte || "").split(":");
  if (!sel || !attendu) return false;
  const calcule = crypto.scryptSync(motDePasse, sel, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(calcule), Buffer.from(attendu));
}

const parEmail = (email) => Object.values(users).find((u) => u.email === email);

export function inscrireEmail(email, motDePasse) {
  const e = normEmail(email);
  if (!emailValide(e)) return { error: "EMAIL_INVALIDE" };
  if (String(motDePasse || "").length < 8) return { error: "MOT_DE_PASSE_COURT" };
  if (parEmail(e)) return { error: "EMAIL_DEJA_PRIS" };

  const id = `mail:${crypto.randomBytes(8).toString("hex")}`;
  users[id] = {
    id, email: e, motDePasse: hacher(motDePasse),
    pseudo: "", pseudoChosen: false, avatar: "🎬",
    totalScore: 0, gamesPlayed: 0, credits: STARTING_CREDITS, points: 0, role: "joueur",
    amis: [], demandesRecues: [], demandesEnvoyees: [], bloques: [], claimedBonuses: [],
  };
  saveUsers();
  return { user: users[id] };
}

export function connecterEmail(email, motDePasse) {
  const u = parEmail(normEmail(email));
  if (!u || !verifierMotDePasse(motDePasse, u.motDePasse)) return { error: "IDENTIFIANTS_INVALIDES" };
  if (u.banned) return { error: "BANNI" };
  return { user: u };
}

export function creerCompte({ identifiant, motDePasse, pseudo, avatar, photo, estEnfant }) {
  const id = String(identifiant || "").trim().toLowerCase();
  const cle = `kid:${id}`;
  users[cle] = {
    id: cle, identifiant: id, motDePasse: hacher(motDePasse),
    pseudo: String(pseudo || id).trim().slice(0, 20), pseudoChosen: true,
    avatar: avatar || (estEnfant ? "🧸" : "🎬"), photo: photo || null,
    compteEnfant: !!estEnfant, fondateur: true, emailVerifie: true, role: "joueur",
    totalScore: 0, gamesPlayed: 0, scoreGlobal: 0, partiesGlobales: 0,
    credits: STARTING_CREDITS, points: 0, amis: [], demandesRecues: [], demandesEnvoyees: [], bloques: [], claimedBonuses: [],
  };
  saveUsers();
  return { user: users[cle] };
}

export function connecterManuel(identifiant, motDePasse) {
  const id = String(identifiant || "").trim().toLowerCase();
  const u = Object.values(users).find((x) => x.identifiant === id);
  if (!u || !verifierMotDePasse(motDePasse, u.motDePasse)) return { error: "IDENTIFIANTS_INVALIDES" };
  if (u.banned) return { error: "BANNI" };
  return { user: u };
}

export const estCompteEnfant = (u) => Boolean(u?.compteEnfant);

export function xpRequise(niveau, base = 100, croissance = 1.04) {
  return Math.round(base * Math.pow(croissance, niveau));
}

export function niveauDepuisXp(xp, base, croissance, plafond = 300) {
  let niveau = 0, reste = xp || 0;
  while (niveau < plafond && reste >= xpRequise(niveau, base, croissance)) {
    reste -= xpRequise(niveau, base, croissance);
    niveau++;
  }
  return { niveau, reste, requis: xpRequise(niveau, base, croissance) };
}

export function ajouterXp(userId, montant, reglages = {}) {
  const u = users[userId];
  if (!u || montant <= 0) return null;
  const { base = 100, croissance = 1.04, plafond = 300 } = reglages;
  const avant = niveauDepuisXp(u.xp || 0, base, croissance, plafond).niveau;
  u.xp = (u.xp || 0) + montant;
  const apres = niveauDepuisXp(u.xp, base, croissance, plafond);
  u.niveau = apres.niveau;
  saveUsers();
  return { gagne: montant, xp: u.xp, ...apres, monte: apres.niveau > avant, niveauAvant: avant };
}

export const infoNiveau = (userId, reglages = {}) => {
  const u = users[userId];
  if (!u) return null;
  const { base = 100, croissance = 1.04, plafond = 300 } = reglages;
  return { xp: u.xp || 0, ...niveauDepuisXp(u.xp || 0, base, croissance, plafond) };
};

const PARTIES_POUR_CODE = 25;
const USAGES_PAR_CODE = 5;
const USAGES_FILLEUL = 3;
const ALPHABET_CODE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const parrainageObligatoire = () => process.env.PARRAINAGE === "obligatoire";

function genererCodeParrain() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => ALPHABET_CODE[crypto.randomInt(ALPHABET_CODE.length)]).join("");
  } while (Object.values(users).some((u) => u.codeParrain === code));
  return code;
}

export function verifierCodeParrain(userId) {
  const u = users[userId];
  if (!u || u.codeParrain) return null;
  if ((u.partiesGlobales || 0) < PARTIES_POUR_CODE) return null;
  u.codeParrain = genererCodeParrain();
  u.usagesMax = u.parrainId ? USAGES_FILLEUL : USAGES_PAR_CODE;
  saveUsers();
  return u.codeParrain;
}

const usagesRestants = (u) => Math.max(0, (u.usagesMax ?? USAGES_PAR_CODE) - (u.filleuls || []).length);
const parCode = (code) => Object.values(users).find((u) => u.codeParrain === String(code || "").toUpperCase().trim());

export function verifierCode(code) {
  const parrain = parCode(code);
  if (!parrain || parrain.banned) return { error: "CODE_INCONNU" };
  if (usagesRestants(parrain) <= 0) return { error: "CODE_EPUISE" };
  return { ok: true, parrain: { id: parrain.id, pseudo: parrain.pseudo, avatar: parrain.avatar, photo: parrain.photo || null }, restants: usagesRestants(parrain) };
}

export function rattacherParrain(userId, code) {
  const u = users[userId];
  if (!u) return { error: "INTROUVABLE" };
  if (u.parrainId) return { error: "DEJA_PARRAINE" };
  const parrain = parCode(code);
  if (!parrain || parrain.banned) return { error: "CODE_INCONNU" };
  if (parrain.id === userId) return { error: "SOI_MEME" };
  if (usagesRestants(parrain) <= 0) return { error: "CODE_EPUISE" };
  u.parrainId = parrain.id;
  u.parraineLe = Date.now();
  parrain.filleuls = [...(parrain.filleuls || []), userId];
  saveUsers();
  return { ok: true };
}

export function infoParrainage(userId) {
  const u = users[userId];
  if (!u) return null;
  const bref = (id) => {
    const x = users[id];
    return x && x.pseudoChosen ? { id: x.id, pseudo: x.pseudo, avatar: x.avatar, photo: x.photo || null, online: connectes.has(x.id) } : null;
  };
  return {
    code: u.codeParrain || null,
    usagesMax: u.usagesMax ?? (u.parrainId ? USAGES_FILLEUL : USAGES_PAR_CODE),
    usagesRestants: u.codeParrain ? usagesRestants(u) : null,
    partiesRequises: PARTIES_POUR_CODE,
    parties: u.partiesGlobales || 0,
    parrain: u.parrainId ? bref(u.parrainId) : null,
    filleuls: (u.filleuls || []).map(bref).filter(Boolean),
  };
}

const lien = (u) => ({ id: u.id, pseudo: u.pseudo, avatar: u.avatar, photo: u.photo || null, niveau: u.niveau || 0, online: connectes.has(u.id), role: u.role || "joueur" });

export function relations(userId) {
  const u = users[userId];
  if (!u) return null;
  const vus = (liste = []) => liste.map((id) => users[id]).filter(Boolean).map(lien);
  return { amis: vus(u.amis), recues: vus(u.demandesRecues), envoyees: vus(u.demandesEnvoyees), bloques: vus(u.bloques) };
}

const pousser = (liste, id) => (liste.includes(id) ? liste : [...liste, id]);
const retirer = (liste, id) => liste.filter((x) => x !== id);

export function demanderAmi(deId, versId) {
  const a = users[deId], b = users[versId];
  if (!a || !b || deId === versId) return { error: "INTROUVABLE" };
  if ((b.bloques || []).includes(deId)) return { error: "BLOQUE" };
  if ((a.amis || []).includes(versId)) return { error: "DEJA_AMIS" };
  if ((a.demandesRecues || []).includes(versId)) return accepterAmi(deId, versId);
  a.demandesEnvoyees = pousser(a.demandesEnvoyees || [], versId);
  b.demandesRecues = pousser(b.demandesRecues || [], deId);
  saveUsers();
  return { ok: true, statut: "envoyee" };
}

export function accepterAmi(userId, autreId) {
  const a = users[userId], b = users[autreId];
  if (!a || !b) return { error: "INTROUVABLE" };
  if (!(a.demandesRecues || []).includes(autreId)) return { error: "AUCUNE_DEMANDE" };
  a.demandesRecues = retirer(a.demandesRecues || [], autreId);
  b.demandesEnvoyees = retirer(b.demandesEnvoyees || [], userId);
  a.amis = pousser(a.amis || [], autreId);
  b.amis = pousser(b.amis || [], userId);
  saveUsers();
  return { ok: true, statut: "amis" };
}

export function retirerAmi(userId, autreId) {
  const a = users[userId], b = users[autreId];
  if (!a || !b) return { error: "INTROUVABLE" };
  for (const [x, y] of [[a, autreId], [b, userId]]) {
    x.amis = retirer(x.amis || [], y);
    x.demandesRecues = retirer(x.demandesRecues || [], y);
    x.demandesEnvoyees = retirer(x.demandesEnvoyees || [], y);
  }
  saveUsers();
  return { ok: true };
}

export function bloquer(userId, autreId, bloquerOuNon = true) {
  const a = users[userId];
  if (!a || !users[autreId] || userId === autreId) return { error: "INTROUVABLE" };
  if (bloquerOuNon) { retirerAmi(userId, autreId); a.bloques = pousser(a.bloques || [], autreId); }
  else { a.bloques = retirer(a.bloques || [], autreId); }
  saveUsers();
  return { ok: true, bloque: bloquerOuNon };
}

export const estBloque = (userId, autreId) => (users[userId]?.bloques || []).includes(autreId) || (users[autreId]?.bloques || []).includes(userId);

export function chercherJoueurs(requete, saufId, limite = 15) {
  const q = String(requete || "").trim().toLowerCase();
  if (q.length < 2) return [];
  return Object.values(users).filter((u) => u.pseudoChosen && u.id !== saufId && !u.banned && (u.pseudo || "").toLowerCase().includes(q) && !(u.bloques || []).includes(saufId)).slice(0, limite).map(lien);
}

export function fichePublique(id, demandeurId) {
  const u = users[id];
  if (!u || !u.pseudoChosen) return null;
  if ((u.bloques || []).includes(demandeurId)) return null;
  return { id: u.id, pseudo: u.pseudo, avatar: u.avatar, photo: u.photo || null, role: u.role || "joueur", online: connectes.has(u.id), niveau: u.niveau || 0, xp: u.xp || 0, scoreGlobal: u.scoreGlobal || 0, partiesGlobales: u.partiesGlobales || 0, scoreSaison: u.totalScore || 0, partiesSaison: u.gamesPlayed || 0, moyenne: (u.partiesGlobales || 0) ? Math.round((u.scoreGlobal || 0) / u.partiesGlobales) : 0, amis: (u.amis || []).length, relation: statutRelation(demandeurId, id) };
}

export function statutRelation(userId, autreId) {
  const u = users[userId];
  if (!u || userId === autreId) return "soi";
  if ((u.bloques || []).includes(autreId)) return "bloque";
  if ((u.amis || []).includes(autreId)) return "ami";
  if ((u.demandesEnvoyees || []).includes(autreId)) return "envoyee";
  if ((u.demandesRecues || []).includes(autreId)) return "recue";
  return "aucun";
}

export const ROLES = ["joueur", "moderateur", "admin"];
export const estModerateur = (user) => user && ["moderateur", "admin"].includes(user.role);

export function definirRole(id, role) {
  const user = users[id];
  if (!user || !ROLES.includes(role)) return null;
  user.role = role;
  saveUsers();
  return user;
}

export const nombreEnLigne = () => connectes.size;
export const getCredits = (userId) => users[userId]?.credits ?? 0;
export const getPoints = (userId) => users[userId]?.points ?? 0;

export function retirerPoints(userId, montant) {
  const u = users[userId];
  if (!u || (u.points ?? 0) < montant) return false;
  u.points -= montant;
  saveUsers();
  return true;
}

export function grantPointsDon(userId, montant) {
  const u = users[userId];
  if (!u) return;
  u.points = (u.points ?? 0) + montant;
  saveUsers();
}

export function grantPoints(userId, points) {
  const user = users[userId];
  if (!user) return;
  const gagnes = Math.max(0, points || 0);
  user.points = (user.points ?? 0) + gagnes;
  user.scoreGlobal = (user.scoreGlobal || 0) + gagnes;
  user.partiesGlobales = (user.partiesGlobales || 0) + 1;
  saveUsers();
}

export function exchangePoints(userId, points, rate) {
  const user = users[userId];
  if (!user) return { error: "NOT_FOUND" };
  const demande = Math.floor(Number(points) || 0);
  if (demande < rate) return { error: "MIN_NOT_REACHED" };
  if ((user.points ?? 0) < demande) return { error: "NOT_ENOUGH_POINTS" };
  const tickets = Math.floor(demande / rate);
  user.points -= tickets * rate;
  user.credits = (user.credits ?? 0) + tickets;
  saveUsers();
  return { tickets, consommes: tickets * rate, points: user.points, credits: user.credits };
}

export const listUsers = () => Object.values(users).sort((x, y) => (y.totalScore || 0) - (x.totalScore || 0)).map(({ motDePasse, code, codeExpire, codeEssais, ...reste }) => reste);

export function definirPhoto(id, url) {
  const user = users[id];
  if (!user) return null;
  const propre = String(url || "").trim();
  if (propre && !/^https:\/\/\S+$/i.test(propre)) return { error: "URL_INVALIDE" };
  propre ? (user.photo = propre.slice(0, 500)) : delete user.photo;
  saveUsers();
  return user;
}

export function adminUpdateUser(id, changes) {
  const user = users[id];
  if (!user) return null;
  if (typeof changes.credits === "number") user.credits = Math.max(0, Math.round(changes.credits));
  if (typeof changes.totalScore === "number") user.totalScore = Math.max(0, Math.round(changes.totalScore));
  if (typeof changes.points === "number") user.points = Math.max(0, Math.round(changes.points));
  if (typeof changes.pseudo === "string" && changes.pseudo.trim().length >= 2) { user.pseudo = changes.pseudo.trim().slice(0, 20); user.pseudoChosen = true; }
  if (changes.banned === true || changes.banned === false) user.banned = changes.banned;
  if (ROLES.includes(changes.role)) user.role = changes.role;
  if (changes.fondateur === true || changes.fondateur === false) user.fondateur = changes.fondateur;
  if (typeof changes.photo === "string") { const p = changes.photo.trim(); p ? (user.photo = p.slice(0, 500)) : delete user.photo; }
  saveUsers();
  return user;
}

export function adminDeleteUser(id) {
  if (!users[id]) return false;
  delete users[id];
  saveUsers();
  return true;
}

export function grantAll(amount) {
  for (const u of Object.values(users)) u.credits = (u.credits ?? 0) + amount;
  saveUsers();
  return Object.keys(users).length;
}

export function addRankedPoints(userId, points) {
  const user = users[userId];
  if (!user) return;
  user.totalScore = (user.totalScore || 0) + Math.max(0, points || 0);
  user.gamesPlayed = (user.gamesPlayed || 0) + 1;
  saveUsers();
}

export const leaderboard = (limit = 50, type = "saison") => {
  const champ = type === "global" ? "scoreGlobal" : "totalScore";
  const parties = type === "global" ? "partiesGlobales" : "gamesPlayed";
  return Object.values(users).filter((u) => u.pseudoChosen && ((u[parties] || 0) > 0 || (u[champ] || 0) > 0)).sort((a, b) => (b[champ] || 0) - (a[champ] || 0)).slice(0, limit).map((u, i) => ({ id: u.id, rank: i + 1, pseudo: u.pseudo, avatar: u.avatar, photo: u.photo || null, niveau: u.niveau || 0, totalScore: u[champ] || 0, gamesPlayed: u[parties] || 0, online: connectes.has(u.id), role: u.role || "joueur" }));
};

export function reinitialiserClassement() {
  for (const u of Object.values(users)) { u.totalScore = 0; u.gamesPlayed = 0; }
  saveUsers();
}

function domaineCookie() {
  try {
    const hote = new URL(PUBLIC_URL).hostname;
    if (hote === "localhost" || /^[\d.]+$/.test(hote)) return "";
    return hote.startsWith("www.") ? ` Domain=${hote.slice(4)};` : "";
  } catch { return ""; }
}

function createSession(res, user) {
  const sid = creerJeton(user.id);
  const secure = PUBLIC_URL.startsWith("https") ? " Secure;" : "";
  res.setHeader("Set-Cookie", `mb_sid=${sid}; HttpOnly;${secure}${domaineCookie()} SameSite=Lax; Path=/; Max-Age=${DUREE_SESSION}`);
}

export function mountAuth(app) {
  const sansSecret = ({ motDePasse, code, codeExpire, codeEssais, ...reste }) => reste;

  app.get("/api/me", (req, res) => {
    const user = userFromCookie(req.headers.cookie);
    if (!user) return res.status(401).json({ error: "NOT_AUTHENTICATED", devMode: DEV_MODE });
    res.json(sansSecret(user));
  });

  app.post("/auth/email/inscription", async (req, res) => {
    if (!(await captchaValide(req.body.captcha, req.ip))) return res.status(400).json({ error: "CAPTCHA_INVALIDE" });
    const r = inscrireEmail(req.body.email, req.body.motDePasse);
    if (r.error) return res.status(400).json(r);
    createSession(res, r.user);
    const envoi = await envoyerCodeValidation(r.user.id);
    res.json({ ...sansSecret(r.user), envoi });
  });

  app.post("/auth/email/code", async (req, res) => {
    const user = userFromCookie(req.headers.cookie);
    if (!user) return res.status(401).json({ error: "NOT_AUTHENTICATED" });
    const r = validerCode(user.id, req.body.code);
    if (r.error) return res.status(400).json(r);
    res.json(sansSecret(user));
  });

  app.post("/auth/email/renvoyer", async (req, res) => {
    const user = userFromCookie(req.headers.cookie);
    if (!user) return res.status(401).json({ error: "NOT_AUTHENTICATED" });
    const r = await envoyerCodeValidation(user.id);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  app.get("/api/captcha", (_req, res) => res.json({ siteKey: process.env.TURNSTILE_SITE_KEY || null }));

  app.post("/auth/email/connexion", (req, res) => {
    const r = connecterEmail(req.body.email, req.body.motDePasse);
    if (r.error) return res.status(401).json(r);
    createSession(res, r.user);
    res.json(sansSecret(r.user));
  });

  app.post("/api/profile", (req, res) => {
    const user = userFromCookie(req.headers.cookie);
    if (!user) return res.status(401).json({ error: "NOT_AUTHENTICATED" });
    const pseudo = String(req.body.pseudo || "").trim().slice(0, 20);
    if (pseudo.length < 2) return res.status(400).json({ error: "PSEUDO_TOO_SHORT" });
    const taken = Object.values(users).some((u) => u.id !== user.id && (u.pseudo || "").toLowerCase() === pseudo.toLowerCase());
    if (taken) return res.status(409).json({ error: "PSEUDO_TAKEN" });
    user.pseudo = pseudo;
    user.pseudoChosen = true;
    if (typeof req.body.avatar === "string") user.avatar = req.body.avatar.slice(0, 8);
    saveUsers();
    res.json(sansSecret(user));
  });

  app.post("/auth/logout", (req, res) => {
    res.setHeader("Set-Cookie", `mb_sid=;${domaineCookie()} HttpOnly; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  if (DEV_MODE) {
    app.get("/auth/x/login", (_req, res) => {
      const id = `dev-${crypto.randomBytes(4).toString("hex")}`;
      users[id] = { id, pseudo: "", pseudoChosen: false, avatar: "🎬", totalScore: 0, gamesPlayed: 0, credits: STARTING_CREDITS, points: 0, role: "joueur", amis: [], demandesRecues: [], demandesEnvoyees: [], bloques: [], claimedBonuses: [] };
      saveUsers();
      createSession(res, users[id]);
      res.redirect("/");
    });
    return;
  }

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
      const tokenRes = await fetch("https://twitter.com/twitter/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
        body: new URLSearchParams({ code, grant_type: "authorization_code", client_id: CLIENT_ID, redirect_uri: CALLBACK, code_verifier: entry.verifier }),
      });
      const token = await tokenRes.json();
      if (!token.access_token) throw new Error(JSON.stringify(token));
      const meRes = await fetch("https://api.twitter.com/2/users/me", { headers: { Authorization: `Bearer ${token.access_token}` } });
      const { data } = await meRes.json();
      if (!data?.id) throw new Error("profil X illisible");
      const id = `x:${data.id}`;
      users[id] = users[id] || { id, pseudo: "", pseudoChosen: false, suggestion: data.username.slice(0, 20), avatar: "🎬", totalScore: 0, gamesPlayed: 0, credits: STARTING_CREDITS, points: 0, role: "joueur", amis: [], demandesRecues: [], demandesEnvoyees: [], bloques: [], claimedBonuses: [] };
      users[id].xHandle = data.username;
      saveUsers();
      createSession(res, users[id]);
      res.redirect("/");
    } catch (err) {
      res.redirect("/?erreur=auth");
    }
  });
}

export function genererCodeAdmin() {
  const code = genererCodeParrain();
  if (!users["master_admin"]) {
    users["master_admin"] = { id: "master_admin", pseudo: "VIP", pseudoChosen: true, avatar: "👑", totalScore: 0, gamesPlayed: 0, credits: 0, points: 0, role: "admin", amis: [], demandesRecues: [], demandesEnvoyees: [], bloques: [], claimedBonuses: [], filleuls: [] };
  }
  users["master_admin"].codeParrain = code;
  users["master_admin"].usagesMax = 999999;
  saveUsers();
  return code;
}
