import http from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const corsOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((v) => v.trim());
const pendingEliminations = new Map();

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS bloque: " + origin));
    },
    credentials: true,
  }),
);
app.use(express.json());

function randomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

async function loadAndSeedMissions() {
  const missionsPath = path.join(__dirname, "missions.json");
  const data = fs.readFileSync(missionsPath, "utf-8");
  const parsed = JSON.parse(data);
  const unique = [...new Set(parsed.map((m) => String(m).trim()).filter(Boolean))];

  for (const content of unique) {
    await prisma.mission.upsert({
      where: { content },
      update: { isActive: true },
      create: { content, isActive: true },
    });
  }
  console.log(`Missions pretes: ${unique.length}`);
}

async function ensureUser(pseudo) {
  const existing = await prisma.user.findUnique({ where: { pseudo } });
  if (existing) return existing;

  const fallbackHash = await bcrypt.hash(`guest-${pseudo}`, 10);
  return prisma.user.create({
    data: {
      pseudo,
      passwordHash: fallbackHash,
    },
  });
}

async function getPlayersState(gameCode) {
  const game = await prisma.game.findUnique({
    where: { code: gameCode },
    include: {
      players: {
        include: {
          user: true,
          assignmentsAsKiller: {
            where: { isActive: true },
            include: {
              targetPlayer: { include: { user: true } },
              mission: true,
            },
            take: 1,
          },
        },
      },
    },
  });

  if (!game) return [];

  return game.players.map((player) => {
    const activeAssignment = player.assignmentsAsKiller[0];
    return {
      id: player.socketId,
      pseudo: player.user.pseudo,
      code: game.code,
      cible: activeAssignment?.targetPlayer?.user?.pseudo ?? null,
      mission: activeAssignment?.mission?.content ?? null,
      elimine: !player.isAlive,
    };
  });
}

async function buildClassement(gameId) {
  const [players, eliminations] = await Promise.all([
    prisma.gamePlayer.findMany({
      where: { gameId },
      include: { user: true },
    }),
    prisma.elimination.findMany({
      where: { gameId },
      orderBy: { createdAt: "asc" },
      include: { victimPlayer: { include: { user: true } } },
    }),
  ]);

  const total = players.length;
  const classement = eliminations.map((elim, index) => ({
    pseudo: elim.victimPlayer.user.pseudo,
    position: total - index,
  }));

  const winner = players.find((p) => p.finalPosition === 1 || p.isAlive);
  if (winner) {
    classement.push({ pseudo: winner.user.pseudo, position: 1 });
  }
  return classement;
}

app.post("/api/inscription", async (req, res) => {
  const { pseudo, motdepasse } = req.body;
  if (!pseudo || !motdepasse) {
    return res.status(400).json({ ok: false, message: "Pseudo et mot de passe requis" });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { pseudo } });
    if (existingUser) {
      return res.status(400).json({ ok: false, message: "Pseudo deja pris" });
    }

    const passwordHash = await bcrypt.hash(motdepasse, 10);
    await prisma.user.create({
      data: {
        pseudo,
        passwordHash,
      },
    });
    res.json({ ok: true, message: "Profil cree avec succes" });
  } catch (error) {
    console.error("Erreur inscription:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur" });
  }
});

app.post("/api/connexion", async (req, res) => {
  const { pseudo, motdepasse } = req.body;
  if (!pseudo || !motdepasse) {
    return res.status(400).json({ ok: false, message: "Pseudo et mot de passe requis" });
  }

  try {
    const user = await prisma.user.findUnique({ where: { pseudo } });
    if (!user) {
      return res.status(404).json({ ok: false, message: "Profil introuvable" });
    }

    const match = await bcrypt.compare(motdepasse, user.passwordHash);
    if (!match) {
      return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
    }

    res.json({ ok: true, message: "Connexion reussie" });
  } catch (error) {
    console.error("Erreur connexion:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur" });
  }
});

app.post("/api/enregistrer-partie", async (req, res) => {
  const { code, classement } = req.body;
  if (!Array.isArray(classement) || classement.length === 0 || !code) {
    return res.status(400).json({ ok: false, message: "Classement invalide" });
  }

  try {
    const game = await prisma.game.findUnique({
      where: { code },
      include: {
        players: {
          include: { user: true },
        },
      },
    });
    if (!game) {
      return res.status(404).json({ ok: false, message: "Partie introuvable" });
    }

    await prisma.$transaction(
      classement.map((entry) => {
        const gp = game.players.find((p) => p.user.pseudo === entry.pseudo);
        if (!gp) return prisma.$executeRaw`SELECT 1`;
        return prisma.gamePlayer.update({
          where: { id: gp.id },
          data: { finalPosition: Number(entry.position) || null },
        });
      }),
    );

    await prisma.game.update({
      where: { id: game.id },
      data: { status: "FINISHED", endedAt: new Date() },
    });

    res.json({ ok: true, message: "Partie enregistree" });
  } catch (error) {
    console.error("Erreur enregistrement partie:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur" });
  }
});

app.get("/api/profil-stats", async (req, res) => {
  const pseudo = req.query.pseudo;
  if (!pseudo) {
    return res.status(400).json({ ok: false, message: "Pseudo requis" });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { pseudo: String(pseudo) },
      include: {
        gamePlayers: {
          where: { finalPosition: { not: null } },
        },
      },
    });

    if (!user) {
      return res.json({ nbParties: 0, nbVictoires: 0, moyennePlace: null });
    }

    const nbParties = user.gamePlayers.length;
    const nbVictoires = user.gamePlayers.filter((p) => p.finalPosition === 1).length;
    const moyenne = nbParties
      ? (
          user.gamePlayers.reduce((acc, p) => acc + Number(p.finalPosition || 0), 0) / nbParties
        ).toFixed(2)
      : null;

    res.json({ nbParties, nbVictoires, moyennePlace: moyenne });
  } catch (error) {
    console.error("Erreur stats profil:", error);
    res.status(500).json({ ok: false, message: "Erreur serveur" });
  }
});

const frontendDistPath = path.resolve(__dirname, "../dist");
app.use(express.static(frontendDistPath));

// Fallback SPA: toutes les routes non-API retournent index.html
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(frontendDistPath, "index.html"));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigins,
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  socket.on("creer_partie", async ({ pseudo }) => {
    try {
      const user = await ensureUser(pseudo);

      let code = randomCode();
      while (await prisma.game.findUnique({ where: { code } })) {
        code = randomCode();
      }

      const game = await prisma.game.create({
        data: { code, status: "LOBBY" },
      });

      await prisma.gamePlayer.create({
        data: {
          gameId: game.id,
          userId: user.id,
          socketId: socket.id,
          isAlive: true,
        },
      });

      socket.join(code);
      const players = await getPlayersState(code);
      socket.emit("partie_creee", { code, joueurs: players });
      io.to(code).emit("mise_a_jour_joueurs", players);
    } catch (error) {
      console.error("Erreur creer_partie:", error);
      socket.emit("erreur", "Impossible de creer la partie.");
    }
  });

  socket.on("rejoindre_partie", async ({ code, pseudo }) => {
    try {
      const game = await prisma.game.findUnique({ where: { code } });
      if (!game) {
        socket.emit("erreur", "Code de partie invalide.");
        return;
      }

      const user = await ensureUser(pseudo);
      await prisma.gamePlayer.upsert({
        where: { gameId_userId: { gameId: game.id, userId: user.id } },
        update: { socketId: socket.id, isAlive: true },
        create: {
          gameId: game.id,
          userId: user.id,
          socketId: socket.id,
          isAlive: true,
        },
      });

      socket.join(code);
      socket.emit("confirmation_rejoindre", { code, pseudo });
      const players = await getPlayersState(code);
      io.to(code).emit("mise_a_jour_joueurs", players);
    } catch (error) {
      console.error("Erreur rejoindre_partie:", error);
      socket.emit("erreur", "Impossible de rejoindre la partie.");
    }
  });

  socket.on("reconnexion", async ({ code, pseudo }) => {
    try {
      const game = await prisma.game.findUnique({ where: { code } });
      if (!game) {
        socket.emit("erreur", "Partie introuvable.");
        return;
      }

      const user = await prisma.user.findUnique({ where: { pseudo } });
      if (!user) {
        socket.emit("erreur", "Pseudo non reconnu.");
        return;
      }

      const gamePlayer = await prisma.gamePlayer.findUnique({
        where: { gameId_userId: { gameId: game.id, userId: user.id } },
        include: {
          assignmentsAsKiller: {
            where: { isActive: true },
            include: {
              targetPlayer: { include: { user: true } },
              mission: true,
            },
            take: 1,
          },
        },
      });

      if (!gamePlayer) {
        socket.emit("erreur", "Pseudo non reconnu.");
        return;
      }

      await prisma.gamePlayer.update({
        where: { id: gamePlayer.id },
        data: { socketId: socket.id },
      });
      socket.join(code);

      const activeAssignment = gamePlayer.assignmentsAsKiller[0];
      if (activeAssignment) {
        socket.emit("partie_lancee", {
          pseudo,
          code,
          cible: activeAssignment.targetPlayer?.user?.pseudo ?? null,
          mission: activeAssignment.mission?.content ?? "Mission secrete.",
        });
      }

      const pending = pendingEliminations.get(`${code}:${pseudo}`);
      if (pending) {
        socket.emit("demande_validation", { tueur: pending.tueur, message: pending.message });
      }

      const players = await getPlayersState(code);
      socket.emit("reconnexion_ok", {
        pseudo,
        code,
        mission: activeAssignment?.mission?.content ?? null,
        cible: activeAssignment?.targetPlayer?.user?.pseudo ?? null,
        joueurs: players,
      });
      io.to(code).emit("mise_a_jour_joueurs", players);
    } catch (error) {
      console.error("Erreur reconnexion:", error);
      socket.emit("erreur", "Reconnexion impossible.");
    }
  });

  socket.on("lancer_partie", async (code) => {
    try {
      const game = await prisma.game.findUnique({
        where: { code },
        include: {
          players: {
            where: { isAlive: true },
            include: { user: true },
          },
        },
      });

      if (!game || game.players.length < 2) {
        io.to(code).emit("erreur", "Il faut au moins 2 joueurs.");
        return;
      }

      const availableMissions = await prisma.mission.findMany({ where: { isActive: true } });
      if (!availableMissions.length) {
        io.to(code).emit("erreur", "Aucune mission active.");
        return;
      }

      const shuffledPlayers = shuffle(game.players);
      const shuffledMissions = shuffle(availableMissions);

      await prisma.$transaction(async (tx) => {
        await tx.assignment.updateMany({ where: { gameId: game.id }, data: { isActive: false } });

        for (let i = 0; i < shuffledPlayers.length; i += 1) {
          const killer = shuffledPlayers[i];
          const target = shuffledPlayers[(i + 1) % shuffledPlayers.length];
          const mission = shuffledMissions[i % shuffledMissions.length];

          await tx.assignment.create({
            data: {
              gameId: game.id,
              killerPlayerId: killer.id,
              targetPlayerId: target.id,
              missionId: mission.id,
              isActive: true,
            },
          });
          await tx.gamePlayer.update({
            where: { id: killer.id },
            data: { validatedMission: false, missionChanges: 0 },
          });
        }

        await tx.game.update({
          where: { id: game.id },
          data: { status: "COUNTDOWN", startedAt: new Date() },
        });
      });

      const players = await getPlayersState(code);
      players.forEach((p) => {
        if (!p.id) return;
        io.to(p.id).emit("partie_lancee", {
          pseudo: p.pseudo,
          cible: p.cible,
          mission: p.mission,
          code,
        });
      });

      setTimeout(async () => {
        await prisma.game.update({
          where: { code },
          data: { status: "RUNNING" },
        });
        io.to(code).emit("autorisation_elimination");
      }, 5000);
    } catch (error) {
      console.error("Erreur lancer_partie:", error);
      io.to(code).emit("erreur", "Impossible de lancer la partie.");
    }
  });

  socket.on("tentative_elimination", async ({ code, tueur, cible, message }) => {
    try {
      const game = await prisma.game.findUnique({ where: { code } });
      if (!game || game.status !== "RUNNING") {
        socket.emit("erreur", "La phase d'elimination n'est pas encore active.");
        return;
      }

      const targetPlayer = await prisma.gamePlayer.findFirst({
        where: {
          gameId: game.id,
          isAlive: true,
          user: { pseudo: cible },
        },
        include: { user: true },
      });

      if (!targetPlayer || !targetPlayer.socketId) return;
      pendingEliminations.set(`${code}:${cible}`, { tueur, message });
      io.to(targetPlayer.socketId).emit("demande_validation", { tueur, message });
    } catch (error) {
      console.error("Erreur tentative_elimination:", error);
      socket.emit("erreur", "Tentative invalide.");
    }
  });

  socket.on("validation_elimination", async ({ code, cible, tueur }) => {
    try {
      const game = await prisma.game.findUnique({ where: { code } });
      if (!game) return;

      const result = await prisma.$transaction(async (tx) => {
        const killer = await tx.gamePlayer.findFirst({
          where: { gameId: game.id, isAlive: true, user: { pseudo: tueur } },
          include: { user: true },
        });
        const victim = await tx.gamePlayer.findFirst({
          where: { gameId: game.id, isAlive: true, user: { pseudo: cible } },
          include: { user: true },
        });
        if (!killer || !victim) return null;

        const killerAssignment = await tx.assignment.findFirst({
          where: { gameId: game.id, killerPlayerId: killer.id, isActive: true },
        });
        const victimAssignment = await tx.assignment.findFirst({
          where: { gameId: game.id, killerPlayerId: victim.id, isActive: true },
        });
        if (!killerAssignment) return null;

        const aliveCount = await tx.gamePlayer.count({
          where: { gameId: game.id, isAlive: true },
        });

        await tx.elimination.create({
          data: {
            gameId: game.id,
            killerPlayerId: killer.id,
            victimPlayerId: victim.id,
            message: `${tueur} a elimine ${cible}`,
          },
        });

        await tx.gamePlayer.update({
          where: { id: victim.id },
          data: {
            isAlive: false,
            finalPosition: aliveCount,
            eliminatedAt: new Date(),
            validatedMission: true,
            socketId: null,
          },
        });

        if (victimAssignment) {
          await tx.assignment.update({
            where: { id: killerAssignment.id },
            data: {
              targetPlayerId: victimAssignment.targetPlayerId,
              missionId: victimAssignment.missionId,
            },
          });
          await tx.assignment.update({
            where: { id: victimAssignment.id },
            data: { isActive: false },
          });
        } else {
          await tx.assignment.update({
            where: { id: killerAssignment.id },
            data: { targetPlayerId: null },
          });
        }

        const remainingAlive = await tx.gamePlayer.findMany({
          where: { gameId: game.id, isAlive: true },
          include: { user: true },
        });

        if (remainingAlive.length === 1) {
          await tx.gamePlayer.update({
            where: { id: remainingAlive[0].id },
            data: { finalPosition: 1 },
          });
          await tx.assignment.updateMany({
            where: { gameId: game.id, killerPlayerId: remainingAlive[0].id, isActive: true },
            data: { targetPlayerId: null, isActive: false },
          });
          await tx.game.update({
            where: { id: game.id },
            data: { status: "FINISHED", endedAt: new Date() },
          });
        }

        return { killer, remainingAlive };
      });

      if (!result) return;

      io.to(code).emit("joueur_elimine", cible);
      const players = await getPlayersState(code);
      io.to(code).emit("mise_a_jour_joueurs", players);

      const killerState = players.find((p) => p.pseudo === tueur);
      if (killerState?.id) {
        io.to(killerState.id).emit("partie_lancee", {
          pseudo: killerState.pseudo,
          cible: killerState.cible,
          mission: killerState.mission,
          code,
        });
      }

      if (result.remainingAlive.length === 1) {
        const survivor = result.remainingAlive[0];
        const classement = await buildClassement(game.id);
        if (survivor.socketId) {
          io.to(survivor.socketId).emit("victoire");
          io.to(survivor.socketId).emit("classement_final", classement);
        }
      }

      pendingEliminations.delete(`${code}:${cible}`);
    } catch (error) {
      console.error("Erreur validation_elimination:", error);
      socket.emit("erreur", "Validation impossible.");
    }
  });

  socket.on("verif_mission_validee", async ({ code, pseudo }) => {
    try {
      const gp = await prisma.gamePlayer.findFirst({
        where: { game: { code }, user: { pseudo } },
        select: { validatedMission: true, missionChanges: true },
      });
      io.to(socket.id).emit("mission_validee_recue", {
        verrou: Boolean(gp?.validatedMission),
        missionChanges: gp?.missionChanges ?? 0,
      });
    } catch (error) {
      console.error("Erreur verif_mission_validee:", error);
    }
  });

  socket.on("valider_mission", async ({ code, pseudo }) => {
    try {
      const gp = await prisma.gamePlayer.findFirst({
        where: { game: { code }, user: { pseudo }, isAlive: true },
        select: { id: true, missionChanges: true },
      });
      if (!gp) return;

      await prisma.gamePlayer.update({
        where: { id: gp.id },
        data: { validatedMission: true },
      });

      io.to(socket.id).emit("mission_validee_recue", {
        verrou: true,
        missionChanges: gp.missionChanges,
      });
    } catch (error) {
      console.error("Erreur valider_mission:", error);
    }
  });

  socket.on("demande_survivants", async ({ code }) => {
    try {
      const players = await getPlayersState(code);
      const vivants = players.filter((p) => !p.elimine);
      io.to(socket.id).emit(
        "liste_survivants",
        vivants.map((j) => ({
          pseudo: j.pseudo,
          cible: j.cible,
          mission: j.mission,
        })),
      );
    } catch (error) {
      console.error("Erreur demande_survivants:", error);
    }
  });

  socket.on("demande_nouvelle_mission", async ({ pseudo, code }) => {
    try {
      const game = await prisma.game.findUnique({ where: { code } });
      if (!game) return;

      const gp = await prisma.gamePlayer.findFirst({
        where: { gameId: game.id, user: { pseudo }, isAlive: true },
      });
      if (!gp) return;

      if (gp.validatedMission) {
        if (gp.socketId) io.to(gp.socketId).emit("erreur", "Mission deja validee.");
        return;
      }

      if (gp.missionChanges >= 2) {
        if (gp.socketId) io.to(gp.socketId).emit("erreur", "Tu as deja change ta mission 2 fois.");
        return;
      }

      const missions = await prisma.mission.findMany({ where: { isActive: true } });
      if (!missions.length) return;
      const nouvelleMission = shuffle(missions)[0];

      await prisma.$transaction([
        prisma.assignment.updateMany({
          where: { gameId: game.id, killerPlayerId: gp.id, isActive: true },
          data: { missionId: nouvelleMission.id },
        }),
        prisma.gamePlayer.update({
          where: { id: gp.id },
          data: { missionChanges: { increment: 1 } },
        }),
      ]);

      if (gp.socketId) {
        io.to(gp.socketId).emit("nouvelle_mission", {
          mission: nouvelleMission.content,
          missionChanges: gp.missionChanges + 1,
        });
      }
    } catch (error) {
      console.error("Erreur demande_nouvelle_mission:", error);
    }
  });

  socket.on("disconnect", async () => {
    try {
      const gp = await prisma.gamePlayer.findFirst({
        where: { socketId: socket.id },
        include: { game: true, user: true },
      });
      if (!gp) return;

      await prisma.gamePlayer.update({
        where: { id: gp.id },
        data: { socketId: null },
      });

      const players = await getPlayersState(gp.game.code);
      io.to(gp.game.code).emit("mise_a_jour_joueurs", players);

      const activeSockets = players.filter((p) => p.id && !p.elimine);
      if (activeSockets.length === 1 && gp.game.status !== "FINISHED") {
        const classement = await buildClassement(gp.gameId);
        io.to(activeSockets[0].id).emit("classement_final", classement);
      }
    } catch (error) {
      console.error("Erreur disconnect:", error);
    }
  });
});

const PORT = Number(process.env.PORT || 3000);

loadAndSeedMissions()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Serveur Socket.IO en ligne sur http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Erreur initialisation serveur:", error);
    process.exit(1);
  });