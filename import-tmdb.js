/**
 * Import des 300 plus gros succès du box-office depuis TMDB.
 *
 *   1. Clé gratuite sur https://www.themoviedb.org/settings/api
 *   2. Windows  :  set TMDB_API_KEY=votre_cle && node import-tmdb.js
 *      macOS/Linux : TMDB_API_KEY=votre_cle node import-tmdb.js
 *
 * Écrit movies.json (l'ancien est sauvegardé en movies.backup.json).
 * Comptez 2 à 3 minutes : une requête par film pour les crédits.
 */

import { writeFileSync, existsSync, copyFileSync } from "fs";

const API_KEY = process.env.TMDB_API_KEY;
const TARGET = Number(process.env.TARGET || 300);
const MIN_YEAR = Number(process.env.MIN_YEAR || 1975);

if (!API_KEY) {
  console.error("Clé manquante. Définissez TMDB_API_KEY avant de lancer le script.");
  process.exit(1);
}

const api = async (path, params = {}) => {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("language", "fr-FR");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status} sur ${path}`);
  return res.json();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retire le titre du synopsis : sinon la réponse est offerte. */
function scrubTitle(synopsis, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return synopsis.replace(new RegExp(escaped, "gi"), "…").replace(/\s+/g, " ").trim();
}

/** Variantes de titre acceptées en réponse (VO, sous-titre retiré, chiffres romains). */
function buildAnswers(fr, original) {
  const set = new Set([fr, original]);
  for (const t of [fr, original]) {
    if (t.includes(":")) set.add(t.split(":")[0]);
    if (t.includes(" - ")) set.add(t.split(" - ")[0]);
  }
  return [...set].map((t) => t.trim()).filter(Boolean);
}

const movies = [];
const seen = new Set();

console.log(`Import des ${TARGET} plus gros succès au box-office…`);

for (let page = 1; movies.length < TARGET && page <= 40; page++) {
  const { results } = await api("/discover/movie", {
    sort_by: "revenue.desc",
    "primary_release_date.gte": `${MIN_YEAR}-01-01`,
    "vote_count.gte": 500,
    include_adult: "false",
    page,
  });
  if (!results?.length) break;

  for (const m of results) {
    if (movies.length >= TARGET) break;
    if (seen.has(m.id) || !m.overview || !m.poster_path) continue; // sans synopsis FR : inutilisable
    seen.add(m.id);

    let director = "", actors = "";
    try {
      const credits = await api(`/movie/${m.id}/credits`);
      director = (credits.crew.find((c) => c.job === "Director") || {}).name || "";
      actors = credits.cast.slice(0, 3).map((c) => c.name).join(", ");
    } catch { /* crédits indisponibles : le film reste jouable sans ces indices */ }

    movies.push({
      id: movies.length + 1,
      title: m.title,
      acceptedAnswers: buildAnswers(m.title, m.original_title),
      synopsis: scrubTitle(m.overview, m.title),
      year: Number((m.release_date || "").slice(0, 4)) || null,
      director,
      actors,
      poster: `https://image.tmdb.org/t/p/w500${m.poster_path}`,
    });

    if (movies.length % 25 === 0) console.log(`  ${movies.length} films…`);
    await sleep(120); // reste largement sous la limite de débit TMDB
  }
}

if (existsSync("movies.json")) copyFileSync("movies.json", "movies.backup.json");
writeFileSync("movies.json", JSON.stringify(movies, null, 2));

const suspects = movies.filter((m) => m.synopsis.length < 90 || m.synopsis.includes("…"));
console.log(`\n${movies.length} films écrits dans movies.json`);
console.log(`${suspects.length} synopsis à relire dans /admin.html (trop courts ou contenant le titre) :`);
suspects.slice(0, 20).forEach((m) => console.log(`  - ${m.title}`));
