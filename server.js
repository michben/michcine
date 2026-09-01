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
import fs from "fs";
import { creerModuleVocalSalon } from "./vocal-salon.js";
import { mountAuth, mountPasserelleEntrante, userFromCookie, addRankedPoints,
         spendCredits, grantCredits, getCredits, CREDITS_PER_GAME,
         listUsers, adminUpdateUser, adminDeleteUser, grantAll,
         grantPoints, getPoints, exchangePoints,
         marquerEnLigne, marquerHorsLigne, estEnLigne, nombreEnLigne, getConnectedUsers,
         estModerateur, estEnfant, definirRole, ROLES, chargerUtilisateurs,
         relations, demanderAmi, accepterAmi, retirerAmi, bloquer,
         chercherJoueurs, statutRelation, estBloque, emailAValider, partageJeuActif,
         leaderboard, monClassement, reinitialiserClassement, definirPhoto, fichePublique, pseudoDe,
         retirerPoints, grantPointsDon, ajouterXp, infoNiveau, validerManuellement,
         verifierCode, rattacherParrain, infoParrainage, verifierCodeParrain,
         parrainageManquant, parrainageObligatoire, genererCodeAdmin,
         creerCompteAdmin, sansMotDePasse,
         genererCodeParrainGagne, roueGratuiteDisponible, marquerRoueGratuiteUtilisee,
         roueTirPayantDisponible, marquerTirPayantRoueUtilise, ROUE_MAX_TIRS_PAYANTS,
         roueTirPubDisponible, marquerTirPubRoueUtilise,
         roueTirsPubCycle, roueProchaineRechargePub,
         pepiteSlotsBonus, accorderPepiteSlotBonus,
         tourRoueBonusDisponible, accorderTourRoueBonus, consommerTourRoueBonus,
         marquerCoffreReclame, nombreComptes } from "./auth-x.js";

const app = express();
app.use(express.json({ limit: '25mb' })); // Limite augmentée pour l'upload d'images, de musique et de courtes vidéos
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
  // Certaines versions/installations de socket.io n'exposent pas "./package.json" dans leur
  // champ "exports" (variable selon la version exacte installée) — on ne dépend donc jamais de
  // ce chemin. On résout plutôt son point d'entrée principal (toujours exporté), puis on remonte
  // jusqu'au dossier contenant son package.json par simple vérification de fichier — une opération
  // fs classique, jamais soumise aux restrictions du champ "exports".
  let racine = dirname(require.resolve("socket.io"));
  while (!fs.existsSync(join(racine, "package.json"))) {
    const parent = dirname(racine);
    if (parent === racine) throw new Error("racine du paquet socket.io introuvable");
    racine = parent;
  }
  return join(racine, "client-dist", "socket.io.min.js");
})();

app.get("/js/moteur.js", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.type("application/javascript").sendFile(MOTEUR, (err) => {
    if (err && !res.headersSent) res.status(404).send("// moteur introuvable");
  });
});

// La route "/vocal" (page indépendante du salon vocal, voir public/vocal.html) est maintenant
// définie par le module vocal-salon.js lui-même (voir plus bas, creerModuleVocalSalon) — le salon
// vocal étant désormais totalement autonome, jusqu'à posséder sa propre route.

mountAuth(app);                       // /auth/x/login, /auth/x/callback, /api/me, /api/leaderboard
mountPasserelleEntrante(app, () => REGLAGES.passerelleEntrante);   // /auth/michben/retour
const httpServer = createServer(app);
/**
 * Le chemin par défaut « /socket.io » est filtré par de nombreux bloqueurs de
 * publicité, qui reconnaissent le nom. On expose donc le même service sous
 * « /rt », un nom neutre. Un seul serveur : tous les joueurs partagent
 * bien les mêmes salons.
 */
// maxHttpBufferSize : par défaut Socket.IO plafonne chaque message à 1 Mo, bien trop peu pour un
// fichier audio/vidéo envoyé en base64 depuis un salon vocal (voir vocal:radio-ajouter et
// vocal:video-fichier) — un fichier encodé en base64 grossit d'environ 37 %, et dépassait donc
// systématiquement une limite trop juste. Le paquet est alors rejeté avant même d'atteindre notre
// gestionnaire : le rappel (cb) n'arrive jamais, et le client finit par afficher « le serveur ne
// répond pas » après le délai de emitAvecDelai — alors que le serveur n'a en réalité jamais reçu
// la demande. Calée sur la plus grosse limite réelle (vidéo, VIDEO_MAX_OCTETS = 160 Mo), avec une
// bonne marge au-delà du +37 % de l'encodage base64 pour laisser de la place au reste du message
// (titre, code du salon…). Attention : une limite aussi haute veut dire qu'un envoi à 160 Mo garde
// temporairement ce fichier entier en mémoire côté serveur (une fois décodé) le temps de l'écrire
// sur disque — acceptable pour un salon avec peu d'envois simultanés, à surveiller si l'usage grossit.
const io = new Server(httpServer, { cors: { origin: "*" }, path: "/rt", maxHttpBufferSize: 230 * 1024 * 1024 });

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Réglages du jeu, modifiables depuis la console d'administration.
 * Ils sont conservés en base : un changement survit aux redéploiements.
 */
const REGLAGES_DEFAUT = {
  animationsAvancees: true,
  roundDuration: 60,                 // secondes
  basePoints: 1000,
  tmdbApiKey: "",
  youtubeApiKey: "", // Recherche YouTube depuis le salon vocal (voir /api/youtube/recherche) — clé
                     // gratuite (YouTube Data API v3) à créer sur console.cloud.google.com. Sans
                     // clé, il reste possible de coller un lien YouTube directement, comme avant.
  geoapifyApiKey: "",   // « Cinéma le plus proche » — clé gratuite (3000 requêtes/jour) sur geoapify.com,
                        // utilisée en priorité pour la fiabilité (Overpass/OSM sert de repli sans clé).
  adsterraApiKey: "",   // Réservée pour un usage futur (ex. récupération de statistiques via l'API
                        // éditeur Adsterra) — non nécessaire pour diffuser une publicité « Lien
                        // direct » Adsterra, qui se configure uniquement via l'onglet Publicités.
  pubMaxParCycle: 5,     // Roue : nombre de tours "regarder une pub" autorisés par cycle de recharge.
  pubHeureRecharge: 18,  // Heure (0-23) d'ancrage de la recharge des pubs — comme les 18h de la roue
                         // elle-même ; le cycle dure 12h, donc la recharge a aussi lieu 12h plus tôt/tard.
  afficherRadio: true,   // Affiche (ou masque entièrement, boutons compris) la radio d'ambiance
                         // sur toutes les pages — réglable depuis la console (onglet Réglages).
  // Logos affichés sur les fiches de « Cinéma le plus proche », selon l'enseigne détectée dans
  // le nom du cinéma (UGC / MK2 / Gaumont) ou l'image "indépendant" par défaut pour les autres
  // salles. Chaque valeur est soit "" (rien d'uploadé), soit une image encodée en base64.
  logosCinema: { ugc: "", mk2: "", gaumont: "", pathe: "", independant: "" },
  // Un ami peut-il regarder la partie d'un autre ami en direct (lecture seule) ? Désactivé par
  // défaut — réglable depuis la console admin (onglet Réglages).
  autoriserSpectateur: false,
  // Affiche (ou masque entièrement) le compteur « amis en ligne » sur le menu principal —
  // réglable depuis la console admin (onglet Réglages). L'ancien bandeau « Vos amis en ligne »
  // (avatars en tête d'affiche), qui faisait doublon avec ce compteur, a été retiré.
  afficherAmisEnLigne: true,
  // Affiche (ou masque) la carte « votre position au classement » sur le menu principal, qui a
  // pris la place de l'ancien bandeau ci-dessus — réglable depuis la console admin (onglet Réglages).
  afficherClassementAccueil: true,
  // Plafond (en %) de la part de films français dans une manche tirée au sort — le reste
  // (international + non classés) comble la différence. Sert à rééquilibrer un catalogue trop
  // riche en films français, sans jamais raccourcir une partie si le vivier international est
  // insuffisant (voir choisirFilms). Ignoré tant que des films ne sont pas classés « France » /
  // « International » depuis l'onglet Films de la console admin (champ « Origine »).
  ratioFilmsFrancaisMax: 40,
  creditsDepart: 12,
  creditsParPartie: 4,
  pointsParTicket: 250,
  saisonJours: 20,                   // durée d'une saison classée
  partiesClasseesParJour: 5,         // parties classées autorisées par 24 h
  transfertMax: 2000,                // points transférables en une fois entre amis
  transfertParJour: 5000,            // plafond quotidien de dons
  donTicketsMax: 100,                // tickets (crédits) transférables en une fois entre amis
  donTicketsParJour: 500,            // plafond quotidien de tickets donnés
  donTicketsXp: 8,                   // xp gagnée par le donneur à chaque don de tickets récompensé
  donTicketsXpParJourMax: 5,         // au-delà de ce nombre de dons par jour, le don marche toujours mais ne rapporte plus d'xp
  coeurs: 3,                         // erreurs tolérées avant la fin de partie
  xpBase: 100,                       // expérience du premier niveau
  xpCroissance: 1.04,                // augmentation par niveau
  niveauMax: 300,
  xpParPartie: 40,                   // expérience versée pour une partie terminée
  xpParBonneReponse: 12,
  xpParVictoire: 60,                 // bonus en multijoueur
  graceApresPremier: 15,             // secondes
  vitesseSynopsis: 2800,             // durée totale du dévoilement, en millisecondes (0 = désactivé)
  indices: {
    letters:  { actif: true, points: 150, tickets: 1, libelle: "Nombre de lettres" },
    year:     { actif: true, points: 100, tickets: 1, libelle: "Année" },
    director: { actif: true, points: 200, tickets: 1, libelle: "Réalisateur" },
    actors:   { actif: true, points: 300, tickets: 2, libelle: "Acteurs" },
    poster:   { actif: true, points: 250, tickets: 2, libelle: "Photo du film",
                zoom: 160, cadrage: "center", flou: 0 },
  },
  // Réactions emoji volantes (console admin, onglet Réglages) : la même liste et la même durée
  // d'affichage servent à la fois pendant une partie (#emojiBar) et dans un salon vocal
  // (#vocalEmojiBar) — un seul réglage pour les deux, voir afficherReactionVolante côté client.
  reactions: {
    emojis: ["👋", "❤️", "💯", "🩸", "😂", "😭"],
    dureeAffichageMs: 2300,
  },
  // Personnalisation graphique (console admin, onglet « Apparence ») : couleurs, polices et
  // ordre des modules du menu principal. Vide par défaut = apparence d'origine inchangée.
  theme: {
    couleurs: { ink: "#0A0C16", velvet: "#151A2E", card: "#1C2238", beam: "#F5B942",
                ticket: "#E4586E", teal: "#4ECDC4", chalk: "#EDE8DC", muted: "#7C819B" },
    polices: { affiche: "Anton", corps: "Inter", etiquette: "Oswald" },
    ordre: { menu: ["modes", "sorties", "cinemas", "niveau", "quotidien", "actions", "rejoindre", "stats"],
             vocal: ["vocal-hote", "vocal-intervenants", "vocal-auditeurs"] },
    // Couleurs propres à chaque grand module (espace échanges, classement, quêtes, sondages,
    // amis, salon vocal) : "" = pas de personnalisation, le module garde les couleurs globales
    // ci-dessus. Volontairement limité à l'accent principal et secondaire (et non les 8 couleurs
    // globales) pour rester simple à régler depuis la console tout en donnant à chaque module
    // sa propre identité visuelle.
    couleursCategories: {
      echange:    { beam: "", teal: "" },
      classement: { beam: "", teal: "" },
      quetes:     { beam: "", teal: "" },
      sondages:   { beam: "", teal: "" },
      amis:       { beam: "", teal: "" },
      vocal:      { beam: "", teal: "" },
    },
  },
  // Espace audio (console admin, onglet « Audio ») : réglages liés aux salons vocaux — serveur
  // TURN (relais audio pour les réseaux les plus restrictifs, voir plus bas), capacité des salons,
  // délai de grâce avant fermeture. Regroupés ici pour pouvoir accueillir d'autres options à
  // l'avenir sans avoir à ajouter de nouveaux réglages épars ailleurs.
  audio: {
    turnActif: false, turnUrl: "", turnUsername: "", turnCredential: "",
    // Serveur TURN recommandé (voir obtenirIceServersCloudflare plus bas) : contrairement à
    // turnUrl/turnUsername/turnCredential ci-dessus (un identifiant fixe, fourni une fois pour
    // toutes par exemple par metered.ca), Cloudflare fonctionne avec une CLÉ (jamais transmise au
    // navigateur) qui sert à fabriquer des identifiants TEMPORAIRES régulièrement renouvelés — plus
    // sûr, et un forfait gratuit bien plus généreux (1000 Go/mois contre 500 Mo/mois chez la
    // plupart des concurrents gratuits). Utilisé en priorité dès que ces deux champs sont remplis.
    cloudflareTurnKeyId: "", cloudflareTurnApiToken: "",
    maxParticipantsVocal: 40, maxCohotesVocal: 3, fermetureGraceMinutes: 3,
    // Réglage par défaut appliqué à la CRÉATION d'un salon (l'hôte reste toujours libre de le
    // changer ensuite depuis sa propre console de modération) : à false, un auditeur doit passer
    // par une demande explicite ("✋ Demander à intervenir") que l'hôte et les cohôtes reçoivent
    // et valident avant de pouvoir parler — jamais de montée automatique sans validation.
    monteeLibreParDefaut: false,
  },
  // Petit bouton teaser (voir #btnLienExterne côté client, à côté du bouton "?") pour annoncer un
  // lien externe — pensé au départ pour un futur second jeu développé séparément. `cible` est une
  // date/heure (format <input type="datetime-local">, donc sans fuseau horaire explicite) : tant
  // qu'elle n'est pas atteinte, les joueurs voient un compte à rebours plutôt que le lien lui-même.
  // Laisser `cible` vide rend le lien actif immédiatement, sans compte à rebours.
  lienExterne: { actif: false, url: "", titre: "", cible: "" },
  // Liens épinglés accessibles aux joueurs via le trombone 📎 sur la page d'accueil (voir
  // #btnLiensEpingles côté client et /api/config) : une petite page perso de liens (site web,
  // réseaux sociaux, Discord, etc.), chacun avec un titre et une « jaquette » (jpeg/png)
  // facultative — entièrement gérée depuis la console admin, onglet Réglages. Le bouton reste
  // masqué côté joueur tant qu'aucun lien valide n'est enregistré.
  liensEpingles: [],
  // Passerelle de connexion (« Sign in with MichBen ») : permet à un AUTRE projet de reconnaître
  // automatiquement un compte MichBen sans jamais partager mots de passe ni base de données — voir
  // GET /api/passerelle/autoriser et POST /api/passerelle/echanger plus bas. `domaines` liste les
  // adresses de retour autorisées (une par ligne) pour empêcher qu'un lien piégé ne détourne un
  // code de connexion vers un site tiers.
  passerelle: { actif: false, cleSecrete: "", domaines: "" },
  // Passerelle ENTRANTE : le sens inverse — recevoir un joueur qui arrive déjà connecté depuis un
  // AUTRE jeu (ex. Le Nouveau Bac) via son propre bouton 🔗. `domaine` = adresse de cet autre jeu,
  // `cleSecrete` = exactement la même valeur que celle réglée dans SA carte « Passerelle de
  // connexion » — c'est un secret partagé entre les deux projets, jamais transmis au navigateur.
  passerelleEntrante: { actif: false, domaine: "", cleSecrete: "" },
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
  // Le temps laissé à un salon sans aucun joueur en ligne avant sa suppression :
  // couvre une coupure wifi ou une mise en veille de téléphone le temps de revenir.
  ROOM_VIDE_GRACE_MS: 90 * 1000,
};

/* ------------------------------------------------------------------ */
/* Bots (duel)                                                         */
/*                                                                     */
/* Un joueur seul en duel peut défier un bot plutôt que d'attendre     */
/* un adversaire. Le bot « répond » via un minuteur côté serveur, avec */
/* une précision et un délai de réflexion qui varient selon le niveau  */
/* choisi — il n'y a pas de réelle intelligence, juste assez de hasard */
/* pour donner l'impression d'un adversaire crédible et amusant.       */
/* ------------------------------------------------------------------ */

const BOT_NIVEAUX = {
  facile:   { precision: 0.35, delaiMin: 5000, delaiMax: 11000, emoji: "🙂", label: "Facile" },
  moyen:    { precision: 0.62, delaiMin: 2500, delaiMax: 7000,  emoji: "😎", label: "Moyen" },
  hardcore: { precision: 0.90, delaiMin: 700,  delaiMax: 2200,  emoji: "🔥", label: "Hardcore" },
};

/** Nombre maximum de bots que l'on peut ajouter en même temps dans une partie "chacun pour soi". */
const MAX_BOTS_FFA = 7;

const BOT_NOMS = [
  "CinéPhilippe", "PopcornMaster", "Bobine Express", "Le Projectionniste Fou", "Grosminet Ciné",
  "Madame Sous-titres", "Capitaine Spoiler", "Nanar Attitude", "Vieux Fauteuil Rouge", "Toto la Pellicule",
  "Zorro du Zapping", "Reine du Rembobinage", "Doudou Blockbuster", "Papy Western", "Mémé Nanar",
  "Turbo Ticket", "Choupinet Cinéma", "L'Ouvreuse Masquée", "Sacha Scénario", "Bulle de Pop-corn",
];
const nomBotAleatoire = () => BOT_NOMS[Math.floor(Math.random() * BOT_NOMS.length)];

/**
 * Petites piques et taquineries envoyées par les bots pendant la partie, pour qu'ils paraissent
 * un peu plus « vivants » qu'un simple curseur qui répond dans le vide. Le ton monte avec le
 * niveau de difficulté (facile = sympa et un peu benêt, hardcore = fier et taquin) mais reste
 * toujours bon enfant — jamais méchant, jamais grossier.
 */
const BOT_PHRASES = {
  facile: {
    intro: ["Salut ! Je vais faire de mon mieux 🙂", "Coucou tout le monde, soyez indulgents avec moi !", "C'est parti, j'ai un peu le trac 😅"],
    bonneReponse: ["Ah, je l'ai eu ! 🙂", "Oh, une bonne réponse, ça arrive même à moi !", "Youpi, j'ai trouvé !"],
    mauvaiseReponse: ["Zut, raté...", "Ah non, pas celui-là 😅", "Je n'avais aucune idée pour celui-ci."],
    adversaireReussit: ["Bien joué !", "Chapeau, tu connais tes films 👏", "Wahou, trouvé si vite !"],
    adversaireRate: ["Pas grave, on se rattrape au prochain !", "Ça arrive à tout le monde 🙂", "Oh, dommage pour toi aussi !"],
    victoire: ["J'ai gagné ?! Incroyable 😄", "Waouh, première place, je n'y crois pas !", "Merci d'avoir joué avec moi, c'était sympa !"],
    defaite: ["Bien joué, tu as mérité ta victoire !", "GG, c'était une belle partie 🙂", "Je ferai mieux la prochaine fois !"],
  },
  moyen: {
    intro: ["Prêt à jouer ? On va voir ce que tu vaux 😎", "Salut ! J'espère que t'as révisé tes films.", "C'est parti, accroche-toi un peu quand même."],
    bonneReponse: ["Facile 😎", "Encore une pour moi.", "Je commence à prendre le rythme !"],
    mauvaiseReponse: ["Bon, celui-là je le laisse passer.", "Ok, celle-ci était un piège.", "Pas ma meilleure manche..."],
    adversaireReussit: ["Pas mal, pas mal 👀", "Ok tu connais un peu tes classiques.", "Tiens, une bonne réponse, ça change !"],
    adversaireRate: ["Ah ah, celle-là était pour moi 😏", "Dommage, je t'attendais au tournant.", "Même pas déçu pour toi."],
    victoire: ["GG, je m'en doutais un peu 😎", "Bien joué quand même, tu t'es battu.", "Belle partie, on remet ça ?"],
    defaite: ["Ok, bien joué... cette fois-ci 😏", "GG, mais la revanche arrive vite.", "Pas mal du tout, respect."],
  },
  hardcore: {
    intro: ["Prépare-toi, ça va être rapide 🔥", "J'espère que t'es venu prêt, parce que moi oui.", "On y va, essaie de suivre le rythme 😏"],
    bonneReponse: ["Trop facile 🔥", "C'est même pas un défi pour moi.", "Encaisse celle-là 😏"],
    mauvaiseReponse: ["Bon, ok, personne n'est parfait.", "Rare, mais ça arrive même à moi.", "Je note et je passe à la suivante."],
    adversaireReussit: ["Ok, jolie réponse... pour une fois.", "Pas mal, mais je reste devant 😏", "Tu m'impressionnes presque là."],
    adversaireRate: ["Ah ah, sans commentaire 😂", "Je m'y attendais un peu, avoue.", "Tu peux mieux faire, allez !"],
    victoire: ["GG, comme prévu 🔥", "Bien essayé, mais c'était couru d'avance 😏", "Une victoire de plus pour moi, merci pour le match !"],
    defaite: ["Ok... bien joué, je le reconnais 👏", "GG, tu m'as eu cette fois, chapeau.", "Alerte info : le bot aussi peut perdre. Bien joué !"],
  },
};

/**
 * Fait « parler » un bot : soit une petite phrase piochée dans BOT_PHRASES selon son niveau et
 * la catégorie de l'instant, soit une simple réaction emoji — avec un léger délai aléatoire pour
 * ne pas donner l'impression d'un message instantané et robotique. `probabilite` évite que le bot
 * commente absolument chaque événement (ce serait vite fatigant) : il ne parle qu'une fois sur N.
 */
function botDire(room, bot, categorie, probabilite = 0.4) {
  if (!room || !bot || !bot.bot) return;
  if (Math.random() > probabilite) return;

  const delai = 500 + Math.random() * 1600;
  setTimeout(() => {
    // Le salon peut avoir disparu (partie terminée, tout le monde parti) entre-temps.
    if (rooms.get(room.code) !== room || !room.players.has(bot.userId)) return;

    const enEmoji = Math.random() < 0.4;
    if (enEmoji) {
      // Liste personnalisable depuis la console admin (voir REGLAGES.reactions) : les bots réagissent
      // avec les mêmes émojis que ceux proposés aux joueurs humains, jamais une liste figée à part.
      const emojisDispo = REGLAGES.reactions.emojis;
      const emoji = emojisDispo[Math.floor(Math.random() * emojisDispo.length)];
      io.to(room.code).emit("reaction", { emoji, pseudo: bot.pseudo, avatar: bot.avatar });
      return;
    }

    const banque = BOT_PHRASES[bot.botNiveau] || BOT_PHRASES.moyen;
    const phrases = banque[categorie];
    if (!phrases || !phrases.length) return;
    const texte = phrases[Math.floor(Math.random() * phrases.length)];
    for (const autre of room.players.values()) {
      if (autre.bot) continue;   // inutile d'envoyer à des sockets de bots, qui n'existent pas
      io.to(autre.id).emit("chat:message", { pseudo: bot.pseudo, avatar: bot.avatar, text: texte, at: Date.now() });
    }
  }, delai);
}

/** Un bot pris au hasard parmi ceux du salon (utile quand plusieurs bots jouent en même temps
 *  en mode « chacun pour soi » : on n'en fait réagir qu'un seul à la fois, pas tous en chœur). */
function botAuHasard(room) {
  const bots = [...room.players.values()].filter((p) => p.bot);
  return bots.length ? bots[Math.floor(Math.random() * bots.length)] : null;
}

/**
 * Mot de passe d'administration.
 *
 * Il est stocké en base sous forme d'empreinte, ce qui permet de le changer
 * depuis la console sans redéployer. La variable ADMIN_TOKEN ne sert plus
 * qu'à la toute première ouverture, ou comme secours si la base est vide.
 */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "michben-admin";
let empreinteAdmin = null;   // chargée au démarrage

/**
 * Serveur TURN optionnel pour les salons vocaux (WebRTC).
 *
 * Sans TURN, seul un serveur STUN gratuit est utilisé pour établir les connexions audio directes
 * entre participants — cela suffit sur la plupart des réseaux, mais échoue silencieusement sur les
 * réseaux les plus restrictifs (certaines box d'opérateur, wifi d'entreprise très filtré, NAT dit
 * "symétrique") : la personne concernée ne peut alors entendre AUCUN participant, même si les
 * autres s'entendent très bien entre eux. Un serveur TURN relaie l'audio quand la connexion directe
 * échoue, ce qui règle ce cas — mais ça nécessite un service payant ou un compte gratuit chez un
 * fournisseur (ex. metered.ca, Twilio, Cloudflare Calls). Si ces trois variables sont renseignées,
 * elles sont transmises au client via /api/config et ajoutées automatiquement aux serveurs ICE.
 */
const TURN_URL = process.env.TURN_URL || "";
const TURN_USERNAME = process.env.TURN_USERNAME || "";
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || "";
// Voir REGLAGES.audio.cloudflareTurnKeyId/cloudflareTurnApiToken : même principe de valeur de
// secours au tout premier démarrage que TURN_URL ci-dessus, pour permettre de les régler depuis
// les variables d'environnement de Render plutôt que depuis la console admin, si préféré.
const CLOUDFLARE_TURN_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID || "";
const CLOUDFLARE_TURN_API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN || "";

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
    if (m.kids === undefined) m.kids = false;
    // Origine (France / international) utilisée pour équilibrer le tirage des manches (voir
    // choisirFilms) : reprend l'ancien champ `vf` posé par le script d'import en masse quand il
    // existe, sinon reste "non classé" (n'entre alors dans aucun des deux quotas, sans jamais
    // être exclu du jeu) — à corriger au cas par cas depuis l'onglet Films de la console admin.
    if (m.origine === undefined)
      m.origine = m.vf === true ? "france" : (m.vf === false ? "international" : "");
  }
}
const saveMovies = () => sauver("movies", movies, MOVIES_FILE);

/* ---------- signalements d'anomalies ---------- */

const REPORTS_FILE = new URL("./reports.json", import.meta.url);
let reports = [];
let palmares = [];   // podiums des saisons écoulées
const saveReports = () => sauver("reports", reports, REPORTS_FILE);

/* ---------- suggestions de films des joueurs ---------- */
// Comme le reste des données persistées, on passe par charger/sauver (db.js) :
// des écritures fs.* brutes ne survivent pas forcément au disque du serveur
// en production, alors que ce mécanisme est celui qui fonctionne partout.
const SUGGESTIONS_FILE = new URL("./suggestions.json", import.meta.url);
let suggestions = [];
const saveSuggestions = () => sauver("suggestions", suggestions, SUGGESTIONS_FILE);

/* ---------- citations de cinéma affichées à chaque niveau ---------- */
const CITATIONS_FILE = new URL("./citations.json", import.meta.url);
let citations = [];
const saveCitations = () => sauver("citations", citations, CITATIONS_FILE);
const CITATIONS_DEFAUT = [
  { id:1, texte:"Je vais lui faire une offre qu'il ne pourra pas refuser.", film:"Le Parrain", annee:1972, source:"Vito Corleone (Marlon Brando)", anecdote:"Brando avait glissé du coton dans ses joues pour se donner le physique bouledogue du parrain." },
  { id:2, texte:"Que la Force soit avec toi.", film:"Star Wars", annee:1977, source:"Han Solo (Harrison Ford)", anecdote:"George Lucas a écrit près de quatre versions du scénario avant de trouver le ton de la saga." },
  { id:3, texte:"Nobody's perfect.", film:"Certains l'aiment chaud", annee:1959, source:"Osgood (Joe E. Brown)", anecdote:"Cette dernière réplique du film est régulièrement classée parmi les meilleures fins de l'histoire du cinéma." },
  { id:4, texte:"Ce fut un plaisir, Sam.", film:"Casablanca", annee:1942, source:"Rick Blaine (Humphrey Bogart)", anecdote:"Le scénario était encore réécrit pendant le tournage : personne ne savait comment le film finirait." },
  { id:5, texte:"La vie, c'est comme une boîte de chocolats : on ne sait jamais sur quoi on va tomber.", film:"Forrest Gump", annee:1994, source:"Forrest Gump (Tom Hanks)", anecdote:"Tom Hanks a reçu l'Oscar du meilleur acteur pour ce rôle, un an après celui de Philadelphia." },
  { id:6, texte:"Houston, on a un problème.", film:"Apollo 13", annee:1995, source:"Jim Lovell (Tom Hanks)", anecdote:"La véritable phrase radio de 1970 était en fait au passé : « Houston, we've had a problem. »" },
  { id:7, texte:"Hasta la vista, baby.", film:"Terminator 2", annee:1991, source:"Le Terminator (Arnold Schwarzenegger)", anecdote:"Arnold Schwarzenegger a appris la réplique phonétiquement avant de comprendre ce qu'elle signifiait vraiment." },
  { id:8, texte:"Aujourd'hui est peut-être un bon jour pour mourir.", film:"Le Roi Lion", annee:1994, source:"Mufasa (voix de James Earl Jones)", anecdote:"James Earl Jones prêtait déjà sa voix à Dark Vador : Mufasa était un clin d'œil assumé des studios Disney." },
  { id:9, texte:"Avec de grands pouvoirs viennent de grandes responsabilités.", film:"Spider-Man", annee:2002, source:"Oncle Ben (Cliff Robertson)", anecdote:"Cette morale existait déjà dans le tout premier comic Spider-Man de 1962, sous une formulation légèrement différente." },
  { id:10, texte:"Il n'y a pas de problème qu'on ne puisse résoudre en équipe.", film:"Les Indestructibles", annee:2004, source:"Mr Indestructible", anecdote:"Brad Bird a animé le film pour qu'il ressemble à un James Bond des années 60 revisité en famille." },
  { id:11, texte:"Un jour, mon prince viendra.", film:"Blanche-Neige et les Sept Nains", annee:1937, source:"Blanche-Neige", anecdote:"Premier long métrage d'animation entièrement en couleurs produit par un studio américain." },
  { id:12, texte:"Je suis le roi du monde !", film:"Titanic", annee:1997, source:"Jack Dawson (Leonardo DiCaprio)", anecdote:"La réplique était en réalité improvisée par DiCaprio pendant les essais caméra." },
  { id:13, texte:"Dans la vie, il y a les mangeurs de pierre et les mangeurs de graines.", film:"Les Tontons flingueurs", annee:1963, source:"Fernand Naudin (Lino Ventura)", anecdote:"Les dialogues de Michel Audiard sont si célèbres qu'ils sont encore cités quotidiennement en France." },
  { id:14, texte:"C'est un métier, ça, moussaillon ?", film:"L'Aile ou la Cuisse", annee:1976, source:"Charles Duchemin (Louis de Funès)", anecdote:"Louis de Funès a insisté pour tourner lui-même certaines cascades comiques du film." },
  { id:15, texte:"Bienvenue chez les Ch'tis, ça vaut le déplacement.", film:"Bienvenue chez les Ch'tis", annee:2008, source:"Antoine Bailleul (Dany Boon)", anecdote:"Le film reste, encore aujourd'hui, l'un des plus gros succès du cinéma français en salles." },
  { id:16, texte:"L'amour ne se commande pas.", film:"Le Fabuleux Destin d'Amélie Poulain", annee:2001, source:"Amélie Poulain (Audrey Tautou)", anecdote:"Jean-Pierre Jeunet a fait retoucher numériquement Paris pour effacer toute trace de saleté ou de graffiti." },
  { id:17, texte:"Ici, c'est chacun pour sa gueule.", film:"La Haine", annee:1995, source:"Vinz (Vincent Cassel)", anecdote:"Le film a été tourné en noir et blanc pour accentuer le contraste social et l'urgence du propos." },
  { id:18, texte:"Faut pas rêver, faut vivre.", film:"Le Grand Bleu", annee:1988, source:"Jacques Mayol (Jean-Marc Barr)", anecdote:"Luc Besson a dédié le film à son ami Jacques Mayol, véritable champion d'apnée qui a inspiré l'histoire." },
  { id:19, texte:"Tu me parles ?", film:"Taxi Driver", annee:1976, source:"Travis Bickle (Robert De Niro)", anecdote:"Cette réplique culte a été entièrement improvisée par Robert De Niro devant la caméra." },
  { id:20, texte:"Dis bonjour à mon petit ami.", film:"Scarface", annee:1983, source:"Tony Montana (Al Pacino)", anecdote:"Al Pacino a tourné la scène finale du film pendant près de deux semaines, un record pour l'époque." },
  { id:21, texte:"Que la fête commence.", film:"Kaamelott", annee:2005, source:"Le Roi Arthur (Alexandre Astier)", anecdote:"Alexandre Astier a écrit, réalisé et interprété la quasi-totalité de la série à lui seul." },
  { id:22, texte:"Je suis ton père.", film:"Star Wars : L'Empire contre-attaque", annee:1980, source:"Dark Vador (voix de James Earl Jones)", anecdote:"Même Mark Hamill, qui joue Luke Skywalker, ignorait ce twist avant le tournage de la scène." },
  { id:23, texte:"On se retrouvera, si le destin le veut, sur le bateau de la vie.", film:"Intouchables", annee:2011, source:"Driss (Omar Sy)", anecdote:"L'histoire est inspirée de la véritable amitié entre Philippe Pozzo di Borgo et Abdel Sellou." },
  { id:24, texte:"Toute grande histoire commence par une petite étincelle.", film:"Ratatouille", annee:2007, source:"Auguste Gusteau", anecdote:"Les animateurs de Pixar ont suivi un vrai cours de cuisine française pour rendre les scènes crédibles." },
];

/* ------------------------------------------------------------------ */
/* Roue quotidienne : un tour gratuit par jour, puis 100 crédits/tour   */
/*                                                                      */
/* La roue tient un stock partagé de lots pour la journée, consommé au  */
/* fur et à mesure par TOUS les joueurs. Elle se réapprovisionne soit   */
/* dès qu'elle est vide, soit automatiquement chaque jour à 18h,        */
/* heure de Paris (nouvelle « journée de roue »).                       */
/* ------------------------------------------------------------------ */

const ROUE_FILE = new URL("./roue.json", import.meta.url);
let roue = null;   // { jour, lots: [...restants], historique: [...derniers tirages] }
const saveRoue = () => sauver("roue", roue, ROUE_FILE);

/* Gain tiré mais pas encore réclamé par le joueur (un seul à la fois, en attente du bouton « Réclamer »). */
const GAINS_ROUE_FILE = new URL("./roue-gains.json", import.meta.url);
let gainsEnAttente = {};   // userId -> { type, label, valeur?, gratuit, date }
const saveGainsRoue = () => sauver("roueGains", gainsEnAttente, GAINS_ROUE_FILE);

/* File des demandes de code VIP : le joueur réclame, l'administrateur génère et envoie manuellement. */
const DEMANDES_VIP_FILE = new URL("./roue-vip.json", import.meta.url);
let demandesVip = [];   // { id, userId, pseudo, avatar, photo, date, statut: "attente"|"envoye", code, envoyeLe }
const saveDemandesVip = () => sauver("roueVip", demandesVip, DEMANDES_VIP_FILE);

/** Emoji représentatif d'un lot, pour l'afficher dans la liste des lots de la roue. */
function emojiLot(l) {
  if (l.type === "vip") return "👑";
  if (l.type === "ranked") return "📈";
  if ((l.valeur || 0) >= 500) return "💎";
  if ((l.valeur || 0) >= 100) return "⭐";
  return "🎁";
}

/** Catégories possibles de lots de la roue — cette LISTE reste stable (c'est elle que la console
 * admin utilise pour afficher le stock restant de chacune), mais leur présence et leur quantité
 * varient à chaque réapprovisionnement (voir stockRoueDefaut()) : deux jours ne se ressemblent
 * jamais tout à fait. */
const CATEGORIES_ROUE_BASE = [
  { type: "vip", label: "Code VIP — parrainage offert" },
  { type: "credits", label: "1000 tickets", valeur: 1000 },
  { type: "credits", label: "500 tickets", valeur: 500 },
  { type: "credits", label: "200 tickets", valeur: 200 },
  { type: "credits", label: "100 tickets", valeur: 100 },
  { type: "credits", label: "50 tickets", valeur: 50 },
  { type: "credits", label: "20 tickets", valeur: 20 },
  { type: "ranked", label: "1 partie classée bonus", valeur: 1 },
  { type: "ranked", label: "3 parties classées bonus", valeur: 3 },
];

/** Catalogue complet des lots de la roue (toujours les mêmes catégories), avec le stock restant de chacune. */
function catalogueRoue(lots) {
  return CATEGORIES_ROUE_BASE.map((c) => ({
    ...c,
    valeur: c.valeur || null,
    emoji: emojiLot(c),
    restants: lots.filter((l) => l.type === c.type && (l.valeur || null) === (c.valeur || null)).length,
  }));
}

/**
 * Stock d'un plein réapprovisionnement : deux fois plus de lots qu'avant (base doublée par
 * rapport à l'ancien stock fixe : 1 VIP→2, 3×500→6, 5×100→10, 10×50→20, 2×classé→4), et surtout
 * un tirage qui varie vraiment d'un réapprovisionnement à l'autre — quantités aléatoires autour
 * de cette base, et quelques catégories bonus qui n'apparaissent qu'un jour sur deux, pour que la
 * roue n'ait jamais deux fois la même tête.
 */
function stockRoueDefaut() {
  const lots = [];
  // Quantité aléatoire autour d'une base, jamais négative.
  const varie = (base, ecart) => Math.max(0, base + Math.floor(Math.random() * (ecart * 2 + 1)) - ecart);
  const ajouter = (n, type, label, valeur) => { for (let i = 0; i < n; i++) lots.push({ type, label, valeur }); };

  ajouter(varie(2, 1), "vip", "Code VIP — parrainage offert");                          // avant : 1 fixe
  if (Math.random() < 0.5) ajouter(1, "credits", "1000 tickets", 1000);                 // gros lot rare, un jour sur deux
  ajouter(varie(6, 2), "credits", "500 tickets", 500);                                  // avant : 3 fixe
  if (Math.random() < 0.6) ajouter(varie(3, 2), "credits", "200 tickets", 200);         // catégorie bonus, pas systématique
  ajouter(varie(10, 3), "credits", "100 tickets", 100);                                 // avant : 5 fixe
  ajouter(varie(20, 5), "credits", "50 tickets", 50);                                   // avant : 10 fixe
  if (Math.random() < 0.7) ajouter(varie(8, 4), "credits", "20 tickets", 20);           // petite catégorie bonus
  ajouter(varie(4, 2), "ranked", "1 partie classée bonus", 1);                          // avant : 2 fixe
  if (Math.random() < 0.4) ajouter(varie(2, 1), "ranked", "3 parties classées bonus", 3); // catégorie bonus rare

  // Un identifiant unique par lot pour pouvoir le retirer précisément du stock.
  return lots.map((l, i) => ({ ...l, id: i + 1 }));
}

function melangerLots(lots) {
  const t = [...lots];
  for (let i = t.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [t[i], t[j]] = [t[j], t[i]];
  }
  return t;
}

/** « Journée de roue » : la date change à 18h précises, heure de Paris. */
function journeeRoue(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  let y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  const h = Number(parts.hour === "24" ? "0" : parts.hour);
  if (h < 18) {
    // Avant 18h : on est encore dans la journée de roue entamée la veille à 18h.
    const veille = new Date(Date.UTC(y, m - 1, d));
    veille.setUTCDate(veille.getUTCDate() - 1);
    y = veille.getUTCFullYear(); m = veille.getUTCMonth() + 1; d = veille.getUTCDate();
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Garantit une roue à jour : nouvelle journée, ou stock épuisé. */
function assurerRoueDuJour() {
  const jour = journeeRoue();
  if (!roue || roue.jour !== jour || !Array.isArray(roue.lots) || roue.lots.length === 0) {
    roue = {
      jour,
      lots: melangerLots(stockRoueDefaut()),
      historique: (roue?.jour === jour && Array.isArray(roue.historique)) ? roue.historique : [],
    };
    saveRoue();
  }
}

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

app.get("/api/favicon", (req, res) => {
  const exts = ["png", "svg", "ico", "jpg", "jpeg"];
  for (const ext of exts) {
    const p = join(process.cwd(), "public", `favicon.${ext}`);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).end();
});

app.post("/api/admin/favicon", requireAdmin, (req, res) => {
  try {
    const { image, ext } = req.body;
    if (!image) return res.status(400).json({ error: "NO_IMAGE" });
    const publicDir = join(process.cwd(), "public");
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
    
    for (const e of ["svg", "png", "ico", "jpg", "jpeg"]) {
       const p = join(publicDir, `favicon.${e}`);
       if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    const cleanExt = ["svg", "png", "ico", "jpg", "jpeg"].includes(String(ext).toLowerCase()) ? String(ext).toLowerCase() : "png";
    const base64Data = image.split(';base64,').pop();
    fs.writeFileSync(join(publicDir, `favicon.${cleanExt}`), Buffer.from(base64Data, 'base64'));
    res.json({ ok: true });
  } catch (error) {
    console.error("Erreur upload favicon:", error);
    res.status(500).json({ error: "INTERNAL_ERROR", details: error.message });
  }
});

/**
 * Logos des enseignes de cinéma (UGC, MK2, Gaumont) et logo générique « indépendant »,
 * affichés sur les fiches de résultat de « Cinéma le plus proche ». Stockés directement dans
 * REGLAGES (comme le reste de la config) plutôt qu'en fichier sur disque : contrairement au
 * favicon, ça survit à un redéploiement même sans disque persistant sur l'hébergeur.
 */
const LOGOS_CINEMA_CLES = ["ugc", "mk2", "gaumont", "pathe", "independant"];
app.post("/api/admin/logos-cinema", requireAdmin, (req, res) => {
  try {
    const { cle, image } = req.body || {};
    if (!LOGOS_CINEMA_CLES.includes(cle)) return res.status(400).json({ error: "CLE_INVALIDE" });
    if (!REGLAGES.logosCinema) REGLAGES.logosCinema = { ugc: "", mk2: "", gaumont: "", pathe: "", independant: "" };
    if (!image) {
      // image vide/absente = on retire le logo pour cette enseigne
      REGLAGES.logosCinema[cle] = "";
      sauver("reglages", REGLAGES);
      return res.json({ ok: true, logosCinema: REGLAGES.logosCinema });
    }
    if (!/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/.test(image))
      return res.status(400).json({ error: "IMAGE_INVALIDE" });
    // ~1.4 Mo de base64 ≈ 1 Mo d'image d'origine : large pour un logo, mais on borne quand même
    // pour éviter qu'un fichier trop lourd n'alourdisse chaque sauvegarde des réglages.
    if (image.length > 1_400_000) return res.status(400).json({ error: "IMAGE_TROP_LOURDE" });
    REGLAGES.logosCinema[cle] = image;
    sauver("reglages", REGLAGES);
    res.json({ ok: true, logosCinema: REGLAGES.logosCinema });
  } catch (error) {
    console.error("Erreur upload logo cinéma:", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
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
  REGLAGES.vitesseSynopsis  = borne(r.vitesseSynopsis, 0, 10000, REGLAGES.vitesseSynopsis);
  REGLAGES.partiesClasseesParJour = borne(r.partiesClasseesParJour, 1, 100, REGLAGES.partiesClasseesParJour);
  REGLAGES.transfertMax     = borne(r.transfertMax, 0, 100000, REGLAGES.transfertMax);
  REGLAGES.transfertParJour = borne(r.transfertParJour, 0, 500000, REGLAGES.transfertParJour);
  REGLAGES.donTicketsMax    = borne(r.donTicketsMax, 0, 100000, REGLAGES.donTicketsMax);
  REGLAGES.donTicketsParJour = borne(r.donTicketsParJour, 0, 500000, REGLAGES.donTicketsParJour);
  REGLAGES.donTicketsXp     = borne(r.donTicketsXp, 0, 1000, REGLAGES.donTicketsXp);
  REGLAGES.donTicketsXpParJourMax = borne(r.donTicketsXpParJourMax, 0, 1000, REGLAGES.donTicketsXpParJourMax);
  if (typeof r.tmdbApiKey === 'string') REGLAGES.tmdbApiKey = r.tmdbApiKey;
  if (typeof r.youtubeApiKey === 'string') REGLAGES.youtubeApiKey = r.youtubeApiKey;
  if (typeof r.geoapifyApiKey === 'string') REGLAGES.geoapifyApiKey = r.geoapifyApiKey;
  if (typeof r.adsterraApiKey === 'string') REGLAGES.adsterraApiKey = r.adsterraApiKey;
  REGLAGES.pubMaxParCycle   = borne(r.pubMaxParCycle, 1, 50, REGLAGES.pubMaxParCycle);
  REGLAGES.pubHeureRecharge = borne(r.pubHeureRecharge, 0, 23, REGLAGES.pubHeureRecharge);
  if (typeof r.afficherRadio === "boolean") REGLAGES.afficherRadio = r.afficherRadio;
  if (typeof r.autoriserSpectateur === "boolean") REGLAGES.autoriserSpectateur = r.autoriserSpectateur;
  if (typeof r.afficherAmisEnLigne === "boolean") REGLAGES.afficherAmisEnLigne = r.afficherAmisEnLigne;
  if (typeof r.afficherClassementAccueil === "boolean") REGLAGES.afficherClassementAccueil = r.afficherClassementAccueil;
  REGLAGES.ratioFilmsFrancaisMax = borne(r.ratioFilmsFrancaisMax, 0, 100, REGLAGES.ratioFilmsFrancaisMax);
  REGLAGES.animationsAvancees = r.animationsAvancees !== false;
  REGLAGES.coeurs           = borne(r.coeurs, 1, 10, REGLAGES.coeurs);
  REGLAGES.xpBase           = borne(r.xpBase, 10, 10000, REGLAGES.xpBase);
  REGLAGES.xpCroissance     = borne(r.xpCroissance, 1.01, 2, REGLAGES.xpCroissance);
  REGLAGES.niveauMax        = borne(r.niveauMax, 10, 1000, REGLAGES.niveauMax);
  REGLAGES.xpParPartie      = borne(r.xpParPartie, 0, 1000, REGLAGES.xpParPartie);
  REGLAGES.xpParBonneReponse= borne(r.xpParBonneReponse, 0, 500, REGLAGES.xpParBonneReponse);
  REGLAGES.xpParVictoire    = borne(r.xpParVictoire, 0, 1000, REGLAGES.xpParVictoire);

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

  // Réactions emoji (voir REGLAGES_DEFAUT.reactions) : liste bornée en nombre et en « longueur
  // visuelle » (certains emojis comme ❤️ ou 🩸 tiennent sur plusieurs points de code) plutôt qu'en
  // octets, pour ne jamais couper un emoji au milieu tout en repoussant un texte arbitraire.
  if (!REGLAGES.reactions || typeof REGLAGES.reactions !== "object")
    REGLAGES.reactions = structuredClone(REGLAGES_DEFAUT.reactions);
  if (Array.isArray(r.reactions?.emojis)) {
    const emojisValides = r.reactions.emojis
      .map((e) => String(e || "").trim())
      .filter((e) => e && [...e].length <= 4)
      .slice(0, 16);
    if (emojisValides.length) REGLAGES.reactions.emojis = emojisValides;
  }
  REGLAGES.reactions.dureeAffichageMs = borne(r.reactions?.dureeAffichageMs, 800, 8000, REGLAGES.reactions.dureeAffichageMs);

  // Liens épinglés (voir REGLAGES_DEFAUT.liensEpingles) : chaque lien doit avoir un titre et une
  // url http(s) valide pour être conservé — un titre ou un lien vide est silencieusement écarté
  // plutôt que de faire échouer tout l'enregistrement des réglages. La jaquette (si présente) suit
  // les mêmes règles que les logos de cinéma (voir /api/admin/logos-cinema) : une image encodée en
  // base64, bornée en poids pour ne pas alourdir le fichier de réglages à chaque sauvegarde.
  if (Array.isArray(r.liensEpingles)) {
    REGLAGES.liensEpingles = r.liensEpingles
      .slice(0, 12)
      .map((l) => {
        const titre = String(l?.titre || "").trim().slice(0, 60);
        const url = String(l?.url || "").trim().slice(0, 500);
        if (!titre || !url || !/^https?:\/\//i.test(url)) return null;
        let image = "";
        if (typeof l?.image === "string" && l.image
            && /^data:image\/(png|jpe?g|webp);base64,/.test(l.image) && l.image.length <= 1_400_000) {
          image = l.image;
        }
        const id = String(l?.id || "").trim().slice(0, 60) || crypto.randomUUID();
        return { id, titre, url, image };
      })
      .filter(Boolean);
  }

  sauver("reglages", REGLAGES);
  res.json(REGLAGES);
});

app.post("/api/admin/reglages/defaut", requireAdmin, (_req, res) => {
  REGLAGES = structuredClone(REGLAGES_DEFAUT);
  sauver("reglages", REGLAGES);
  res.json(REGLAGES);
});

/**
 * Personnalisation graphique (couleurs, polices, ordre des modules du menu).
 *
 * Listes fermées volontairement : les couleurs sont validées comme codes hexadécimaux, les
 * polices et les identifiants de modules ne peuvent venir que des valeurs proposées par la
 * console admin (mêmes polices que celles chargées dans index.html, mêmes modules que ceux
 * marqués data-module). Rien d'arbitraire n'est jamais injecté dans le CSS ou le HTML du site.
 */
const THEME_COULEURS_CLES = ["ink", "velvet", "card", "beam", "ticket", "teal", "chalk", "muted"];
const THEME_POLICES = {
  affiche: ["Anton", "Bebas Neue", "Bangers", "Archivo Black", "Oswald", "Montserrat"],
  corps: ["Inter", "Roboto", "Poppins", "Montserrat", "Nunito"],
  etiquette: ["Oswald", "Barlow Condensed", "Teko", "Rajdhani", "Bebas Neue", "Montserrat"],
};
const THEME_MODULES_MENU = ["sorties", "cinemas", "niveau", "quotidien", "modes", "actions", "rejoindre", "stats"];
// Disposition des cases du salon vocal (hôte/cohôtes, intervenants, auditeurs), réordonnable depuis
// la même console admin — voir REGLAGES_DEFAUT.theme.ordre.vocal et appliquerTheme() côté client.
const THEME_MODULES_VOCAL = ["vocal-hote", "vocal-intervenants", "vocal-auditeurs"];
// Modules personnalisables individuellement (accent principal + secondaire uniquement — voir
// REGLAGES_DEFAUT.theme.couleursCategories pour le détail du choix).
const THEME_CATEGORIES = {
  echange: "Espace échanges", classement: "Classement", quetes: "Quêtes",
  sondages: "Sondages", amis: "Amis", vocal: "Salon vocal",
};
const THEME_COULEURS_CATEGORIE_CLES = ["beam", "teal"];

/** Rétablit couleursCategories si absent (réglages sauvegardés avant l'ajout de cette fonctionnalité). */
function assurerCouleursCategories() {
  if (!REGLAGES.theme) REGLAGES.theme = structuredClone(REGLAGES_DEFAUT.theme);
  if (!REGLAGES.theme.couleursCategories || typeof REGLAGES.theme.couleursCategories !== "object")
    REGLAGES.theme.couleursCategories = structuredClone(REGLAGES_DEFAUT.theme.couleursCategories);
  for (const cat of Object.keys(THEME_CATEGORIES))
    if (!REGLAGES.theme.couleursCategories[cat]) REGLAGES.theme.couleursCategories[cat] = { beam: "", teal: "" };
}

app.put("/api/admin/theme", requireAdmin, (req, res) => {
  assurerCouleursCategories();
  const t = req.body || {};
  for (const cle of THEME_COULEURS_CLES) {
    const v = t.couleurs?.[cle];
    if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) REGLAGES.theme.couleurs[cle] = v;
  }
  for (const role of Object.keys(THEME_POLICES)) {
    const v = t.polices?.[role];
    if (THEME_POLICES[role].includes(v)) REGLAGES.theme.polices[role] = v;
  }
  const ordreMenu = t.ordre?.menu;
  if (Array.isArray(ordreMenu)) {
    const filtre = ordreMenu.filter((id) => THEME_MODULES_MENU.includes(id));
    // On complète avec les modules manquants (dans l'ordre par défaut) pour ne jamais faire
    // disparaître un module du menu suite à une liste incomplète envoyée par erreur.
    const manquants = THEME_MODULES_MENU.filter((id) => !filtre.includes(id));
    REGLAGES.theme.ordre.menu = [...filtre, ...manquants];
  }
  const ordreVocal = t.ordre?.vocal;
  if (Array.isArray(ordreVocal)) {
    const filtre = ordreVocal.filter((id) => THEME_MODULES_VOCAL.includes(id));
    const manquants = THEME_MODULES_VOCAL.filter((id) => !filtre.includes(id));
    REGLAGES.theme.ordre.vocal = [...filtre, ...manquants];
  }
  const couleursCategories = t.couleursCategories;
  if (couleursCategories && typeof couleursCategories === "object") {
    for (const cat of Object.keys(THEME_CATEGORIES)) {
      const source = couleursCategories[cat];
      if (!source || typeof source !== "object") continue;
      for (const cle of THEME_COULEURS_CATEGORIE_CLES) {
        const v = source[cle];
        // chaîne vide = on retire la personnalisation de ce module (retour à la couleur
        // globale) ; sinon la valeur doit être un code hexadécimal strict, jamais injecté tel quel.
        if (v === "" || (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)))
          REGLAGES.theme.couleursCategories[cat][cle] = v;
      }
    }
  }
  sauver("reglages", REGLAGES);
  res.json({ ok: true, theme: REGLAGES.theme });
});

app.post("/api/admin/theme/defaut", requireAdmin, (_req, res) => {
  REGLAGES.theme = structuredClone(REGLAGES_DEFAUT.theme);
  sauver("reglages", REGLAGES);
  res.json({ ok: true, theme: REGLAGES.theme });
});

app.get("/api/admin/theme/options", requireAdmin, (_req, res) => {
  res.json({
    couleurs: THEME_COULEURS_CLES, polices: THEME_POLICES, modulesMenu: THEME_MODULES_MENU,
    modulesVocal: THEME_MODULES_VOCAL,
    categories: THEME_CATEGORIES, couleursCategorieCles: THEME_COULEURS_CATEGORIE_CLES,
  });
});

/**
 * Espace audio (console admin, onglet « Audio ») : réglages liés aux salons vocaux, regroupés à
 * un seul endroit pour pouvoir en accueillir d'autres à l'avenir. La lecture se fait via l'onglet
 * Réglages existant (GET /api/admin/reglages renvoie déjà tout REGLAGES, audio compris) ; seule
 * l'écriture a besoin de sa propre route, avec sa propre validation.
 */
app.put("/api/admin/audio", requireAdmin, (req, res) => {
  const a = req.body || {};
  if (!REGLAGES.audio) REGLAGES.audio = structuredClone(REGLAGES_DEFAUT.audio);
  if (typeof a.turnActif === "boolean") REGLAGES.audio.turnActif = a.turnActif;
  if (typeof a.turnUrl === "string") REGLAGES.audio.turnUrl = a.turnUrl.trim().slice(0, 600);
  if (typeof a.turnUsername === "string") REGLAGES.audio.turnUsername = a.turnUsername.trim().slice(0, 120);
  if (typeof a.turnCredential === "string") REGLAGES.audio.turnCredential = a.turnCredential.trim().slice(0, 200);
  // Cloudflare (recommandé, voir REGLAGES_DEFAUT.audio plus haut) : changer l'un ou l'autre de ces
  // deux champs invalide immédiatement le cache d'identifiants temporaires en cours (voir
  // obtenirIceServersCloudflare) pour qu'une clé corrigée reprenne effet tout de suite, sans
  // attendre l'expiration naturelle du cache.
  if (typeof a.cloudflareTurnKeyId === "string" && a.cloudflareTurnKeyId.trim().slice(0, 200) !== REGLAGES.audio.cloudflareTurnKeyId) {
    REGLAGES.audio.cloudflareTurnKeyId = a.cloudflareTurnKeyId.trim().slice(0, 200);
    cloudflareTurnCache = null;
  }
  if (typeof a.cloudflareTurnApiToken === "string" && a.cloudflareTurnApiToken.trim().slice(0, 400) !== REGLAGES.audio.cloudflareTurnApiToken) {
    REGLAGES.audio.cloudflareTurnApiToken = a.cloudflareTurnApiToken.trim().slice(0, 400);
    cloudflareTurnCache = null;
  }
  REGLAGES.audio.maxParticipantsVocal = borneValeur(a.maxParticipantsVocal, 2, 200, REGLAGES.audio.maxParticipantsVocal);
  REGLAGES.audio.maxCohotesVocal = borneValeur(a.maxCohotesVocal, 1, 10, REGLAGES.audio.maxCohotesVocal);
  REGLAGES.audio.fermetureGraceMinutes = borneValeur(a.fermetureGraceMinutes, 1, 30, REGLAGES.audio.fermetureGraceMinutes);
  if (typeof a.monteeLibreParDefaut === "boolean") REGLAGES.audio.monteeLibreParDefaut = a.monteeLibreParDefaut;
  sauver("reglages", REGLAGES);
  res.json({ ok: true, audio: REGLAGES.audio });
});

// La route "/api/admin/vocal/salons" (vue de modération) est maintenant définie par le module
// vocal-salon.js lui-même (voir plus bas, creerModuleVocalSalon).

/**
 * Petit bouton teaser à côté du "?" (voir #btnLienExterne côté client) : un lien externe à
 * annoncer aux joueurs, avec un compte à rebours optionnel avant qu'il ne devienne cliquable.
 * Pensé pour un futur second jeu développé séparément, sans rien présumer de plus pour l'instant.
 */
app.get("/api/admin/lien-externe", requireAdmin, (_req, res) => res.json(REGLAGES.lienExterne));

app.put("/api/admin/lien-externe", requireAdmin, (req, res) => {
  const l = req.body || {};
  if (!REGLAGES.lienExterne) REGLAGES.lienExterne = structuredClone(REGLAGES_DEFAUT.lienExterne);
  if (typeof l.url === "string") {
    const url = l.url.trim().slice(0, 500);
    // Seuls http(s) sont acceptés : rien d'autre n'atterrit jamais dans un attribut href généré
    // côté serveur (voir la règle du projet sur ce qui peut être injecté dans le HTML du site).
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "URL_INVALIDE" });
    REGLAGES.lienExterne.url = url;
  }
  if (typeof l.titre === "string") REGLAGES.lienExterne.titre = l.titre.trim().slice(0, 60);
  if (typeof l.cible === "string") REGLAGES.lienExterne.cible = l.cible.trim().slice(0, 40);
  if (typeof l.actif === "boolean") REGLAGES.lienExterne.actif = l.actif;
  sauver("reglages", REGLAGES);
  res.json({ ok: true, lienExterne: REGLAGES.lienExterne });
});

/**
 * Passerelle de connexion (« Sign in with MichBen ») : permet à un AUTRE jeu, développé
 * séparément, de reconnaître automatiquement le compte MichBen d'un joueur qui clique sur le
 * bouton 🔗 — sans jamais partager de mot de passe ni de base de données entre les deux projets.
 * Voir le document remis à part pour la marche à suivre côté second projet.
 */
app.get("/api/admin/passerelle", requireAdmin, (_req, res) => res.json(REGLAGES.passerelle));

app.get("/api/admin/passerelle/generer-cle", requireAdmin, (_req, res) => {
  res.json({ cle: crypto.randomBytes(24).toString("hex") });
});

app.put("/api/admin/passerelle", requireAdmin, (req, res) => {
  const p = req.body || {};
  if (!REGLAGES.passerelle) REGLAGES.passerelle = structuredClone(REGLAGES_DEFAUT.passerelle);
  if (typeof p.cleSecrete === "string") REGLAGES.passerelle.cleSecrete = p.cleSecrete.trim().slice(0, 200);
  if (typeof p.domaines === "string") {
    const lignes = p.domaines.split(/[\n,]/).map((d) => d.trim()).filter(Boolean);
    if (lignes.some((d) => !/^https?:\/\//i.test(d)))
      return res.status(400).json({ error: "DOMAINE_INVALIDE" });
    REGLAGES.passerelle.domaines = lignes.join("\n").slice(0, 1000);
  }
  if (typeof p.actif === "boolean") REGLAGES.passerelle.actif = p.actif;
  sauver("reglages", REGLAGES);
  res.json({ ok: true, passerelle: REGLAGES.passerelle });
});

/**
 * Passerelle ENTRANTE : configuration du sens inverse — un joueur d'un AUTRE jeu (ex. Le Nouveau
 * Bac) qui clique sur son propre bouton 🔗 doit arriver ici déjà connecté (voir
 * /auth/michben/retour dans auth-x.js). `cleSecrete` doit être EXACTEMENT la même valeur que
 * celle configurée côté de cet autre jeu, dans sa carte « Passerelle de connexion ».
 */
app.get("/api/admin/passerelle-entrante", requireAdmin, (_req, res) => res.json(REGLAGES.passerelleEntrante));

app.put("/api/admin/passerelle-entrante", requireAdmin, (req, res) => {
  const p = req.body || {};
  if (!REGLAGES.passerelleEntrante) REGLAGES.passerelleEntrante = structuredClone(REGLAGES_DEFAUT.passerelleEntrante);
  if (typeof p.domaine === "string") {
    const d = p.domaine.trim();
    if (d && !/^https?:\/\//i.test(d)) return res.status(400).json({ error: "DOMAINE_INVALIDE" });
    REGLAGES.passerelleEntrante.domaine = d.slice(0, 300);
  }
  if (typeof p.cleSecrete === "string") REGLAGES.passerelleEntrante.cleSecrete = p.cleSecrete.trim().slice(0, 200);
  if (typeof p.actif === "boolean") REGLAGES.passerelleEntrante.actif = p.actif;
  sauver("reglages", REGLAGES);
  res.json({ ok: true, passerelleEntrante: REGLAGES.passerelleEntrante });
});

// code à usage unique -> { userId, expiresAt } — voir GET /api/passerelle/autoriser.
const passerelleCodes = new Map();
const PASSERELLE_CODE_DUREE_MS = 60 * 1000; // large marge : l'échange se fait serveur à serveur, tout de suite après la redirection
setInterval(() => {
  const maintenant = Date.now();
  for (const [code, entree] of passerelleCodes) if (entree.expiresAt < maintenant) passerelleCodes.delete(code);
}, 5 * 60 * 1000);

/** Un joueur clique sur le bouton 🔗 : s'il est bien connecté ici, on l'envoie vers l'autre jeu
 *  avec un code à usage unique dans l'URL, que ce jeu pourra échanger contre son profil (voir plus
 *  bas). Rien n'est jamais transmis en clair : le code seul ne révèle rien sans la clé secrète. */
app.get("/api/passerelle/autoriser", (req, res) => {
  const retour = String(req.query.retour || "");
  if (!REGLAGES.passerelle?.actif || !REGLAGES.passerelle.cleSecrete)
    return res.redirect("/?erreur=passerelle_indisponible");

  const domainesAutorises = (REGLAGES.passerelle.domaines || "").split("\n").map((d) => d.trim()).filter(Boolean);
  if (!domainesAutorises.some((d) => retour.startsWith(d)))
    return res.redirect("/?erreur=passerelle_domaine");

  const user = userFromCookie(req.headers.cookie);
  if (!user) return res.redirect("/?erreur=passerelle_non_connecte");

  const code = crypto.randomBytes(24).toString("hex");
  passerelleCodes.set(code, { userId: user.id, expiresAt: Date.now() + PASSERELLE_CODE_DUREE_MS });
  const sep = retour.includes("?") ? "&" : "?";
  res.redirect(`${retour}${sep}mb_code=${code}`);
});

/** Appel serveur-à-serveur depuis l'AUTRE jeu (jamais depuis un navigateur) : échange un code
 *  contre le profil MichBen minimal du joueur concerné. Authentifié par la clé secrète partagée
 *  (configurée dans les deux projets, jamais par cookie) — voir x-passerelle-cle ci-dessous. */
app.post("/api/passerelle/echanger", (req, res) => {
  const cleAttendue = REGLAGES.passerelle?.cleSecrete || "";
  const cleRecue = String(req.get("x-passerelle-cle") || "");
  if (!cleAttendue || cleRecue.length !== cleAttendue.length ||
      !crypto.timingSafeEqual(Buffer.from(cleRecue), Buffer.from(cleAttendue)))
    return res.status(401).json({ error: "CLE_INVALIDE" });

  const code = String(req.body?.code || "");
  const entree = passerelleCodes.get(code);
  passerelleCodes.delete(code); // usage unique, qu'il soit valide ou non
  if (!entree || entree.expiresAt < Date.now()) return res.status(400).json({ error: "CODE_INVALIDE" });

  const user = listUsers().find((u) => u.id === entree.userId);
  if (!user) return res.status(404).json({ error: "INTROUVABLE" });

  res.json({
    ok: true,
    id: user.id, pseudo: user.pseudo, avatar: user.avatar, photo: user.photo || null,
    niveau: user.niveau || 0, xp: user.xp || 0, role: user.role || "joueur",
  });
});

/** Indique si le mot de passe par défaut est encore en usage. */
app.get("/api/admin/etat", requireAdmin, (_req, res) =>
  res.json({ motDePasseParDefaut: !empreinteAdmin })
);

app.get("/api/movies", requireAdmin, (_req, res) => res.json(movies));

// Nombre de films actifs dans le jeu — affiché en petit dans le menu des joueurs, pas besoin
// d'être admin pour le consulter (aucune donnée sensible, juste un compteur).
app.get("/api/movies/total", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  res.json({ total: movies.filter((m) => m.enabled).length });
});

// Nombre total de joueurs inscrits depuis le début — petit indicateur du menu, lui aussi
// public une fois connecté (pas de donnée sensible, juste un chiffre).
app.get("/api/joueurs/total", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  res.json({ total: nombreComptes() });
});

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

/* ------------------------------------------------------------------ */
/* Import de films enfants depuis TMDB (Animation / Famille)           */
/* ------------------------------------------------------------------ */
const GENRE_ANIMATION_TMDB = 16, GENRE_FAMILLE_TMDB = 10751;

/** Retire le titre du synopsis : sinon la réponse est offerte. */
function scrubTitreTmdb(synopsis, title) {
  const t = String(title || "");
  const echappe = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!echappe) return String(synopsis || "").trim();
  return String(synopsis || "").replace(new RegExp(echappe, "gi"), "…").replace(/\s+/g, " ").trim();
}

/** Variantes acceptées en réponse (VF, VO, titre sans sous-titre). */
function buildAnswersTmdb(fr, original) {
  const set = new Set([fr, original].filter(Boolean));
  for (const t of [fr, original]) {
    if (!t) continue;
    if (t.includes(":")) set.add(t.split(":")[0]);
    if (t.includes(" - ")) set.add(t.split(" - ")[0]);
  }
  return [...set].map((t) => t.trim()).filter(Boolean);
}

/**
 * Cherche sur TMDB des films d'animation / familiaux absents du catalogue,
 * pour alimenter le mode enfant sans avoir à lancer de script en ligne de
 * commande. Ne modifie rien : l'administration choisit ensuite lesquels
 * ajouter via /tmdb-kids-importer.
 */
app.get("/api/admin/movies/tmdb-kids-suggestions", requireAdmin, async (req, res) => {
  const tmdbKey = REGLAGES.tmdbApiKey;
  if (!tmdbKey) return res.status(400).json({ error: "NO_KEY" });

  const pages = Math.min(5, Math.max(1, Number(req.query.pages) || 2));
  const limite = Math.min(40, Math.max(1, Number(req.query.limite) || 24));

  const idsConnus = new Set(movies.filter((m) => m.tmdbId).map((m) => m.tmdbId));
  const titresConnus = new Set(movies.map((m) => String(m.title || "").trim().toLowerCase()));

  try {
    const candidats = [];
    for (let page = 1; page <= pages && candidats.length < limite * 2; page++) {
      const url = `https://api.themoviedb.org/3/discover/movie?api_key=${tmdbKey}&language=fr-FR&region=FR` +
        `&sort_by=popularity.desc&include_adult=false&with_genres=${GENRE_ANIMATION_TMDB},${GENRE_FAMILLE_TMDB}` +
        `&vote_count.gte=150&page=${page}`;
      const r = await fetch(url);
      if (!r.ok) break;
      const data = await r.json();
      for (const m of data.results || []) {
        if (idsConnus.has(m.id)) continue;
        if (titresConnus.has(String(m.title || "").trim().toLowerCase())) continue;
        if (!m.overview || !m.poster_path) continue;
        candidats.push(m);
      }
    }

    const retenus = [];
    for (const brut of candidats.slice(0, limite)) {
      try {
        const dRes = await fetch(
          `https://api.themoviedb.org/3/movie/${brut.id}?api_key=${tmdbKey}&language=fr-FR&append_to_response=credits`
        );
        if (!dRes.ok) continue;
        const d = await dRes.json();
        if (!d.overview || !d.poster_path) continue;
        retenus.push({
          tmdbId: d.id,
          title: d.title,
          acceptedAnswers: buildAnswersTmdb(d.title, d.original_title),
          synopsis: scrubTitreTmdb(d.overview, d.title),
          year: Number((d.release_date || "").slice(0, 4)) || null,
          director: (d.credits?.crew || []).find((c) => c.job === "Director")?.name || "",
          actors: (d.credits?.cast || []).slice(0, 3).map((c) => c.name).join(", "),
          poster: `https://image.tmdb.org/t/p/w500${d.poster_path}`,
          still: d.backdrop_path ? `https://image.tmdb.org/t/p/w780${d.backdrop_path}` : "",
          rating: Math.round((d.vote_average || 0) * 10) / 10,
          votes: d.vote_count || 0,
          difficulty: niveauDepuisVotes(d.vote_count || 0),
          kids: true,
        });
      } catch { /* un film en erreur n'empêche pas les autres */ }
    }
    res.json({ movies: retenus });
  } catch (err) {
    console.error("Erreur suggestions TMDB enfants:", err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/** Ajoute au catalogue les films choisis par l'administration parmi les suggestions TMDB. */
app.post("/api/admin/movies/tmdb-kids-importer", requireAdmin, (req, res) => {
  const proposes = Array.isArray(req.body.movies) ? req.body.movies : [];
  const titresConnus = new Set(movies.map((m) => String(m.title || "").trim().toLowerCase()));
  const idsConnus = new Set(movies.filter((m) => m.tmdbId).map((m) => m.tmdbId));

  let ajoutes = 0, ignores = 0;
  for (const brut of proposes) {
    const titreNorm = String(brut.title || "").trim().toLowerCase();
    if (!titreNorm || titresConnus.has(titreNorm) || (brut.tmdbId && idsConnus.has(Number(brut.tmdbId)))) {
      ignores++; continue;
    }
    const film = sanitizeMovie({ ...brut, kids: true });
    if (!film.title || !film.synopsis) { ignores++; continue; }
    film.tmdbId = Number(brut.tmdbId) || null;
    film.id = Math.max(0, ...movies.map((m) => m.id)) + 1;
    movies.push(film);
    titresConnus.add(titreNorm);
    if (film.tmdbId) idsConnus.add(film.tmdbId);
    ajoutes++;
  }
  saveMovies();
  res.json({ ajoutes, ignores, total: movies.length });
});

/** Codes pays acceptés pour l'import ciblé (voir tmdb-pays-suggestions) — liste volontairement
 *  fermée pour ne jamais transmettre à TMDB une valeur arbitraire venue du client. */
const PAYS_IMPORT_TMDB = {
  FR: "France", US: "États-Unis", GB: "Royaume-Uni", CA: "Canada", IT: "Italie", ES: "Espagne",
  DE: "Allemagne", BE: "Belgique", CH: "Suisse", JP: "Japon", KR: "Corée du Sud", CN: "Chine",
  HK: "Hong Kong", IN: "Inde", BR: "Brésil", MX: "Mexique", AU: "Australie", SE: "Suède",
  DK: "Danemark", NO: "Norvège", NL: "Pays-Bas", RU: "Russie", PL: "Pologne", TR: "Turquie",
  IR: "Iran", TH: "Thaïlande", EG: "Égypte", SN: "Sénégal", MA: "Maroc", DZ: "Algérie",
  TN: "Tunisie", AR: "Argentine", CO: "Colombie", ZA: "Afrique du Sud", NG: "Nigeria",
};

/**
 * Cherche sur TMDB des films d'un pays donné, absents du catalogue — même principe que
 * l'import ciblé « enfant » ci-dessus, mais filtré par pays d'origine (with_origin_country)
 * plutôt que par genre. Classe automatiquement chaque suggestion « France » ou
 * « international » selon le pays choisi, pour alimenter directement l'équilibrage du tirage
 * des manches (voir choisirFilms / REGLAGES.ratioFilmsFrancaisMax) sans reclassement manuel.
 */
app.get("/api/admin/movies/tmdb-pays-suggestions", requireAdmin, async (req, res) => {
  const tmdbKey = REGLAGES.tmdbApiKey;
  if (!tmdbKey) return res.status(400).json({ error: "NO_KEY" });

  const pays = String(req.query.pays || "").toUpperCase();
  if (!PAYS_IMPORT_TMDB[pays]) return res.status(400).json({ error: "PAYS_INVALIDE" });

  const pages = Math.min(5, Math.max(1, Number(req.query.pages) || 2));
  const limite = Math.min(40, Math.max(1, Number(req.query.limite) || 24));
  const origine = pays === "FR" ? "france" : "international";

  const idsConnus = new Set(movies.filter((m) => m.tmdbId).map((m) => m.tmdbId));
  const titresConnus = new Set(movies.map((m) => String(m.title || "").trim().toLowerCase()));

  try {
    const candidats = [];
    for (let page = 1; page <= pages && candidats.length < limite * 2; page++) {
      const url = `https://api.themoviedb.org/3/discover/movie?api_key=${tmdbKey}&language=fr-FR` +
        `&sort_by=popularity.desc&include_adult=false&with_origin_country=${pays}` +
        `&vote_count.gte=100&page=${page}`;
      const r = await fetch(url);
      if (!r.ok) break;
      const data = await r.json();
      for (const m of data.results || []) {
        if (idsConnus.has(m.id)) continue;
        if (titresConnus.has(String(m.title || "").trim().toLowerCase())) continue;
        if (!m.overview || !m.poster_path) continue;
        candidats.push(m);
      }
    }

    const retenus = [];
    for (const brut of candidats.slice(0, limite)) {
      try {
        const dRes = await fetch(
          `https://api.themoviedb.org/3/movie/${brut.id}?api_key=${tmdbKey}&language=fr-FR&append_to_response=credits`
        );
        if (!dRes.ok) continue;
        const d = await dRes.json();
        if (!d.overview || !d.poster_path) continue;
        const estAnime = (d.genres || []).some((g) => g.id === GENRE_ANIMATION_TMDB);
        const estFamille = (d.genres || []).some((g) => g.id === GENRE_FAMILLE_TMDB);
        retenus.push({
          tmdbId: d.id,
          title: d.title,
          acceptedAnswers: buildAnswersTmdb(d.title, d.original_title),
          synopsis: scrubTitreTmdb(d.overview, d.title),
          year: Number((d.release_date || "").slice(0, 4)) || null,
          director: (d.credits?.crew || []).find((c) => c.job === "Director")?.name || "",
          actors: (d.credits?.cast || []).slice(0, 3).map((c) => c.name).join(", "),
          poster: `https://image.tmdb.org/t/p/w500${d.poster_path}`,
          still: d.backdrop_path ? `https://image.tmdb.org/t/p/w780${d.backdrop_path}` : "",
          rating: Math.round((d.vote_average || 0) * 10) / 10,
          votes: d.vote_count || 0,
          difficulty: niveauDepuisVotes(d.vote_count || 0),
          kids: estAnime || estFamille,
          origine,
        });
      } catch { /* un film en erreur n'empêche pas les autres */ }
    }
    res.json({ movies: retenus, pays, paysNom: PAYS_IMPORT_TMDB[pays] });
  } catch (err) {
    console.error("Erreur suggestions TMDB par pays:", err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/** Ajoute au catalogue les films choisis par l'administration parmi les suggestions par pays. */
app.post("/api/admin/movies/tmdb-pays-importer", requireAdmin, (req, res) => {
  const proposes = Array.isArray(req.body.movies) ? req.body.movies : [];
  const titresConnus = new Set(movies.map((m) => String(m.title || "").trim().toLowerCase()));
  const idsConnus = new Set(movies.filter((m) => m.tmdbId).map((m) => m.tmdbId));

  let ajoutes = 0, ignores = 0;
  for (const brut of proposes) {
    const titreNorm = String(brut.title || "").trim().toLowerCase();
    if (!titreNorm || titresConnus.has(titreNorm) || (brut.tmdbId && idsConnus.has(Number(brut.tmdbId)))) {
      ignores++; continue;
    }
    const film = sanitizeMovie(brut);
    if (!film.title || !film.synopsis) { ignores++; continue; }
    film.tmdbId = Number(brut.tmdbId) || null;
    film.id = Math.max(0, ...movies.map((m) => m.id)) + 1;
    movies.push(film);
    titresConnus.add(titreNorm);
    if (film.tmdbId) idsConnus.add(film.tmdbId);
    ajoutes++;
  }
  saveMovies();
  res.json({ ajoutes, ignores, total: movies.length });
});

app.post("/api/admin/invite", requireAdmin, (req, res) => {
  const code = genererCodeAdmin();
  res.json({ code });
});

app.get("/api/admin/stats", requireAdmin, (_req, res) => {
  const parNiveau = {};
  for (const n of ["facile", "moyen", "difficile"])
    parNiveau[n] = {
      total: movies.filter((m) => m.difficulty === n).length,
      actifs: movies.filter((m) => m.difficulty === n && m.enabled).length,
    };
  // Répartition France / international parmi les films actifs : sert à voir d'un coup d'œil si
  // le catalogue est équilibré, sans quoi le tirage (voir choisirFilms) a beau plafonner la part
  // de films français par manche, il ne peut pas inventer des films internationaux manquants.
  const actifsListe = movies.filter((m) => m.enabled);
  const parOrigine = {
    france: actifsListe.filter((m) => m.origine === "france").length,
    international: actifsListe.filter((m) => m.origine === "international").length,
    nonClasse: actifsListe.filter((m) => !m.origine).length,
  };
  res.json({ total: movies.length, actifs: actifsListe.length, parNiveau, parOrigine });
});

/* ---------- administration des joueurs ---------- */

app.get("/api/admin/users", requireAdmin, (_req, res) => res.json(listUsers()));

// Le fondateur peut créer jusqu'à ce nombre de comptes enfant depuis la console admin —
// au-delà, on considère que c'est une erreur de manipulation plutôt qu'un vrai besoin.
const MAX_COMPTES_ENFANT = 5;
const nombreComptesEnfant = () => listUsers().filter((u) => u.role === "enfant").length;

/** Combien de comptes enfant existent déjà, et combien il en reste possible à créer. */
app.get("/api/admin/comptes-enfant", requireAdmin, (_req, res) => {
  const utilises = nombreComptesEnfant();
  res.json({ utilises, max: MAX_COMPTES_ENFANT, restants: Math.max(0, MAX_COMPTES_ENFANT - utilises) });
});

/**
 * Création rapide d'un compte par l'administration : identifiant + mot de
 * passe, sans email à valider. Cocher « enfant » crée un compte restreint
 * au mode enfant, avec son propre classement — plafonné à MAX_COMPTES_ENFANT
 * pour éviter les créations accidentelles en rafale.
 */
app.post("/api/admin/comptes", requireAdmin, (req, res) => {
  const enfant = req.body.enfant === true;
  if (enfant && nombreComptesEnfant() >= MAX_COMPTES_ENFANT) {
    return res.status(400).json({ error: "MAX_COMPTES_ENFANT_ATTEINT", max: MAX_COMPTES_ENFANT });
  }
  const r = creerCompteAdmin({
    pseudo: req.body.pseudo,
    motDePasse: req.body.motDePasse,
    enfant,
  });
  if (r.error) return res.status(400).json(r);
  res.status(201).json(sansMotDePasse(r.user));
});

app.put("/api/admin/users/:id", requireAdmin, (req, res) => {
  const avantCredits = getCredits(req.params.id), avantPoints = getPoints(req.params.id);
  const user = adminUpdateUser(req.params.id, req.body);
  if (!user) return res.status(404).json({ error: "NOT_FOUND" });
  const deltaCredits = getCredits(req.params.id) - avantCredits;
  const deltaPoints = getPoints(req.params.id) - avantPoints;
  if (deltaCredits) enregistrerTransaction(req.params.id, deltaCredits, "credits", "Ajustement par l'administrateur");
  if (deltaPoints) enregistrerTransaction(req.params.id, deltaPoints, "points", "Ajustement par l'administrateur");
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
    // Film adapté aux enfants (Disney, Pixar, familial…) : sert au mode enfant.
    kids: body.kids === true || body.kids === "true",
    // Identifiant TMDB d'origine, pour éviter les doublons lors d'un futur import.
    tmdbId: Number(body.tmdbId) || null,
    // France / international : sert à équilibrer le tirage des manches (voir choisirFilms),
    // pour éviter qu'un catalogue trop riche en films français à l'ajout n'étouffe les
    // films internationaux. "" = non classé (n'entre dans aucun des deux quotas).
    origine: ["france", "international"].includes(body.origine) ? body.origine : "",
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

/* ------------------------------------------------------------------ */
/* Signets : chaque joueur (adulte ou enfant) peut mettre de côté un    */
/* film à voir plus tard, proposé juste après la révélation de la      */
/* réponse. Simple liste d'identifiants par joueur.                     */
/* ------------------------------------------------------------------ */

const SIGNETS_FILE = new URL("./signets.json", import.meta.url);
let signets = {};   // userId -> [movieId, ...] (le plus récent en dernier)
const saveSignets = () => sauver("signets", signets, SIGNETS_FILE);

app.get("/api/signets", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    const mesIds = signets[user.id] || [];
    const films = mesIds
        .map((id) => movies.find((m) => m.id === id))
        .filter(Boolean)
        .map((m) => ({ id: m.id, title: m.title, poster: m.poster, year: m.year, tmdbId: m.tmdbId }))
        .reverse();   // le plus récemment ajouté en premier
    res.json(films);
});

app.post("/api/signets/:movieId/toggle", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    const movieId = Number(req.params.movieId);
    if (!movies.find((m) => m.id === movieId)) return res.status(404).json({ error: "MOVIE_NOT_FOUND" });

    const mesIds = signets[user.id] || (signets[user.id] = []);
    const i = mesIds.indexOf(movieId);
    let signet;
    if (i === -1) { mesIds.push(movieId); signet = true; }
    else { mesIds.splice(i, 1); signet = false; }
    saveSignets();
    res.json({ ok: true, signet });
});

/** Catalogue des films, pour le parcourir et le rechercher en dehors d'une manche — mettre un
 *  film de côté (signet), en pépite, ou le signaler sans attendre de tomber dessus en jouant.
 *  Champs volontairement limités à l'essentiel (titre, année, affiche, identifiant TMDB pour la
 *  bande-annonce) : jamais de synopsis ni de réponses acceptées ici, qui n'ont rien à y faire —
 *  seuls masquerReponse()/les routes de manche renvoient ces champs sensibles, jamais celle-ci.
 *  Un compte enfant (ou la bascule "Mode enfant" — voir kids) ne voit que le catalogue enfant,
 *  comme partout ailleurs dans le jeu (voir /api/solo/start). */
app.get("/api/films/parcourir", (req, res) => {
    const user = userFromCookie(req.headers.cookie);
    const modeEnfant = user?.role === "enfant" ? true : req.query.kids === "1";
    const recherche = String(req.query.q || "").trim().toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const parPage = 30;

    let vivier = movies.filter((m) => m.enabled !== false);
    if (modeEnfant) vivier = vivier.filter((m) => m.kids === true);
    if (recherche) vivier = vivier.filter((m) => String(m.title || "").toLowerCase().includes(recherche));
    vivier = [...vivier].sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "fr"));

    const total = vivier.length;
    const debut = (page - 1) * parPage;
    const films = vivier.slice(debut, debut + parPage)
        .map((m) => ({ id: m.id, title: m.title, year: m.year, poster: m.poster, tmdbId: m.tmdbId || null }));
    res.json({ films, total, page, pages: Math.max(1, Math.ceil(total / parPage)) });
});

/* ------------------------------------------------------------------ */
/* Pépites                                                              */
/*                                                                      */
/* Un « top 5 » personnel, plus exclusif que les signets (illimités) :  */
/* chaque joueur ne peut mettre en avant que 5 films au maximum. Les    */
/* pépites de tout le monde sont agrégées pour faire remonter les films */
/* les plus plébiscités (visible par tous, et depuis la console admin). */
/* ------------------------------------------------------------------ */

const PEPITES_FILE = new URL("./pepites.json", import.meta.url);
let pepites = {};   // userId -> [movieId, ...] (le plus récent en dernier), 5 maximum
const savePepites = () => sauver("pepites", pepites, PEPITES_FILE);
const MAX_PEPITES = 5;

const filmsDepuisIds = (ids) => ids
    .map((id) => movies.find((m) => m.id === id))
    .filter(Boolean)
    .map((m) => ({ id: m.id, title: m.title, poster: m.poster, year: m.year, tmdbId: m.tmdbId }));

// Un joueur peut débloquer jusqu'à 2 emplacements pépites supplémentaires via les coffres
// de niveau (voir plus bas) : sa limite réelle est donc parfois > MAX_PEPITES.
const maxPepitesPour = (userId) => MAX_PEPITES + pepiteSlotsBonus(userId);

app.get("/api/pepites", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    res.json({ films: filmsDepuisIds(pepites[user.id] || []).reverse(), max: maxPepitesPour(user.id) });
});

app.post("/api/pepites/:movieId/toggle", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    const movieId = Number(req.params.movieId);
    if (!movies.find((m) => m.id === movieId)) return res.status(404).json({ error: "MOVIE_NOT_FOUND" });

    const max = maxPepitesPour(user.id);
    const mesIds = pepites[user.id] || (pepites[user.id] = []);
    const i = mesIds.indexOf(movieId);
    let pepite;
    if (i === -1) {
        if (mesIds.length >= max) return res.status(400).json({ error: "MAX_PEPITES_ATTEINT", max });
        mesIds.push(movieId);
        pepite = true;
    } else {
        mesIds.splice(i, 1);
        pepite = false;
    }
    savePepites();
    res.json({ ok: true, pepite, restantes: max - mesIds.length, max });
});

/** Classement des films les plus mis en pépite, tous joueurs confondus. */
function topPepites(limite = 10) {
    const compte = new Map();
    for (const ids of Object.values(pepites)) for (const id of ids) compte.set(id, (compte.get(id) || 0) + 1);
    return [...compte.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limite)
        .map(([id, n]) => {
            const m = movies.find((x) => x.id === id);
            return m ? { id: m.id, title: m.title, poster: m.poster, year: m.year, tmdbId: m.tmdbId, pepites: n } : null;
        })
        .filter(Boolean);
}

app.get("/api/pepites/top", (req, res) => {
    const user = exigeCompte(req, res);
    if (user) res.json(topPepites());
});

app.get("/api/admin/pepites/top", requireAdmin, (_req, res) => res.json(topPepites(20)));

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

/** Exempte un compte de parrainage — utile pour les premiers joueurs. */
/** Valide l'adresse email d'un compte sans lui envoyer de code. */
app.put("/api/admin/users/:id/valider", requireAdmin, (req, res) => {
  const user = validerManuellement(req.params.id);
  if (!user) return res.status(404).json({ error: "NOT_FOUND" });
  res.json({ ok: true, emailVerifie: true });
});


app.post("/api/admin/debug-user/:id", requireAdmin, (req, res) => {
    const userId = req.params.id;
    const user = users[userId];
    if (!user) return res.status(404).json({ error: "NOT_FOUND" });
    
    // Reset status to allow login if it was an issue
    user.banned = false;
    user.emailVerifie = true; // Auto-verify email
    saveUsers();
    res.json({ ok: true, user: { ...user, motDePasse: "***" } });
});

app.put("/api/admin/users/:id/fondateur", requireAdmin, (req, res) => {
  const user = adminUpdateUser(req.params.id, { fondateur: req.body.fondateur !== false });
  if (!user) return res.status(404).json({ error: "NOT_FOUND" });
  res.json({ ok: true, fondateur: Boolean(user.fondateur) });
});

app.put("/api/admin/users/:id/role", requireAdmin, (req, res) => {
  const user = definirRole(req.params.id, req.body.role);
  if (!user) return res.status(400).json({ error: "ROLE_INVALIDE" });
  res.json(user);
});

/**
 * Redonne manuellement une (ou plusieurs) partie(s) classée(s) à un joueur, sans entamer son
 * quota quotidien normal — pensé pour compenser une déconnexion subie (coupure réseau, ou un
 * redéploiement du serveur qui a coupé toutes les parties en cours sans prévenir), plutôt que de
 * devoir attendre la recharge du lendemain. Réutilise le même compteur « bonus » que le lot de
 * la roue du jour : les deux se cumulent normalement.
 */
app.post("/api/admin/users/:id/ranked-bonus", requireAdmin, (req, res) => {
  const user = adminUpdateUser(req.params.id, {});
  if (!user) return res.status(404).json({ error: "NOT_FOUND" });
  const n = Math.max(1, Math.min(20, Math.round(Number(req.body.n)) || 1));
  accorderPartiesClasseesBonus(req.params.id, n);
  res.json({ ok: true, partiesRestantes: partiesRestantes(req.params.id) });
});

/** Renvoie l'utilisateur connecté, ou termine la requête en 401. */
function exigeCompte(req, res) {
  const user = userFromCookie(req.headers.cookie);
  if (!user) { res.status(401).json({ error: "NOT_AUTHENTICATED" }); return null; }
  return user;
}

/* ------------------------------------------------------------------ */
/* Sondages « vs » (ex. pop-corn salé ou sucré ?)                       */
/*                                                                      */
/* Fonctionnalité à part entière, indépendante des salons de jeu : un   */
/* sondage à deux camps, ouvert à tous les comptes connectés, avec un   */
/* résultat en direct sous forme de pourcentages — jamais les noms des  */
/* votants. Un joueur peut changer d'avis, son vote remplace le         */
/* précédent plutôt que de s'additionner.                               */
/* ------------------------------------------------------------------ */
const SONDAGES_FILE = new URL("./sondages.json", import.meta.url);
let sondages = [];
const saveSondages = () => sauver("sondages", sondages, SONDAGES_FILE);

function resultatsSondage(s) {
  const votes = Object.values(s.votes || {});
  const totalA = votes.filter((v) => v === "A").length;
  const totalB = votes.filter((v) => v === "B").length;
  const total = totalA + totalB;
  const pourcentA = total ? Math.round((totalA / total) * 100) : 0;
  return { total, totalA, totalB, pourcentA, pourcentB: total ? 100 - pourcentA : 0 };
}
/** Vue générique (diffusée à tout le monde) : jamais qui a voté quoi. */
function sondageAggrege(s) {
  const { votes, ...reste } = s;
  return { ...reste, ...resultatsSondage(s) };
}
/** Vue personnelle (réponse à une requête d'un joueur précis) : ajoute son propre vote. */
function sondagePersonnel(s, userId) {
  return { ...sondageAggrege(s), monVote: (s.votes || {})[userId] || null };
}

app.get("/api/sondages", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  res.json(sondages.filter((s) => s.actif).map((s) => sondagePersonnel(s, user.id)));
});

app.post("/api/sondages/:id/voter", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const s = sondages.find((x) => x.id === req.params.id && x.actif);
  if (!s) return res.status(404).json({ error: "NOT_FOUND" });
  const cote = req.body.cote;
  if (!["A", "B"].includes(cote)) return res.status(400).json({ error: "COTE_INVALIDE" });
  s.votes = s.votes || {};
  // La récompense individuelle n'est donnée qu'à la toute première participation, jamais en
  // changeant d'avis ensuite — sinon il suffirait de re-voter en boucle pour farmer des tickets.
  const premierVote = !s.votes[user.id];
  s.votes[user.id] = cote;
  saveSondages();
  io.emit("sondage:maj", sondageAggrege(s));   // diffusé à tous, sans jamais dire qui a voté quoi

  let recompenseGagnee = null;
  if (premierVote && s.recompense?.actif && !s.recompense.collectif) {
    recompenseGagnee = { tickets: s.recompense.tickets || 0, xp: s.recompense.xp || 0 };
    if (recompenseGagnee.tickets) {
      grantCredits(user.id, recompenseGagnee.tickets);
      enregistrerTransaction(user.id, recompenseGagnee.tickets, "credits", `Sondage « ${s.question} »`);
    }
    if (recompenseGagnee.xp) ajouterXp(user.id, recompenseGagnee.xp, reglagesNiveau());
  }

  res.json({ ...sondagePersonnel(s, user.id), recompenseGagnee });
});

app.get("/api/admin/sondages", requireAdmin, (_req, res) =>
  res.json(sondages.map((s) => sondageAggrege(s))));

/** Construit une option de sondage à partir d'un film du catalogue (pour les battles). */
function optionDepuisFilm(filmId, texteRepli, emojiRepli) {
  const film = filmId ? movies.find((m) => m.id === Number(filmId)) : null;
  if (film) return { texte: film.title.slice(0, 40), emoji: "🎬", filmId: film.id, poster: film.poster || "" };
  const texte = String(texteRepli || "").trim();
  if (!texte) return null;
  return { texte: texte.slice(0, 40), emoji: String(emojiRepli || "🅰️").slice(0, 8) };
}

/** Nettoie et borne la configuration de récompense envoyée par l'admin. */
function recompenseDepuisRequete(r) {
  if (!r || !r.actif) return { actif: false, tickets: 0, xp: 0, collectif: false };
  return {
    actif: true,
    tickets: Math.max(0, Math.min(50, Number(r.tickets) || 0)),
    xp: Math.max(0, Math.min(500, Number(r.xp) || 0)),
    collectif: Boolean(r.collectif),
  };
}

app.post("/api/admin/sondages", requireAdmin, (req, res) => {
  // Option « battle de films » : filmA/filmB (identifiants du catalogue) remplacent le texte
  // libre — le titre, l'affiche et l'emoji 🎬 sont repris automatiquement du film.
  const optionA = optionDepuisFilm(req.body.filmA, req.body.optionA?.texte, req.body.optionA?.emoji);
  const optionB = optionDepuisFilm(req.body.filmB, req.body.optionB?.texte, req.body.optionB?.emoji);
  if (!optionA || !optionB) return res.status(400).json({ error: "OPTIONS_MANQUANTES" });
  const s = {
    id: crypto.randomUUID(),
    question: String(req.body.question || "").trim().slice(0, 120),
    optionA, optionB,
    actif: true,
    creeLe: new Date().toISOString(),
    votes: {},
    recompense: recompenseDepuisRequete(req.body.recompense),
    recompenseDistribuee: false,
  };
  sondages.unshift(s);
  saveSondages();
  // Annoncée dans le bandeau défilant de tout le monde : les statistiques en direct suivront
  // ensuite toutes seules, l'onglet Sondages affichant déjà les pourcentages en temps réel
  // (voir socket.on("sondage:maj", ...) côté client, repris aussi par le bandeau — cf. index.html).
  diffuserAnnonce(`🍿 Nouvelle battle de films : ${optionA.emoji} ${optionA.texte} contre ${optionB.texte} ${optionB.emoji} — venez voter !`, "sondage");
  res.status(201).json(sondageAggrege(s));
});

app.put("/api/admin/sondages/:id", requireAdmin, (req, res) => {
  const s = sondages.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "NOT_FOUND" });
  const cloture = typeof req.body.actif === "boolean" && req.body.actif === false && s.actif === true;
  if (typeof req.body.actif === "boolean") s.actif = req.body.actif;
  if (typeof req.body.question === "string") s.question = req.body.question.trim().slice(0, 120);

  // Récompense collective : distribuée une seule fois, au moment où l'admin clôt le sondage
  // (désactivation), à tous les joueurs ayant voté — quel que soit leur camp, pour que la
  // « battle » reste un moment positif à plusieurs plutôt qu'une compétition avec des perdants.
  if (cloture && s.recompense?.actif && s.recompense.collectif && !s.recompenseDistribuee) {
    const votants = Object.keys(s.votes || {});
    for (const userId of votants) {
      if (s.recompense.tickets) {
        grantCredits(userId, s.recompense.tickets);
        enregistrerTransaction(userId, s.recompense.tickets, "credits", `Sondage « ${s.question} » (récompense collective)`);
      }
      if (s.recompense.xp) ajouterXp(userId, s.recompense.xp, reglagesNiveau());
      notifier(userId, { type: "recompense_sondage", question: s.question,
        tickets: s.recompense.tickets, xp: s.recompense.xp });
    }
    s.recompenseDistribuee = true;
  }

  saveSondages();
  io.emit("sondage:maj", sondageAggrege(s));   // active/désactive en direct sur les écrans ouverts
  res.json(sondageAggrege(s));
});

app.delete("/api/admin/sondages/:id", requireAdmin, (req, res) => {
  sondages = sondages.filter((x) => x.id !== req.params.id);
  saveSondages();
  io.emit("sondage:supprime", { id: req.params.id });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Solo et partie classée, sans temps réel                            */
/*                                                                     */
/* Ces modes ne concernent qu'un joueur : les faire passer par le      */
/* WebSocket les rendait inutilement fragiles (bloqueurs, réseaux      */
/* filtrants). Ici, tout se joue en requêtes HTTP ordinaires.          */
/* ------------------------------------------------------------------ */


/** Calcule les avantages d'un joueur en fonction de son niveau */
function getAvantagesNiveau(niveau) {
  let extraCoeurs = 0;
  if (niveau >= 300) extraCoeurs = 3;
  else if (niveau >= 200) extraCoeurs = 2;
  else if (niveau >= 100) extraCoeurs = 1;

  let freeHints = 0;
  let allFree = false;
  if (niveau >= 300) {
    allFree = true;
  } else if (niveau >= 50) {
    freeHints = 1; // 1 indice gratuit par partie
  }

  return { extraCoeurs, freeHints, allFree };
}

const parties = new Map();
   // userId -> partie en cours

const vueManche = (p) => ({
  roundIndex: p.index,
  total: p.playlist.length,
  synopsis: masquerReponse(p.playlist[p.index].synopsis, p.playlist[p.index]),
  choices: p.choices,
  duration: CONFIG.ROUND_DURATION_MS,
  hintCosts: CONFIG.HINT_COSTS,
  hintCredits: CONFIG.HINT_CREDITS,
  coeurs: p.coeurs,
  coeursMax: p.coeursMax,
  freeHintsRemaining: p.freeHintsRemaining,
  allHintsFree: p.allHintsFree,
  hintLabels: libellesIndices(),
  posterStyle: styleAffiche(p.playlist[p.index]),
  vitesseSynopsis: REGLAGES.vitesseSynopsis,
});

function demarrerManche(p) {
  const film = p.playlist[p.index];
  p.choices = buildChoices(film);
  p.startedAt = Date.now();
  p.hints = [];
  p.paidHints = [];
  p.repondu = false;
  p.pauseA = null;
  const vue = vueManche(p);
  diffuserSpectateursSolo(p, "regarder:manche", vue);
  return vue;
}

app.post("/api/solo/start", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  if (parrainageManquant(user)) return res.status(403).json({ error: "PARRAINAGE_REQUIS" });

  const { mode = "solo", rounds, kids } = req.body;
  // Un compte enfant ne joue qu'avec le catalogue enfant, quoi que le client envoie.
  const modeEnfant = user.role === "enfant" ? true : kids === true;
  let vivier = movies.filter((m) => m.enabled !== false);
  if (modeEnfant) vivier = vivier.filter((m) => m.kids === true);
  if (!vivier.length) return res.status(400).json({ error: modeEnfant ? "NO_MOVIES_KIDS" : "NO_MOVIES" });

  if (mode === "ranked" && partiesRestantes(user.id) <= 0)
    return res.status(400).json({ error: "PLUS_DE_PARTIES", ...infoSaison(),
                                  prochaineRecharge: prochaineRecharge(user.id) });

  const nombre = Math.min(Number(rounds) || 10, vivier.length);
  const niveau = infoNiveau(user.id)?.niveau || 0;
  const avantages = getAvantagesNiveau(niveau);
  
  const p = {
    mode: mode === "ranked" ? "ranked" : "solo",
    playlist: choisirFilms(vivier, nombre, user.id),
    index: 0, score: 0, 
    coeursMax: REGLAGES.coeurs + avantages.extraCoeurs,
    coeurs: REGLAGES.coeurs + avantages.extraCoeurs,
    freeHintsRemaining: avantages.freeHints,
    allHintsFree: avantages.allFree,
    paidHints: []
  };
  memoriserVus(user.id, p.playlist);
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

  const isFree = p.allHintsFree || p.freeHintsRemaining > 0;
  if (!isFree) {
    if (!spendCredits(user.id, CONFIG.HINT_CREDITS[type]))
      return res.status(400).json({ error: "NO_CREDITS" });
    enregistrerTransaction(user.id, -CONFIG.HINT_CREDITS[type], "credits",
      `Indice « ${REGLAGES.indices?.[type]?.libelle || type} »`);
    p.paidHints.push(type);
  } else {
    if (!p.allHintsFree) p.freeHintsRemaining--;
  }

  p.hints.push(type);
  const film = p.playlist[p.index];
  const value = type === "poster" ? (film.still || film.poster)
              : type === "letters" ? titlePattern(film.title)
              : film[type];
  res.json({ ok: true, type, value, credits: getCredits(user.id), freeHintsRemaining: p.freeHintsRemaining, allHintsFree: p.allHintsFree });
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
    points = computeScore({ elapsedMs: Date.now() - p.startedAt, hintsUsed: p.paidHints });
    p.score += points;
    p.bonnes = (p.bonnes || 0) + 1;
    if (!p.hints.length) p.sansIndice = (p.sansIndice || 0) + 1;
  } else {
    p.coeurs = Math.max(0, p.coeurs - 1);
  }

  diffuserSpectateursSolo(p, "regarder:fin", {
    answer: film.title, poster: film.poster, year: film.year,
    scores: [{ pseudo: user.pseudo, avatar: user.avatar, photo: user.photo, score: p.score }],
    mode: p.mode,
  });

  res.json({
    ok: true, correct: juste, points, movieId: film.id,
    answer: film.title, poster: film.poster, year: film.year, total: p.score,
    coeurs: p.coeurs, perdu: p.coeurs === 0,
  });
});

app.post("/api/solo/next", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const p = parties.get(user.id);
  if (!p) return res.status(400).json({ error: "PAS_DE_PARTIE" });

  // passer sans avoir répondu revient à renoncer : cela coûte un cœur
  if (!p.repondu) {
    p.coeurs = Math.max(0, p.coeurs - 1);
    p.repondu = true;
  }

  p.index++;
  const fini = p.index >= p.playlist.length || p.coeurs === 0;
  if (!fini) return res.json({ ok: true, ...demarrerManche(p) });

  // fin de partie : on crédite une seule fois, puis on oublie la partie
  diffuserSpectateursSolo(p, "regarder:termine", {
    ranking: [{ pseudo: user.pseudo, avatar: user.avatar, photo: user.photo, score: p.score }],
  });
  parties.delete(user.id);
  if (p.mode === "ranked") {
    addRankedPoints(user.id, p.score);
    if (p.coeurs > 0) {
      // Victoire (terminée sans perdre tous ses cœurs) : comptée sur le quota de base, jamais sur
      // le bonus, pour que celui-ci puisse vraiment s'accumuler jusqu'à 3 (voir les commentaires
      // sur enregistrerParticipationClassee et recompenserVictoireClassee).
      enregistrerParticipationClassee(user.id);
      recompenserVictoireClassee(user.id);
    } else {
      consommerPartieClassee(user.id);
    }
  }
  grantPoints(user.id, p.score);
  grantCredits(user.id, REGLAGES.creditsParPartie);
  if (p.score) enregistrerTransaction(user.id, p.score, "points", "Partie terminée");
  if (REGLAGES.creditsParPartie) enregistrerTransaction(user.id, REGLAGES.creditsParPartie, "credits", "Partie terminée");
  // bilan : expérience, quêtes avancées, niveau atteint
  const bonnes = p.bonnes || 0;
  const xpGagnee = REGLAGES.xpParPartie + bonnes * REGLAGES.xpParBonneReponse;
  const niveau = ajouterXp(user.id, xpGagnee, reglagesNiveau());

  avancerQuete(user.id, "jouer3");
  if (bonnes) avancerQuete(user.id, "bonnes10", bonnes);
  if (p.sansIndice) avancerQuete(user.id, "sansIndice", p.sansIndice);
  if (p.coeurs === REGLAGES.coeurs) avancerQuete(user.id, "sansFaute");
  avancerQueteGlobale(user.id, "jouerParties");
  if (p.coeurs === REGLAGES.coeurs) avancerQueteGlobale(user.id, "sansFauteGlobal");

  const codeObtenu = verifierCodeParrain(user.id);
  res.json({
    ok: true, fini: true, score: p.score, mode: p.mode,
    coeursEpuises: p.coeurs === 0,
    manchesJouees: p.index, manchesTotal: p.playlist.length,
    credits: getCredits(user.id), points: getPoints(user.id), codeObtenu,
    bilan: {
      xp: xpGagnee, bonnes, ticketsGagnes: REGLAGES.creditsParPartie,
      niveau, quetes: etatQuetes(user.id),
    },
  });
});

/* ------------------------------------------------------------------ */
/* Messagerie privée entre amis                                        */
/*                                                                     */
/* Réservée aux amitiés réciproques : on ne peut pas écrire à un        */
/* inconnu, ce qui écarte l'essentiel du harcèlement. Les échanges      */
/* sont conservés et consultables par un modérateur en cas de           */
/* signalement — sans cela, un canal privé serait sans recours.         */
/* ------------------------------------------------------------------ */

let conversations = {};   // "idA|idB" trié -> { messages, signale }

const cleConv = (a, b) => [a, b].sort().join("|");
const saveConversations = () => sauver("conversations", conversations);

app.get("/api/messages/:id", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const autre = req.params.id;
  if (statutRelation(user.id, autre) !== "ami")
    return res.status(403).json({ error: "PAS_AMI" });

  const conv = conversations[cleConv(user.id, autre)] || { messages: [] };
  
  // Flash : efface les messages de plus de 24h
  const limit = Date.now() - 24 * 60 * 60 * 1000;
  conv.messages = conv.messages.filter(m => m.at > limit);
  
  // on marque comme lus les messages de l'autre
  let change = false;
  for (const m of conv.messages)
    if (m.de === autre && !m.lu) { m.lu = true; change = true; }
  
  saveConversations(); // on sauvegarde toujours pour purger les vieux messages

  res.json({ messages: conv.messages.slice(-100) });
});

app.post("/api/messages/:id", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const autre = req.params.id;
  if (statutRelation(user.id, autre) !== "ami")
    return res.status(403).json({ error: "PAS_AMI" });
  if (estBloque(user.id, autre)) return res.status(403).json({ error: "BLOQUE" });

  const texte = String(req.body.texte || "").trim().slice(0, 500);
  if (!texte) return res.status(400).json({ error: "VIDE" });

  const cle = cleConv(user.id, autre);
  const conv = conversations[cle] || (conversations[cle] = { messages: [], signale: false });
  
  // Flash : nettoyage avant ajout
  const limit = Date.now() - 24 * 60 * 60 * 1000;
  conv.messages = conv.messages.filter(m => m.at > limit);
  
  conv.messages.push({ de: user.id, texte, at: Date.now(), lu: false });
  if (conv.messages.length > 300) conv.messages = conv.messages.slice(-300);
  saveConversations();

  notifier(autre, { type: "message", de: user.pseudo, avatar: user.avatar,
                    photo: user.photo || null, id: user.id, apercu: texte.slice(0, 60) });

  res.json({ ok: true });
});

/** Nombre de messages non lus par expéditeur, et date du dernier message par conversation — cette
 *  seconde information permet au client de faire remonter en haut de la liste d'amis celui qui
 *  vient d'écrire, plutôt que de garder l'ordre figé du jour où l'amitié a été nouée. */
app.get("/api/messages", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const parAmi = {};
  const dernierMessage = {};
  let total = 0;
  const limit = Date.now() - 24 * 60 * 60 * 1000;
  for (const [cle, conv] of Object.entries(conversations)) {
    // Purge au passage
    conv.messages = conv.messages.filter(m => m.at > limit);

    if (!cle.includes(user.id)) continue;
    const autre = cle.split("|").find((x) => x !== user.id);
    const n = conv.messages.filter((m) => m.de === autre && !m.lu).length;
    if (n) { parAmi[autre] = n; total += n; }
    if (conv.messages.length) dernierMessage[autre] = conv.messages[conv.messages.length - 1].at;
  }
  saveConversations();
  res.json({ total, parAmi, dernierMessage });
});

/** Signale une conversation à la modération. */
app.post("/api/messages/:id/signaler", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const conv = conversations[cleConv(user.id, req.params.id)];
  if (!conv) return res.status(404).json({ error: "INTROUVABLE" });

  conv.signale = { par: user.pseudo, parId: user.id,
                   motif: String(req.body.motif || "").slice(0, 200), at: Date.now() };
  saveConversations();
  res.json({ ok: true });
});

/** Conversations signalées, réservées aux modérateurs. */
app.get("/api/admin/conversations", requireModerateur, (_req, res) => {
  const liste = Object.entries(conversations)
    .filter(([, c]) => c.signale)
    .map(([cle, c]) => ({ cle, signale: c.signale, messages: c.messages.slice(-40) }));
  res.json(liste);
});

app.post("/api/admin/conversations/:cle/traiter", requireModerateur, (req, res) => {
  const conv = conversations[req.params.cle];
  if (!conv) return res.status(404).json({ error: "INTROUVABLE" });
  conv.signale = false;
  saveConversations();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Message au développeur : une petite enveloppe accessible à tous les  */
/* joueurs, sans passer par le système d'amis (contrairement aux         */
/* messages classiques ci-dessus). L'administration choisit le compte   */
/* qui doit recevoir ces demandes (par défaut aucun, tant que ce n'est   */
/* pas configuré).                                                      */
/* ------------------------------------------------------------------ */
const CONTACT_DEV_FILE = new URL("./contactDev.json", import.meta.url);
let contactDevConfig = { destinataireId: null, destinatairePseudo: null };
const saveContactDevConfig = () => sauver("contactDevConfig", contactDevConfig, CONTACT_DEV_FILE);

const MESSAGES_DEV_FILE = new URL("./messagesDev.json", import.meta.url);
let messagesDev = [];
const saveMessagesDev = () => sauver("messagesDev", messagesDev, MESSAGES_DEV_FILE);

app.post("/api/contact-developpeur", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const texte = String(req.body?.texte || "").trim().slice(0, 500);
  if (!texte) return res.status(400).json({ error: "VIDE" });
  const msg = {
    id: crypto.randomUUID(), de: user.id, pseudo: user.pseudo,
    avatar: user.avatar, photo: user.photo || null,
    texte, at: Date.now(), lu: false,
  };
  messagesDev.unshift(msg);
  if (messagesDev.length > 500) messagesDev = messagesDev.slice(0, 500);
  saveMessagesDev();
  // Petit signal en direct si le compte destinataire est justement connecté — purement
  // indicatif, la vraie boîte de réception reste la liste ci-dessous côté administration.
  if (contactDevConfig.destinataireId) notifier(contactDevConfig.destinataireId,
    { type: "message_dev", de: user.pseudo, avatar: user.avatar, photo: user.photo || null, apercu: texte.slice(0, 60) });
  res.json({ ok: true });
});

/** Configuration : quel compte reçoit les messages envoyés au développeur. */
app.get("/api/admin/contact-developpeur/config", requireAdmin, (_req, res) => res.json(contactDevConfig));
app.put("/api/admin/contact-developpeur/config", requireAdmin, (req, res) => {
  const id = req.body?.destinataireId ? String(req.body.destinataireId) : null;
  contactDevConfig = { destinataireId: id, destinatairePseudo: id ? (pseudoDe(id) || null) : null };
  saveContactDevConfig();
  res.json({ ok: true, config: contactDevConfig });
});

app.get("/api/admin/contact-developpeur", requireAdmin, (_req, res) => {
  res.json({ messages: messagesDev, nonLus: messagesDev.filter((m) => !m.lu).length });
});
app.put("/api/admin/contact-developpeur/:id/lu", requireAdmin, (req, res) => {
  const m = messagesDev.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "INTROUVABLE" });
  m.lu = Boolean(req.body?.lu ?? true);
  saveMessagesDev();
  res.json({ ok: true });
});
app.delete("/api/admin/contact-developpeur/:id", requireAdmin, (req, res) => {
  messagesDev = messagesDev.filter((x) => x.id !== req.params.id);
  saveMessagesDev();
  res.json({ ok: true });
});


/* ---------- Progression & Map ---------- */
function isBonusLevel(lvl) {
    return lvl === 5 || (lvl > 0 && lvl % 10 === 0);
}
/** Niveaux dont le petit cadeau (parmi les ~30 répartis sur toute la montée) est une pépite en
 * plus plutôt que des tickets — exactement 2, comme demandé, réparties au milieu et au sommet
 * du parcours pour ne pas les regrouper. Calculé sur le plafond réel (modifiable par l'admin). */
function niveauxPepiteBonus() {
    const max = REGLAGES.niveauMax || 300;
    const milieu = Math.max(10, Math.round(max / 2 / 10) * 10);
    return [...new Set([milieu, max])].filter((l) => l > 0 && l <= max && isBonusLevel(l));
}
function getBonusReward(lvl) {
    if (niveauxPepiteBonus().includes(lvl)) {
        // Un petit bonus de tickets/xp accompagne quand même la pépite, pour que le coffre
        // ne semble jamais « vide » comparé aux autres paliers.
        return { type: "pepite", credits: 1, xp: lvl * 10, pepite: true };
    }
    return { type: "credits", credits: 2 + Math.floor(lvl / 10), xp: lvl * 10 };
}

/** Coffres tous les 15 niveaux (15, 30, 45… jusqu'au plafond) : au choix, une pépite en plus,
 * un tour de roue gratuit, ou une demande de code VIP — présentés côté client sous forme de
 * coffre à ouvrir, distincts des petits cadeaux ci-dessus. */
function isChestLevel(lvl) {
    return lvl > 0 && lvl % 15 === 0;
}

app.get("/api/progression", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    const n = infoNiveau(user.id, { base: REGLAGES.xpBase, croissance: REGLAGES.xpCroissance, plafond: REGLAGES.niveauMax })?.niveau || 0;
    const claimed = user.claimedBonuses || [];
    const claimedChests = user.claimedChests || [];

    let nextBonus = null;
    for (let i = n + 1; i <= REGLAGES.niveauMax; i++) {
        if (isBonusLevel(i)) { nextBonus = i; break; }
    }
    let nextChest = null;
    for (let i = n + 1; i <= REGLAGES.niveauMax; i++) {
        if (isChestLevel(i)) { nextChest = i; break; }
    }

    res.json({ currentLevel: n, claimedBonuses: claimed, claimedChests, nextBonus, nextChest, maxLevel: REGLAGES.niveauMax });
});

app.post("/api/progression/claim", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    const lvl = Number(req.body.level);
    const n = infoNiveau(user.id, { base: REGLAGES.xpBase, croissance: REGLAGES.xpCroissance, plafond: REGLAGES.niveauMax })?.niveau || 0;

    if (lvl > n) return res.status(400).json({ error: "NIVEAU_NON_ATTEINT" });
    if (!isBonusLevel(lvl)) return res.status(400).json({ error: "PAS_UN_BONUS" });

    user.claimedBonuses = user.claimedBonuses || [];
    if (user.claimedBonuses.includes(lvl)) return res.status(400).json({ error: "DEJA_RECLAME" });

    user.claimedBonuses.push(lvl);

    const reward = getBonusReward(lvl);
    grantCredits(user.id, reward.credits);
    if (reward.credits) enregistrerTransaction(user.id, reward.credits, "credits", `Bonus du niveau ${lvl}`);
    const nv = ajouterXp(user.id, reward.xp, { base: REGLAGES.xpBase, croissance: REGLAGES.xpCroissance, plafond: REGLAGES.niveauMax });
    if (reward.pepite) accorderPepiteSlotBonus(user.id, 1);

    res.json({ ok: true, reward, credits: getCredits(user.id), niveau: nv,
        pepiteMax: reward.pepite ? maxPepitesPour(user.id) : undefined });
});

/** Réclame un coffre de niveau (tous les 15 niveaux) : le joueur choisit sa récompense. */
app.post("/api/progression/claim-coffre", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    const lvl = Number(req.body.level);
    const choix = String(req.body.choix || "");
    const n = infoNiveau(user.id, { base: REGLAGES.xpBase, croissance: REGLAGES.xpCroissance, plafond: REGLAGES.niveauMax })?.niveau || 0;

    if (lvl > n) return res.status(400).json({ error: "NIVEAU_NON_ATTEINT" });
    if (!isChestLevel(lvl) || lvl > REGLAGES.niveauMax) return res.status(400).json({ error: "PAS_UN_COFFRE" });
    if (!["pepite", "roue", "vip"].includes(choix)) return res.status(400).json({ error: "CHOIX_INVALIDE" });

    const dejaReclames = user.claimedChests || [];
    if (dejaReclames.includes(lvl)) return res.status(400).json({ error: "DEJA_RECLAME" });

    marquerCoffreReclame(user.id, lvl);

    if (choix === "pepite") {
        accorderPepiteSlotBonus(user.id, 1);
        return res.json({ ok: true, choix, pepiteMax: maxPepitesPour(user.id) });
    }
    if (choix === "roue") {
        accorderTourRoueBonus(user.id, 1);
        return res.json({ ok: true, choix, toursRoueBonus: user.toursRoueBonus || 0 });
    }
    // Code VIP : même file d'attente que celle de la roue — l'administrateur valide et envoie le vrai code.
    const demande = {
        id: demandesVip.length ? Math.max(...demandesVip.map((d) => d.id)) + 1 : 1,
        userId: user.id, pseudo: user.pseudo, avatar: user.avatar, photo: user.photo || null,
        date: new Date().toISOString(), statut: "attente", code: null, envoyeLe: null,
        origine: `Coffre du niveau ${lvl}`,
    };
    demandesVip.push(demande);
    saveDemandesVip();
    res.json({ ok: true, choix, enAttente: true });
});


app.post("/api/suggestions", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    const { titre, commentaire } = req.body || {};
    if (!titre || !String(titre).trim()) return res.status(400).json({ error: "TITRE_MANQUANT" });

    // Comme pour le reste des données du jeu, on passe par charger/sauver
    // (db.js) et non par fs.* directement : en production le stockage est
    // Postgres (voir enBase plus bas), pas le disque du conteneur — des
    // écritures fs.* brutes n'y survivent jamais, d'où le bouton qui
    // semblait ne "rien faire" côté joueur.
    try {
        suggestions.push({
            id: crypto.randomUUID(),
            auteurId: user.id,
            auteur: user.pseudo,
            titre: String(titre).trim(),
            commentaire: commentaire ? String(commentaire).trim() : "",
            date: new Date().toISOString(),
            statut: "attente",   // "attente" | "accepte" | "refuse"
            publie: false,       // l'auteur a choisi de la publier dans « Suggestions retenues »
            anonyme: false,
            publieLe: null,
            decline: false,      // l'auteur a explicitement choisi de NE PAS publier : on arrête de lui proposer
        });
        saveSuggestions();
        res.json({ ok: true });
    } catch (err) {
        console.error("Erreur enregistrement suggestion:", err);
        res.status(500).json({ error: "ECRITURE_IMPOSSIBLE" });
    }
});

app.get("/api/admin/suggestions", requireAdmin, (req, res) => {
    res.json(suggestions);
});

/** L'administration accepte ou refuse une suggestion. Si acceptée, l'auteur en est prévenu. */
app.post("/api/admin/suggestions/:id/statut", requireAdmin, (req, res) => {
    const s = suggestions.find((x) => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: "INTROUVABLE" });
    const statut = req.body?.statut;
    if (!["attente", "accepte", "refuse"].includes(statut)) return res.status(400).json({ error: "STATUT_INVALIDE" });
    s.statut = statut;
    saveSuggestions();
    if (statut === "accepte" && s.auteurId) {
        notifier(s.auteurId, { type: "suggestion_acceptee", titre: s.titre, id: s.id });
    }
    res.json({ ok: true });
});

/** Les suggestions du joueur connecté, pour lui proposer le repost s'il a manqué la notif. */
app.get("/api/suggestions/mine", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    res.json(suggestions.filter((s) => s.auteurId === user.id));
});

/** L'auteur choisit de publier (ou non) sa suggestion acceptée, sous son nom ou anonymement. */
app.post("/api/suggestions/:id/publier", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    const s = suggestions.find((x) => x.id === req.params.id && x.auteurId === user.id);
    if (!s) return res.status(404).json({ error: "INTROUVABLE" });
    if (s.statut !== "accepte") return res.status(400).json({ error: "PAS_ACCEPTEE" });
    s.publie = true;
    s.anonyme = Boolean(req.body?.anonyme);
    s.publieLe = new Date().toISOString();
    saveSuggestions();
    res.json({ ok: true });
});

/** L'auteur choisit explicitement de NE PAS publier sa suggestion acceptée — on arrête de le relancer. */
app.post("/api/suggestions/:id/decliner", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    const s = suggestions.find((x) => x.id === req.params.id && x.auteurId === user.id);
    if (!s) return res.status(404).json({ error: "INTROUVABLE" });
    s.decline = true;
    saveSuggestions();
    res.json({ ok: true });
});

/** L'administration corrige le titre/commentaire d'une suggestion (coquille, orthographe...),
 *  y compris une fois publiée dans la vitrine « Suggestions retenues » qui la reflète directement. */
app.put("/api/admin/suggestions/:id", requireAdmin, (req, res) => {
    const s = suggestions.find((x) => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: "INTROUVABLE" });
    const { titre, commentaire } = req.body || {};
    if (titre !== undefined) {
        if (!String(titre).trim()) return res.status(400).json({ error: "TITRE_MANQUANT" });
        s.titre = String(titre).trim();
    }
    if (commentaire !== undefined) s.commentaire = String(commentaire).trim();
    saveSuggestions();
    res.json({ ok: true });
});

/** L'administration retire une suggestion de la vitrine publique (publiée par erreur, par exemple) sans
 *  supprimer la suggestion elle-même : elle reste visible côté admin, statut "acceptée" inchangé. */
app.post("/api/admin/suggestions/:id/depublier", requireAdmin, (req, res) => {
    const s = suggestions.find((x) => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: "INTROUVABLE" });
    s.publie = false;
    s.publieLe = null;
    saveSuggestions();
    res.json({ ok: true });
});

/** L'administration supprime définitivement une suggestion (elle disparaît aussi de la vitrine
 *  publique si elle y était affichée). */
app.delete("/api/admin/suggestions/:id", requireAdmin, (req, res) => {
    const i = suggestions.findIndex((x) => x.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: "INTROUVABLE" });
    suggestions.splice(i, 1);
    saveSuggestions();
    res.json({ ok: true });
});

/** Vitrine publique : les suggestions de joueurs acceptées ET publiées par leur auteur. */
app.get("/api/suggestions/publiees", (req, res) => {
    const liste = suggestions
        .filter((s) => s.statut === "accepte" && s.publie)
        .sort((a, b) => new Date(b.publieLe || 0) - new Date(a.publieLe || 0))
        .map((s) => ({
            id: s.id, titre: s.titre, commentaire: s.commentaire,
            auteur: s.anonyme ? null : s.auteur,
        }));
    res.json(liste);
});

/* ---------- citations de cinéma (gérées depuis l'administration) ---------- */

app.get("/api/citations", (req, res) => {
    res.json(citations);
});

app.post("/api/admin/citations", requireAdmin, (req, res) => {
    const { texte, film, annee, source, anecdote } = req.body || {};
    if (!texte || !String(texte).trim() || !film || !String(film).trim())
        return res.status(400).json({ error: "CHAMPS_MANQUANTS" });
    const id = citations.reduce((max, c) => Math.max(max, c.id || 0), 0) + 1;
    const citation = {
        id,
        texte: String(texte).trim(),
        film: String(film).trim(),
        annee: Number(annee) || null,
        source: source ? String(source).trim() : "",
        anecdote: anecdote ? String(anecdote).trim() : "",
    };
    citations.push(citation);
    saveCitations();
    res.json({ ok: true, citation });
});

app.put("/api/admin/citations/:id", requireAdmin, (req, res) => {
    const citation = citations.find((c) => c.id === Number(req.params.id));
    if (!citation) return res.status(404).json({ error: "INTROUVABLE" });
    const { texte, film, annee, source, anecdote } = req.body || {};
    if (texte !== undefined) citation.texte = String(texte).trim();
    if (film !== undefined) citation.film = String(film).trim();
    if (annee !== undefined) citation.annee = Number(annee) || null;
    if (source !== undefined) citation.source = String(source).trim();
    if (anecdote !== undefined) citation.anecdote = String(anecdote).trim();
    saveCitations();
    res.json({ ok: true, citation });
});

app.delete("/api/admin/citations/:id", requireAdmin, (req, res) => {
    const avant = citations.length;
    citations = citations.filter((c) => c.id !== Number(req.params.id));
    if (citations.length === avant) return res.status(404).json({ error: "INTROUVABLE" });
    saveCitations();
    res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Musique d'ambiance : playlist diffusée en fond pendant les parties, */
/* gérée depuis l'administration (lien externe ou fichier envoyé).     */
/* ------------------------------------------------------------------ */

const MUSIQUE_FILE = new URL("./musique.json", import.meta.url);
let playlisteMusique = [];   // [{id, titre, type: "lien"|"fichier", url, ajouteLe}]
const saveMusique = () => sauver("musique", playlisteMusique, MUSIQUE_FILE);
const MUSIQUE_DIR = join(process.cwd(), "public", "musique");
// Élargi au-delà de mp3/wav : un fichier envoyé depuis un téléphone est très souvent dans un
// format « natif » du partage (WhatsApp envoie du .opus, un iPhone du .m4a/.aac...). Un fichier
// mal reconnu retombait sur l'extension "mp3" par défaut alors que son contenu réel était différent
// — le navigateur reçoit alors un Content-Type qui ne correspond pas aux octets envoyés, et refuse
// de le décoder (lecture totalement silencieuse, y compris en cliquant sur ▶️ manuellement).
const MUSIQUE_EXT_AUTORISEES = ["mp3", "mpeg", "ogg", "oga", "opus", "wav", "m4a", "aac", "flac", "webm"];
// ~8 Mo de fichier réel. Comparer directement à la longueur de la chaîne base64 (comme
// c'était fait avant) rejette à tort des fichiers d'à peine 6 Mo : l'encodage base64 gonfle
// la taille d'environ 1,37×, donc un fichier de 8 Mo produit une chaîne d'environ 11 Mo. On
// décode d'abord, puis on compare la taille réelle du fichier obtenu à cette limite.
const MUSIQUE_MAX_OCTETS = 8 * 1024 * 1024;

/** Le stockage local (voir MUSIQUE_DIR) ne survit pas à un redéploiement sur la plupart des
 *  hébergements (disque « éphémère ») : le fichier lui-même disparaît alors que la playlist,
 *  elle, peut encore le lister — ce qui se voit comme une piste qui « marchait avant et plus
 *  maintenant », de façon aléatoire selon quand a eu lieu le dernier redéploiement. On vérifie
 *  donc systématiquement que le fichier existe réellement avant de proposer une piste envoyée
 *  par fichier — un lien direct (type "lien"), lui, n'est jamais concerné par ce problème. */
function fichierMusiqueExiste(piste) {
    if (piste.type !== "fichier") return true;
    try { return fs.existsSync(join(process.cwd(), "public", piste.url)); }
    catch { return false; }
}

// Vidéos diffusées en direct dans un salon vocal (YouTube, lien web, ou fichier envoyé depuis le
// téléphone) — contrairement à la musique, ce n'est pas une playlist partagée mais un envoi
// ponctuel : voir vocal:video-fichier. Mêmes limites de taille qu'un fichier musical, un peu plus
// larges pour laisser la place à quelques secondes d'image en plus.
const VIDEO_DIR = join(process.cwd(), "public", "videos");
const VIDEO_EXT_AUTORISEES = ["mp4", "webm", "mov", "m4v", "ogg", "ogv"];
const VIDEO_MAX_OCTETS = 160 * 1024 * 1024;

// extraireIdYoutube (reconnaître un lien YouTube et en extraire l'identifiant) vit maintenant
// exclusivement dans vocal-salon.js — seul le salon vocal en avait besoin.

/**
 * Le salon vocal est un module totalement à part (voir vocal-salon.js) : il ne connaît rien du
 * jeu de quiz lui-même. `getReglages`/`getPlaylisteMusique` sont des fonctions plutôt que les
 * valeurs directement, car REGLAGES et playlisteMusique sont parfois entièrement REMPLACÉS
 * ailleurs dans ce fichier (import de réglages, ajout d'une piste) — une simple copie de la
 * valeur, prise une fois ici, deviendrait alors périmée sans que le module vocal ne le sache.
 */
const vocalSalon = creerModuleVocalSalon({
  app, io,
  getReglages: () => REGLAGES,
  getPlaylisteMusique: () => playlisteMusique,
  borneValeur, exigeCompte, requireModerateur, fichierMusiqueExiste, ajouterPisteMusique,
  VIDEO_EXT_AUTORISEES, VIDEO_MAX_OCTETS, VIDEO_DIR,
});

// Avis des joueurs sur chaque piste (pouce vers le haut / vers le bas), remonté dans l'admin.
// Un vote par joueur et par piste : trackId -> { userId: "up" | "down" }. Revoter change ou retire l'avis.
const VOTES_MUSIQUE_FILE = new URL("./votesMusique.json", import.meta.url);
let votesMusique = {};
const saveVotesMusique = () => sauver("votesMusique", votesMusique, VOTES_MUSIQUE_FILE);
function comptageVotes(trackId) {
    const v = votesMusique[trackId] || {};
    let up = 0, down = 0;
    for (const sens of Object.values(v)) sens === "up" ? up++ : down++;
    return { up, down };
}

app.get("/api/musique", (req, res) => {
    const user = userFromCookie(req.headers.cookie);
    // Voir fichierMusiqueExiste : une piste envoyée par fichier dont le fichier a disparu (le plus
    // souvent après un redéploiement, sur un disque non persistant) est retirée de la liste plutôt
    // que proposée puis silencieusement muette au moment de la lecture.
    res.json(playlisteMusique.filter(fichierMusiqueExiste).map(({ id, titre, url }) => ({
        id, titre, url,
        monAvis: user ? (votesMusique[id]?.[user.id] || null) : null,
    })));
});

app.post("/api/musique/:id/vote", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    const piste = playlisteMusique.find((p) => p.id === req.params.id);
    if (!piste) return res.status(404).json({ error: "INTROUVABLE" });
    const sens = req.body?.sens;
    if (!["up", "down"].includes(sens)) return res.status(400).json({ error: "AVIS_INVALIDE" });

    const votes = votesMusique[piste.id] || (votesMusique[piste.id] = {});
    votes[user.id] = votes[user.id] === sens ? undefined : sens;   // revoter pareil = retirer son avis
    if (votes[user.id] === undefined) delete votes[user.id];
    saveVotesMusique();

    res.json({ ok: true, monAvis: votes[user.id] || null, ...comptageVotes(piste.id) });
});

// Pannes de lecture signalées par les joueurs (piste introuvable, format refusé, lien mort...) :
// remonté dans l'admin avec la raison, pour repérer d'un coup d'œil les pistes à réparer ou retirer.
const ERREURS_MUSIQUE_FILE = new URL("./erreursMusique.json", import.meta.url);
let erreursMusique = {};   // trackId -> { count, message, derniereFois }
const saveErreursMusique = () => sauver("erreursMusique", erreursMusique, ERREURS_MUSIQUE_FILE);
const RAISONS_ERREUR_MUSIQUE = {
    reseau: "Erreur réseau (fichier inaccessible)",
    decodage: "Impossible de décoder le fichier (fichier corrompu)",
    format: "Format audio non supporté par le navigateur",
    introuvable: "Lien ou fichier introuvable (404)",
    bloque: "Lecture bloquée par le navigateur",
    inconnue: "Erreur de lecture inconnue",
};

app.post("/api/musique/:id/signaler-erreur", (req, res) => {
    const piste = playlisteMusique.find((p) => p.id === req.params.id);
    if (!piste) return res.status(404).json({ error: "INTROUVABLE" });
    const raison = RAISONS_ERREUR_MUSIQUE[req.body?.raison] ? req.body.raison : "inconnue";

    const e = erreursMusique[piste.id] || (erreursMusique[piste.id] = { count: 0, raison: "inconnue", derniereFois: null });
    e.count += 1;
    e.raison = raison;
    e.derniereFois = new Date().toISOString();
    saveErreursMusique();
    res.json({ ok: true });
});

app.get("/api/admin/musique", requireAdmin, (req, res) => {
    res.json(playlisteMusique.map((p) => {
        const e = erreursMusique[p.id];
        const votes = votesMusique[p.id] || {};
        // Qui a voté quoi, pour l'admin uniquement — jamais exposé côté joueur (voir /api/musique).
        const votants = Object.entries(votes).map(([userId, sens]) => ({
            pseudo: pseudoDe(userId) || "Compte supprimé", sens,
        }));
        return {
            ...p, ...comptageVotes(p.id), votants,
            fichierManquant: !fichierMusiqueExiste(p),
            erreur: e ? { count: e.count, message: RAISONS_ERREUR_MUSIQUE[e.raison] || RAISONS_ERREUR_MUSIQUE.inconnue,
                          derniereFois: e.derniereFois } : null,
        };
    }));
});

/** Cœur commun à l'ajout d'une piste (lien direct ou fichier envoyé, encodé en base64) — utilisé
 *  à la fois par la gestion complète de la playlist en console admin (POST /api/admin/musique,
 *  ci-dessous) et par l'ajout rapide depuis un salon vocal en direct (voir vocal:radio-ajouter),
 *  qui n'exige pas la clé d'administration mais seulement d'être hôte/cohôte de ce salon.
 *  Retourne { piste } ou { error }, jamais les deux — jamais d'accès direct à la réponse HTTP ici,
 *  pour rester utilisable aussi bien depuis une route Express que depuis un gestionnaire Socket.IO. */
function ajouterPisteMusique({ titre, url, fichier, ext }) {
    const nom = String(titre || "").trim().slice(0, 80) || "Sans titre";

    if (fichier) {
        // Un format non reconnu était auparavant renommé de force en ".mp3" (voir le commentaire de
        // MUSIQUE_EXT_AUTORISEES plus haut) : le fichier semblait envoyé avec succès, mais le
        // navigateur recevait ensuite un Content-Type qui ne correspondait pas à son contenu réel et
        // refusait de le lire — silencieusement, ce qui donnait l'impression d'un envoi qui « marche
        // une fois puis plus » de façon aléatoire. On refuse maintenant clairement ce cas, avec un
        // message explicite, plutôt que de mentir sur le format.
        const cleanExt = String(ext || "").toLowerCase();
        if (!MUSIQUE_EXT_AUTORISEES.includes(cleanExt)) return { error: "FORMAT_NON_SUPPORTE" };
        const base64Data = String(fichier).split(";base64,").pop();
        const octets = Buffer.from(base64Data, "base64");
        if (octets.length > MUSIQUE_MAX_OCTETS) return { error: "FICHIER_TROP_LOURD" };
        if (!fs.existsSync(MUSIQUE_DIR)) fs.mkdirSync(MUSIQUE_DIR, { recursive: true });
        const nomFichier = `${crypto.randomUUID()}.${cleanExt}`;
        try {
            fs.writeFileSync(join(MUSIQUE_DIR, nomFichier), octets);
        } catch (e) {
            return { error: "ECRITURE_IMPOSSIBLE" };
        }
        const piste = { id: crypto.randomUUID(), titre: nom, type: "fichier",
            url: `/musique/${nomFichier}`, ajouteLe: new Date().toISOString() };
        playlisteMusique.push(piste);
        saveMusique();
        return { piste };
    }

    const lien = String(url || "").trim();
    if (!/^https?:\/\/\S+$/i.test(lien)) return { error: "LIEN_INVALIDE" };
    const piste = { id: crypto.randomUUID(), titre: nom, type: "lien", url: lien,
        ajouteLe: new Date().toISOString() };
    playlisteMusique.push(piste);
    saveMusique();
    return { piste };
}

app.post("/api/admin/musique", requireAdmin, (req, res) => {
    const resultat = ajouterPisteMusique(req.body || {});
    if (resultat.error) return res.status(400).json({ error: resultat.error });
    res.json({ ok: true, piste: resultat.piste });
});

app.delete("/api/admin/musique/:id", requireAdmin, (req, res) => {
    const piste = playlisteMusique.find((p) => p.id === req.params.id);
    if (!piste) return res.status(404).json({ error: "INTROUVABLE" });
    playlisteMusique = playlisteMusique.filter((p) => p.id !== req.params.id);
    saveMusique();
    if (votesMusique[piste.id]) { delete votesMusique[piste.id]; saveVotesMusique(); }
    if (erreursMusique[piste.id]) { delete erreursMusique[piste.id]; saveErreursMusique(); }
    if (piste.type === "fichier") {
        const chemin = join(process.cwd(), "public", piste.url.replace(/^\//, ""));
        fs.unlink(chemin, () => {}); // silencieux : peu grave si le fichier est déjà absent
    }
    res.json({ ok: true });
});

app.post("/api/admin/musique/:id/deplacer", requireAdmin, (req, res) => {
    const i = playlisteMusique.findIndex((p) => p.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: "INTROUVABLE" });
    const j = req.body?.direction === "haut" ? i - 1 : i + 1;
    if (j < 0 || j >= playlisteMusique.length) return res.json({ ok: true, playlist: playlisteMusique });
    [playlisteMusique[i], playlisteMusique[j]] = [playlisteMusique[j], playlisteMusique[i]];
    saveMusique();
    res.json({ ok: true, playlist: playlisteMusique });
});

/* ------------------------------------------------------------------ */
/* Bouton d'aide « ? » : masqué par défaut. L'administrateur rédige le */
/* message (règles, annonce...) et choisit lui-même quand le publier   */
/* aux joueurs, sans jamais dépendre d'un déploiement de fichiers.     */
/* ------------------------------------------------------------------ */

const AIDE_FILE = new URL("./aide.json", import.meta.url);
let aideConfig = {
    actif: false,
    titre: "Comment jouer ? 🎬🎵",
    message: `Bienvenue ! Testez vos connaissances et défiez vos amis dans nos différents modes de jeu interactifs.

🍿 Mode Ciné Quiz
Prouvez que vous êtes incollable sur le 7ème art.
- Lisez attentivement la question affichée.
- Sélectionnez la bonne proposition avant la fin du chrono.
- Plus vous êtes rapide, plus vous marquez de points !

🚀 L'aventure ne fait que commencer...
MichBen Ciné n'est que la toute première étape. Ce que vous voyez aujourd'hui est le point de départ d'une longue série de mini-jeux, d'expériences interactives et d'univers encore plus poussés qui arriveront très prochainement. Entraînez-vous bien, la suite s'annonce lourde !`,
};
const saveAide = () => sauver("aide", aideConfig, AIDE_FILE);

app.get("/api/aide", (req, res) => {
    res.json(aideConfig.actif
        ? { actif: true, titre: aideConfig.titre, message: aideConfig.message }
        : { actif: false });
});

app.get("/api/admin/aide", requireAdmin, (req, res) => {
    res.json(aideConfig);
});

app.put("/api/admin/aide", requireAdmin, (req, res) => {
    const { actif, titre, message } = req.body || {};
    aideConfig = {
        actif: Boolean(actif),
        titre: String(titre || "").trim().slice(0, 120) || "Comment jouer ? 🎬🎵",
        message: String(message || "").slice(0, 8000),
    };
    saveAide();
    res.json({ ok: true, aide: aideConfig });
});

/* ------------------------------------------------------------------ */
/* Bandeau défilant : annonce développeur (avant une mise à jour, par  */
/* exemple) + petits événements diffusés en direct à tous les joueurs  */
/* connectés (gain à la roue, victoire d'équipe...). Le mode maintenance */
/* bloque juste la création de nouveaux salons, le temps d'un déploiement. */
/* ------------------------------------------------------------------ */

const ANNONCE_FILE = new URL("./annonce.json", import.meta.url);
let annonceConfig = { actif: false, texte: "", maintenance: false };
const saveAnnonce = () => sauver("annonce", annonceConfig, ANNONCE_FILE);

/** Diffuse un message dans le bandeau défilant de tous les joueurs actuellement connectés.
 *  type : "roue" | "equipe" | "partage" | "sondage" | "info" — sert à la couleur affichée côté
 *  client. `extra` peut porter des champs additionnels (ex. photo/pseudo d'un joueur pour rendre
 *  le message cliquable vers sa fiche) qui sont simplement recopiés dans l'événement diffusé. */
function diffuserAnnonce(texte, type = "info", extra = null) {
    io.emit("annonce:nouvelle", { texte, type, date: Date.now(), ...(extra || {}) });
}

app.get("/api/annonce-dev", (req, res) => {
    res.json(annonceConfig.actif ? { actif: true, texte: annonceConfig.texte } : { actif: false });
});

app.get("/api/admin/annonce-dev", requireAdmin, (req, res) => {
    res.json(annonceConfig);
});

app.put("/api/admin/annonce-dev", requireAdmin, (req, res) => {
    const { actif, texte } = req.body || {};
    annonceConfig = {
        ...annonceConfig,
        actif: Boolean(actif),
        texte: String(texte || "").trim().slice(0, 220),
    };
    saveAnnonce();
    io.emit("annonce:dev", { actif: annonceConfig.actif, texte: annonceConfig.texte });
    res.json({ ok: true, annonce: annonceConfig });
});

/** État du mode maintenance + un état des lieux des parties en cours, pour que l'administration
 *  sache en un coup d'œil s'il est prudent de déployer maintenant. */
app.get("/api/admin/maintenance", requireAdmin, (req, res) => {
    const actives = [...rooms.values()].filter((r) => r.status === "playing");
    res.json({
        maintenance: annonceConfig.maintenance,
        partiesEnCours: actives.length,
        partiesEnPause: actives.filter((r) => r.pauseA).length,
    });
});

app.put("/api/admin/maintenance", requireAdmin, (req, res) => {
    annonceConfig = { ...annonceConfig, maintenance: Boolean(req.body?.maintenance) };
    saveAnnonce();
    res.json({ ok: true, maintenance: annonceConfig.maintenance });
});

/** Met en pause (ou reprend) toutes les parties en cours d'un coup — pratique juste avant un
 *  déploiement, plutôt que de compter sur chaque hôte pour le faire de son côté. */
app.post("/api/admin/maintenance/pause-toutes", requireAdmin, (req, res) => {
    let n = 0;
    for (const room of rooms.values())
        if (pauserSalon(room, "l'administrateur (maintenance)")) n++;
    res.json({ ok: true, misesEnPause: n });
});

app.post("/api/admin/maintenance/reprendre-toutes", requireAdmin, (req, res) => {
    let n = 0;
    for (const room of rooms.values())
        if (reprendreSalon(room)) n++;
    res.json({ ok: true, reprises: n });
});

/* ------------------------------------------------------------------ */
/* Porte-monnaie : historique horodaté des transactions (tickets et    */
/* points), avec la provenance de chaque mouvement.                    */
/* ------------------------------------------------------------------ */

const WALLET_FILE = new URL("./wallet.json", import.meta.url);
let walletHistorique = {};   // userId -> [{date, montant, devise, motif}], le plus récent en dernier
const saveWallet = () => sauver("wallet", walletHistorique, WALLET_FILE);

/** Ajoute une ligne au porte-monnaie d'un joueur. montant > 0 = crédit, < 0 = débit. */
function enregistrerTransaction(userId, montant, devise, motif) {
  if (!userId || !montant) return;
  const liste = walletHistorique[userId] || (walletHistorique[userId] = []);
  liste.push({ date: new Date().toISOString(), montant, devise, motif });
  if (liste.length > 80) liste.splice(0, liste.length - 80);
  saveWallet();
}

app.get("/api/wallet/historique", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const transactions = (walletHistorique[user.id] || []).slice(-40).reverse();
  res.json({ transactions, credits: getCredits(user.id), points: getPoints(user.id) });
});

/* ---------- publicités "roue" : regarder une pub pour gagner un tour gratuit ---------- */
// Gérées depuis la console admin, comme la playlist musicale : image, vidéo (fichier direct ou
// lien YouTube), ou lien direct (type "lien" — le format compatible avec les régies publicitaires
// du type Adsterra « Direct Link » : une simple URL, ouverte dans un nouvel onglet, sans aperçu
// intégré), un lien cible optionnel (le sponsor), et une durée minimale de visionnage avant que
// le joueur puisse récupérer son tour gratuit.

const PUBLICITES_TYPES = ["image", "video", "lien"];
const PUBLICITES_FILE = new URL("./publicites.json", import.meta.url);
let publicites = [];   // [{id, titre, type: "image"|"video"|"lien", url, cible, duree, actif, ajouteLe}]
const savePublicites = () => sauver("publicites", publicites, PUBLICITES_FILE);

/** Une publicité active tirée au hasard, présentée au joueur qui préfère regarder une pub
 *  plutôt que de payer pour un tour de roue supplémentaire. */
app.get("/api/publicites/une", (req, res) => {
    const actives = publicites.filter((p) => p.actif !== false);
    if (!actives.length) return res.json({ publicite: null });
    const p = actives[Math.floor(Math.random() * actives.length)];
    res.json({ publicite: { id: p.id, titre: p.titre, type: p.type, url: p.url, cible: p.cible || null, duree: p.duree || 15 } });
});

app.get("/api/admin/publicites", requireAdmin, (req, res) => res.json(publicites));

// Certaines régies (dont Adsterra, hors format « Direct Link ») fournissent un extrait
// <script src="...tag.min.js">...</script> à coller directement dans le code d'une page —
// pas une adresse de page à ouvrir. Si on ouvre ce genre de lien tel quel dans un nouvel
// onglet, le navigateur affiche le code source du script au lieu d'une publicité. On détecte
// ce cas pour le type « lien » et on prévient l'administrateur plutôt que de le laisser
// enregistrer un lien qui ne fonctionnera jamais.
const ressembleAUnScript = (lien) => /\.(js|mjs)(\?.*)?$/i.test(lien);

app.post("/api/admin/publicites", requireAdmin, (req, res) => {
    const { titre, type, url, cible, duree } = req.body || {};
    const nom = String(titre || "").trim().slice(0, 80) || "Sans titre";
    const t = PUBLICITES_TYPES.includes(type) ? type : "image";
    const lien = String(url || "").trim();
    if (!/^https?:\/\/\S+$/i.test(lien)) return res.status(400).json({ error: "LIEN_INVALIDE" });
    if (t === "lien" && ressembleAUnScript(lien)) return res.status(400).json({ error: "LIEN_SCRIPT_DETECTE" });
    const pub = {
        id: crypto.randomUUID(), titre: nom, type: t, url: lien,
        cible: cible ? String(cible).trim().slice(0, 300) : "",
        duree: Math.min(60, Math.max(5, Number(duree) || 15)),
        actif: true, ajouteLe: new Date().toISOString(),
    };
    publicites.push(pub);
    savePublicites();
    res.json({ ok: true, publicite: pub });
});

app.put("/api/admin/publicites/:id", requireAdmin, (req, res) => {
    const p = publicites.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: "INTROUVABLE" });
    const { titre, type, url, cible, duree, actif } = req.body || {};
    if (titre !== undefined) p.titre = String(titre).trim().slice(0, 80) || p.titre;
    if (PUBLICITES_TYPES.includes(type)) p.type = type;
    if (url !== undefined) {
        const lien = String(url).trim();
        if (!/^https?:\/\/\S+$/i.test(lien)) return res.status(400).json({ error: "LIEN_INVALIDE" });
        const typeFinal = PUBLICITES_TYPES.includes(type) ? type : p.type;
        if (typeFinal === "lien" && ressembleAUnScript(lien)) return res.status(400).json({ error: "LIEN_SCRIPT_DETECTE" });
        p.url = lien;
    }
    if (cible !== undefined) p.cible = String(cible).trim().slice(0, 300);
    if (duree !== undefined) p.duree = Math.min(60, Math.max(5, Number(duree) || p.duree));
    if (actif !== undefined) p.actif = Boolean(actif);
    savePublicites();
    res.json({ ok: true, publicite: p });
});

app.delete("/api/admin/publicites/:id", requireAdmin, (req, res) => {
    const p = publicites.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: "INTROUVABLE" });
    publicites = publicites.filter((x) => x.id !== req.params.id);
    savePublicites();
    res.json({ ok: true });
});

/* ---------- roue quotidienne ---------- */

const COUT_TOUR_ROUE = 100;

/** La dernière demande de code VIP d'un joueur (attente ou déjà envoyée), la plus récente en premier. */
function demandeVipDuJoueur(userId) {
  const mine = demandesVip.filter((d) => d.userId === userId);
  return mine.length ? mine[mine.length - 1] : null;
}

app.get("/api/roue", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    assurerRoueDuJour();
    const demande = demandeVipDuJoueur(user.id);
    res.json({
        jour: roue.jour,
        lotsRestants: roue.lots.length,
        catalogue: catalogueRoue(roue.lots),
        gratuitDisponible: roueGratuiteDisponible(user.id, roue.jour),
        tirPayantDisponible: roueTirPayantDisponible(user.id, roue.jour),
        tirsPayantsMax: ROUE_MAX_TIRS_PAYANTS,
        tirPubDisponible: roueTirPubDisponible(user.id, REGLAGES.pubHeureRecharge, REGLAGES.pubMaxParCycle),
        tirsPubMax: REGLAGES.pubMaxParCycle,
        tirsPubUtilises: roueTirsPubCycle(user.id, REGLAGES.pubHeureRecharge),
        // Prochaine recharge du quota de pubs (cycle fixe de 12h ancré sur pubHeureRecharge,
        // 18h par défaut, donc aussi 6h) — le client s'en sert pour un compte à rebours.
        prochaineRechargePub: new Date(roueProchaineRechargePub(REGLAGES.pubHeureRecharge)).toISOString(),
        coutTour: COUT_TOUR_ROUE,
        credits: getCredits(user.id),
        derniersTirages: roue.historique.slice(-8).reverse(),
        gainEnAttente: gainsEnAttente[user.id] || null,
        demandeVip: demande ? { statut: demande.statut, code: demande.statut === "envoye" ? demande.code : null } : null,
    });
});

app.post("/api/roue/tourner", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    assurerRoueDuJour();

    if (gainsEnAttente[user.id]) return res.status(409).json({ error: "GAIN_EN_ATTENTE" });

    const gratuitJournalier = roueGratuiteDisponible(user.id, roue.jour);
    // Un tour bonus gagné via un coffre de niveau (voir /api/progression/claim-coffre) compte
    // aussi comme gratuit, mais seulement une fois le tour gratuit du jour déjà utilisé.
    const gratuitBonus = !gratuitJournalier && tourRoueBonusDisponible(user.id);
    const gratuit = gratuitJournalier || gratuitBonus;
    // Une fois le tour gratuit du jour consommé, le joueur choisit : payer en tickets, ou
    // regarder une publicité (gérée depuis la console admin) pour un tour gratuit à la place.
    const viaPub = !gratuit && req.body?.via === "pub";
    if (!gratuit && !viaPub) {
        if (!roueTirPayantDisponible(user.id, roue.jour))
            return res.status(429).json({ error: "LIMITE_TIRS_PAYANTS", max: ROUE_MAX_TIRS_PAYANTS });
        const ok = spendCredits(user.id, COUT_TOUR_ROUE);
        if (!ok) return res.status(400).json({ error: "CREDITS_INSUFFISANTS" });
        enregistrerTransaction(user.id, -COUT_TOUR_ROUE, "credits", "Tour de roue");
    } else if (viaPub) {
        if (!roueTirPubDisponible(user.id, REGLAGES.pubHeureRecharge, REGLAGES.pubMaxParCycle))
            return res.status(429).json({ error: "LIMITE_TIRS_PUB", max: REGLAGES.pubMaxParCycle,
                jusqua: new Date(roueProchaineRechargePub(REGLAGES.pubHeureRecharge)).toISOString() });
    }

    if (roue.lots.length === 0) {
        // Filet de sécurité : assurerRoueDuJour() vient tout juste de réapprovisionner,
        // ce cas ne devrait jamais se produire — on rembourse par précaution (seulement si
        // des tickets ont réellement été dépensés : ni le tour gratuit, ni le tour "pub" n'en coûtent).
        if (!gratuit && !viaPub) {
            grantCredits(user.id, COUT_TOUR_ROUE);
            enregistrerTransaction(user.id, COUT_TOUR_ROUE, "credits", "Remboursement — roue vide");
        }
        return res.status(409).json({ error: "ROUE_VIDE" });
    }

    const index = Math.floor(Math.random() * roue.lots.length);
    const [lot] = roue.lots.splice(index, 1);

    const resultat = { type: lot.type, label: lot.label };
    if (lot.type === "credits" || lot.type === "ranked") resultat.valeur = lot.valeur;

    // Le gain n'est pas crédité tout de suite : le joueur doit le réclamer via un bouton.
    gainsEnAttente[user.id] = { ...resultat, gratuit, viaPub, date: new Date().toISOString() };
    saveGainsRoue();

    if (gratuitJournalier) marquerRoueGratuiteUtilisee(user.id, roue.jour);
    else if (gratuitBonus) consommerTourRoueBonus(user.id);
    else if (viaPub) marquerTirPubRoueUtilise(user.id, REGLAGES.pubHeureRecharge);
    else marquerTirPayantRoueUtilise(user.id, roue.jour);
    saveRoue();

    // Le stock vient peut-être de s'épuiser : on prépare déjà la suite pour le joueur suivant.
    assurerRoueDuJour();

    res.json({
        ok: true, gratuit, resultat,
        credits: getCredits(user.id),
        lotsRestants: roue.lots.length,
    });
});

app.post("/api/roue/reclamer", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;

    const gain = gainsEnAttente[user.id];
    if (!gain) return res.status(400).json({ error: "AUCUN_GAIN" });

    delete gainsEnAttente[user.id];
    saveGainsRoue();

    roue.historique.push({ pseudo: user.pseudo, lot: gain.label, gratuit: gain.gratuit, date: new Date().toISOString() });
    if (roue.historique.length > 200) roue.historique = roue.historique.slice(-200);
    saveRoue();

    if (gain.type === "credits") {
        grantCredits(user.id, gain.valeur);
        enregistrerTransaction(user.id, gain.valeur, "credits", gain.gratuit ? "Roue du jour (tour gratuit)" : "Roue du jour");
        // Seuls les gros gains passent dans le bandeau de tout le monde — les petits tickets à
        // chaque tour rendraient le défilé bien trop bavard.
        if (gain.valeur >= 100) diffuserAnnonce(`🎉 ${user.pseudo} vient de gagner ${gain.valeur} tickets à la roue !`, "roue");
        return res.json({ ok: true, type: "credits", valeur: gain.valeur, credits: getCredits(user.id) });
    }

    if (gain.type === "ranked") {
        accorderPartiesClasseesBonus(user.id, gain.valeur);
        diffuserAnnonce(`🎉 ${user.pseudo} vient de gagner ${gain.valeur} partie${gain.valeur > 1 ? "s" : ""} classée${gain.valeur > 1 ? "s" : ""} bonus à la roue !`, "roue");
        return res.json({ ok: true, type: "ranked", valeur: gain.valeur, partiesRestantes: partiesRestantes(user.id) });
    }

    // Code VIP : pas de génération automatique — une demande part vers l'administrateur.
    diffuserAnnonce(`👑 ${user.pseudo} a décroché un Code VIP à la roue !`, "roue");
    const demande = {
        id: demandesVip.length ? Math.max(...demandesVip.map((d) => d.id)) + 1 : 1,
        userId: user.id, pseudo: user.pseudo, avatar: user.avatar, photo: user.photo || null,
        date: new Date().toISOString(), statut: "attente", code: null, envoyeLe: null,
    };
    demandesVip.push(demande);
    saveDemandesVip();
    res.json({ ok: true, type: "vip", enAttente: true });
});

app.get("/api/admin/roue", requireAdmin, (req, res) => {
    assurerRoueDuJour();
    res.json({
        jour: roue.jour,
        lots: roue.lots,
        catalogue: catalogueRoue(roue.lots),
        historique: roue.historique.slice(-50).reverse(),
    });
});

app.post("/api/admin/roue/reapprovisionner", requireAdmin, (req, res) => {
    roue = { jour: journeeRoue(), lots: melangerLots(stockRoueDefaut()), historique: roue?.historique || [] };
    saveRoue();
    res.json({ ok: true, lotsRestants: roue.lots.length });
});

/** Ajoute manuellement un ou plusieurs exemplaires d'un lot à la roue du jour, sans toucher au
 *  reste du stock — pour compléter (ou corriger) le tirage automatique aléatoire au lieu de tout
 *  réinitialiser. Les trois types possibles restent ceux que /api/roue/reclamer sait distribuer. */
app.post("/api/admin/roue/ajouter", requireAdmin, (req, res) => {
    assurerRoueDuJour();
    const type = String(req.body?.type || "");
    if (!["vip", "credits", "ranked"].includes(type)) return res.status(400).json({ error: "TYPE_INVALIDE" });

    let valeur = null;
    if (type === "credits" || type === "ranked") {
        valeur = Math.round(Number(req.body?.valeur));
        if (!Number.isFinite(valeur) || valeur <= 0) return res.status(400).json({ error: "VALEUR_INVALIDE" });
    }

    const quantite = Math.max(1, Math.min(200, Math.round(Number(req.body?.quantite)) || 1));

    let label = String(req.body?.label || "").trim().slice(0, 80);
    if (!label) {
        label = type === "vip" ? "Code VIP — parrainage offert"
              : type === "credits" ? `${valeur} tickets`
              : `${valeur} partie${valeur > 1 ? "s" : ""} classée${valeur > 1 ? "s" : ""} bonus`;
    }

    let prochainId = roue.lots.reduce((max, l) => Math.max(max, Number(l.id) || 0), 0);
    const ajoutes = [];
    for (let i = 0; i < quantite; i++) {
        const lot = { id: ++prochainId, type, label, valeur };
        roue.lots.push(lot);
        ajoutes.push(lot);
    }
    roue.lots = melangerLots(roue.lots);
    saveRoue();

    res.json({ ok: true, ajoutes: ajoutes.length, lotsRestants: roue.lots.length, catalogue: catalogueRoue(roue.lots) });
});

/** Retire manuellement jusqu'à N exemplaires d'un lot précis (même type + même valeur) — pour
 *  corriger le stock sans devoir tout réapprovisionner. */
app.post("/api/admin/roue/retirer", requireAdmin, (req, res) => {
    assurerRoueDuJour();
    const type = String(req.body?.type || "");
    const valeur = req.body?.valeur === null || req.body?.valeur === undefined || req.body?.valeur === ""
        ? null : Math.round(Number(req.body.valeur));
    const quantite = Math.max(1, Math.min(200, Math.round(Number(req.body?.quantite)) || 1));

    let retires = 0;
    for (let i = roue.lots.length - 1; i >= 0 && retires < quantite; i--) {
        const l = roue.lots[i];
        if (l.type === type && (l.valeur || null) === valeur) { roue.lots.splice(i, 1); retires++; }
    }
    saveRoue();

    res.json({ ok: true, retires, lotsRestants: roue.lots.length, catalogue: catalogueRoue(roue.lots) });
});

app.get("/api/admin/roue/vip", requireAdmin, (req, res) => {
    res.json({ demandes: [...demandesVip].reverse().slice(0, 100) });
});

app.post("/api/admin/roue/vip/:id/envoyer", requireAdmin, (req, res) => {
    const demande = demandesVip.find((d) => d.id === Number(req.params.id));
    if (!demande) return res.status(404).json({ error: "INTROUVABLE" });
    if (demande.statut === "envoye") return res.json({ ok: true, dejaEnvoye: true, code: demande.code });

    demande.code = genererCodeParrainGagne(demande.userId);
    demande.statut = "envoye";
    demande.envoyeLe = new Date().toISOString();
    saveDemandesVip();

    notifier(demande.userId, { type: "vip_code", de: "L'administrateur", avatar: "👑", code: demande.code });
    res.json({ ok: true, code: demande.code });
});

/* ---------- amis ---------- */

/**
 * Prévient un joueur connecté, sur tous ses onglets ouverts.
 * Silencieux s'il est hors ligne : il verra la pastille à sa prochaine visite.
 */
function notifier(userId, charge) {
  for (const [, socket] of io.of("/").sockets)
    if (socket.data.user?.id === userId) socket.emit("notif", charge);
}

app.get("/api/friends", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const data = relations(user.id);
  // Indique quels amis sont en train de jouer, pour proposer de les regarder en direct.
  if (Array.isArray(data.amis)) {
    data.amis = data.amis.map((a) => ({ ...a, ...joueurEnPartie(a.id) }));
  }
  res.json(data);
});

app.get("/api/players/search", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const trouves = chercherJoueurs(req.query.q, user.id)
    .map((j) => {
      const relation = statutRelation(user.id, j.id);
      // Ne proposer « regarder en direct » que pour un ami réellement en partie,
      // ici aussi (et pas seulement depuis l'onglet Amis) : sinon le bouton
      // n'apparaît jamais si on retrouve son ami via la recherche.
      if (relation !== "ami") return { ...j, relation };
      return { ...j, relation, ...joueurEnPartie(j.id) };
    });
  res.json(trouves);
});

app.get("/api/players/:id/fiche", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const fiche = fichePublique(req.params.id, user.id);
  if (!fiche) return res.status(404).json({ error: "INTROUVABLE" });
  // Ne proposer « regarder en direct » qu'entre amis, et seulement si une partie est en cours.
  if (fiche.relation === "ami") {
    Object.assign(fiche, joueurEnPartie(fiche.id));
  }
  // Progression dans le niveau actuel (reste/requis), pour afficher une vraie barre dans la
  // fiche de profil — fichePublique() ne renvoie que le niveau brut, sans ce détail.
  const progression = infoNiveau(fiche.id, reglagesNiveau());
  if (progression) { fiche.reste = progression.reste; fiche.requis = progression.requis; }
  // Les pépites sont volontairement publiques (comme le reste de la fiche) : chacun peut
  // voir le « top 5 » d'un autre joueur, exactement comme demandé.
  fiche.pepites = filmsDepuisIds(pepites[fiche.id] || []).reverse();
  res.json(fiche);
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

  const cible = String(req.body.id || "");
  const resultat = action(user.id, cible);
  if (resultat?.error) return res.status(400).json(resultat);

  // l'autre joueur est prévenu immédiatement s'il est connecté
  if (req.params.action === "demander")
    notifier(cible, { type: "demande", de: user.pseudo, avatar: user.avatar, photo: user.photo || null });
  if (req.params.action === "accepter")
    notifier(cible, { type: "acceptee", de: user.pseudo, avatar: user.avatar, photo: user.photo || null });

  res.json({ ...resultat, relation: statutRelation(user.id, cible) });
});

/* ------------------------------------------------------------------ */
/* Quêtes                                                              */
/*                                                                     */
/* Deux familles : les quêtes du jour (simples, renouvelées chaque     */
/* minuit — une raison de revenir sans exiger de longues sessions) et  */
/* les quêtes globales (des défis plus ambitieux, jamais réinitialisés,*/
/* qui ne se réclament qu'une fois) dont la récompense inclut toujours */
/* une « surprise » tirée au sort parmi le même vocabulaire de gains   */
/* que la roue du jour et les coffres de niveau — tickets, xp, pépite, */
/* partie classée bonus ou tour de roue bonus.                        */
/* ------------------------------------------------------------------ */

const QUETES = {
  jouer3:      { titre: "Jouer 3 parties",              cible: 3,  tickets: 3, xp: 60 },
  bonnes10:    { titre: "Trouver 10 films",             cible: 10, tickets: 4, xp: 80 },
  sansIndice:  { titre: "Gagner 3 questions sans indice", cible: 3,  tickets: 5, xp: 100 },
  sansFaute:   { titre: "Terminer une partie sans faute", cible: 1, tickets: 6, xp: 120 },
};

// Défis de fond, valables tant qu'ils ne sont pas réclamés (aucune remise à zéro quotidienne).
// `compteur` indique la clé de progression à incrémenter : plusieurs quêtes peuvent partager le
// même compteur (ex. jouer50/jouer200 comptent toutes deux les parties jouées, tous modes confondus)
// pour offrir des paliers successifs sans dupliquer le suivi de progression.
const QUETES_GLOBALES = {
  jouer50:  { titre: "Jouer 50 parties, tous modes confondus", compteur: "jouerParties", cible: 50, tickets: 40, xp: 400 },
  jouer200: { titre: "Jouer 200 parties, tous modes confondus", compteur: "jouerParties", cible: 200, tickets: 150, xp: 1200 },
  sansFauteGlobal:    { titre: "Terminer 10 parties sans perdre le moindre cœur", compteur: "sansFauteGlobal", cible: 10, tickets: 80, xp: 600 },
  battreHardcoreDuel: { titre: "Battre un adversaire IA de niveau Hardcore en duel", compteur: "battreHardcoreDuel", cible: 1, tickets: 60, xp: 500 },
};

let progression = {};        // userId -> { jour, compteurs, reclamees }  (quêtes du jour)
let progressionGlobale = {}; // userId -> { compteurs, reclamees }        (quêtes globales, sans remise à zéro)
const saveProgression = () => sauver("quetes", progression);
const saveProgressionGlobale = () => sauver("quetesGlobales", progressionGlobale);
const jourCourant = () => new Date().toISOString().slice(0, 10);

function quetesDu(userId) {
  const p = progression[userId];
  if (!p || p.jour !== jourCourant())
    progression[userId] = { jour: jourCourant(), compteurs: {}, reclamees: [] };
  return progression[userId];
}

function quetesGlobalesDe(userId) {
  if (!progressionGlobale[userId]) progressionGlobale[userId] = { compteurs: {}, reclamees: [] };
  return progressionGlobale[userId];
}

function avancerQuete(userId, cle, pas = 1) {
  const p = quetesDu(userId);
  p.compteurs[cle] = (p.compteurs[cle] || 0) + pas;
  saveProgression();
}

/** Fait avancer un compteur de quête globale (voir le champ `compteur` de QUETES_GLOBALES). */
function avancerQueteGlobale(userId, compteur, pas = 1) {
  const p = quetesGlobalesDe(userId);
  p.compteurs[compteur] = (p.compteurs[compteur] || 0) + pas;
  saveProgressionGlobale();
}

const etatQuetes = (userId) => {
  const pj = quetesDu(userId);
  const pg = quetesGlobalesDe(userId);
  const jour = Object.entries(QUETES).map(([cle, q]) => ({
    cle, type: "jour", ...q,
    avancement: Math.min(pj.compteurs[cle] || 0, q.cible),
    accomplie: (pj.compteurs[cle] || 0) >= q.cible,
    reclamee: pj.reclamees.includes(cle),
  }));
  const globales = Object.entries(QUETES_GLOBALES).map(([cle, q]) => {
    const n = pg.compteurs[q.compteur || cle] || 0;
    return {
      cle, type: "globale", ...q,
      avancement: Math.min(n, q.cible),
      accomplie: n >= q.cible,
      reclamee: pg.reclamees.includes(cle),
    };
  });
  return [...jour, ...globales];
};

/**
 * Surprise tirée au sort à la réclamation d'une quête globale (jamais pour les quêtes du jour,
 * qui restent prévisibles). Même vocabulaire de récompense que la roue du jour et les coffres de
 * niveau : rien de nouveau à administrer, juste un tirage pondéré parmi des gains déjà éprouvés.
 */
const SURPRISES_QUETES = [
  { type: "credits", poids: 40, min: 150, max: 500 },
  { type: "xp",      poids: 25, min: 150, max: 450 },
  { type: "pepite",  poids: 15 },
  { type: "ranked",  poids: 10 },
  { type: "roue",    poids: 10 },
];

function tirerSurpriseQuete() {
  const total = SURPRISES_QUETES.reduce((s, l) => s + l.poids, 0);
  let r = Math.random() * total;
  for (const lot of SURPRISES_QUETES) {
    r -= lot.poids;
    if (r <= 0) return lot;
  }
  return SURPRISES_QUETES[0];
}

/** Applique une surprise de quête globale et renvoie un résumé (type, montant, libellé) pour le client. */
function appliquerSurpriseQuete(userId) {
  const lot = tirerSurpriseQuete();
  if (lot.type === "credits") {
    const montant = Math.round(lot.min + Math.random() * (lot.max - lot.min));
    grantCredits(userId, montant);
    enregistrerTransaction(userId, montant, "credits", "Surprise de quête");
    return { type: "credits", montant, libelle: `🎟️ ${montant} tickets bonus` };
  }
  if (lot.type === "xp") {
    const montant = Math.round(lot.min + Math.random() * (lot.max - lot.min));
    ajouterXp(userId, montant, reglagesNiveau());
    return { type: "xp", montant, libelle: `⚡ ${montant} xp bonus` };
  }
  if (lot.type === "pepite") {
    accorderPepiteSlotBonus(userId, 1);
    return { type: "pepite", libelle: "💎 Un emplacement pépite supplémentaire" };
  }
  if (lot.type === "ranked") {
    accorderPartiesClasseesBonus(userId, 1);
    return { type: "ranked", libelle: "🏆 Une partie classée bonus" };
  }
  accorderTourRoueBonus(userId, 1);
  return { type: "roue", libelle: "🎡 Un tour de roue bonus" };
}

app.get("/api/quetes", (req, res) => {
  const user = exigeCompte(req, res);
  if (user) res.json({ quetes: etatQuetes(user.id), niveau: niveauJoueur(user.id) });
});

app.post("/api/quetes/:cle/reclamer", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const cle = req.params.cle;
  const quete = QUETES[cle] || QUETES_GLOBALES[cle];
  if (!quete) return res.status(404).json({ error: "INCONNUE" });
  const estGlobale = Boolean(QUETES_GLOBALES[cle]);

  const p = estGlobale ? quetesGlobalesDe(user.id) : quetesDu(user.id);
  const n = estGlobale ? (p.compteurs[quete.compteur || cle] || 0) : (p.compteurs[cle] || 0);
  if (p.reclamees.includes(cle)) return res.status(400).json({ error: "DEJA_RECLAMEE" });
  if (n < quete.cible) return res.status(400).json({ error: "PAS_ACCOMPLIE" });

  p.reclamees.push(cle);
  estGlobale ? saveProgressionGlobale() : saveProgression();
  grantCredits(user.id, quete.tickets);
  if (quete.tickets) enregistrerTransaction(user.id, quete.tickets, "credits", `Quête « ${quete.titre} »`);
  const niveau = ajouterXp(user.id, quete.xp, reglagesNiveau());
  const surprise = estGlobale ? appliquerSurpriseQuete(user.id) : null;

  res.json({ ok: true, tickets: quete.tickets, xp: quete.xp, surprise,
             credits: getCredits(user.id), niveau });
});

const reglagesNiveau = () => ({
  base: REGLAGES.xpBase, croissance: REGLAGES.xpCroissance, plafond: REGLAGES.niveauMax,
});

const niveauJoueur = (userId) => infoNiveau(userId, reglagesNiveau());

/* ---------- parrainage ---------- */

app.get("/api/parrainage", (req, res) => {
  const user = exigeCompte(req, res);
  if (user) res.json({ ...infoParrainage(user.id), obligatoire: parrainageObligatoire() });
});

app.post("/api/parrainage/verifier", (req, res) => {
  const r = verifierCode(req.body.code);
  r.error ? res.status(404).json(r) : res.json(r);
});

app.post("/api/parrainage/rejoindre", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  const r = rattacherParrain(user.id, req.body.code);
  r.error ? res.status(400).json(r) : res.json({ ...r, ...infoParrainage(user.id) });
});

// Le joueur qui consulte la présence ne doit pas se compter lui-même : sinon le total affiché
// ne correspond jamais à la liste des AUTRES joueurs en ligne qu'il voit à l'écran.
// « En ligne » ne montre jamais des inconnus : uniquement les AMIS du joueur qui consulte.
// Utile pour la vie privée de tous, et indispensable pour un compte enfant, qui ne doit
// croiser ni être croisé par des joueurs qu'il n'a pas ajoutés lui-même.
app.get("/api/presence", (req, res) => {
  const user = userFromCookie(req.headers.cookie);
  if (!user) return res.json({ enLigne: 0 });
  const amis = relations(user.id)?.amis || [];
  res.json({ enLigne: amis.filter((a) => a.online).length });
});
app.get("/api/presence/users", (req, res) => {
  const user = userFromCookie(req.headers.cookie);
  if (!user) return res.json([]);
  const amis = relations(user.id)?.amis || [];
  res.json(amis.filter((a) => a.online).map(({ id, pseudo, avatar, photo, role }) => ({ id, pseudo, avatar, photo, role })));
});


const SORTIES_FILE = new URL("./sorties.json", import.meta.url);
// kidsOk : films explicitement approuvés par l'administration pour les comptes enfant.
// Liste blanche volontairement vide par défaut — un film non approuvé n'est jamais montré
// à un compte enfant, même s'il est visible pour les comptes adultes.
let sortiesConfig = { hidden: [], custom: [], kidsOk: [] };
const saveSortiesConfig = () => sauver("sortiesConfig", sortiesConfig, SORTIES_FILE);

const NOWPLAYING_FILE = new URL("./nowplaying.json", import.meta.url);
let nowPlayingConfig = { hidden: [], custom: [], kidsOk: [] };
const saveNowPlayingConfig = () => sauver("nowPlayingConfig", nowPlayingConfig, NOWPLAYING_FILE);

app.post("/api/admin/sorties/hide", requireAdmin, (req, res) => {
    const id = Number(req.body.id);
    if (id && !sortiesConfig.hidden.includes(id)) {
        sortiesConfig.hidden.push(id);
        saveSortiesConfig();
    }
    res.json({ ok: true });
});

app.post("/api/admin/sorties/unhide", requireAdmin, (req, res) => {
    const id = Number(req.body.id);
    sortiesConfig.hidden = sortiesConfig.hidden.filter(x => x !== id);
    saveSortiesConfig();
    res.json({ ok: true });
});

app.post("/api/admin/sorties/custom", requireAdmin, (req, res) => {
    const id = Number(req.body.id);
    if (id && !sortiesConfig.custom.includes(id)) {
        sortiesConfig.custom.push(id);
        saveSortiesConfig();
    }
    res.json({ ok: true });
});

app.post("/api/admin/sorties/remove-custom", requireAdmin, (req, res) => {
    const id = Number(req.body.id);
    sortiesConfig.custom = sortiesConfig.custom.filter(x => x !== id);
    saveSortiesConfig();
    res.json({ ok: true });
});

/** Approuve ou retire un film de la liste blanche « adapté aux enfants » des sorties ciné. */
app.post("/api/admin/sorties/kids-toggle", requireAdmin, (req, res) => {
    const id = Number(req.body.id);
    if (!id) return res.status(400).json({ error: "ID_MANQUANT" });
    sortiesConfig.kidsOk = sortiesConfig.kidsOk || [];
    sortiesConfig.kidsOk = sortiesConfig.kidsOk.includes(id)
        ? sortiesConfig.kidsOk.filter(x => x !== id)
        : [...sortiesConfig.kidsOk, id];
    saveSortiesConfig();
    res.json({ ok: true, kidsOk: sortiesConfig.kidsOk.includes(id) });
});

app.post("/api/admin/nowplaying/hide", requireAdmin, (req, res) => {
    const id = Number(req.body.id);
    if (id && !nowPlayingConfig.hidden.includes(id)) {
        nowPlayingConfig.hidden.push(id);
        saveNowPlayingConfig();
    }
    res.json({ ok: true });
});

app.post("/api/admin/nowplaying/unhide", requireAdmin, (req, res) => {
    const id = Number(req.body.id);
    nowPlayingConfig.hidden = nowPlayingConfig.hidden.filter(x => x !== id);
    saveNowPlayingConfig();
    res.json({ ok: true });
});

app.post("/api/admin/nowplaying/custom", requireAdmin, (req, res) => {
    const id = Number(req.body.id);
    if (id && !nowPlayingConfig.custom.includes(id)) {
        nowPlayingConfig.custom.push(id);
        saveNowPlayingConfig();
    }
    res.json({ ok: true });
});

app.post("/api/admin/nowplaying/remove-custom", requireAdmin, (req, res) => {
    const id = Number(req.body.id);
    nowPlayingConfig.custom = nowPlayingConfig.custom.filter(x => x !== id);
    saveNowPlayingConfig();
    res.json({ ok: true });
});

/** Approuve ou retire un film de la liste blanche « adapté aux enfants » des films au cinéma. */
app.post("/api/admin/nowplaying/kids-toggle", requireAdmin, (req, res) => {
    const id = Number(req.body.id);
    if (!id) return res.status(400).json({ error: "ID_MANQUANT" });
    nowPlayingConfig.kidsOk = nowPlayingConfig.kidsOk || [];
    nowPlayingConfig.kidsOk = nowPlayingConfig.kidsOk.includes(id)
        ? nowPlayingConfig.kidsOk.filter(x => x !== id)
        : [...nowPlayingConfig.kidsOk, id];
    saveNowPlayingConfig();
    res.json({ ok: true, kidsOk: nowPlayingConfig.kidsOk.includes(id) });
});

app.get("/api/movies/upcoming", async (req, res) => {
  try {
    const tmdbKey = REGLAGES.tmdbApiKey;
    if (!tmdbKey) return res.json({ error: "NO_KEY", movies: [] });
    
    const isAdmin = motDePasseAdminValide(req.get("x-admin-token"));
    // Un compte "enfant" est toujours filtré, mais aussi n'importe quel compte qui a activé le
    // bouton "Mode enfant" en cours de session (paramètre ?kids=1) : sans ça, ce mode ne
    // s'appliquait qu'au choix des films de quiz, jamais aux Sorties Ciné / À l'affiche.
    const estCompteEnfant = estEnfant(userFromCookie(req.headers.cookie)) || req.query.kids === "1";

    const now = new Date();
    const day = now.getDay();
    const diffToWed = (3 - day + 7) % 7; 
    
    const wednesday = new Date(now);
    wednesday.setDate(now.getDate() + (day >= 3 ? (3 - day) : diffToWed));
    
    const nextTuesday = new Date(wednesday);
    nextTuesday.setDate(wednesday.getDate() + 6);

    const fmt = d => d.toISOString().split('T')[0];
    const gte = fmt(wednesday);
    const lte = fmt(nextTuesday);

    const url = `https://api.themoviedb.org/3/discover/movie?api_key=${tmdbKey}&language=fr-FR&region=FR&primary_release_date.gte=${gte}&primary_release_date.lte=${lte}&with_release_type=3&sort_by=popularity.desc`;
    const response = await fetch(url);
    if (!response.ok) return res.json({ error: "API_ERROR", movies: [] });
    
    const data = await response.json();
    let results = data.results || [];
    
    const customMovies = [];
    for (const cid of (sortiesConfig.custom || [])) {
        try {
            const cRes = await fetch(`https://api.themoviedb.org/3/movie/${cid}?api_key=${tmdbKey}&language=fr-FR`);
            if (cRes.ok) {
                customMovies.push(await cRes.json());
            }
        } catch(e){}
    }
    
    const allMovies = [...customMovies, ...results];
    const seen = new Set();
    const finalMovies = [];
    
    for (const m of allMovies) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        
        const isHidden = (sortiesConfig.hidden || []).includes(m.id);
        const isCustom = (sortiesConfig.custom || []).includes(m.id);
        const isKidsOk = (sortiesConfig.kidsOk || []).includes(m.id);

        if (isHidden && !isAdmin) continue;
        // Liste blanche stricte : un compte enfant ne voit que les films explicitement
        // approuvés par l'administration, jamais le flux TMDB brut (non classé par âge).
        if (estCompteEnfant && !isKidsOk) continue;

        finalMovies.push({
            id: m.id,
            title: m.title,
            overview: m.overview,
            poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
            vote: m.vote_average,
            hidden: isHidden,
            custom: isCustom,
            kidsOk: isKidsOk
        });
    }

    res.json({
        dateDebut: gte,
        movies: isAdmin ? finalMovies : finalMovies.slice(0, 10)
    });
  } catch (err) {
    console.error("Erreur upcoming:", err);
    res.json({ error: "INTERNAL_ERROR", movies: [] });
  }
});



app.get("/api/movies/now_playing", async (req, res) => {
  try {
    const tmdbKey = REGLAGES.tmdbApiKey;
    if (!tmdbKey) return res.json({ error: "NO_KEY", movies: [] });
    
    const isAdmin = motDePasseAdminValide(req.get("x-admin-token"));
    // Voir le commentaire équivalent dans /api/movies/upcoming : le mode enfant activé en session
    // (pas seulement un compte enfant dédié) doit aussi filtrer la liste "Actuellement au cinéma".
    const estCompteEnfant = estEnfant(userFromCookie(req.headers.cookie)) || req.query.kids === "1";
    const url = `https://api.themoviedb.org/3/movie/now_playing?api_key=${tmdbKey}&language=fr-FR&region=FR`;
    
    const response = await fetch(url);
    if (!response.ok) return res.json({ error: "API_ERROR", movies: [] });
    
    const data = await response.json();
    let results = data.results || [];
    
    const customMovies = [];
    for (const cid of (nowPlayingConfig.custom || [])) {
        try {
            const cRes = await fetch(`https://api.themoviedb.org/3/movie/${cid}?api_key=${tmdbKey}&language=fr-FR`);
            if (cRes.ok) customMovies.push(await cRes.json());
        } catch(e){}
    }
    
    const allMovies = [...customMovies, ...results];
    const seen = new Set();
    const finalMovies = [];
    
    for (const m of allMovies) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        
        const isHidden = (nowPlayingConfig.hidden || []).includes(m.id);
        const isCustom = (nowPlayingConfig.custom || []).includes(m.id);
        const isKidsOk = (nowPlayingConfig.kidsOk || []).includes(m.id);

        if (isHidden && !isAdmin) continue;
        // Liste blanche stricte : un compte enfant ne voit que les films explicitement
        // approuvés par l'administration, jamais le flux TMDB brut (non classé par âge).
        if (estCompteEnfant && !isKidsOk) continue;

        finalMovies.push({
            id: m.id,
            title: m.title,
            overview: m.overview,
            poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
            vote: m.vote_average,
            hidden: isHidden,
            custom: isCustom,
            kidsOk: isKidsOk
        });
    }

    res.json({ movies: isAdmin ? finalMovies : finalMovies.slice(0, 15) });
  } catch (err) {
    console.error("Erreur now_playing:", err);
    res.json({ error: "INTERNAL_ERROR", movies: [] });
  }
});

/**
 * Recherche de films dans le salon vocal (voir #btnVocalRechercheFilm côté client) : soit une
 * poignée de catégories toutes prêtes (populaires, mieux notés…), soit une recherche libre par
 * titre — toutes deux interrogent TMDB directement plutôt que le seul catalogue local (movies.json),
 * puisqu'il s'agit ici de proposer un film à regarder ensemble, pas forcément un film du quiz.
 * Liste de catégories fermée (comme PAYS_IMPORT_TMDB plus haut) : jamais de chemin d'API arbitraire
 * construit à partir d'une valeur venue du client.
 */
const TMDB_CATEGORIES_PREDEFINIES = {
  populaires: "movie/popular",
  "mieux-notes": "movie/top_rated",
  "au-cinema": "movie/now_playing",
  prochainement: "movie/upcoming",
};

function simplifierResultatsTmdb(resultats) {
  return (resultats || []).slice(0, 12).map((m) => ({
    id: m.id,
    title: m.title,
    annee: (m.release_date || "").slice(0, 4) || null,
    poster: m.poster_path ? `https://image.tmdb.org/t/p/w200${m.poster_path}` : null,
  }));
}

app.get("/api/tmdb/predefini/:categorie", async (req, res) => {
  const tmdbKey = REGLAGES.tmdbApiKey;
  if (!tmdbKey) return res.json({ ok: false, error: "NO_KEY", resultats: [] });
  const chemin = TMDB_CATEGORIES_PREDEFINIES[req.params.categorie];
  if (!chemin) return res.status(400).json({ ok: false, error: "CATEGORIE_INCONNUE", resultats: [] });
  try {
    const url = `https://api.themoviedb.org/3/${chemin}?api_key=${tmdbKey}&language=fr-FR&region=FR`;
    const r = await fetch(url);
    if (!r.ok) return res.json({ ok: false, error: "API_ERROR", resultats: [] });
    const data = await r.json();
    res.json({ ok: true, resultats: simplifierResultatsTmdb(data.results) });
  } catch (e) {
    console.error("Erreur recherche TMDB (prédéfini) :", e);
    res.json({ ok: false, error: "INTERNAL_ERROR", resultats: [] });
  }
});

app.get("/api/tmdb/recherche", async (req, res) => {
  const tmdbKey = REGLAGES.tmdbApiKey;
  if (!tmdbKey) return res.json({ ok: false, error: "NO_KEY", resultats: [] });
  const q = String(req.query.q || "").trim().slice(0, 60);
  if (q.length < 2) return res.status(400).json({ ok: false, error: "TROP_COURT", resultats: [] });
  try {
    const url = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&language=fr-FR&include_adult=false&query=${encodeURIComponent(q)}`;
    const r = await fetch(url);
    if (!r.ok) return res.json({ ok: false, error: "API_ERROR", resultats: [] });
    const data = await r.json();
    res.json({ ok: true, resultats: simplifierResultatsTmdb(data.results) });
  } catch (e) {
    console.error("Erreur recherche TMDB (libre) :", e);
    res.json({ ok: false, error: "INTERNAL_ERROR", resultats: [] });
  }
});

/** Recherche YouTube depuis le salon vocal (voir #btnVocalRechercheVideo côté client) : un moteur
 *  simple et léger pour choisir une vidéo à diffuser sans avoir à la chercher sur YouTube puis
 *  copier-coller le lien. Nécessite une clé YouTube Data API v3, gratuite (créée sur
 *  console.cloud.google.com, voir REGLAGES.youtubeApiKey réglable depuis la console admin) — sans
 *  clé, coller un lien YouTube directement reste possible comme avant (voir vocal:video-youtube),
 *  cette recherche n'est qu'un confort en plus, jamais une obligation. */
function decoderEntitesHtml(s) {
  return String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function simplifierResultatsYoutube(items) {
  return (items || [])
    .filter((it) => it.id?.videoId)
    .slice(0, 12)
    .map((it) => ({
      videoId: it.id.videoId,
      titre: decoderEntitesHtml(it.snippet?.title),
      chaine: decoderEntitesHtml(it.snippet?.channelTitle),
      vignette: it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url || null,
    }));
}
/** Traduit une erreur brute renvoyée par l'API YouTube (statut HTTP + corps JSON) en un couple
 *  (code court, message clair en français) — sert à la fois aux logs serveur et au bouton
 *  « Tester la clé » de la console admin, pour que l'administrateur puisse comprendre et corriger
 *  le problème lui-même sans avoir besoin de lire les logs techniques du serveur. */
function interpreterErreurYoutube(statutHttp, data) {
  const raison = data?.error?.errors?.[0]?.reason || data?.error?.status || "";
  const messageBrut = data?.error?.message || "";
  if (raison === "quotaExceeded" || /quota/i.test(messageBrut)) {
    return { code: "QUOTA_DEPASSE", message: "Le quota gratuit quotidien de l'API YouTube est épuisé pour aujourd'hui — il se réinitialise automatiquement le lendemain (minuit, heure du Pacifique). Rien à faire, ça se rétablit tout seul." };
  }
  if (statutHttp === 403 && /has not been used|disabled|not enabled/i.test(messageBrut)) {
    return { code: "API_NON_ACTIVEE", message: "La clé est valide mais l'API « YouTube Data API v3 » n'est pas activée sur le projet Google Cloud associé. Dans console.cloud.google.com, ouvrez le projet de cette clé → « API et services » → « Bibliothèque » → cherchez « YouTube Data API v3 » → cliquez sur « Activer »." };
  }
  if (statutHttp === 400 || /API key not valid/i.test(messageBrut)) {
    return { code: "CLE_INVALIDE", message: "La clé n'est pas reconnue par Google (invalide ou mal copiée). Vérifiez qu'il n'y a pas d'espace avant/après en la recollant depuis console.cloud.google.com → « Identifiants »." };
  }
  if (statutHttp === 403) {
    return { code: "ACCES_REFUSE", message: "Google refuse cette clé pour cette requête (souvent une restriction sur la clé, par exemple « restriction par site web/HTTP referrer », incompatible avec un appel fait depuis le serveur). Dans console.cloud.google.com → « Identifiants » → cette clé → « Restrictions relatives à l'application », choisissez « Aucune » ou « Adresses IP », puis réessayez." };
  }
  return { code: "ERREUR_INCONNUE", message: messageBrut || `Erreur Google non identifiée (code HTTP ${statutHttp}).` };
}

app.get("/api/youtube/recherche", async (req, res) => {
  const youtubeKey = REGLAGES.youtubeApiKey;
  if (!youtubeKey) return res.json({ ok: false, error: "NO_KEY", resultats: [] });
  const q = String(req.query.q || "").trim().slice(0, 80);
  if (q.length < 2) return res.status(400).json({ ok: false, error: "TROP_COURT", resultats: [] });
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12&safeSearch=moderate&q=${encodeURIComponent(q)}&key=${youtubeKey}`;
    const r = await fetch(url);
    if (!r.ok) {
      const data = await r.json().catch(() => null);
      const { code, message } = interpreterErreurYoutube(r.status, data);
      console.error(`Erreur recherche YouTube (${code}) :`, message, data?.error || "");
      return res.json({ ok: false, error: "API_ERROR", resultats: [] });
    }
    const data = await r.json();
    res.json({ ok: true, resultats: simplifierResultatsYoutube(data.items) });
  } catch (e) {
    console.error("Erreur recherche YouTube :", e);
    res.json({ ok: false, error: "INTERNAL_ERROR", resultats: [] });
  }
});

/** Diagnostic réservé à l'administration : lance une recherche de test avec la clé YouTube
 *  actuellement enregistrée et renvoie l'explication exacte en cas d'échec (voir
 *  interpreterErreurYoutube ci-dessus), pour que l'administrateur puisse corriger le réglage
 *  sans avoir à consulter les logs techniques du serveur (Render, etc.). */
app.get("/api/admin/youtube/tester", requireAdmin, async (req, res) => {
  const youtubeKey = REGLAGES.youtubeApiKey;
  if (!youtubeKey) return res.json({ ok: false, code: "NO_KEY", message: "Aucune clé YouTube n'est enregistrée." });
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=test&key=${youtubeKey}`;
    const r = await fetch(url);
    if (!r.ok) {
      const data = await r.json().catch(() => null);
      return res.json({ ok: false, ...interpreterErreurYoutube(r.status, data) });
    }
    return res.json({ ok: true, message: "La clé fonctionne correctement — la recherche YouTube est bien active dans le salon vocal." });
  } catch (e) {
    return res.json({ ok: false, code: "RESEAU", message: "Impossible de contacter Google depuis le serveur pour l'instant, réessayez plus tard." });
  }
});

/** Bande-annonce YouTube d'un film TMDB, utilisée par le lecteur vidéo des « Sorties de la
 *  semaine » : cherche d'abord une bande-annonce officielle en VF, puis retente en VO si
 *  TMDB n'en propose aucune (fréquent pour les sorties très récentes). Appelée à la demande,
 *  au clic sur un film, plutôt qu'en même temps que la liste pour ne pas multiplier les
 *  appels TMDB par film affiché. */
app.get("/api/movies/:id/trailer", async (req, res) => {
  try {
    const tmdbKey = REGLAGES.tmdbApiKey;
    if (!tmdbKey) return res.json({ error: "NO_KEY", key: null });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID_INVALIDE", key: null });

    const chercherTrailer = async (langue) => {
      const r = await fetch(`https://api.themoviedb.org/3/movie/${id}/videos?api_key=${tmdbKey}&language=${langue}`);
      if (!r.ok) return null;
      const d = await r.json();
      const vids = d.results || [];
      const officiel = vids.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official);
      const trailer = officiel || vids.find((v) => v.site === "YouTube" && v.type === "Trailer");
      const teaser = vids.find((v) => v.site === "YouTube" && v.type === "Teaser");
      return trailer || teaser || null;
    };

    const trouve = (await chercherTrailer("fr-FR")) || (await chercherTrailer("en-US"));
    if (!trouve) return res.json({ key: null });
    res.json({ key: trouve.key });
  } catch (err) {
    console.error("Erreur bande-annonce:", err);
    res.status(500).json({ error: "INTERNAL_ERROR", key: null });
  }
});

/* ------------------------------------------------------------------ */
/* Cinémas à proximité : géolocalisation du joueur → cinémas les plus  */
/* proches via OpenStreetMap (Overpass API, gratuit, sans clé), avec   */
/* identification des grandes enseignes (UGC, MK2, Gaumont, Pathé...)  */
/* pour les distinguer des cinémas indépendants / de quartier.         */
/* ------------------------------------------------------------------ */

const ENSEIGNES_CINEMA = [
  { motif: /\bugc\b/i, nom: "UGC" },
  { motif: /\bmk2\b/i, nom: "MK2" },
  { motif: /gaumont/i, nom: "Gaumont" },
  { motif: /path[eé]/i, nom: "Pathé" },
  { motif: /\bcgr\b/i, nom: "CGR" },
  { motif: /cin[eé]ville/i, nom: "Cinéville" },
  { motif: /kinepolis/i, nom: "Kinepolis" },
  { motif: /megarama/i, nom: "Megarama" },
];
const enseigneDepuisNom = (nom) =>
  (ENSEIGNES_CINEMA.find((e) => e.motif.test(nom || "")) || {}).nom || "Cinéma indépendant";

/** Logo à afficher sur une fiche cinéma, selon son enseigne — configuré (upload d'image) depuis
 *  la console admin. Les enseignes non reconnues (ou sans logo dédié uploadé) reçoivent le logo
 *  "indépendant" générique, s'il a été configuré ; sinon aucun logo n'est affiché. */
function logoPourEnseigne(enseigne) {
  const logos = REGLAGES.logosCinema || {};
  if (enseigne === "UGC" && logos.ugc) return logos.ugc;
  if (enseigne === "MK2" && logos.mk2) return logos.mk2;
  if (enseigne === "Gaumont" && logos.gaumont) return logos.gaumont;
  if (enseigne === "Pathé" && logos.pathe) return logos.pathe;
  return logos.independant || "";
}

/** Distance à vol d'oiseau entre deux points GPS, en kilomètres (formule de haversine). */
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Le serveur Overpass principal (OpenStreetMap, gratuit et sans clé) est parfois lent, surchargé
// ou limite le débit des adresses IP partagées des hébergeurs cloud (Render, Heroku...) — ce qui
// peut le rendre silencieusement inutilisable depuis un serveur, même quand tout fonctionne en
// local. On borne chaque appel dans le temps et on bascule sur un miroir avant d'abandonner.
const OVERPASS_INSTANCES = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
async function interrogerOverpass(url, requete) {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), 10000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Overpass demande un User-Agent explicite identifiant l'appli — son absence peut
        // entraîner un rejet silencieux des requêtes sur certaines instances.
        "User-Agent": "MichBenCineQuizz/1.0 (+https://michben-cine-quizz; contact: sospchs@gmail.com)",
      },
      body: `data=${encodeURIComponent(requete)}`,
      signal: controleur.signal,
    });
    if (!r.ok) { console.error(`Overpass (${url}) a répondu ${r.status}`); return null; }
    const d = await r.json();
    return d.elements || [];
  } catch (err) {
    console.error(`Overpass (${url}) indisponible :`, err?.message || err);
    return null;
  } finally {
    clearTimeout(minuteur);
  }
}

/** Cherche des cinémas via OpenStreetMap/Overpass (gratuit, sans clé, mais pas toujours
 *  fiable depuis un serveur cloud). Retourne un tableau (éventuellement vide) ou null si les
 *  deux instances ont échoué. */
async function cinemasViaOverpass(lat, lon, rayonMetres) {
  const requete = `[out:json][timeout:9];(node["amenity"="cinema"](around:${rayonMetres},${lat},${lon});way["amenity"="cinema"](around:${rayonMetres},${lat},${lon}););out center;`;
  let elements = null;
  for (const instance of OVERPASS_INSTANCES) {
    elements = await interrogerOverpass(instance, requete);
    if (elements !== null) break;
  }
  if (elements === null) return null;

  const vus = new Set();
  const cinemas = [];
  for (const el of elements) {
    const nom = el.tags?.name;
    if (!nom) continue;
    const latEl = el.lat ?? el.center?.lat;
    const lonEl = el.lon ?? el.center?.lon;
    if (!Number.isFinite(latEl) || !Number.isFinite(lonEl)) continue;
    const cle = nom + "|" + (el.tags?.["addr:street"] || "");
    if (vus.has(cle)) continue;
    vus.add(cle);
    const adresse = [el.tags?.["addr:housenumber"], el.tags?.["addr:street"]].filter(Boolean).join(" ") || null;
    cinemas.push({
      nom, enseigne: enseigneDepuisNom(nom), adresse,
      ville: el.tags?.["addr:city"] || null, codePostal: el.tags?.["addr:postcode"] || null,
      lat: latEl, lon: lonEl, distanceKm: Math.round(distanceKm(lat, lon, latEl, lonEl) * 10) / 10,
    });
  }
  return cinemas;
}

/** Cherche des cinémas via l'API Geoapify Places (clé gratuite requise, configurée en
 *  console admin — bien plus fiable qu'Overpass depuis un hébergeur cloud). Retourne un
 *  tableau (éventuellement vide) ou null en cas d'échec ou si aucune clé n'est configurée. */
async function cinemasViaGeoapify(lat, lon, rayonMetres) {
  const cle = REGLAGES.geoapifyApiKey;
  if (!cle) return null;
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), 10000);
  try {
    const url = `https://api.geoapify.com/v2/places?categories=entertainment.cinema` +
      `&filter=circle:${lon},${lat},${rayonMetres}&bias=proximity:${lon},${lat}&limit=20&apiKey=${encodeURIComponent(cle)}`;
    const r = await fetch(url, { signal: controleur.signal });
    if (!r.ok) { console.error(`Geoapify a répondu ${r.status}`); return null; }
    const d = await r.json();
    const features = d.features || [];
    return features.map((f) => {
      const p = f.properties || {};
      return {
        nom: p.name || "Cinéma",
        enseigne: enseigneDepuisNom(p.name || ""),
        adresse: p.address_line1 || [p.housenumber, p.street].filter(Boolean).join(" ") || null,
        ville: p.city || null,
        codePostal: p.postcode || null,
        lat: p.lat, lon: p.lon,
        distanceKm: Number.isFinite(p.distance) ? Math.round(p.distance / 100) / 10
          : Math.round(distanceKm(lat, lon, p.lat, p.lon) * 10) / 10,
      };
    }).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  } catch (err) {
    console.error("Geoapify indisponible :", err?.message || err);
    return null;
  } finally {
    clearTimeout(minuteur);
  }
}

/**
 * Communes correspondant à un code postal de France métropolitaine — utilisé pour chercher des
 * cinémas sans dépendre du GPS (adresse saisie à la main). S'appuie sur l'API officielle
 * gratuite « geo.api.gouv.fr » (aucune clé requise) : un code postal peut couvrir plusieurs
 * communes (ex. Paris), d'où le retour d'une liste plutôt que d'une seule position.
 */
app.get("/api/communes", async (req, res) => {
  try {
    const cp = String(req.query.codePostal || "").trim();
    // Métropole uniquement (01xxx à 95xxx), comme demandé : les DROM (97x/98x) et la Corse restent
    // hors du champ de cette recherche pour l'instant, mais sont bien sûr toujours trouvables via GPS.
    if (!/^(0[1-9]|[1-8]\d|9[0-5])\d{3}$/.test(cp))
      return res.status(400).json({ error: "CODE_POSTAL_INVALIDE", communes: [] });

    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), 8000);
    try {
      const url = `https://geo.api.gouv.fr/communes?codePostal=${cp}&fields=nom,code,centre,codesPostaux&format=json`;
      const r = await fetch(url, { signal: controleur.signal });
      if (!r.ok) return res.status(502).json({ error: "SERVICE_INDISPONIBLE", communes: [] });
      const data = await r.json();
      const communes = (Array.isArray(data) ? data : [])
        .filter((c) => c.centre?.coordinates?.length === 2)
        .map((c) => ({ nom: c.nom, code: c.code, lat: c.centre.coordinates[1], lon: c.centre.coordinates[0] }))
        .sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
      res.json({ communes });
    } finally {
      clearTimeout(minuteur);
    }
  } catch (err) {
    console.error("Erreur communes:", err);
    res.status(500).json({ error: "INTERNAL_ERROR", communes: [] });
  }
});

app.get("/api/cinemas/proches", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return res.status(400).json({ error: "POSITION_INVALIDE", cinemas: [] });

    // Geoapify (avec clé configurée) est essayé en premier — bien plus fiable depuis un
    // serveur cloud qu'Overpass, qui limite parfois le débit des adresses IP partagées des
    // hébergeurs. Overpass sert de repli gratuit si aucune clé n'est configurée, ou si
    // Geoapify échoue ou ne remonte presque rien.
    let cinemas = await cinemasViaGeoapify(lat, lon, 50000);
    let source = cinemas !== null ? "geoapify" : null;
    if ((cinemas === null || cinemas.length < 3)) {
      const viaOsm = await cinemasViaOverpass(lat, lon, 50000);
      if (viaOsm !== null && (cinemas === null || viaOsm.length > cinemas.length)) { cinemas = viaOsm; source = "overpass"; }
    }
    // Élargit à 100 km si presque rien ne remonte — utile en zone peu dense.
    if (cinemas !== null && cinemas.length < 3) {
      const elargi = source === "geoapify" ? await cinemasViaGeoapify(lat, lon, 100000) : await cinemasViaOverpass(lat, lon, 100000);
      if (elargi && elargi.length > cinemas.length) cinemas = elargi;
    }

    if (cinemas === null) {
      const conseil = REGLAGES.geoapifyApiKey
        ? "Geoapify et OpenStreetMap sont tous deux indisponibles pour le moment."
        : "Aucune clé Geoapify configurée et OpenStreetMap est indisponible pour le moment — ajoutez une clé Geoapify gratuite en console admin (Réglages) pour fiabiliser cette fonctionnalité.";
      console.error("Recherche de cinémas : aucune source disponible.", conseil);
      return res.status(502).json({ error: "SERVICE_INDISPONIBLE", cinemas: [] });
    }

    cinemas.sort((a, b) => a.distanceKm - b.distanceKm);
    const cinemasAvecLogo = cinemas.slice(0, 20).map((c) => ({ ...c, logo: logoPourEnseigne(c.enseigne) }));
    res.json({ cinemas: cinemasAvecLogo, source });
  } catch (err) {
    console.error("Erreur cinémas proches:", err);
    res.status(500).json({ error: "INTERNAL_ERROR", cinemas: [] });
  }
});

app.get("/api/leaderboard", (req, res) =>
  res.json(leaderboard(50, ["global", "enfant"].includes(req.query.type) ? req.query.type : "saison"))
);

/** Position exacte du compte connecté au classement (même hors du top 50 renvoyé par
 *  /api/leaderboard) — pour la carte « votre position » affichée en haut du menu principal. */
app.get("/api/mon-classement", (req, res) => {
  const user = userFromCookie(req.headers.cookie);
  if (!user) return res.json({ rang: null });
  const type = ["global", "enfant"].includes(req.query.type) ? req.query.type : "saison";
  res.json(monClassement(user.id, type) || { rang: null });
});

app.get("/api/saison", (req, res) => {
  const user = userFromCookie(req.headers.cookie);
  res.json({
    ...infoSaison(),
    partiesRestantes: user ? partiesRestantes(user.id) : null,
    prochaineRecharge: user ? prochaineRecharge(user.id) : null,
    palmares: palmares.slice(-3).reverse(),
  });
});

app.get("/api/birthdays", async (req, res) => {
  try {
    let mm, dd;
    if (req.query.mm && req.query.dd) {
        mm = req.query.mm;
        dd = req.query.dd;
    } else {
        const today = new Date();
        mm = String(today.getMonth() + 1).padStart(2, '0');
        dd = String(today.getDate()).padStart(2, '0');
    }
    const response = await fetch(`https://fr.wikipedia.org/api/rest_v1/feed/onthisday/births/${mm}/${dd}`);
    if (!response.ok) return res.json({ actors: [] });
    const data = await response.json();
    
    const actors = data.births.filter(b => {
      const text = (b.text || "").toLowerCase();
      return text.includes("acteur") || text.includes("actrice") || text.includes("réalisateur") || text.includes("cinéaste");
    }).map(b => {
      const page = b.pages && b.pages[0] ? b.pages[0] : null;
      const nom = page ? page.title.replace(/_/g, ' ') : "Inconnu";
      // Lien Wikipédia : celui fourni par l'API si présent, sinon on reconstruit
      // à partir du titre de la page (fonctionne dans l'immense majorité des cas).
      const url = page?.content_urls?.desktop?.page
        || (page ? `https://fr.wikipedia.org/wiki/${encodeURIComponent(page.title)}` : null);
      return {
        name: nom,
        year: b.year,
        // Âge que la personne a (ou aurait) cette année, calculé à partir de l'année de naissance.
        age: b.year ? (new Date().getFullYear() - b.year) : null,
        description: b.text,
        thumbnail: page && page.thumbnail ? page.thumbnail.source : null,
        url,
      };
    }).sort((a, b) => b.year - a.year);
    
    res.json({ actors: actors.slice(0, 15) });
  } catch (err) {
    console.error("Erreur anniversaires:", err);
    res.json({ actors: [] });
  }
});

/** Identifiants TURN Cloudflare, mis en cache en mémoire et renouvelés automatiquement bien avant
 *  leur expiration — un identifiant Cloudflare est volontairement TEMPORAIRE (quelques heures),
 *  contrairement à l'identifiant fixe d'un service comme metered.ca : on ne peut donc pas se
 *  contenter de le lire depuis les réglages une fois pour toutes, il faut en refabriquer un
 *  nouveau à la demande via l'API de Cloudflare (voir cloudflareTurnKeyId/cloudflareTurnApiToken).
 *  `cloudflareTurnCache` est remis à `null` dès que l'admin change l'une de ces deux valeurs (voir
 *  PUT /api/admin/audio) pour qu'une correction prenne effet immédiatement plutôt que de rester
 *  bloquée sur d'anciens identifiants jusqu'à leur expiration naturelle. */
let cloudflareTurnCache = null; // { iceServers, expireLe }
const CLOUDFLARE_TURN_TTL_S = 6 * 60 * 60; // 6h : largement assez pour un salon vocal, renouvelé bien avant
async function obtenirIceServersCloudflare() {
  const keyId = REGLAGES.audio?.cloudflareTurnKeyId;
  const apiToken = REGLAGES.audio?.cloudflareTurnApiToken;
  if (!keyId || !apiToken) return null;
  const maintenant = Date.now();
  if (cloudflareTurnCache && cloudflareTurnCache.expireLe > maintenant) return cloudflareTurnCache.iceServers;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: CLOUDFLARE_TURN_TTL_S }),
    });
    if (!r.ok) { console.error("Cloudflare TURN : identifiants refusés", r.status); return cloudflareTurnCache?.iceServers || null; }
    const data = await r.json();
    if (!Array.isArray(data.iceServers) || !data.iceServers.length) return cloudflareTurnCache?.iceServers || null;
    // Marge de 5 minutes avant l'expiration réelle, pour ne jamais risquer de servir un identifiant
    // qui expire en plein milieu d'un salon vocal déjà en cours de connexion.
    cloudflareTurnCache = { iceServers: data.iceServers, expireLe: maintenant + (CLOUDFLARE_TURN_TTL_S - 300) * 1000 };
    return cloudflareTurnCache.iceServers;
  } catch (err) {
    console.error("Cloudflare TURN : requête impossible", err.message);
    return cloudflareTurnCache?.iceServers || null; // un identifiant périmé reste préférable à aucun
  }
}

app.get("/api/config", async (_req, res) => res.json({
  tipUrl: CONFIG.TIP_URL, maxPlayers: CONFIG.MAX_PLAYERS, pointsParTicket: CONFIG.POINTS_PAR_TICKET, animationsAvancees: REGLAGES.animationsAvancees,
  afficherRadio: REGLAGES.afficherRadio,
  autoriserSpectateur: REGLAGES.autoriserSpectateur,
  afficherAmisEnLigne: REGLAGES.afficherAmisEnLigne,
  afficherClassementAccueil: REGLAGES.afficherClassementAccueil,
  theme: REGLAGES.theme,
  reactions: REGLAGES.reactions,
  // Priorité à Cloudflare (voir obtenirIceServersCloudflare ci-dessus) dès qu'il est configuré —
  // bien meilleur forfait gratuit. Sinon, réglage manuel fait depuis la console admin (onglet
  // Audio) ; les variables d'environnement TURN_URL / TURN_USERNAME / TURN_CREDENTIAL ne servent
  // plus que de valeur de secours au tout premier démarrage (voir plus bas dans ce fichier).
  // Toujours envoyé sous forme de tableau (voir VOCAL_ICE_SERVERS côté client) — Cloudflare renvoie
  // à la fois un serveur STUN et un serveur TURN en une seule fois, contrairement à l'ancien format.
  turn: await (async () => {
    const iceCloudflare = await obtenirIceServersCloudflare();
    if (iceCloudflare) return iceCloudflare;
    if (!REGLAGES.audio?.turnActif || !REGLAGES.audio.turnUrl) return null;
    const urls = REGLAGES.audio.turnUrl.split(/[\n,]/).map((u) => u.trim()).filter(Boolean);
    if (!urls.length) return null;
    return [{ urls: urls.length > 1 ? urls : urls[0], username: REGLAGES.audio.turnUsername, credential: REGLAGES.audio.turnCredential }];
  })(),
  // Bouton teaser à côté du "?" (voir #btnLienExterne) : n'est envoyé au client que si l'admin l'a
  // activé et a bien renseigné un lien — sinon le bouton reste simplement masqué.
  lienExterne: (REGLAGES.lienExterne?.actif && REGLAGES.lienExterne.url)
    ? {
        url: REGLAGES.lienExterne.url, titre: REGLAGES.lienExterne.titre || "", cible: REGLAGES.lienExterne.cible || null,
        // Si la passerelle de connexion est configurée, le clic passe par elle (voir
        // /api/passerelle/autoriser) pour arriver déjà connecté sur l'autre jeu.
        passerelle: Boolean(REGLAGES.passerelle?.actif && REGLAGES.passerelle.cleSecrete),
      }
    : null,
  // Liens épinglés (voir #btnLiensEpingles côté client) : envoyés tels quels aux joueurs, déjà
  // filtrés de tout lien incomplet côté serveur (voir PUT /api/admin/reglages) — le bouton reste
  // masqué côté client tant que ce tableau est vide.
  liensEpingles: (REGLAGES.liensEpingles || []).map((l) => ({ id: l.id, titre: l.titre, url: l.url, image: l.image || "" })),
}));

/**
 * Don de points à un ami. Plafonné par opération et sur 24 h : sans cela,
 * plusieurs comptes pourraient converger vers un seul pour gonfler un score.
 *
 * Le plafond par envoi (REGLAGES.transfertMax) est celui du premier palier
 * (niveau 1) : plus un joueur progresse, plus son plafond grandit, jusqu'à
 * 10 fois ce montant au niveau maximum (300 par défaut). Récompense la
 * fidélité sans jamais réduire ce qu'un nouveau joueur peut déjà offrir.
 */
const PALIERS_DON = 10;             // nombre de paliers, du niveau 1 (×1) au niveau max (×10)
const MULTIPLICATEUR_DON_MAX = 10;  // au dernier palier, on peut envoyer 10 fois plus qu'au premier

/** Palier de don atteint (1 à PALIERS_DON) pour un niveau donné, réparti sur toute la progression. */
function palierDon(niveau) {
  const plafondNiveau = REGLAGES.niveauMax || 300;
  return Math.min(PALIERS_DON, Math.max(1, Math.ceil((Math.max(0, niveau) / plafondNiveau) * PALIERS_DON)));
}

/** Plafond de points transférables en un seul don pour ce joueur, selon son niveau actuel. */
function plafondDonPourJoueur(userId) {
  const niveau = infoNiveau(userId, { base: REGLAGES.xpBase, croissance: REGLAGES.xpCroissance, plafond: REGLAGES.niveauMax })?.niveau || 0;
  const palier = palierDon(niveau);
  const multiplicateur = 1 + (MULTIPLICATEUR_DON_MAX - 1) * (palier - 1) / (PALIERS_DON - 1);
  return { max: Math.round(REGLAGES.transfertMax * multiplicateur), palier, niveau };
}

const donsRecents = new Map();   // userId -> [{ montant, at }]

/** Total déjà donné par ce joueur sur les dernières 24h, et ce qu'il lui reste. */
function statutDonsJour(userId) {
  const limite = Date.now() - 24 * 60 * 60 * 1000;
  const recents = (donsRecents.get(userId) || []).filter((d) => d.at > limite);
  const dejaDonne = recents.reduce((t, d) => t + d.montant, 0);
  const { max, palier, niveau } = plafondDonPourJoueur(userId);
  return {
    max, palier, paliersMax: PALIERS_DON, niveau,
    plafondJour: REGLAGES.transfertParJour,
    dejaDonne,
    restant: Math.max(0, REGLAGES.transfertParJour - dejaDonne),
  };
}

app.get("/api/points/dons-statut", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  res.json(statutDonsJour(user.id));
});

app.post("/api/points/donner", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;

  const cible = String(req.body.id || "");
  const montant = Math.floor(Number(req.body.points) || 0);
  if (montant <= 0) return res.status(400).json({ error: "MONTANT_INVALIDE" });
  const { max: plafondDon } = plafondDonPourJoueur(user.id);
  if (montant > plafondDon)
    return res.status(400).json({ error: "TROP_ELEVE", max: plafondDon });
  if (statutRelation(user.id, cible) !== "ami")
    return res.status(403).json({ error: "PAS_AMI" });

  const { dejaDonne, restant } = statutDonsJour(user.id);
  if (dejaDonne + montant > REGLAGES.transfertParJour)
    return res.status(400).json({ error: "PLAFOND_JOUR", restant });

  if (getPoints(user.id) < montant) return res.status(400).json({ error: "SOLDE_INSUFFISANT" });

  retirerPoints(user.id, montant);
  grantPointsDon(cible, montant);
  const limite = Date.now() - 24 * 60 * 60 * 1000;
  const recents = (donsRecents.get(user.id) || []).filter((d) => d.at > limite);
  donsRecents.set(user.id, [...recents, { montant, at: Date.now() }]);

  const cibleFiche = fichePublique(cible, user.id);
  enregistrerTransaction(user.id, -montant, "points", `Don envoyé à ${cibleFiche?.pseudo || "un ami"}`);
  enregistrerTransaction(cible, montant, "points", `Don reçu de ${user.pseudo}`);

  notifier(cible, { type: "don", de: user.pseudo, avatar: user.avatar,
                    photo: user.photo || null, montant });
  // Si donneur et receveur sont tous deux dans le même salon vocal en ce moment, le don devient un
  // petit moment visible par tout le salon (voir diffuserDonVocal) — comme les réactions emoji.
  vocalSalon.diffuserDonVocal(user.id, cible, { type: "points", de: user.pseudo, avatar: user.avatar,
                    photo: user.photo || null, cible: cibleFiche?.pseudo || "", montant });

  res.json({ ok: true, points: getPoints(user.id), montant, restant: statutDonsJour(user.id).restant });
});

/**
 * Don d'une partie classée à un ami (voir donnerPartieClassee) : réservé aux amis, comme le don de
 * points ci-dessus — jamais à un inconnu ni à quelqu'un qu'on a bloqué (ou qui nous a bloqué).
 */
app.post("/api/parties-classees/donner", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;

  const cible = String(req.body.id || "");
  if (statutRelation(user.id, cible) !== "ami")
    return res.status(403).json({ error: "PAS_AMI" });
  if (estBloque(user.id, cible)) return res.status(403).json({ error: "BLOQUE" });

  const resultat = donnerPartieClassee(user.id, cible);
  if (!resultat.ok) return res.status(400).json(resultat);

  const cibleFiche = fichePublique(cible, user.id);
  notifier(cible, { type: "don_partie", de: user.pseudo, avatar: user.avatar, photo: user.photo || null });
  vocalSalon.diffuserDonVocal(user.id, cible, { type: "partie", de: user.pseudo, avatar: user.avatar,
                    photo: user.photo || null, cible: cibleFiche?.pseudo || "" });
  res.json({ ok: true, partiesRestantes: partiesRestantes(user.id) });
});

/**
 * Don de tickets (crédits) à un ami : le joueur choisit librement la quantité (plafonnée par envoi
 * et sur 24h, comme le don de points plus haut, pour éviter qu'un même joueur ne fasse converger
 * plusieurs comptes vers un seul). Contrairement au don de points, celui qui offre des tickets
 * gagne un peu d'expérience en retour — mais seulement pour un nombre limité de dons par jour
 * (REGLAGES.donTicketsXpParJourMax) : sans cette limite, deux comptes pourraient se renvoyer le même
 * ticket à l'infini pour farmer de l'xp gratuitement. Au-delà, le don continue de fonctionner
 * normalement, simplement sans xp supplémentaire ce jour-là.
 */
const donsTicketsRecents = new Map();   // userId -> [{ montant, at }]

/** Total de tickets déjà donnés par ce joueur sur les dernières 24h, ce qu'il lui reste à donner,
 *  et le nombre de dons déjà récompensés en xp aujourd'hui. */
function statutDonsTicketsJour(userId) {
  const limite = Date.now() - 24 * 60 * 60 * 1000;
  const recents = (donsTicketsRecents.get(userId) || []).filter((d) => d.at > limite);
  const dejaDonne = recents.reduce((t, d) => t + d.montant, 0);
  return {
    max: REGLAGES.donTicketsMax,
    plafondJour: REGLAGES.donTicketsParJour,
    dejaDonne,
    restant: Math.max(0, REGLAGES.donTicketsParJour - dejaDonne),
    xpParDon: REGLAGES.donTicketsXp,
    donsRecompensesAujourdhui: recents.length,
    xpEncoreDisponible: recents.length < REGLAGES.donTicketsXpParJourMax,
  };
}

app.get("/api/tickets/dons-statut", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;
  res.json(statutDonsTicketsJour(user.id));
});

app.post("/api/tickets/donner", (req, res) => {
  const user = exigeCompte(req, res);
  if (!user) return;

  const cible = String(req.body.id || "");
  const montant = Math.floor(Number(req.body.montant) || 0);
  if (montant <= 0) return res.status(400).json({ error: "MONTANT_INVALIDE" });
  if (montant > REGLAGES.donTicketsMax)
    return res.status(400).json({ error: "TROP_ELEVE", max: REGLAGES.donTicketsMax });
  if (statutRelation(user.id, cible) !== "ami")
    return res.status(403).json({ error: "PAS_AMI" });
  if (estBloque(user.id, cible)) return res.status(403).json({ error: "BLOQUE" });

  const { dejaDonne, restant, donsRecompensesAujourdhui } = statutDonsTicketsJour(user.id);
  if (dejaDonne + montant > REGLAGES.donTicketsParJour)
    return res.status(400).json({ error: "PLAFOND_JOUR", restant });

  if (!spendCredits(user.id, montant)) return res.status(400).json({ error: "SOLDE_INSUFFISANT" });
  grantCredits(cible, montant);

  const limite = Date.now() - 24 * 60 * 60 * 1000;
  const recents = (donsTicketsRecents.get(user.id) || []).filter((d) => d.at > limite);
  donsTicketsRecents.set(user.id, [...recents, { montant, at: Date.now() }]);

  // Récompense de générosité, plafonnée en nombre de dons par jour (voir le commentaire plus haut).
  let xpGagnee = 0, niveau = null;
  if (donsRecompensesAujourdhui < REGLAGES.donTicketsXpParJourMax) {
    xpGagnee = REGLAGES.donTicketsXp;
    niveau = ajouterXp(user.id, xpGagnee, reglagesNiveau());
  }

  const cibleFiche = fichePublique(cible, user.id);
  enregistrerTransaction(user.id, -montant, "credits", `Don envoyé à ${cibleFiche?.pseudo || "un ami"}`);
  enregistrerTransaction(cible, montant, "credits", `Don reçu de ${user.pseudo}`);

  notifier(cible, { type: "don_tickets", de: user.pseudo, avatar: user.avatar,
                    photo: user.photo || null, montant });
  vocalSalon.diffuserDonVocal(user.id, cible, { type: "tickets", de: user.pseudo, avatar: user.avatar,
                    photo: user.photo || null, cible: cibleFiche?.pseudo || "", montant });

  res.json({ ok: true, credits: getCredits(user.id), montant, xpGagnee, niveau,
             restant: statutDonsTicketsJour(user.id).restant });
});

/** Espace échange : points gagnés → tickets bonus. */
app.post("/api/exchange", (req, res) => {
  const user = userFromCookie(req.headers.cookie);
  if (!user) return res.status(401).json({ error: "NOT_AUTHENTICATED" });

  const result = exchangePoints(user.id, req.body.points, CONFIG.POINTS_PAR_TICKET);
  if (result.error) return res.status(400).json(result);
  if (result.consommes) enregistrerTransaction(user.id, -result.consommes, "points", "Échange contre des tickets");
  if (result.tickets) enregistrerTransaction(user.id, result.tickets, "credits", "Échange de points");
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

/** Retrouve la partie active (non terminée) où joue actuellement un utilisateur. */
function salonDuJoueur(userId) {
  for (const room of rooms.values()) {
    if (room.status === "finished") continue;
    if (room.players.has(userId)) return room;
  }
  return null;
}

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

/* ------------------------------------------------------------------ */
/* Salons vocaux : rôles (hôte, cohôte, intervenant, auditeur), une      */
/* piste radio diffusée en synchronisé à partir du catalogue musique     */
/* existant, et un vrai son transmis entre navigateurs par connexion     */
/* directe (WebRTC, pair-à-pair — voir vocal:rtc-signal plus bas). Ce     */
/* serveur ne fait que relayer les messages de négociation (offres,      */
/* réponses, candidats ICE) : le son lui-même ne transite jamais par     */
/* ici. Sans service de relais audio payant (TURN), la connexion directe */
/* échoue parfois sur les réseaux les plus restrictifs (box de certains  */
/* opérateurs, wifi d'entreprise très filtré) — c'est le compromis       */
/* accepté pour garder cette fonctionnalité gratuite.                    */
/* ------------------------------------------------------------------ */

/** Clamp générique (même logique que le `borne` local utilisé par les routes de réglages, mais
 *  au niveau du module pour pouvoir servir aux salons vocaux en dehors d'une route). */
function borneValeur(v, min, max, defaut) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaut;
}

// Tout ce qui suivait ici (salons vocaux : état, aide, routes /api/vocal/*) vit maintenant dans
// le module totalement indépendant vocal-salon.js (voir la constante `vocalSalon` plus haut) —
// server.js n'a plus besoin de connaître le détail de son fonctionnement, seulement les quelques
// fonctions que ce module expose en retour (vocalSalon.diffuserDonVocal, vocalSalon.salonsVocaux,
// etc.) pour les deux passerelles qui restent, elles, du côté du jeu (vocal:equipe-ouvrir,
// vocal:partie-ouvrir et fusionnerSalonsVocauxEquipe, plus bas dans ce fichier).

/**
 * Quatre propositions : la bonne, plus trois leurres pris de préférence
 * dans la même décennie — sinon le bon titre saute aux yeux.
 */
function buildChoices(movie) {
  // Si la question porte sur un film enfant, les leurres doivent l'être
  // aussi : pas question qu'un titre pour adultes apparaisse comme option.
  const actifs = movies.filter((m) => m.enabled !== false && (!movie.kids || m.kids === true));
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
    partiesMax: REGLAGES.partiesClasseesParJour,
  };
};

/**
 * Les parties classées se rechargent toutes les 24 h, comme un seau de
 * pop-corn qui se vide en jouant et se remplit du jour au lendemain.
 * On mémorise l'horodatage de chaque partie plutôt qu'un simple compteur :
 * la recharge est ainsi progressive et honnête, sans remise à zéro brutale.
 */
const JOUR_MS = 24 * 60 * 60 * 1000;

function partiesRecentes(userId) {
  const liste = saison.participations[userId] || [];
  const limite = Date.now() - JOUR_MS;
  const gardees = (Array.isArray(liste) ? liste : []).filter((t) => t > limite);
  if (gardees.length !== liste.length) saison.participations[userId] = gardees;
  return gardees;
}

/**
 * Parties classées bonus, gagnées à la roue du jour (lot « partie classée
 * bonus ») : s'ajoutent au quota quotidien classique sans jamais l'entamer,
 * et ne se rechargent pas — une fois utilisées, elles sont consommées.
 */
const BONUS_RANKED_FILE = new URL("./bonusRanked.json", import.meta.url);
let bonusPartiesClassees = {};   // userId -> nombre de parties classées bonus en réserve
const saveBonusRanked = () => sauver("bonusRanked", bonusPartiesClassees, BONUS_RANKED_FILE);

function accorderPartiesClasseesBonus(userId, n) {
  bonusPartiesClassees[userId] = (bonusPartiesClassees[userId] || 0) + Math.max(0, n);
  saveBonusRanked();
}

const partiesRestantes = (userId) => {
  verifierSaison();
  const base = Math.max(0, REGLAGES.partiesClasseesParJour - partiesRecentes(userId).length);
  return base + (bonusPartiesClassees[userId] || 0);
};

/** Quand la prochaine partie redevient disponible, en millisecondes. */
function prochaineRecharge(userId) {
  if (bonusPartiesClassees[userId] > 0) return 0;   // une partie bonus est immédiatement disponible
  const recentes = partiesRecentes(userId);
  if (recentes.length < REGLAGES.partiesClasseesParJour) return 0;
  return Math.max(0, Math.min(...recentes) + JOUR_MS - Date.now());
}

/** Enregistre une partie comme comptant sur le quota quotidien classique, sans jamais toucher à la
 *  réserve bonus (voir enregistrerParticipationClassee ci-dessous pour pourquoi c'est important). */
function enregistrerParticipationClassee(userId) {
  const recentes = partiesRecentes(userId);
  saison.participations[userId] = [...recentes, Date.now()];
  sauver("saison", saison);
}

function consommerPartieClassee(userId) {
  // On puise d'abord dans la réserve bonus : elle ne doit jamais entamer le quota quotidien classique.
  if (bonusPartiesClassees[userId] > 0) {
    bonusPartiesClassees[userId] -= 1;
    saveBonusRanked();
    return;
  }
  enregistrerParticipationClassee(userId);
}

/**
 * Une partie classée gagnée (terminée sans avoir perdu tous ses cœurs) réapprovisionne le seau
 * d'une partie bonus, comme une victoire méritée qui redonne une chance de continuer à jouer.
 * Plafonné pour que le seau ne grossisse pas indéfiniment à force d'enchaîner les victoires — voir
 * RANKED_BONUS_MAX ci-dessous, partagé avec les dons entre amis.
 *
 * Une victoire doit TOUJOURS être comptée sur le quota quotidien classique (voir l'appel à
 * enregistrerParticipationClassee côté appelant), jamais sur la réserve bonus : sinon la victoire
 * consommerait aussitôt le jeton qu'elle vient elle-même de rapporter, et la réserve ne pourrait
 * jamais dépasser 1 quel que soit le nombre de victoires enchaînées.
 */
const RANKED_BONUS_MAX = 3;   // parties bonus max en réserve (victoires + dons confondus) : 5 + 3 = 8 au total
function recompenserVictoireClassee(userId) {
  if ((bonusPartiesClassees[userId] || 0) >= RANKED_BONUS_MAX) return;
  accorderPartiesClasseesBonus(userId, 1);
}

/**
 * Don d'une partie classée à un ami : le donneur cède une des parties encore disponibles dans son
 * propre seau, et le destinataire la reçoit TOUJOURS en bonus, par-dessus son quota quotidien
 * classique (voir partiesRestantes) — même s'il lui reste encore des parties de son quota normal.
 * Un joueur a ainsi droit à ses 5 parties habituelles ET jusqu'à 3 parties en dons/bonus en plus,
 * soit 8 parties au total au lieu de devoir attendre que son seau soit vide pour en profiter.
 *
 * Seule limite : la réserve bonus (RANKED_BONUS_MAX, partagée avec les récompenses de victoire)
 * ne doit pas grossir indéfiniment — un don refusé pour réserve pleine n'est pas perdu pour le
 * donneur, qui garde sa partie disponible pour la retenter plus tard ou l'offrir à quelqu'un d'autre.
 *
 * Le don retire une partie chez le donneur exactement comme s'il venait d'en jouer une (voir
 * consommerPartieClassee, qui puise d'abord dans sa propre réserve bonus) et en accorde une, en
 * bonus, chez le destinataire (voir accorderPartiesClasseesBonus) — jamais l'inverse.
 */
function donnerPartieClassee(donneurId, destinataireId) {
  if (donneurId === destinataireId) return { ok: false, error: "SOI_MEME" };
  if (partiesRestantes(donneurId) <= 0) return { ok: false, error: "AUCUNE_PARTIE" };
  const reserveDestinataire = bonusPartiesClassees[destinataireId] || 0;
  if (reserveDestinataire >= RANKED_BONUS_MAX)
    return { ok: false, error: "RESERVE_PLEINE", max: RANKED_BONUS_MAX };
  consommerPartieClassee(donneurId);
  accorderPartiesClasseesBonus(destinataireId, 1);
  return { ok: true };
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
/** Indice « Nombre de lettres » : le masque du titre, plus le chiffre exact. */
function titlePattern(title) {
  const masque = [...title].map((c) => (/[\p{L}\p{N}]/u.test(c) ? "–" : c)).join("");
  const nbLettres = [...title].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
  return `${masque}  (${nbLettres} lettre${nbLettres > 1 ? "s" : ""})`;
}

/**
 * Films servis récemment, tous joueurs confondus (pas seulement l'historique du joueur qui a
 * lancé la partie). En multijoueur, seule la personne qui crée le salon comptait jusqu'ici pour
 * éviter les répétitions : les autres joueurs du salon pouvaient très bien retomber sur des
 * films qu'ils venaient eux-mêmes de voir dans une partie précédente. Ce filet de sécurité
 * partagé réduit ce cas sans avoir à connaître à l'avance tous les joueurs d'un salon.
 */
const recemmentServis = new Map();          // id de film -> horodatage du dernier tirage
const COOLDOWN_SERVI_MS = 3 * 60 * 60 * 1000; // 3 h : large sur un petit catalogue, discret sur un grand

function purgerServisRecents() {
  const limite = Date.now() - COOLDOWN_SERVI_MS;
  for (const [id, t] of recemmentServis) if (t < limite) recemmentServis.delete(id);
}
function marquerServis(films) {
  const maintenant = Date.now();
  for (const f of films) recemmentServis.set(f.id, maintenant);
}

/**
 * Parmi un ensemble de films déjà filtré (indemnes de répétition), plafonne la part de films
 * français à REGLAGES.ratioFilmsFrancaisMax % et comble le reste avec l'international (et les
 * films non classés, qui ne sont pénalisés ni favorisés). Ne raccourcit jamais une manche : si le
 * vivier international est insuffisant pour atteindre `nombre`, on repuise dans le reste des
 * films français plutôt que de livrer moins de films que demandé.
 */
function tirerAvecEquilibreOrigine(pool, nombre) {
  const ratioMax = Math.min(1, Math.max(0, (REGLAGES.ratioFilmsFrancaisMax ?? 100) / 100));
  const francais = melange(pool.filter((m) => m.origine === "france"));
  const autres = melange(pool.filter((m) => m.origine !== "france"));
  const maxFrancais = Math.min(francais.length, Math.ceil(nombre * ratioMax));

  const choisis = [...francais.slice(0, maxFrancais), ...autres.slice(0, nombre - maxFrancais)];
  if (choisis.length < nombre) {
    // L'international (+ non classés) ne suffit pas à compléter : on repuise dans le reste des
    // films français déjà écartés par le plafond, plutôt que de jouer une manche plus courte.
    const resteFrancais = francais.slice(maxFrancais);
    choisis.push(...resteFrancais.slice(0, nombre - choisis.length));
  }
  return melange(choisis).slice(0, nombre);
}

/**
 * Sélectionne des films en évitant ceux déjà vus récemment par le joueur (et, dans la mesure du
 * possible, ceux servis à n'importe qui il y a peu), puis équilibre la part de films français /
 * internationaux du tirage. Sans anti-répétition, un tirage purement aléatoire ramène
 * statistiquement les mêmes titres bien plus souvent que ne le perçoit un joueur — c'est le
 * reproche le plus fréquent sur ce type de jeu, avec celui d'un catalogue trop mono-national.
 */
function choisirFilms(vivier, nombre, userId) {
  purgerServisRecents();
  const vus = new Set(historiqueVus(userId));
  const dispoBase = vivier.filter((m) => !vus.has(m.id));
  // On essaie d'abord d'éviter aussi ce qui vient d'être servi à d'autres joueurs, mais seulement
  // si ça laisse assez de choix — sinon on revient au filtrage simple plutôt que de bloquer la partie.
  const dispoFrais = dispoBase.filter((m) => !recemmentServis.has(m.id));
  const dispo = dispoFrais.length >= nombre ? dispoFrais : dispoBase;

  let choix;
  if (dispo.length >= nombre) {
    choix = tirerAvecEquilibreOrigine(dispo, nombre);
  } else {
    // Pas assez d'inédits pour ce joueur : on complète avec les films déjà vus, les plus
    // anciennement vus en priorité — toujours en essayant de respecter l'équilibre d'origine.
    const anciens = melange(vivier.filter((m) => vus.has(m.id)));
    choix = [...tirerAvecEquilibreOrigine(dispo, dispo.length), ...anciens].slice(0, nombre);
  }
  marquerServis(choix);
  return choix;
}

/** Films récemment vus par un joueur, du plus ancien au plus récent. */
function historiqueVus(userId) {
  return vusParJoueur.get(userId) || [];
}

/**
 * Mémorise les films joués. La fenêtre couvre la moitié du catalogue :
 * un joueur ne revoit un film qu'après en avoir vu des centaines d'autres.
 */
function memoriserVus(userId, films) {
  const taille = Math.max(50, Math.floor(movies.length / 2));
  const liste = [...historiqueVus(userId), ...films.map((m) => m.id)];
  vusParJoueur.set(userId, liste.slice(-taille));
  sauver("vus", Object.fromEntries(vusParJoueur));
}

const vusParJoueur = new Map();

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
    roundIndex: room.roundIndex,
    players: [...room.players.values()].map((p) => ({
      id: p.id, userId: p.userId, pseudo: p.pseudo, avatar: p.avatar, score: p.score,
      team: p.team, hasAnswered: p.hasAnswered, online: p.online !== false,
      fondateur: Boolean(p.fondateur), bot: Boolean(p.bot),
      // Diffusés à tout le salon (pas seulement au joueur concerné) pour permettre
      // l'affichage permanent des cœurs des adversaires en duel / équipes.
      coeurs: p.coeurs, coeursMax: p.coeursMax,
      // Confirmation de présence avant le lancement : un bot est toujours « prêt »
      // (il ne peut pas cliquer lui-même), un joueur humain doit le confirmer.
      pret: Boolean(p.pret) || Boolean(p.bot),
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

/**
 * Cœur de la mise en pause / reprise d'un salon en cours de partie — utilisé à la fois par
 * l'hôte (pause manuelle depuis son écran) et par l'administration (pause groupée avant un
 * déploiement, voir /api/admin/maintenance/pause-toutes). Renvoie true si l'action a bien eu
 * lieu, false si le salon n'était pas dans le bon état (déjà en pause, partie non lancée...).
 */
function pauserSalon(room, par) {
  if (!room || room.status !== "playing" || room.pauseA) return false;
  room.pauseA = Date.now();
  clearTimeout(room.timer);
  if (room.graceTimer) {
    room.graceRestant = Math.max(0, CONFIG.GRACE_AFTER_FIRST_MS - (Date.now() - (room.graceDebut || 0)));
    clearTimeout(room.graceTimer);
  }
  const reste = Math.max(0, CONFIG.ROUND_DURATION_MS - (room.pauseA - room.startedAt));
  io.to(room.code).emit("game:paused", { enPause: true, reste, par });
  return true;
}

function reprendreSalon(room) {
  if (!room || !room.pauseA) return false;
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
  return true;
}

/**
 * Diffuse un événement aux seuls spectateurs d'une partie (ceux qui la
 * regardent en direct), sur des noms d'événements dédiés — jamais les mêmes
 * que ceux des joueurs, pour ne jamais interférer avec leur écran de jeu.
 */
function diffuserSpectateurs(room, event, payload) {
  if (!room.spectateurs || !room.spectateurs.size) return;
  for (const socketId of room.spectateurs.keys()) io.to(socketId).emit(event, payload);
}

/** Même mécanisme que diffuserSpectateurs(), mais pour une partie solo/classée (sans salon). */
function diffuserSpectateursSolo(p, event, payload) {
  if (!p.spectateurs || !p.spectateurs.size) return;
  for (const socketId of p.spectateurs.keys()) io.to(socketId).emit(event, payload);
}

/**
 * À l'inverse de diffuserSpectateurs() : prévient les JOUEURS (jamais les
 * spectateurs eux-mêmes) de qui les regarde en ce moment, pour l'afficher
 * dans un coin de l'écran. Simple liste de pseudos, mise à jour à chaque
 * arrivée ou départ d'un spectateur.
 */
function diffuserListeSpectateurs(room) {
  const noms = room.spectateurs ? [...room.spectateurs.values()].map((s) => s.pseudo).filter(Boolean) : [];
  io.to(room.code).emit("spectateurs:liste", { noms });
}

/** Même chose pour une partie solo/classée : il n'y a qu'un seul joueur à prévenir. */
function diffuserListeSpectateursSolo(userId, p) {
  const noms = p.spectateurs ? [...p.spectateurs.values()].map((s) => s.pseudo).filter(Boolean) : [];
  for (const [, s] of io.of("/").sockets)
    if (s.data.user?.id === userId) s.emit("spectateurs:liste", { noms });
}

/** Un ami est-il en train de jouer, en salon comme en solo/classée ? */
function joueurEnPartie(userId) {
  // partageActif : le joueur a coché « Partager ma partie » dans son profil — sans ça,
  // même en partie, ses amis ne doivent pas voir le bouton « Regarder en direct ».
  const partageActif = partageJeuActif(userId);
  const room = salonDuJoueur(userId);
  if (room) return { enPartie: true, modeSalon: room.mode, partageActif };
  const p = parties.get(userId);
  if (p) return { enPartie: true, modeSalon: p.mode, partageActif };
  return { enPartie: false, modeSalon: null, partageActif };
}

/* ------------------------------------------------------------------ */
/* Boucle de jeu                                                       */
/* ------------------------------------------------------------------ */

/**
 * Programme la réponse d'un bot pour la manche en cours : délai de réflexion aléatoire
 * (borné à la durée de la manche) puis clic simulé, correct ou non selon sa précision.
 */
function planifierReponseBot(room, bot) {
  const config = BOT_NIVEAUX[bot.botNiveau] || BOT_NIVEAUX.moyen;
  const correct = Math.random() < config.precision;
  const autres = room.choices.filter((c) => c.id !== room.currentMovie.id);
  const choiceId = (correct || !autres.length)
    ? room.currentMovie.id
    : autres[Math.floor(Math.random() * autres.length)].id;
  const delaiBrut = config.delaiMin + Math.random() * (config.delaiMax - config.delaiMin);
  const delai = Math.max(400, Math.min(delaiBrut, CONFIG.ROUND_DURATION_MS - 1200));
  const manche = room.roundIndex;   // pour ignorer ce minuteur si la manche a déjà changé
  clearTimeout(bot.timerReponse);
  bot.timerReponse = setTimeout(() => {
    if (room.roundIndex !== manche || room.status !== "playing") return;
    traiterReponseBot(room, bot, choiceId);
  }, delai);
}

/**
 * Fait « répondre » un bot après son délai de réflexion — reprend exactement la même logique
 * de score/cœurs/fin de manche que answer:submit en mode « par clic », sans passer par un
 * socket puisque le bot n'en a pas.
 */
function traiterReponseBot(room, bot, choiceId) {
  if (!room || !bot || room.status !== "playing" || bot.hasAnswered || bot.coeurs === 0) return;
  const correct = Number(choiceId) === room.currentMovie.id;

  if (!correct) {
    bot.hasAnswered = true;
    bot.coeurs = Math.max(0, (bot.coeurs ?? bot.coeursMax) - 1);
    io.to(room.code).emit("player:answered", { id: bot.id, pseudo: bot.pseudo, team: bot.team, points: 0,
      coeurs: bot.coeurs, coeursMax: bot.coeursMax });
    io.to(room.code).emit("room:update", publicState(room));
    botDire(room, bot, "mauvaiseReponse");
    if ([...room.players.values()].every((p) => p.hasAnswered)) endRound(room);
    return;
  }

  bot.hasAnswered = true;
  let points = computeScore({ elapsedMs: Date.now() - room.startedAt, hintsUsed: bot.paidHints });
  points = Math.max(30, Math.round(points * CONFIG.CHOICE_RATIO));
  bot.score += points;
  io.to(room.code).emit("player:answered", { id: bot.id, pseudo: bot.pseudo, team: bot.team, points,
    coeurs: bot.coeurs, coeursMax: bot.coeursMax });
  botDire(room, bot, "bonneReponse");

  const tousTrouve = [...room.players.values()].every((p) => p.hasAnswered || p.coeurs === 0);
  if (tousTrouve) return endRound(room);

  if (!room.graceTimer) {
    room.graceDebut = Date.now();
    room.graceTimer = setTimeout(() => endRound(room), CONFIG.GRACE_AFTER_FIRST_MS);
    io.to(room.code).emit("round:grace", { ms: CONFIG.GRACE_AFTER_FIRST_MS, pseudo: bot.pseudo });
  }
}

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
  for (const p of room.players.values()) {
    if (p.coeurs === undefined) p.coeurs = p.coeursMax ?? REGLAGES.coeurs;
    // Cœurs épuisés : éliminé pour le reste de la partie — on ne le sollicite plus à
    // chaque manche, il ne peut plus que suivre la partie ou quitter le salon.
    p.hasAnswered = p.coeurs === 0;
    p.hints = [];
    p.paidHints = [];
  }

  io.to(room.code).emit("round:start", {
    roundIndex: room.roundIndex,
    total: room.playlist.length,
    synopsis: masquerReponse(movie.synopsis, movie),   // aucun mot du titre ne transparaît
    duration: CONFIG.ROUND_DURATION_MS,
    hintCosts: CONFIG.HINT_COSTS,
    hintCredits: CONFIG.HINT_CREDITS,
    hintLabels: libellesIndices(),
    posterStyle: styleAffiche(movie),
    vitesseSynopsis: REGLAGES.vitesseSynopsis,
    choices: room.choices,
  });
  diffuserSpectateurs(room, "regarder:manche", {
    roundIndex: room.roundIndex,
    total: room.playlist.length,
    synopsis: masquerReponse(movie.synopsis, movie),
    duration: CONFIG.ROUND_DURATION_MS,
    posterStyle: styleAffiche(movie),
    vitesseSynopsis: REGLAGES.vitesseSynopsis,
    choices: room.choices,
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room), CONFIG.ROUND_DURATION_MS);

  // Les bots encore en jeu « réfléchissent » puis répondent tout seuls, avec un délai et une
  // précision qui dépendent du niveau choisi par l'hôte.
  for (const p of room.players.values()) {
    if (p.bot && p.coeurs > 0) planifierReponseBot(room, p);
  }

  // Remet à jour l'état public (cœurs inclus) pour l'affichage permanent des
  // adversaires en duel / équipes, dès le début de la manche.
  io.to(room.code).emit("room:update", publicState(room));

  for (const p of room.players.values()) {
    io.to(p.id).emit("player:round_info", {
      coeursMax: p.coeursMax,
      coeurs: p.coeurs,
      freeHintsRemaining: p.freeHintsRemaining,
      allHintsFree: p.allHintsFree
    });
  }
}

function endRound(room) {
  if (room.status !== "playing") return;   // évite un double appel timer + grâce
  clearTimeout(room.timer);
  clearTimeout(room.graceTimer);
  room.graceTimer = null;

  // Le seul cas où un cœur est préservé, c'est de donner la bonne réponse (voir answer:submit) :
  // une mauvaise réponse en coûte un (answer:submit), passer volontairement aussi (round:skip), et
  // ne pas répondre du tout avant la fin du temps imparti doit se comporter pareil — sans ce
  // rattrapage, un joueur qui restait simplement silencieux gardait tous ses cœurs indéfiniment,
  // manche après manche, ce qui n'est pas la règle voulue. Les bots ne sont jamais concernés : leur
  // propre minuteur (voir planifierReponseBot) répond toujours avant celui-ci.
  for (const p of room.players.values()) {
    if (p.bot || p.hasAnswered || p.coeurs === 0) continue;
    p.hasAnswered = true;
    p.coeurs = Math.max(0, (p.coeurs ?? p.coeursMax) - 1);
    const s = [...io.of("/").sockets.values()].find((sk) => sk.data.user?.id === p.userId);
    if (s) s.emit("coeurs:maj", { coeurs: p.coeurs, elimine: p.coeurs === 0 });
    io.to(room.code).emit("player:answered", { id: p.id, pseudo: p.pseudo, team: p.team, points: 0,
      coeurs: p.coeurs, coeursMax: p.coeursMax });
  }

  io.to(room.code).emit("round:end", {
    answer: room.currentMovie.title,
    movieId: room.currentMovie.id,
    poster: room.currentMovie.poster,   // affiche révélée seulement maintenant
    year: room.currentMovie.year,
    scores: publicState(room).players,
    isHost: room.hostId,
    mode: room.mode,
  });
  diffuserSpectateurs(room, "regarder:fin", {
    answer: room.currentMovie.title,
    poster: room.currentMovie.poster,
    year: room.currentMovie.year,
    scores: publicState(room).players,
    mode: room.mode,
  });
  // Petit partage dans le bandeau défilant de tout le monde : qui a trouvé le film en premier,
  // avec sa photo — cliquer dessus ouvre sa fiche. Diffusé seulement maintenant que la réponse
  // vient d'être révélée à toute la salle (jamais avant, ça donnerait la solution aux autres).
  if (room.premierTrouveur) {
    diffuserAnnonce(`🎬 ${room.premierTrouveur.pseudo} a trouvé « ${room.currentMovie.title} » !`, "partage", {
      joueurId: room.premierTrouveur.userId,
      joueurPseudo: room.premierTrouveur.pseudo,
      joueurAvatar: room.premierTrouveur.avatar,
      joueurPhoto: room.premierTrouveur.photo,
      filmTitre: room.currentMovie.title,
    });
    room.premierTrouveur = null;
  }
  room.roundIndex++;
  room.status = "intermission";
  room.nextTimer = setTimeout(() => startRound(room), 12000);   // doublé : laisse plus de temps pour voir la réponse
}

/**
 * Fusionne les deux salons vocaux d'équipe (ouverts pendant la partie via vocal:equipe-ouvrir) en
 * un seul à la fin d'une partie « en équipes », pour un bilan convivial où tout le monde peut se
 * parler. Ne fait rien si une seule équipe (ou aucune) avait ouvert un salon — rien à fusionner.
 * Le salon de l'équipe A devient le salon commun ; ceux de l'équipe B y sont ajoutés (leur hôte
 * devient cohôte, les autres intervenants) pour que tout le monde puisse parler immédiatement.
 */
function fusionnerSalonsVocauxEquipe(room) {
  const codes = room.salonsVocauxEquipe;
  if (!codes || !codes.A || !codes.B || codes.A === codes.B) return;
  const salonA = vocalSalon.salonsVocaux.get(codes.A);
  const salonB = vocalSalon.salonsVocaux.get(codes.B);
  if (!salonA || !salonB) return;

  salonA.titre = `🏆 Résultat final — partie ${room.code}`;
  // Les deux fils de discussion fusionnent aussi, triés chronologiquement, pour ne perdre aucun
  // message échangé pendant la partie dans l'un ou l'autre salon d'équipe.
  salonA.chat = [...(salonA.chat || []), ...(salonB.chat || [])]
    .sort((a, b) => a.at - b.at)
    .slice(-vocalSalon.VOCAL_CHAT_HISTORIQUE_MAX);
  for (const [uid, p] of salonB.participants) {
    if (!salonA.participants.has(uid)) {
      salonA.participants.set(uid, { ...p, role: p.role === "hote" ? "cohote" : "intervenant", parle: false });
    }
    const s = [...io.of("/").sockets.values()].find((sk) => sk.data.user?.id === uid);
    if (s) {
      s.leave(`vocal:${salonB.code}`);
      s.join(`vocal:${salonA.code}`);
      // Émis directement au socket (plutôt qu'à la salle vocal:${salonB.code}, qu'il vient de
      // quitter) : c'est ce qui déclenche côté client la bascule vers le salon commun et la
      // reconnexion audio (WebRTC) vers les participants qui n'y étaient pas encore.
      s.emit("vocal:fusionne", { salon: vocalSalon.publicVocal(salonA) });
    }
  }
  vocalSalon.salonsVocaux.delete(salonB.code);
  vocalSalon.diffuserVocal(salonA);
  diffuserAnnonce("🎉 Les deux salons vocaux d'équipe se réunissent pour un bilan convivial !", "equipe");
}

function endGame(room) {
  room.status = "finished";
  const state = publicState(room);
  const ranking = state.players.sort((a, b) => b.score - a.score);
  for (const p of room.players.values()) {
    if (room.mode === "ranked") addRankedPoints(p.userId, p.score); // classement permanent
    grantPoints(p.userId, p.score);                                  // cagnotte échangeable
    grantCredits(p.userId, REGLAGES.creditsParPartie);
    if (p.score) enregistrerTransaction(p.userId, p.score, "points", "Partie terminée");
    if (REGLAGES.creditsParPartie) enregistrerTransaction(p.userId, REGLAGES.creditsParPartie, "credits", "Partie terminée");

    const vainqueur = ranking[0]?.id === p.id;
    const xp = REGLAGES.xpParPartie + (vainqueur ? REGLAGES.xpParVictoire : 0);
    const niveau = ajouterXp(p.userId, xp, reglagesNiveau());
    avancerQuete(p.userId, "jouer3");
    avancerQueteGlobale(p.userId, "jouerParties");
    if (p.coeurs !== undefined && p.coeurs === p.coeursMax) avancerQueteGlobale(p.userId, "sansFauteGlobal");
    // Défi « battre un Hardcore en duel » : un adversaire (parmi les autres joueurs du salon,
    // donc l'unique adversaire en duel) doté d'un bot de niveau Hardcore, et une victoire.
    if (room.mode === "duel" && vainqueur &&
        [...room.players.values()].some((o) => o.userId !== p.userId && o.bot && o.botNiveau === "hardcore"))
      avancerQueteGlobale(p.userId, "battreHardcoreDuel");
    p.bilan = { xp, niveau, vainqueur, ticketsGagnes: REGLAGES.creditsParPartie };

    verifierCodeParrain(p.userId);
    // Petit mot de la fin pour les bots — fier s'ils gagnent, beau joueur sinon.
    if (p.bot) botDire(room, p, vainqueur ? "victoire" : "defaite", 0.7);
  }
  for (const p of room.players.values())
    io.to(p.id).emit("game:end", { ranking, mode: room.mode, teams: state.teams,
      credits: getCredits(p.userId), points: getPoints(p.userId), bilan: p.bilan });
  // Diffusion à ceux qui regardaient en direct (pas de gains, juste la fin de partie).
  diffuserSpectateurs(room, "regarder:termine", { ranking, mode: room.mode, teams: state.teams });
  // Petite fanfare dans le bandeau défilant de tout le monde quand une équipe l'emporte
  // (rien à annoncer en cas d'égalité parfaite).
  if (room.mode === "teams" && state.teams && state.teams.A !== state.teams.B) {
    const gagnante = state.teams.A > state.teams.B ? "🟡 L'équipe jaune" : "🔷 L'équipe turquoise";
    diffuserAnnonce(`${gagnante} remporte la partie ! 🏆`, "equipe");
  }
  if (room.mode === "teams") fusionnerSalonsVocauxEquipe(room);
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
  if (parrainageManquant(user)) return next(new Error("PARRAINAGE_REQUIS"));
  if (!user.pseudoChosen) return next(new Error("NO_PSEUDO")); // ni sans pseudo choisi
  socket.data.user = user;
  next();
});

/**
 * Diffuse le nombre de joueurs en ligne à chaque socket, en excluant son propre
 * titulaire du compte : sinon chacun se voit lui-même comptabilisé, ce qui fausse
 * le total par rapport à la liste des AUTRES joueurs affichée à l'écran.
 */
function diffuserPresence() {
  for (const [, s] of io.of("/").sockets) {
    const uid = s.data.user?.id;
    if (!uid) continue;
    const amis = relations(uid)?.amis || [];
    s.emit("presence", { enLigne: amis.filter((a) => a.online).length });
  }
}

io.on("connection", (socket) => {
  const user = socket.data.user;
  marquerEnLigne(user.id);
  diffuserPresence();

  // Notify friends that this user just connected
  const mesRelations = relations(user.id);
  if (mesRelations && mesRelations.amis) {
      for (const ami of mesRelations.amis) {
          for (const [, s] of io.of("/").sockets) {
              if (s.data.user?.id === ami.id) {
                  s.emit("notif", {
                      type: "friend_online",
                      de: user.pseudo,
                      avatar: user.avatar,
                      photo: user.photo || null,
                      id: user.id
                  });
              }
          }
      }
  }

  socket.on("disconnect", () => {
    marquerHorsLigne(user.id);
    diffuserPresence();
  });

  socket.on("room:create", ({ rounds, mode, kids }, cb) => {
    // Mode maintenance : on bloque uniquement la CRÉATION de nouveaux salons (les parties déjà
    // lancées continuent normalement) — le temps qu'un déploiement se termine sans perdre de partie.
    if (annonceConfig.maintenance) return cb?.({ ok: false, error: "MAINTENANCE" });

    // Un compte ne doit jamais se retrouver hôte de deux salons à la fois : un salon
    // abandonné sans départ propre (page rechargée, onglet fermé sans clic "quitter")
    // créerait sinon une partie fantôme en double. On nettoie d'abord son ancien salon.
    leaveAllRooms(socket, true);

    // Un compte enfant crée forcément un salon en mode enfant, quoi qu'envoie le client.
    const compteEnfant = user.role === "enfant";
    // Filtre de films "enfant" : forcé pour un compte enfant, ou activé volontairement par un adulte
    // (contenu familial). Ceci est indépendant de la présence réelle d'un compte enfant dans le salon.
    const modeEnfant = compteEnfant ? true : kids === true;
    let vivier = movies.filter((m) => m.enabled !== false);
    if (modeEnfant) vivier = vivier.filter((m) => m.kids === true);
    if (vivier.length === 0) return cb?.({ ok: false, error: modeEnfant ? "NO_MOVIES_KIDS" : "NO_MOVIES" });

    const code = generateRoomCode();
    const count = Math.min(Number(rounds) || 10, vivier.length);
    const room = {
      code, hostId: user.id, status: "lobby", roundIndex: 0,
      mode: ["solo", "ffa", "duel", "teams", "ranked"].includes(mode) ? mode : "ffa",
      kids: modeEnfant,
      // Isolation stricte : un salon créé par un compte enfant ne peut accueillir que des comptes enfants,
      // et inversement. Distinct de "kids" (qui ne filtre que le catalogue de films).
      compteEnfant,
      players: new Map(),
      playlist: choisirFilms(vivier, count, user.id),
      currentMovie: null, startedAt: null, timer: null, nextTimer: null, graceTimer: null, emptyTimer: null,
    };
    memoriserVus(user.id, room.playlist);
    rooms.set(code, room);
    joinRoom(socket, room, user);
    cb?.({ ok: true, code, state: publicState(room) });
    if (room.mode === "solo" || room.mode === "ranked") {
        startRound(room); // le solo démarre immédiatement
    } else {
        // Mode multijoueur : on notifie automatiquement les amis en ligne
        const mesRelations = relations(user.id);
        if (mesRelations && mesRelations.amis) {
            for (const ami of mesRelations.amis) {
                for (const [, s] of io.of("/").sockets) {
                    if (s.data.user?.id === ami.id) {
                        s.emit("invite:recue", {
                            code: room.code,
                            mode: room.mode,
                            de: user.pseudo,
                            avatar: user.avatar,
                            joueurs: 1
                        });
                    }
                }
            }
        }
    }
  });

  socket.on("room:join", ({ code }, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    // Séparation stricte enfant / adulte : un compte enfant ne peut rejoindre qu'un salon créé par un
    // compte enfant, et un compte adulte ne peut jamais rejoindre un salon créé par un compte enfant.
    if (user.role === "enfant" && !room.compteEnfant) return cb?.({ ok: false, error: "ENFANT_MODE_ENFANT_UNIQUEMENT" });
    if (user.role !== "enfant" && room.compteEnfant) return cb?.({ ok: false, error: "ADULTE_SALON_ENFANT_INTERDIT" });

    const existingPlayer = room.players.get(user.id);
    const enCours = room.status !== "lobby";

    if (!existingPlayer) {
      // Rejoindre un nouveau salon (ex. accepter l'invitation d'un ami) nettoie
      // d'abord toute appartenance à un autre salon : sinon un joueur qui avait déjà
      // le sien ouvert se retrouve fantôme dans les deux à la fois — une des causes
      // des « parties en double ». Sans effet sur ce salon-ci, puisqu'il n'y est pas.
      leaveAllRooms(socket, true);
    }

    if (existingPlayer) {
       existingPlayer.id = socket.id;
       existingPlayer.online = true;
       // Une reconnexion (coupure réseau, mise en veille…) annule le compte à rebours
       // de suppression du salon vide déclenché par la déconnexion précédente.
       clearTimeout(room.emptyTimer);
       room.emptyTimer = null;
       socket.join(room.code);
       io.to(room.code).emit("room:update", publicState(room));

       cb?.({ ok: true, code: room.code, state: publicState(room), waiting: enCours && existingPlayer.hasAnswered,
           roundIndex: room.roundIndex, total: room.playlist.length });

       // Réémis aussi pour un joueur éliminé (cœurs à 0) qui se reconnecte : il ne peut plus
       // répondre, mais doit pouvoir suivre la manche en cours plutôt que rester sur un écran
       // vide — le client bascule automatiquement sur l'écran « éliminé » via state.elimine.
       if (room.status === "playing" && (!existingPlayer.hasAnswered || existingPlayer.coeurs === 0)) {
          const movie = room.currentMovie;
          io.to(socket.id).emit("round:start", {
            roundIndex: room.roundIndex,
            total: room.playlist.length,
            synopsis: masquerReponse(movie.synopsis, movie),
            duration: CONFIG.ROUND_DURATION_MS,
            hintCosts: CONFIG.HINT_COSTS,
            hintCredits: CONFIG.HINT_CREDITS,
            hintLabels: libellesIndices(),
            posterStyle: styleAffiche(movie),
            vitesseSynopsis: REGLAGES.vitesseSynopsis,
            choices: room.choices,
          });
          io.to(socket.id).emit("player:round_info", {
            coeursMax: existingPlayer.coeursMax,
            coeurs: existingPlayer.coeurs,
            freeHintsRemaining: existingPlayer.freeHintsRemaining,
            allHintsFree: existingPlayer.allHintsFree
          });
       } else if (room.status === "intermission" && room.currentMovie) {
          // Reconnecté pendant l'entracte : on rejoue la révélation de la manche
          // qui vient de se terminer, sinon l'écran resterait figé jusqu'à la suivante.
          io.to(socket.id).emit("round:end", {
            answer: room.currentMovie.title,
            movieId: room.currentMovie.id,
            poster: room.currentMovie.poster,
            year: room.currentMovie.year,
            scores: publicState(room).players,
            isHost: room.hostId,
            mode: room.mode,
          });
       }
       return;
    }
    
    const limit = room.mode === "duel" ? 2 : CONFIG.MAX_PLAYERS;
    if (room.players.size >= limit) return cb?.({ ok: false, error: "ROOM_FULL" });
    if (room.status === "finished") return cb?.({ ok: false, error: "GAME_OVER" });

    joinRoom(socket, room, user);
    if (enCours) room.players.get(user.id).hasAnswered = true; // n'entre qu'à la manche suivante
    cb?.({ ok: true, code: room.code, state: publicState(room), waiting: enCours,
           roundIndex: room.roundIndex, total: room.playlist.length });
  });

  socket.on("team:choose", ({ code, team }) => {
    const room = rooms.get(code);
    const player = room?.players.get(socket.data.user.id);
    if (!room || !player || room.status !== "lobby" || !["A", "B"].includes(team)) return;
    player.team = team;
    io.to(room.code).emit("room:update", publicState(room));
  });

  /** Confirmation de présence avant le lancement : chacun coche « je suis prêt »,
   *  l'hôte ne peut lancer la partie qu'une fois tout le monde prêt (les bots le
   *  sont automatiquement). Évite qu'une manche démarre avec quelqu'un pas installé. */
  socket.on("room:pret", ({ code, pret }) => {
    const room = rooms.get(code);
    const player = room?.players.get(socket.data.user.id);
    if (!room || !player || room.status !== "lobby" || player.bot) return;
    player.pret = Boolean(pret);
    io.to(room.code).emit("room:update", publicState(room));
  });

  socket.on("game:start", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || !estHote(room, socket.data.user.id) || room.status !== "lobby") return cb?.({ ok: false });
    const nonPrets = [...room.players.values()].filter((p) => !p.bot && !p.pret);
    if (nonPrets.length)
      return cb?.({ ok: false, error: "JOUEURS_PAS_PRETS", manquants: nonPrets.map((p) => p.pseudo) });
    startRound(room);
    cb?.({ ok: true });
  });

  /** Ajoute un bot au salon (duel ou chacun-pour-soi) : pratique quand personne d'autre
   *  n'est disponible pour rejoindre. Réservé à l'hôte, avant le lancement de la partie. */
  socket.on("room:add-bot", ({ code, niveau }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    // Duel : un seul bot (adversaire unique). Chacun pour soi : plusieurs bots pour remplir la
    // partie quand personne d'autre n'est dispo, jusqu'à MAX_BOTS_FFA à la fois.
    if (!["duel", "ffa"].includes(room.mode)) return cb?.({ ok: false, error: "MODE_INVALIDE" });
    if (room.status !== "lobby") return cb?.({ ok: false, error: "DEJA_COMMENCE" });
    if (!estHote(room, socket.data.user.id)) return cb?.({ ok: false, error: "PAS_HOTE" });
    const limiteSalon = room.mode === "duel" ? 2 : CONFIG.MAX_PLAYERS;
    if (room.players.size >= limiteSalon) return cb?.({ ok: false, error: "SALON_COMPLET" });
    if (room.mode === "ffa") {
      const nbBotsActuels = [...room.players.values()].filter((p) => p.bot).length;
      if (nbBotsActuels >= MAX_BOTS_FFA) return cb?.({ ok: false, error: "MAX_BOTS_ATTEINT", max: MAX_BOTS_FFA });
    }

    const niveauBot = BOT_NIVEAUX[niveau] ? niveau : "moyen";
    const botId = `bot-${crypto.randomUUID()}`;
    const bot = {
      id: botId, userId: botId, pseudo: nomBotAleatoire(), avatar: BOT_NIVEAUX[niveauBot].emoji,
      photo: null, fondateur: false, team: null,
      score: 0, hints: [], paidHints: [], hasAnswered: false,
      coeursMax: REGLAGES.coeurs, coeurs: REGLAGES.coeurs,
      freeHintsRemaining: 0, allHintsFree: false,
      online: true, bot: true, botNiveau: niveauBot,
    };
    room.players.set(botId, bot);
    io.to(room.code).emit("room:update", publicState(room));
    cb?.({ ok: true, state: publicState(room) });
    // Petit mot d'ambiance à l'arrivée du bot dans le salon — pas la peine d'attendre le début
    // de la partie pour lui donner un peu de personnalité.
    botDire(room, bot, "intro", 0.8);
  });

  /** Retire un ou plusieurs bots du salon (avant le lancement), au cas où l'hôte change d'avis.
   *  En duel il n'y en a qu'un, donc on les retire tous par simplicité (comportement historique).
   *  En chacun-pour-soi, un `botId` précis ne retire que ce bot-là et laisse les autres jouer ;
   *  sans `botId` (par exemple un bouton "retirer tous les bots"), on les enlève tous. */
  socket.on("room:remove-bot", ({ code, botId }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.status !== "lobby") return cb?.({ ok: false, error: "DEJA_COMMENCE" });
    if (!estHote(room, socket.data.user.id)) return cb?.({ ok: false, error: "PAS_HOTE" });
    if (botId) {
      const p = room.players.get(botId);
      if (p?.bot) { clearTimeout(p.timerReponse); room.players.delete(botId); }
    } else {
      for (const [id, p] of room.players) {
        if (p.bot) { clearTimeout(p.timerReponse); room.players.delete(id); }
      }
    }
    io.to(room.code).emit("room:update", publicState(room));
    cb?.({ ok: true, state: publicState(room) });
  });

  socket.on("hint:buy", ({ code, type }, cb) => {
    const room = rooms.get(code);
    const player = room?.players.get(socket.data.user.id);
    if (!room || !player || room.status !== "playing") return cb?.({ ok: false });
    if (room.pauseA) return cb?.({ ok: false, error: "EN_PAUSE" });
    if (!CONFIG.HINT_COSTS[type]) return cb?.({ ok: false, error: "UNKNOWN_HINT" });
    if (player.hints.includes(type)) return cb?.({ ok: false, error: "ALREADY_BOUGHT" });

    const isFree = player.allHintsFree || player.freeHintsRemaining > 0;
    if (!isFree) {
      if (!spendCredits(player.userId, CONFIG.HINT_CREDITS[type]))
        return cb?.({ ok: false, error: "NO_CREDITS" });
      enregistrerTransaction(player.userId, -CONFIG.HINT_CREDITS[type], "credits",
        `Indice « ${REGLAGES.indices?.[type]?.libelle || type} »`);
      player.paidHints.push(type);
    } else {
      if (!player.allHintsFree) player.freeHintsRemaining--;
    }

    player.hints.push(type);
    const value =
      type === "poster" ? (room.currentMovie.still || room.currentMovie.poster) // sans titre imprimé
    : type === "letters" ? titlePattern(room.currentMovie.title)
    : room.currentMovie[type];
    cb?.({ ok: true, type, value, credits: getCredits(player.userId), freeHintsRemaining: player.freeHintsRemaining, allHintsFree: player.allHintsFree });
  });

  socket.on("answer:submit", ({ code, guess, choiceId }, cb) => {
    const room = rooms.get(code);
    const player = room?.players.get(socket.data.user.id);
    if (!room || !player || room.status !== "playing") return cb?.({ ok: false });
    // Cœurs épuisés : éliminé pour le reste de la partie, ne peut plus répondre — seulement
    // suivre la partie ou quitter le salon (voir aussi startRound, qui ne le sollicite plus).
    // Ce contrôle passe AVANT celui de hasAnswered (startRound met hasAnswered=true pour les
    // joueurs éliminés) afin que le client reçoive toujours un motif clair ("ELIMINE").
    if (player.coeurs === 0) return cb?.({ ok: false, error: "ELIMINE" });
    if (player.hasAnswered) return cb?.({ ok: false, error: "DEJA_REPONDU" });
    if (room.pauseA) return cb?.({ ok: false, error: "EN_PAUSE" });

    const parClic = choiceId !== undefined && choiceId !== null;
    const correct = parClic
      ? Number(choiceId) === room.currentMovie.id
      : room.currentMovie.acceptedAnswers.some((a) => normalize(a) === normalize(guess));

    // un clic est définitif : sinon il suffirait de cliquer les quatre cases
    if (!correct) {
      if (!parClic) return cb?.({ ok: true, correct: false });
      player.hasAnswered = true;
      player.coeurs = Math.max(0, (player.coeurs ?? player.coeursMax) - 1);
      io.to(room.code).emit("player:answered", { id: player.id, pseudo: player.pseudo, team: player.team, points: 0,
        coeurs: player.coeurs, coeursMax: player.coeursMax });
      io.to(room.code).emit("room:update", publicState(room));   // pour l'affichage permanent des cœurs adverses
      // Un bot du salon (s'il y en a) peut se moquer gentiment d'une mauvaise réponse — un seul à
      // la fois, même avec plusieurs bots en « chacun pour soi », pour ne pas noyer le chat.
      const botTaquin = botAuHasard(room);
      if (botTaquin) botDire(room, botTaquin, "adversaireRate", 0.3);
      if ([...room.players.values()].every((p) => p.hasAnswered)) endRound(room);
      return cb?.({ ok: true, correct: false, final: true,
                    coeurs: player.coeurs, elimine: player.coeurs === 0 });
    }

    player.hasAnswered = true;
    let points = computeScore({ elapsedMs: Date.now() - room.startedAt, hintsUsed: player.paidHints });
    if (parClic) points = Math.max(30, Math.round(points * CONFIG.CHOICE_RATIO));
    player.score += points;

    // Retenu pour le petit partage dans le bandeau défilant, diffusé seulement à la fin de la
    // manche (voir endRound) — jamais avant, pour ne pas donner la solution en cours de manche.
    if (!room.premierTrouveur) {
      room.premierTrouveur = { userId: player.userId, pseudo: player.pseudo, avatar: player.avatar, photo: player.photo || null };
    }

    cb?.({ ok: true, correct: true, points, movieId: room.currentMovie.id,
           coeurs: player.coeurs ?? player.coeursMax });
    io.to(room.code).emit("player:answered", { id: player.id, pseudo: player.pseudo, team: player.team, points,
      coeurs: player.coeurs, coeursMax: player.coeursMax });
    const botAdmiratif = botAuHasard(room);
    if (botAdmiratif) botDire(room, botAdmiratif, "adversaireReussit", 0.3);

    const tousTrouve = [...room.players.values()]
      .every((p) => p.hasAnswered || p.coeurs === 0);
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
    const player = room?.players.get(socket.data.user.id);
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
    const player = room?.players.get(socket.data.user.id);
    if (!room || !player || room.status !== "playing" || player.coeurs === 0) return;

    // renoncer à la manche coûte un cœur, comme une mauvaise réponse
    if (!player.hasAnswered) {
      player.hasAnswered = true;
      player.coeurs = Math.max(0, (player.coeurs ?? player.coeursMax) - 1);
      socket.emit("coeurs:maj", { coeurs: player.coeurs, elimine: player.coeurs === 0 });
      io.to(room.code).emit("player:answered", { id: player.id, pseudo: player.pseudo, team: player.team, points: 0,
        coeurs: player.coeurs, coeursMax: player.coeursMax });
      io.to(room.code).emit("room:update", publicState(room));   // pour l'affichage permanent des cœurs adverses
    }
    if ([...room.players.values()].every((p) => p.hasAnswered || p.coeurs === 0)) endRound(room);
  });

  /** Enchaîner sans attendre la fin de l'entracte. */
  socket.on("round:next", ({ code }) => {
    const room = rooms.get(code);
    if (!room || !room.players.has(socket.data.user.id) || room.status !== "intermission") return;
    if (!["solo", "ranked"].includes(room.mode) && !estHote(room, socket.data.user.id)) return; // l'hôte décide
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
    if (!room || !estHote(room, socket.data.user.id) || room.status !== "playing") return;
    if (reprendre) reprendreSalon(room);
    else pauserSalon(room, socket.data.user.pseudo);
  });

  // Tous les événements vocal:* (créer, rejoindre, quitter, réactions, radio, chat, etc.) sont
  // maintenant gérés par le module totalement indépendant vocal-salon.js — un seul point de
  // contact avec ce socket, voir attacherSocket() dans ce fichier.
  vocalSalon.attacherSocket(socket);

  /**
   * Ouvre (ou rejoint, si un coéquipier l'a déjà ouvert) un salon vocal réservé à toute son équipe
   * dans une partie « en équipes » en cours, et invite d'un coup tous les coéquipiers actuellement
   * dans la salle de jeu — sans exiger l'amitié, puisqu'ils jouent déjà ensemble. Le code du salon
   * de chaque équipe est mémorisé sur la salle de jeu (room.salonsVocauxEquipe) pour pouvoir fusionner
   * les deux salons d'équipe en un seul à la fin de la partie (voir endGame).
   */
  socket.on("vocal:equipe-ouvrir", ({ code }, cb) => {
    const room = rooms.get(code);
    const joueur = room?.players.get(user.id);
    if (!room || room.mode !== "teams" || !joueur || !joueur.team) return cb?.({ ok: false, error: "PAS_EQUIPE" });

    room.salonsVocauxEquipe = room.salonsVocauxEquipe || {};
    let salonCode = room.salonsVocauxEquipe[joueur.team];
    let salon = salonCode ? vocalSalon.salonsVocaux.get(salonCode) : null;

    if (!salon) {
      vocalSalon.quitterSalonVocal(socket);
      vocalSalon.retourVocalDisponible.delete(user.id);
      salonCode = vocalSalon.genererCodeVocal();
      salon = {
        code: salonCode, hostId: user.id,
        titre: `Équipe ${joueur.team === "A" ? "🟡" : "🔷"} — partie ${room.code}`,
        participants: new Map(),
        demandesMontee: new Set(),
        invites: new Map(),
        radio: null,
        chat: [],
        creeLe: Date.now(),
        salleDeJeu: room.code, equipe: joueur.team, // pour retrouver et fusionner les deux salons à la fin
      };
      salon.participants.set(user.id, {
        userId: user.id, pseudo: user.pseudo, avatar: user.avatar, photo: user.photo || null,
        role: "hote", mute: true, parle: false,
      });
      vocalSalon.salonsVocaux.set(salonCode, salon);
      socket.join(`vocal:${salonCode}`);
      room.salonsVocauxEquipe[joueur.team] = salonCode;
    } else if (!salon.participants.has(user.id)) {
      if (salon.participants.size >= vocalSalon.MAX_PARTICIPANTS_VOCAL()) return cb?.({ ok: false, error: "SALON_COMPLET" });
      vocalSalon.quitterSalonVocal(socket);
      vocalSalon.retourVocalDisponible.delete(user.id);
      salon.participants.set(user.id, {
        userId: user.id, pseudo: user.pseudo, avatar: user.avatar, photo: user.photo || null,
        role: "auditeur", mute: true, parle: false,
      });
      socket.join(`vocal:${salonCode}`);
    }

    // Invite d'un coup tous les coéquipiers présents dans la salle de jeu (respect des blocages).
    let invites = 0;
    for (const p of room.players.values()) {
      if (p.userId === user.id || p.team !== joueur.team || salon.participants.has(p.userId)) continue;
      if (estBloque(user.id, p.userId)) continue;
      salon.invites.set(p.userId, { de: user.pseudo, at: Date.now() });
      const s = [...io.of("/").sockets.values()].find((sk) => sk.data.user?.id === p.userId);
      if (s) {
        s.emit("vocal:invite-recue", {
          code: salonCode, titre: salon.titre, de: user.pseudo, avatar: user.avatar, photo: user.photo || null,
        });
        invites++;
      }
    }

    vocalSalon.diffuserVocal(salon);
    cb?.({ ok: true, code: salonCode, salon: vocalSalon.publicVocal(salon), invites });
  });

  /** Équivalent de vocal:equipe-ouvrir pour les modes sans équipes (duel, chacun pour soi,
   *  classée) : un seul salon partagé par tous les joueurs humains de la partie en cours, ouvert
   *  ou rejoint d'un clic pendant le jeu — sans avoir à interrompre la partie pour aller chercher
   *  un code dans le menu. */
  socket.on("vocal:partie-ouvrir", ({ code }, cb) => {
    const room = rooms.get(code);
    const joueur = room?.players.get(user.id);
    if (!room || room.mode === "teams" || !joueur) return cb?.({ ok: false, error: "INDISPONIBLE" });

    let salonCode = room.salonVocalPartie;
    let salon = salonCode ? vocalSalon.salonsVocaux.get(salonCode) : null;

    if (!salon) {
      vocalSalon.quitterSalonVocal(socket);
      vocalSalon.retourVocalDisponible.delete(user.id);
      salonCode = vocalSalon.genererCodeVocal();
      salon = {
        code: salonCode, hostId: user.id,
        titre: `Salon de la partie ${room.code}`,
        participants: new Map(),
        demandesMontee: new Set(),
        invites: new Map(),
        radio: null,
        chat: [],
        creeLe: Date.now(),
        salleDeJeu: room.code,
      };
      salon.participants.set(user.id, {
        userId: user.id, pseudo: user.pseudo, avatar: user.avatar, photo: user.photo || null,
        role: "hote", mute: true, parle: false,
      });
      vocalSalon.salonsVocaux.set(salonCode, salon);
      socket.join(`vocal:${salonCode}`);
      room.salonVocalPartie = salonCode;
    } else if (!salon.participants.has(user.id)) {
      if (salon.participants.size >= vocalSalon.MAX_PARTICIPANTS_VOCAL()) return cb?.({ ok: false, error: "SALON_COMPLET" });
      vocalSalon.quitterSalonVocal(socket);
      vocalSalon.retourVocalDisponible.delete(user.id);
      salon.participants.set(user.id, {
        userId: user.id, pseudo: user.pseudo, avatar: user.avatar, photo: user.photo || null,
        role: "auditeur", mute: true, parle: false,
      });
      socket.join(`vocal:${salonCode}`);
    }

    // Invite d'un coup tous les autres joueurs humains présents dans la salle de jeu.
    let invites = 0;
    for (const p of room.players.values()) {
      if (p.userId === user.id || p.bot || salon.participants.has(p.userId)) continue;
      if (estBloque(user.id, p.userId)) continue;
      salon.invites.set(p.userId, { de: user.pseudo, at: Date.now() });
      const s = [...io.of("/").sockets.values()].find((sk) => sk.data.user?.id === p.userId);
      if (s) {
        s.emit("vocal:invite-recue", {
          code: salonCode, titre: salon.titre, de: user.pseudo, avatar: user.avatar, photo: user.photo || null,
        });
        invites++;
      }
    }

    vocalSalon.diffuserVocal(salon);
    cb?.({ ok: true, code: salonCode, salon: vocalSalon.publicVocal(salon), invites });
  });

  // Le "disconnect" propre au salon vocal est déjà enregistré par vocalSalon.attacherSocket(socket)
  // plus haut (voir vocal-salon.js) — inutile d'en ajouter un second ici.

  /** Réactions émoji pendant la partie, relayées à tout le salon (liste REGLAGES.reactions.emojis,
   *  personnalisable depuis la console admin, aussi utilisée par les bots — voir botDire()).
   *  `photo: true` : réaction spéciale qui envoie la photo de profil de l'expéditeur au lieu d'un
   *  emoji — jamais son URL fournie par le client, toujours `user.photo` (le compte authentifié),
   *  pour qu'on ne puisse jamais faire apparaître la photo de quelqu'un d'autre. Refusée en
   *  silence si le compte n'a pas de photo.
   *  socket.to (et non io.to) : n'est PAS renvoyée à l'expéditeur lui-même, qui affiche désormais sa
   *  propre réaction immédiatement en local dès le clic (voir construireBarreReactions côté client)
   *  plutôt que d'attendre cet aller-retour serveur — c'était la cause du "il faut cliquer plusieurs
   *  fois pour avoir un retour" remonté par plusieurs joueurs. La lui renvoyer en plus l'aurait
   *  affichée une seconde fois en double. */
  let derniereReaction = 0;

  socket.on("reaction", ({ code, emoji, photo }) => {
    const room = rooms.get(code);
    const player = room?.players.get(socket.data.user.id);
    if (!room || !player) return;
    const estPhoto = photo === true && Boolean(user.photo);
    if (!estPhoto && !REGLAGES.reactions.emojis.includes(emoji)) return;
    if (Date.now() - derniereReaction < 700) return;   // évite le matraquage
    derniereReaction = Date.now();
    socket.to(room.code).emit("reaction", estPhoto
      ? { photo: user.photo, pseudo: player.pseudo, avatar: player.avatar }
      : { emoji, pseudo: player.pseudo, avatar: player.avatar });
  });

  /** Invite un ami dans le salon en cours. Il reçoit une notification. */
  socket.on("invite:send", ({ code, amiId }, cb) => {
    const room = rooms.get(code);
    if (!room || !room.players.has(socket.data.user.id)) return cb?.({ ok: false });
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

  /**
   * Regarder en direct la partie d'un ami — lecture seule : synopsis, choix,
   * scores en temps réel, mais aucune réponse possible. Réservé aux amis.
   */
  socket.on("room:regarder", ({ amiId }, cb) => {
    if (!REGLAGES.autoriserSpectateur)
      return cb?.({ ok: false, error: "SPECTATEUR_DESACTIVE" });
    if (!amiId || statutRelation(user.id, amiId) !== "ami")
      return cb?.({ ok: false, error: "PAS_AMI" });
    // Même entre amis, il faut que LA PERSONNE REGARDÉE ait explicitement coché
    // « Partager ma partie » dans son profil — sinon, pas d'accès, même via l'API.
    if (!partageJeuActif(amiId))
      return cb?.({ ok: false, error: "PARTAGE_DESACTIVE" });

    arreterRegarder(socket);   // ne regarde qu'une seule partie à la fois

    const room = salonDuJoueur(amiId);
    if (room) {
      room.spectateurs = room.spectateurs || new Map();
      room.spectateurs.set(socket.id, { id: user.id, pseudo: user.pseudo });
      socket.data.regarde = room.code;
      diffuserListeSpectateurs(room);

      const film = room.currentMovie;
      const manche = room.status === "playing" && film ? {
        roundIndex: room.roundIndex,
        total: room.playlist.length,
        synopsis: masquerReponse(film.synopsis, film),
        duration: CONFIG.ROUND_DURATION_MS,
        choices: room.choices,
        posterStyle: styleAffiche(film),
        vitesseSynopsis: REGLAGES.vitesseSynopsis,
      } : null;

      return cb?.({ ok: true, code: room.code, state: publicState(room), manche });
    }

    // Repli : la partie de l'ami n'est pas un salon multijoueur, c'est peut-être une partie solo/classée.
    const p = parties.get(amiId);
    if (!p) return cb?.({ ok: false, error: "PARTIE_INTROUVABLE" });

    const fiche = fichePublique(amiId, user.id);
    p.spectateurs = p.spectateurs || new Map();
    p.spectateurs.set(socket.id, { id: user.id, pseudo: user.pseudo });
    socket.data.regardeSolo = amiId;
    diffuserListeSpectateursSolo(amiId, p);

    const manche = p.repondu ? null : vueManche(p);
    cb?.({
      ok: true,
      solo: true,
      mode: p.mode,
      state: {
        players: [{
          pseudo: fiche?.pseudo || "Joueur",
          avatar: fiche?.avatar || null,
          photo: fiche?.photo || null,
          score: p.score || 0,
        }],
      },
      manche,
    });
  });

  socket.on("room:arreterRegarder", () => arreterRegarder(socket));

  /** Quitte le suivi en direct d'une partie, sans affecter les joueurs. */
  function arreterRegarder(socket) {
    const code = socket.data.regarde;
    if (code) {
      const room = rooms.get(code);
      if (room?.spectateurs?.delete(socket.id)) diffuserListeSpectateurs(room);
      delete socket.data.regarde;
    }
    const soloId = socket.data.regardeSolo;
    if (soloId) {
      const p = parties.get(soloId);
      if (p?.spectateurs?.delete(socket.id)) diffuserListeSpectateursSolo(soloId, p);
      delete socket.data.regardeSolo;
    }
  }

  // Un départ volontaire (clic sur "quitter") retire vraiment le joueur d'un salon
  // encore en lobby ; une déconnexion involontaire (coupure réseau, mise en veille du
  // téléphone, changement de wifi…) ne fait que le marquer hors-ligne un moment, le
  // temps qu'il revienne — sinon la moindre coupure pendant l'attente d'un ami fait
  // disparaître tout le salon.
  socket.on("room:leave", () => { leaveAllRooms(socket, true); arreterRegarder(socket); });

  socket.on("disconnect", () => { leaveAllRooms(socket, false); arreterRegarder(socket); });

  function leaveAllRooms(socket, explicite = false) {
    const userId = socket.data.user?.id;
    for (const room of rooms.values()) {
      const p = room.players.get(userId);
      if (!p || p.id !== socket.id) continue;

      if (room.status === "lobby" && explicite) {
          room.players.delete(userId);
      } else {
          p.online = false;
      }
      socket.leave(room.code);

      // Les bots ne comptent jamais comme un joueur « actif » pour ces vérifications : sinon
      // un salon où il ne reste qu'un bot (l'humain parti) ne serait jamais nettoyé, puisque
      // le bot reste toujours online.
      const activePlayers = [...room.players.values()].filter(x => x.online !== false && !x.bot);
      clearTimeout(room.emptyTimer);
      room.emptyTimer = null;

      if (activePlayers.length === 0) {
        clearTimeout(room.timer); clearTimeout(room.nextTimer); clearTimeout(room.graceTimer);
        for (const p of room.players.values()) clearTimeout(p.timerReponse);
        diffuserSpectateurs(room, "regarder:termine", { abandon: true });
        // Salon vide : on ne le détruit pas immédiatement. Une coupure réseau ou une
        // mise en veille de quelques secondes ne doit pas faire perdre la partie —
        // on laisse une marge de reconnexion avant de vraiment l'effacer.
        const code = room.code;
        room.emptyTimer = setTimeout(() => {
          const r = rooms.get(code);
          if (r && [...r.players.values()].every((x) => x.online === false || x.bot)) rooms.delete(code);
        }, CONFIG.ROOM_VIDE_GRACE_MS);
      } else {
        // Un départ VOLONTAIRE de l'hôte transfère vraiment la main à un autre joueur
        // actif : il ne reviendra pas. Une simple coupure réseau, elle, ne change rien
        // à l'hôte affiché — estHote() (plus bas) permet aux autres de continuer si
        // besoin, et le titulaire retrouve automatiquement son statut dès son retour,
        // au lieu de le perdre à la moindre micro-coupure.
        if (explicite && room.hostId === userId) {
            room.hostId = activePlayers[0].userId;
        }
        io.to(room.code).emit("room:update", publicState(room));
      }
    }
  }
});

/**
 * Un joueur a l'autorité d'hôte s'il l'est vraiment, ou si l'hôte titulaire est
 * actuellement injoignable (coupure réseau, mise en veille…) — pour qu'un salon
 * ne reste jamais bloqué en attendant un hôte parti, tout en lui rendant
 * automatiquement la main dès qu'il revient (voir leaveAllRooms ci-dessus).
 */
function estHote(room, userId) {
  if (room.hostId === userId) return true;
  const hote = room.players.get(room.hostId);
  return !hote || hote.online === false;
}

function joinRoom(socket, room, user) {
  const niveau = infoNiveau(user.id)?.niveau || 0;
  const avantages = getAvantagesNiveau(niveau);
  // Un nouveau joueur qui rejoint annule une éventuelle suppression programmée du salon.
  clearTimeout(room.emptyTimer);
  room.emptyTimer = null;

  room.players.set(user.id, {
    id: socket.id,
    userId: user.id,
    pseudo: user.pseudo,
    avatar: user.avatar || "🎬",
    photo: user.photo || null,
    fondateur: Boolean(user.fondateur),
    team: room.mode === "teams" ? balancedTeam(room) : null,
    score: 0, hints: [], paidHints: [], hasAnswered: false,
    coeursMax: REGLAGES.coeurs + avantages.extraCoeurs,
    coeurs: REGLAGES.coeurs + avantages.extraCoeurs,
    freeHintsRemaining: avantages.freeHints,
    allHintsFree: avantages.allFree,
    pret: false,
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
progression = await charger("quetes", null, {});
progressionGlobale = await charger("quetesGlobales", null, {});
for (const [id, liste] of Object.entries(await charger("vus", null, {})))
  vusParJoueur.set(id, liste);
conversations = await charger("conversations", null, {});
  sortiesConfig = await charger("sortiesConfig", SORTIES_FILE, { hidden: [], custom: [], kidsOk: [] });
  if (!Array.isArray(sortiesConfig.kidsOk)) sortiesConfig.kidsOk = [];
  nowPlayingConfig = await charger("nowPlayingConfig", NOWPLAYING_FILE, { hidden: [], custom: [], kidsOk: [] });
  if (!Array.isArray(nowPlayingConfig.kidsOk)) nowPlayingConfig.kidsOk = [];
suggestions = await charger("suggestions", SUGGESTIONS_FILE, []);
if (!Array.isArray(suggestions)) suggestions = [];
// Ancien format sans id/statut : on complète pour que les suggestions déjà en base
// restent utilisables avec le circuit d'acceptation/publication.
{
    let suggestionsAMigrer = false;
    for (const s of suggestions) {
        if (!s.id) { s.id = crypto.randomUUID(); suggestionsAMigrer = true; }
        if (s.statut === undefined) { s.statut = "attente"; suggestionsAMigrer = true; }
        if (s.publie === undefined) { s.publie = false; suggestionsAMigrer = true; }
        if (s.anonyme === undefined) { s.anonyme = false; suggestionsAMigrer = true; }
        if (s.auteurId === undefined) { s.auteurId = null; suggestionsAMigrer = true; }
        if (s.publieLe === undefined) { s.publieLe = null; suggestionsAMigrer = true; }
        if (s.decline === undefined) { s.decline = false; suggestionsAMigrer = true; }
    }
    if (suggestionsAMigrer) saveSuggestions();
}
citations = await charger("citations", CITATIONS_FILE, CITATIONS_DEFAUT);
if (!Array.isArray(citations) || !citations.length) citations = CITATIONS_DEFAUT;
sondages = await charger("sondages", SONDAGES_FILE, []);
if (!Array.isArray(sondages)) sondages = [];
playlisteMusique = await charger("musique", MUSIQUE_FILE, []);
if (!Array.isArray(playlisteMusique)) playlisteMusique = [];
votesMusique = await charger("votesMusique", VOTES_MUSIQUE_FILE, {});
if (!votesMusique || typeof votesMusique !== "object") votesMusique = {};
erreursMusique = await charger("erreursMusique", ERREURS_MUSIQUE_FILE, {});
if (!erreursMusique || typeof erreursMusique !== "object") erreursMusique = {};
publicites = await charger("publicites", PUBLICITES_FILE, []);
if (!Array.isArray(publicites)) publicites = [];
signets = await charger("signets", SIGNETS_FILE, {});
if (!signets || typeof signets !== "object") signets = {};
pepites = await charger("pepites", PEPITES_FILE, {});
if (!pepites || typeof pepites !== "object") pepites = {};
aideConfig = await charger("aide", AIDE_FILE, aideConfig);
if (!aideConfig || typeof aideConfig !== "object") aideConfig = { actif: false, titre: "Comment jouer ? 🎬🎵", message: "" };
annonceConfig = await charger("annonce", ANNONCE_FILE, annonceConfig);
if (!annonceConfig || typeof annonceConfig !== "object") annonceConfig = { actif: false, texte: "", maintenance: false };
contactDevConfig = await charger("contactDevConfig", CONTACT_DEV_FILE, contactDevConfig);
if (!contactDevConfig || typeof contactDevConfig !== "object") contactDevConfig = { destinataireId: null, destinatairePseudo: null };
messagesDev = await charger("messagesDev", MESSAGES_DEV_FILE, []);
if (!Array.isArray(messagesDev)) messagesDev = [];
roue = await charger("roue", ROUE_FILE, null);
assurerRoueDuJour();
gainsEnAttente = await charger("roueGains", GAINS_ROUE_FILE, {});
if (!gainsEnAttente || typeof gainsEnAttente !== "object") gainsEnAttente = {};
demandesVip = await charger("roueVip", DEMANDES_VIP_FILE, []);
if (!Array.isArray(demandesVip)) demandesVip = [];
bonusPartiesClassees = await charger("bonusRanked", BONUS_RANKED_FILE, {});
if (!bonusPartiesClassees || typeof bonusPartiesClassees !== "object") bonusPartiesClassees = {};
walletHistorique = await charger("wallet", WALLET_FILE, {});
if (!walletHistorique || typeof walletHistorique !== "object") walletHistorique = {};
REGLAGES = { ...structuredClone(REGLAGES_DEFAUT), ...(await charger("reglages", null, {})) };
assurerCouleursCategories();
// Réglages sauvegardés avant l'ajout de l'espace audio : on les rétablit, puis on reprend les
// variables d'environnement TURN_* comme valeur de secours au tout premier démarrage seulement
// (si l'admin n'a encore jamais rien réglé depuis la console) — cela ne les écrase jamais ensuite.
if (!REGLAGES.audio || typeof REGLAGES.audio !== "object") REGLAGES.audio = structuredClone(REGLAGES_DEFAUT.audio);
if (!REGLAGES.audio.turnUrl && TURN_URL) {
  REGLAGES.audio.turnActif = true;
  REGLAGES.audio.turnUrl = TURN_URL;
  REGLAGES.audio.turnUsername = TURN_USERNAME;
  REGLAGES.audio.turnCredential = TURN_CREDENTIAL;
}
if (!REGLAGES.audio.cloudflareTurnKeyId && CLOUDFLARE_TURN_KEY_ID) {
  REGLAGES.audio.cloudflareTurnKeyId = CLOUDFLARE_TURN_KEY_ID;
  REGLAGES.audio.cloudflareTurnApiToken = CLOUDFLARE_TURN_API_TOKEN;
}
if (!REGLAGES.lienExterne || typeof REGLAGES.lienExterne !== "object")
  REGLAGES.lienExterne = structuredClone(REGLAGES_DEFAUT.lienExterne);
if (!REGLAGES.passerelle || typeof REGLAGES.passerelle !== "object")
  REGLAGES.passerelle = structuredClone(REGLAGES_DEFAUT.passerelle);
if (!REGLAGES.passerelleEntrante || typeof REGLAGES.passerelleEntrante !== "object")
  REGLAGES.passerelleEntrante = structuredClone(REGLAGES_DEFAUT.passerelleEntrante);
if (!REGLAGES.reactions || typeof REGLAGES.reactions !== "object" || !Array.isArray(REGLAGES.reactions.emojis) || !REGLAGES.reactions.emojis.length)
  REGLAGES.reactions = structuredClone(REGLAGES_DEFAUT.reactions);
// Réglages d'ordre du menu sauvegardés avant l'ajout du bloc « stats » (compteurs films/joueurs,
// voir THEME_MODULES_MENU) : on les rétablit à l'ordre par défaut à jour plutôt que de les
// compléter en fin de liste, sans quoi le nouveau bloc atterrirait tout en haut du menu (avant
// même « Choisissez votre partie »), faute d'avoir jamais été positionné par appliquerTheme côté
// client. Ne s'applique qu'une fois : dès qu'un admin réordonne les modules depuis sa console
// (voir PUT /api/admin/theme), ce réglage à jour est sauvegardé et cette migration ne le
// retouche plus jamais.
if (Array.isArray(REGLAGES.theme?.ordre?.menu) && !REGLAGES.theme.ordre.menu.includes("stats")) {
  REGLAGES.theme.ordre.menu = structuredClone(REGLAGES_DEFAUT.theme.ordre.menu);
}
// Réglages d'ordre du salon vocal (voir THEME_MODULES_VOCAL, ajouté avec la personnalisation de la
// disposition des cases hôte/intervenants/auditeurs) : les configs sauvegardées avant cet ajout n'ont
// jamais eu de clé « vocal » sous ordre (celle-ci n'existait pas), donc on l'initialise ici à l'ordre
// par défaut au lieu de la laisser vide, sans quoi appliquerTheme ne réordonnerait jamais rien côté
// client. Comme pour le menu, ne s'applique qu'une fois : dès qu'un admin sauvegarde un ordre depuis
// la console (voir PUT /api/admin/theme), ce réglage à jour est conservé tel quel.
if (!Array.isArray(REGLAGES.theme?.ordre?.vocal) || THEME_MODULES_VOCAL.some((id) => !REGLAGES.theme.ordre.vocal.includes(id))) {
  if (!REGLAGES.theme.ordre) REGLAGES.theme.ordre = {};
  REGLAGES.theme.ordre.vocal = structuredClone(REGLAGES_DEFAUT.theme.ordre.vocal);
}
if (!empreinteAdmin)
  console.warn("⚠️  Mot de passe d'administration par défaut : changez-le depuis /admin.html");
await chargerUtilisateurs();

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`MichBen Ciné Quizz → http://localhost:${PORT}  (admin : /admin.html)`);
  console.log(`${movies.length} films · stockage : ${enBase ? "Postgres" : "fichiers locaux"}`);
});
