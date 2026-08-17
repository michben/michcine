# MichBen Ciné Quizz — archive du 17 août 2026

Tous les fichiers de cette archive ont été vérifiés ensemble : syntaxe,
démarrage du serveur, pages servies, routes, partie solo, partie multijoueur
dans les trois modes, catégorie Enfants, administration.

## Ce que contient l'archive

```
server.js          serveur de jeu, API, administration
auth-x.js          comptes, sessions, amis, niveaux, parrainage
db.js              stockage Postgres (repli fichier en local)
import-tmdb.js     import du catalogue depuis TMDB
package.json       dépendances
.gitignore
public/
  index.html       le jeu
  admin.html       console d'administration
  regles.html      règles et code de conduite
  diag.html        page de diagnostic
  favicon.svg      icône du site
```

**movies.json n'est pas inclus** : votre catalogue de 600 films est le vôtre,
ne l'écrasez pas.

## Installation

1. Décompressez l'archive dans votre dossier de projet, en écrasant les fichiers
   existants — **sauf movies.json**.
2. `npm install`
3. `npm start` — vérifiez que le serveur démarre sans erreur.
4. Ouvrez http://localhost:3000 et cliquez sur Solo.
5. Si tout fonctionne : `git add . && git commit -m "mise a jour" && git push`

## La règle à respecter désormais

**Lancez `npm start` avant chaque `git push`.** Si le serveur démarre et que le
jeu se lance en local, vous pouvez pousser. Sinon, ne poussez pas.

La panne précédente venait d'un outil ayant inséré le même bloc de code 91 fois
dans index.html, coupant autant d'instructions en deux. Un simple `npm start`
l'aurait révélé immédiatement.

**N'utilisez qu'un seul assistant à la fois sur ces fichiers.** Deux outils qui
modifient le même fichier sans se voir produisent des fichiers incohérents.

## Ce qui n'est pas dans cette version

La machine à sous n'a pas été reprise. Elle fait miser des points contre un gain
aléatoire, ce qui pose deux problèmes : c'est une mécanique de jeu d'argent
exposée à des mineurs — vous venez d'ajouter une catégorie Enfants — et elle
distribue des points de classement sans jouer, ce qui dévalue le classement.

Une roue de récompense quotidienne et gratuite, distribuant des tickets et non
des points, garderait l'effet de surprise sans ces inconvénients. Dites-le si
vous la voulez.
