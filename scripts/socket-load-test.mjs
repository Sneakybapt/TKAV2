import { io } from "socket.io-client";

function parseArgs(argv) {
  const args = {
    url: "http://localhost:3001",
    players: 50,
    joinTimeoutMs: 30000,
    launchTimeoutMs: 20000,
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
  const socket = io(url, {
    transports: ["websocket"],
    reconnection: false,
    timeout: 10000,
  });

  socket.on("connect_error", (error) => {
    console.error(`[${pseudo}] connect_error:`, error.message);
  });

  return socket;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const start = Date.now();
  const runId = Date.now().toString(36);
  const hostPseudo = `lt_${runId}_host`;

  console.log("=== Socket load test ===");
  console.log(`URL: ${args.url}`);
  console.log(`Players: ${args.players}`);
  console.log("Mode: creation/rejoindre/lancer uniquement (pas d'elimination)");

  const sockets = [];
  let code = null;

  try {
    const host = createClient(args.url, hostPseudo);
    sockets.push({ pseudo: hostPseudo, socket: host });

    await withTimeout(
      new Promise((resolve, reject) => {
        host.once("connect", resolve);
        host.once("erreur", (msg) => reject(new Error(`[host] erreur: ${msg}`)));
      }),
      10000,
      "connexion host",
    );

    const created = withTimeout(
      new Promise((resolve, reject) => {
        host.once("partie_creee", ({ code: gameCode }) => resolve(gameCode));
        host.once("erreur", (msg) => reject(new Error(`[host] creer_partie erreur: ${msg}`)));
      }),
      args.joinTimeoutMs,
      "creation partie",
    );

    host.emit("creer_partie", { pseudo: hostPseudo });
    code = await created;
    console.log(`Partie creee: ${code}`);

    const joinPromises = [];
    for (let i = 1; i < args.players; i += 1) {
      const pseudo = `lt_${runId}_${String(i).padStart(2, "0")}`;
      const client = createClient(args.url, pseudo);
      sockets.push({ pseudo, socket: client });

      const p = withTimeout(
        new Promise((resolve, reject) => {
          client.once("connect", () => {
            client.emit("rejoindre_partie", { code, pseudo });
          });
          client.once("confirmation_rejoindre", () => resolve());
          client.once("erreur", (msg) => reject(new Error(`[${pseudo}] rejoindre erreur: ${msg}`)));
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
      new Promise((resolve, reject) => {
        const expected = args.players;
        host.on("mise_a_jour_joueurs", (players) => {
          if (Array.isArray(players) && players.length >= expected) resolve();
        });
        host.once("erreur", (msg) => reject(new Error(`[host] lobby erreur: ${msg}`)));
      }),
      args.joinTimeoutMs,
      "synchronisation lobby",
    );

    const launchPromises = sockets.map(({ pseudo, socket }) =>
      withTimeout(
        new Promise((resolve, reject) => {
          socket.once("partie_lancee", () => resolve(pseudo));
          socket.once("erreur", (msg) => reject(new Error(`[${pseudo}] partie_lancee erreur: ${msg}`)));
        }),
        args.launchTimeoutMs,
        `partie_lancee ${pseudo}`,
      ),
    );

    host.emit("lancer_partie", code);
    await Promise.all(launchPromises);

    const elapsed = Date.now() - start;
    console.log("RESULTAT: OK");
    console.log(`- Code partie: ${code}`);
    console.log(`- Joueurs connectes: ${args.players}`);
    console.log(`- Duree totale: ${elapsed}ms`);
  } finally {
    for (const { socket } of sockets) {
      socket.disconnect();
    }
  }
}

run().catch((error) => {
  console.error("RESULTAT: ECHEC");
  console.error(error.message);
  process.exit(1);
});
