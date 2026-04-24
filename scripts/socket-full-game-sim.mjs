import { io } from "socket.io-client";

function parseArgs(argv) {
  const args = {
    url: "http://localhost:3001",
    players: 20,
    joinTimeoutMs: 30000,
    launchTimeoutMs: 25000,
    eliminationTimeoutMs: 20000,
    delayMs: 15,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    if (current === "--url" && next) {
      args.url = next;
      i += 1;
    } else if (current === "--players" && next) {
      args.players = Number(next);
      i += 1;
    } else if (current === "--join-timeout" && next) {
      args.joinTimeoutMs = Number(next);
      i += 1;
    } else if (current === "--launch-timeout" && next) {
      args.launchTimeoutMs = Number(next);
      i += 1;
    } else if (current === "--elimination-timeout" && next) {
      args.eliminationTimeoutMs = Number(next);
      i += 1;
    } else if (current === "--delay-ms" && next) {
      args.delayMs = Number(next);
      i += 1;
    }
  }

  if (!Number.isFinite(args.players) || args.players < 2) {
    throw new Error("`--players` doit etre >= 2");
  }

  return args;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout ${label} apres ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function createClient(url, pseudo) {
  return io(url, {
    transports: ["websocket"],
    reconnection: false,
    timeout: 10000,
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const start = Date.now();
  const runId = Date.now().toString(36);
  const hostPseudo = `sim_${runId}_host`;
  const sockets = new Map();
  const alive = new Set();
  const currentTarget = new Map();
  const eliminationWaiters = new Map();
  const errors = [];

  let code = null;
  let killerPseudo = hostPseudo;

  function registerClient(pseudo, socket) {
    sockets.set(pseudo, socket);
    alive.add(pseudo);

    socket.on("erreur", (msg) => {
      const text = `[${pseudo}] erreur: ${msg}`;
      errors.push(text);
      console.warn(text);
    });

    socket.on("partie_lancee", ({ cible }) => {
      if (cible) currentTarget.set(pseudo, cible);
    });

    socket.on("demande_validation", ({ tueur }) => {
      // Auto-validation pour simuler la reaction du joueur cible.
      socket.emit("validation_elimination", {
        code,
        cible: pseudo,
        tueur,
      });
    });

    socket.on("joueur_elimine", (pseudoElimine) => {
      alive.delete(pseudoElimine);
      const waiter = eliminationWaiters.get(pseudoElimine);
      if (waiter) {
        eliminationWaiters.delete(pseudoElimine);
        waiter();
      }
    });
  }

  function waitForElimination(pseudo, timeoutMs) {
    return withTimeout(
      new Promise((resolve) => {
        eliminationWaiters.set(pseudo, resolve);
      }),
      timeoutMs,
      `elimination ${pseudo}`,
    );
  }

  try {
    console.log("=== Simulation partie complete ===");
    console.log(`URL: ${args.url}`);
    console.log(`Players: ${args.players}`);
    console.log("Mode: auto kills + auto validations");

    const host = createClient(args.url, hostPseudo);
    registerClient(hostPseudo, host);

    await withTimeout(
      new Promise((resolve, reject) => {
        host.once("connect", resolve);
        host.once("connect_error", (e) => reject(e));
      }),
      10000,
      "connexion host",
    );

    const gameCodePromise = withTimeout(
      new Promise((resolve, reject) => {
        host.once("partie_creee", ({ code: gameCode }) => resolve(gameCode));
        host.once("erreur", (msg) => reject(new Error(`[host] creer_partie: ${msg}`)));
      }),
      args.joinTimeoutMs,
      "creation partie",
    );

    host.emit("creer_partie", { pseudo: hostPseudo });
    code = await gameCodePromise;
    console.log(`Partie creee: ${code}`);

    const joinPromises = [];
    for (let i = 1; i < args.players; i += 1) {
      const pseudo = `sim_${runId}_${String(i).padStart(2, "0")}`;
      const socket = createClient(args.url, pseudo);
      registerClient(pseudo, socket);

      const p = withTimeout(
        new Promise((resolve, reject) => {
          socket.once("connect", () => {
            socket.emit("rejoindre_partie", { code, pseudo });
          });
          socket.once("confirmation_rejoindre", resolve);
          socket.once("erreur", (msg) => reject(new Error(`[${pseudo}] rejoindre: ${msg}`)));
          socket.once("connect_error", (e) => reject(e));
        }),
        args.joinTimeoutMs,
        `join ${pseudo}`,
      );
      joinPromises.push(p);

      if (args.delayMs > 0) await wait(args.delayMs);
    }
    await Promise.all(joinPromises);
    console.log(`${args.players - 1} joueurs ont rejoint`);

    await withTimeout(
      new Promise((resolve) => {
        host.on("mise_a_jour_joueurs", (players) => {
          if (Array.isArray(players) && players.length >= args.players) resolve();
        });
      }),
      args.joinTimeoutMs,
      "sync lobby complet",
    );

    const launchPromises = Array.from(sockets.entries()).map(([pseudo, socket]) =>
      withTimeout(
        new Promise((resolve, reject) => {
          socket.once("partie_lancee", () => resolve(pseudo));
          socket.once("erreur", (msg) => reject(new Error(`[${pseudo}] launch: ${msg}`)));
        }),
        args.launchTimeoutMs,
        `partie_lancee ${pseudo}`,
      ),
    );

    const runningPromise = withTimeout(
      new Promise((resolve) => {
        host.once("autorisation_elimination", resolve);
      }),
      args.launchTimeoutMs,
      "autorisation_elimination",
    );

    host.emit("lancer_partie", code);
    await Promise.all(launchPromises);
    await runningPromise;
    console.log("Partie lancee et phase elimination active");

    let eliminationCount = 0;
    while (alive.size > 1) {
      const target = currentTarget.get(killerPseudo);
      if (!target || !alive.has(target)) {
        throw new Error(`Cible invalide pour ${killerPseudo}: ${String(target)}`);
      }

      const killerSocket = sockets.get(killerPseudo);
      if (!killerSocket) {
        throw new Error(`Socket introuvable pour ${killerPseudo}`);
      }

      const waitElim = waitForElimination(target, args.eliminationTimeoutMs);

      killerSocket.emit("tentative_elimination", {
        code,
        tueur: killerPseudo,
        cible: target,
        message: `[SIM] elimination de ${target}`,
      });

      await waitElim;
      eliminationCount += 1;
      console.log(`Elimination ${eliminationCount}: ${killerPseudo} -> ${target} (restants: ${alive.size})`);
    }

    const elapsed = Date.now() - start;
    const winner = Array.from(alive)[0];

    console.log("RESULTAT: OK");
    console.log(`- Code partie: ${code}`);
    console.log(`- Joueurs: ${args.players}`);
    console.log(`- Eliminations: ${eliminationCount}`);
    console.log(`- Vainqueur: ${winner}`);
    console.log(`- Duree: ${elapsed}ms`);
    if (errors.length > 0) {
      console.log(`- Avertissements serveur/socket: ${errors.length}`);
    }
  } finally {
    for (const socket of sockets.values()) {
      socket.disconnect();
    }
  }
}

run().catch((error) => {
  console.error("RESULTAT: ECHEC");
  console.error(error.message);
  process.exit(1);
});
