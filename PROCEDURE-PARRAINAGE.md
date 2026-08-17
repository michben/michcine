# Activer le parrainage — procédure

⚠️ **L'ordre compte.** Si vous activez le parrainage avant de marquer vos
joueurs, plus personne ne pourra entrer dans le jeu, vous compris.

---

## Étape 1 — Marquer les joueurs actuels

1. Ouvrez **www.michbencine.fr/admin.html**
2. Onglet **Joueurs**
3. En haut, encart *Avant d'activer le parrainage* → bouton
   **Marquer tous les joueurs actuels**
4. Confirmez

Chaque joueur porte alors la mention « fondateur » sous son pseudo. Ils sont
dispensés de code, définitivement.

**Pour un joueur en particulier**, le bouton **☆ Fondateur** de sa ligne fait
la même chose. Il devient **★ Fondateur** une fois actif. Recliquer retire la
dispense.

Vérifiez que **votre propre compte** est marqué avant de continuer.

---

## Étape 2 — Activer le parrainage sur Render

Service web → **Environment** → Add Environment Variable :

| Key | Value |
|---|---|
| `PARRAINAGE` | `obligatoire` |

Puis **Save, rebuild and deploy**.

Pour désactiver plus tard, supprimez la variable : le jeu redevient ouvert à
tous, et les liens de filiation déjà créés sont conservés.

---

## Étape 3 — Vérifier

1. Ouvrez le jeu dans une **fenêtre de navigation privée**
2. Connectez-vous avec un compte qui n'est ni fondateur ni parrainé
3. L'écran **Code d'invitation** doit apparaître

Si vous tombez sur cet écran avec votre compte habituel, c'est que l'étape 1
a été oubliée : revenez dans la console et marquez-vous fondateur.

---

## Comment vos joueurs obtiennent leur code

Automatiquement, après **25 parties**. Une jauge dans leur profil montre où ils
en sont, et un bandeau les prévient dès qu'il est prêt. Le code fait six
caractères, sans lettres ambiguës.

Chacun voit dans son profil qui l'a invité et qui il a parrainé.

Pour changer le seuil, ajoutez sur Render :

| Key | Value |
|---|---|
| `PARTIES_POUR_CODE` | `25` |

---

# Variables Render — liste complète

Service web → **Environment**. Les trois premières sont indispensables.

## Indispensables

| Variable | Valeur | Sans elle |
|---|---|---|
| `DATABASE_URL` | l'Internal Database URL de votre base Postgres | comptes effacés à chaque déploiement |
| `SESSION_SECRET` | une longue phrase que vous inventez, **à ne jamais changer** | tous les joueurs déconnectés à chaque redémarrage |
| `PUBLIC_URL` | `https://www.michbencine.fr` | connexion X cassée, cookie invalide |

## Connexion X

| Variable | Valeur | Sans elle |
|---|---|---|
| `X_CLIENT_ID` | depuis developer.x.com | **connexion de test ouverte à tous** |
| `X_CLIENT_SECRET` | idem | idem |

## Administration

| Variable | Valeur | Sans elle |
|---|---|---|
| `ADMIN_TOKEN` | mot de passe de secours | `michben-admin`, connu de tous |

Une fois le mot de passe changé depuis l'onglet Réglages, cette variable ne
sert plus qu'en cas d'oubli.

## Parrainage

| Variable | Valeur | Sans elle |
|---|---|---|
| `PARRAINAGE` | `obligatoire` | jeu ouvert à tous |
| `PARTIES_POUR_CODE` | `25` | 25 par défaut |

## Facultatives

| Variable | Valeur | Sans elle |
|---|---|---|
| `TIP_URL` | votre lien Buy Me a Coffee | lien d'exemple non fonctionnel |
| `RESEND_API_KEY` | clé Resend | pas de validation email exigée |
| `EMAIL_EXPEDITEUR` | `MichBen Ciné Quizz <onboarding@resend.dev>` | — |
| `TURNSTILE_SITE_KEY` | clé publique Cloudflare | captcha ignoré |
| `TURNSTILE_SECRET` | clé secrète Cloudflare | idem |
| `LICENSE_SECRET` | une phrase secrète | valeur par défaut |

`PORT` est fourni par Render : ne l'ajoutez pas.

---

## Vérifier votre configuration

Après déploiement, les logs affichent un avertissement pour chaque variable
importante manquante :

```
⚠️  X_CLIENT_ID absent : connexion de test activée. NE PAS DÉPLOYER AINSI.
⚠️  DATABASE_URL absent : stockage en fichiers, effacé à chaque déploiement.
⚠️  SESSION_SECRET absent : les sessions seront perdues à chaque redémarrage.
⚠️  Mot de passe d'administration par défaut : changez-le depuis /admin.html
```

**Aucun de ces messages ne doit apparaître** sur un service ouvert au public.
La ligne à voir est :

```
Stockage Postgres prêt.
600 films · stockage : Postgres
```
