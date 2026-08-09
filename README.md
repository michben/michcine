# MichBen Ciné Quizz

## Arborescence

```
michben-cine-quizz/
├── server.js
├── movies.json
├── package.json
└── public/
    ├── index.html   ← le jeu
    └── admin.html   ← le catalogue de films
```

## Lancer sur votre PC

```bash
npm install
npm start
```

- Jeu : http://localhost:3000
- Catalogue : http://localhost:3000/admin.html (clé par défaut : `michben-admin`)

Changez la clé avant toute mise en ligne :

```bash
ADMIN_TOKEN="votre-cle-secrete" LICENSE_SECRET="autre-secret" npm start
```

## Jouer à plusieurs

**Sur le même réseau (Wi-Fi maison).** Trouvez l'IP locale du PC (`ipconfig` sous Windows,
`ifconfig | grep inet` sous macOS/Linux), puis vos amis ouvrent `http://192.168.x.x:3000`.
Autorisez Node dans le pare-feu Windows à la première demande.

**Sur Internet, sans configurer votre box.** Ouvrez un tunnel pendant que le serveur tourne :

```bash
npx localtunnel --port 3000
# ou : cloudflared tunnel --url http://localhost:3000
```

Vous obtenez une URL publique temporaire à partager. Elle ne vit que le temps de la commande,
et votre PC doit rester allumé. Pour un lien permanent, déployez sur Render, Railway ou Fly.io.

## Publicité et Premium

- L'emplacement publicitaire est le bloc `#adSlot` dans `public/index.html` : remplacez-le
  par votre balise AdSense une fois votre compte régie validé.
- Le Premium retire la publicité et offre l'indice « affiche floutée ».
- **Le paiement est un mannequin.** `POST /api/premium/checkout` délivre une licence signée
  sans encaisser un centime. Pour encaisser réellement, il faut :
  1. un compte Stripe et des comptes utilisateurs (le statut premium doit être attaché à un
     compte, pas au navigateur — ici un `localStorage` effacé fait perdre l'achat) ;
  2. la création de session côté serveur avec votre clé secrète ;
  3. le statut premium écrit **depuis le webhook Stripe**, jamais depuis le client.
  Les points 1 et 3 sont non négociables : sans eux, n'importe qui débloque le Premium
  en trois lignes dans la console du navigateur.

## Affiches

Les URL d'affiches pointent vers TMDB. Pour un usage public, créez une clé API TMDB
(gratuite) et respectez leurs conditions d'attribution, plutôt que de copier des URL à la main.
