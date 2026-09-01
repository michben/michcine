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
import { charger, sauver } from "./db.js";

const CLIENT_ID = process.env.X_CLIENT_ID;
const CLIENT_SECRET = process.env.X_CLIENT_SECRET;
const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const CALLBACK = `${PUBLIC_URL}/auth/x/callback`;
const DEV_MODE = !CLIENT_ID; // aucune clé X : connexion locale de test

const USERS_FILE = new URL("./users.json", import.meta.url);
let users = {};
const saveUsers = () => sauver("users", users, USERS_FILE);

/** À appeler au démarrage, avant de servir la moindre requête. */
export async function chargerUtilisateurs() {
  users = await charger("users", USERS_FILE, {});
  // comptes créés avant l'arrivée des amis
  for (const u of Object.values(users))
    for (const champ of ["amis", "demandesRecues", "demandesEnvoyees", "bloques", "claimedBonuses"])
      if (!Array.isArray(u[champ])) u[champ] = [];
  // comptes créés avant l'arrivée du classement global
  for (const u of Object.values(users)) {
    if (u.scoreGlobal === undefined) u.scoreGlobal = u.totalScore || 0;
    if (u.partiesGlobales === undefined) u.partiesGlobales = u.gamesPlayed || 0;
  }
  console.log(`${Object.keys(users).length} compte(s) chargé(s).`);
}

const connectes = new Map(); // userId -> nombre d'onglets ouverts

/**
 * Sessions signées plutôt que stockées.
 *
 * Le cookie contient l'identifiant, une date d'expiration et une signature.
 * Le serveur n'a donc rien à mémoriser : une session survit aux redémarrages
 * et aux redéploiements, ce qui n'était pas le cas avec une table en mémoire —
 * les joueurs se retrouvaient déconnectés au moindre réveil du service.
 */
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.LICENSE_SECRET;
if (!SESSION_SECRET)
  console.warn("⚠️  SESSION_SECRET absent : les sessions seront perdues à chaque redémarrage.");
const CLE_SESSION = SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const DUREE_SESSION = 60 * 60 * 24 * 30; // 30 jours

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

  // comparaison à durée constante : évite de laisser deviner la signature
  const attendue = Buffer.from(signature(`${idEncode}.${expire}`));
  const fournie = Buffer.from(sig);
  if (attendue.length !== fournie.length || !crypto.timingSafeEqual(attendue, fournie)) return null;
  if (Number(expire) < Date.now() / 1000) return null;

  return Buffer.from(idEncode, "base64url").toString();
}
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
  const userId = lireJeton(parseCookies(cookieHeader).mb_sid);
  return userId ? users[userId] || null : null;
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

/** Emplacements pépites bonus, gagnés via les coffres de niveau (au-delà des 5 de base). */
export const pepiteSlotsBonus = (userId) => Number(users[userId]?.pepiteSlotsBonus) || 0;
export function accorderPepiteSlotBonus(userId, n = 1) {
  const u = users[userId];
  if (!u) return 0;
  u.pepiteSlotsBonus = (Number(u.pepiteSlotsBonus) || 0) + n;
  saveUsers();
  return u.pepiteSlotsBonus;
}

/** Tours de roue bonus (hors tour gratuit quotidien), gagnés via les coffres de niveau. */
export const tourRoueBonusDisponible = (userId) => (Number(users[userId]?.toursRoueBonus) || 0) > 0;
export function accorderTourRoueBonus(userId, n = 1) {
  const u = users[userId];
  if (!u) return 0;
  u.toursRoueBonus = (Number(u.toursRoueBonus) || 0) + n;
  saveUsers();
  return u.toursRoueBonus;
}
export function consommerTourRoueBonus(userId) {
  const u = users[userId];
  if (!u || !((Number(u.toursRoueBonus) || 0) > 0)) return false;
  u.toursRoueBonus -= 1;
  saveUsers();
  return true;
}

/** Marque un coffre de niveau (tous les 15 niveaux) comme réclamé. */
export function marquerCoffreReclame(userId, lvl) {
  const u = users[userId];
  if (!u) return;
  u.claimedChests = u.claimedChests || [];
  if (!u.claimedChests.includes(lvl)) u.claimedChests.push(lvl);
  saveUsers();
}

/** La roue quotidienne : un tour gratuit par « journée de roue » (18h à 18h). */
export function roueGratuiteDisponible(userId, jour) {
  const u = users[userId];
  return Boolean(u) && u.derniereRoueGratuite !== jour;
}
export function marquerRoueGratuiteUtilisee(userId, jour) {
  const u = users[userId];
  if (!u) return;
  u.derniereRoueGratuite = jour;
  saveUsers();
}

/**
 * Question bonus du jour (voir server.js, /api/question-bonus) : un seul essai par jour et par
 * joueur, verrouillé dès qu'il commence (voir questionBonusCommencer) — répondre juste ET à temps
 * rapporte des tickets ; tout le reste (mauvaise réponse, hors délai, ou pas de réponse du tout)
 * attend simplement le lendemain, sans jamais bloquer le joueur plus d'un jour. `u.questionBonusJour`
 * n'étant mis à jour qu'au moment de « commencer », un jour différent de celui demandé veut
 * simplement dire « rien fait aujourd'hui » — donc disponible, que le dernier essai remonte à hier
 * ou à jamais.
 */
export function questionBonusEtat(userId, jour) {
  const u = users[userId];
  if (!u || u.questionBonusJour !== jour) return { dejaTente: false, enCours: false, debutTs: null, resultat: null };
  return {
    dejaTente: Boolean(u.questionBonusResultat),
    enCours: !u.questionBonusResultat,
    debutTs: u.questionBonusDebutTs || null,
    resultat: u.questionBonusResultat || null,
  };
}
export function questionBonusCommencer(userId, jour) {
  const u = users[userId];
  if (!u) return null;
  u.questionBonusJour = jour;
  u.questionBonusDebutTs = Date.now();
  u.questionBonusResultat = null;
  saveUsers();
  return u.questionBonusDebutTs;
}
export function questionBonusEnregistrerResultat(userId, jour, resultat) {
  const u = users[userId];
  if (!u || u.questionBonusJour !== jour) return;
  u.questionBonusResultat = resultat;
  saveUsers();
}
/** Si une tentative du jour a été commencée mais jamais résolue (le joueur a laissé filer le délai
 *  sans jamais valider de réponse, ou a simplement fermé la page) : on la referme nous-mêmes en
 *  « perdu, hors délai » dès qu'on la recroise, pour ne jamais laisser un joueur « en cours »
 *  indéfiniment ni lui permettre de relancer un nouveau délai en rappelant « commencer ». */
export function questionBonusResoudreSiExpiree(userId, jour, delaiMs, bonneReponse) {
  const u = users[userId];
  if (!u || u.questionBonusJour !== jour || u.questionBonusResultat) return null;
  if (Date.now() - (u.questionBonusDebutTs || 0) <= delaiMs) return null; // encore dans les temps
  const resultat = { gagne: false, bonneReponse, tickets: 0, expire: true };
  u.questionBonusResultat = resultat;
  saveUsers();
  return { dejaTente: true, resultat };
}

const MAX_TIRS_PAYANTS_ROUE = 10;

/** Nombre de tours payants déjà effectués aujourd'hui (remis à zéro à chaque nouvelle journée de roue). */
export function roueTirsPayantsAujourdhui(userId, jour) {
  const u = users[userId];
  if (!u) return 0;
  return u.roueJourPayant === jour ? (u.roueTirsPayants || 0) : 0;
}
/** Reste-t-il un tour payant disponible aujourd'hui (max 10/jour) ? */
export function roueTirPayantDisponible(userId, jour) {
  return roueTirsPayantsAujourdhui(userId, jour) < MAX_TIRS_PAYANTS_ROUE;
}
export function marquerTirPayantRoueUtilise(userId, jour) {
  const u = users[userId];
  if (!u) return;
  if (u.roueJourPayant !== jour) { u.roueJourPayant = jour; u.roueTirsPayants = 0; }
  u.roueTirsPayants = (u.roueTirsPayants || 0) + 1;
  saveUsers();
}
export const ROUE_MAX_TIRS_PAYANTS = MAX_TIRS_PAYANTS_ROUE;

// Tours gagnés en regardant une publicité : plafonnés séparément des tours payants, sur un
// cycle fixe de 12 h ancré sur une heure choisie en console admin (18h par défaut — comme le
// réapprovisionnement de la roue — et donc aussi 6h, 12h plus tard), plutôt qu'un délai glissant
// depuis la dernière pub regardée : plus simple à annoncer aux joueurs ("ça recharge à 18h").
// Le nombre max (5 par défaut) et l'heure d'ancrage sont tous deux réglables depuis la console.
export const PUB_MAX_DEFAUT = 5;
export const PUB_HEURE_RECHARGE_DEFAUT = 18;

/** Horodatage (ms epoch) du début du cycle de recharge en cours, pour une heure d'ancrage
 *  donnée (0-23) — le cycle bascule à `heureAncrage`:00 et `heureAncrage+12`:00 chaque jour. */
function debutCyclePub(heureAncrage) {
  const maintenant = Date.now();
  const heures = [heureAncrage % 24, (heureAncrage + 12) % 24];
  const candidats = [];
  for (let offsetJour = -1; offsetJour <= 0; offsetJour++) {
    for (const h of heures) {
      const d = new Date();
      d.setHours(h, 0, 0, 0);
      d.setDate(d.getDate() + offsetJour);
      candidats.push(d.getTime());
    }
  }
  return Math.max(...candidats.filter((t) => t <= maintenant));
}
/** Horodatage (ms epoch) de la prochaine recharge (fin du cycle en cours). */
export function roueProchaineRechargePub(heureAncrage = PUB_HEURE_RECHARGE_DEFAUT) {
  return debutCyclePub(heureAncrage) + 12 * 60 * 60 * 1000;
}
/** Nombre de tours "gagnés en regardant une pub" effectués depuis le début du cycle en cours. */
export function roueTirsPubCycle(userId, heureAncrage = PUB_HEURE_RECHARGE_DEFAUT) {
  const u = users[userId];
  if (!u) return 0;
  return u.pubCycleDebut === debutCyclePub(heureAncrage) ? (u.pubCompteur || 0) : 0;
}
/** Reste-t-il un tour "publicité" disponible dans le cycle en cours ? */
export function roueTirPubDisponible(userId, heureAncrage = PUB_HEURE_RECHARGE_DEFAUT, max = PUB_MAX_DEFAUT) {
  return roueTirsPubCycle(userId, heureAncrage) < max;
}
export function marquerTirPubRoueUtilise(userId, heureAncrage = PUB_HEURE_RECHARGE_DEFAUT) {
  const u = users[userId];
  if (!u) return;
  const debut = debutCyclePub(heureAncrage);
  if (u.pubCycleDebut !== debut) { u.pubCycleDebut = debut; u.pubCompteur = 0; }
  u.pubCompteur = (u.pubCompteur || 0) + 1;
  saveUsers();
}
export const ROUE_MAX_TIRS_PUB = PUB_MAX_DEFAUT;

/** Présence : un joueur peut avoir plusieurs onglets, on compte les connexions. */
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

/* ---------- captcha et validation par email ---------- */

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_EXPEDITEUR = process.env.EMAIL_EXPEDITEUR || "MichBen Ciné Quizz <onboarding@resend.dev>";

/**
 * Vérifie le jeton Cloudflare Turnstile auprès de leurs serveurs.
 * Sans clé configurée, la vérification est ignorée : pratique en local,
 * à ne surtout pas laisser ainsi en production.
 */
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
    console.error("Captcha injoignable :", e.message);
    return false;   // en cas de panne, on refuse plutôt que d'ouvrir la porte
  }
}

const codeQuatreChiffres = () => String(crypto.randomInt(1000, 10000));

/** Envoi du code par email. Sans clé, le code est écrit dans les logs. */
async function envoyerCode(email, code) {
  if (!RESEND_API_KEY) {
    console.warn(`⚠️  Pas d'envoi d'email configuré. Code pour ${email} : ${code}`);
    return { simule: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: EMAIL_EXPEDITEUR,
      to: [email],
      subject: `${code} — votre code MichBen Ciné Quizz`,
      text: `Votre code de validation est ${code}.\n\n` +
            `Il expire dans 20 minutes. Si vous n'êtes pas à l'origine de cette inscription, ignorez ce message.`,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return { envoye: true };
}

export async function envoyerCodeValidation(userId) {
  const u = users[userId];
  if (!u || !u.email) return { error: "INTROUVABLE" };
  if (u.emailVerifie) return { error: "DEJA_VERIFIE" };

  // au maximum un envoi par minute, pour ne pas servir de robot d'envoi
  if (u.codeEnvoyeA && Date.now() - u.codeEnvoyeA < 60_000) return { error: "TROP_TOT" };

  u.code = codeQuatreChiffres();
  u.codeExpire = Date.now() + 20 * 60 * 1000;
  u.codeEnvoyeA = Date.now();
  u.codeEssais = 0;
  saveUsers();

  try {
    const r = await envoyerCode(u.email, u.code);
    return { ok: true, ...r };
  } catch (e) {
    console.error("Envoi du code échoué :", e.message);
    return { error: "ENVOI_ECHOUE" };
  }
}

/** Valide l'adresse d'un compte sans code — réservé à l'administration. */
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

/**
 * Un compte email doit être validé avant de jouer — mais seulement si
 * l'envoi d'emails est configuré. Sans clé, exiger un code bloquerait
 * les joueurs devant un écran dont ils ne recevraient jamais le message.
 */
/** Vrai tant que le compte n'a pas fourni de code de parrainage. */
export const parrainageManquant = (u) =>
  parrainageObligatoire() && Boolean(u) && !u.parrainId && !u.fondateur;

export const emailAValider = (u) =>
  Boolean(RESEND_API_KEY) && Boolean(u?.email) && !u.emailVerifie;

/* ---------- inscription par email ---------- */

const normEmail = (e) => String(e || "").trim().toLowerCase();
const emailValide = (e) => /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(e);

/** Empreinte du mot de passe : scrypt avec sel, jamais le mot de passe en clair. */
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
    creeLe: new Date().toISOString(),
  };
  saveUsers();
  return { user: users[id] };
}

export function connecterEmail(email, motDePasse) {
  const u = parEmail(normEmail(email));
  // même message dans les deux cas : ne pas révéler quels emails existent
  if (!u || !verifierMotDePasse(motDePasse, u.motDePasse)) return { error: "IDENTIFIANTS_INVALIDES" };
  if (u.banned) return { error: "BANNI" };
  return { user: u };
}

/* ---------- comptes créés par l'administration (sans email) ---------- */

const normPseudo = (p) => String(p || "").trim();
const parPseudo = (p) =>
  Object.values(users).find((u) => (u.pseudo || "").toLowerCase() === p.toLowerCase());

/**
 * Compte créé directement par l'administration : identifiant (pseudo) +
 * mot de passe, sans adresse email à valider. Sert notamment aux comptes
 * enfant, remis en main propre par un adulte.
 */
export function creerCompteAdmin({ pseudo, motDePasse, enfant = false }) {
  const p = normPseudo(pseudo);
  if (p.length < 2 || p.length > 20) return { error: "PSEUDO_INVALIDE" };
  if (String(motDePasse || "").length < 6) return { error: "MOT_DE_PASSE_COURT" };
  if (parPseudo(p)) return { error: "PSEUDO_PRIS" };

  const id = `local:${crypto.randomBytes(8).toString("hex")}`;
  users[id] = {
    id, pseudo: p, pseudoChosen: true,
    avatar: enfant ? "🧒" : "🎬",
    motDePasse: hacher(motDePasse),
    totalScore: 0, gamesPlayed: 0, credits: STARTING_CREDITS, points: 0,
    role: enfant ? "enfant" : "joueur",
    emailVerifie: true,     // pas d'email à valider pour un compte créé par l'admin
    fondateur: true,        // dispensé de code de parrainage : le compte vient déjà d'un adulte de confiance
    amis: [], demandesRecues: [], demandesEnvoyees: [], bloques: [], claimedBonuses: [],
    creeLe: new Date().toISOString(),
  };
  saveUsers();
  return { user: users[id] };
}

/** Connexion par pseudo + mot de passe, pour les comptes créés par l'administration. */
export function connecterPseudo(pseudo, motDePasse) {
  const u = parPseudo(normPseudo(pseudo));
  if (!u || !verifierMotDePasse(motDePasse, u.motDePasse)) return { error: "IDENTIFIANTS_INVALIDES" };
  if (u.banned) return { error: "BANNI" };
  return { user: u };
}

/** Retire les champs sensibles avant d'envoyer un utilisateur au client. */
export const sansMotDePasse = (u) => {
  const { motDePasse, code, codeExpire, codeEssais, ...reste } = u;
  return reste;
};

/* ---------- niveaux et expérience ---------- */

/**
 * L'expérience nécessaire augmente à chaque niveau : les premiers montent
 * vite, ce qui donne un sentiment de progression immédiat, puis le rythme
 * ralentit pour que les niveaux élevés gardent de la valeur.
 */
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

/** Ajoute de l'expérience et signale une éventuelle montée de niveau. */
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

/* ---------- parrainage ---------- */

const PARTIES_POUR_CODE = Number(process.env.PARTIES_POUR_CODE || 25);
const USAGES_PAR_CODE = Number(process.env.USAGES_PAR_CODE || 5);        // pour un code de première génération
const USAGES_FILLEUL = Number(process.env.USAGES_FILLEUL || 3);          // pour un code obtenu par parrainage
const ALPHABET_CODE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // sans I, O, 0, 1

/** Le parrainage est exigé seulement si la variable est active. */
export const parrainageObligatoire = () => process.env.PARRAINAGE === "obligatoire";

function genererCodeParrain() {
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      ALPHABET_CODE[crypto.randomInt(ALPHABET_CODE.length)]).join("");
  } while (Object.values(users).some((u) => u.codeParrain === code));
  return code;
}

/**
 * Attribue son code au joueur dès qu'il atteint le seuil de parties.
 * Appelé après chaque partie : le code apparaît alors de lui-même.
 */
/**
 * Attribue son code au joueur dès le seuil atteint.
 * Un joueur arrivé par parrainage dispose de moins d'invitations que les
 * premiers membres : la croissance reste maîtrisée de génération en génération.
 */
export function verifierCodeParrain(userId) {
  const u = users[userId];
  if (!u || u.codeParrain) return null;
  if ((u.partiesGlobales || 0) < PARTIES_POUR_CODE) return null;
  u.codeParrain = genererCodeParrain();
  u.usagesMax = u.parrainId ? USAGES_FILLEUL : USAGES_PAR_CODE;
  saveUsers();
  return u.codeParrain;
}

/**
 * Lot « Code VIP » de la roue quotidienne : donne au gagnant la capacité de
 * parrainer sans avoir atteint le seuil de parties habituel. S'il a déjà un
 * code, le lot ajoute simplement des invitations supplémentaires plutôt que
 * de le remplacer.
 */
export function genererCodeParrainGagne(userId) {
  const u = users[userId];
  if (!u) return null;
  if (!u.codeParrain) {
    u.codeParrain = genererCodeParrain();
    u.usagesMax = u.parrainId ? USAGES_FILLEUL : USAGES_PAR_CODE;
  } else {
    u.usagesMax = (u.usagesMax ?? USAGES_PAR_CODE) + USAGES_PAR_CODE;
  }
  saveUsers();
  return u.codeParrain;
}

const usagesRestants = (u) =>
  Math.max(0, (u.usagesMax ?? USAGES_PAR_CODE) - (u.filleuls || []).length);

const parCode = (code) =>
  Object.values(users).find((u) => u.codeParrain === String(code || "").toUpperCase().trim());

/** Valide un code sans consommer quoi que ce soit. */
export function verifierCode(code) {
  const parrain = parCode(code);
  if (!parrain || parrain.banned) return { error: "CODE_INCONNU" };
  if (usagesRestants(parrain) <= 0) return { error: "CODE_EPUISE" };
  return { ok: true, parrain: { id: parrain.id, pseudo: parrain.pseudo,
                                avatar: parrain.avatar, photo: parrain.photo || null },
           restants: usagesRestants(parrain) };
}

/** Rattache un nouveau compte à son parrain. Irréversible et unique. */
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

/** Ce que le joueur voit de son propre parrainage. */
export function infoParrainage(userId) {
  const u = users[userId];
  if (!u) return null;
  const bref = (id) => {
    const x = users[id];
    return x && x.pseudoChosen
      ? { id: x.id, pseudo: x.pseudo, avatar: x.avatar, photo: x.photo || null,
          online: connectes.has(x.id) }
      : null;
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

/* ---------- amis ---------- */

const lien = (u) => ({ id: u.id, pseudo: u.pseudo, avatar: u.avatar, photo: u.photo || null,
                       niveau: u.niveau || 0, fondateur: Boolean(u.fondateur),
                       online: connectes.has(u.id), role: u.role || "joueur" });

/** Listes d'amis, demandes reçues et envoyées, comptes bloqués. */
export function relations(userId) {
  const u = users[userId];
  if (!u) return null;
  const vus = (liste = []) => liste.map((id) => users[id]).filter(Boolean).map(lien);
  return {
    amis: vus(u.amis),
    recues: vus(u.demandesRecues),
    envoyees: vus(u.demandesEnvoyees),
    bloques: vus(u.bloques),
  };
}

const pousser = (liste, id) => (liste.includes(id) ? liste : [...liste, id]);
const retirer = (liste, id) => liste.filter((x) => x !== id);

export function demanderAmi(deId, versId) {
  const a = users[deId], b = users[versId];
  if (!a || !b || deId === versId) return { error: "INTROUVABLE" };
  if ((b.bloques || []).includes(deId)) return { error: "BLOQUE" };
  // Un compte enfant et un compte adulte ne peuvent jamais devenir amis directement :
  // il n'existe aucun mécanisme d'approbation parentale dans le jeu, donc on refuse
  // systématiquement plutôt que de laisser passer un lien non supervisé.
  if (estEnfant(a) !== estEnfant(b)) return { error: "MONDE_DIFFERENT" };
  if ((a.amis || []).includes(versId)) return { error: "DEJA_AMIS" };

  // demande croisée : on lie directement les deux comptes
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
  // Filet de sécurité : même une demande déjà en attente ne doit jamais aboutir
  // à un lien enfant ↔ adulte.
  if (estEnfant(a) !== estEnfant(b)) return { error: "MONDE_DIFFERENT" };

  a.demandesRecues = retirer(a.demandesRecues || [], autreId);
  b.demandesEnvoyees = retirer(b.demandesEnvoyees || [], userId);
  a.amis = pousser(a.amis || [], autreId);
  b.amis = pousser(b.amis || [], userId);
  saveUsers();
  return { ok: true, statut: "amis" };
}

/** Retire l'amitié et toute demande en cours, dans les deux sens. */
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
  if (bloquerOuNon) {
    retirerAmi(userId, autreId);        // bloquer rompt le lien
    a.bloques = pousser(a.bloques || [], autreId);
  } else {
    a.bloques = retirer(a.bloques || [], autreId);
  }
  saveUsers();
  return { ok: true, bloque: bloquerOuNon };
}

export const estBloque = (userId, autreId) =>
  (users[userId]?.bloques || []).includes(autreId) ||
  (users[autreId]?.bloques || []).includes(userId);

/** Le joueur a-t-il activé « Partager ma partie » dans son profil ? Faux par défaut : le
 * partage est un choix explicite du joueur, pas une option activée pour tout le monde. */
export const partageJeuActif = (userId) => users[userId]?.partageJeu === true;

/** Recherche par pseudo, insensible à la casse. */
export function chercherJoueurs(requete, saufId, limite = 15) {
  const q = String(requete || "").trim().toLowerCase();
  if (q.length < 2) return [];
  // Un compte enfant ne doit jamais croiser un compte adulte, ni dans un sens ni dans l'autre :
  // la recherche reste cantonnée au même « monde » (enfant ↔ enfant, adulte ↔ adulte).
  const monMonde = estEnfant(users[saufId]);
  return Object.values(users)
    .filter((u) => u.pseudoChosen && u.id !== saufId && !u.banned &&
                   (u.pseudo || "").toLowerCase().includes(q) &&
                   !(u.bloques || []).includes(saufId) &&
                   estEnfant(u) === monMonde)
    .slice(0, limite)
    .map(lien);
}

/**
 * Fiche publique d'un joueur : ce que n'importe qui peut voir de lui.
 * Volontairement limitée — ni email, ni identifiant X, ni cagnotte : ce sont
 * ses affaires, pas celles des autres joueurs.
 */
export function fichePublique(id, demandeurId) {
  const u = users[id];
  if (!u || !u.pseudoChosen) return null;
  if ((u.bloques || []).includes(demandeurId)) return null;   // il ne veut pas être vu

  const classement = (champ) => {
    const tries = Object.values(users)
      .filter((x) => x.pseudoChosen && (x[champ] || 0) > 0)
      .sort((a, b) => (b[champ] || 0) - (a[champ] || 0));
    const rang = tries.findIndex((x) => x.id === id);
    return rang === -1 ? null : { rang: rang + 1, sur: tries.length };
  };

  return {
    id: u.id, pseudo: u.pseudo, avatar: u.avatar, photo: u.photo || null,
    role: u.role || "joueur",
    fondateur: Boolean(u.fondateur),
    online: connectes.has(u.id),
    niveau: u.niveau || 0,
    xp: u.xp || 0,
    scoreGlobal: u.scoreGlobal || 0,
    partiesGlobales: u.partiesGlobales || 0,
    scoreSaison: u.totalScore || 0,
    partiesSaison: u.gamesPlayed || 0,
    moyenne: (u.partiesGlobales || 0)
      ? Math.round((u.scoreGlobal || 0) / u.partiesGlobales) : 0,
    rangGlobal: classement("scoreGlobal"),
    rangSaison: classement("totalScore"),
    amis: (u.amis || []).length,
    // Nombre d'amis en commun avec le demandeur, sans jamais lister les noms — juste le chiffre.
    amisCommuns: amisCommuns(demandeurId, id),
    relation: statutRelation(demandeurId, id),
  };
}

/** Combien d'amis deux comptes ont-ils en commun ? Le chiffre seul, jamais la liste. */
function amisCommuns(userId, autreId) {
  if (!userId || !autreId || userId === autreId) return 0;
  const mesAmis = users[userId]?.amis || [];
  if (!mesAmis.length) return 0;
  const sesAmis = new Set(users[autreId]?.amis || []);
  return mesAmis.filter((aId) => sesAmis.has(aId)).length;
}

/** Relation entre deux joueurs, pour afficher le bon bouton. */
export function statutRelation(userId, autreId) {
  const u = users[userId];
  if (!u || userId === autreId) return "soi";
  if ((u.bloques || []).includes(autreId)) return "bloque";
  if ((u.amis || []).includes(autreId)) return "ami";
  if ((u.demandesEnvoyees || []).includes(autreId)) return "envoyee";
  if ((u.demandesRecues || []).includes(autreId)) return "recue";
  return "aucun";
}

/* ---------- rôles ---------- */

export const ROLES = ["joueur", "moderateur", "admin", "enfant"];
export const estModerateur = (user) => user && ["moderateur", "admin"].includes(user.role);
export const estEnfant = (user) => Boolean(user && user.role === "enfant");

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
/** Pseudo d'un joueur à partir de son id, ou null s'il n'existe plus — usage admin uniquement. */
export const pseudoDe = (userId) => users[userId]?.pseudo || null;

/** Retire des points de la cagnotte (don à un ami). */
export function retirerPoints(userId, montant) {
  const u = users[userId];
  if (!u || (u.points ?? 0) < montant) return false;
  u.points -= montant;
  saveUsers();
  return true;
}

/**
 * Crédite un don reçu. N'alimente ni le classement ni le compteur de parties :
 * un score doit se gagner en jouant, pas se recevoir.
 */
export function grantPointsDon(userId, montant) {
  const u = users[userId];
  if (!u) return;
  u.points = (u.points ?? 0) + montant;
  saveUsers();
}

/**
 * Cagnotte dépensable, alimentée à chaque partie, distincte du classement.
 * Le compteur de parties augmente même à zéro point : une partie perdue
 * reste une partie jouée, et compte pour débloquer le code d'invitation.
 */
export function grantPoints(userId, points) {
  const user = users[userId];
  if (!user) return;
  const gagnes = Math.max(0, points || 0);
  user.points = (user.points ?? 0) + gagnes;
  user.scoreGlobal = (user.scoreGlobal || 0) + gagnes;
  user.partiesGlobales = (user.partiesGlobales || 0) + 1;
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

/** Les comptes les plus récents en premier (les comptes créés avant l'ajout de ce suivi n'ont
 *  pas de date : ils sont traités comme les plus anciens et se retrouvent donc en bas). */
export const listUsers = () =>
  Object.values(users)
    .sort((x, y) => new Date(y.creeLe || 0) - new Date(x.creeLe || 0))
    .map(({ motDePasse, code, codeExpire, codeEssais, ...reste }) => reste);

/**
 * Photo de profil imposée par l'administration.
 * Le joueur ne peut pas la modifier : c'est voulu, cela évite les images
 * choquantes ou l'usurpation d'identité par la photo.
 */
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
  if (typeof changes.pseudo === "string" && changes.pseudo.trim().length >= 2) {
    user.pseudo = changes.pseudo.trim().slice(0, 20);
    user.pseudoChosen = true;
  }
  if (changes.banned === true || changes.banned === false) user.banned = changes.banned;
  if (ROLES.includes(changes.role)) user.role = changes.role;
  if (changes.fondateur === true || changes.fondateur === false) user.fondateur = changes.fondateur;
  if (typeof changes.photo === "string") {
    const p = changes.photo.trim();
    p ? (user.photo = p.slice(0, 500)) : delete user.photo;
  }
  saveUsers();
  return user;
}

export function adminDeleteUser(id) {
  if (!users[id]) return false;
  delete users[id];   // le jeton reste valide mais ne correspond plus à aucun compte
  saveUsers();
  return true;
}

/** Nombre total de comptes créés depuis le début — pour le petit indicateur du menu. */
export const nombreComptes = () => Object.keys(users).length;

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
  points = Math.max(0, points || 0);
  user.totalScore = (user.totalScore || 0) + points;    // classement de la saison
  user.gamesPlayed = (user.gamesPlayed || 0) + 1;
  saveUsers();
}

/**
 * Deux classements distincts :
 *  — « global » cumule toutes les parties depuis l'inscription, il ne baisse
 *    jamais et récompense la fidélité ;
 *  — « saison » ne compte que les parties classées de la saison en cours, et
 *    repart de zéro à chaque nouvelle saison.
 */
export const leaderboard = (limit = 50, type = "saison") => {
  const champ = type === "global" ? "scoreGlobal" : "totalScore";
  const parties = type === "global" ? "partiesGlobales" : "gamesPlayed";
  // Le classement enfant est séparé : les comptes enfant n'apparaissent jamais
  // dans les classements « saison » ou « global », et inversement.
  return Object.values(users)
    .filter((u) => u.pseudoChosen && ((u[parties] || 0) > 0 || (u[champ] || 0) > 0))
    .filter((u) => (type === "enfant") === (u.role === "enfant"))
    .sort((a, b) => (b[champ] || 0) - (a[champ] || 0))
    .slice(0, limit)
    .map((u, i) => ({
      id: u.id,   // permet d'ouvrir la fiche du joueur depuis le classement
      rank: i + 1, pseudo: u.pseudo, avatar: u.avatar, photo: u.photo || null, niveau: u.niveau || 0,
      totalScore: u[champ] || 0, gamesPlayed: u[parties] || 0,
      online: connectes.has(u.id), role: u.role || "joueur", fondateur: Boolean(u.fondateur),
    }));
};

/** Position d'un joueur précis dans un classement, même s'il n'est pas dans le top affiché par
 *  leaderboard() (qui se limite à `limit` lignes) — pour la carte « votre position » sur l'accueil.
 *  Retourne `null` si le compte n'a pas encore choisi de pseudo (voir pseudoChosen). */
export const monClassement = (userId, type = "saison") => {
  const u0 = users[userId];
  if (!u0 || !u0.pseudoChosen) return null;
  const champ = type === "global" ? "scoreGlobal" : "totalScore";
  const parties = type === "global" ? "partiesGlobales" : "gamesPlayed";
  const classe = Object.values(users)
    .filter((u) => u.pseudoChosen && ((u[parties] || 0) > 0 || (u[champ] || 0) > 0))
    .filter((u) => (type === "enfant") === (u.role === "enfant"))
    .sort((a, b) => (b[champ] || 0) - (a[champ] || 0));
  const idx = classe.findIndex((u) => u.id === userId);
  if (idx === -1) return { rang: null, total: classe.length, score: u0[champ] || 0 };
  return { rang: idx + 1, total: classe.length, score: classe[idx][champ] || 0 };
};

/** Remet à zéro le classement de saison, sans toucher au classement global. */
export function reinitialiserClassement() {
  for (const u of Object.values(users)) { u.totalScore = 0; u.gamesPlayed = 0; }
  saveUsers();
}

/**
 * Domaine du cookie : sans cela, une session ouverte sur www.exemple.fr
 * n'est pas reconnue sur exemple.fr, et le joueur paraît déconnecté.
 * On pose donc le cookie sur le domaine parent quand l'hôte commence par www.
 */
function domaineCookie() {
  try {
    const hote = new URL(PUBLIC_URL).hostname;
    if (hote === "localhost" || /^[\d.]+$/.test(hote)) return "";      // local ou adresse IP
    return hote.startsWith("www.") ? ` Domain=${hote.slice(4)};` : "";
  } catch { return ""; }
}

function createSession(res, user) {
  const sid = creerJeton(user.id);
  const secure = PUBLIC_URL.startsWith("https") ? " Secure;" : "";
  res.setHeader("Set-Cookie",
    `mb_sid=${sid}; HttpOnly;${secure}${domaineCookie()} SameSite=Lax; Path=/; Max-Age=${DUREE_SESSION}`);
}

/* ---------- routes ---------- */

export function mountAuth(app) {
  const sansSecret = ({ motDePasse, code, codeExpire, codeEssais, ...reste }) => reste;

  app.get("/api/me", (req, res) => {
    const user = userFromCookie(req.headers.cookie);
    if (!user) return res.status(401).json({ error: "NOT_AUTHENTICATED", devMode: DEV_MODE });
    res.json(sansSecret(user));
  });

  app.post("/auth/email/inscription", async (req, res) => {
    if (!(await captchaValide(req.body.captcha, req.ip)))
      return res.status(400).json({ error: "CAPTCHA_INVALIDE" });

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

  app.get("/api/captcha", (_req, res) =>
    res.json({ siteKey: process.env.TURNSTILE_SITE_KEY || null }));

  app.post("/auth/email/connexion", (req, res) => {
    const r = connecterEmail(req.body.email, req.body.motDePasse);
    if (r.error) return res.status(401).json(r);
    createSession(res, r.user);
    res.json(sansSecret(r.user));
  });

  /** Connexion des comptes créés par l'administration (identifiant + mot de passe, sans email). */
  app.post("/auth/enfant/connexion", (req, res) => {
    const r = connecterPseudo(req.body.pseudo, req.body.motDePasse);
    if (r.error) return res.status(401).json(r);
    createSession(res, r.user);
    res.json(sansSecret(r.user));
  });


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
    // la photo n'est pas modifiable ici : seule l'administration la définit
    if (typeof req.body.avatar === "string") user.avatar = req.body.avatar.slice(0, 8);
    // Partage de partie : le joueur doit explicitement cocher cette case pour que ses
    // amis puissent le regarder en direct (en plus du réglage global de l'administrateur).
    if (typeof req.body.partageJeu === "boolean") user.partageJeu = req.body.partageJeu;
    saveUsers();
    res.json(sansSecret(user));
  });

  /** Réponse (une seule fois, définitive) au bandeau cookies/vie privée — voir #popCookies côté
   *  client. `cookiesReponse` absent = jamais répondu (compte nouveau ou déjà existant avant
   *  l'ajout de ce bandeau, les deux cas sont traités pareil) ; une fois posé, on ne redemande
   *  plus jamais, quelle que soit la réponse donnée. */
  app.post("/api/cookies-reponse", (req, res) => {
    const user = userFromCookie(req.headers.cookie);
    if (!user) return res.status(401).json({ error: "NOT_AUTHENTICATED" });
    user.cookiesReponse = req.body?.accepte === true ? "accepte" : "refuse";
    user.cookiesReponseLe = new Date().toISOString();
    saveUsers();
    res.json(sansSecret(user));
  });

  app.post("/auth/logout", (req, res) => {
    res.setHeader("Set-Cookie", `mb_sid=;${domaineCookie()} HttpOnly; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  /* --- Page de retour après connexion : "/" par défaut, ou une page précise (ex. "/vocal")
     quand le lien de connexion l'a demandé via ?retour=/vocal — utilisé par la page indépendante
     du salon vocal pour ramener le joueur exactement là où il voulait aller, plutôt que de le
     laisser sur l'accueil du jeu après s'être connecté. Validée strictement (chemin interne
     commençant par un seul "/", jamais une adresse externe) pour ne jamais servir de redirection
     ouverte. */
  function retourValide(valeur) {
    const v = String(valeur || "");
    return /^\/[a-zA-Z0-9_-]*$/.test(v) ? v : "/";
  }

  /* --- Mode développement : aucune clé X configurée --- */
  if (DEV_MODE) {
    console.warn("⚠️  X_CLIENT_ID absent : connexion de test activée. NE PAS DÉPLOYER AINSI.");
    app.get("/auth/x/login", (req, res) => {
      const id = `dev-${crypto.randomBytes(4).toString("hex")}`;
      users[id] = { id, pseudo: "", pseudoChosen: false, avatar: "🎬", totalScore: 0, gamesPlayed: 0, credits: STARTING_CREDITS, points: 0, role: "joueur",
        amis: [], demandesRecues: [], demandesEnvoyees: [], bloques: [], claimedBonuses: [], creeLe: new Date().toISOString() };
      saveUsers();
      createSession(res, users[id]);
      res.redirect(retourValide(req.query.retour));
    });
    return;
  }

  /* --- OAuth 2.0 avec PKCE --- */
  app.get("/auth/x/login", (req, res) => {
    const state = b64url(crypto.randomBytes(16));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    pending.set(state, { verifier, createdAt: Date.now(), retour: retourValide(req.query.retour) });

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
        avatar: "🎬", totalScore: 0, gamesPlayed: 0, credits: STARTING_CREDITS, points: 0, role: "joueur",
        amis: [], demandesRecues: [], demandesEnvoyees: [], bloques: [], claimedBonuses: [], creeLe: new Date().toISOString() };
      users[id].xHandle = data.username;
      saveUsers();
      createSession(res, users[id]);
      res.redirect(entry.retour || "/");
    } catch (err) {
      console.error("Échec OAuth X :", err.message);
      res.redirect("/?erreur=auth");
    }
  });
}

/**
 * Passerelle ENTRANTE (sens autre jeu → Ciné Quizz, ex. Le Nouveau Bac) : un joueur connecté sur
 * cet autre projet clique sur son propre bouton 🔗 et arrive ici via /auth/michben/retour?mb_code=... .
 * On échange ce code contre son profil auprès de ce projet (appel serveur à serveur, authentifié
 * par la clé secrète partagée — jamais transmise au navigateur), puis on crée ou retrouve un
 * compte local à partir de son identifiant stable. Cet identifiant est déjà au même format que les
 * comptes X natifs d'ici (« x:123456789 ») : si cette même personne a par ailleurs déjà un compte
 * ici (arrivée directement via /auth/x/login), c'est exactement le même compte qui est retrouvé.
 * `getConfig()` doit renvoyer { actif, domaine, cleSecrete } — voir REGLAGES.passerelleEntrante
 * côté server.js (jamais codé en dur ici, réglable depuis la console admin).
 */
export function mountPasserelleEntrante(app, getConfig) {
  app.get("/auth/michben/retour", async (req, res) => {
    const config = getConfig() || {};
    const code = String(req.query.mb_code || "");
    if (!config.actif || !config.domaine || !config.cleSecrete)
      return res.redirect("/?erreur=passerelle_indisponible");
    if (!code) return res.redirect("/?erreur=passerelle_code_manquant");

    try {
      const r = await fetch(`${config.domaine.replace(/\/+$/, "")}/api/passerelle/echanger`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-passerelle-cle": config.cleSecrete },
        body: JSON.stringify({ code }),
      });
      const profil = await r.json().catch(() => ({}));
      if (!r.ok || !profil?.ok || !profil.id) {
        console.error("Passerelle entrante : échange refusé —", profil?.error || r.status);
        return res.redirect("/?erreur=passerelle");
      }

      const id = String(profil.id);
      const nouveau = !users[id];
      users[id] = users[id] || { id, pseudo: "", pseudoChosen: false, avatar: "🎬",
        totalScore: 0, gamesPlayed: 0, credits: STARTING_CREDITS, points: 0, role: "joueur",
        amis: [], demandesRecues: [], demandesEnvoyees: [], bloques: [], claimedBonuses: [],
        creeLe: new Date().toISOString() };

      // Un compte déjà créé directement ici garde son propre pseudo/avatar/photo choisis ; seule
      // la toute première arrivée (nouveau compte) reprend le profil de l'autre jeu — pseudo déjà
      // pris par quelqu'un d'autre ici (rarissime, mais possible) : on le garde en suggestion
      // plutôt que de créer un conflit, l'écran habituel de choix de pseudo prend le relais.
      if (nouveau) {
        const pseudoPris = Object.values(users).some(
          (u) => u.id !== id && (u.pseudo || "").toLowerCase() === String(profil.pseudo || "").toLowerCase()
        );
        if (profil.pseudo && !pseudoPris) {
          users[id].pseudo = String(profil.pseudo).slice(0, 20);
          users[id].pseudoChosen = true;
        } else if (profil.pseudo) {
          users[id].suggestion = String(profil.pseudo).slice(0, 20);
        }
        if (profil.avatar) users[id].avatar = String(profil.avatar).slice(0, 8);
        users[id].photo = profil.photo || null;
      }
      saveUsers();
      createSession(res, users[id]);
      res.redirect("/");
    } catch (err) {
      console.error("Passerelle entrante : erreur —", err.message);
      res.redirect("/?erreur=passerelle");
    }
  });
}

export function genererCodeAdmin() {
  const code = genererCodeParrain();
  if (!users["master_admin"]) {
    users["master_admin"] = {
      id: "master_admin", pseudo: "VIP", pseudoChosen: true, avatar: "👑", totalScore: 0, gamesPlayed: 0, credits: 0, points: 0, role: "admin", amis: [], demandesRecues: [], demandesEnvoyees: [], bloques: [], claimedBonuses: [], filleuls: []
    };
  }
  users["master_admin"].codeParrain = code;
  users["master_admin"].usagesMax = 999999;
  saveUsers();
  return code;
}

/* Nettoyage horaire des états OAuth abandonnés. */
setInterval(() => {
  const limit = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of pending) if (v.createdAt < limit) pending.delete(k);
}, 60 * 60 * 1000).unref?.();
