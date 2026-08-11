/**
 * Connexion PostgreSQL — V2 rangée et optimisée
 */
import pg from "pg";

const URL_BASE = process.env.DATABASE_URL;
export const enBase = Boolean(URL_BASE);

const pool = enBase
  ? new pg.Pool({
      connectionString: URL_BASE,
      ssl: URL_BASE.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 10,
    })
  : null;

/* ------------------------------------------------------------------ */
/* Gestion des Films                                                  */
/* ------------------------------------------------------------------ */

/** Récupère tous les films actifs de la base de données */
export async function chargerFilms() {
  if (!enBase) return [];
  try {
    const { rows } = await pool.query(
      "SELECT id, titre_reponse AS title, synopsis, annee AS year, realisateur AS director, acteurs AS actors, image_url AS poster, difficulte AS difficulty, actif AS enabled FROM films ORDER BY id ASC"
    );
    return rows;
  } catch (err) {
    console.error("❌ Erreur chargement films :", err.message);
    return [];
  }
}

/** Ajoute ou modifie un film */
export async function sauvegarderFilm(film) {
  if (!enBase) return;
  const { id, title, synopsis, year, director, actors, poster, difficulty, enabled } = film;

  if (id) {
    // Modification d'un film existant
    await pool.query(
      `UPDATE films 
       SET titre_reponse = $1, synopsis = $2, annee = $3, realisateur = $4, acteurs = $5, image_url = $6, difficulte = $7, actif = $8
       WHERE id = $9`,
      [title, synopsis, year || null, director, actors, poster, difficulty || 'moyen', enabled !== false, id]
    );
  } else {
    // Création d'un nouveau film
    await pool.query(
      `INSERT INTO films (titre_reponse, synopsis, annee, realisateur, acteurs, image_url, difficulte, actif)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [title, synopsis, year || null, director, actors, poster, difficulty || 'moyen', enabled !== false]
    );
  }
}

/** Supprime un film */
export async function supprimerFilm(id) {
  if (!enBase) return;
  await pool.query("DELETE FROM films WHERE id = $1", [id]);
}

/* ------------------------------------------------------------------ */
/* Compatibilité temporaire pour ne rien casser                      */
/* ------------------------------------------------------------------ */

export async function initStockage() {
  console.log("Stockage Postgres V2 opérationnel.");
}

export async function charger(cle) {
  if (cle === "movies") return await chargerFilms();
  return [];
}

export function sauver() {
  // Désormais, chaque action sauvegarde directement en base
  /* ------------------------------------------------------------------ */
/* Gestion des Utilisateurs (Admin)                                   */
/* ------------------------------------------------------------------ */

/** Récupère tous les joueurs pour la console admin */
export async function chargerUtilisateursAdmin() {
  if (!enBase) return [];
  try {
    const { rows } = await pool.query(
      "SELECT id, pseudo, email, tickets, points, role FROM utilisateurs ORDER BY points DESC"
    );
    return rows;
  } catch (err) {
    console.error("❌ Erreur chargement utilisateurs :", err.message);
    return [];
  }
}

/** Ajoute ou retire des points/tickets à un joueur */
export async function modifierSolde(id, variationPoints, variationTickets) {
  if (!enBase) return;
  try {
    await pool.query(
      `UPDATE utilisateurs 
       SET points = points + $1, tickets = tickets + $2 
       WHERE id = $3`,
      [variationPoints, variationTickets, id]
    );
  } catch (err) {
    console.error("❌ Erreur modification solde :", err.message);
  }
}
