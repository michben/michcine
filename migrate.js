import pg from "pg";

const URL_BASE = process.env.DATABASE_URL;

export async function demenager() {
  if (!URL_BASE) {
    console.log("⚠️ DATABASE_URL absent, migration ignorée.");
    return;
  }

  const pool = new pg.Pool({
    connectionString: URL_BASE,
    ssl: URL_BASE.includes("localhost") ? false : { rejectUnauthorized: false },
  });

  console.log("🚚 Démarrage du transfert des données...");

  try {
    // 1. Création des nouvelles tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS utilisateurs (
        id SERIAL PRIMARY KEY,
        pseudo VARCHAR(50) NOT NULL,
        email VARCHAR(100) UNIQUE,
        tickets INT DEFAULT 0,
        points INT DEFAULT 0,
        role VARCHAR(20) DEFAULT 'joueur'
      );

      CREATE TABLE IF NOT EXISTS films (
        id SERIAL PRIMARY KEY,
        titre_reponse VARCHAR(200) NOT NULL,
        synopsis TEXT NOT NULL,
        annee INT,
        realisateur VARCHAR(100),
        acteurs TEXT,
        image_url TEXT,
        difficulte VARCHAR(20),
        actif BOOLEAN DEFAULT true
      );
    `);

    // 2. Transfert des films depuis l'ancien carton
    const resFilms = await pool.query("SELECT valeur FROM store WHERE cle = 'movies'");
    
    if (resFilms.rows.length > 0) {
      const films = resFilms.rows[0].valeur;
      console.log(`🎬 ${films.length} films trouvés. Transfert en cours...`);
      
      for (const film of films) {
         await pool.query(`
           INSERT INTO films (id, titre_reponse, synopsis, annee, realisateur, acteurs, image_url, difficulte, actif)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING;
         `, [
           film.id, 
           film.title, 
           film.synopsis, 
           film.year || null, 
           film.director || '', 
           film.actors || '', 
           film.poster || film.still || '', 
           film.difficulty || 'moyen',
           film.enabled !== false
         ]);
      }
      
      await pool.query("SELECT setval('films_id_seq', (SELECT MAX(id) FROM films));");
      console.log("✅ Tous les films ont été transférés !");
    } else {
      console.log("⚠️ Aucun film trouvé dans l'ancien système (ou déjà transférés).");
    }

    console.log("🎉 Migration terminée avec succès !");
  } catch (erreur) {
    console.error("❌ Erreur pendant le transfert :", erreur.message);
  } finally {
    await pool.end();
  }
}