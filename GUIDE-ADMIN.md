# Guide de l'administrateur — MichBen Ciné Quizz

Document à garder pour toi. Il ne se transmet pas aux modérateurs : il donne
accès à tout.

---

## Accès

**Console d'administration :** www.michbencine.fr/admin.html
**Mot de passe :** celui que tu as défini dans l'onglet Réglages.

Il n'existe aucun moyen de le récupérer s'il est perdu — il est stocké sous
forme d'empreinte, pas en clair. Note-le dans ton gestionnaire de mots de passe.
En cas d'oubli, il faudra supprimer la ligne `adminPass` dans la base Postgres
pour revenir à la valeur de secours.

**Ne transmets jamais ce mot de passe à un modérateur.** Ils n'en ont pas
besoin : leurs outils sont dans le jeu, avec leur propre compte.

---

## Nommer un modérateur

1. Console → onglet **Joueurs**
2. Trouve le compte (la liste est triée par score, les joueurs en ligne sont
   signalés)
3. Change son rôle en `moderateur` dans le menu déroulant
4. Clique sur **Enregistrer**
5. Préviens la personne : elle doit se déconnecter et se reconnecter pour voir
   apparaître son bouton Modération

Les trois rôles : `joueur`, `moderateur`, `admin`. Le rôle `admin` donne accès à
la modération dans le jeu, mais **pas** à la console — celle-ci reste protégée
par le mot de passe seul.

Pour retirer un rôle, repasse le compte en `joueur` : l'accès disparaît
immédiatement.

---

## Ce que toi seul peux faire

**Onglet Films** — ajouter, modifier, supprimer, activer ou retirer des films.
Actions groupées par niveau et par note. Le bouton « Retirer » exclut un film du
jeu sans le supprimer : c'est ce que font aussi tes modérateurs.

**Onglet Joueurs** — ajuster tickets et points, changer un rôle, bannir,
réactiver, supprimer un compte. Le bouton « Offrir à tous » crédite l'ensemble
des joueurs d'un coup, pratique pour lancer une soirée ou compenser un incident.

**Onglet Signalements** — même vue que tes modérateurs, avec le compte de ceux
en attente.

**Onglet Réglages** — indices proposés, coûts, cadrage de l'image d'indice,
durée des manches, économie du jeu, mot de passe d'administration.

---

## Bannir un compte

Console → Joueurs → **Bannir**. L'effet est immédiat : le joueur est déconnecté
et ne peut plus entrer en partie.

Avant de bannir, demande à ton modérateur ce qui a été dit, quand, et par qui.
La règle affichée aux joueurs est claire — bannissement sans préavis — mais
elle t'engage : applique-la pour ce qu'elle vise, pas pour un simple agacement.

Le bannissement est réversible : le même bouton réactive le compte.

---

## Entretien courant

**Ajouter des films.** Le plus simple reste de relancer l'import :

```
TMDB_API_KEY=ta_cle node import-tmdb.js
git add movies.json && git commit -m "catalogue" && git push
```

Puis, dans la console, bouton **Réimporter** pour écraser le catalogue en base
par celui du dépôt. Attention : cela efface les films que tu aurais ajoutés à la
main depuis la console.

**Corriger un film signalé.** Onglet Films, recherche par filtre, bouton
Modifier. Réactive-le une fois corrigé.

**Surveiller.** Le nombre de joueurs en ligne s'affiche au menu du jeu. Les logs
Render montrent les démarrages et les erreurs.

---

## Points de vigilance

**Le plan Postgres gratuit de Render expire au bout de 30 jours.** Mets-toi un
rappel : à l'échéance, il faudra passer à leur offre payante ou migrer vers
Neon. Sans base, tous les comptes disparaissent.

**Ne change jamais `SESSION_SECRET`** sur Render : cela déconnecterait tous les
joueurs d'un coup.

**Un seul outil à la fois sur le code.** Deux assistants qui modifient les mêmes
fichiers sans se voir produisent des fichiers incohérents — c'est déjà arrivé.

**Avant chaque `git push`, lance `npm start` en local.** Si le serveur démarre
sans erreur, tu peux pousser. Sinon, ne pousse pas.

**En cas de panne**, ouvre www.michbencine.fr/diag.html : la page teste chaque
brique et affiche ce qui casse.
