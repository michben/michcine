/**
 * MichBen Ciné Quizz — import du catalogue depuis TMDB.
 *
 *   Clé gratuite : https://www.themoviedb.org/settings/api  (clé API v3)
 *
 *   macOS / Linux :  TMDB_API_KEY=votre_cle node import-tmdb.js
 *   Windows       :  set TMDB_API_KEY=votre_cle && node import-tmdb.js
 *
 * Écrit movies.json (l'ancien est sauvegardé en movies.backup.json).
 * Comptez 10 à 15 minutes : une requête de détail par film.
 *
 * Réglages facultatifs, à placer devant la commande :
 *   TARGET=300        succès internationaux visés
 *   TARGET_FR=300     films français visés
 *   MIN_YEAR=1970     année la plus ancienne
 *   MAX_ANIMATION=20  nombre maximum de films d'animation
 *   MAX_TITLE_LEN=22  longueur maximale du titre
 */

import { writeFileSync, existsSync, copyFileSync } from "fs";

const API_KEY = process.env.TMDB_API_KEY;
if (!API_KEY) {
  console.error("Clé manquante : définissez TMDB_API_KEY avant de lancer le script.");
  process.exit(1);
}

const TARGET = Number(process.env.TARGET || 300);
const TARGET_FR = Number(process.env.TARGET_FR || 300);
const MIN_YEAR = Number(process.env.MIN_YEAR || 1970);
const MAX_ANIMATION = Number(process.env.MAX_ANIMATION || 20);
const MAX_TITLE_LEN = Number(process.env.MAX_TITLE_LEN || 22);
const MAX_TITLE_WORDS = Number(process.env.MAX_TITLE_WORDS || 4);

const GENRE_ANIMATION = 16;

/* ------------------------------------------------------------------ */
/* Accès à l'API                                                       */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("language", "fr-FR");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let essai = 1; essai <= 3; essai++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 429) { await sleep(2000 * essai); continue; }   // limite de débit
    throw new Error(`TMDB ${res.status} sur ${path}`);
  }
  throw new Error(`TMDB inaccessible sur ${path}`);
}

/* ------------------------------------------------------------------ */
/* Filtres de titre                                                    */
/* ------------------------------------------------------------------ */

/** Retire le titre du synopsis : sinon la réponse est offerte. */
function scrubTitle(synopsis, title) {
  const echappe = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return synopsis.replace(new RegExp(echappe, "gi"), "…").replace(/\s+/g, " ").trim();
}

/** Variantes acceptées en réponse (VO, titre sans sous-titre). */
function buildAnswers(fr, original) {
  const set = new Set([fr, original]);
  for (const t of [fr, original]) {
    if (t.includes(":")) set.add(t.split(":")[0]);
    if (t.includes(" - ")) set.add(t.split(" - ")[0]);
  }
  return [...set].map((t) => t.trim()).filter(Boolean);
}

/** Numéro de suite dans le titre : « 2 », « II », « Partie 3 ». */
const SUITE = /\s(\d{1,2}|I{2,3}|IV|VI{0,3}|IX|XI{0,3})$|\b(part(ie)?|chapitre|episode|épisode)\s*\d/i;

function titreRejete(m, vf) {
  const t = m.title.trim();
  if (t.length > MAX_TITLE_LEN) return "titre";
  if (t.split(/\s+/).length > MAX_TITLE_WORDS) return "titre";
  if (/[:–]/.test(t)) return "titre";
  if (SUITE.test(t)) return "suite";
  if (!vf && m.original_language === "en" && t.toLowerCase() === m.original_title.trim().toLowerCase())
    return "titre";
  return null;
}

/** Le niveau vient de la notoriété, pas de la note : un chef-d'œuvre confidentiel est difficile. */
const niveau = (votes) => (votes >= 8000 ? "facile" : votes >= 2500 ? "moyen" : "difficile");

/* ------------------------------------------------------------------ */
/* Collecte                                                            */
/* ------------------------------------------------------------------ */

const vus = new Set();       // ids TMDB déjà examinés
const sagas = new Map();     // id de collection -> film retenu
const rejets = { suite: 0, titre: 0, animation: 0, saga: 0, sansSynopsis: 0 };
let animations = 0;

async function collecte(label, params, cible, vf) {
  console.log(`\n${label} — objectif ${cible}`);
  const retenus = [];

  for (let page = 1; retenus.length < cible && page <= 60; page++) {
    let lot;
    try { lot = await api("/discover/movie", { ...params, page }); }
    catch (e) { console.warn(`  page ${page} ignorée (${e.message})`); continue; }
    if (!lot.results?.length) break;

    for (const brut of lot.results) {
      if (retenus.length >= cible) break;
      if (vus.has(brut.id)) continue;
      vus.add(brut.id);

      if (!brut.overview || !brut.poster_path) { rejets.sansSynopsis++; continue; }

      const raison = titreRejete(brut, vf);
      if (raison) { rejets[raison]++; continue; }

      // un seul appel pour les genres, la saga et le générique
      let d;
      try { d = await api(`/movie/${brut.id}`, { append_to_response: "credits" }); }
      catch { continue; }
      await sleep(110);

      const estAnime = (d.genres || []).some((g) => g.id === GENRE_ANIMATION);
      if (estAnime && animations >= MAX_ANIMATION) { rejets.animation++; continue; }

      const film = {
        tmdbId: d.id,
        title: d.title,
        acceptedAnswers: buildAnswers(d.title, d.original_title),
        synopsis: scrubTitle(d.overview, d.title),
        year: Number((d.release_date || "").slice(0, 4)) || null,
        director: (d.credits?.crew || []).find((c) => c.job === "Director")?.name || "",
        actors: (d.credits?.cast || []).slice(0, 3).map((c) => c.name).join(", "),
        poster: `https://image.tmdb.org/t/p/w500${d.poster_path}`,
        still: d.backdrop_path ? `https://image.tmdb.org/t/p/w780${d.backdrop_path}` : "",
        rating: Math.round((d.vote_average || 0) * 10) / 10,
        votes: d.vote_count || 0,
        difficulty: niveau(d.vote_count || 0),
        animation: estAnime,
        // les films d'animation et familiaux alimentent la catégorie Enfants
        categorie: (d.genres || []).some((g) => [16, 10751].includes(g.id)) ? "kid" : "tous",
        vf,
        enabled: true,
      };

      // Une saga = un seul film, et c'est le premier sorti.
      const saga = d.belongs_to_collection?.id;
      if (saga) {
        const dejaLa = sagas.get(saga);
        if (dejaLa) {
          rejets.saga++;
          if ((film.year || 9999) < (dejaLa.year || 9999)) Object.assign(dejaLa, film);
          continue;
        }
        sagas.set(saga, film);
      }

      if (estAnime) animations++;
      retenus.push(film);
      if (retenus.length % 25 === 0) console.log(`  ${retenus.length}…`);
    }
  }

  console.log(`${label} : ${retenus.length} films retenus.`);
  return retenus;
}

/* ------------------------------------------------------------------ */
/* Exécution                                                           */
/* ------------------------------------------------------------------ */

const commun = {
  "primary_release_date.gte": `${MIN_YEAR}-01-01`,
  include_adult: "false",
};

const internationaux = await collecte("Succès internationaux",
  { ...commun, sort_by: "revenue.desc", "vote_count.gte": 500 }, TARGET, false);

const francais = await collecte("Films français",
  { ...commun, sort_by: "popularity.desc", with_original_language: "fr", "vote_count.gte": 60 },
  TARGET_FR, true);

/** Fisher-Yates : chaque ordre possible est également probable. */
function melange(tableau) {
  const t = [...tableau];
  for (let i = t.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [t[i], t[j]] = [t[j], t[i]];
  }
  return t;
}

const movies = melange([...internationaux, ...francais])   // les deux origines s'entremêlent
  .map((m, i) => ({ id: i + 1, ...m }));

if (existsSync("movies.json")) copyFileSync("movies.json", "movies.backup.json");
writeFileSync("movies.json", JSON.stringify(movies, null, 2));

/* ------------------------------------------------------------------ */
/* Rapport                                                             */
/* ------------------------------------------------------------------ */

const compte = (f) => movies.filter(f).length;

console.log(`\n${movies.length} films écrits dans movies.json`);
console.log(`  français : ${compte((m) => m.vf)} · internationaux : ${compte((m) => !m.vf)}`);
console.log(`  animation : ${compte((m) => m.animation)} (plafond ${MAX_ANIMATION})`);
console.log(`  catégorie Enfants : ${compte((m) => m.categorie === "kid")}`);
for (const n of ["facile", "moyen", "difficile"])
  console.log(`  ${n} : ${compte((m) => m.difficulty === n)}`);

console.log(`\nÉcartés : ${rejets.suite} suites, ${rejets.saga} doublons de saga, ` +
            `${rejets.titre} titres inadaptés, ${rejets.animation} animations au-delà du quota, ` +
            `${rejets.sansSynopsis} sans synopsis français.`);

const arelire = movies.filter((m) => m.synopsis.length < 90 || m.synopsis.includes("…"));
console.log(`\n${arelire.length} synopsis à relire dans /admin.html :`);
arelire.slice(0, 25).forEach((m) => console.log(`  - ${m.title}`));
