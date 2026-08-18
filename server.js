import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { charger, sauver, initStockage, enBase } from "./db.js";
import { mountAuth, userFromCookie, chargerUtilisateurs, estCompteEnfant } from "./auth-x.js";

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static("public"));

mountAuth(app);
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" }, path: "/rt" });

const PORT = process.env.PORT || 3000;

await initStockage();
await chargerUtilisateurs();

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`MichBen Ciné Quizz en ligne sur le port ${PORT}`);
});
