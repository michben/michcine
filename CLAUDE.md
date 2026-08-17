# MichBen Ciné Quizz

Jeu de quiz cinéma en français : un synopsis s'affiche, le joueur devine le film
parmi quatre propositions. Solo ou jusqu'à 16 joueurs.

**En ligne :** https://www.michbencine.fr — hébergé sur Render, déployé
automatiquement à chaque `git push` sur `main`.

## Démarrer

```bash
npm install
npm start          # http://localhost:3000
npm test           # vérification complète (voir plus bas)
```

Sans `DATABASE_URL`, le stockage retombe sur des fichiers JSON locaux et une
connexion de test remplace X — pratique en développement, jamais en production.

## Architecture

| Fichier | Rôle |
|---|---|
| `server.js` | Serveur Express + Socket.IO : catalogue, parties, API d'administration, mode solo HTTP |
| `auth-x.js` | Authentification (X OAuth 2.0 + email), sessions signées, comptes, amis, rôles |
| `db.js` | Stockage : Postgres si `DATABASE_URL`, fichiers JSON sinon |
| `import-tmdb.js` | Script d'import du catalogue depuis TMDB (lancé à la main) |
| `movies.json` | Catalogue de départ, semé en base au premier démarrage |
| `public/index.html` | Le jeu entier : HTML, CSS et JS dans un seul fichier |
| `public/admin.html` | Console d'administration (films, joueurs, signalements) |
| `public/diag.html` | Page de diagnostic, teste chaque brique depuis le navigateur |
| `public/regles.html` | Règles et code de conduite |

Pas de build, pas de framework, pas de bundler. Les fichiers de `public/` sont
servis tels quels. C'est volontaire : le propriétaire édite parfois depuis un
téléphone via l'éditeur GitHub.

## Décisions à connaître avant de modifier

**Le temps réel passe par `/rt`, pas `/socket.io`.** De nombreux bloqueurs
filtrent sur le nom « socket.io ». Le client est servi par le serveur sous
`/js/moteur.js`, depuis le paquet installé. Ne pas revenir aux chemins par défaut.

**Solo et partie classée n'utilisent pas le temps réel** (`/api/solo/*`). Ils
restent jouables quand un bloqueur ou un réseau filtrant coupe les WebSockets.
Ne pas les refaire passer par Socket.IO.

**Les sessions sont des jetons signés**, pas une table en mémoire : elles
survivent aux redéploiements. `SESSION_SECRET` ne doit jamais changer, sinon
tous les joueurs sont déconnectés.

**Le cookie porte `Domain=michbencine.fr`** pour valoir avec et sans `www`.

**Le disque de Render est effacé à chaque déploiement.** Toute donnée qui doit
survivre passe par `db.js`. Ne jamais écrire directement dans un fichier JSON
pour des données de joueurs.

**Le titre du film ne part jamais au client** pendant une manche. L'indice
« photo » utilise `still` (image sans titre imprimé), pas l'affiche.

**Le mélange utilise Fisher-Yates** (`melange()`), pas `sort(() => Math.random() - 0.5)`
qui est statistiquement biaisé — la bonne réponse tombait plus souvent à
certaines positions.

## Variables d'environnement (Render)

| Variable | Rôle | Sans elle |
|---|---|---|
| `DATABASE_URL` | Postgres | stockage fichier, effacé au déploiement |
| `SESSION_SECRET` | signature des sessions | déconnexion à chaque redémarrage |
| `PUBLIC_URL` | `https://www.michbencine.fr` | callback X et cookie incorrects |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | connexion X | connexion de test ouverte à tous |
| `ADMIN_TOKEN` | accès à `/admin.html` | valeur par défaut publique |
| `TIP_URL` | lien pourboire | lien d'exemple |
| `RESEND_API_KEY` | envoi du code de validation email | pas de validation exigée |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` | captcha | captcha ignoré |

## Conventions

- Code et commentaires **en français**, comme le reste du projet.
- Commenter le *pourquoi*, jamais le *quoi*.
- Pas de dépendance nouvelle sans nécessité réelle.
- Toute donnée venant du client est validée côté serveur : le client peut mentir.

## Vérifier avant de pousser

`npm test` lance une partie solo complète et une partie multijoueur à deux
joueurs, et vérifie les routes principales. **Le lancer après toute
modification** : plusieurs pannes en production venaient d'un fichier modifié
sans exécution réelle, la vérification de syntaxe ne suffit pas.

## Pièges déjà rencontrés

- `server.js` et `auth-x.js` doivent être déployés ensemble : `server.js`
  importe des fonctions qui n'existent que dans la version correspondante.
- Un `index.html` périmé en ligne a provoqué plusieurs faux diagnostics.
  `public/diag.html` affiche la version réellement servie.
- L'éditeur GitHub ne permet pas de coller un fichier de plusieurs dizaines de
  kilo-octets ; passer par `Add file → Upload files`.
