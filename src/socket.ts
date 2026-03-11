import { io } from "socket.io-client";

const socketUrl =
  import.meta.env.VITE_SOCKET_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.PROD ? "https://the-killer.onrender.com" : "http://localhost:3001");

const socket = io(socketUrl);

export default socket;

// ✅ Fonction pour initialiser les listeners globaux
export function initSocketListeners() {
  socket.on("joueur_elimine", (pseudoElimine: string) => {
    console.log("📡 joueur_elimine reçu :", pseudoElimine);

    const elimines: { pseudo: string; position: number }[] =
      JSON.parse(localStorage.getItem("tka_elimines") || "[]");

    if (elimines.some(j => j.pseudo === pseudoElimine)) return;

    const position = elimines.length + 2;
    elimines.push({ pseudo: pseudoElimine, position });

    localStorage.setItem("tka_elimines", JSON.stringify(elimines));
    console.log("📦 Éliminé enregistré :", pseudoElimine, "→", position);
  });
}
