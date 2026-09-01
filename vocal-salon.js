/**
 * Salon vocal — module totalement indépendant du jeu de quiz lui-même.
 *
 * Tout ce dont ce fichier a besoin de l'application qui l'utilise (server.js) lui est fourni
 * explicitement en paramètre de creerModuleVocalSalon() ci-dessous — jamais lu directement dans
 * une variable globale du reste du programme. Ce fichier ne connaît RIEN des parties de quiz, des
 * salles de jeu, des équipes ou du classement : à ses yeux, un salon vocal n'existe que pour
 * accueillir des comptes qui parlent entre eux, diffusent de la musique/vidéo, discutent par écrit
 * et s'envoient des réactions — rien de plus. C'est le sens de la demande "séparer vraiment le
 * salon vocal, qu'il soit totalement indépendant de l'application du cinéma".
 *
 * La seule passerelle qui existe entre les deux univers (ouvrir un salon vocal d'équipe ou de
 * partie depuis une partie de quiz en cours) reste, elle, dans server.js — c'est justement une
 * fonctionnalité DU JEU (qui a besoin de connaître les salles/équipes de jeu), pas du salon vocal :
 * elle se contente d'utiliser les quelques fonctions publiques que ce module expose en retour
 * (voir le "return" tout en bas), exactement comme le ferait n'importe quelle autre application qui
 * voudrait proposer des salons vocaux à ses utilisateurs.
 */
import { join } from "path";
import crypto from "crypto";
import fs from "fs";
import { estBloque, statutRelation } from "./auth-x.js";

export function creerModuleVocalSalon({
  app, io,
  // Réglages/données vivants de l'application hôte : fournis sous forme de fonctions ("getters")
  // plutôt que de valeurs figées, parce que l'application hôte peut totalement REMPLACER ces objets
  // en cours de route (ex : rechargement des réglages admin, playlist musicale modifiée) — un
  // simple objet reçu une fois à l'initialisation deviendrait alors périmé silencieusement.
  getReglages, getPlaylisteMusique,
  // Fonctions utilitaires génériques de l'application hôte (aucune ne dépend du quiz lui-même).
  borneValeur, exigeCompte, requireModerateur, fichierMusiqueExiste, ajouterPisteMusique,
  // Formats/limites pour l'envoi de vidéos depuis le téléphone.
  VIDEO_EXT_AUTORISEES, VIDEO_MAX_OCTETS, VIDEO_DIR,
}) {
  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // sans I, O, 0, 1 — ambigus à l'oral/à l'écrit

  /** Délai (ms) entre le moment où une vidéo est choisie et le moment où elle démarre réellement
   *  chez tout le monde : le temps d'afficher un compte à rebours "3, 2, 1…" bien visible à l'écran
   *  (voir demarreLe plus bas et l'affichage côté client), pour que personne ne rate le début. Ne
   *  s'applique qu'aux vidéos — la musique (audio) démarre toujours immédiatement. */
  const COMPTE_A_REBOURS_VIDEO_MS = 3000;

  /** Reconnaît un lien YouTube sous ses formes les plus courantes et en extrait l'identifiant. */
  function extraireIdYoutube(url) {
    const s = String(url || "").trim();
    const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  /** Reconnaît un lien vers un post X/Twitter (twitter.com ou x.com, avec ou sans www., un
   *  sous-chemin i/web/, un nom de compte quelconque) et en extrait l'identifiant numérique du
   *  post — c'est cet identifiant, et lui seul, qu'accepte le lecteur officiel intégré (voir
   *  vocal:tweet-diffuser plus bas et vocalChargerTweet côté client). */
  function extraireIdTweet(url) {
    const s = String(url || "").trim();
    const m = s.match(/(?:twitter\.com|x\.com)\/(?:[A-Za-z0-9_]+|i\/web)\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  const MAX_COHOTES_VOCAL = () => borneValeur(getReglages().audio?.maxCohotesVocal, 1, 10, 3);
  const MAX_PARTICIPANTS_VOCAL = () => borneValeur(getReglages().audio?.maxParticipantsVocal, 2, 200, 40);
  const salonsVocaux = new Map(); // code -> salon

  /** Retrouve le salon vocal (s'il y en a un) où se trouve actuellement ce joueur — utilisé par
   *  l'application hôte pour rendre un don (points/tickets/partie classée) visible par tout le
   *  salon quand donneur et receveur s'y trouvent tous les deux au moment du don. */
  function salonVocalDuJoueur(userId) {
    for (const salon of salonsVocaux.values()) {
      if (salon.participants.has(userId)) return salon;
    }
    return null;
  }

  /** Si le donneur et le receveur d'un don sont actuellement tous les deux dans le même salon
   *  vocal, diffuse un petit effet visuel (façon réaction volante) à tout le salon — un don fait
   *  "en direct" devient ainsi un moment visible par tous. Ne fait rien si l'un des deux n'est pas
   *  dans ce salon. C'est la SEULE fonction de ce module pensée pour être appelée par autre chose
   *  que le salon vocal lui-même (le système de dons du jeu, côté server.js). */
  function diffuserDonVocal(donneurId, cibleId, payload) {
    const salon = salonVocalDuJoueur(donneurId);
    if (!salon || !salon.participants.has(cibleId)) return;
    for (const p of salon.participants.values()) {
      const s = [...io.of("/").sockets.values()].find((sk) => sk.data.user?.id === p.userId);
      if (s) s.emit("vocal:don", payload);
    }
  }

  /** Personnes coupées involontairement (réseau, onglet fermé…) d'un salon vocal toujours actif :
   *  on leur garde un accès rapide pour y revenir depuis la page d'accueil plutôt que de les
   *  laisser rechercher le salon ou retaper le code. Périmé après RETOUR_VOCAL_VALIDITE_MS. */
  const retourVocalDisponible = new Map(); // userId -> { code, titre, at }
  const RETOUR_VOCAL_VALIDITE_MS = 15 * 60 * 1000;

  /** Micro qui « reste en sourdine » quand un joueur change d'application ou de page : le vrai
   *  coupable n'était pas le micro lui-même, mais le fait qu'une coupure de connexion involontaire
   *  supprimait entièrement son entrée dans le salon (voir quitterSalonVocal), si bien qu'au retour,
   *  vocal:rejoindre le faisait recommencer à zéro. On garde donc une courte mémoire de son état
   *  juste avant la coupure, pour le lui restituer telle quelle s'il revient à temps. */
  const vocalEtatRecent = new Map(); // "code:userId" -> { role, mute, mainLevee, expire }
  setInterval(() => {
    const maintenant = Date.now();
    for (const [cle, etat] of vocalEtatRecent) if (etat.expire < maintenant) vocalEtatRecent.delete(cle);
  }, 60 * 1000);

  function genererCodeVocal() {
    let code;
    do {
      code = Array.from({ length: 4 }, () =>
        CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
      ).join("");
    } while (salonsVocaux.has(code));
    return code;
  }

  /** Trie une liste de participants pour mettre en avant celui ou ceux qui parlent EN CE MOMENT
   *  (détection de voix côté client, voir vocal:parler) : demande explicite pour que, dans un
   *  salon avec beaucoup de monde, on repère tout de suite qui a la parole sans avoir à chercher
   *  l'anneau qui pulse. Un participant muet ou silencieux garde sa place habituelle (tri stable,
   *  donc aucun "sautillement" pour ceux qui ne parlent pas) ; il ne se déplace en tête que
   *  lorsqu'il se met effectivement à parler, et perd cette place dès qu'il se tait. */
  function trierParPriseDeParole(participants) {
    return [...participants].sort((a, b) => (b.parle ? 1 : 0) - (a.parle ? 1 : 0));
  }

  /** État public d'un salon vocal, envoyé à ses participants à chaque changement. */
  function publicVocal(salon) {
    return {
      code: salon.code,
      titre: salon.titre,
      hostId: salon.hostId,
      participants: trierParPriseDeParole([...salon.participants.values()]).map((p) => ({
        userId: p.userId, pseudo: p.pseudo, avatar: p.avatar, photo: p.photo,
        role: p.role, mute: p.mute, parle: p.parle, mainLevee: Boolean(p.mainLevee),
      })),
      demandesMontee: [...salon.demandesMontee],
      radio: salon.radio,
      chat: salon.chat || [],
      prive: Boolean(salon.prive),
      monteeLibre: Boolean(salon.monteeLibre),
    };
  }

  const VOCAL_CHAT_HISTORIQUE_MAX = 50; // borne la taille de l'historique renvoyé à chaque mise à jour

  function diffuserVocal(salon) {
    io.to(`vocal:${salon.code}`).emit("vocal:update", publicVocal(salon));
  }

  /** Hôte ou cohôte : les deux ont les pouvoirs de modération, seul l'hôte peut nommer/retirer des cohôtes. */
  function estModoVocal(salon, userId) {
    return salon.hostId === userId || salon.participants.get(userId)?.role === "cohote";
  }

  /** Délai laissé à un salon vocal devenu « sans personne pour le tenir » avant sa fermeture
   *  réelle — le temps d'une coupure wifi ou d'une mise en veille de téléphone. Réglable depuis la
   *  console admin (onglet Audio) — 3 minutes par défaut. */
  const VOCAL_SALON_VIDE_GRACE_MS = () => borneValeur(getReglages().audio?.fermetureGraceMinutes, 1, 30, 3) * 60 * 1000;

  /** Un salon totalement vide n'a aucune raison de bénéficier du long délai de grâce ci-dessus.
   *  Fermeture rapide pour libérer le code. */
  const VOCAL_SALON_TOTALEMENT_VIDE_GRACE_MS = 10_000;

  /** Ferme un salon vocal pour de bon : prévient tout le monde et libère le salon. */
  function fermerSalonVocalDefinitivement(salon, raison) {
    io.to(`vocal:${salon.code}`).emit("vocal:ferme", { raison });
    for (const p of salon.participants.values()) {
      const s = [...io.of("/").sockets.values()].find((sk) => sk.data.user?.id === p.userId);
      if (s) s.leave(`vocal:${salon.code}`);
    }
    salonsVocaux.delete(salon.code);
  }

  /** Retire un socket de tout salon vocal dont il fait partie (déconnexion, ou changement de
   *  salon). Si l'hôte part ou si plus personne n'est présent, le salon n'est pas détruit tout de
   *  suite : il reste ouvert VOCAL_SALON_VIDE_GRACE_MS, le temps que la personne revienne.
   *  `involontaire` distingue une vraie coupure d'un départ volontaire (bouton Quitter). */
  function quitterSalonVocal(socket, { involontaire = false } = {}) {
    const userId = socket.data.user?.id;
    if (!userId) return;
    for (const salon of salonsVocaux.values()) {
      if (!salon.participants.has(userId)) continue;
      const etaitHote = salon.hostId === userId;
      const participantSortant = salon.participants.get(userId);
      if (involontaire) {
        vocalEtatRecent.set(`${salon.code}:${userId}`, {
          role: participantSortant.role, mute: participantSortant.mute,
          mainLevee: Boolean(participantSortant.mainLevee), expire: Date.now() + VOCAL_SALON_VIDE_GRACE_MS(),
        });
      }
      salon.participants.delete(userId);
      salon.demandesMontee.delete(userId);
      socket.leave(`vocal:${salon.code}`);
      clearTimeout(salon.fermetureTimer);
      if (etaitHote || salon.participants.size === 0) {
        if (involontaire) {
          retourVocalDisponible.set(userId, { code: salon.code, titre: salon.titre, at: Date.now() });
        }
        io.to(`vocal:${salon.code}`).emit("vocal:rtc-peer-left", { userId });
        diffuserVocal(salon);
        const delaiFermeture = salon.participants.size === 0
          ? VOCAL_SALON_TOTALEMENT_VIDE_GRACE_MS
          : VOCAL_SALON_VIDE_GRACE_MS();
        salon.fermetureTimer = setTimeout(() => {
          if (salonsVocaux.get(salon.code) === salon)
            fermerSalonVocalDefinitivement(salon, etaitHote ? "HOTE_PARTI" : "SALON_VIDE");
        }, delaiFermeture);
      } else {
        io.to(`vocal:${salon.code}`).emit("vocal:rtc-peer-left", { userId });
        diffuserVocal(salon);
        if (involontaire) {
          retourVocalDisponible.set(userId, { code: salon.code, titre: salon.titre, at: Date.now() });
        }
      }
      return; // un compte ne peut être que dans un seul salon vocal à la fois
    }
  }

  /** Page autonome du salon vocal (voir public/vocal.html) : un accès direct au salon vocal, sans
   *  jouer au quiz. Toujours protégée par connexion (vérifiée côté client via /api/me) — mêmes
   *  comptes que le jeu, jamais d'accès anonyme. */
  app.get("/vocal", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.sendFile("vocal.html", { root: "public" });
  });

  /** Liste des salons vocaux ouverts en ce moment (« Salons en direct »), pour en rejoindre un
   *  sans code. Un salon privé n'apparaît que pour les amis de l'hôte et pour ceux qui y sont déjà. */
  app.get("/api/vocal/salons", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    res.json([...salonsVocaux.values()]
      .filter((s) => Boolean(s.compteEnfant) === (user.role === "enfant"))
      .filter((s) => {
        if (!s.prive) return true;
        if (s.participants.has(user.id)) return true;
        return statutRelation(user.id, s.hostId) === "ami";
      })
      .map((s) => ({
        code: s.code, titre: s.titre,
        hote: s.participants.get(s.hostId)?.pseudo || "?",
        hoteEstAmi: statutRelation(user.id, s.hostId) === "ami",
        participants: s.participants.size,
        prive: Boolean(s.prive),
      })));
  });

  /** Bulle affichée en haut de la page d'accueil : propose un accès direct à un salon vocal encore
   *  actif, soit parce que le compte en a été coupé involontairement, soit parce qu'il a reçu une
   *  invitation à laquelle il n'a pas encore répondu. */
  app.get("/api/vocal/retour", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;

    const r = retourVocalDisponible.get(user.id);
    if (r) {
      if (Date.now() - r.at < RETOUR_VOCAL_VALIDITE_MS && salonsVocaux.has(r.code)) {
        return res.json({ retour: { code: r.code, titre: r.titre, motif: "deconnecte" } });
      }
      retourVocalDisponible.delete(user.id);
    }

    for (const salon of salonsVocaux.values()) {
      const invite = salon.invites?.get(user.id);
      if (invite && !salon.participants.has(user.id)) {
        return res.json({ retour: { code: salon.code, titre: salon.titre, motif: "invite", de: invite.de } });
      }
    }

    res.json({ retour: null });
  });

  /** Ferme la bulle de retour sans rejoindre le salon : nettoie la coupure et les invitations en
   *  attente pour ce compte, pour qu'elle ne réapparaisse pas tant que rien de nouveau ne survient. */
  app.post("/api/vocal/retour/ignorer", (req, res) => {
    const user = exigeCompte(req, res);
    if (!user) return;
    retourVocalDisponible.delete(user.id);
    for (const salon of salonsVocaux.values()) salon.invites?.delete(user.id);
    res.json({ ok: true });
  });

  /** Vue d'ensemble de tous les salons vocaux actuellement ouverts, pour la modération —
   *  indépendante de la liste publique (qui masque les salons privés aux non-amis de l'hôte).*/
  app.get("/api/admin/vocal/salons", requireModerateur, (_req, res) => {
    res.json([...salonsVocaux.values()].map((s) => ({
      code: s.code,
      titre: s.titre,
      prive: s.prive,
      monteeLibre: s.monteeLibre,
      compteEnfant: Boolean(s.compteEnfant),
      creeLe: s.creeLe,
      participants: [...s.participants.values()].map((p) => ({
        pseudo: p.pseudo, avatar: p.avatar, role: p.role, mute: p.mute,
      })),
    })));
  });

  /** Attache à un socket fraîchement connecté tous les événements propres au salon vocal — c'est
   *  le seul point de contact entre ce module et le reste de l'application : server.js n'a qu'à
   *  appeler cette fonction une fois par connexion pour que tout le salon vocal fonctionne, sans
   *  jamais avoir à connaître le détail de ce qui se passe à l'intérieur. */
  function attacherSocket(socket) {
    const user = socket.data.user;

    socket.on("vocal:creer", ({ titre }, cb) => {
      quitterSalonVocal(socket);
      retourVocalDisponible.delete(user.id);
      const code = genererCodeVocal();
      const salon = {
        code, hostId: user.id,
        titre: String(titre || "").trim().slice(0, 60) || `Le salon de ${user.pseudo}`,
        participants: new Map(),
        demandesMontee: new Set(),
        invites: new Map(),
        radio: null,
        chat: [],
        creeLe: Date.now(),
        prive: false,
        monteeLibre: getReglages().audio?.monteeLibreParDefaut === true,
        compteEnfant: user.role === "enfant",
      };
      salon.participants.set(user.id, {
        userId: user.id, pseudo: user.pseudo, avatar: user.avatar, photo: user.photo || null,
        role: "hote", mute: true, parle: false,
      });
      salonsVocaux.set(code, salon);
      socket.join(`vocal:${code}`);
      cb?.({ ok: true, code, salon: publicVocal(salon) });
    });

    socket.on("vocal:rejoindre", ({ code }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon) return cb?.({ ok: false, error: "SALON_INTROUVABLE" });
      if (user.role === "enfant" && !salon.compteEnfant) return cb?.({ ok: false, error: "ENFANT_MODE_ENFANT_UNIQUEMENT" });
      if (user.role !== "enfant" && salon.compteEnfant) return cb?.({ ok: false, error: "ADULTE_SALON_ENFANT_INTERDIT" });
      if (salon.participants.size >= MAX_PARTICIPANTS_VOCAL()) return cb?.({ ok: false, error: "SALON_COMPLET" });
      quitterSalonVocal(socket);
      retourVocalDisponible.delete(user.id);
      salon.invites?.delete(user.id);
      clearTimeout(salon.fermetureTimer);
      const redevientHote = salon.hostId === user.id && !salon.participants.has(user.id);
      const cleEtatRecent = `${salon.code}:${user.id}`;
      const etatRecent = vocalEtatRecent.get(cleEtatRecent);
      vocalEtatRecent.delete(cleEtatRecent);
      const etatEncoreValide = etatRecent && etatRecent.expire > Date.now();
      salon.participants.set(user.id, {
        userId: user.id, pseudo: user.pseudo, avatar: user.avatar, photo: user.photo || null,
        role: redevientHote ? "hote" : (etatEncoreValide ? etatRecent.role : "auditeur"),
        mute: etatEncoreValide ? etatRecent.mute : true,
        parle: false,
        mainLevee: etatEncoreValide ? etatRecent.mainLevee : false,
      });
      socket.join(`vocal:${salon.code}`);
      diffuserVocal(salon);
      cb?.({ ok: true, salon: publicVocal(salon) });
    });

    socket.on("vocal:quitter", ({ code }, cb) => {
      quitterSalonVocal(socket);
      cb?.({ ok: true });
    });

    socket.on("vocal:parler", ({ code, parle }) => {
      const salon = salonsVocaux.get(code);
      const moi = salon?.participants.get(user.id);
      if (!moi || moi.mute || !["hote", "cohote", "intervenant"].includes(moi.role)) return;
      moi.parle = Boolean(parle);
      diffuserVocal(salon);
    });

    socket.on("vocal:mute", ({ code, mute }) => {
      const salon = salonsVocaux.get(code);
      const moi = salon?.participants.get(user.id);
      if (!moi) return;
      moi.mute = Boolean(mute);
      if (moi.mute) moi.parle = false;
      diffuserVocal(salon);
    });

    socket.on("vocal:demander-intervenir", ({ code }, cb) => {
      const salon = salonsVocaux.get(code);
      const moi = salon?.participants.get(user.id);
      if (!moi || moi.role !== "auditeur") return cb?.({ ok: false });
      if (salon.monteeLibre) {
        moi.role = "intervenant";
        moi.mute = true;
        salon.demandesMontee.delete(user.id);
      } else {
        salon.demandesMontee.add(user.id);
      }
      diffuserVocal(salon);
      cb?.({ ok: true, monteeLibre: Boolean(salon.monteeLibre) });
    });

    socket.on("vocal:annuler-demande", ({ code }) => {
      const salon = salonsVocaux.get(code);
      if (!salon) return;
      salon.demandesMontee.delete(user.id);
      diffuserVocal(salon);
    });

    socket.on("vocal:main-toggle", ({ code }, cb) => {
      const salon = salonsVocaux.get(code);
      const moi = salon?.participants.get(user.id);
      if (!moi || !["hote", "cohote", "intervenant"].includes(moi.role)) return cb?.({ ok: false });
      moi.mainLevee = !moi.mainLevee;
      diffuserVocal(salon);
      cb?.({ ok: true, salon: publicVocal(salon) });
    });

    socket.on("vocal:promouvoir", ({ code, userId }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || !estModoVocal(salon, user.id)) return cb?.({ ok: false });
      const cible = salon.participants.get(userId);
      if (!cible || cible.role !== "auditeur") return cb?.({ ok: false });
      cible.role = "intervenant";
      cible.mute = true;
      salon.demandesMontee.delete(userId);
      diffuserVocal(salon);
      cb?.({ ok: true });
    });

    socket.on("vocal:fermer", ({ code }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || salon.hostId !== user.id) return cb?.({ ok: false });
      clearTimeout(salon.fermetureTimer);
      fermerSalonVocalDefinitivement(salon, "FERME_PAR_HOTE");
      cb?.({ ok: true });
    });

    socket.on("vocal:reglages", ({ code, prive, monteeLibre, titre }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || !estModoVocal(salon, user.id)) return cb?.({ ok: false });
      if (typeof prive === "boolean") salon.prive = prive;
      if (typeof monteeLibre === "boolean") salon.monteeLibre = monteeLibre;
      if (typeof titre === "string") {
        const t = titre.trim().slice(0, 60);
        if (t) salon.titre = t;
      }
      diffuserVocal(salon);
      cb?.({ ok: true, prive: salon.prive, monteeLibre: salon.monteeLibre, titre: salon.titre });
    });

    socket.on("vocal:retrograder", ({ code, userId }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || !estModoVocal(salon, user.id)) return cb?.({ ok: false });
      const cible = salon.participants.get(userId);
      if (!cible || cible.role !== "intervenant") return cb?.({ ok: false });
      cible.role = "auditeur";
      cible.parle = false;
      cible.mute = true;
      cible.mainLevee = false;
      diffuserVocal(salon);
      cb?.({ ok: true });
    });

    socket.on("vocal:nommer-cohote", ({ code, userId }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || salon.hostId !== user.id) return cb?.({ ok: false, error: "PAS_HOTE" });
      const nbCohotes = [...salon.participants.values()].filter((p) => p.role === "cohote").length;
      if (nbCohotes >= MAX_COHOTES_VOCAL()) return cb?.({ ok: false, error: "MAX_COHOTES_ATTEINT", max: MAX_COHOTES_VOCAL() });
      const cible = salon.participants.get(userId);
      if (!cible || cible.role === "hote" || cible.role === "cohote") return cb?.({ ok: false });
      cible.role = "cohote";
      salon.demandesMontee.delete(userId);
      diffuserVocal(salon);
      cb?.({ ok: true });
    });

    socket.on("vocal:retirer-cohote", ({ code, userId }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || salon.hostId !== user.id) return cb?.({ ok: false, error: "PAS_HOTE" });
      const cible = salon.participants.get(userId);
      if (!cible || cible.role !== "cohote") return cb?.({ ok: false });
      cible.role = "intervenant";
      diffuserVocal(salon);
      cb?.({ ok: true });
    });

    socket.on("vocal:exclure", ({ code, userId }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || !estModoVocal(salon, user.id) || userId === user.id) return cb?.({ ok: false });
      const cible = salon.participants.get(userId);
      if (!cible || cible.role === "hote") return cb?.({ ok: false });
      if (salon.hostId !== user.id && cible.role === "cohote") return cb?.({ ok: false });
      salon.participants.delete(userId);
      salon.demandesMontee.delete(userId);
      const socketCible = [...io.of("/").sockets.values()].find((s) => s.data.user?.id === userId);
      if (socketCible) {
        socketCible.leave(`vocal:${salon.code}`);
        socketCible.emit("vocal:exclu", { code: salon.code });
      }
      io.to(`vocal:${salon.code}`).emit("vocal:rtc-peer-left", { userId });
      diffuserVocal(salon);
      cb?.({ ok: true });
    });

    socket.on("vocal:rtc-signal", ({ code, to, signal }) => {
      const salon = salonsVocaux.get(code);
      if (!salon || !salon.participants.has(user.id) || !salon.participants.has(to)) return;
      const socketCible = [...io.of("/").sockets.values()].find((s) => s.data.user?.id === to);
      if (socketCible) socketCible.emit("vocal:rtc-signal", { from: user.id, signal });
    });

    socket.on("vocal:radio", ({ code, pisteId }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || !estModoVocal(salon, user.id)) return cb?.({ ok: false });
      if (!pisteId) {
        salon.radio = null;
        diffuserVocal(salon);
        return cb?.({ ok: true });
      }
      const piste = getPlaylisteMusique().find((p) => p.id === pisteId);
      if (!piste) return cb?.({ ok: false, error: "PISTE_INTROUVABLE" });
      if (!fichierMusiqueExiste(piste)) return cb?.({ ok: false, error: "FICHIER_INTROUVABLE" });
      salon.radio = { titre: piste.titre, url: piste.url, type: "audio", demarreLe: Date.now() };
      diffuserVocal(salon);
      cb?.({ ok: true });
    });

    socket.on("vocal:radio-ajouter", ({ code, titre, url, fichier, ext }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || !estModoVocal(salon, user.id)) return cb?.({ ok: false });
      const resultat = ajouterPisteMusique({ titre, url, fichier, ext });
      if (resultat.error) return cb?.({ ok: false, error: resultat.error });
      salon.radio = { titre: resultat.piste.titre, url: resultat.piste.url, type: "audio", demarreLe: Date.now() };
      diffuserVocal(salon);
      cb?.({ ok: true, piste: resultat.piste });
    });

    /** Bascule la lecture en boucle du morceau audio en cours (voir la demande — remplace le
     *  contrôle de vitesse et le téléchargement, retirés du lecteur, voir controlsList côté client) :
     *  réservé à l'audio/la musique, jamais à la vidéo/YouTube/X, et contrôlé par l'hôte/les cohôtes
     *  pour tout le salon, comme le reste de la diffusion (pas un réglage personnel par auditeur). */
    socket.on("vocal:radio-boucle", ({ code }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || !estModoVocal(salon, user.id)) return cb?.({ ok: false });
      if (!salon.radio || salon.radio.type !== "audio") return cb?.({ ok: false, error: "AUCUNE_MUSIQUE" });
      salon.radio.boucle = !salon.radio.boucle;
      diffuserVocal(salon);
      cb?.({ ok: true, boucle: salon.radio.boucle });
    });

    socket.on("vocal:video-youtube", ({ code, url, titre }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || !estModoVocal(salon, user.id)) return cb?.({ ok: false });
      const youtubeId = extraireIdYoutube(url);
      if (!youtubeId) return cb?.({ ok: false, error: "LIEN_YOUTUBE_INVALIDE" });
      salon.radio = {
        // Une vidéo se lance après un compte à rebours (voir demarreLe et la note plus bas sur
        // COMPTE_A_REBOURS_VIDEO_MS), affiché à tout le salon (contrairement à l'audio, immédiat) —
        // pour que tout le monde ait le temps de regarder l'écran avant que ça commence.
        titre: String(titre || "").trim().slice(0, 80) || "Vidéo YouTube",
        type: "youtube", youtubeId, demarreLe: Date.now() + COMPTE_A_REBOURS_VIDEO_MS,
      };
      diffuserVocal(salon);
      cb?.({ ok: true });
    });

    /** Diffuse un post X/Twitter (une vidéo qu'il contient, ou simplement le post lui-même) à tout
     *  le salon, via le lecteur officiel intégré de X (voir vocalChargerTweet côté client) — jamais
     *  en essayant d'extraire nous-mêmes un flux vidéo, ce que X ne permet de toute façon pas de
     *  faire depuis l'extérieur. IMPORTANT — limite honnête, à ne jamais perdre de vue : un "Space"
     *  (émission audio en direct de X) n'est PAS diffusable ainsi, ni par aucun autre moyen : X ne
     *  fournit aucune façon, ni publique ni privée, d'intégrer un Space sur un site tiers — seule
     *  l'application ou le site X eux-mêmes peuvent le faire écouter. Seuls les posts contenant une
     *  vidéo (ou une simple image/texte) fonctionnent ici. */
    socket.on("vocal:tweet-diffuser", ({ code, url, titre }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || !estModoVocal(salon, user.id)) return cb?.({ ok: false });
      const tweetId = extraireIdTweet(url);
      if (!tweetId) return cb?.({ ok: false, error: "LIEN_TWEET_INVALIDE" });
      salon.radio = {
        titre: String(titre || "").trim().slice(0, 80) || "Post X",
        type: "twitter", tweetId, demarreLe: Date.now() + COMPTE_A_REBOURS_VIDEO_MS,
      };
      diffuserVocal(salon);
      cb?.({ ok: true });
    });

    socket.on("vocal:video-lien", ({ code, url, titre }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || !estModoVocal(salon, user.id)) return cb?.({ ok: false });
      const lien = String(url || "").trim();
      if (!/^https?:\/\/\S+$/i.test(lien)) return cb?.({ ok: false, error: "LIEN_INVALIDE" });
      salon.radio = { titre: String(titre || "").trim().slice(0, 80) || "Vidéo", type: "video", url: lien, demarreLe: Date.now() + COMPTE_A_REBOURS_VIDEO_MS };
      diffuserVocal(salon);
      cb?.({ ok: true });
    });

    socket.on("vocal:video-fichier", ({ code, titre, fichier, ext }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || !estModoVocal(salon, user.id)) return cb?.({ ok: false });
      const cleanExt = String(ext || "").toLowerCase();
      if (!VIDEO_EXT_AUTORISEES.includes(cleanExt)) return cb?.({ ok: false, error: "FORMAT_NON_SUPPORTE" });
      const base64Data = String(fichier || "").split(";base64,").pop();
      const octets = Buffer.from(base64Data, "base64");
      if (!octets.length) return cb?.({ ok: false, error: "FICHIER_INVALIDE" });
      if (octets.length > VIDEO_MAX_OCTETS) return cb?.({ ok: false, error: "FICHIER_TROP_LOURD" });
      if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });
      const nomFichier = `${crypto.randomUUID()}.${cleanExt}`;
      try { fs.writeFileSync(join(VIDEO_DIR, nomFichier), octets); }
      catch { return cb?.({ ok: false, error: "ECRITURE_IMPOSSIBLE" }); }
      salon.radio = {
        titre: String(titre || "").trim().slice(0, 80) || "Vidéo",
        type: "video", url: `/videos/${nomFichier}`, demarreLe: Date.now() + COMPTE_A_REBOURS_VIDEO_MS,
      };
      diffuserVocal(salon);
      cb?.({ ok: true });
    });

    socket.on("vocal:chat-envoyer", ({ code, texte, filmTmdbId, filmTitre, filmPoster, enGrand }, cb) => {
      const salon = salonsVocaux.get(code);
      const moi = salon?.participants.get(user.id);
      if (!salon || !moi) return cb?.({ ok: false });

      const message = String(texte || "").trim().slice(0, 300);
      if (!message) return cb?.({ ok: false, error: "VIDE" });

      // "Envoyer comme emoji" (voir demande) : un simple affichage volant et éphémère, façon
      // réaction (voir vocal:reaction juste plus bas) — jamais ajouté à l'historique écrit du
      // tchat (voir la demande : pas besoin qu'il apparaisse dans le fil des messages). Réservé
      // aux tout petits messages (quelques emojis/caractères) pour ne pas afficher un pavé de
      // texte géant à l'écran. Le serveur ne le renvoie qu'aux AUTRES participants, exactement
      // comme vocal:reaction : l'expéditeur l'affiche lui-même tout de suite, côté client.
      if (enGrand === true && message.length <= 12) {
        for (const p of salon.participants.values()) {
          if (p.userId === user.id) continue;
          if (estBloque(p.userId, user.id)) continue;
          const s = [...io.of("/").sockets.values()].find((sk) => sk.data.user?.id === p.userId);
          if (s) s.emit("vocal:message-en-grand", { texte: message, pseudo: user.pseudo });
        }
        return cb?.({ ok: true });
      }

      const idTmdb = /^\d+$/.test(String(filmTmdbId || "")) ? String(filmTmdbId) : null;

      salon.chat = salon.chat || [];
      salon.chat.push({
        id: crypto.randomUUID(), userId: user.id, pseudo: user.pseudo,
        avatar: user.avatar, photo: user.photo || null, texte: message, at: Date.now(),
        ...(idTmdb ? { filmTmdbId: idTmdb, filmTitre: String(filmTitre || "").trim().slice(0, 120),
                       filmPoster: String(filmPoster || "").trim().slice(0, 300) || null } : {}),
      });
      if (salon.chat.length > VOCAL_CHAT_HISTORIQUE_MAX) salon.chat = salon.chat.slice(-VOCAL_CHAT_HISTORIQUE_MAX);

      for (const p of salon.participants.values()) {
        if (p.userId !== user.id && estBloque(p.userId, user.id)) continue;
        const s = [...io.of("/").sockets.values()].find((sk) => sk.data.user?.id === p.userId);
        if (s) s.emit("vocal:update", publicVocal(salon));
      }
      cb?.({ ok: true });
    });

    let derniereReactionVocale = 0;
    socket.on("vocal:reaction", ({ code, emoji, photo }) => {
      const salon = salonsVocaux.get(code);
      const moi = salon?.participants.get(user.id);
      if (!salon || !moi) return;
      const estPhoto = photo === true && Boolean(user.photo);
      if (!estPhoto && !getReglages().reactions.emojis.includes(emoji)) return;
      if (Date.now() - derniereReactionVocale < 700) return;
      derniereReactionVocale = Date.now();
      const payload = estPhoto
        ? { photo: user.photo, pseudo: user.pseudo, avatar: user.avatar }
        : { emoji, pseudo: user.pseudo, avatar: user.avatar };
      for (const p of salon.participants.values()) {
        if (p.userId === user.id) continue;
        if (estBloque(p.userId, user.id)) continue;
        const s = [...io.of("/").sockets.values()].find((sk) => sk.data.user?.id === p.userId);
        if (s) s.emit("vocal:reaction", payload);
      }
    });

    let derniereReactionVocalePrivee = 0;
    socket.on("vocal:reaction-privee", ({ code, cibleUserId, emoji }) => {
      const salon = salonsVocaux.get(code);
      const moi = salon?.participants.get(user.id);
      if (!salon || !moi || !cibleUserId || cibleUserId === user.id) return;
      const cible = salon.participants.get(cibleUserId);
      if (!cible) return;
      if (!getReglages().reactions.emojis.includes(emoji)) return;
      if (estBloque(cibleUserId, user.id)) return;
      if (Date.now() - derniereReactionVocalePrivee < 700) return;
      derniereReactionVocalePrivee = Date.now();
      const s = [...io.of("/").sockets.values()].find((sk) => sk.data.user?.id === cibleUserId);
      if (s) s.emit("vocal:reaction-privee", { emoji, pseudo: user.pseudo, avatar: user.avatar });
    });

    socket.on("vocal:inviter", ({ code, amiId }, cb) => {
      const salon = salonsVocaux.get(code);
      if (!salon || !salon.participants.has(user.id)) return cb?.({ ok: false });
      if (statutRelation(user.id, amiId) !== "ami") return cb?.({ ok: false, error: "PAS_AMI" });
      if (estBloque(user.id, amiId)) return cb?.({ ok: false, error: "BLOQUE" });

      salon.invites?.set(amiId, { de: user.pseudo, at: Date.now() });

      let livree = false;
      for (const [, s] of io.of("/").sockets) {
        if (s.data.user?.id !== amiId) continue;
        s.emit("vocal:invite-recue", {
          code: salon.code, titre: salon.titre,
          de: user.pseudo, avatar: user.avatar, photo: user.photo || null,
        });
        livree = true;
      }
      cb?.({ ok: true, livree });
    });

    socket.on("disconnect", () => quitterSalonVocal(socket, { involontaire: true }));
  }

  return {
    attacherSocket,
    // Exposé pour la SEULE passerelle qui doit exister entre le jeu et le salon vocal (ouvrir/
    // fusionner les salons d'équipe ou de partie depuis une partie de quiz en cours, voir
    // vocal:equipe-ouvrir, vocal:partie-ouvrir et fusionnerSalonsVocauxEquipe dans server.js) —
    // c'est le jeu qui vient piocher dans le salon vocal, jamais l'inverse.
    salonsVocaux, publicVocal, diffuserVocal, genererCodeVocal, quitterSalonVocal,
    retourVocalDisponible, MAX_PARTICIPANTS_VOCAL, VOCAL_CHAT_HISTORIQUE_MAX,
    // Exposé pour le système de dons du jeu (voir plus haut dans ce fichier).
    salonVocalDuJoueur, diffuserDonVocal,
  };
}
