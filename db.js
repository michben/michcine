/**
 * Stockage persistant — Postgres si DATABASE_URL est défini, fichiers JSON sinon.
 *
 * Pourquoi ce fonctionnement :
 *   Sur Render, le disque est effacé à chaque déploiement. Les comptes, crédits,
 *   classements, rôles et signalements doivent donc vivre en base.
 *   En local, sans base, on retombe sur les fichiers JSON : le développement
 *   reste possible sans rien installer.
 *
 * Les données sont chargées une fois au démarrage et gardées en mémoire ;
 * chaque modification est réécrite en base de façon différée (200 ms), ce qui
 * évite une écriture par clic tout en garantissant la persistance.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import pg from "pg";

const URL_BASE = process.env.DATABASE_URL;
export const enBase = Boolean(URL_BASE);

const pool = enBase
  ? new pg.Pool({
      connectionString: URL_BASE,
      // Render impose TLS mais avec un certificat interne
      ssl: URL_BASE.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 5,
    })
  : null;

const cache = new Map();     // clé -> valeur JavaScript
const minuteries = new Map(); // clé -> écriture différée

/* ------------------------------------------------------------------ */

export async function initStockage() {
  if (!enBase) {
    console.warn("⚠️  DATABASE_URL absent : stockage en fichiers, effacé à chaque déploiement.");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      cle    TEXT PRIMARY KEY,
      valeur JSONB NOT NULL,
      maj    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  console.log("Stockage Postgres prêt.");
}

/**
 * Charge une clé. Au premier démarrage, la base est vide : on reprend alors
 * le fichier JSON du dépôt comme graine (utile pour movies.json).
 */
export async function charger(cle, fichier, defaut) {
  if (enBase) {
    const { rows } = await pool.query("SELECT valeur FROM store WHERE cle = $1", [cle]);
    if (rows.length) {
      cache.set(cle, rows[0].valeur);
      return rows[0].valeur;
    }
    const graine = lireFichier(fichier, defaut);
    cache.set(cle, graine);
    await ecrire(cle, graine);
    console.log(`« ${cle} » initialisé en base depuis ${fichier ? "le fichier" : "les valeurs par défaut"}.`);
    return graine;
  }
  const valeur = lireFichier(fichier, defaut);
  cache.set(cle, valeur);
  return valeur;
}

/** Enregistre une clé. Différé pour absorber les rafales de modifications. */
export function sauver(cle, valeur, fichier) {
  cache.set(cle, valeur);
  clearTimeout(minuteries.get(cle));
  minuteries.set(cle, setTimeout(() => {
    if (enBase) ecrire(cle, valeur).catch((e) => console.error(`Écriture ${cle} :`, e.message));
    else if (fichier) writeFileSync(fichier, JSON.stringify(valeur, null, 2));
  }, 200));
}

async function ecrire(cle, valeur) {
  await pool.query(
    `INSERT INTO store (cle, valeur, maj) VALUES ($1, $2, now())
     ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur, maj = now()`,
    [cle, JSON.stringify(valeur)]
  );
}

function lireFichier(fichier, defaut) {
  if (fichier && existsSync(fichier)) {
    try { return JSON.parse(readFileSync(fichier, "utf8")); }
    catch (e) { console.error(`Lecture ${fichier} :`, e.message); }
  }
  return defaut;
}

/** Vide les écritures en attente avant l'arrêt du service. */
export async function viderFileAttente() {
  for (const [cle, timer] of minuteries) {
    clearTimeout(timer);
    if (enBase) await ecrire(cle, cache.get(cle)).catch(() => {});
  }
  minuteries.clear();
}

// Render envoie SIGTERM avant chaque redéploiement : on écrit ce qui reste.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    await viderFileAttente();
    if (pool) await pool.end().catch(() => {});
    process.exit(0);
  });
}
